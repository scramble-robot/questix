import { html, nothing } from '../vendor/lit-html.js';
import { loadJson } from '../core/content.js';
import { controlConceptStep } from './core.js';
import { fillSentence as fill } from '../core/content.js';

// "Try one number through the formula" panel of the P, I and D topics. The learner supplies a
// measurement by hand; this demonstrates one calculation, not the response of a second physical
// robot or a new controller setting. Sentences live in content/control/concepts.json.

const copy = await loadJson('content/control/concepts.json');

const CONCEPT_KINDS = ['p', 'i', 'd'];
// The number field differs per concept: rpm for the speed examples, metres for the distance one.
const CONCEPT_INPUTS = {
  p: { min: '0', max: '100', step: '10', start: '50', unit: 'rpm', quantity: 'speed' },
  i: { min: '0', max: '100', step: '10', start: '50', unit: 'rpm', quantity: 'speed' },
  d: { min: '.5', max: '1.5', step: '.1', start: '.8', unit: 'm', quantity: 'distance' },
};

const num = (value, digits = 1) => Number(value).toFixed(digits);

function signPrefix(value) {
  if (value < 0) return '−';
  if (value > 0) return '＋';
  return '';
}

const signed = (value, digits = 1) => signPrefix(value) + num(Math.abs(value), digits);

// The state of one concept panel. `total` is the correction I has accumulated (per cent),
// `seconds` how many one-second steps the learner has taken, `last` the step just taken.
function conceptState(topicId) {
  if (!CONCEPT_KINDS.includes(topicId)) return null;
  return { kind: topicId, value: CONCEPT_INPUTS[topicId].start, total: 0, seconds: 0, last: null };
}

// The typed number, or null while the field is empty or outside its range.
function conceptReading(concept) {
  const field = CONCEPT_INPUTS[concept.kind];
  const value = Number(concept.value);
  if (concept.value === '' || !Number.isFinite(value)) return null;
  if (value < Number(field.min) || value > Number(field.max)) return null;
  return value;
}

// One second of I accumulating at the current error.
function advanceConcept(concept) {
  const measured = conceptReading(concept);
  if (measured === null) return concept;
  const step = controlConceptStep(concept.kind, measured, concept.total);
  return {
    ...concept,
    last: { before: concept.total, error: step.error },
    total: step.correction,
    seconds: concept.seconds + 1,
  };
}

const resetConcept = (concept) => ({ ...concept, total: 0, seconds: 0, last: null });

const row = (label, value) => html`<div><span>${label}</span><strong>${value}</strong></div>`;

function proportionalNote(error) {
  if (error > 0) return copy.p.slow;
  if (error < 0) return copy.p.fast;
  return copy.p.zero;
}

function integralTrend(error) {
  if (error === 0) return copy.i.zero;
  return error < 0 ? copy.i.fast : copy.i.slow;
}

function derivativeNote(error) {
  if (error < 0) return copy.d.closing;
  if (error > 0) return copy.d.opening;
  return copy.d.still;
}

function proportionalResult(measured) {
  const step = controlConceptStep('p', measured);
  return html`${row(copy.rows.pError, `60 − ${num(measured)} = ${signed(step.error)} rpm`)}${row(
      copy.rows.pOutput,
      `${signed(step.error)} × 1.2 = ${signed(step.correction)}%`,
    )}
    <p>${proportionalNote(step.error) + copy.p.notCumulative}</p>`;
}

function integralResult(concept, measured) {
  const step = controlConceptStep('i', measured, concept.total);
  const last = concept.last;
  return html`${row(copy.rows.iError, `60 − ${num(measured)} = ${signed(step.error)} rpm`)}${row(
      fill(copy.rows.iTotal, { seconds: concept.seconds }),
      `${signed(concept.total)}%`,
    )}
    <p>
      ${
        last
          ? fill(copy.i.lastStep, {
              before: signed(last.before),
              error: signed(last.error),
              total: signed(concept.total),
            })
          : copy.i.noStep
      }
    </p>
    <p>${fill(copy.i.nextStep, { error: signed(step.error) }) + integralTrend(step.error)}</p>
    ${Math.abs(concept.total) > 100 ? html`<p>${copy.i.over100}</p>` : nothing}`;
}

function derivativeResult(measured) {
  const step = controlConceptStep('d', measured);
  const change = signed(step.error, 2);
  return html`${row(copy.rows.dChange, `${num(measured, 2)} − 1.00 = ${change} m`)}${row(
      copy.rows.dRate,
      `${change} ÷ 1秒 = ${change} m/秒`,
    )}${row(copy.rows.dOutput, `${signed(step.correction)}%`)}
    <p>${derivativeNote(step.error) + copy.d.scale}</p>`;
}

function conceptResult(concept) {
  const measured = conceptReading(concept);
  const field = CONCEPT_INPUTS[concept.kind];
  if (measured === null) return fill(copy.outOfRange, { min: field.min, max: field.max });
  if (concept.kind === 'p') return proportionalResult(measured);
  if (concept.kind === 'i') return integralResult(concept, measured);
  return derivativeResult(measured);
}

/**
 * The foldable "check the calculation with your own number" panel. Returns `nothing` for the
 * topics that have no such panel, so the caller can drop it straight into a template.
 */
function conceptLesson(concept, actions) {
  if (!concept) return nothing;
  const field = CONCEPT_INPUTS[concept.kind];
  return html`<details data-help-dialog class="control-concept">
    <summary>${concept.kind.toUpperCase() + 'の計算を、数値を変えて確かめる'}</summary>
    <div class="control-concept-body">
      <p>${copy.intro[concept.kind]}</p>
      <p class="helper">${copy.gainNote[concept.kind]}</p>
      <label class="control-concept-input" for="conceptMeasured"
        >${copy.inputLabel[field.quantity]}<span
          ><input
            id="conceptMeasured"
            type="number"
            min=${field.min}
            max=${field.max}
            step=${field.step}
            .value=${concept.value}
            @input=${(event) => actions.setConceptValue(event.target.value)}
          />
          ${field.unit}</span
        ></label
      >
      ${
        concept.kind === 'i'
          ? html`<div class="control-concept-actions">
              <button
                id="conceptAdvance"
                class="primary"
                ?disabled=${conceptReading(concept) === null}
                @click=${actions.advanceConcept}
              >
                この測定値のまま1秒進める
              </button>
              <button id="conceptReset" @click=${actions.resetConcept}>積み重ねを0に戻す</button>
            </div>`
          : nothing
      }
      <div id="conceptResult" class="control-concept-result" role="status" aria-live="polite">
        ${conceptResult(concept)}
      </div>
      <p class="helper">${copy.scope}</p>
    </div>
  </details>`;
}

export {
  controlConceptStep,
  conceptState,
  conceptReading,
  advanceConcept,
  resetConcept,
  conceptLesson,
};
