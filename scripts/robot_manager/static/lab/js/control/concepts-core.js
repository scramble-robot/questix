import { controlConceptStep } from './core.js';

// State and arithmetic of the "try one number through the formula" panel of the P, I and D
// topics (concepts.js draws it). No DOM: the learner's typed value comes in as the string of the
// number field, and every number the panel shows comes out of controlConceptStep, which runs the
// course's own pidStep. The example is fixed: 60 rpm target, P gain 1.2 and I gain 1 per cent per
// rpm, D gain 1 with the distance one second earlier at 1.00 m.

const CONCEPT_KINDS = ['p', 'i', 'd'];
// The number field differs per concept: rpm for the speed examples, metres for the distance one.
const CONCEPT_INPUTS = {
  p: { min: '0', max: '100', step: '10', start: '50', unit: 'rpm', quantity: 'speed' },
  i: { min: '0', max: '100', step: '10', start: '50', unit: 'rpm', quantity: 'speed' },
  d: { min: '.5', max: '1.5', step: '.1', start: '.8', unit: 'm', quantity: 'distance' },
};
const CONCEPT_TARGET = 60; // rpm, the wheel speed the P and I examples aim for
const CONCEPT_PREVIOUS_DISTANCE = 1; // m, the distance to the wall one second before (D)
const OUTPUT_LIMIT = 100; // per cent; beyond it the real output would be clipped

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

// Which sentence explains the sign of the result: the key of content/control/concepts.json's
// p / i / d section.
function conceptNote(kind, error) {
  if (kind === 'd') {
    if (error < 0) return 'closing';
    return error > 0 ? 'opening' : 'still';
  }
  if (error < 0) return 'fast';
  return error > 0 ? 'slow' : 'zero';
}

/**
 * What the panel shows for the typed number: null while it is not a valid reading, otherwise the
 * measured value, the error (rpm, or the change of distance in m for D), this concept's
 * correction and the command it gives on its own (both per cent), the explaining sentence's key
 * and, for I, the correction accumulated so far and whether it has passed the output limit.
 */
function conceptOutcome(concept) {
  const measured = conceptReading(concept);
  if (measured === null) return null;
  const step = controlConceptStep(concept.kind, measured, concept.total);
  return {
    kind: concept.kind,
    measured,
    target: CONCEPT_TARGET,
    previousDistance: CONCEPT_PREVIOUS_DISTANCE,
    ...step,
    note: conceptNote(concept.kind, step.error),
    total: concept.total,
    seconds: concept.seconds,
    last: concept.last,
    overLimit: Math.abs(concept.total) > OUTPUT_LIMIT,
  };
}

export {
  CONCEPT_KINDS,
  CONCEPT_INPUTS,
  CONCEPT_TARGET,
  CONCEPT_PREVIOUS_DISTANCE,
  conceptState,
  conceptReading,
  advanceConcept,
  resetConcept,
  conceptNote,
  conceptOutcome,
};
