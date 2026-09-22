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
