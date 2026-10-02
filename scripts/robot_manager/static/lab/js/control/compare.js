import { fillSentence as fill } from '../core/content.js';
import { firstHold, stepMetrics } from '../live/capture-core.js';
import { formatValue } from './summary.js';

// Comparing real runs in the feedback-control course: what each recording is called, the rows of
// the comparison table and the one sentence that says what changed between the last two runs.
// No DOM: test/control-compare.test.mjs. Sentences come from content/control/ui.json (`live`),
// handed in as `text`.

const CENTIMETRES = 100; // per metre: distances are shown in cm
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const pad = (value) => String(value).padStart(2, '0');

/** 「10:51:02」 in the browser's time zone, or '' when the time is missing or not a date. */
function clockTime(iso) {
  const date = new Date(iso ?? NaN);
  if (Number.isNaN(date.getTime())) return '';
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join(':');
}

const textOf = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * What a recording says about itself (the optional fields the live layer writes):
 * `{settings, known, time, group, robot}`. Older files have none of them: their settings read
 * 「設定：不明」 (`text.unknownSettings`) and the rest stays empty.
 *
 * Can later be replaced by recordingLabel() in js/live/recording-core.js, which reads the same
 * fields for every course.
 */
function runLabelParts(recording, text) {
  const settings = textOf(recording?.conditions?.label);
  return {
    settings: settings || text.unknownSettings,
    known: Boolean(settings),
    time: clockTime(recording?.recordedAt),
    group: textOf(recording?.group),
    robot: textOf(recording?.robot?.name),
  };
}

/** The group and robot, 「3班・questix-03」, or ''. */
const whoText = (parts) => [parts.group, parts.robot].filter(Boolean).join('・');

/** One line naming a recording: 「0.2 m/s 10:51:02（3班・questix-03）」. */
function runLabel(recording, text) {
  const parts = runLabelParts(recording, text);
  const who = whoText(parts);
  const head = [parts.settings, parts.time].filter(Boolean).join(' ');
  return who ? `${head}（${who}）` : head;
}

/** A, B, C … for the n-th compared run (0-based), AA after Z. */
function compareLetter(index) {
  const letter = LETTERS[index % LETTERS.length];
  return index < LETTERS.length
    ? letter
    : compareLetter(Math.floor(index / LETTERS.length) - 1) + letter;
}

/**
 * The samples a real run is judged on and where its label goes on the chart. A speed recording
 * counts over its first command only (the robot stops afterwards); its label sits at the end of
 * that command, where the plateaus of different runs are furthest apart.
 */
function judgedSamples(run, distance) {
  return distance ? run.samples : firstHold(run.samples);
}

function labelPoint(run, distance) {
  const sample = judgedSamples(run, distance).at(-1);
  return sample ? { time: sample.time, value: sample.measured } : null;
}

/** The command a speed recording held first (rpm), or null for the wall. */
function commandRpm(run, distance) {
  if (distance) return null;
  const target = firstHold(run.samples)[0]?.target;
  return Number.isFinite(target) ? target : null;
}

function realMetrics(run, distance, stopDistance) {
  const samples = judgedSamples(run, distance);
  if (!samples.length) return null;
  const target = distance ? stopDistance : samples[0].target;
  return stepMetrics(samples, { key: 'measured', target, distance });
}

/**
 * The rows of the comparison table: the simulation on screen (when it is of this kind), the
 * recording on screen, then the compared runs. A run too short to judge is left out.
 * `simulation`: `{samples, target, settings, stale}` or null; `current`: `{run, parts}` or null;
 * `compared`: `[{run, parts, letter, source, file}]`.
 */
function comparisonRows({ simulation, current, compared, distance, stopDistance, text }) {
  const rows = [];
  if (simulation)
    rows.push({
      id: 'sim',
      name: text.compareSimulation,
      settings: simulation.settings,
      stale: simulation.stale,
      metrics: stepMetrics(simulation.samples, {
        key: 'actual',
        target: simulation.target,
        distance,
      }),
    });
  if (current)
    rows.push(
      realRow('live', currentName(current.parts, text), current, distance, stopDistance, text),
    );
  for (const entry of compared)
    rows.push(
      realRow(entry.letter, comparedName(entry, text), entry, distance, stopDistance, text),
    );
  return rows.filter((row) => row.metrics);
}

/**
 * The name of a compared run, as the help text and the legend call it: an earlier run of this page
 * (source 'past', the grey dotted line) 「A（前の走行）」, an opened file (dark grey dashes) 「A」.
 * The letter alone is what the chart writes at the end of the line.
 */
const comparedName = (entry, text) =>
  entry.source === 'past' ? fill(text.compareNamePast, { letter: entry.letter }) : entry.letter;

const currentName = (parts, text) =>
  parts.time ? fill(text.compareNameLive, { time: parts.time }) : text.compareNameLiveNoTime;

function realRow(id, name, entry, distance, stopDistance, text) {
  const { parts } = entry;
  const details = [parts.settings, id === 'live' ? '' : parts.time, whoText(parts)];
  return {
    id,
    name,
    settings: details.filter(Boolean).join('・'),
    source: entry.source ?? 'live',
    file: entry.source === 'file' ? (entry.file ?? '') : '',
    parts,
    conditions: entry.conditions ?? null,
    recordedAt: entry.recordedAt ?? null,
    stale: false,
    metrics: realMetrics(entry.run, distance, stopDistance),
  };
}

// --- the sentence under the table -----------------------------------------------------------

// The settings a lesson's drive.conditions() reports, in the order and words of the sliders.
const SETTING_NAMES = {
  speed: { name: '速さ', unit: ' m/s' },
  kp: { name: 'P', unit: '' },
  ki: { name: 'I', unit: '' },
  kd: { name: 'D', unit: '' },
  stop: { name: '止める距離', unit: ' m' },
};

// 0 → 「0」, 0.6 → 「0.6」, 2.25 → 「2.25」: a gain as the learner set it, without trailing zeros.
const plain = (value) => String(Number(Number(value).toFixed(2)));

function changedSettings(before, after) {
  return Object.keys(SETTING_NAMES).filter(
    (key) =>
      Number.isFinite(before[key]) &&
      Number.isFinite(after[key]) &&
      plain(before[key]) !== plain(after[key]),
  );
}

const hasSettings = (conditions) =>
  Boolean(conditions) && Object.keys(SETTING_NAMES).some((key) => Number.isFinite(conditions[key]));

function leadText(before, after, words) {
  const from = before.conditions;
  const to = after.conditions;
  if (!hasSettings(from) || !hasSettings(to))
    return fill(words.leadUnknown, { from: before.name, to: after.name });
  const changed = changedSettings(from, to);
  const settings = textOf(to.label) || before.name;
  // A file may come from another group's robot: that is not "the same run again".
  const opened = before.source === 'file' || after.source === 'file';
  if (!changed.length && opened)
    return fill(words.leadSameOther, { settings, from: before.name, to: after.name });
  if (!changed.length) return fill(words.leadSame, { settings });
  if (changed.length > 1)
    return fill(words.leadMany, {
      from: textOf(from.label) || before.name,
      to: textOf(to.label) || after.name,
    });
  const key = changed[0];
  return fill(words.leadOne, {
    name: SETTING_NAMES[key].name,
    from: plain(from[key]),
    to: plain(to[key]),
    unit: SETTING_NAMES[key].unit,
  });
}

// One number of the two runs: 「止まるまで7.9→8.3秒」, 「行き過ぎは0 cmのまま」. `null` is a run
// that did not settle.
function metricChange(name, [from, to], unit, words, neverText) {
  if (from === null && to === null) return neverText;
  if (from === to) return fill(words.same, { name, value: from, unit });
  if (from === null || to === null)
    return fill(words.changedMixed, {
      name,
      from: from === null ? words.notSettled : from + unit,
      to: to === null ? words.notSettled : to + unit,
    });
  return fill(words.changed, { name, from, to, unit });
}

const settlingText = (metrics) =>
  metrics.settling === null ? null : formatValue(metrics.settling, 1);

function overshootText(metrics, distance) {
  if (distance) return formatValue(metrics.overshoot * CENTIMETRES, 0);
  return formatValue(metrics.overshoot, 1);
}

/**
 * One sentence built from the numbers of two real runs (rows of comparisonRows, `before` the
 * earlier): what was changed and how the time to settle and the overshoot moved.
 */
function conclusionSentence(before, after, { distance, text }) {
  const words = text.conclusion;
  const settling = metricChange(
    distance ? words.settlingDistance : words.settlingSpeed,
    [settlingText(before.metrics), settlingText(after.metrics)],
    words.seconds,
    words,
    distance ? words.neverSettledDistance : words.neverSettledSpeed,
  );
  const overshoot = metricChange(
    words.overshoot,
    [overshootText(before.metrics, distance), overshootText(after.metrics, distance)],
    distance ? ' cm' : ' rpm',
    words,
    '',
  );
  return leadText(before, after, words) + [settling, overshoot].join('、') + words.end;
}

const timeOf = (row) => {
  const time = new Date(row.recordedAt ?? NaN).getTime();
  return Number.isNaN(time) ? null : time;
};

/**
 * The two real runs the sentence compares, earlier first: the recording on screen and the run
 * before it on this page (or, without one, the newest opened file). Null with fewer than two.
 */
function lastTwoRuns(rows) {
  const current = rows.find((row) => row.id === 'live');
  const others = rows.filter((row) => row.id !== 'sim' && row.id !== 'live');
  const pasts = others.filter((row) => row.source === 'past');
  // Rows come in the order they were added; a row without a time keeps that order.
  const sorted = (pasts.length ? pasts : others).sort(
    (a, b) => (timeOf(a) ?? 0) - (timeOf(b) ?? 0),
  );
  const newest = sorted.at(-1);
  if (!newest) return null;
  if (!current) return sorted.length > 1 ? [sorted.at(-2), newest] : null;
  const newestTime = timeOf(newest);
  const currentTime = timeOf(current);
  const fileIsLater =
    newest.source === 'file' &&
    newestTime !== null &&
    currentTime !== null &&
    newestTime > currentTime;
  return fileIsLater ? [current, newest] : [newest, current];
}

/** The conclusion for the comparison table, or '' when there are not two real runs. */
function comparisonConclusion(rows, options) {
  const pair = lastTwoRuns(rows);
  return pair ? conclusionSentence(pair[0], pair[1], options) : '';
}

export {
  comparedName,
  clockTime,
  runLabelParts,
  runLabel,
  whoText,
  compareLetter,
  labelPoint,
  commandRpm,
  comparisonRows,
  conclusionSentence,
  comparisonConclusion,
  lastTwoRuns,
};
