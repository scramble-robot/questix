// The line chart's handling of gaps (js/core/html-chart.js): a missing value breaks a line rather
// than joining across it, and a line's direct label sits on its last finite point. Run with
// `node --test test/*.test.mjs`.

import assert from 'node:assert/strict';
import { test } from 'node:test';

// lit-html looks up `document` when it is loaded; these tests only read the template values.
globalThis.document ??= {
  createComment: () => ({}),
  createTreeWalker: () => ({}),
  createElement: () => ({}),
  importNode: () => ({}),
};
const { htmlChart } = await import('../js/core/html-chart.js');

const axis = { min: 0, max: 10, step: 5, ticks: [0, 5, 10] };

// Every lit template under `value` whose static text contains `marker`, depth first.
function templates(value, marker, found = []) {
  if (Array.isArray(value)) value.forEach((item) => templates(item, marker, found));
  else if (value && Array.isArray(value.strings) && Array.isArray(value.values)) {
    if (value.strings.join('').includes(marker)) found.push(value);
    value.values.forEach((item) => templates(item, marker, found));
  }
  return found;
}

const polylines = (chart) => templates(chart, '<polyline points=').map((line) => line.values[0]);
const labelStyles = (chart) =>
  templates(chart, 'html-chart-line-label').map((label) => label.values[0]);

const chartOf = (points) =>
  htmlChart({
    label: 'test',
    xTitle: 'x',
    yTitle: 'y',
    x: axis,
    y: axis,
    series: [{ points, color: '#000', label: 'line' }],
  });

test('a line without gaps is one polyline, as before', () => {
  const chart = chartOf([
    [0, 0],
    [5, 5],
    [10, 10],
  ]);
  assert.deepEqual(polylines(chart), ['0,1000 500,500 1000,0']);
});

test('a missing value splits the line and is never drawn', () => {
  const chart = chartOf([
    [0, 0],
    [2, 2],
    [4, NaN],
    [6, 6],
    [8, 8],
    [9, null],
  ]);
  const lines = polylines(chart);
  assert.deepEqual(lines, ['0,1000 200,800', '600,400 800,200']);
  assert.ok(lines.every((line) => !line.includes('NaN')));
});

test('the direct label sits on the last finite point', () => {
  const chart = chartOf([
    [0, 0],
    [5, 5],
    [8, NaN],
  ]);
  assert.match(labelStyles(chart)[0], /^left:50%;top:50%;/);
  // A line with no finite point has no label (and no polyline).
  const empty = chartOf([[1, NaN]]);
  assert.deepEqual(polylines(empty), []);
  assert.deepEqual(labelStyles(empty), []);
});
