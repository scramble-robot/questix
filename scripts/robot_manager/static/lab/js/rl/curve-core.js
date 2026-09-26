import { niceScale, formatTick, scaleTo } from '../core/chart-scale.js';

// Geometry of the learning curves of the reinforcement-learning course (the foundation chapters'
// "mean reward per 50 runs" and the lab's training chart). No DOM: curve-view.js turns the layout
// into an SVG plot whose tick labels and line labels are HTML, so they stay readable when the
// plot is squeezed onto a phone. test/rl-curve-core.test.mjs.
//
// The plot is drawn in a 0–100 box on both axes and stretched to the figure's size
// (preserveAspectRatio="none"); positions are handed out as percentages of that box.

const PLOT_UNITS = 100;
const X_TICKS = 4; // labelled lines along the run count; fits a 300 px phone plot

/** Means of consecutive blocks of `size` values; an incomplete last block is left out. */
function blockMeans(values, size) {
  const means = [];
  for (let start = 0; start + size <= values.length; start += size) {
    let sum = 0;
    for (let index = start; index < start + size; index++) sum += values[index];
    means.push(sum / size);
  }
  return means;
}

/** Points `{x, y}` of block means, each placed at the run count where its block ends. */
function blockPoints(values, size) {
  return blockMeans(values, size).map((mean, index) => ({ x: (index + 1) * size, y: mean }));
}

const finite = (value) => value !== null && value !== undefined && Number.isFinite(value);

// SVG path through the points; a missing value breaks the line instead of bridging the gap.
function linePath(points, xAt, yAt) {
  let path = '';
  let gap = true;
  for (const point of points) {
    if (!finite(point.y)) {
      gap = true;
      continue;
    }
    path += (gap ? 'M' : 'L') + xAt(point.x).toFixed(2) + ' ' + yAt(point.y).toFixed(2) + ' ';
    gap = false;
  }
  return path.trim();
}

function lastPoint(points) {
  for (let index = points.length - 1; index >= 0; index--)
    if (finite(points[index].y)) return points[index];
  return null;
}

/**
 * Layout of a learning curve.
 * - `series`: `[{role, label, points: [{x, y}]}]`, drawn in order (put the previous run first).
 * - `xMax`: the run count at the right edge — the whole run, fixed before it starts.
 * - `yRange`: values the y axis must always show (e.g. the best score a run can reach), so the
 *   axis stays put while a run is still being drawn.
 * - `yInteger`, `yMin`/`yMax`, `yPadding`: forwarded to niceScale (`yPadding: 0` for a quantity
 *   with a hard limit such as 100 %).
 * Returns percentages from the plot's top-left corner, ready for curve-view.js.
 */
function curveLayout({ series, xMax, yRange = [], yInteger = false, yMin, yMax, yPadding }) {
  const values = series.flatMap((line) => line.points.map((point) => point.y)).filter(finite);
  const yScale = niceScale([...values, ...yRange], {
    integer: yInteger,
    min: yMin,
    max: yMax,
    padding: yPadding,
  });
  const xScale = niceScale([0, xMax], { integer: true, padding: 0, ticks: X_TICKS });
  const xAt = scaleTo(xScale, 0, PLOT_UNITS);
  const yAt = scaleTo(yScale, PLOT_UNITS, 0);
  const lines = series.map((line) => {
    const end = lastPoint(line.points);
    return {
      role: line.role,
      label: line.label,
      path: linePath(line.points, xAt, yAt),
      end: end && { x: xAt(end.x), y: yAt(end.y), value: end.y },
    };
  });
  return {
    xScale,
    yScale,
    yTicks: yScale.ticks.map((value) => ({
      value,
      label: formatTick(value, yScale.step),
      position: yAt(value),
      zero: value === 0,
    })),
    xTicks: xScale.ticks.map((value) => ({
      value,
      label: value.toLocaleString('ja-JP'),
      position: xAt(value),
    })),
    lines,
    empty: lines.every((line) => !line.path),
  };
}

const RANGE_HEADROOM = 0.5; // share of the span added past a value that left the range

/**
 * The y range `[low, high]` a chart keeps while a run is still adding values it cannot know in
 * advance (a score, a time): it never shrinks, and when a value falls outside it grows past that
 * value by half its span, so the axis moves a few times per run instead of with every point.
 */
function stickyRange(range, values) {
  const known = values.filter(finite);
  if (!known.length) return range;
  const lowest = Math.min(...known);
  const highest = Math.max(...known);
  if (!range) return [lowest, highest];
  let [low, high] = range;
  if (lowest >= low && highest <= high) return range;
  const span = Math.max(highest, high) - Math.min(lowest, low) || Math.abs(highest) || 1;
  if (lowest < low) low = lowest - span * RANGE_HEADROOM;
  if (highest > high) high = highest + span * RANGE_HEADROOM;
  return [low, high];
}

const REWARD_BLOCK = 50; // training runs averaged into one point of a reward curve

/**
 * Layout of "mean reward per 50 runs": `lines` are `[{role, label, rewards}]` with the total reward
 * of every training run so far, `total` the number of runs the training will reach.
 */
function rewardCurveLayout(lines, total, yRange) {
  return curveLayout({
    series: lines.map((line) => ({
      role: line.role,
      label: line.label,
      points: blockPoints(line.rewards, REWARD_BLOCK),
    })),
    xMax: total,
    yRange,
  });
}

export {
  PLOT_UNITS,
  REWARD_BLOCK,
  blockMeans,
  blockPoints,
  curveLayout,
  rewardCurveLayout,
  stickyRange,
};
