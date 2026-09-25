import { html, svg, nothing } from '../vendor/lit-html.js';
import { formatTick } from './chart-scale.js';

// A line chart for learners on any screen (CONTRIBUTING.md, "Figures and charts"): the plot is an
// SVG stretched to its box with strokes that keep their width, and every word and number — axis
// titles, ticks, direct line labels, band and marker labels — is HTML over it, so nothing shrinks
// under 12 px on a phone. Pure template; the scales come from js/core/chart-scale.js.

const PLOT = 1000; // SVG units along each axis of the stretched plot
const LABEL_GAP = 9; // percent of the plot height kept between two direct labels
const LABEL_FLIP_AT = 75; // percent: a marker label further right than this goes on its left
const HLINE_LABEL_SPAN = 40; // percent of the plot width a threshold's label may cover from the left

const percentX = (scale, value) => ((value - scale.min) / (scale.max - scale.min || 1)) * 100;
const percentY = (scale, value) => 100 - ((value - scale.min) / (scale.max - scale.min || 1)) * 100;

function polyline(points, x, y, line) {
  const coordinates = points
    .map(([px, py]) => `${(percentX(x, px) * PLOT) / 100},${(percentY(y, py) * PLOT) / 100}`)
    .join(' ');
  return svg`<polyline points=${coordinates} fill="none" stroke=${line.color} stroke-width=${line.width ?? 2.5} stroke-dasharray=${line.dash || nothing} stroke-linejoin="round" vector-effect="non-scaling-stroke" opacity=${line.opacity ?? 1}/>`;
}

function grid(x, y) {
  return svg`${y.ticks.map((tick) => {
    const at = (percentY(y, tick) * PLOT) / 100;
    return svg`<line x1="0" x2=${PLOT} y1=${at} y2=${at} stroke=${tick === 0 ? '#6f858c' : '#dbe4e6'} stroke-width=${tick === 0 ? 2 : 1} vector-effect="non-scaling-stroke"/>`;
  })}${x.ticks.map((tick) => {
    const at = (percentX(x, tick) * PLOT) / 100;
    return svg`<line x1=${at} x2=${at} y1="0" y2=${PLOT} stroke="#edf2f3" vector-effect="non-scaling-stroke"/>`;
  })}`;
}

// A line label that would sit on a threshold's label (both are drawn just above their line, the
// threshold's at the left edge) moves just below the threshold instead.
function clearOfThresholds(label, thresholds) {
  if (label.left > HLINE_LABEL_SPAN) return;
  const hit = thresholds.find((top) => Math.abs(label.top - top) < LABEL_GAP);
  if (hit !== undefined) label.top = hit + LABEL_GAP;
}

// Direct labels at the right end of each line, pushed apart so they never overlap; with
// `thresholds` (percent tops of threshold lines) they also keep clear of the thresholds' labels.
function lineLabels(series, x, y, thresholds = []) {
  const labels = series
    .filter((line) => line.label && line.points.length)
    .map((line) => {
      const [px, py] = line.points.at(-1);
      return { line, left: percentX(x, px), top: percentY(y, py) };
    })
    .sort((a, b) => a.top - b.top);
  for (let i = 1; i < labels.length; i++)
    labels[i].top = Math.max(labels[i].top, labels[i - 1].top + LABEL_GAP);
  for (const label of labels) clearOfThresholds(label, thresholds);
  return labels.map(
    ({ line, left, top }) =>
      html`<span
        class="html-chart-line-label"
        style=${`left:${Math.min(left, 100)}%;top:${Math.min(top, 100)}%;color:${line.labelColor || line.color}`}
        >${line.label}</span
      >`,
  );
}

/**
 * spec: {
 *   label, xTitle, yTitle, x, y (niceScale results),
 *   series: [{points: [[x, y]], color, dash, width, opacity, label, labelColor}],
 *   bands: [{from, to, label}]    — a shaded x range,
 *   hlines: [{y, label, color, dash}] — a threshold across the plot,
 *   vlines: [{x, label, color, dash}] — a marked position or moment,
 *   clearOfHlineLabels — move line labels off the thresholds' labels (a run played back grows
 *     through them),
 * }
 */
function htmlChart(spec) {
  const { x, y, series = [], bands = [], hlines = [], vlines = [] } = spec;
  return html`<figure class="html-chart" role="img" aria-label=${spec.label}>
    <figcaption class="html-chart-y-title">${spec.yTitle}</figcaption>
    <div class="html-chart-area">
      <svg viewBox=${`0 0 ${PLOT} ${PLOT}`} preserveAspectRatio="none" aria-hidden="true">
        ${bands.map(
          (band) =>
            svg`<rect x=${(percentX(x, band.from) * PLOT) / 100} y="0" width=${((percentX(x, band.to) - percentX(x, band.from)) * PLOT) / 100} height=${PLOT} fill="#f2c14e44"/>`,
        )}
        ${grid(x, y)}
        ${hlines.map(
          (line) =>
            svg`<line x1="0" x2=${PLOT} y1=${(percentY(y, line.y) * PLOT) / 100} y2=${(percentY(y, line.y) * PLOT) / 100} stroke=${line.color} stroke-width="2" stroke-dasharray=${line.dash || nothing} vector-effect="non-scaling-stroke"/>`,
        )}
        ${vlines.map(
          (line) =>
            svg`<line x1=${(percentX(x, line.x) * PLOT) / 100} x2=${(percentX(x, line.x) * PLOT) / 100} y1="0" y2=${PLOT} stroke=${line.color} stroke-width="2" stroke-dasharray=${line.dash || nothing} vector-effect="non-scaling-stroke"/>`,
        )}
        ${series.map((line) => polyline(line.points, x, y, line))}
      </svg>
      ${y.ticks.map(
        (tick) =>
          html`<span class="html-chart-tick-y" style=${`top:${percentY(y, tick)}%`}
            >${formatTick(tick, y.step)}</span
          >`,
      )}
      ${x.ticks.map(
        (tick) =>
          html`<span class="html-chart-tick-x" style=${`left:${percentX(x, tick)}%`}
            >${formatTick(tick, x.step)}</span
          >`,
      )}
      ${bands.map(
        (band) =>
          html`<span
            class="html-chart-band-label"
            style=${`left:${(percentX(x, band.from) + percentX(x, band.to)) / 2}%`}
            >${band.label}</span
          >`,
      )}
      ${hlines.map(
        (line) =>
          html`<span
            class="html-chart-hline-label"
            style=${`top:${percentY(y, line.y)}%;color:${line.color}`}
            >${line.label}</span
          >`,
      )}
      ${vlines.map(
        (line) =>
          html`<span
            class=${percentX(x, line.x) > LABEL_FLIP_AT ? 'html-chart-vline-label flip' : 'html-chart-vline-label'}
            style=${`left:${percentX(x, line.x)}%;color:${line.color}`}
            >${line.label}</span
          >`,
      )}
      ${lineLabels(
        series,
        x,
        y,
        spec.clearOfHlineLabels ? hlines.map((line) => percentY(y, line.y)) : [],
      )}
    </div>
    <div class="html-chart-x-title">${spec.xTitle}</div>
  </figure>`;
}

export { htmlChart };
