import { html, nothing } from '../vendor/lit-html.js';
import { loadJson } from '../core/content.js';
import { fillSentence as fill } from '../core/content.js';

// What the learner is told about the scene: the live reading shown above the drawing (a label, a
// value and one or two sentences explaining it), and the "evidence" panel that spells out the
// numbers behind a prediction or a time correction. Pure functions of a run and the sample being
// shown; no DOM, no state. Every sentence comes from content/systems/narration.json.

const copy = await loadJson('content/systems/narration.json');

const DATA_LOSS_TIME = 1.5; // seconds; diagnostics/missing stops receiving new ranges here
const SHOCK_TIME = 2; // seconds; diagnostics/impact plays its event here
const QUEUE_BACKLOG = 10; // items waiting before the timing/queue reading counts as falling behind
const WALL_TOLERANCE = 1e-8; // metres; below this the map and the real wall are the same place
const EQUATION_DIGITS = 4; // an equation shows its terms as measured, without padding

const num = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '—');
// Equation terms keep their exact value: 4.2 stays "4.2", not "4.2000".
const amount = (value) => String(Number(value.toFixed(EQUATION_DIGITS)));

// Before the first run every reading is in its neutral "ready" state.
const modeOf = (started, running) => (started ? running : 'ready');

// --- the live reading ---------------------------------------------------------------------------

function brakingReading(run, sample, started, event) {
  const text = copy.mechanics.braking;
  const value = () => {
    if (!started) return copy.unknown;
    if (sample.v === 0) return text.stopped;
    return sample.braking ? text.braking : text.beforeBraking;
  };
  const explanation = () => {
    if (!started || !sample.braking) return fill(text.plan, { distance: num(run.config.brakeAt) });
    const opening = fill(text.startedAt, { time: num(event.t, 1) });
    return opening + (sample.v > 0 ? text.stillMoving : text.halted);
  };
  return {
    event,
    label: text.label,
    value: value(),
    mode: modeOf(started, sample.braking ? 'brake' : 'drive'),
    text: explanation(),
    replay: text.replay,
  };
}

function powerReading(run, sample, started, event) {
  const text = copy.mechanics.power;
  const explanation = () => {
    if (!started) return fill(text.plan, { power: run.config.power });
    if (sample.motorPower > 0) return text.driving;
    const cut = fill(text.cutAt, { time: num(event.t, 1), power: run.config.power });
    return cut + (sample.v > 0 ? text.coasting : text.halted);
  };
  return {
    event,
    label: text.label,
    value: started ? sample.motorPower + text.unit : copy.unknown,
    mode: modeOf(started, sample.motorPower > 0 ? 'drive' : 'coast'),
    text: explanation(),
    replay: text.replay,
  };
}

function mechanicsReading(run, index, started) {
  const sample = run.samples[index];
  const event = run.events.find((entry) => entry.kind === 'power-off' || entry.kind === 'brake');
  if (run.topic === 'braking') return brakingReading(run, sample, started, event);
  return powerReading(run, sample, started, event);
}

function stopDistanceReading(config, sample, started) {
  const text = copy.diagnostics.distance;
  const bothSensors = config.sensorRule === 'both';
  const usedRange = bothSensors ? Math.min(sample.lidar, sample.depth) : sample.lidar;
  const value = () => {
    if (!started) return text.beforeValue;
    if (sample.contact) return text.contactValue;
    return sample.latched ? text.latchedValue : text.runningValue;
  };
  const detail = () => {
    if (!started) return text.before;
    if (sample.contact) return text.contact;
    if (sample.latched) return text.latched;
    return fill(text.current, { range: num(usedRange) });
  };
  const rule = fill(text.rule, {
    rule: bothSensors ? text.bothSensors : text.lidarOnly,
    limit: num(config.stopDistance),
  });
  return {
    label: text.label,
    value: value(),
    mode: sample.contact || sample.latched ? 'brake' : 'ready',
    text: rule + detail(),
  };
}

function staleDataReading(config, sample, started) {
  const text = copy.diagnostics.missing;
  const fresh = sample.t < DATA_LOSS_TIME;
  const value = () => {
    if (!started) return text.waitingValue;
    return fresh ? text.freshValue : text.staleValue;
  };
  const explanation = () => {
    if (!started) return text.before;
    if (fresh) return text.fresh;
    if (sample.latched) return fill(text.latched, { limit: num(config.staleLimit) });
    const ageing = fill(text.ageing, { range: num(sample.range), age: num(sample.age) });
    const limit = config.watchdog
      ? fill(text.watchdog, { limit: num(config.staleLimit) })
      : text.noWatchdog;
    return ageing + limit;
  };
  return {
    label: text.label,
    value: value(),
    mode: fresh ? 'ready' : 'coast',
    text: explanation(),
  };
}

function impactReading(config, sample, started) {
  const text = copy.diagnostics.impact;
  const value = () => {
    if (!started) return text.beforeValue;
    if (sample.latched) return text.latchedValue;
    return sample.t < SHOCK_TIME ? text.beforeEventValue : text.runningValue;
  };
  const explanation = () => {
    if (!started)
      return fill(text.plan, {
        event: config.eventType === 'bump' ? text.bump : text.shock,
        limit: num(config.impactLimit, 1),
      });
    if (sample.t < SHOCK_TIME) return text.beforeEvent;
    return sample.latched ? text.latched : text.belowLimit;
  };
  return {
    label: text.label,
    value: value(),
    mode: sample.latched ? 'brake' : 'ready',
    text: explanation(),
  };
}

function diagnosticsReading(run, index, started) {
  const sample = run.samples[index];
  if (run.topic === 'distance') return stopDistanceReading(run.config, sample, started);
  if (run.topic === 'missing') return staleDataReading(run.config, sample, started);
  return impactReading(run.config, sample, started);
}

function velocityReading(sample, started) {
  const text = copy.tracking.velocity;
  const explanation = () => {
    if (!started) return text.before;
    if (!sample.previousObs) return text.singleObservation;
    return fill(text.comparing, {
      previous: num(sample.previousObs.t, 1),
      latest: num(sample.obs.t, 1),
    });
  };
  return {
    label: text.label,
    value: !started || sample.velocity === null ? copy.unknown : num(sample.velocity) + text.unit,
    mode: 'ready',
    text: explanation(),
  };
}

function predictionReading(config, sample, started) {
  const text = copy.tracking.prediction;
  const explanation = () => {
    if (!started || !sample.predicted) return text.before;
    return fill(text.predicting, {
      measured: num(sample.obs.t, 1),
      target: num(sample.predicted.targetTime, 1),
    });
  };
  return {
    label: text.label,
    value: fill(text.value, { horizon: num(config.horizon, 1) }),
    mode: 'ready',
    text: explanation(),
  };
}

function crossingReading(config, sample, started) {
  const text = copy.tracking.crossing;
  const rule =
    config.rule === 'predict'
      ? fill(text.predictRule, { horizon: num(config.horizon, 1) })
      : text.nearRule;
  return {
    label: text.label,
    value: started ? sample.status : text.beforeValue,
    mode: sample.status === text.waitingStatus ? 'brake' : 'ready',
    text: rule + text.stoppingNote,
  };
}

function trackingReading(run, index, started) {
  const sample = run.samples[index];
  if (run.topic === 'velocity') return velocityReading(sample, started);
  if (run.topic === 'prediction') return predictionReading(run.config, sample, started);
  return crossingReading(run.config, sample, started);
}

function alignmentReading(config, sample) {
  const text = copy.timing.alignment;
  const explanation = () => {
    if (sample.stamp === null) return text.before;
    return fill(text.using, {
      stamp: num(sample.stamp, 2),
      pose: num(config.align === 'stamp' ? sample.stamp : sample.t, 2),
    });
  };
  return {
    label: text.label,
    value: config.align === 'stamp' ? text.atStamp : text.atNow,
    mode: 'ready',
    text: explanation(),
  };
}

function queueReading(config, sample, started) {
  const text = copy.timing.queue;
  const detail = () => {
    if (!started) return text.before;
    if (sample.stamp === null) return text.waiting;
    return fill(text.using, { age: num(sample.age, 2) });
  };
  return {
    label: text.label,
    value: started ? sample.queue + text.unit : copy.unknown,
    mode: sample.queue > QUEUE_BACKLOG ? 'coast' : 'ready',
    text: fill(text.rate, { processing: config.processing }) + detail(),
  };
}

function delayReading(config, sample, started) {
  const text = copy.timing.delay;
  const explanation = () => {
    if (!started || sample.stamp === null) return text.before;
    const age = num(sample.age, 2);
    return config.compensate ? fill(text.compensated, { age }) : fill(text.raw, { age });
  };
  return {
    label: text.label,
    value: started && sample.usedRange !== null ? num(sample.usedRange) + text.unit : copy.unknown,
    mode: sample.contact ? 'brake' : 'ready',
    text: explanation(),
  };
}

function timingReading(run, index, started) {
  const sample = run.samples[index];
  if (run.topic === 'alignment') return alignmentReading(run.config, sample);
  if (run.topic === 'queue') return queueReading(run.config, sample, started);
  return delayReading(run.config, sample, started);
}

const READINGS = {
  mechanics: mechanicsReading,
  diagnostics: diagnosticsReading,
  tracking: trackingReading,
  timing: timingReading,
};

// The behaviour and coordination courses have no live reading; their panel stays hidden.
function systemState(run, index, started = true) {
  const reading = READINGS[run.course];
  return reading ? reading(run, index, started) : null;
}

// --- the evidence panel -------------------------------------------------------------------------

function evidencePanel(title, body, note) {
  return html`<div class="sys-forecast-check">
    <h3>${title}</h3>
    ${body}${note ? html`<p class="muted">${note}</p>` : nothing}
  </div>`;
}

function predictionEvidence(run, index, started) {
  const text = copy.evidence.prediction;
  const evaluation = started ? run.samples[index].evaluation : null;
  if (!evaluation) return evidencePanel(text.title, html`<p>${text.pending}</p>`, text.note);
  const comparison = fill(text.comparison, {
    madeAt: num(evaluation.madeAt, 1),
    target: num(evaluation.targetTime, 1),
  });
  const values = [evaluation.predictedY, evaluation.actualY, evaluation.error];
  const body = html`<p>${comparison}</p>
    <dl>
      ${text.terms.map(
        (term, position) =>
          html`<div>
            <dt>${term}</dt>
            <dd>${num(values[position]) + text.unit}</dd>
          </div>`,
      )}
    </dl>`;
  return evidencePanel(text.title, body, text.note);
}

function mapEvidence(text, config, sample) {
  const sentence = fill(text.mapSentence, {
    pose: num(config.align === 'stamp' ? sample.stamp : sample.t, 2),
    stamp: num(sample.stamp, 2),
  });
  const equation = fill(text.mapEquation, {
    base: amount(sample.mapBaseX),
    range: amount(sample.rawRange),
    estimate: amount(sample.wallEstimate),
  });
  const verdict =
    Math.abs(sample.wallError) < WALL_TOLERANCE
      ? text.wallMatches
      : fill(text.wallDiffers, { error: num(Math.abs(sample.wallError)) });
  return html`<p>${sentence}</p>
    <p class="sys-timing-equation">${equation}</p>
    <p>${text.wallActual + verdict}</p>`;
}

function rangeEvidence(text, sample) {
  const equation = fill(text.rangeEquation, {
    measured: amount(sample.rawRange),
    travelled: amount(sample.x - sample.measuredX),
    estimate: amount(sample.usedRange),
  });
  return html`<p>${text.rangeSentence}</p>
    <p class="sys-timing-equation">${equation}</p>
    <p>${text.rangeNote}</p>`;
}

// timing/queue has nothing to show, and timing/delay only when the age is compensated for.
function timingEvidence(run, index, started) {
  if (run.topic === 'queue') return nothing;
  if (run.topic === 'delay' && !run.config.compensate) return nothing;
  const text = copy.evidence.timing;
  const mapping = run.topic === 'alignment';
  const title = mapping ? text.mapTitle : text.rangeTitle;
  const sample = run.samples[index];
  // Until the first range arrives there is nothing to put in the equation.
  if (!started || sample.stamp === null)
    return evidencePanel(title, html`<p>${text.pending}</p>`, null);
  const body = mapping ? mapEvidence(text, run.config, sample) : rangeEvidence(text, sample);
  return evidencePanel(title, body, text.note);
}

function systemEvidence(run, index, started = true) {
  if (run.course === 'tracking' && run.topic === 'prediction')
    return predictionEvidence(run, index, started);
  if (run.course === 'timing') return timingEvidence(run, index, started);
  return nothing;
}

export { systemState, systemEvidence };
