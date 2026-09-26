import { niceScale, scaleTo } from '../core/chart-scale.js';

function measurementStats(values) {
  if (!values.length || values.some((v) => !Number.isFinite(v))) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return {
    n: values.length,
    mean,
    min: Math.min(...values),
    max: Math.max(...values),
    sd: Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length),
  };
}
function fitMeasurement(rows) {
  const train = rows.filter((r) => !r.test);
  const check = rows.filter((r) => r.test);
  if (train.length < 2 || rows.some((r) => !Number.isFinite(r.x) || !Number.isFinite(r.y)))
    return null;
  const x = measurementStats(train.map((r) => r.x)).mean;
  const y = measurementStats(train.map((r) => r.y)).mean;
  const variance = train.reduce((s, r) => s + (r.x - x) ** 2, 0);
  if (variance < 1e-9) return null;
  const slope = train.reduce((s, r) => s + (r.x - x) * (r.y - y), 0) / variance;
  const intercept = y - slope * x;
  const min = Math.min(...train.map((r) => r.x));
  const max = Math.max(...train.map((r) => r.x));
  const predictions = check.map((r) => ({
    ...r,
    predicted: slope * r.x + intercept,
    error: slope * r.x + intercept - r.y,
    inside: r.x >= min && r.x <= max,
  }));
  return {
    slope,
    intercept,
    min,
    max,
    predictions,
    mae: predictions.length
      ? measurementStats(predictions.map((r) => Math.abs(r.error))).mean
      : null,
  };
}
function parseMeasurementCSV(text) {
  const lines = text
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('#'));
  // The header is optional; a two-column table may leave out the test column.
  if (['x,y,test', 'x,y'].includes(lines[0]?.toLowerCase().replace(/\s/g, ''))) lines.shift();
  if (!lines.length || lines.length > 200)
    throw new Error('1〜200行の x,y,test のデータを使ってください。');
  return lines.map((line, i) => {
    const v = line.split(',').map((s) => s.trim());
    if (
      v.length < 2 ||
      v.length > 3 ||
      v.slice(0, 2).some((s) => !s || !Number.isFinite(Number(s))) ||
      (v[2] && !['0', '1'].includes(v[2]))
    )
      throw new Error(
        i + 1 + '行目を確認してください。数値2列と、確認用なら1（それ以外0）を使います。',
      );
    return { x: Number(v[0]), y: Number(v[1]), test: v[2] === '1' };
  });
}

// What kind of file the learner picked in the measurement CSV field, before it is parsed as one:
// 'json' (a recording or any other JSON), 'recording' (the recording CSV this material saves: its
// header starts with time_s,stream), 'wide' (a table with more than the three columns x,y,test —
// e.g. a recording CSV in another layout), 'binary' (a rosbag, an image…) or null for text that may
// be a measurement CSV. The lesson turns the kind into its own sentence instead of a parse error.
const BINARY_SAMPLE = 512; // characters looked at for control bytes
const MAX_COLUMNS = 3; // x, y, test
const RECORDING_CSV_HEADER = /^time_s\s*,\s*stream\s*(,|$)/i;

function measurementFileProblem(text) {
  const body = text.replace(/^\uFEFF/, '').trimStart();
  // NUL and other control bytes (tab, line breaks and the replacement character aside) never
  // occur in a CSV someone typed or exported.
  if (/[\u0000-\u0008\u000E-\u001F]/.test(body.slice(0, BINARY_SAMPLE))) return 'binary';
  if (body.startsWith('{') || body.startsWith('[')) return 'json';
  const header = body.split(/\r?\n/).find((line) => line.trim() && !line.startsWith('#')) ?? '';
  if (RECORDING_CSV_HEADER.test(header.trim())) return 'recording';
  if (header.split(',').length > MAX_COLUMNS) return 'wide';
  return null;
}

// --- the scatter plot's axes ---------------------------------------------------------------------

// The plot is drawn in an SVG whose viewBox is as wide as it is on screen, so its tick labels keep
// their pixel size on a phone (CONTRIBUTING: no figure text under 12 px). Narrow screens get a
// slightly lower plot and fewer ticks.
const NARROW_PLOT = 560; // px
const PLOT_HEIGHT = { wide: 260, narrow: 220 }; // px
const PLOT_MARGIN = { left: 56, right: 18, top: 14, bottom: 34 }; // px, room for the tick labels
const TICK_SPACING = { x: 80, y: 44 }; // px between labelled ticks, about
const MIN_TICKS = 3;
const MIN_PLOT_WIDTH = 280; // px; below this the plot is simply scaled down

/**
 * Axes for `rows` ({x, y}; `correction` is added to every y) in a plot `width` px wide:
 * `{width, height, narrow, box: {left, top, right, bottom}, x, y, toX, toY}`, where x and y are
 * niceScale axes (round ticks, zero on the axis) and toX / toY map values to pixels.
 */
function measurementPlotAxes(rows, correction, width) {
  const plotWidth = Math.max(MIN_PLOT_WIDTH, Math.round(width) || 0);
  const narrow = plotWidth < NARROW_PLOT;
  const height = narrow ? PLOT_HEIGHT.narrow : PLOT_HEIGHT.wide;
  const box = {
    left: PLOT_MARGIN.left,
    top: PLOT_MARGIN.top,
    right: plotWidth - PLOT_MARGIN.right,
    bottom: height - PLOT_MARGIN.bottom,
  };
  const xTicks = Math.max(MIN_TICKS, Math.floor((box.right - box.left) / TICK_SPACING.x));
  const yTicks = Math.max(MIN_TICKS, Math.floor((box.bottom - box.top) / TICK_SPACING.y));
  const x = niceScale(
    rows.map((row) => row.x),
    { ticks: xTicks },
  );
  const y = niceScale(
    rows.map((row) => row.y + correction),
    { ticks: yTicks },
  );
  return {
    width: plotWidth,
    height,
    narrow,
    box,
    x,
    y,
    toX: scaleTo(x, box.left, box.right),
    toY: scaleTo(y, box.bottom, box.top),
  };
}

// --- where a row came from -------------------------------------------------------------------------

const FILE_PREFIX = /^QUESTiX-LAB-/i;
// The date-time stamp this material puts in a saved file's name (capture.js fileStamp).
const FILE_STAMP = /-?\d{8}-(\d{2})(\d{2})(\d{2})(?=$|[^\d])/;
const SHORT_NAME = { length: 24, head: 8, tail: 15 }; // characters of a shortened file name

/**
 * A file name short enough for a table cell: no extension, no QUESTiX-LAB- prefix, the saved
 * date-time stamp as HH:MM:SS, and the middle cut out of a long name (the end, with the settings
 * and the time, tells files apart best).
 */
function shortFileName(name) {
  const base = String(name ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(FILE_PREFIX, '')
    .replace(FILE_STAMP, (stamp, hours, minutes, seconds) => ` ${hours}:${minutes}:${seconds}`)
    .trim();
  if (base.length <= SHORT_NAME.length) return base;
  return base.slice(0, SHORT_NAME.head) + '…' + base.slice(-SHORT_NAME.tail);
}

const twoDigits = (value) => String(value).padStart(2, '0');

/** HH:MM:SS of an ISO time in the device's time zone, or '' when it cannot be read. */
function clockTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(twoDigits).join(':');
}

/**
 * The short name of a recording in the source column: the group's name (with the time) when the
 * recording has one, otherwise the file it was opened from, otherwise 実機 and the time.
 * `texts` = {group: '{group} {time}', live: '実機 {time}'}; `fill` fills the placeholders.
 */
function recordingSourceLabel(recording, texts, fill) {
  const time = clockTime(recording?.recordedAt);
  const group = typeof recording?.group === 'string' ? recording.group.trim() : '';
  if (group) return fill(texts.group, { group, time }).trim();
  if (recording?.name) return shortFileName(recording.name);
  return fill(texts.live, { time }).trim();
}

export {
  measurementStats,
  fitMeasurement,
  parseMeasurementCSV,
  measurementFileProblem,
  measurementPlotAxes,
  shortFileName,
  clockTime,
  recordingSourceLabel,
};
