// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  makeRecording,
  parseRecording,
  serializeRecording,
  recordingSummary,
  missingInRecording,
  pairByStamp,
  driveRows,
  recordingCSV,
  cleanConditions,
  withRunInfo,
  recordingLabel,
  commandZero,
  recordingTableCSV,
  recordingFile,
  RECORDING_STREAMS,
  RECORDING_VERSION,
} from '../js/live/recording-core.js';

const config = { wheel_radius: 0.1, wheel_separation: 0.5 };

// Messages as questix_lab_bridge sends them.
const drive = (stamp, v) => ({
  type: 'drive',
  stamp,
  left: { rpm: 0, current_amp: 0.1 },
  right: { rpm: 0, current_amp: 0.2 },
  v,
  w: 0,
  emergency_stop: false,
});
const twist = (stamp, linear) => ({ type: 'twist', stamp, linear, angular: 0 });
const odom = (stamp, x) => ({ type: 'odom', stamp, x, y: 0, theta: 0, v: 0, w: 0 });

function sample() {
  return makeRecording({
    source: 'live',
    name: '',
    recordedAt: '2026-09-23T01:02:03.000Z',
    config,
    topics: { drive: '/drive_status', twist: '/target_twist' },
    // deliberately out of order: arrival order must not matter
    streams: {
      drive: [drive(10.1, 0.2), drive(10.0, 0), drive(12.0, 0.2)],
      twist: [twist(10.05, 0.2), twist(9.9, 0)],
      odom: [odom(10.0, 0)],
    },
  });
}

test('a recording keeps each stream sorted by stamp', () => {
  const recording = sample();
  assert.deepEqual(
    recording.streams.drive.map((message) => message.stamp),
    [10.0, 10.1, 12.0],
  );
  assert.equal(recording.streams.scan, undefined);
  assert.deepEqual(missingInRecording(recording, ['drive', 'scan']), ['scan']);
});

test('a saved recording reads back identically', () => {
  const recording = sample();
  assert.deepEqual(parseRecording(serializeRecording(recording)), recording);
  // A BOM written by another tool is accepted.
  assert.deepEqual(parseRecording('﻿' + serializeRecording(recording)), recording);
});

test('files that are not a recording are refused with a sentence for the learner', () => {
  assert.throws(() => parseRecording('x,y,test'), /JSON/);
  assert.throws(() => parseRecording('{"format":"robo-lab-sensors-v1"}'), /questix-lab-recording/);
  const other = { ...sample(), version: 99 };
  assert.throws(() => parseRecording(JSON.stringify(other)), /別の版/);
  const noConfig = { ...sample(), config: {} };
  assert.throws(() => parseRecording(JSON.stringify(noConfig)), /車輪の寸法/);
  const badStream = { ...sample(), streams: { drive: 'many' } };
  assert.throws(() => parseRecording(JSON.stringify(badStream)), /drive/);
});

test('pairByStamp attaches the latest partner that is not after the sample', () => {
  const samples = pairByStamp(sample(), 'drive', ['twist'], 1);
  assert.deepEqual(
    samples.map((entry) => entry.twist?.stamp ?? null),
    [9.9, 10.05, null], // 12.0 - 10.05 is older than one second
  );
});

test('driveRows pairs the command in force with each wheel measurement', () => {
  const { rows, summary } = driveRows(sample());
  assert.equal(rows.length, 3);
  assert.equal(rows[0].commandRpm, 0);
  assert.ok(rows[1].commandRpm > 0);
  assert.ok(Number.isNaN(rows[2].commandRpm));
  assert.equal(summary.moved, true);
});

test('the summary covers every stream', () => {
  const summary = recordingSummary(sample());
  assert.ok(Math.abs(summary.seconds - 2.1) < 1e-9);
  assert.deepEqual(summary.counts, { drive: 3, twist: 2, odom: 1 });
});

test('the CSV has one row per message in time order, with units in the header', () => {
  const lines = recordingCSV(sample()).replace(/^﻿/, '').trim().split('\n');
  const header = lines[0].split(',');
  assert.deepEqual(header.slice(0, 3), ['time_s', 'stream', 'stamp_s']);
  assert.ok(header.includes('left_rpm') && header.includes('front_m'));
  assert.equal(lines.length, 1 + 6);
  const rows = lines.slice(1).map((line) => line.split(','));
  assert.deepEqual(
    rows.map((row) => row[1]),
    ['twist', 'drive', 'odom', 'twist', 'drive', 'drive'],
  );
  assert.equal(rows[0][0], '0.000');
  const moving = rows[4];
  const leftRpm = Number(moving[header.indexOf('left_rpm')]);
  assert.ok(Math.abs(leftRpm - (0.2 / (2 * Math.PI * 0.1)) * 60) < 0.01);
  // Columns that do not belong to a stream stay empty.
  assert.equal(rows[0][header.indexOf('left_rpm')], '');
});

// --- what a run was (lesson, conditions, robot, group, outcome) ------------------------------

const localTime = (hours, minutes, seconds) =>
  new Date(2026, 8, 25, hours, minutes, seconds).toISOString();

test('conditions from a lesson become numbers plus a label; a string becomes the label', () => {
  assert.deepEqual(cleanConditions({ speed: 0.2, label: '0.20 m/s' }), {
    speed: 0.2,
    label: '0.20 m/s',
  });
  assert.deepEqual(cleanConditions('P 2.2・I 0・D 0.6'), { label: 'P 2.2・I 0・D 0.6' });
  // Without a label the usual words are made; anything that is not a number or text is dropped.
  assert.deepEqual(cleanConditions({ kp: 2.2, ki: 0, kd: 0.6, stop: 0.5, bad: {} }), {
    kp: 2.2,
    ki: 0,
    kd: 0.6,
    stop: 0.5,
    label: 'P 2.2・I 0・D 0.6',
  });
  assert.equal(cleanConditions(null), null);
  assert.equal(cleanConditions(''), null);
  // The control lesson's object carries a non-enumerable toString() for string readers.
  const control = { kp: 2.2, ki: 0, kd: 0.6, stop: 0.5, label: 'P 2.2・I 0・D 0.6' };
  Object.defineProperty(control, 'toString', { value: () => control.label });
  assert.deepEqual(cleanConditions(control), { ...control });
  assert.equal(JSON.stringify(cleanConditions(control)).includes('toString'), false);
});

test('run fields are written into a recording and survive saving and opening again', () => {
  const recording = withRunInfo(sample(), {
    lesson: 'control-speed',
    conditions: { speed: 0.2, label: '0.20 m/s' },
    robot: { name: 'questix-03', domain: 3 },
    group: ' 3班 ',
    outcome: { reason: 'done', label: '予定どおり走り終えた' },
  });
  assert.equal(recording.group, '3班');
  assert.deepEqual(recording.robot, { name: 'questix-03', domain: 3 });
  const reopened = parseRecording(serializeRecording(recording));
  assert.deepEqual(reopened, recording);
  // Empty fields are left out rather than stored as blanks.
  const bare = withRunInfo(sample(), { group: '', robot: null, conditions: undefined });
  assert.equal('group' in bare, false);
  assert.equal('robot' in bare, false);
  // A file of the old format has none of them and still opens.
  assert.equal(parseRecording(serializeRecording(sample())).conditions, undefined);
});

test('recordingLabel names a run by its conditions and time, and says when they are unknown', () => {
  const at = localTime(10, 51, 2);
  const speed = withRunInfo({ ...sample(), recordedAt: at }, { conditions: { speed: 0.2 } });
  assert.equal(recordingLabel(speed), '0.20 m/s 10:51:02');
  const gains = withRunInfo(
    { ...sample(), recordedAt: localTime(10, 52, 10) },
    { conditions: { kp: 2.2, kd: 0.6, label: 'P 2.2・D 0.6' }, group: '3班' },
  );
  assert.equal(recordingLabel(gains), '3班 P 2.2・D 0.6 10:52:10');
  assert.equal(recordingLabel({ ...sample(), recordedAt: at }), '設定：不明 10:51:02');
  assert.equal(recordingLabel({ recordedAt: 'broken' }), '設定：不明');
});

test('time counts from the first command that asks the robot to move', () => {
  assert.equal(commandZero(sample()), 10.05);
  const still = makeRecording({ ...sample(), streams: { twist: [twist(9.9, 0)], drive: [] } });
  assert.equal(commandZero(still), 9.9);
  const none = makeRecording({ ...sample(), streams: { drive: [drive(10.0, 0)] } });
  assert.equal(commandZero(none), 10.0);
});

test('the tidy CSV starts with the conditions and has one row per wheel measurement', () => {
  const recording = withRunInfo(sample(), {
    lesson: 'control-speed',
    conditions: { speed: 0.2, label: '0.20 m/s' },
    group: '3班, 2年',
  });
  const lines = recordingTableCSV(recording).replace(/^﻿/, '').trim().split('\n');
  assert.equal(lines[0], '教材,control-speed');
  assert.equal(lines[1], '条件,0.20 m/s');
  assert.ok(lines.includes('班,"3班, 2年"'));
  const header = lines.indexOf('') + 1;
  assert.equal(lines[header].split(',')[0], '時間（指令からの秒）');
  const rows = lines.slice(header + 1).map((line) => line.split(','));
  assert.deepEqual(
    rows.map((row) => row[0]),
    ['-0.050', '0.050', '1.950'],
  );
  // command in force (fresh within 0.5 s), measured speed, distance along /odom
  assert.equal(rows[1][1], '0.200');
  assert.equal(rows[1][2], '0.200');
  assert.equal(rows[2][1], '');
  assert.equal(rows[0][7], '0.000');
  // An old file says its conditions are unknown.
  assert.ok(recordingTableCSV(sample()).includes('条件,設定：不明'));
});

test('saved files are named after lesson, group, robot, conditions and time', () => {
  const recording = withRunInfo(
    { ...sample(), recordedAt: localTime(10, 51, 2) },
    {
      lesson: 'control-speed',
      group: '3班',
      robot: { name: 'questix 03' },
      conditions: { speed: 0.2 },
    },
  );
  assert.equal(
    recordingFile(recording, 'other', 'json').name,
    'QUESTiX-LAB-control-speed-3班-questix_03-0.20mps-20260925-105102.json',
  );
  assert.ok(recordingFile(recording, 'other', 'csv').name.endsWith('-105102.csv'));
  assert.ok(recordingFile(recording, 'other', 'raw-csv').text.includes('time_s,stream'));
  const gains = withRunInfo(recording, { conditions: { kp: 2.2, ki: 0, kd: 0.6 } });
  assert.ok(recordingFile(gains, 'x').name.includes('-P2.2-I0-D0.6-'));
  // An old file: the lesson given by the caller, nothing else.
  assert.equal(
    recordingFile({ ...sample(), recordedAt: localTime(9, 0, 0) }, 'bench', 'json').name,
    'QUESTiX-LAB-bench-20260925-090000.json',
  );
});

// --- the launcher's statuses (roller, shot), optional streams since 2026-09 --------------------

const roller = (stamp, command, source = 'lab') => ({
  type: 'roller',
  stamp,
  command,
  source,
  lab_accepted: true,
  lab_locked: false,
  estop: false,
});
const shot = (stamp, count, tilt = 30) => ({
  type: 'shot',
  stamp,
  tilt_deg: tilt,
  shooting: false,
  fired_count: count,
  last_fire_source: 'lab',
});

test("a recording keeps the launcher's roller and shot statuses, and older files stay valid", () => {
  const launcher = makeRecording({
    ...sample(),
    streams: {
      drive: [drive(10.0, 0)],
      roller: [roller(10.4, 0.5), roller(10.2, 0.5)],
      shot: [shot(10.3, 1)],
    },
  });
  assert.deepEqual(
    launcher.streams.roller.map((message) => message.stamp),
    [10.2, 10.4],
  );
  assert.deepEqual(parseRecording(serializeRecording(launcher)), launcher);
  assert.deepEqual(recordingSummary(launcher).counts, { drive: 1, roller: 2, shot: 1 });
  // A file written before the launcher streams existed reads back unchanged.
  const old = sample();
  assert.equal(parseRecording(serializeRecording(old)).streams.roller, undefined);
  const broken = { ...sample(), streams: { roller: 'many' } };
  assert.throws(() => parseRecording(JSON.stringify(broken)), /roller が一覧/);
});

test('the per-message CSV has columns for the roller command and the tilt', () => {
  const launcher = makeRecording({
    ...sample(),
    streams: { roller: [roller(1.0, 0.5, 'joy,"x')], shot: [shot(1.1, 3, 42.5)] },
  });
  const lines = recordingCSV(launcher).replace(/^﻿/, '').trim().split('\n');
  const header = lines[0].split(',');
  const rows = lines.slice(1).map((line) => line.split(','));
  assert.equal(rows[0][header.indexOf('roller_command')], '0.5');
  assert.equal(rows[0][header.indexOf('roller_source')], '', 'an odd word is left out');
  assert.equal(rows[1][header.indexOf('tilt_deg')], '42.5');
  assert.equal(rows[1][header.indexOf('fired_count')], '3');
  assert.equal(rows[1][header.indexOf('shooting')], '0');
  assert.ok(rows.every((row) => row.length === header.length));
});

// --- wheel-level authority, the authoritative E-stop, and v1 compatibility ---------------------

const wheelDrive = (stamp, filtered) => ({
  type: 'drive',
  stamp,
  bridge_stamp: stamp + 0.001,
  left: {
    rpm: filtered,
    rpm_raw: filtered + 2,
    target_rpm: filtered + 1,
    current_amp: 0.1,
    feedback_stamp: stamp - 0.02,
    feedback_age_sec: 0.02,
    feedback_valid: true,
  },
  right: {
    rpm: -filtered,
    rpm_raw: -(filtered + 2),
    target_rpm: -(filtered + 1),
    current_amp: 0.2,
    feedback_stamp: null,
    feedback_age_sec: null,
    feedback_valid: false,
  },
  v: 0.3,
  w: 0,
  emergency_stop: false,
});
const estop = (stamp, active) => ({
  type: 'estop',
  stamp,
  bridge_stamp: stamp + 0.001,
  active,
  source: 'operation_manager',
  reason: active ? 'pin 5 is true' : 'released',
});

test('the robot keeps exactly the streams a page records (records.py RECORDING_STREAMS)', () => {
  const source = fs.readFileSync(
    new URL('../../../../../questix_lab_bridge/questix_lab_bridge/records.py', import.meta.url),
    'utf8',
  );
  const python = source.match(/^RECORDING_STREAMS = \(([^)]*)\)/m)[1];
  const names = [...python.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  assert.deepEqual(names, RECORDING_STREAMS);
  assert.equal(Number(source.match(/^RECORDING_VERSION = (\d+)/m)[1]), RECORDING_VERSION);
  assert.ok(RECORDING_STREAMS.includes('estop') && RECORDING_STREAMS.includes('roller'));
});

test('a new recording with the E-stop stream and wheel fields saves and opens again', () => {
  const recording = makeRecording({
    ...sample(),
    streams: { drive: [wheelDrive(10.0, 30)], estop: [estop(9.9, false), estop(10.2, true)] },
  });
  assert.equal(recording.version, 1); // optional additions only
  const back = parseRecording(serializeRecording(recording));
  assert.deepEqual(back, recording);
  assert.equal(back.streams.estop.length, 2);
  assert.equal(back.streams.drive[0].right.rpm, -30); // native sign kept in the JSON
  assert.equal(back.streams.drive[0].right.feedback_stamp, null);
});

test('an older v1 recording (no E-stop stream, no wheel fields) still opens and reads', () => {
  const old = JSON.parse(serializeRecording(sample()));
  delete old.streams.estop;
  const back = parseRecording(JSON.stringify(old));
  assert.equal(back.streams.estop, undefined);
  const { rows } = driveRows(back);
  assert.ok(rows.length > 0 && rows.every((row) => row.authority === 'legacy'));
});

test('the per-message CSV adds the native wheel values and the authoritative E-stop at the end', () => {
  const recording = makeRecording({
    ...sample(),
    streams: { drive: [wheelDrive(10.0, 30), drive(10.1, 0.2)], estop: [estop(9.9, true)] },
  });
  const lines = recordingCSV(recording)
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\n');
  const header = lines[0].split(',');
  const added = [
    'left_target_rpm_native',
    'right_target_rpm_native',
    'left_raw_rpm_native',
    'right_raw_rpm_native',
    'left_filtered_rpm_native',
    'right_filtered_rpm_native',
    'left_feedback_stamp_s',
    'right_feedback_stamp_s',
    'left_feedback_age_s',
    'right_feedback_age_s',
    'estop_authoritative',
  ];
  assert.deepEqual(header.slice(-added.length), added);
  assert.equal(header.indexOf('fired_count'), header.length - added.length - 1);
  const rows = lines.slice(1).map((line) => line.split(','));
  const cell = (row, name) => row[header.indexOf(name)];
  const [estopRow, newDrive, oldDrive] = rows;
  assert.equal(cell(estopRow, 'estop_authoritative'), '1');
  assert.equal(cell(newDrive, 'left_filtered_rpm_native'), '30');
  assert.equal(cell(newDrive, 'right_filtered_rpm_native'), '-30');
  assert.equal(cell(newDrive, 'right_raw_rpm_native'), '-32');
  assert.equal(cell(newDrive, 'right_target_rpm_native'), '-31');
  assert.equal(cell(newDrive, 'left_feedback_stamp_s'), '9.980000');
  assert.equal(cell(newDrive, 'right_feedback_stamp_s'), ''); // never received
  assert.equal(cell(newDrive, 'right_feedback_age_s'), '');
  assert.equal(cell(newDrive, 'estop_authoritative'), '');
  assert.equal(cell(oldDrive, 'left_filtered_rpm_native'), '0'); // the older fixture's rpm: 0
  assert.equal(cell(oldDrive, 'left_feedback_stamp_s'), '');
  assert.ok(rows.every((row) => row.length === header.length));
});
