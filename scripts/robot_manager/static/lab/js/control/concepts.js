import { html, nothing } from '../vendor/lit-html.js';
import { loadJson, fillSentence as fill } from '../core/content.js';
import { controlConceptStep } from './core.js';
import {
  CONCEPT_INPUTS,
  conceptState,
  conceptReading,
  advanceConcept,
  resetConcept,
  conceptOutcome,
} from './concepts-core.js';

// "Try one number through the formula" panel of the P, I and D topics. The learner supplies a
// measurement by hand; this demonstrates one calculation, not the response of a second physical
// robot or a new controller setting. The state and the numbers come from concepts-core.js (no
// DOM, tested); sentences live in content/control/concepts.json.

const copy = await loadJson('content/control/concepts.json');

const num = (value, digits = 1) => Number(value).toFixed(digits);

function signPrefix(value) {
  if (value < 0) return '−';
  if (value > 0) return '＋';
  return '';
}

const signed = (value, digits = 1) => signPrefix(value) + num(Math.abs(value), digits);

const row = (label, value) => html`<div><span>${label}</span><strong>${value}</strong></div>`;

const speedError = (outcome) =>
  `${outcome.target} − ${num(outcome.measured)} = ${signed(outcome.error)} rpm`;

function proportionalResult(outcome) {
  return html`${row(copy.rows.pError, speedError(outcome))}${row(
      copy.rows.pOutput,
      `${signed(outcome.error)} × 1.2 = ${signed(outcome.correction)}%`,
    )}
    <p>${copy.p[outcome.note] + copy.p.notCumulative}</p>`;
}

function integralResult(outcome) {
  const last = outcome.last;
  return html`${row(copy.rows.iError, speedError(outcome))}${row(
      fill(copy.rows.iTotal, { seconds: outcome.seconds }),
      `${signed(outcome.total)}%`,
    )}
    <p>
      ${
        last
          ? fill(copy.i.lastStep, {
              before: signed(last.before),
              error: signed(last.error),
              total: signed(outcome.total),
            })
          : copy.i.noStep
      }
    </p>
    <p>${fill(copy.i.nextStep, { error: signed(outcome.error) }) + copy.i[outcome.note]}</p>
    ${outcome.overLimit ? html`<p>${copy.i.over100}</p>` : nothing}`;
}

function derivativeResult(outcome) {
  const change = signed(outcome.error, 2);
  return html`${row(
      copy.rows.dChange,
      `${num(outcome.measured, 2)} − ${num(outcome.previousDistance, 2)} = ${change} m`,
    )}${row(copy.rows.dRate, `${change} ÷ 1秒 = ${change} m/秒`)}${row(
      copy.rows.dOutput,
      `${signed(outcome.correction)}%`,
    )}
    <p>${copy.d[outcome.note] + copy.d.scale}</p>`;
}

function conceptResult(concept) {
  const outcome = conceptOutcome(concept);
  const field = CONCEPT_INPUTS[concept.kind];
  if (!outcome) return fill(copy.outOfRange, { min: field.min, max: field.max });
  if (outcome.kind === 'p') return proportionalResult(outcome);
  if (outcome.kind === 'i') return integralResult(outcome);
  return derivativeResult(outcome);
}

function integralButtons(concept, actions) {
  if (concept.kind !== 'i') return nothing;
  return html`<div class="control-concept-actions">
    <button
      id="conceptAdvance"
      class="primary"
      ?disabled=${conceptReading(concept) === null}
      @click=${actions.advanceConcept}
    >
      この測定値のまま1秒進める
    </button>
    <button id="conceptReset" @click=${actions.resetConcept}>積み重ねを0に戻す</button>
  </div>`;
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
      ${integralButtons(concept, actions)}
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
