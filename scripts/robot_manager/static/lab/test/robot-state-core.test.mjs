// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// The 「実機の状態」 panel's arithmetic (js/live/robot-state-core.js): what it says about the robot
// from the streams, how fresh each value is, and the line it adds to a memo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  HISTORY_SECONDS,
  createStateTracker,
  resetPose,
  ingest,
  wheelAxis,
  driverOf,
  robotStateModel,
  snapshotLine,
  freshnessText,
  signed,
} from '../js/live/robot-state-core.js';

const text = JSON.parse(
  fs.readFileSync(new URL('../content/live/robot-state.json', import.meta.url), 'utf8'),
);
const config = { wheel_radius: 0.1, wheel_separation: 0.5 };
const streams = { drive: '/drive_status', odom: '/odom', scan: '/scan', twist: '/target_twist' };
const link = { connected: true, phase: 'open', streams, config, robot: { name: 'questix-01' } };
const RPM_PER_MPS = 60 / (2 * Math.PI * config.wheel_radius);

const drive = (v, w = 0, emergency = false) => ({ type: 'drive', v, w, emergency_stop: emergency });
const twist = (linear, angular = 0) => ({ type: 'twist', linear, angular });
const odom = (x, y, theta) => ({ type: 'odom', x, y, theta });
// A scan with a wall `distance` metres straight ahead of the LiDAR, nothing elsewhere.
function scanAhead(distance) {
  const count = 360;
  const ranges = Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI + (index * 2 * Math.PI) / count;
    return Math.abs(angle) < (10 * Math.PI) / 180 ? distance / Math.cos(angle) : null;
  });
  return {
    type: 'scan',
    angle_min: -Math.PI,
    angle_increment: (2 * Math.PI) / count,
    ranges,
    mount: { x: 0.2, y: 0, yaw: 0 },
  };
}

test('offline, the model only says so', () => {
  const model = robotStateModel(createStateTracker(), {
    link: { connected: false, phase: 'idle' },
    now: 0,
  });
  assert.deepEqual(model, { connected: false, phase: 'idle' });
});

test('wheel speeds come from the chassis velocity and keep the last ten seconds', () => {
  const tracker = createStateTracker();
  ingest(tracker, 'twist', twist(0.2), 0, config);
  ingest(tracker, 'drive', drive(0.2, 0.4), 50, config);
  let model = robotStateModel(tracker, { link, now: 100 });
  const half = (0.4 * config.wheel_separation) / 2;
  assert.ok(Math.abs(model.wheels.left - (0.2 - half) * RPM_PER_MPS) < 1e-9);
  assert.ok(Math.abs(model.wheels.right - (0.2 + half) * RPM_PER_MPS) < 1e-9);
  // The command was straight ahead: both wheels were asked for the same speed.
  assert.ok(Math.abs(model.wheels.targetLeft - 0.2 * RPM_PER_MPS) < 1e-9);
  assert.equal(model.wheels.targetLeft, model.wheels.targetRight);
  assert.deepEqual(model.wheels.series.left[0][0], -0.05);
  for (let at = 100; at <= 12000; at += 100) ingest(tracker, 'drive', drive(0.1), at, config);
  model = robotStateModel(tracker, { link, now: 12000 });
  const times = model.wheels.series.left.map(([time]) => time);
  assert.ok(Math.min(...times) >= -HISTORY_SECONDS);
  assert.equal(Math.max(...times), 0);
  // The command is older than a second by then: no dashed line, no "指令" number.
  assert.ok(Number.isNaN(model.wheels.targetLeft));
  assert.equal(model.command, null);
});

test('the wheel axis is fixed by the bridge limits and only grows', () => {
  const tracker = createStateTracker();
  const limits = { linear: 0.3, angular: 1 };
  // 0.3 m/s + 1 rad/s × 0.25 m = 0.55 m/s at a wheel, 52.5 rpm: the axis spans ±60 rpm.
  assert.deepEqual(wheelAxis(tracker, limits, config), {
    min: -60,
    max: 60,
    step: 30,
    ticks: [-60, -30, 0, 30, 60],
  });
  assert.equal(wheelAxis(tracker, null, config).max, 60);
  ingest(tracker, 'drive', drive(1), 0, config); // 95.5 rpm with the controller
  assert.equal(wheelAxis(tracker, limits, config).max, 100);
  ingest(tracker, 'drive', drive(0), 100, config);
  assert.equal(wheelAxis(tracker, limits, config).max, 100);
});

test('who drives: a page run, the controller, nobody, or wheels turning without a command', () => {
  const idle = { active: false, owner: null };
  assert.equal(driverOf({ driveState: { active: true, owner: 7 }, session: 7 }), 'me');
  assert.equal(driverOf({ driveState: { active: true, owner: 3 }, session: 7 }), 'page');
  assert.equal(driverOf({ driveState: idle, command: { linear: 0.2, angular: 0 } }), 'controller');
  assert.equal(driverOf({ driveState: idle, command: { linear: 0, angular: 0 } }), 'none');
  assert.equal(
    driverOf({ driveState: idle, command: null, wheels: { left: 5, right: 5 } }),
    'unknown',
  );
  assert.equal(driverOf({ driveState: null, command: null, wheels: null }), 'none');
});

test('the emergency stop is read from a fresh /drive_status only', () => {
  const tracker = createStateTracker();
  assert.equal(robotStateModel(tracker, { link, now: 0 }).estop, null);
  ingest(tracker, 'drive', drive(0, 0, true), 0, config);
  assert.equal(robotStateModel(tracker, { link, now: 500 }).estop, true);
  // Nothing for two seconds: the last value no longer says what the button is now.
  assert.equal(robotStateModel(tracker, { link, now: 2000 }).estop, null);
});

test('the pose is measured from where the panel started, forward up', () => {
  const tracker = createStateTracker();
  // The robot starts at (1, 1) facing +y in the odometry frame…
  ingest(tracker, 'odom', odom(1, 1, Math.PI / 2), 0, config);
  // …then drives 0.5 m along its heading and turns 30° left.
  ingest(tracker, 'odom', odom(1, 1.5, Math.PI / 2 + Math.PI / 6), 100, config);
  const pose = robotStateModel(tracker, { link, now: 150 }).pose;
  assert.ok(Math.abs(pose.forward - 0.5) < 1e-9);
  assert.ok(Math.abs(pose.left) < 1e-9);
  assert.ok(Math.abs(pose.heading - Math.PI / 6) < 1e-9);
  assert.equal(pose.trail.length, 2);
  assert.equal(pose.half, 1);
  ingest(tracker, 'odom', odom(1, 2.4, Math.PI / 2), 200, config);
  // 1.4 m ahead plus 0.4 m of margin: the view grows to ±2 m.
  assert.equal(robotStateModel(tracker, { link, now: 250 }).pose.half, 2);
  resetPose(tracker);
  assert.equal(robotStateModel(tracker, { link, now: 250 }).pose, null);
  ingest(tracker, 'odom', odom(1, 2.4, Math.PI / 2), 300, config);
  assert.equal(robotStateModel(tracker, { link, now: 300 }).pose.forward, 0);
});

test('the front view keeps the beams ahead and the median distance', () => {
  const tracker = createStateTracker();
  ingest(tracker, 'scan', scanAhead(1.2), 0, config);
  const front = robotStateModel(tracker, { link, now: 100 }).front;
  assert.ok(Math.abs(front.distance - 1.2) < 0.01);
  assert.ok(front.points.length > 5);
  assert.ok(front.points.every((point) => point.forward > 0));
  // A wall further than the fan: the distance is still read, no point is drawn.
  ingest(tracker, 'scan', scanAhead(5), 200, config);
  const far = robotStateModel(tracker, { link, now: 300 }).front;
  assert.ok(far.distance > 4.9);
  assert.equal(far.points.length, 0);
});

test('freshness: seconds ago, grey once stale, and a command that is simply not sent', () => {
  const tracker = createStateTracker();
  ingest(tracker, 'drive', drive(0), 0, config);
  ingest(tracker, 'scan', scanAhead(1), 0, config);
  const states = robotStateModel(tracker, { link, now: 1500 }).streams;
  const byName = Object.fromEntries(states.map((stream) => [stream.name, stream]));
  assert.equal(byName.drive.stale, true); // 1.5 s > 1 s
  assert.equal(byName.scan.stale, false); // the LiDAR may be 2 s old
  assert.equal(freshnessText(byName.drive, text.fresh), '1.5秒前');
  assert.equal(freshnessText(byName.odom, text.fresh), '届いていません');
  assert.equal(freshnessText(byName.twist, text.fresh), '出ていません');
  assert.equal(freshnessText({ name: 'drive', age: 42 }, text.fresh), '10秒以上前');
});

test('a memo line carries the state of that moment, and dashes for stale values', () => {
  const tracker = createStateTracker();
  ingest(tracker, 'drive', drive(0.2, 0), 0, config);
  ingest(tracker, 'odom', odom(0, 0, 0), 0, config);
  ingest(tracker, 'odom', odom(0.1, 0, 0.05), 50, config);
  ingest(tracker, 'scan', scanAhead(1.2), 50, config);
  const date = new Date(2026, 8, 25, 14, 3, 7);
  const model = robotStateModel(tracker, { link, now: 100 });
  const rpm = (0.2 * RPM_PER_MPS).toFixed(1);
  assert.equal(
    snapshotLine(model, date, text.memo),
    `14:03:07 左 ${rpm} rpm・右 ${rpm} rpm／前後 +0.20 m/秒・回転 0.00 rad/秒／向き +3°／前 1.20 m／非常停止 解除`,
  );
  const later = robotStateModel(tracker, { link, now: 5000 });
  assert.equal(
    snapshotLine(later, date, text.memo),
    '14:03:07 左 — rpm・右 — rpm／前後 — m/秒・回転 — rad/秒／向き —°／前 — m／非常停止 —',
  );
});

test('signed numbers never show -0 or +0', () => {
  assert.equal(signed(0.004, 2), '0.00');
  assert.equal(signed(-0.004, 2), '0.00');
  assert.equal(signed(3.4, 0), '+3');
  assert.equal(signed(-0.126, 2), '-0.13');
});
