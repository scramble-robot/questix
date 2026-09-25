// A recording from the real robot as a value that outlives the page: what capture.js collected
// from the live link, or what was read from a rosbag, in one shape. It can be saved as a file,
// opened again (in this or another lesson), written out as CSV for a spreadsheet or a plotting
// tool, and kept in the browser across a reload. No DOM: checked in test/recording-core.test.mjs.
//
// {
//   format: 'questix-lab-recording', version: 1,
//   source: 'live' | 'rosbag', name, recordedAt (ISO 8601),
//   config: { wheel_radius, wheel_separation },       // metres, as the bridge's hello reports it
//   topics: { drive: '/drive_status', ... },            // the ROS topic behind each stream
//   streams: { drive: [...], twist: [...], scan: [...], odom: [...] }
//   // optional, written since 2026-09 (older files simply lack them; readers fall back):
//   lesson: 'control-speed',                            // the lesson / slot it was made for
//   conditions: { speed: 0.2, label: '0.20 m/s' },      // the lesson's drive.conditions() + label
//   robot: { name: 'questix-03', domain: 3 },           // from the bridge's hello
//   group: '3班',                                        // 班の名前 typed on this device
//   outcome: { reason: 'done', label: '予定どおり走り終えた' }, // how a driving run ended
// }
//
// Every stream holds messages exactly as questix_lab_bridge sends them (see
// questix_lab_bridge/questix_lab_bridge/messages.py), each with a `stamp` in seconds of the
// robot's clock, sorted by it. Lessons derive their numbers from the streams, never from the
// order messages happened to arrive in, so a reopened file gives the same result as the recording.

import {
  wheelRpm,
  frontDistance,
  driveSamples,
  captureSummary,
  distanceSamples,
  odomMoves,
} from './capture-core.js';

const RECORDING_FORMAT = 'questix-lab-recording';
const RECORDING_VERSION = 1;
const RECORDING_STREAMS = ['drive', 'twist', 'scan', 'odom'];
const MAX_RECORDING_MESSAGES = 200000; // about 45 minutes of every stream at the bridge's rates

const recordingError = (text) => new Error(text);

function sortedByStamp(list) {
  return list
    .filter((message) => Number.isFinite(message?.stamp))
    .sort((a, b) => a.stamp - b.stamp);
}

// --- what a run was: lesson, conditions, robot, group, outcome --------------------------------

const UNKNOWN_CONDITIONS = '設定：不明';
const MAX_TEXT = 60; // characters kept of a label read from a file
const MAX_GROUP = 30;

const cleanText = (value, max = MAX_TEXT) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

// The words a lesson would have written, for conditions that came without a label.
function conditionsText(values) {
  if (Number.isFinite(values.speed)) return `${values.speed.toFixed(2)} m/s`;
  const gains = [
    ['P', values.kp],
    ['I', values.ki],
    ['D', values.kd],
  ].filter(([, value]) => Number.isFinite(value));
  return gains.map(([name, value]) => `${name} ${value}`).join('・');
}

/**
 * The lesson's conditions as stored in a recording: `{...numbers and short texts, label}`, or null.
 * A string (what drive.conditions() returned before it returned an object) becomes the label.
 */
function cleanConditions(value) {
  if (typeof value === 'string') return cleanText(value) ? { label: cleanText(value) } : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kept = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'label') continue;
    if (typeof item === 'number' && Number.isFinite(item)) kept[key] = item;
    else if (typeof item === 'string' || typeof item === 'boolean')
      kept[key] = typeof item === 'string' ? cleanText(item) : item;
  }
  const label = cleanText(value.label) || conditionsText(kept);
  if (!label && !Object.keys(kept).length) return null;
  return { ...kept, label };
}

function cleanRobot(value) {
  if (!value || typeof value !== 'object') return null;
  const name = cleanText(value.name);
  const domain = Number.isInteger(value.domain) ? value.domain : null;
  return name || domain !== null ? { name, domain } : null;
}

function cleanOutcome(value) {
  const reason = cleanText(value?.reason, 40);
  return reason ? { reason, label: cleanText(value.label) } : null;
}

/** The optional run fields of a recording, cleaned; empty ones are left out. */
function runInfo({ lesson, conditions, robot, group, outcome } = {}) {
  const info = {
    lesson: cleanText(lesson),
    conditions: cleanConditions(conditions),
    robot: cleanRobot(robot),
    group: cleanText(group, MAX_GROUP),
    outcome: cleanOutcome(outcome),
  };
  return Object.fromEntries(Object.entries(info).filter(([, value]) => value));
}

/**
 * `recording` with the given run fields (`lesson`, `conditions`, `robot`, `group`, `outcome`)
 * added or replaced; fields given as empty are left as they were.
 */
const withRunInfo = (recording, info) => ({ ...recording, ...runInfo(info) });

const pad = (number) => String(number).padStart(2, '0');

/** 「10:51:02」 in local time, or '' for a missing or broken date. */
function clockText(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * A short name for a recording that a reader (chart legend, table row, history) can show next to
 * others: 「0.20 m/s 10:51:02」, 「P 2.2・D 0.6 10:52:10」, with the group first when one was typed
 * (「3班 0.20 m/s 10:51:02」), and 「設定：不明 10:51:02」 for files saved before recordings carried
 * their conditions. The time is when the recording was made (local time, seconds included, so two
 * runs a minute apart never share a name).
 */
function recordingLabel(recording) {
  const conditions = cleanText(recording?.conditions?.label) || UNKNOWN_CONDITIONS;
  return [cleanText(recording?.group, MAX_GROUP), conditions, clockText(recording?.recordedAt)]
    .filter(Boolean)
    .join(' ');
}

/** A recording from its parts; streams not given are left out, the rest are sorted by stamp. */
function makeRecording({ source, name, recordedAt, config, topics = {}, streams, ...info }) {
  const kept = {};
  for (const stream of RECORDING_STREAMS)
    if (Array.isArray(streams[stream])) kept[stream] = sortedByStamp(streams[stream]);
  return {
    format: RECORDING_FORMAT,
    version: RECORDING_VERSION,
    source,
    name,
    recordedAt,
    config: { wheel_radius: config.wheel_radius, wheel_separation: config.wheel_separation },
    topics,
    streams: kept,
    ...runInfo(info),
  };
}

function checkConfig(config) {
  if (!config || !(config.wheel_radius > 0) || !(config.wheel_separation > 0))
    throw recordingError(
      '記録ファイルに車輪の寸法（wheel_radius・wheel_separation）がありません。',
    );
}

/** Read a saved recording back; throws an Error whose message can be shown to the learner. */
function parseRecording(text) {
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw recordingError(
      '記録ファイルを読み取れませんでした。この教材で保存したJSONを選んでください。',
    );
  }
  if (data?.format !== RECORDING_FORMAT)
    throw recordingError('QUESTiX LABの実機記録（questix-lab-recording）ではありません。');
  if (data.version !== RECORDING_VERSION)
    throw recordingError('この記録ファイルは、別の版の教材で保存されています。');
  checkConfig(data.config);
  const streams = data.streams && typeof data.streams === 'object' ? data.streams : {};
  let count = 0;
  for (const stream of RECORDING_STREAMS) {
    if (streams[stream] === undefined) continue;
    if (!Array.isArray(streams[stream]))
      throw recordingError(`記録ファイルの ${stream} が一覧になっていません。`);
    count += streams[stream].length;
  }
  if (count > MAX_RECORDING_MESSAGES)
    throw recordingError('記録が長すぎます。45分以内に区切って保存したものを使ってください。');
  return makeRecording({ ...data, streams });
}

const serializeRecording = (recording) => JSON.stringify(recording);

/** How long the recording is and how many messages each stream holds. */
function recordingSummary(recording) {
  const stamps = Object.values(recording.streams).flatMap((list) =>
    list.length ? [list[0].stamp, list[list.length - 1].stamp] : [],
  );
  const counts = Object.fromEntries(
    Object.entries(recording.streams).map(([stream, list]) => [stream, list.length]),
  );
  return {
    seconds: stamps.length ? Math.max(...stamps) - Math.min(...stamps) : 0,
    counts,
  };
}

/** The streams a lesson needs that the recording does not have (or has no message in). */
function missingInRecording(recording, needed) {
  return needed.filter((stream) => !recording.streams[stream]?.length);
}

/**
 * One sample per message of `trigger`, with the latest message of each `pair` stream whose stamp
 * is not after it attached — or null, when there is none within `freshSeconds`. Deciding what to
 * do with a missing partner is left to the lesson (a drive sample without a command is still a
 * measurement; a scan without wheel feedback is not).
 */
function pairByStamp(recording, trigger, pair = [], freshSeconds = Infinity) {
  const cursors = Object.fromEntries(pair.map((name) => [name, 0]));
  const samples = [];
  for (const message of recording.streams[trigger] ?? []) {
    const sample = { [trigger]: message };
    for (const name of pair) {
      const list = recording.streams[name] ?? [];
      while (cursors[name] < list.length && list[cursors[name]].stamp <= message.stamp)
        cursors[name] += 1;
      const latest = list[cursors[name] - 1];
      sample[name] = latest && message.stamp - latest.stamp <= freshSeconds ? latest : null;
    }
    samples.push(sample);
  }
  return samples;
}

// --- what the lessons take from a recording -------------------------------------------------

/**
 * The wheel rows of capture-core (`driveSamples`) with the command that was in force at each
 * /drive_status attached, and the conditions a lesson reports with them.
 */
function driveRows(recording) {
  const samples = pairByStamp(recording, 'drive', ['twist']);
  const rows = driveSamples(samples, recording.config);
  return { rows, summary: captureSummary(rows) };
}

/** The wall straight ahead, one row per scan (capture-core `distanceSamples`). */
const wallRows = (recording) => distanceSamples(recording.streams.scan ?? []);

/** The drives between stops, from /odom (capture-core `odomMoves`). */
const drivesOf = (recording) => odomMoves(recording.streams.odom ?? []);

// --- one time zero for every reader of a run ------------------------------------------------

const COMMAND_MOVING = 1e-3; // |command| above this asks the robot to move (m/s or rad/s)

/**
 * The robot-clock stamp every chart and table of a run counts time from: the first command that
 * asked the robot to move (the moment the page — or the controller — started it). The command
 * stream also carries zeros before that (twist_arbiter republishes), which must not count. Without
 * a moving command: the first command, else the first message of any stream, else 0.
 */
function commandZero(recording) {
  const commands = (recording.streams.twist ?? []).filter(
    (message) => Number.isFinite(message.linear) && Number.isFinite(message.angular),
  );
  const moving = commands.find(
    (message) =>
      Math.abs(message.linear) > COMMAND_MOVING || Math.abs(message.angular) > COMMAND_MOVING,
  );
  if (moving) return moving.stamp;
  if (commands.length) return commands[0].stamp;
  const stamps = Object.values(recording.streams).flatMap((list) =>
    list.length ? [list[0].stamp] : [],
  );
  return stamps.length ? Math.min(...stamps) : 0;
}

// --- CSV for a spreadsheet or a plotting tool ------------------------------------------------

// One row per message, all streams in one table ordered by time, so a spreadsheet can filter by
// the `stream` column and a plotting tool can draw any column against `time_s`. Units are in the
// header. Wheel speeds are forward-positive for both wheels, derived from the chassis velocity as
// the lessons do (the right motor's raw rpm is mirrored on the wire). The scan is reduced to the
// wall straight ahead (`front_m`), the number the lessons use; the full ranges stay in the JSON.
const isDrive = (stream) => stream === 'drive';
const isOdom = (stream) => stream === 'odom';
const moving = (stream) => isDrive(stream) || isOdom(stream);
const wheel = (message, config, side) =>
  Number.isFinite(message.v) && Number.isFinite(message.w)
    ? wheelRpm(message, config)[side].toFixed(2)
    : '';
const CSV_COLUMNS = [
  ['time_s', () => ''],
  ['stream', () => ''],
  ['stamp_s', (message) => message.stamp.toFixed(6)],
  ['v_mps', (message, stream) => (moving(stream) ? message.v : '')],
  ['w_radps', (message, stream) => (moving(stream) ? message.w : '')],
  [
    'left_rpm',
    (message, stream, config) => (isDrive(stream) ? wheel(message, config, 'left') : ''),
  ],
  [
    'right_rpm',
    (message, stream, config) => (isDrive(stream) ? wheel(message, config, 'right') : ''),
  ],
  ['left_current_a', (message, stream) => (isDrive(stream) ? message.left?.current_amp : '')],
  ['right_current_a', (message, stream) => (isDrive(stream) ? message.right?.current_amp : '')],
  ['emergency_stop', (message, stream) => (isDrive(stream) ? Number(message.emergency_stop) : '')],
  ['command_linear_mps', (message, stream) => (stream === 'twist' ? message.linear : '')],
  ['command_angular_radps', (message, stream) => (stream === 'twist' ? message.angular : '')],
  ['x_m', (message, stream) => (isOdom(stream) ? message.x : '')],
  ['y_m', (message, stream) => (isOdom(stream) ? message.y : '')],
  ['theta_rad', (message, stream) => (isOdom(stream) ? message.theta : '')],
  ['front_m', (message, stream) => (stream === 'scan' ? frontDistance(message) : '')],
];

const csvCell = (value) =>
  value === null || value === undefined || Number.isNaN(value) ? '' : String(value);

/** The recording as CSV text (UTF-8 BOM, so spreadsheet software reads the header correctly). */
function recordingCSV(recording) {
  const rows = Object.entries(recording.streams)
    .flatMap(([stream, list]) => list.map((message) => ({ stream, message })))
    .sort((a, b) => a.message.stamp - b.message.stamp);
  const start = rows.length ? rows[0].message.stamp : 0;
  const header = CSV_COLUMNS.map(([name]) => name).join(',');
  const lines = rows.map(({ stream, message }) =>
    [
      (message.stamp - start).toFixed(3),
      stream,
      ...CSV_COLUMNS.slice(2).map(([, cell]) => csvCell(cell(message, stream, recording.config))),
    ].join(','),
  );
  return '\uFEFF' + [header, ...lines].join('\n') + '\n';
}

// --- the run as a table, for a spreadsheet (what a learner hands in) ---------------------------

// One row per wheel measurement (or per scan, for a LiDAR-only recording), time counted from the
// first moving command (commandZero, as in the run report), Japanese headers with units, and the
// conditions of the run above the table. The full per-message CSV (recordingCSV) stays available.
const TABLE_FRESH = 0.5; // s: a command, pose or scan older than this is not attached to a row
const TABLE_COLUMNS = [
  '時間（指令からの秒）',
  '指令の速さ（m/秒）',
  '実測の速さ（m/秒）',
  '指令の回転の速さ（rad/秒）',
  '実測の回転の速さ（rad/秒）',
  '左車輪の実測（rpm）',
  '右車輪の実測（rpm）',
  '走った距離（m）',
  '正面の壁までの距離（m）',
  '非常停止',
];

// A cell in quotes when needed (a group name or a label may hold a comma).
function csvText(value) {
  const text = csvCell(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const digits = (value, count) => (Number.isFinite(value) ? value.toFixed(count) : '');

// Distance along /odom up to each message, keyed by the message itself.
function odomDistances(odoms) {
  const distances = new Map();
  let total = 0;
  odoms.forEach((message, index) => {
    const before = odoms[index - 1];
    if (before && [message.x, message.y, before.x, before.y].every(Number.isFinite))
      total += Math.hypot(message.x - before.x, message.y - before.y);
    distances.set(message, total);
  });
  return distances;
}

const tableTrigger = (recording) =>
  ['drive', 'scan', 'odom'].find((name) => recording.streams[name]?.length) ?? null;

function tableRow(sample, trigger, zero, config, distances) {
  const drive = sample.drive ?? null;
  const measured = drive && Number.isFinite(drive.v) && Number.isFinite(drive.w);
  const wheels = measured ? wheelRpm(drive, config) : null;
  const front = sample.scan ? frontDistance(sample.scan) : null;
  return [
    digits(sample[trigger].stamp - zero, 3),
    digits(sample.twist?.linear, 3),
    measured ? digits(drive.v, 3) : '',
    digits(sample.twist?.angular, 3),
    measured ? digits(drive.w, 3) : '',
    wheels ? digits(wheels.left, 1) : '',
    wheels ? digits(wheels.right, 1) : '',
    sample.odom ? digits(distances.get(sample.odom), 3) : '',
    digits(front, 3),
    drive?.emergency_stop ? '押されていた' : '',
  ].join(',');
}

/** 「key,value」 lines above the table: what a reader needs to tell this run from another. */
function tableHeading(recording) {
  const lines = [
    ['教材', recording.lesson],
    ['条件', recording.conditions?.label || UNKNOWN_CONDITIONS],
    ['ロボット', recording.robot?.name],
    ['班', recording.group],
    ['記録した時刻', recording.recordedAt],
    ['終わり方', recording.outcome?.label],
    ['時間の0', '最初に走る指令が出た時刻'],
  ];
  return lines.filter(([, value]) => value).map(([key, value]) => `${key},${csvText(value)}`);
}

/** The run as a tidy table (UTF-8 BOM): conditions lines, a blank line, then one row per sample. */
function recordingTableCSV(recording) {
  const trigger = tableTrigger(recording);
  const zero = commandZero(recording);
  const pair = ['twist', 'odom', 'scan'].filter((name) => name !== trigger);
  const samples = trigger ? pairByStamp(recording, trigger, pair, TABLE_FRESH) : [];
  const distances = odomDistances(recording.streams.odom ?? []);
  const rows = samples.map((sample) =>
    tableRow(sample, trigger, zero, recording.config, distances),
  );
  const lines = [...tableHeading(recording), '', TABLE_COLUMNS.join(','), ...rows];
  return '﻿' + lines.join('\n') + '\n';
}

// --- file names ---------------------------------------------------------------------------------

function fileStamp(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return 'recording';
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

// Characters no file system minds, so a group name in Japanese stays readable.
const filePart = (text, max = 24) =>
  String(text ?? '')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max);

/** A few characters for the conditions in a file name: 0.20mps, P2.2-I0-D0.6, 50cm. */
function conditionsToken(conditions) {
  if (!conditions) return '';
  if (Number.isFinite(conditions.speed)) return `${conditions.speed.toFixed(2)}mps`;
  const gains = [
    ['P', conditions.kp],
    ['I', conditions.ki],
    ['D', conditions.kd],
  ].filter(([, value]) => Number.isFinite(value));
  if (gains.length) return gains.map(([name, value]) => `${name}${value}`).join('-');
  const label = conditions.label.replace(/\s+/g, '').replaceAll('・', '-').replaceAll('/', 'p');
  return filePart(label, 20);
}

const FILE_KINDS = {
  json: {
    suffix: '.json',
    type: 'application/json',
    text: (recording) => serializeRecording(recording),
  },
  csv: {
    suffix: '.csv',
    type: 'text/csv;charset=utf-8',
    text: (recording) => recordingTableCSV(recording),
  },
  'raw-csv': {
    suffix: '-messages.csv',
    type: 'text/csv;charset=utf-8',
    text: (recording) => recordingCSV(recording),
  },
};

/**
 * File name and contents for saving `recording`: `kind` 'json' (opens again in this material),
 * 'csv' (the tidy table, recordingTableCSV) or 'raw-csv' (every message, recordingCSV). One name
 * scheme for every place that saves a run:
 * QUESTiX-LAB-<lesson>-<group>-<robot>-<conditions>-<yyyymmdd-hhmmss>, parts left out when unknown.
 * `lesson` is used when the recording does not say which lesson it was made for.
 */
function recordingFile(recording, lesson, kind = 'json') {
  const parts = [
    'QUESTiX-LAB',
    filePart(recording.lesson || lesson, 40),
    filePart(recording.group),
    filePart(recording.robot?.name),
    conditionsToken(recording.conditions),
    fileStamp(recording.recordedAt),
  ].filter(Boolean);
  const format = FILE_KINDS[kind] ?? FILE_KINDS.json;
  return { name: parts.join('-') + format.suffix, text: format.text(recording), type: format.type };
}

export {
  UNKNOWN_CONDITIONS,
  cleanConditions,
  runInfo,
  withRunInfo,
  clockText,
  recordingLabel,
  commandZero,
  recordingTableCSV,
  recordingFile,
  RECORDING_FORMAT,
  RECORDING_VERSION,
  RECORDING_STREAMS,
  makeRecording,
  parseRecording,
  serializeRecording,
  recordingSummary,
  missingInRecording,
  pairByStamp,
  driveRows,
  wallRows,
  drivesOf,
  recordingCSV,
};
