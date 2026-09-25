import { html, svg, nothing, styleMap } from '../vendor/lit-html.js';
import { loadJson, fillSentence as fill } from '../core/content.js';
import {
  describeOffset,
  describeTurn,
  describeTurnRate,
  runStatusKind,
  runStatusKey,
  MOVED_DISTANCE,
  MOVED_TURN,
} from './drive-report-core.js';
import { driveRunName, hasRecording } from './drive-history.js';
import { UNKNOWN_CONDITIONS } from './recording-core.js';

// The report of one driving run (drive-history.js entry): what happened in numbers, the commanded
// and measured speed over time, the path seen from above, and the wall distance when the LiDAR saw
// one; plus the history list. Pure templates.
//
// Time charts are an SVG stretched to a box of fixed CSS height (preserveAspectRatio="none", lines
// with vector-effect="non-scaling-stroke") under HTML labels placed in %, so the text keeps its
// size on a phone and on a projector alike. Colours are the palette's roles (css/drive-report.css):
// measured blue solid, command = the target amber dashed, other runs grey with their own dash
// pattern, each line with a direct label at its end (A, B, C for the compared runs).

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
const COMPARE_NAMES = ['A', 'B', 'C'];
const STATUS_ICONS = { ok: '✓', stopped: '■', problem: '⚠︎', unknown: '?' };
// Labels closer than this (percent of the plot's height, about one line of 12 px text on the
// phone's 128 px plot) are moved apart.
const LABEL_GAP = 12;
const STILL_TURN_RATE = 0.05; // rad/s: a run whose turn rate never exceeds this did not turn
const SHORT_RUN = 1.5; // s: a run stopped part-way within this is folded in the history list
// The numbers of the summary, in order; a lesson picks its own (live-session `reportMetrics`).
const REPORT_METRICS = [
  'driveTime',
  'duration',
  'distance',
  'ended',
  'turn',
  'maxSpeed',
  'maxTurnRate',
  'stop',
  'closest',
];

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
        svg`<polyline class="line ${line.kind}" points=${polyline(shownPoints(line.points), x, y)} vector-effect="non-scaling-stroke"></polyline>`,
    )}
  </svg>`;
}

// Before the first command (t < 0) the robot stood waiting: the chart starts at the command. The
// last point before it is kept (drawn at t = 0), so a line starts at the axis, not in mid-air.
function shownPoints(points) {
  const first = points.findIndex(([t]) => t >= 0);
  if (first < 0) return [];
  return points.slice(Math.max(0, first - 1));
}

// Moves labels (sorted by `top`, in %) apart to at least LABEL_GAP, staying inside 0–100 %.
function spreadLabels(labels) {
  const sorted = [...labels].sort((a, b) => a.top - b.top);
  for (let index = 1; index < sorted.length; index++)
    sorted[index].top = Math.max(sorted[index].top, sorted[index - 1].top + LABEL_GAP);
  const overflow = (sorted.at(-1)?.top ?? 0) - PLOT_SPAN;
  if (overflow > 0) for (const label of sorted) label.top -= overflow;
  return sorted;
}

// The name of each line, written where the line ends (outside the plot on its right when it runs
// to the end of the time axis).
function endLabels(chart, x, y) {
  const labels = chart.lines
    .filter((line) => line.end && shownPoints(line.points).length)
    .map((line) => {
      const [t, value] = shownPoints(line.points).at(-1);
      return { kind: line.kind, text: line.end, left: x(t), top: y(value) };
    });
  return spreadLabels(labels).map(
    (label) =>
      html`<span
        class="drive-plot-end ${label.kind}"
        style=${styleMap({ left: percent(label.left), top: percent(label.top) })}
        >${label.text}</span
      >`,
  );
}

// Reference lines are labelled above the line; when two lie close, the lower one's label goes
// below its line instead, so 「目標 0.50 m」 and 「ここで止める 0.30 m」 never overlap.
function referenceLabels(references, y) {
  const placed = references
    .map((reference) => ({ ...reference, top: y(reference.value) }))
    .sort((a, b) => a.top - b.top);
  return placed.map((reference, index) => {
    const crowded = index > 0 && reference.top - placed[index - 1].top < LABEL_GAP * 2;
    return html`<span
      class="drive-plot-reference ${crowded ? 'below' : ''}"
      style=${styleMap({ top: percent(reference.top) })}
      >${reference.label}</span
    >`;
  });
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

// `ticks.values` on the y axis, `ticks.times` (s) on the time axis (its title is under the chart).
function plotLabels(chart, ticks, x, y) {
  return html`${ticks.values.map(
    (value) =>
      html`<span class="drive-plot-y" style=${styleMap({ top: percent(y(value)) })}
        >${tickText(value)}</span
      >`,
  )}
  ${ticks.times.map(
    (t) =>
      html`<span class="drive-plot-t" style=${styleMap({ left: percent(x(t)) })}
        >${tickText(t)}</span
      >`,
  )}
  ${referenceLabels(chart.references, y)} ${endLabels(chart, x, y)} ${markerLabel(chart.marker, x)}`;
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
 * A time chart. `lines` are `{kind, points: [[t, value]], end}` (kind = CSS modifier: measured,
 * command, front, compare-1…; `end` the label written where the line ends; points before t = 0
 * are not drawn), `legend` `{kind, label}`, `references` horizontal lines
 * `{value, label}`, `marker` an optional vertical line `{t, label}`; `duration` in seconds.
 */
function timeChart(chart) {
  const values = [
    ...chart.lines.flatMap((line) => shownPoints(line.points).map((point) => point[1])),
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
    <p class="drive-plot-axis">${text().timeAxis}</p>
  </figure>`;
}

// --- which charts a run gets --------------------------------------------------------------------

// 「A 3班 0.20 m/s 10:51:02」: the letter drawn at the line's end, then the run's short name.
const compareName = (run, index) => `${COMPARE_NAMES[index]} ${driveRunName(run)}`;

const compareLegend = (compare) =>
  compare.map((run, index) => ({ kind: `compare-${index + 1}`, label: compareName(run, index) }));

// Command below, the compared runs' measurements, this run's measurement on top.
function motionChart(run, compare, { key, label, unit, duration, marker }) {
  const copy = text();
  const { command, measured } = run.report.series;
  const series = (samples, kind, end) => ({
    kind,
    end,
    points: samples.map((sample) => [sample.t, sample[key]]),
  });
  return timeChart({
    label,
    unit,
    duration,
    marker,
    references: [],
    lines: [
      series(command, 'command', copy.command),
      ...compare.map((other, index) =>
        series(other.report.series.measured, `compare-${index + 1}`, COMPARE_NAMES[index]),
      ),
      series(measured, 'measured', copy.measured),
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
  const series = (samples, kind, end) => ({
    kind,
    end,
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
        series(other.report.series.front ?? [], `compare-${index + 1}`, COMPARE_NAMES[index]),
      ),
      series(run.report.series.front, 'front', copy.lidar),
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
function allSummaryItems(summary, cut) {
  const copy = text();
  const items = [];
  if (Number.isFinite(summary.driveSeconds))
    items.push(['driveTime', copy.driveTime, secondsText(summary.driveSeconds)]);
  items.push(['duration', cut ? copy.durationCut : copy.duration, secondsText(summary.seconds)]);
  items.push(['distance', copy.distance, `${fixed(summary.distance * 100, 1)} cm`]);
  items.push(['ended', copy.ended, describeOffset(summary.forward, summary.left, copy)]);
  items.push(['turn', copy.turn, describeTurn(summary.turn, copy)]);
  items.push([
    'maxSpeed',
    copy.maxSpeed,
    fill(copy.maxSpeedValue, {
      speed: fixed(summary.maxSpeed, 2),
      command: fixed(summary.maxCommand, 2),
    }),
  ]);
  items.push(['maxTurnRate', copy.maxTurnRate, describeTurnRate(summary.maxTurnRate, copy)]);
  items.push(['stop', copy.stop, stopText(summary.stop)]);
  if (Number.isFinite(summary.closest))
    items.push(['closest', copy.closest, `${fixed(summary.closest, 2)} m`]);
  return items;
}

// A run that neither turned nor was turned has nothing to say about turning.
const turned = (summary) =>
  Math.abs(summary.turn ?? 0) >= MOVED_TURN || summary.maxTurnRate > STILL_TURN_RATE;

/**
 * The summary's `[term, value]` pairs: `metrics` (keys of REPORT_METRICS) picks and orders them;
 * without it, all of them — in the compact report less the turning ones when the run did not
 * turn. An emergency stop is always said.
 */
function summaryItems(summary, cut, { metrics = null, compact = false } = {}) {
  const items = allSummaryItems(summary, cut);
  const wanted = metrics ?? REPORT_METRICS;
  const skipTurn = !metrics && compact && !turned(summary);
  const shown = wanted
    .map((key) => items.find(([item]) => item === key))
    .filter((item) => item && !(skipTurn && ['turn', 'maxTurnRate'].includes(item[0])))
    .map(([, term, value]) => [term, value]);
  if (summary.emergencyStop) shown.push([text().emergencyStop, text().emergencyStopYes]);
  return shown;
}

// A value such as 「前へ 60.0 cm・左右 0 cm」 may wrap only after 「・」 or before 「（」, never
// between a number and its unit; a sentence without numbers wraps as usual.
const valueParts = (value) =>
  value
    .split(/(?<=・)|(?=（)/)
    .map((part) => (/\d/.test(part) ? html`<span class="drive-value-part">${part}</span>` : part));

function summaryList(run, options) {
  return html`<dl class="drive-report-summary">
    ${summaryItems(run.report.summary, run.cut, options).map(
      ([term, value]) =>
        html`<div>
          <dt>${term}</dt>
          <dd>${valueParts(value)}</dd>
        </div>`,
    )}
  </dl>`;
}

/** How a run ended in words, from drive-link's reason (「予定どおり走り終えた」, …). */
const runStatusText = (reason) => text().status[runStatusKey(reason)];

/** How a run ended, for an icon and its words: `{kind: 'ok' | 'stopped' | 'problem', text}`. */
function driveRunStatus(run) {
  // A file saved before recordings said how the run ended.
  if (!run.reason && run.source === 'file') return { kind: 'unknown', text: text().status.unknown };
  return { kind: runStatusKind(run.reason), text: runStatusText(run.reason) };
}

// The icon with its words next to it (the icon alone would leave ■ and ⚠︎ to be guessed).
function statusBadge(run) {
  const status = driveRunStatus(run);
  return html`<span class="drive-status-badge ${status.kind}"
    ><span class="drive-status ${status.kind}" aria-hidden="true">${STATUS_ICONS[status.kind]}</span
    >${status.text}</span
  >`;
}

function reportHeader(run) {
  const copy = text();
  const meta = [
    run.group ? fill(copy.group, { group: run.group }) : '',
    run.robot ? fill(copy.robot, { robot: run.robot }) : '',
    fill(copy.conditions, { conditions: run.conditions || copy.conditionsUnknown }),
    run.source === 'file' ? copy.fromFile : '',
  ].filter(Boolean);
  return html`<header class="drive-report-head">
    <h4>${fill(copy.title, { time: formatTime(run.at), lesson: run.lesson })}</h4>
    <p class="drive-report-status">${statusBadge(run)}</p>
    <p class="drive-report-meta">${meta.join('　')}</p>
    ${run.ended ? html`<p>${run.ended}</p>` : nothing}
    ${run.cut ? html`<p class="drive-report-cut">${copy.cut}</p>` : nothing}
  </header>`;
}

function reportNotes(summary) {
  const copy = text();
  const smoothing = summary.stop ? fill(copy.smoothing, { tau: MEASURED_SMOOTHING }) : '';
  return smoothing ? html`<p class="drive-note">${smoothing}</p>` : nothing;
}

// Which ROS topic each number and line came from: for the teacher, folded.
const topicDetails = () =>
  html`<details class="drive-teacher drive-report-topics">
    <summary>${text().teacherDetails}</summary>
    <p>${text().chartSources}</p>
  </details>`;

function saveButtons(run, saveRun) {
  const copy = text();
  if (!hasRecording(run)) return html`<p class="drive-note">${copy.notKept}</p>`;
  if (!saveRun) return nothing;
  return html`<div class="live-capture-actions">
      <button data-drive-save="json" @click=${() => saveRun(run.id, 'json')}>
        ${copy.saveJson}
      </button>
      <button data-drive-save="csv" @click=${() => saveRun(run.id, 'csv')}>${copy.saveCsv}</button>
      <button class="quiet" data-drive-save="raw-csv" @click=${() => saveRun(run.id, 'raw-csv')}>
        ${copy.saveRawCsv}
      </button>
    </div>
    <p class="drive-note">${copy.share}</p>`;
}

// --- the report ---------------------------------------------------------------------------------

// Inside a lesson block: the numbers and the first chart; the rest behind a closed <details>.
function compactBody(run, parts, metrics) {
  const copy = text();
  const [first, ...rest] = parts;
  const names = rest.map((part) => copy.chartNames[part.name]).join('・');
  return html`${summaryList(run, { metrics, compact: true })} ${first?.view ?? nothing}
  ${reportNotes(run.report.summary)}
  ${
    rest.length
      ? html`<details class="drive-report-more">
          <summary>${fill(copy.moreCharts, { names })}</summary>
          <div class="drive-report-charts">${rest.map((part) => part.view)}</div>
        </details>`
      : nothing
  }
  ${topicDetails()}`;
}

// With other runs overlaid, the charts are what the learner asked to see: they come first.
function fullBody(run, charts, path, { saveRun, comparing }) {
  const overview = html`<div class="drive-report-overview">${summaryList(run)} ${path}</div>`;
  const chartList = html`<div class="drive-report-charts" data-drive-report-charts>
    ${charts.map((chart) => chart.view)}
  </div>`;
  return html`${comparing ? chartList : overview} ${reportNotes(run.report.summary)}
  ${comparing ? overview : chartList} ${topicDetails()} ${saveButtons(run, saveRun)}`;
}

/**
 * The report of one run (drive-history.js entry).
 * - `compact`: for a lesson block — summary and the first chart, the others folded, no saving.
 * - `metrics`: the summary's numbers (keys of REPORT_METRICS, in order); all when null.
 * - `saveRun(id, kind)`: shows the save buttons (full view, while the recording can be had).
 * - `compare`: other entries whose measurements are overlaid (at most compareLimit), grey with
 *   their own dash pattern and labelled A, B, C.
 */
function driveReportView(run, { compact = false, metrics = null, saveRun, compare = [] } = {}) {
  const others = compare
    .filter((other) => other?.report && other.id !== run.id)
    .slice(0, COMPARE_LIMIT);
  const charts = timeCharts(run, others);
  const path = pathPart(run.report.summary, run.report.series.path);
  return html`<section class="drive-report ${compact ? 'compact' : ''}" data-drive-report=${run.id}>
    ${reportHeader(run)}
    ${
      compact
        ? compactBody(run, [...charts, { name: 'path', view: path }], metrics)
        : fullBody(run, charts, path, { saveRun, comparing: others.length > 0 })
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

/** One line per run, as plain text (time, lesson, group, conditions, distance, seconds). */
function driveRunLabel(run) {
  const head = fill(text().listItem, { time: formatTime(run.at), lesson: run.lesson });
  return [head, run.group, run.conditions, runNumbers(run)].filter(Boolean).join('　');
}

function historyItem(run, list) {
  const shown = run.id === list.selected;
  const compared = list.compared.includes(run.id);
  const full = !compared && list.compared.length >= COMPARE_LIMIT;
  const details = [run.group, run.conditions || UNKNOWN_CONDITIONS, runNumbers(run)]
    .filter(Boolean)
    .join('　');
  return html`<li>
    <button
      data-drive-run=${run.id}
      aria-pressed=${shown ? 'true' : 'false'}
      @click=${() => list.select(run.id)}
    >
      <span class="drive-history-text">
        <span>${fill(text().listItem, { time: formatTime(run.at), lesson: run.lesson })}</span>
        <span class="drive-history-numbers">${details}</span>
        ${statusBadge(run)}
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
  const folded = runs.filter((run) => isShortStop(run) && !isInUse(run, list));
  const listed = runs.filter((run) => !folded.includes(run));
  return html`${
      toggleCompare
        ? html`<p class="drive-note">${fill(text().compareLead, { limit: COMPARE_LIMIT })}</p>`
        : nothing
    }
    <ol class="drive-history">
      ${listed.map((run) => historyItem(run, list))}
    </ol>
    ${
      folded.length
        ? html`<details class="drive-history-short">
            <summary>${fill(text().shortRuns, { count: folded.length })}</summary>
            <ol class="drive-history">
              ${folded.map((run) => historyItem(run, list))}
            </ol>
          </details>`
        : nothing
    }`;
}

// A run stopped within its first moments says little; it is kept, but folded away so the runs
// worth comparing stay together.
function isShortStop(run) {
  if (run.reason === 'done' || !run.reason) return false;
  const summary = run.report.summary;
  const seconds = Number.isFinite(summary.driveSeconds) ? summary.driveSeconds : summary.seconds;
  return seconds < SHORT_RUN;
}

const isInUse = (run, list) => run.id === list.selected || list.compared.includes(run.id);

export {
  driveReportView,
  driveRunLabel,
  driveRunStatus,
  runStatusText,
  REPORT_METRICS,
  driveHistoryList,
  reportCopy,
  COMPARE_LIMIT as compareLimit,
};
