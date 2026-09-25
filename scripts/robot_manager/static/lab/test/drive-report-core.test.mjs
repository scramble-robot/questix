// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// The report of one driving run (js/live/drive-report-core.js), from made-up recordings.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  driveReport,
  isEmptyRun,
  runStatusKind,
  runStatusKey,
  benchCheck,
  describeTurn,
  describeOffset,
  describeTurnRate,
} from '../js/live/drive-report-core.js';
import { loadJson } from '../js/core/content.js';

const copy = await loadJson('content/live/drive-report.json');

// A robot that follows its command with a first-order lag, starting at (x0, y0) facing theta0.
// Commands: 0.2 m/s from t = 1 s to t = 4 s, then 0 until 6 s.
function straightRun({ x0 = 5, y0 = -2, theta0 = Math.PI / 2, t0 = 100 } = {}) {
  const twist = [];
  const drive = [];
  const odom = [];
  let v = 0;
  let travelled = 0;
  for (let step = 0; step <= 300; step++) {
    const t = step * 0.02;
    const command = t >= 1 && t < 4 ? 0.2 : 0;
    if (step % 2 === 0) twist.push({ stamp: t0 + t, linear: t >= 0 ? command : 0, angular: 0 });
    v += ((command - v) * 0.02) / 0.15;
    travelled += v * 0.02;
    drive.push({ stamp: t0 + t, v, w: 0, emergency_stop: false });
    odom.push({
      stamp: t0 + t,
      x: x0 + travelled * Math.cos(theta0),
      y: y0 + travelled * Math.sin(theta0),
      theta: theta0,
    });
  }
  return { config: { wheel_radius: 0.1, wheel_separation: 0.5 }, streams: { twist, drive, odom } };
}

test('time starts at the first moving command and the path starts at the origin facing forward', () => {
  const report = driveReport(straightRun());
  // Zero commands came from t = 0 s, the first 0.2 m/s at 1 s: that is the report's zero (the same
  // as the lesson charts and the saved table), so the waiting before it has negative times.
  assert.ok(Math.abs(report.series.command[0].t + 1) < 1e-9);
  // (the series is thinned to one command per 0.05 s)
  const firstMoving = report.series.command.find((sample) => sample.v > 0).t;
  assert.ok(firstMoving >= 0 && firstMoving < 0.05, `first moving command at ${firstMoving}`);
  const { path } = report.series;
  assert.deepEqual([path[0].x, path[0].y], [0, 0]);
  // The robot faced +y in the odom frame; in the report it drives straight ahead (+x).
  const end = path[path.length - 1];
  assert.ok(end.x > 0.55 && end.x < 0.65, `forward ${end.x}`);
  assert.ok(Math.abs(end.y) < 1e-9, `left ${end.y}`);
});

test('the summary gives distance, peak speed and how the robot stopped', () => {
  const { summary } = driveReport(straightRun());
  assert.ok(Math.abs(summary.distance - 0.6) < 0.02, `distance ${summary.distance}`);
  assert.ok(Math.abs(summary.maxSpeed - 0.2) < 0.005);
  assert.equal(summary.maxCommand, 0.2);
  assert.ok(Math.abs(summary.turn) < 1e-9);
  assert.equal(summary.emergencyStop, false);
  assert.equal(summary.closest, null);
  // The stop command came 3 s after the first moving one; a 0.15 s lag needs about 0.35 s to fall
  // below 0.02 m/s.
  assert.ok(Math.abs(summary.stop.at - 3) < 0.05, `stop at ${summary.stop.at}`);
  assert.ok(summary.stop.delay > 0.2 && summary.stop.delay < 0.5, `delay ${summary.stop.delay}`);
  assert.ok(summary.stop.distance > 0.01 && summary.stop.distance < 0.05);
});

test('a run that never commanded motion has no stop, and missing streams leave gaps', () => {
  const report = driveReport({
    config: { wheel_radius: 0.1, wheel_separation: 0.5 },
    streams: { twist: [{ stamp: 1, linear: 0, angular: 0 }], drive: [], odom: [] },
  });
  assert.equal(report.summary.stop, null);
  assert.equal(report.summary.forward, null);
  assert.deepEqual(report.series.path, []);
});

test('a robot still moving at the end of the recording has not stopped', () => {
  const recording = straightRun();
  recording.streams.drive = recording.streams.drive.map((message) => ({ ...message, v: 0.2 }));
  assert.equal(driveReport(recording).summary.stop, null);
});

test('turns are unwrapped across ±180°', () => {
  const odom = [];
  for (let step = 0; step <= 40; step++)
    odom.push({
      stamp: step * 0.1,
      x: 0,
      y: 0,
      theta: Math.atan2(Math.sin(3 + step * 0.1), Math.cos(3 + step * 0.1)),
    });
  const report = driveReport({
    config: { wheel_radius: 0.1, wheel_separation: 0.5 },
    streams: { odom, twist: [], drive: [] },
  });
  assert.ok(Math.abs(report.summary.turn - 4) < 1e-9, `turn ${report.summary.turn}`);
});

test('the wall ahead is reported when the LiDAR saw one', () => {
  const scan = (stamp, distance) => ({
    stamp,
    angle_min: -0.1,
    angle_increment: 0.01,
    mount: { x: 0, y: 0, yaw: 0 },
    ranges: new Array(21).fill(distance),
  });
  const recording = straightRun();
  recording.streams.scan = [scan(100, 1.5), scan(102, 0.8), scan(104, 0.52)];
  const report = driveReport(recording);
  assert.equal(report.summary.closest, 0.52);
  assert.deepEqual(
    report.series.front.map((sample) => sample.d),
    [1.5, 0.8, 0.52],
  );
});

test('the kept series are thinned for storage', () => {
  const report = driveReport(straightRun());
  assert.ok(report.series.measured.length <= 62, `${report.series.measured.length} samples`);
  assert.ok(report.series.path.length < 100);
});

test('the drive time runs from the first moving command to the zero command after the last', () => {
  const { summary } = driveReport(straightRun());
  // Commands 0.2 m/s from 1 s to 4 s, sent every 0.04 s; the recording goes on until 6 s, which is
  // 5 s after the first moving command.
  assert.ok(Math.abs(summary.driveSeconds - 3) < 0.05, `drive ${summary.driveSeconds}`);
  assert.ok(Math.abs(summary.seconds - 5) < 1e-9, `recording ${summary.seconds}`);
});

test('a run that never moved is empty; a pure turn on the spot is not', () => {
  const still = straightRun();
  still.streams.twist = still.streams.twist.map((message) => ({ ...message, linear: 0 }));
  still.streams.drive = still.streams.drive.map((message) => ({ ...message, v: 0 }));
  still.streams.odom = still.streams.odom.map((message) => ({ ...message, x: 5, y: -2 }));
  assert.equal(driveReport(still).summary.moved, false);
  assert.equal(isEmptyRun(still), true);
  assert.equal(isEmptyRun(straightRun()), false);

  const spin = { config: {}, streams: { twist: [], drive: [], odom: [] } };
  for (let step = 0; step <= 20; step++)
    spin.streams.odom.push({ stamp: step * 0.1, x: 1, y: 1, theta: step * 0.05 });
  const { summary } = driveReport(spin);
  assert.ok(summary.distance < 0.01);
  assert.equal(summary.moved, true);
});

test('a commanded run counts as moved even when the wheels did not turn', () => {
  const blocked = straightRun();
  blocked.streams.odom = blocked.streams.odom.map((message) => ({ ...message, x: 5, y: -2 }));
  assert.equal(isEmptyRun(blocked), false);
});

test('turns and end positions are worded by their sign', () => {
  assert.equal(describeTurn((43 * Math.PI) / 180, copy), '左へ43°');
  assert.equal(describeTurn((-12.4 * Math.PI) / 180, copy), '右へ12°');
  assert.equal(describeTurn(0.001, copy), '0°');
  assert.equal(describeTurn(null, copy), '—');
  assert.equal(describeOffset(0.6, -0.012, copy), '前へ 60.0 cm・右へ 1.2 cm');
  assert.equal(describeOffset(-0.283, 0.087, copy), '後ろへ 28.3 cm・左へ 8.7 cm');
  assert.equal(describeOffset(0, 0.0001, copy), '前後 0 cm・左右 0 cm');
  assert.equal(describeOffset(null, null, copy), '—');
  assert.equal(describeTurnRate(0.5, copy), '0.50 rad/s（約29°/秒）');
});

test('run endings sort into ok, stopped and problem', () => {
  assert.equal(runStatusKind('done'), 'ok');
  for (const reason of ['stopped', 'stopped_other', 'hidden'])
    assert.equal(runStatusKind(reason), 'stopped', reason);
  for (const reason of ['timeout', 'lost', 'emergency_stop', 'other_publisher', 'failed'])
    assert.equal(runStatusKind(reason), 'problem', reason);
  assert.equal(runStatusKind(''), 'stopped');
  // A hand on the controller is a stop, not a problem, and has words of its own.
  assert.equal(runStatusKind('controller'), 'stopped');
  assert.equal(runStatusKey('controller'), 'controller');
  assert.equal(runStatusKey('lost'), 'problem');
  for (const key of ['ok', 'stopped', 'controller', 'problem']) assert.ok(copy.status[key], key);
});

// A bench press: the command for `seconds` from t = 1 s, the wheels following at once.
function benchRun(
  linear,
  angular,
  { seconds = 2, config = { wheel_radius: 0.05, wheel_separation: 0.3 } } = {},
) {
  const twist = [];
  const drive = [];
  for (let step = 0; step <= 200; step++) {
    const t = step * 0.02;
    const on = t >= 1 && t < 1 + seconds;
    twist.push({ stamp: t, linear: on ? linear : 0, angular: on ? angular : 0 });
    drive.push({ stamp: t, v: on ? linear : 0, w: on ? angular : 0, emergency_stop: false });
  }
  return { config, streams: { twist, drive } };
}

test('the bench check says which way the wheels turned while the button was held', () => {
  const forward = benchCheck(benchRun(0.1, 0));
  assert.equal(forward.move, 'forward');
  // 0.1 m/s on a 0.05 m wheel is about 19 rpm on both sides.
  assert.ok(Math.abs(forward.left - 19.1) < 0.2 && Math.abs(forward.right - 19.1) < 0.2);
  assert.equal(benchCheck(benchRun(-0.1, 0)).move, 'backward');
  assert.equal(benchCheck(benchRun(0, 0.5)).move, 'left');
  assert.equal(benchCheck(benchRun(0, -0.5)).move, 'right');
  assert.equal(benchCheck(benchRun(0.1, 0.5)).move, 'forwardLeft');
  assert.equal(benchCheck(benchRun(-0.1, 0.5)).move, 'backwardLeft');
  assert.equal(benchCheck(benchRun(0.001, 0)).move, 'still');
  assert.equal(benchCheck({ config: {}, streams: { twist: [], drive: [] } }), null);
});
