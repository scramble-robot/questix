import { html, svg, nothing } from '../vendor/lit-html.js';
import { loadJson, fillSentence as fill } from '../core/content.js';

// The report of one driving run (drive-history.js entry): what happened in numbers, the commanded
// and measured speed over time, the path seen from above, and the wall distance when the LiDAR saw
// one. Pure templates; charts are inline SVG scaled to the container's width.

const CHART = { width: 640, height: 190, left: 48, right: 12, top: 24, bottom: 28 };
const PATH_BOX = 300; // px: the square the path is drawn in
const PATH_MIN_SPAN = 1; // m: the path view never shows less than this, so a nudge stays small
const PATH_GRID = 0.5; // m between grid lines
const driveCopy = await loadJson('content/live/drive.json');
const text = () => driveCopy.report;

const fixed = (value, digits) => (Number.isFinite(value) ? value.toFixed(digits) : '—');
const degrees = (radians) => (radians * 180) / Math.PI;

function niceStep(span) {
  const rough = span / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const unit = [1, 2, 5, 10].find((candidate) => candidate * power >= rough);
  return unit * power;
}

function polyline(points, x, y) {
  return points.map((point) => `${x(point[0]).toFixed(1)},${y(point[1]).toFixed(1)}`).join(' ');
}

/**
 * A time chart: `lines` are `{points: [[t, value]], kind}` (kind = CSS modifier), `unit` names the
 * y axis. Zero is always on the axis so a small overshoot is not magnified into a big one.
 */
function timeChart({ lines, unit, label, seconds, marker }) {
  const values = lines.flatMap((line) => line.points.map((point) => point[1]));
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const span = high - low || 1;
  const step = niceStep(span);
  const bottomValue = Math.floor(low / step) * step;
  const topValue = Math.ceil(high / step) * step || step;
  const duration = Math.max(1, seconds);
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const x = (t) => CHART.left + (Math.max(0, t) / duration) * plotWidth;
  const y = (value) =>
    CHART.top + (1 - (value - bottomValue) / (topValue - bottomValue)) * plotHeight;
  const ticks = [];
  for (let value = bottomValue; value <= topValue + step / 2; value += step) ticks.push(value);
  const timeStep = niceStep(duration);
  const times = [];
  for (let t = 0; t <= duration + 1e-9; t += timeStep) times.push(t);
  return html`<figure class="drive-report-chart">
    <figcaption>${label}</figcaption>
    <svg viewBox="0 0 ${CHART.width} ${CHART.height}" role="img" aria-label=${label}>
      ${ticks.map(
        (value) =>
          svg`<line class="grid" x1=${CHART.left} x2=${CHART.width - CHART.right} y1=${y(value)} y2=${y(value)}></line>
          <text class="tick" x=${CHART.left - 6} y=${y(value) + 4} text-anchor="end">${+value.toFixed(3)}</text>`,
      )}
      ${times.map(
        (t) =>
          svg`<text class="tick" x=${x(t)} y=${CHART.height - 8} text-anchor="middle">${+t.toFixed(1)}</text>`,
      )}
      <text class="tick" x=${CHART.width - CHART.right} y=${CHART.height - 8} text-anchor="end">
        ${text().seconds}
      </text>
      <text class="tick" x="4" y="12">${unit}</text>
      ${
        marker
          ? svg`<line class="marker" x1=${x(marker.t)} x2=${x(marker.t)} y1=${CHART.top} y2=${CHART.height - CHART.bottom}></line>
            <text class="tick marker-label" x=${x(marker.t) + 4} y=${CHART.top + 10}>${marker.label}</text>`
          : nothing
      }
      ${lines.map(
        (line) =>
          svg`<polyline class="line ${line.kind}" points=${polyline(line.points, x, y)}></polyline>`,
      )}
    </svg>
  </figure>`;
}

// Where the robot went, seen from above: start at the origin facing up the page, left is left.
function pathChart(path) {
  const points = path.length ? path : [{ x: 0, y: 0 }];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const centre = {
    x: (Math.min(0, ...xs) + Math.max(0, ...xs)) / 2,
    y: (Math.min(0, ...ys) + Math.max(0, ...ys)) / 2,
  };
  const span = Math.max(
    PATH_MIN_SPAN,
    (Math.max(0, ...xs) - Math.min(0, ...xs)) * 1.2,
    (Math.max(0, ...ys) - Math.min(0, ...ys)) * 1.2,
  );
  const scale = PATH_BOX / span;
  // Forward (+x) is up the page and left (+y) is left, as in the 実機 dialog's LiDAR view.
  const px = (point) => PATH_BOX / 2 - (point.y - centre.y) * scale;
  const py = (point) => PATH_BOX / 2 - (point.x - centre.x) * scale;
  const grid = [];
  const first = Math.ceil((centre.x - span / 2) / PATH_GRID) * PATH_GRID;
  for (let value = first; value <= centre.x + span / 2; value += PATH_GRID)
    grid.push(
      svg`<line class="grid" x1="0" x2=${PATH_BOX} y1=${py({ x: value })} y2=${py({ x: value })}></line>`,
    );
  const firstY = Math.ceil((centre.y - span / 2) / PATH_GRID) * PATH_GRID;
  for (let value = firstY; value <= centre.y + span / 2; value += PATH_GRID)
    grid.push(
      svg`<line class="grid" y1="0" y2=${PATH_BOX} x1=${px({ y: value })} x2=${px({ y: value })}></line>`,
    );
  const end = points[points.length - 1];
  const start = { x: 0, y: 0 };
  return html`<figure class="drive-report-path">
    <figcaption>${text().path}</figcaption>
    <svg viewBox="0 0 ${PATH_BOX} ${PATH_BOX}" role="img" aria-label=${text().path}>
      ${grid}
      <polyline
        class="line measured"
        points=${points.map((point) => `${px(point).toFixed(1)},${py(point).toFixed(1)}`).join(' ')}
      ></polyline>
      <polygon
        class="start"
        points="${px(start)},${py(start) - 9} ${px(start) + 6},${py(start) + 5} ${px(start) - 6},${py(start) + 5}"
      ></polygon>
      <circle class="end" cx=${px(end)} cy=${py(end)} r="5"></circle>
    </svg>
    <p class="drive-note">${fill(text().pathNote, { grid: PATH_GRID })}</p>
  </figure>`;
}

function summaryList(summary) {
  const copy = text();
  const items = [
    [copy.duration, `${fixed(summary.seconds, 1)} s`],
    [copy.distance, `${fixed(summary.distance * 100, 1)} cm`],
    [
      copy.ended,
      summary.forward === null
        ? '—'
        : fill(copy.endedAt, {
            forward: fixed(summary.forward * 100, 1),
            left: fixed(summary.left * 100, 1),
          }),
    ],
    [copy.turn, summary.turn === null ? '—' : `${fixed(degrees(summary.turn), 0)}°`],
    [
      copy.maxSpeed,
      `${fixed(summary.maxSpeed, 2)} m/s（${copy.command} ${fixed(summary.maxCommand, 2)}）`,
    ],
    [copy.maxTurnRate, `${fixed(summary.maxTurnRate, 2)} rad/s`],
    [
      copy.stop,
      summary.stop
        ? fill(copy.stopValue, {
            delay: fixed(summary.stop.delay, 2),
            distance: fixed(summary.stop.distance * 100, 1),
          })
        : copy.stopUnknown,
    ],
  ];
  if (summary.closest !== null) items.push([copy.closest, `${fixed(summary.closest, 2)} m`]);
  if (summary.emergencyStop) items.push([copy.emergencyStop, copy.emergencyStopYes]);
  return html`<dl class="drive-report-summary">
    ${items.map(
      ([term, value]) =>
        html`<div>
          <dt>${term}</dt>
          <dd>${value}</dd>
        </div>`,
    )}
  </dl>`;
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'medium' });
}

function charts(report) {
  const copy = text();
  const { command, measured, front, path } = report.series;
  const seconds = report.summary.seconds;
  const marker = report.summary.stop ? { t: report.summary.stop.at, label: copy.stopMarker } : null;
  const moved = (key) => [...command, ...measured].some((sample) => Math.abs(sample[key]) > 1e-3);
  const turned = moved('w');
  // A pure turn (the bench's 左/右) has nothing to show in the forward-speed chart.
  const straight = moved('v') || !turned;
  return html`<div class="drive-report-charts">
    ${
      straight
        ? timeChart({
            label: copy.speedChart,
            unit: 'm/s',
            seconds,
            marker,
            lines: [
              { kind: 'command', points: command.map((sample) => [sample.t, sample.v]) },
              { kind: 'measured', points: measured.map((sample) => [sample.t, sample.v]) },
            ],
          })
        : nothing
    }
    ${
      turned
        ? timeChart({
            label: copy.turnChart,
            unit: 'rad/s',
            seconds,
            marker,
            lines: [
              { kind: 'command', points: command.map((sample) => [sample.t, sample.w]) },
              { kind: 'measured', points: measured.map((sample) => [sample.t, sample.w]) },
            ],
          })
        : nothing
    }
    ${
      front.length
        ? timeChart({
            label: copy.frontChart,
            unit: 'm',
            seconds,
            lines: [{ kind: 'front', points: front.map((sample) => [sample.t, sample.d]) }],
          })
        : nothing
    }
    ${path.length ? pathChart(path) : html`<p class="drive-note">${copy.noPath}</p>`}
  </div>`;
}

function saveButtons(run, actions) {
  if (!run.recording || !actions.saveRun) return html`<p class="drive-note">${text().notKept}</p>`;
  return html`<div class="live-capture-actions">
    <button @click=${() => actions.saveRun(run.id, 'json')}>${text().saveJson}</button>
    <button @click=${() => actions.saveRun(run.id, 'csv')}>${text().saveCsv}</button>
  </div>`;
}

/** The whole report of one run; `actions.saveRun(id, kind)` is optional. */
function driveReportView(run, actions = {}) {
  const copy = text();
  return html`<section class="drive-report" data-drive-report=${run.id}>
    <h4>${fill(copy.title, { time: formatTime(run.at), lesson: run.lesson })}</h4>
    ${run.ended ? html`<p>${run.ended}</p>` : nothing}
    <p class="drive-report-legend">
      <span class="key command"></span>${copy.command}
      <span class="key measured"></span>${copy.measured}
    </p>
    ${summaryList(run.report.summary)} ${charts(run.report)} ${saveButtons(run, actions)}
  </section>`;
}

/** One line per run for the history list. */
function driveRunLabel(run) {
  const summary = run.report.summary;
  return fill(text().listItem, {
    time: formatTime(run.at),
    lesson: run.lesson,
    distance: fixed(summary.distance * 100, 0),
    seconds: fixed(summary.seconds, 1),
  });
}

export { driveReportView, driveRunLabel };
