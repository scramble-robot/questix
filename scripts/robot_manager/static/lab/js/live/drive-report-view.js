import { html, svg, nothing, styleMap } from '../vendor/lit-html.js';
import { loadJson, fillSentence as fill } from '../core/content.js';
import {
  describeOffset,
  describeTurn,
  describeTurnRate,
  runStatusKind,
  MOVED_DISTANCE,
} from './drive-report-core.js';

// The report of one driving run (drive-history.js entry): what happened in numbers, the commanded
// and measured speed over time, the path seen from above, and the wall distance when the LiDAR saw
// one; plus the history list. Pure templates.
//
// Time charts are an SVG stretched to a box of fixed CSS height (preserveAspectRatio="none", lines
// with vector-effect="non-scaling-stroke") under HTML labels placed in %, so the text keeps its
// size on a phone and on a projector alike. Colours are CSS variables in css/drive-report.css.

const PLOT_SPAN = 100; // SVG user units across and down a time chart (= percent of the box)
const PATH_BOX = 300; // user units: the square the path is drawn in
const PATH_MIN_SPAN = 1; // m: the path view never shows less than this, so a nudge stays small
const PATH_GRID = 0.5; // m between grid lines
const START_SIZE = 11; // user units from the start triangle's centre to its tip
const END_DOT = 4; // user units: radius of the end dot
const HEADING_ARROW = 22; // user units: length of the arrow showing the heading at the end
const ARROW_HEAD = 7; // user units
const MARKER_FLIP = 70; // %: a marker label right of this is written on the left of its line
const MOTION_SHOWN = 1e-3; // m/s or rad/s: a series that never exceeds this has nothing to show
// drive_component smooths the measured speed with a first-order low-pass filter of this time
// constant (measured_lpf_tau_sec in launcher/config/drive_component.yaml), in seconds.
const MEASURED_SMOOTHING = 0.15;
const COMPARE_LIMIT = 3; // runs that can be overlaid on the report of another
const STATUS_ICONS = { ok: '✓', stopped: '■', problem: '⚠︎' };

const reportCopy = await loadJson('content/live/drive-report.json');
const text = () => reportCopy;

const fixed = (value, digits) => (Number.isFinite(value) ? value.toFixed(digits) : '—');
const percent = (value) => `${value.toFixed(2)}%`;
const tickText = (value) => String(+value.toFixed(3));
const secondsText = (seconds) => fill(text().secondsValue, { seconds: fixed(seconds, 1) });

function niceStep(span) {
  const rough = span / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const unit = [1, 2, 5, 10].find((candidate) => candidate * power >= rough);
  return unit * power;
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'medium' });
}

function formatClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('ja-JP');
}

// --- time charts --------------------------------------------------------------------------------

// The y axis: nice ticks from below the lowest to above the highest value, zero always included so
// a small overshoot is not magnified into a big one.
function valueAxis(values) {
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const step = niceStep(high - low || 1);
  const bottom = Math.floor(low / step) * step;
  const top = Math.ceil(high / step) * step || step;
  const ticks = [];
  for (let value = bottom; value <= top + step / 2; value += step) ticks.push(value);
  return { bottom, top, ticks };
}

// Time ticks from 0 up to the first one at or after `duration`, so the axis ends on a label.
function timeTicks(duration) {
  const step = niceStep(duration);
  const ticks = [0];
  while (ticks[ticks.length - 1] < duration - 1e-9) ticks.push(ticks.length * step);
  return ticks;
}

const polyline = (points, x, y) =>
  points.map(([t, value]) => `${x(t).toFixed(2)},${y(value).toFixed(2)}`).join(' ');

function plotLines(chart, axis, x, y) {
  const flat = (className, value) =>
    svg`<line class=${className} x1="0" x2=${PLOT_SPAN} y1=${y(value)} y2=${y(value)} vector-effect="non-scaling-stroke"></line>`;
  const marker = chart.marker;
  return html`<svg
    class="drive-plot-lines"
    viewBox="0 0 ${PLOT_SPAN} ${PLOT_SPAN}"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    ${axis.ticks.map((value) => flat(value === 0 ? 'grid zero' : 'grid', value))}
    ${chart.references.map((reference) => flat('reference', reference.value))}
    ${
      marker
        ? svg`<line class="marker" x1=${x(marker.t)} x2=${x(marker.t)} y1="0" y2=${PLOT_SPAN} vector-effect="non-scaling-stroke"></line>`
        : nothing
    }
    ${chart.lines.map(
      (line) =>
        svg`<polyline class="line ${line.kind}" points=${polyline(line.points, x, y)} vector-effect="non-scaling-stroke"></polyline>`,
    )}
  </svg>`;
}

function markerLabel(marker, x) {
  if (!marker) return nothing;
  const left = x(marker.t);
  return html`<span
    class="drive-plot-marker ${left > MARKER_FLIP ? 'flip' : ''}"
    style=${styleMap({ left: percent(left) })}
    >${marker.label}</span
  >`;
}

// `ticks.values` on the y axis, `ticks.times` (s) on the time axis; the last time gets the unit.
function plotLabels(chart, ticks, x, y) {
  const times = ticks.times;
  const last = times.length - 1;
  return html`${ticks.values.map(
    (value) =>
      html`<span class="drive-plot-y" style=${styleMap({ top: percent(y(value)) })}
        >${tickText(value)}</span
      >`,
  )}
  ${times.map(
    (t, index) =>
      html`<span class="drive-plot-t" style=${styleMap({ left: percent(x(t)) })}
        >${tickText(t)}${index === last ? text().seconds : ''}</span
      >`,
  )}
  ${chart.references.map(
    (reference) =>
      html`<span
        class="drive-plot-reference"
        style=${styleMap({ top: percent(y(reference.value)) })}
        >${reference.label}</span
      >`,
  )}
  ${markerLabel(chart.marker, x)}`;
}

function legendView(entries) {
  return html`<span class="drive-legend">
    ${entries.map(
      (entry) =>
        html`<span class="drive-legend-item"
          ><span class="drive-key ${entry.kind}" aria-hidden="true"></span>${entry.label}</span
        >`,
    )}
  </span>`;
}

/**
 * A time chart. `lines` are `{kind, points: [[t, value]]}` (kind = CSS modifier: measured,
 * command, front, compare-1…), `legend` `{kind, label}`, `references` horizontal lines
 * `{value, label}`, `marker` an optional vertical line `{t, label}`; `duration` in seconds.
 */
function timeChart(chart) {
  const values = [
    ...chart.lines.flatMap((line) => line.points.map((point) => point[1])),
    ...chart.references.map((reference) => reference.value),
  ];
  const axis = valueAxis(values);
  const times = timeTicks(chart.duration);
  const end = times[times.length - 1];
  const x = (t) => (Math.min(Math.max(0, t), end) / end) * PLOT_SPAN;
  const y = (value) => (1 - (value - axis.bottom) / (axis.top - axis.bottom)) * PLOT_SPAN;
  return html`<figure class="drive-report-chart">
    <figcaption>
      <span class="drive-report-caption">${chart.label}</span>${legendView(chart.legend)}
    </figcaption>
    <div class="drive-plot" role="img" aria-label=${`${chart.label}（${chart.unit}）`}>
      <span class="drive-plot-unit">${chart.unit}</span>
      <div class="drive-plot-area">
        ${plotLines(chart, axis, x, y)} ${plotLabels(chart, { values: axis.ticks, times }, x, y)}
      </div>
    </div>
  </figure>`;
}

// --- which charts a run gets --------------------------------------------------------------------

function compareName(run) {
  return fill(text().compareLabel, {
    time: formatClock(run.at),
    conditions: run.conditions ?? '',
  }).trim();
}

const compareLegend = (compare) =>
  compare.map((run, index) => ({ kind: `compare-${index + 1}`, label: compareName(run) }));

// Command below, the compared runs' measurements, this run's measurement on top.
function motionChart(run, compare, { key, label, unit, duration, marker }) {
  const copy = text();
  const { command, measured } = run.report.series;
  const series = (samples, kind) => ({
    kind,
    points: samples.map((sample) => [sample.t, sample[key]]),
  });
  return timeChart({
    label,
    unit,
    duration,
    marker,
    references: [],
    lines: [
      series(command, 'command'),
      ...compare.map((other, index) =>
        series(other.report.series.measured, `compare-${index + 1}`),
      ),
      series(measured, 'measured'),
    ],
    legend: [
      { kind: 'measured', label: copy.measured + (compare.length ? copy.thisRun : '') },
      { kind: 'command', label: copy.command },
      ...compareLegend(compare),
    ],
  });
}

function frontChart(run, compare, duration) {
  const copy = text();
  const series = (samples, kind) => ({
    kind,
    points: samples.map((sample) => [sample.t, sample.d]),
  });
  const withFront = compare.filter((other) => other.report.series.front?.length);
  return timeChart({
    label: copy.frontChart,
    unit: 'm',
    duration,
    references: run.references?.front ?? [],
    lines: [
      ...compare.map((other, index) =>
        series(other.report.series.front ?? [], `compare-${index + 1}`),
      ),
      series(run.report.series.front, 'front'),
    ],
    legend: [
      { kind: 'front', label: copy.lidar + (withFront.length ? copy.thisRun : '') },
      ...compareLegend(compare).filter(
        (entry, index) => compare[index].report.series.front?.length,
      ),
    ],
  });
}

/** The time charts of a run as `[{name, view}]`: speed, turn and front, when they have data. */
function timeCharts(run, compare) {
  const copy = text();
  const { command, measured, front } = run.report.series;
  const summary = run.report.summary;
  const moved = (key) =>
    [...command, ...measured].some((sample) => Math.abs(sample[key]) > MOTION_SHOWN);
  const turned = moved('w');
  // A pure turn (the bench's 左/右) has nothing to show in the forward-speed chart.
  const straight = moved('v') || !turned;
  const duration = Math.max(
    1,
    summary.seconds,
    ...compare.map((other) => other.report.summary.seconds),
  );
  const marker = summary.stop ? { t: summary.stop.at, label: copy.stopMarker } : null;
  const common = { duration, marker };
  const charts = [];
  if (straight)
    charts.push({
      name: 'speed',
      view: motionChart(run, compare, { ...common, key: 'v', label: copy.speedChart, unit: 'm/s' }),
    });
  if (turned)
    charts.push({
      name: 'turn',
      view: motionChart(run, compare, {
        ...common,
        key: 'w',
        label: copy.turnChart,
        unit: 'rad/s',
      }),
    });
  if (front.length) charts.push({ name: 'front', view: frontChart(run, compare, duration) });
  return charts;
}

// --- path ---------------------------------------------------------------------------------------

function pathGrid(centre, span, px, py) {
  const lines = [];
  const firstX = Math.ceil((centre.x - span / 2) / PATH_GRID) * PATH_GRID;
  for (let value = firstX; value <= centre.x + span / 2; value += PATH_GRID)
    lines.push(
      svg`<line class="grid" x1="0" x2=${PATH_BOX} y1=${py({ x: value })} y2=${py({ x: value })}></line>`,
    );
  const firstY = Math.ceil((centre.y - span / 2) / PATH_GRID) * PATH_GRID;
  for (let value = firstY; value <= centre.y + span / 2; value += PATH_GRID)
    lines.push(
      svg`<line class="grid" y1="0" y2=${PATH_BOX} x1=${px({ y: value })} x2=${px({ y: value })}></line>`,
    );
  return lines;
}

// Where the robot ended and which way it faced: a dot and an arrow along the heading.
function endMarker(end, screen) {
  const heading = end.turn ?? 0;
  // Forward (+x) is up the page and left (+y) is left, so heading h points at (-sin h, -cos h).
  const ux = -Math.sin(heading);
  const uy = -Math.cos(heading);
  const tip = { x: screen.x + ux * HEADING_ARROW, y: screen.y + uy * HEADING_ARROW };
  const base = { x: tip.x - ux * ARROW_HEAD, y: tip.y - uy * ARROW_HEAD };
  const side = { x: -uy * (ARROW_HEAD / 2), y: ux * (ARROW_HEAD / 2) };
  const head = [
    tip,
    { x: base.x + side.x, y: base.y + side.y },
    { x: base.x - side.x, y: base.y - side.y },
  ];
  return svg`<line class="heading" x1=${screen.x} y1=${screen.y} x2=${base.x} y2=${base.y}></line>
    <polygon class="heading-head" points=${head.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')}></polygon>
    <circle class="end" cx=${screen.x} cy=${screen.y} r=${END_DOT}></circle>`;
}

function startMarker(screen) {
  const tip = `${screen.x},${screen.y - START_SIZE}`;
  const right = `${screen.x + START_SIZE * 0.8},${screen.y + START_SIZE * 0.6}`;
  const left = `${screen.x - START_SIZE * 0.8},${screen.y + START_SIZE * 0.6}`;
  return svg`<polygon class="start" points="${tip} ${right} ${left}"></polygon>`;
}

// Where the robot went, seen from above: start at the origin facing up the page, left is left.
function pathChart(path) {
  const xs = path.map((point) => point.x);
  const ys = path.map((point) => point.y);
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
  const toScreen = (point) => ({ x: px(point), y: py(point) });
  const end = path[path.length - 1];
  return html`<svg viewBox="0 0 ${PATH_BOX} ${PATH_BOX}" role="img" aria-label=${text().path}>
      ${pathGrid(centre, span, px, py)}
      <polyline
        class="line measured"
        points=${path.map((point) => `${px(point).toFixed(1)},${py(point).toFixed(1)}`).join(' ')}
      ></polyline>
      ${endMarker(end, toScreen(end))} ${startMarker(toScreen({ x: 0, y: 0 }))}
    </svg>
    <p class="drive-note">${fill(text().pathNote, { grid: PATH_GRID })}</p>`;
}

// A turn on the spot draws nothing useful from above, so it is said in words.
function spinText(summary) {
  const copy = text();
  const turn = describeTurn(summary.turn, copy);
  if (turn === copy.turnNone || turn === copy.none) return copy.noMove;
  return fill(copy.spinInPlace, { turn });
}

function pathPart(summary, path) {
  const copy = text();
  if (!path.length) return html`<p class="drive-note">${copy.noPath}</p>`;
  const body =
    summary.distance < MOVED_DISTANCE
      ? html`<p class="drive-report-spin">${spinText(summary)}</p>`
      : pathChart(path);
  return html`<figure class="drive-report-path">
    <figcaption><span class="drive-report-caption">${copy.path}</span></figcaption>
    ${body}
  </figure>`;
}

// --- summary, header, notes ---------------------------------------------------------------------

function stopText(stop) {
  const copy = text();
  if (!stop) return copy.stopUnknown;
  return fill(copy.stopValue, {
    delay: fixed(stop.delay, 2),
    distance: fixed(stop.distance * 100, 1),
  });
}

// Reports stored before `driveSeconds` existed show the recording length only. A cut recording
// has no tail after the stop, so its length is not said to include one.
function summaryItems(summary, cut) {
  const copy = text();
  const items = [];
  if (Number.isFinite(summary.driveSeconds))
    items.push([copy.driveTime, secondsText(summary.driveSeconds)]);
  items.push([cut ? copy.durationCut : copy.duration, secondsText(summary.seconds)]);
  items.push([copy.distance, `${fixed(summary.distance * 100, 1)} cm`]);
  items.push([copy.ended, describeOffset(summary.forward, summary.left, copy)]);
  items.push([copy.turn, describeTurn(summary.turn, copy)]);
  items.push([
    copy.maxSpeed,
    fill(copy.maxSpeedValue, {
      speed: fixed(summary.maxSpeed, 2),
      command: fixed(summary.maxCommand, 2),
    }),
  ]);
  items.push([copy.maxTurnRate, describeTurnRate(summary.maxTurnRate, copy)]);
  items.push([copy.stop, stopText(summary.stop)]);
  if (Number.isFinite(summary.closest))
    items.push([copy.closest, `${fixed(summary.closest, 2)} m`]);
  if (summary.emergencyStop) items.push([copy.emergencyStop, copy.emergencyStopYes]);
  return items;
}

// A value such as 「前へ 60.0 cm・左右 0 cm」 may wrap only after 「・」 or before 「（」, never
// between a number and its unit; a sentence without numbers wraps as usual.
const valueParts = (value) =>
  value
    .split(/(?<=・)|(?=（)/)
    .map((part) => (/\d/.test(part) ? html`<span class="drive-value-part">${part}</span>` : part));

function summaryList(run) {
  return html`<dl class="drive-report-summary">
    ${summaryItems(run.report.summary, run.cut).map(
      ([term, value]) =>
        html`<div>
          <dt>${term}</dt>
          <dd>${valueParts(value)}</dd>
        </div>`,
    )}
  </dl>`;
}

/** How a run ended, for an icon: `{kind: 'ok' | 'stopped' | 'problem', text}`. */
function driveRunStatus(run) {
  const kind = runStatusKind(run.reason);
  return { kind, text: text().status[kind] };
}

function statusIcon(run) {
  const status = driveRunStatus(run);
  return html`<span class="drive-status ${status.kind}" aria-hidden="true"
      >${STATUS_ICONS[status.kind]}</span
    ><span class="sr-only">${status.text}</span>`;
}

function reportHeader(run) {
  const copy = text();
  const meta = [
    run.robot ? fill(copy.robot, { robot: run.robot }) : '',
    run.conditions ? fill(copy.conditions, { conditions: run.conditions }) : '',
  ].filter(Boolean);
  return html`<header class="drive-report-head">
    <h4>
      ${statusIcon(run)} ${fill(copy.title, { time: formatTime(run.at), lesson: run.lesson })}
    </h4>
    ${meta.length ? html`<p class="drive-report-meta">${meta.join('　')}</p>` : nothing}
    ${run.ended ? html`<p>${run.ended}</p>` : nothing}
    ${run.cut ? html`<p class="drive-report-cut">${copy.cut}</p>` : nothing}
  </header>`;
}

function reportNotes(summary) {
  const copy = text();
  const smoothing = summary.stop ? fill(copy.smoothing, { tau: MEASURED_SMOOTHING }) : '';
  return html`<p class="drive-note">${copy.chartSources}${smoothing}</p>`;
}

function saveButtons(run, saveRun) {
  if (!run.recording) return html`<p class="drive-note">${text().notKept}</p>`;
  if (!saveRun) return nothing;
  return html`<div class="live-capture-actions">
    <button @click=${() => saveRun(run.id, 'json')}>${text().saveJson}</button>
    <button @click=${() => saveRun(run.id, 'csv')}>${text().saveCsv}</button>
  </div>`;
}

// --- the report ---------------------------------------------------------------------------------

// Inside a lesson block: the numbers and the first chart; the rest behind a closed <details>.
function compactBody(run, parts) {
  const copy = text();
  const [first, ...rest] = parts;
  const names = rest.map((part) => copy.chartNames[part.name]).join('・');
  return html`${summaryList(run)} ${reportNotes(run.report.summary)} ${first?.view ?? nothing}
  ${
    rest.length
      ? html`<details class="drive-report-more">
          <summary>${fill(copy.moreCharts, { names })}</summary>
          <div class="drive-report-charts">${rest.map((part) => part.view)}</div>
        </details>`
      : nothing
  }`;
}

function fullBody(run, charts, path, saveRun) {
  return html`<div class="drive-report-overview">${summaryList(run)} ${path}</div>
    ${reportNotes(run.report.summary)}
    <div class="drive-report-charts">${charts.map((chart) => chart.view)}</div>
    ${saveButtons(run, saveRun)}`;
}

/**
 * The report of one run (drive-history.js entry).
 * - `compact`: for a lesson block — summary and the first chart, the others folded, no saving.
 * - `saveRun(id, kind)`: shows the save buttons (full view, only while the recording is in memory).
 * - `compare`: other entries whose measurements are overlaid as thin lines (at most compareLimit).
 */
function driveReportView(run, { compact = false, saveRun, compare = [] } = {}) {
  const others = compare
    .filter((other) => other?.report && other.id !== run.id)
    .slice(0, COMPARE_LIMIT);
  const charts = timeCharts(run, others);
  const path = pathPart(run.report.summary, run.report.series.path);
  return html`<section class="drive-report ${compact ? 'compact' : ''}" data-drive-report=${run.id}>
    ${reportHeader(run)}
    ${
      compact
        ? compactBody(run, [...charts, { name: 'path', view: path }])
        : fullBody(run, charts, path, saveRun)
    }
  </section>`;
}

// --- history list -------------------------------------------------------------------------------

function runNumbers(run) {
  const summary = run.report.summary;
  const seconds = Number.isFinite(summary.driveSeconds) ? summary.driveSeconds : summary.seconds;
  return fill(text().listNumbers, {
    distance: fixed(summary.distance * 100, 0),
    seconds: fixed(seconds, 1),
  });
}

/** One line per run, as plain text (time, lesson, conditions, distance, seconds). */
function driveRunLabel(run) {
  const head = fill(text().listItem, { time: formatTime(run.at), lesson: run.lesson });
  return [head, run.conditions, runNumbers(run)].filter(Boolean).join('　');
}

function historyItem(run, list) {
  const shown = run.id === list.selected;
  const compared = list.compared.includes(run.id);
  const full = !compared && list.compared.length >= COMPARE_LIMIT;
  const details = [run.conditions, runNumbers(run)].filter(Boolean).join('　');
  return html`<li>
    <button
      data-drive-run=${run.id}
      aria-pressed=${shown ? 'true' : 'false'}
      @click=${() => list.select(run.id)}
    >
      ${statusIcon(run)}
      <span class="drive-history-text">
        <span>${fill(text().listItem, { time: formatTime(run.at), lesson: run.lesson })}</span>
        <span class="drive-history-numbers">${details}</span>
      </span>
    </button>
    ${
      list.toggleCompare
        ? html`<label class="drive-history-compare">
            <input
              type="checkbox"
              data-drive-compare=${run.id}
              .checked=${compared}
              ?disabled=${shown || full}
              @change=${() => list.toggleCompare(run.id)}
            />${text().compare}
          </label>`
        : nothing
    }
  </li>`;
}

/**
 * The history list. `selected` is the id of the run whose report is shown, `select(id)` shows
 * another; with `toggleCompare(id)` every item gets a 「比べる」 box, `compared` being the ticked
 * ids (at most compareLimit; the shown run cannot be ticked).
 */
function driveHistoryList({ runs, selected, compared = [], select, toggleCompare }) {
  const list = { selected, compared, select, toggleCompare };
  return html`${
      toggleCompare
        ? html`<p class="drive-note">${fill(text().compareLead, { limit: COMPARE_LIMIT })}</p>`
        : nothing
    }
    <ol class="drive-history">
      ${runs.map((run) => historyItem(run, list))}
    </ol>`;
}

export {
  driveReportView,
  driveRunLabel,
  driveRunStatus,
  driveHistoryList,
  reportCopy,
  COMPARE_LIMIT as compareLimit,
};
