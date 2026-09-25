// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
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
