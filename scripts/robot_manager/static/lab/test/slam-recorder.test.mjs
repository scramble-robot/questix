// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { wheelRpm, buildSlamLog, slamLogFromRecording } from '../js/live/slam-recorder.js';
import { makeRecording } from '../js/live/recording-core.js';
import { validateSlamLog } from '../js/slam/engine.js';

const config = { wheel_radius: 0.1, wheel_separation: 0.5 };
const scan = (stamp) => ({
  stamp,
  angle_min: -Math.PI,
  angle_increment: (2 * Math.PI) / 36,
  range_max: 8,
  ranges: Array.from({ length: 36 }, (_, i) =>
    i % 9 === 0 ? null : i % 5 === 0 ? 9.5 : 1 + i / 36,
  ),
});

test('wheelRpm is forward-positive for both wheels', () => {
  const straight = wheelRpm({ v: 0.2, w: 0 }, config);
  assert.ok(straight.left > 0 && Math.abs(straight.left - straight.right) < 1e-9);
  assert.ok(Math.abs(straight.left - (0.2 / (2 * Math.PI * 0.1)) * 60) < 1e-9);
  const turnLeft = wheelRpm({ v: 0, w: 1 }, config); // counter-clockwise: right wheel forward
  assert.ok(turnLeft.right > 0 && turnLeft.left < 0);
});

test('a recording passes the same validation as an uploaded log', () => {
  const samples = Array.from({ length: 12 }, (_, i) => ({
    scan: scan(100 + i * 0.2),
    drive: { v: i < 3 ? 0 : 0.15, w: 0.1 },
  }));
  const { log, moved } = buildSlamLog(samples, config);
  assert.equal(moved, true);
  assert.equal(log.frames.length, 11);
  assert.ok(log.frames[0].t > 0);
  assert.equal(log.frames[0].ranges[5], null, 'readings beyond rangeMax become null');
  const parsed = validateSlamLog(log);
  assert.equal(parsed.source, 'hardware');
  assert.equal(parsed.config.track, 0.5);
});

test('out-of-order scans are skipped and short recordings rejected', () => {
  const samples = [100, 100.2, 100.1, 100.4, 100.6].map((s) => ({
    scan: scan(s),
    drive: { v: 0, w: 0 },
  }));
  assert.equal(buildSlamLog(samples, config).log.frames.length, 3);
  assert.throws(() => buildSlamLog(samples.slice(0, 2), config));
  assert.throws(() => buildSlamLog(samples, { wheel_radius: 0, wheel_separation: 0.5 }));
});

test('a saved recording becomes a SLAM log, scans paired with the wheels by stamp', () => {
  const recording = makeRecording({
    source: 'live',
    name: '',
    recordedAt: '2026-09-25T01:00:00.000Z',
    config,
    streams: {
      scan: Array.from({ length: 8 }, (_, i) => scan(100 + i * 0.2)),
      drive: Array.from({ length: 16 }, (_, i) => ({ stamp: 100 + i * 0.1, v: 0.15, w: 0 })),
    },
  });
  const { log, moved } = slamLogFromRecording(recording);
  assert.equal(moved, true);
  assert.equal(log.frames.length, 7);
  const noWheels = makeRecording({ ...recording, streams: { scan: recording.streams.scan } });
  assert.throws(() => slamLogFromRecording(noWheels), /drive_status/);
});
