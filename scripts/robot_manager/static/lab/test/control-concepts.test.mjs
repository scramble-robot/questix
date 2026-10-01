// Run with: node --test test/*.test.mjs
//
// The P / I / D "check the calculation with your own number" panel of the control course
// (js/control/concepts-core.js): the numbers the learner sees for a typed measurement, the
// one-second steps of I, and which explaining sentence is chosen. The numbers come from the
// course's own pidStep, so they are the same arithmetic as the simulation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CONCEPT_KINDS,
  CONCEPT_INPUTS,
  conceptState,
  conceptReading,
  advanceConcept,
  resetConcept,
  conceptOutcome,
} from '../js/control/concepts-core.js';

const copy = JSON.parse(
  await readFile(new URL('../content/control/concepts.json', import.meta.url), 'utf8'),
);

const round = (value) => Math.round(value * 1000) / 1000 + 0; // + 0 turns -0 into 0
const typed = (concept, value) => ({ ...concept, value: String(value) });
const numbers = (outcome) => ({
  error: round(outcome.error),
  correction: round(outcome.correction),
  command: round(outcome.command),
  note: outcome.note,
});

test('only the P, I and D topics have the panel, starting at the example in the text', () => {
  assert.equal(conceptState('feedback'), null);
  assert.equal(conceptState('output'), null);
  for (const kind of CONCEPT_KINDS) {
    const concept = conceptState(kind);
    assert.equal(concept.kind, kind);
    assert.equal(concept.value, CONCEPT_INPUTS[kind].start);
    assert.deepEqual([concept.total, concept.seconds, concept.last], [0, 0, null]);
  }
});

test('P: error → correction → command for too slow, too fast and on target', () => {
  const concept = conceptState('p');
  // 60 − 50 = +10 rpm, ×1.2 = +12 %; P is the whole command in this example.
  assert.deepEqual(numbers(conceptOutcome(concept)), {
    error: 10,
    correction: 12,
    command: 12,
    note: 'slow',
  });
  assert.deepEqual(numbers(conceptOutcome(typed(concept, 70))), {
    error: -10,
    correction: -12,
    command: -12,
    note: 'fast',
  });
  assert.deepEqual(numbers(conceptOutcome(typed(concept, 60))), {
    error: 0,
    correction: 0,
    command: 0,
    note: 'zero',
  });
});

test('I: two seconds at 50 rpm, then one at 60 rpm keeps the accumulated 20 %', () => {
  let concept = conceptState('i');
  assert.equal(conceptOutcome(concept).correction, 10, 'the next second would add 10 %');
  concept = advanceConcept(concept);
  assert.deepEqual(
    [round(concept.total), concept.seconds, concept.last],
    [
      10,
      1,
      {
        before: 0,
        error: 10,
      },
    ],
  );
  concept = advanceConcept(concept);
  assert.deepEqual([round(concept.total), concept.seconds], [20, 2]);
  // The question of the lesson text: the error is gone, does the correction stay?
  concept = advanceConcept(typed(concept, 60));
  assert.deepEqual([round(concept.total), concept.seconds], [20, 3]);
  const outcome = conceptOutcome(concept);
  assert.equal(outcome.note, 'zero');
  assert.equal(round(outcome.command), 20, 'the command still carries what I accumulated');
  // Faster than the target takes some of it away again.
  concept = advanceConcept(typed(concept, 80));
  assert.equal(round(concept.total), 0);
  assert.equal(conceptOutcome(concept).note, 'fast');
});

test('I: the note about the output limit appears only beyond 100 %', () => {
  let concept = typed(conceptState('i'), 0); // 60 rpm short: +60 % per second
  concept = advanceConcept(concept);
  assert.equal(conceptOutcome(concept).overLimit, false);
  concept = advanceConcept(concept);
  assert.equal(round(concept.total), 120);
  assert.equal(conceptOutcome(concept).overLimit, true);
  const cleared = resetConcept(concept);
  assert.deepEqual([cleared.total, cleared.seconds, cleared.last], [0, 0, null]);
  assert.equal(cleared.value, '0', 'resetting keeps the typed measurement');
});

test('D: the change of distance in one second, not the distance itself, sets the correction', () => {
  const concept = conceptState('d');
  // 0.80 − 1.00 = −0.20 m in one second → −20 % (the forward command is weakened).
  assert.deepEqual(numbers(conceptOutcome(concept)), {
    error: -0.2,
    correction: -20,
    command: -20,
    note: 'closing',
  });
  assert.deepEqual(numbers(conceptOutcome(typed(concept, 1.2))), {
    error: 0.2,
    correction: 20,
    command: 20,
    note: 'opening',
  });
  assert.deepEqual(numbers(conceptOutcome(typed(concept, 1))), {
    error: 0,
    correction: 0,
    command: 0,
    note: 'still',
  });
});

test('an empty or out-of-range field gives no result and I does not advance', () => {
  for (const [kind, bad] of [
    ['p', ''],
    ['p', '-10'],
    ['p', '120'],
    ['i', 'abc'],
    ['d', '0.4'],
    ['d', '1.6'],
  ]) {
    const concept = typed(conceptState(kind), bad);
    assert.equal(conceptReading(concept), null, `${kind} ${bad}`);
    assert.equal(conceptOutcome(concept), null, `${kind} ${bad}`);
  }
  const stuck = typed(conceptState('i'), '');
  assert.equal(advanceConcept(stuck), stuck);
});

test('every note the panel can choose has its sentence in the content file', () => {
  const notes = {
    p: ['slow', 'fast', 'zero'],
    i: ['slow', 'fast', 'zero'],
    d: ['closing', 'opening', 'still'],
  };
  for (const kind of CONCEPT_KINDS) {
    assert.ok(copy.intro[kind] && copy.gainNote[kind], kind);
    for (const note of notes[kind]) assert.ok(copy[kind][note], `${kind}.${note}`);
  }
});
