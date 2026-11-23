import test from 'node:test';
import assert from 'node:assert/strict';
import { toRpm } from '../js/core/angle-units.js';

globalThis.document ??= {
  createComment: () => ({}),
  createTreeWalker: () => ({}),
  createElement: () => ({}),
  importNode: () => ({}),
};
const { chartFor, systemChart } = await import('../js/systems/render.js');

test('behavior wheel chart leaves gaps in missing samples without changing the run', () => {
  const run = {
    course: 'behavior',
    topic: 'sequence',
    config: {},
    duration: 2,
    events: [],
    samples: [
      { t: 0, left: 0, right: toRpm(1) },
      { t: 1, left: toRpm(2), right: null },
      { t: 2, left: toRpm(-1), right: toRpm(2) },
    ],
  };
  const before = structuredClone(run);
  const chart = chartFor(run, 1);
  assert.equal(chart.unit, 'rad/s');
  assert.match(chart.note.all, /1 rad\/s ≒ 9\.55 rpm/);
  const figure = systemChart(run, 2, 1);
  const paths = [];
  function collect(value) {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value?.strings) {
      if (/<path\s+d=$/.test(value.strings[0])) paths.push(value.values[0]);
      value.values.forEach(collect);
    }
  }
  collect(figure);
  assert.equal(paths.length, 2);
  assert.match(paths[0], /^M[^M]*L[^M]*L/);
  assert.match(paths[1], /^M[^ML]+M[^ML]+$/);
  assert.deepEqual(run, before);
});
