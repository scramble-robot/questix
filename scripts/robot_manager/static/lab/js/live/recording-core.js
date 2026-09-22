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

/** A recording from its parts; streams not given are left out, the rest are sorted by stamp. */
function makeRecording({ source, name, recordedAt, config, topics = {}, streams }) {
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

export {
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
