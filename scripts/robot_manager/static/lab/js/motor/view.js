import { html, nothing, unsafeHTML } from '../vendor/lit-html.js';
import { formatNumber } from '../core/dom.js';
import { fillSentence } from '../core/content.js';
import { niceScale } from '../core/chart-scale.js';
import { roleStyle } from '../core/palette.js';
import { htmlChart } from '../core/html-chart.js';
import { lessonLabel } from '../shell/lesson-ui.js';
import { schoolTips } from '../shell/school-tips.js';
import { lessonBrief } from '../shell/lesson-brief.js';
import { runModeBadgeHtml } from '../shell/run-mode.js';
import { LOAD_TIME, LOAD_TARGET, RUN_SECONDS, SERVO_MIN, SERVO_MAX, REAL_PARTS } from './core.js';
import {
  exteriorFigure,
  motorSection,
  coilCloseup,
  rotorFigure,
  servoFigure,
  gearFigure,
  questixMotorsFigure,
} from './render.js';

// Templates of the motor course. Every function is pure: it turns the model built by ui.js into
// markup. Learner-facing sentences come from content/motor.json (`copy`) and content/motor/*.html
// (`fragments`); only short labels and units live here.

const CHOICE_JOBS = ['drive', 'roller', 'feeder'];
const CHOICE_OPTIONS = ['angle', 'drive', 'speed'];
const CHART_TICKS = 4;

// --- Navigation and page frame -----------------------------------------------------------------

function groupNav(model, copy, actions) {
  return html`<nav class="step-nav motor-groups" aria-label=${copy.page.groupNavLabel}>
    ${copy.groups.map(
      (group, index) =>
        html`<button
          data-motor-group=${index}
          aria-current=${model.group === index ? 'step' : 'false'}
          @click=${() => actions.openGroup(index)}
        >
          <span>${index + 1}</span>${group}
        </button>`,
    )}
  </nav>`;
}

function topicNav(model, copy, actions) {
  return html`<nav class="motor-topics" aria-label=${copy.page.topicNavLabel}>
    ${model.groupTopics.map(
      (id) =>
        html`<button
          data-motor-topic=${id}
          aria-pressed=${String(id === model.topic)}
          @click=${() => actions.openTopic(id)}
        >
          ${copy.topics[id].label}
        </button>`,
    )}
  </nav>`;
}

function footer(model, copy, actions) {
  const position = fillSentence(copy.page.position, {
    number: String(model.position + 1),
    total: String(model.total),
    label: copy.topics[model.topic].label,
  });
  const caption = model.next
    ? fillSentence(copy.page.next, { label: copy.topics[model.next].label })
    : copy.page.quiz;
  return html`<footer class="basics-footer">
    <p>${position}</p>
    <button id="motorNext" class="primary" @click=${actions.next}>${caption} →</button>
  </footer>`;
}

// --- Settings ----------------------------------------------------------------------------------

function selectSetting(model, key, text, actions, { disabled = false, note = '' } = {}) {
  const value = String(model.config[key]);
  return html`<label class="motor-setting"
    >${text.label}<select
      data-motor-setting=${key}
      .value=${value}
      ?disabled=${disabled}
      @change=${(event) => actions.setSetting(key, event.target.value)}
    >
      ${Object.entries(text.options).map(
        ([option, caption]) =>
          html`<option value=${option} ?selected=${option === value}>${caption}</option>`,
      )}
    </select>
    ${note ? html`<span class="motor-setting-note">${note}</span>` : nothing}
  </label>`;
}

function rangeSetting(model, key, text, limits, actions) {
  const value = model.config[key];
  return html`<label class="motor-setting" for=${'motorInput-' + key}
    >${text.label}<output id=${'motorValue-' + key}>${value} ${text.unit}</output
    ><input
      id=${'motorInput-' + key}
      type="range"
      data-motor-setting=${key}
      min=${limits.min}
      max=${limits.max}
      step=${limits.step}
      .value=${String(value)}
      @input=${(event) => actions.setSetting(key, event.target.value)}
  /></label>`;
}

function fieldSettings(model, copy, actions) {
  const fixed = model.config.mode === 'fixed';
  return html`${selectSetting(model, 'mode', copy.settings.mode, actions)}${selectSetting(
    model,
    'direction',
    copy.settings.direction,
    actions,
    { disabled: fixed, note: fixed ? copy.settings.direction.disabledNote : '' },
  )}`;
}

function topicSettings(model, copy, actions) {
  const text = copy.settings;
  switch (model.topic) {
    case 'field':
      return fieldSettings(model, copy, actions);
    case 'load':
      return html`${rangeSetting(model, 'power', text.power, { min: 0, max: 100, step: 5 }, actions)}${rangeSetting(
          model,
          'load',
          text.load,
          { min: 0, max: 0.15, step: 0.01 },
          actions,
        )}
        <p class="helper">${text.loadHelper}</p>`;
    case 'transmission':
      return html`${selectSetting(model, 'ratio', text.ratio, actions)}
        <p class="helper">${text.ratioHelper}</p>`;
    case 'esc':
      return html`${selectSetting(model, 'voltage', text.voltage, actions)}${rangeSetting(
          model,
          'throttle',
          text.throttle,
          { min: 0, max: 100, step: 5 },
          actions,
        )}${selectSetting(model, 'loaded', text.loaded, actions)}
        <p class="helper">${text.escHelper}</p>`;
    case 'servo':
      return html`${rangeSetting(model, 'target', text.target, { min: SERVO_MIN, max: SERVO_MAX, step: 15 }, actions)}${selectSetting(
          model,
          'feedback',
          text.feedback,
          actions,
        )}
        <p class="helper">${text.servoHelper}</p>`;
    default:
      return nothing;
  }
}

function kvBox(model, copy) {
  if (model.topic !== 'esc') return nothing;
  const kv = model.kv;
  return html`<div class="motor-kv" id="motorKV">
    <strong>${copy.kv.title}</strong>
    <p>
      ${fillSentence(copy.kv.formula, {
        voltage: String(kv.voltage),
        rpm: kv.rpm.toLocaleString('ja-JP'),
      })}
    </p>
    <p>${fillSentence(copy.kv.cells, { voltage: String(kv.voltage), cells: String(kv.cells) })}</p>
    <small>${copy.kv.note}</small>
  </div>`;
}

function helpDetails(model, copy, fragments) {
  const extra = {
    load: html`<details data-help-dialog class="motor-help">
      <summary>${copy.help.load}</summary>
      ${unsafeHTML(fragments.loadHelp)}
    </details>`,
    field: html`<details data-help-dialog class="motor-help">
      <summary>${copy.help.brush}</summary>
      ${unsafeHTML(fragments.brushHelp)}
    </details>`,
  };
  return html`${extra[model.topic] ?? nothing}
    <details data-help-dialog class="motor-hardware">
      <summary>${copy.help.hardware}</summary>
      ${unsafeHTML(fragments.hardware)}
    </details>`;
}

function guide(model, copy, fragments, actions) {
  const topic = copy.topics[model.topic];
  const eyebrow = model.played ? copy.page.guideEyebrowRun : copy.page.guideEyebrowRead;
  return html`<aside class="guide card motor-guide">
    <p class="eyebrow">${eyebrow}</p>
    <h2>${topic.guideTitle}</h2>
    <p>${topic.explanation}</p>
    ${topicSettings(model, copy, actions)}
    ${
      model.played
        ? html`<button id="motorRun" class="primary full" @click=${actions.run}>
              ${model.run.result ? copy.run.again : copy.run.button}
            </button>
            <p id="motorDirty" class="helper" role="status">
              ${model.run.dirty ? copy.run.dirty : ''}
            </p>`
        : nothing
    }
    ${kvBox(model, copy)} ${helpDetails(model, copy, fragments)}
  </aside>`;
}

// --- Played experiments: scene, readouts, charts, playback ------------------------------------

function phase(run, copy) {
  if (!run.result) return copy.run.before;
  if (run.playing) return copy.run.running;
  return run.atEnd ? copy.run.done : copy.run.paused;
}

function clock(run, copy) {
  if (!run.result) return copy.run.before;
  return fillSentence(copy.run.clock, {
    phase: phase(run, copy),
    time: formatNumber(run.sample.time, 1),
  });
}

function playLabel(run, copy) {
  if (run.playing) return copy.run.pause;
  if (!run.result) return copy.run.play;
  return run.atEnd ? copy.run.replay : copy.run.resume;
}

function eventText(model, copy) {
  const run = model.run;
  if (!run.result) return copy.run.ready;
  const text = copy.events;
  const after = run.sample.time >= LOAD_TIME;
  if (model.topic === 'field') return text.field;
  if (model.topic === 'servo') return after ? text.servoAfter : text.servoBefore;
  if (model.topic === 'esc' && !run.result.config.loaded)
    return after ? text.noLoadAfter : text.noLoadBefore;
  return after ? text.loadAfter : text.loadBefore;
}

function scene(model, copy) {
  const sample = model.run.sample;
  const text = copy.scene;
  const shown = model.run.result?.config ?? model.config;
  if (model.topic === 'field')
    return motorSection(
      { angle: sample.angle, field: sample.field, powered: Boolean(model.run.result) },
      copy.structure.steps[1].figureLabel,
    );
  if (model.topic === 'servo')
    return servoFigure(
      {
        reference: sample.reference || shown.target,
        degrees: sample.degrees,
        pushed: Boolean(model.run.result) && sample.time >= LOAD_TIME,
      },
      text,
      text.figureLabelServo,
    );
  const esc = model.topic === 'esc';
  return rotorFigure(
    {
      angle: sample.angle,
      topic: model.topic,
      boxTitle: esc ? text.rotorEsc : text.rotorSupply,
      boxValue: `${esc ? shown.throttle : shown.power}%`,
    },
    text.figureLabelRotor,
  );
}

function sceneTitle(model, copy) {
  if (model.topic === 'field') return copy.scene.fieldTitle;
  if (model.topic === 'servo') return copy.scene.servoTitle;
  return model.topic === 'esc' ? copy.scene.rotorTitleEsc : copy.scene.rotorTitle;
}

function sceneKey(model, copy) {
  if (model.topic === 'field')
    return model.run.result ? copy.scene.fieldKeyPowered : copy.scene.fieldKeyIdle;
  if (model.topic === 'servo') return copy.scene.servoKey;
  return copy.scene.slowNote;
}

function metricItems(model, copy) {
  const sample = model.run.sample;
  const text = copy.metrics;
  const shown = model.run.result?.config ?? model.config;
  if (model.topic === 'field')
    return [
      [text.angle, formatNumber(sample.degrees, 0) + '°'],
      [text.motion, shown.mode === 'fixed' ? text.motionFixed : text.motionRotate],
    ];
  if (model.topic === 'servo')
    return [
      [text.target, formatNumber(sample.reference || shown.target, 0) + '°'],
      [text.actual, formatNumber(sample.degrees, 1) + '°'],
      [text.holdTorque, formatNumber(Math.abs(sample.torque), 2) + ' N·m'],
    ];
  if (model.topic === 'esc')
    return [
      [text.rpm, formatNumber(sample.rpm, 0) + ' rpm'],
      [text.loadCondition, shown.loaded ? text.loaded : text.unloaded],
    ];
  return [
    [text.rpm, formatNumber(sample.rpm, 0) + ' rpm'],
    [text.current, formatNumber(sample.current, 2) + ' A'],
    [text.heating, formatNumber(sample.heating, 2) + ' W'],
  ];
}

function metrics(model, copy) {
  return html`<div id="motorMetrics" class="motor-metrics">
    ${metricItems(model, copy).map(
      ([name, value]) => html`<div><span>${name}</span><strong>${value}</strong></div>`,
    )}
  </div>`;
}

// One line chart of `key` over the run. The axis range is fixed for the whole run (and the previous
// run shown with it), never recomputed from the part played so far.
function timeChart(model, copy, { key, title, label, digits = 0, extraValues = [], hlines = [] }) {
  const run = model.run;
  const text = copy.charts;
  const toPoints = (samples) => samples.map((sample) => [sample.time, sample[key]]);
  const all = [...run.result.samples, ...(run.previous?.samples ?? [])];
  const y = niceScale([...all.map((sample) => sample[key]), ...extraValues], {
    ticks: CHART_TICKS,
  });
  const series = [];
  if (run.previous)
    series.push({
      ...roleStyle('previous'),
      points: toPoints(run.previous.samples),
      label: text.previous,
    });
  series.push({
    ...roleStyle('actual'),
    points: toPoints(run.result.samples.slice(0, run.index + 1)),
    label: `${text.now} ${formatNumber(run.sample[key], digits)}`,
  });
  const event = roleStyle('event');
  const showEvent = !(model.topic === 'esc' && !run.result.config.loaded);
  const eventLabel = model.topic === 'servo' ? text.pushEvent : text.loadEvent;
  return htmlChart({
    label,
    yTitle: title,
    xTitle: text.timeTitle,
    x: niceScale([0, RUN_SECONDS], { padding: 0, ticks: RUN_SECONDS }),
    y,
    series,
    hlines,
    clearOfHlineLabels: true,
    vlines: showEvent
      ? [{ x: LOAD_TIME, label: eventLabel, color: event.color, dash: event.dash }]
      : [],
  });
}

// A horizontal line across a chart in the colour and dash of its role, with its label.
function referenceLine(role, y, label) {
  const style = roleStyle(role);
  return { y, label, color: style.color, dash: style.dash };
}

function servoChart(model, copy) {
  const text = copy.charts;
  const degrees = model.run.result.config.target;
  const label = fillSentence(text.servoTarget, { degrees: String(degrees) });
  return timeChart(model, copy, {
    key: 'degrees',
    title: text.angleTitle,
    label: text.angleLabel,
    digits: 1,
    extraValues: [degrees],
    hlines: [referenceLine('target', degrees, label)],
  });
}

// The KV estimate is a prediction, so it is drawn in the plan role (magenta dash-dot).
function escChart(model, copy) {
  const text = copy.charts;
  const estimate = model.run.result.samples[0].reference;
  const label = fillSentence(text.kvEstimate, { rpm: formatNumber(estimate, 0) });
  return timeChart(model, copy, {
    key: 'rpm',
    title: text.rpmTitle,
    label: text.rpmLabel,
    extraValues: [estimate],
    hlines: [referenceLine('plan', estimate, label)],
  });
}

// Speed and current share the time axis, one chart above the other.
function loadCharts(model, copy) {
  const text = copy.charts;
  return html`${timeChart(model, copy, {
    key: 'rpm',
    title: text.rpmTitle,
    label: text.rpmLabel,
    extraValues: [LOAD_TARGET.rpm],
    hlines: [referenceLine('target', LOAD_TARGET.rpm, text.loadTarget)],
  })}${timeChart(model, copy, {
    key: 'current',
    title: text.currentTitle,
    label: text.currentLabel,
    digits: 2,
  })}`;
}

const CHARTS = { load: loadCharts, esc: escChart, servo: servoChart };

function charts(model, copy) {
  const chart = CHARTS[model.topic];
  if (!model.run.result || !chart) return nothing;
  return chart(model, copy);
}

// The result sentence of a finished run, with that run's numbers.
function resultSentence(model, copy) {
  const summary = model.run.summary;
  const text = copy.results;
  const n = (value, digits = 0) => formatNumber(value, digits);
  if (model.topic === 'field') {
    if (summary.mode === 'fixed')
      return fillSentence(text.fieldFixed, { degrees: n(summary.finalDegrees) });
    const direction = model.run.result.config.direction > 0 ? text.directionCcw : text.directionCw;
    return fillSentence(text.fieldRotate, { direction, turns: n(summary.turns, 1) });
  }
  if (model.topic === 'load') {
    const values = {
      beforeRpm: n(summary.beforeRpm),
      afterRpm: n(summary.afterRpm),
      beforeCurrent: n(summary.beforeCurrent, 2),
      afterCurrent: n(summary.afterCurrent, 2),
      afterHeating: n(summary.afterHeating, 2),
      direction: summary.afterRpm < LOAD_TARGET.rpm ? text.raise : text.lower,
    };
    return fillSentence(summary.inTarget ? text.loadInTarget : text.loadMissed, values);
  }
  if (model.topic === 'esc')
    return fillSentence(summary.loaded ? text.escLoaded : text.escUnloaded, {
      beforeRpm: n(summary.beforeRpm),
      afterRpm: n(summary.afterRpm),
      drop: n(summary.dropPercent),
      estimate: n(summary.estimate),
    });
  return fillSentence(summary.feedback ? text.servoHeld : text.servoFree, {
    maxDeviation: n(summary.maxDeviation, 1),
    finalDegrees: n(summary.finalDegrees, 1),
    target: n(summary.target),
    finalError: n(summary.finalError, 1),
    holdingTorque: n(summary.holdingTorque, 2),
  });
}

function playback(model, copy, actions) {
  const run = model.run;
  return html`<div class="motor-playback">
    <button id="motorPlay" class="small" ?disabled=${!run.result} @click=${actions.togglePlay}>
      ${playLabel(run, copy)}</button
    ><input
      id="motorSeek"
      type="range"
      min="0"
      max=${run.last}
      .value=${String(run.index)}
      aria-label=${copy.run.seekLabel}
      ?disabled=${!run.result}
      @input=${(event) => actions.seek(Number(event.target.value))}
    />
    <p id="motorEvent" class="motor-event">${eventText(model, copy)}</p>
  </div>`;
}

function playedCard(model, copy, actions) {
  const run = model.run;
  return html`<section class="card motor-main" id="motorMain">
    <div class="motor-status">
      <strong id="motorClock">${clock(run, copy)}</strong><span>${copy.page.modelBadge}</span>
    </div>
    <div class="motor-scene-row">
      <figure class="motor-scene">
        <figcaption>${sceneTitle(model, copy)}</figcaption>
        <div id="motorScene">${scene(model, copy)}</div>
        <p class="motor-scene-key">${sceneKey(model, copy)}</p>
      </figure>
      ${metrics(model, copy)}
    </div>
    <div id="motorChart" class="motor-charts">${charts(model, copy)}</div>
    ${run.previous && model.topic !== 'field' ? html`<p class="motor-chart-note">${copy.charts.previousNote}</p>` : nothing}
    ${playback(model, copy, actions)}
    <p id="motorConclusion" class="motor-task" role="status" ?hidden=${!run.summary}>
      ${run.summary ? resultSentence(model, copy) : ''}
    </p>
  </section>`;
}

// --- Structure of a motor (field topic) ----------------------------------------------------------

function structureFigure(model, copy) {
  const step = copy.structure.steps[model.structure.step];
  if (model.structure.step === 0) return exteriorFigure(step.figureLabel);
  if (model.structure.step === 1)
    return motorSection({ angle: Math.PI / 6, field: 0, powered: false }, step.figureLabel);
  return coilCloseup(model.structure.coil, copy.structure.power, step.figureLabel);
}

function coilSwitch(model, copy, actions) {
  const text = copy.structure;
  const currents = [0, 1, -1];
  const result = {
    0: text.coilResults.off,
    1: text.coilResults.forward,
    '-1': text.coilResults.reverse,
  };
  return html`<div class="motor-coil-switch" role="group" aria-label=${text.coilLabel}>
      ${currents.map(
        (current, index) =>
          html`<button
            data-coil-current=${current}
            aria-pressed=${String(model.structure.coil === current)}
            @click=${() => actions.setCoil(current)}
          >
            ${text.coilButtons[index]}
          </button>`,
      )}
    </div>
    <p class="motor-coil-result" role="status">${result[model.structure.coil]}</p>`;
}

function structureCard(model, copy, actions) {
  const text = copy.structure;
  const index = model.structure.step;
  const step = text.steps[index];
  return html`<section class="card motor-structure" aria-labelledby="motorStructureTitle">
    <header>
      <h2 id="motorStructureTitle">${text.title}</h2>
      <nav aria-label=${text.navLabel}>
        ${text.tabs.map(
          (tab, tabIndex) =>
            html`<button
              data-motor-structure=${tabIndex}
              aria-pressed=${String(index === tabIndex)}
              @click=${() => actions.setStructure(tabIndex)}
            >
              ${tab}
            </button>`,
        )}
      </nav>
    </header>
    <div class="motor-structure-body" id="motorStructureBody">
      <figure class="motor-structure-picture">
        ${structureFigure(model, copy)}
        <ul class="motor-figure-key">
          ${step.key.map((item) => html`<li>${item}</li>`)}
        </ul>
        ${index === 2 ? coilSwitch(model, copy, actions) : nothing}
      </figure>
      <div class="motor-structure-copy">
        <p class="eyebrow">${fillSentence(text.eyebrow, { step: String(index + 1) })}</p>
        <h3>${step.title}</h3>
        <p>${step.copy}</p>
        <p class="motor-structure-note">${step.note}</p>
        <button id="motorStructureNext" class="primary" @click=${actions.structureNext}>
          ${step.next}
        </button>
      </div>
    </div>
    <p class="motor-structure-footnote">${text.footnote}</p>
  </section>`;
}

// --- Transmission --------------------------------------------------------------------------------

function goalLine(name, value, goal, met, copy) {
  return html`<p>
    ${name} <strong>${value}</strong> ／ ${goal}
    <span class=${met ? 'motor-goal-met' : 'motor-goal-missed'}
      >${met ? copy.gear.met : copy.gear.missed}</span
    >
  </p>`;
}

function gearResult(model, copy) {
  const values = model.gear.values;
  const label = copy.settings.ratio.options[String(values.ratio)];
  const numbers = {
    label,
    force: formatNumber(values.force, 1),
    speed: formatNumber(values.speed, 2),
  };
  if (values.forceOk && values.speedOk) return fillSentence(copy.gear.resultBoth, numbers);
  return fillSentence(values.forceOk ? copy.gear.resultSpeed : copy.gear.resultForce, numbers);
}

// Placeholders of the gear texts for the current ratio.
function gearFill(values) {
  return {
    ratio: String(values.ratio),
    teeth: String(values.teeth),
    rpm: formatNumber(values.rpm, 0),
  };
}

function gearScene(model, copy) {
  const text = copy.gear;
  const { values, turns } = model.gear;
  const direct = values.ratio === 1;
  const fill = gearFill(values);
  const ariaLabel = fillSentence(direct ? text.figureLabelDirect : text.figureLabelGear, fill);
  const key = (direct ? text.keyDirect : text.keyGear).map((item) => fillSentence(item, fill));
  return html`<figure class="motor-scene motor-gear-scene">
    <div id="motorGearScene">${gearFigure(values.ratio, turns, ariaLabel)}</div>
    <ul class="motor-figure-key">
      ${key.map((item) => html`<li>${item}</li>`)}
    </ul>
  </figure>`;
}

// Scrubbing the motor by hand: the wheel follows at the gear's ratio.
function gearDemo(model, copy, actions) {
  const text = copy.gear;
  const { values, turns } = model.gear;
  const count = fillSentence(text.turnCount, {
    motor: formatNumber(turns, 2),
    wheel: formatNumber(turns / values.ratio, 2),
  });
  return html`<div class="motor-gear-demo">
    <label for="motorGearTurn">${text.turnLabel}</label>
    <input
      id="motorGearTurn"
      type="range"
      min="0"
      max="6"
      step="0.01"
      .value=${String(turns)}
      @input=${(event) => actions.turnGear(Number(event.target.value))}
    />
    <output id="motorGearCount" for="motorGearTurn">${count}</output>
    <p>${values.ratio === 1 ? text.turnDirect : text.turnGear}</p>
  </div>`;
}

function gearGoals(model, copy) {
  const text = copy.gear;
  const values = model.gear.values;
  const force = formatNumber(values.force, 1) + ' N';
  const speed = formatNumber(values.speed, 2) + ' m/秒';
  return html`<div class="motor-metrics">
      <div><span>${text.wheelRpm}</span><strong>${formatNumber(values.rpm, 0)} rpm</strong></div>
      <div>
        <span>${text.wheelTorque}</span><strong>${formatNumber(values.torque, 3)} N·m</strong>
      </div>
    </div>
    <div class="motor-task">
      <h3>${text.goalTitle}</h3>
      ${goalLine(text.force, force, text.forceGoal, values.forceOk, copy)}
      ${goalLine(text.speed, speed, text.speedGoal, values.speedOk, copy)}
      <p role="status" id="motorGearResult">${gearResult(model, copy)}</p>
    </div>`;
}

function gearCard(model, copy, actions) {
  const text = copy.gear;
  const values = model.gear.values;
  const direct = values.ratio === 1;
  return html`<section class="card motor-main motor-gear" id="motorMain">
    <div class="motor-gear-heading">
      <h3>${direct ? text.directTitle : text.gearTitle}</h3>
      <p>${direct ? text.directCopy : fillSentence(text.gearCopy, gearFill(values))}</p>
    </div>
    ${gearScene(model, copy)} ${gearDemo(model, copy, actions)} ${gearGoals(model, copy)}
    <p class="motor-note">${text.powerNote}</p>
  </section>`;
}

// --- Choosing for QUESTiX ------------------------------------------------------------------------

function choiceVerdict(job, { choices, evaluation }, text) {
  if (!choices[job]) return text.unchosen;
  return evaluation[job] ? text.right : text.retry;
}

function choiceFeedback(model, copy) {
  const { checked, evaluation } = model.choose;
  if (!checked) return html`<div id="motorChoiceFeedback" class="motor-task" hidden></div>`;
  const text = copy.choose;
  const count = CHOICE_JOBS.filter((job) => evaluation[job]).length;
  return html`<div id="motorChoiceFeedback" class="motor-task" role="status">
    <p><strong>${fillSentence(text.score, { count: String(count) })}</strong></p>
    ${CHOICE_JOBS.map(
      (job) =>
        html`<p>
          <strong>${text.jobs[job].title}：${choiceVerdict(job, model.choose, text)}</strong
          ><br />${text.reasons[job]}
        </p>`,
    )}
  </div>`;
}

// One job and its three possible instructions, all visible (radio buttons, not a menu).
function choiceJob(job, model, copy, actions) {
  const text = copy.choose;
  return html`<section>
    <h3>${text.jobs[job].title}</h3>
    <p>${text.jobs[job].copy}</p>
    <fieldset class="motor-choice-options">
      <legend>${text.selectLabel}</legend>
      ${CHOICE_OPTIONS.map(
        (option) =>
          html`<label
            ><input
              type="radio"
              name=${'motorChoice-' + job}
              data-motor-choice=${job}
              value=${option}
              .checked=${model.choose.choices[job] === option}
              @change=${() => actions.choose(job, option)}
            />${text.options[option]}</label
          >`,
      )}
    </fieldset>
  </section>`;
}

function classification(copy) {
  const text = copy.choose;
  return html`<div class="motor-classification">
    <h3>${text.classTitle}</h3>
    <dl>
      ${text.classes.map(
        (entry) =>
          html`<div>
            <dt>${entry.term}</dt>
            <dd>${entry.meaning}</dd>
          </div>`,
      )}
    </dl>
    <p>${text.classNote}</p>
  </div>`;
}

function chooseCard(model, copy, actions) {
  const text = copy.choose;
  return html`<section class="card motor-main motor-choose" id="motorMain">
    <figure class="motor-scene motor-questix">
      <figcaption>${text.figureTitle}</figcaption>
      ${questixMotorsFigure(text, text.figureLabel)}
      <ul class="motor-figure-key">
        ${text.figureKey.map((item) => html`<li>${item}</li>`)}
      </ul>
    </figure>
    <div class="motor-choice-grid">
      ${CHOICE_JOBS.map((job) => choiceJob(job, model, copy, actions))}
    </div>
    <div class="motor-choice-check">
      <button class="primary" id="motorCheck" @click=${actions.checkChoices}>${text.check}</button>
    </div>
    ${choiceFeedback(model, copy)} ${classification(copy)}
  </section>`;
}

// --- Real motors ---------------------------------------------------------------------------------

function planPicker(model, copy, actions) {
  const text = copy.real;
  const plan = text.plans[model.real.part];
  return html`<label class="motor-setting"
      >${text.partLabel}<select
        data-motor-setting="part"
        .value=${model.real.part}
        @change=${(event) => actions.setSetting('part', event.target.value)}
      >
        ${REAL_PARTS.map(
          (part) =>
            html`<option value=${part} ?selected=${part === model.real.part}>
              ${text.plans[part].name}
            </option>`,
        )}
      </select></label
    >
    <ol id="motorPlan" class="motor-plan">
      ${['change', 'record', 'compare'].map(
        (key) => html`<li><strong>${text.planLabels[key]}</strong>${plan[key]}</li>`,
      )}
    </ol>`;
}

// `field` is 'prediction' or 'reflection'; the text survives moving between topics (ui.js).
function noteField(field, id, model, copy, actions) {
  const text = copy.real;
  return html`<label class="motor-text"
    >${text[field + 'Label']}<textarea
      id=${id}
      rows="3"
      placeholder=${text[field + 'Placeholder']}
      .value=${model.real[field]}
      @input=${(event) => actions.write(field, event.target.value)}
    ></textarea>
  </label>`;
}

function measurePointer(copy, actions) {
  const text = copy.real;
  return html`<div class="motor-measure-pointer">
    <h3>${text.measureHeading}</h3>
    <p>${text.measureCopy}</p>
    <button id="motorMeasureJump" class="small" @click=${actions.jumpToMeasurements}>
      ${text.measureJump}
    </button>
  </div>`;
}

function realCard(model, copy, fragments, actions) {
  const text = copy.real;
  return html`<section class="card motor-main motor-real" id="motorMain">
    <h2>${unsafeHTML(runModeBadgeHtml('data'))} ${text.title}</h2>
    ${planPicker(model, copy, actions)}
    ${noteField('prediction', 'motorPrediction', model, copy, actions)}
    ${noteField('reflection', 'motorReflection', model, copy, actions)}
    <button id="motorPlanSave" @click=${actions.savePlan}>${text.save}</button>
    <p class="helper">${text.saveHelper}</p>
    ${measurePointer(copy, actions)}
    <details data-help-dialog class="motor-help">
      <summary>${text.rosSummary}</summary>
      ${unsafeHTML(fragments.realRos)}
    </details>
  </section>`;
}

// --- Page ----------------------------------------------------------------------------------------

function mainCard(model, copy, fragments, actions) {
  if (model.played) return playedCard(model, copy, actions);
  if (model.topic === 'transmission') return gearCard(model, copy, actions);
  if (model.topic === 'choose') return chooseCard(model, copy, actions);
  return realCard(model, copy, fragments, actions);
}

function motorPage(model, copy, fragments, actions) {
  const topic = copy.topics[model.topic];
  const lessonKey = 'motor-' + model.topic;
  return html`<div class="page-heading">
      <div>
        <p class="eyebrow course-label">${unsafeHTML(lessonLabel('motor'))}</p>
        <h1>${topic.title}</h1>
      </div>
    </div>
    ${groupNav(model, copy, actions)} ${topicNav(model, copy, actions)}
    ${unsafeHTML(lessonBrief(lessonKey, topic.brief))}
    ${model.topic === 'field' ? structureCard(model, copy, actions) : nothing}
    ${unsafeHTML(schoolTips(lessonKey))}
    <div class="motor-layout">
      ${mainCard(model, copy, fragments, actions)} ${guide(model, copy, fragments, actions)}
    </div>
    <p class="page-footnote">${topic.footnote}</p>
    ${footer(model, copy, actions)}`;
}

export { motorPage };
