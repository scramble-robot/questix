// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// The 「実機の状態」 panel's arithmetic (js/live/robot-state-core.js): what it says about the robot
// from the streams, how fresh each value is, and the line it adds to a memo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  HISTORY_SECONDS,
  WHEEL_GAP_SECONDS,
  createStateTracker,
  resetPose,
  ingest,
  wheelAxis,
  driverOf,
  robotStateModel,
  snapshotLine,
  freshnessText,
  signed,
  speedTop,
  sparkLines,
  stripModel,
  estopModel,
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
// /emergency_stop itself, as the bridge relays it (the authoritative E-stop).
const estop = (active) => ({ type: 'estop', active, source: 'operation_manager' });
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
  ingest(tracker, 'estop', estop(false), 0, config);
  ingest(tracker, 'odom', odom(0, 0, 0), 0, config);
  ingest(tracker, 'odom', odom(0.1, 0, 0.05), 50, config);
  ingest(tracker, 'scan', scanAhead(1.2), 50, config);
  const date = new Date(2026, 8, 25, 14, 3, 7);
  const model = robotStateModel(tracker, { link, now: 100 });
  const rpm = (0.2 * RPM_PER_MPS).toFixed(1);
  assert.equal(
    snapshotLine(model, date, text.memo),
    `14:03:07 左 ${rpm} rpm・右 ${rpm} rpm／前後 +0.20 m/秒・回転 0.00 rad/秒／向き +3°／前 1.20 m／非常停止：解除されています`,
  );
  const later = robotStateModel(tracker, { link, now: 5000 });
  assert.equal(
    snapshotLine(later, date, text.memo),
    '14:03:07 左 — rpm・右 — rpm／前後 — m/秒・回転 — rad/秒／向き —°／前 — m／非常停止：—',
  );
});

test('the strip: emergency stop, who drives, both wheels and the speed of the last seconds', () => {
  const tracker = createStateTracker();
  const driveState = { active: true, owner: 's1', limits: { linear: 0.3, angular: 1 } };
  for (let step = 0; step <= 20; step++) {
    const now = step * 100;
    ingest(tracker, 'twist', twist(step >= 10 ? 0.2 : 0), now, config);
    ingest(tracker, 'drive', drive(step >= 12 ? 0.2 : 0), now + 50, config);
    ingest(tracker, 'estop', estop(false), now + 50, config);
  }
  const model = robotStateModel(tracker, { link, driveState, session: 's1', now: 2100 });
  const strip = stripModel(model);
  assert.equal(strip.estop, 'released');
  assert.equal(strip.driver, 'me');
  assert.ok(Math.abs(strip.left - 0.2 * RPM_PER_MPS) < 1e-6);
  assert.equal(strip.speed, 0.2);
  // The axis is the bridge's limit: ±0.3 m/s, the zero line in the middle of the 32-unit height.
  assert.equal(strip.top, 0.3);
  assert.equal(strip.measured.length, 1);
  const points = strip.measured[0].split(' ').map((pair) => pair.split(',').map(Number));
  // Now is at the right edge; 0.2 m/s of ±0.3 sits a third of the way up from the middle.
  const [lastX, lastY] = points.at(-1);
  assert.ok(Math.abs(lastX - 120) < 1);
  assert.ok(Math.abs(lastY - (16 - (0.2 / 0.3) * 16)) < 0.1);
  assert.equal(strip.commanded.length, 1);
  // Pressed: the strip says so, whatever else it shows.
  ingest(tracker, 'drive', drive(0, 0, true), 2150, config);
  const pressed = stripModel(robotStateModel(tracker, { link, now: 2200 }));
  assert.equal(pressed.estop, 'pressed');
  assert.deepEqual(stripModel(robotStateModel(tracker, { link: { connected: false }, now: 0 })), {
    connected: false,
    phase: 'idle',
  });
});

test('the strip leaves stale values out and never bridges a gap in the sparkline', () => {
  const tracker = createStateTracker();
  ingest(tracker, 'drive', drive(0.1), 0, config);
  const stale = stripModel(robotStateModel(tracker, { link, now: 5000 }));
  assert.equal(stale.left, null);
  assert.equal(stale.speed, null);
  assert.equal(stale.estop, 'unknown');
  // A missing value splits the line; a single point draws nothing.
  const lines = sparkLines(
    [
      [-3, 0.1],
      [-2, 0.1],
      [-1.5, NaN],
      [-1, 0.2],
      [-0.5, 0.2],
      [-0.2, NaN],
      [0, 0.1],
    ],
    0.3,
  );
  assert.equal(lines.length, 2);
  // Values beyond the axis are drawn at its edge.
  assert.equal(
    sparkLines(
      [
        [-1, 5],
        [0, -5],
      ],
      0.3,
    )[0],
    '108,0 120,32',
  );
});

test('the strip axis grows from the bridge limit to what the robot did, in round steps', () => {
  const tracker = createStateTracker();
  assert.equal(speedTop(tracker, null), 0.3);
  assert.equal(speedTop(tracker, { linear: 0.15 }), 0.2);
  ingest(tracker, 'drive', drive(0.45), 0, config);
  assert.equal(speedTop(tracker, { linear: 0.15 }), 0.5);
});

test('signed numbers never show -0 or +0', () => {
  assert.equal(signed(0.004, 2), '0.00');
  assert.equal(signed(-0.004, 2), '0.00');
  assert.equal(signed(3.4, 0), '+3');
  assert.equal(signed(-0.126, 2), '-0.13');
});

test('only /emergency_stop itself says released; never heard is unknown, silent is stale', () => {
  const tracker = createStateTracker();
  // An older bridge (no estop stream) and a released derived flag: not released, unknown.
  ingest(tracker, 'drive', drive(0), 0, config);
  assert.deepEqual(estopModel(tracker, 100), { state: 'unknown', source: null });
  assert.equal(robotStateModel(tracker, { link, now: 100 }).estop, null);
  // The derived flag may still add a pressed E-stop.
  ingest(tracker, 'drive', drive(0, 0, true), 150, config);
  assert.deepEqual(estopModel(tracker, 200), { state: 'pressed', source: 'drive' });
  ingest(tracker, 'drive', drive(0), 250, config);
  // The topic itself: released, then pressed.
  ingest(tracker, 'estop', estop(false), 300, config);
  assert.deepEqual(estopModel(tracker, 400), { state: 'released', source: 'estop' });
  assert.equal(robotStateModel(tracker, { link, now: 400 }).estop, false);
  ingest(tracker, 'estop', estop(true), 500, config);
  assert.equal(robotStateModel(tracker, { link, now: 600 }).estopState, 'pressed');
  // Silent for more than a second: stale, never the last word "released".
  ingest(tracker, 'estop', estop(false), 700, config);
  const later = robotStateModel(tracker, { link, now: 1800 });
  assert.equal(later.estopState, 'stale');
  assert.equal(later.estop, null);
  assert.equal(stripModel(later).estop, 'unknown');
});

// --- each wheel's own values (bridges with the wheel-level telemetry authority) ---------------

// A /drive_status whose chassis velocity says something else on purpose (about 999 rpm): the
// panel must read each wheel's own values, never recompute them from v / w.
const directDrive = ({ filtered = 30, raw = 35, target = 31, valid = true } = {}) => ({
  type: 'drive',
  v: (999 / RPM_PER_MPS) * 1,
  w: 0,
  emergency_stop: false,
  left: {
    rpm: filtered,
    rpm_raw: raw,
    target_rpm: target,
    feedback_stamp: valid ? 99.98 : null,
    feedback_age_sec: valid ? 0.02 : null,
    feedback_valid: valid,
  },
  right: {
    rpm: -filtered,
    rpm_raw: -raw,
    target_rpm: -target,
    feedback_stamp: valid ? 99.98 : null,
    feedback_age_sec: valid ? 0.02 : null,
    feedback_valid: valid,
  },
});

test('the live panel reads each wheel itself: filtered, raw and the generated target', () => {
  const tracker = createStateTracker();
  const message = directDrive();
  ingest(tracker, 'twist', twist(0.5), 0, config);
  ingest(tracker, 'drive', message, 10, config);
  const model = robotStateModel(tracker, { link, now: 50 });
  assert.equal(model.wheels.authority, 'wheel');
  assert.equal(model.wheels.left, 30);
  assert.equal(model.wheels.right, 30); // forward-positive for the learner
  assert.equal(model.wheels.rawLeft, 35);
  assert.equal(model.wheels.rawRight, 35);
  assert.equal(model.wheels.targetLeft, 31);
  assert.equal(model.wheels.targetRight, 31);
  // The upstream request stays its own value (0.5 m/s as wheels), not the generated target.
  assert.ok(Math.abs(model.wheels.requestLeft - 0.5 * RPM_PER_MPS) < 1e-6);
  assert.ok(![model.wheels.left, model.wheels.targetLeft].some((v) => Math.abs(v - 999) < 1));
  assert.equal(message.right.rpm, -30); // the raw JSON keeps the native sign
  const strip = stripModel(model);
  assert.equal(strip.left, 30);
  assert.equal(strip.right, 30);
});

test('invalid wheel feedback is no fresh measurement; the generated target stays', () => {
  const tracker = createStateTracker();
  ingest(tracker, 'drive', directDrive({ valid: false }), 10, config);
  const model = robotStateModel(tracker, { link, now: 50 });
  assert.equal(model.wheels.stale, true);
  assert.equal(model.wheels.measurementValid, false);
  assert.ok(Number.isNaN(model.wheels.left) && Number.isNaN(model.wheels.rawLeft));
  assert.equal(model.wheels.targetLeft, 31);
  assert.equal(model.wheels.targetRight, 31);
  assert.equal(model.motion.stale, true); // v / w come from that feedback too
  const strip = stripModel(model);
  assert.equal(strip.left, null);
  assert.equal(strip.speed, null);
  const line = snapshotLine(model, new Date(2026, 8, 25, 14, 3, 7), text.memo);
  assert.match(line, /左 — rpm・右 — rpm/);
});

test('an older bridge without wheel fields falls back to the chassis velocity and the command', () => {
  const tracker = createStateTracker();
  ingest(tracker, 'twist', twist(0.2), 0, config);
  ingest(tracker, 'drive', drive(0.1), 10, config);
  const model = robotStateModel(tracker, { link, now: 50 });
  assert.equal(model.wheels.authority, 'legacy');
  assert.ok(Math.abs(model.wheels.left - 0.1 * RPM_PER_MPS) < 1e-6);
  assert.ok(Math.abs(model.wheels.targetLeft - 0.2 * RPM_PER_MPS) < 1e-6);
  assert.ok(Number.isNaN(model.wheels.rawLeft));
});

// --- raw feedback first, gaps kept (the lifted-wheel tests read the unsmoothed wheel) ----------

test('the raw wheel feedback is its own series beside the filtered one and the sent command', () => {
  const tracker = createStateTracker();
  for (let at = 0; at <= 200; at += 50)
    ingest(tracker, 'drive', directDrive({ filtered: 30, raw: 35 + at / 50 }), at, config);
  const { series } = robotStateModel(tracker, { link, now: 200 }).wheels;
  assert.deepEqual(
    series.rawLeft.map(([, rpm]) => rpm),
    [35, 36, 37, 38, 39],
  );
  assert.deepEqual(
    series.rawRight.map(([, rpm]) => rpm),
    [35, 36, 37, 38, 39],
  ); // forward-positive
  assert.ok(series.left.every(([, rpm]) => rpm === 30));
  assert.ok(series.targetLeft.every(([, rpm]) => rpm === 31));
});

test('missing feedback and pauses longer than the gap limit break the wheel lines', () => {
  const tracker = createStateTracker();
  ingest(tracker, 'drive', directDrive(), 0, config);
  ingest(tracker, 'drive', directDrive(), 50, config);
  ingest(tracker, 'drive', directDrive({ valid: false }), 100, config); // feedback not valid
  ingest(tracker, 'drive', directDrive(), 150, config);
  // Nothing for longer than WHEEL_GAP_SECONDS, then the stream resumes.
  const resume = 150 + WHEEL_GAP_SECONDS * 1000 + 50;
  ingest(tracker, 'drive', directDrive(), resume, config);
  ingest(tracker, 'drive', directDrive(), resume + 50, config);
  const { series } = robotStateModel(tracker, { link, now: resume + 50 }).wheels;
  // The invalid sample stays in as NaN instead of being dropped (which would join the line).
  assert.ok(Number.isNaN(series.rawLeft[2][1]));
  // A NaN point marks the pause before the first sample after it.
  assert.equal(series.rawLeft.length, 7);
  assert.ok(Number.isNaN(series.rawLeft[4][1]));
  assert.equal(series.rawLeft[4][0], series.rawLeft[5][0]);
  // Three runs: before the invalid sample, between it and the pause, after the pause.
  assert.equal(sparkLines(series.rawLeft, 60).length, 2); // a run of one point draws nothing
  const runs = series.rawLeft
    .map(([, rpm]) => (Number.isFinite(rpm) ? 'x' : ' '))
    .join('')
    .split(' ')
    .filter(Boolean);
  assert.deepEqual(runs, ['xx', 'x', 'xx']);
  // The generated target is the node's own and stays through invalid feedback, not the pause.
  assert.equal(series.targetLeft[2][1], 31);
  assert.ok(Number.isNaN(series.targetLeft[4][1]));
});

test('the strip draws the chassis speed from the raw wheels', () => {
  const tracker = createStateTracker();
  // Raw 35 rpm on both wheels; the node's own v says 999 rpm on purpose.
  ingest(tracker, 'drive', directDrive({ raw: 35 }), 0, config);
  ingest(tracker, 'drive', directDrive({ raw: 35 }), 50, config);
  const model = robotStateModel(tracker, { link, now: 50 });
  const expected = 35 / RPM_PER_MPS;
  const [, speed] = model.wheels.series.rawSpeed.at(-1);
  assert.ok(Math.abs(speed - expected) < 1e-12);
  assert.deepEqual(model.wheels.series.stripSpeed, model.wheels.series.rawSpeed);
  const strip = stripModel(model);
  assert.equal(strip.measured.length, 1);
  assert.deepEqual(strip.measured, sparkLines(model.wheels.series.rawSpeed, strip.top));
  // A raw speed above the bridge limit grows the strip's axis like any measured speed.
  assert.ok(speedTop(tracker, { linear: 0.1 }) >= expected);
  // Turning in place: the raw wheels cancel, the speed is zero.
  const turning = createStateTracker();
  const spin = directDrive({ raw: 35 });
  spin.right.rpm_raw = 35; // native sign: right wheel turning backwards
  ingest(turning, 'drive', spin, 0, config);
  assert.equal(robotStateModel(turning, { link, now: 0 }).wheels.series.rawSpeed[0][1], 0);
});

test('an older bridge without raw wheels keeps the node speed in the strip', () => {
  const tracker = createStateTracker();
  ingest(tracker, 'drive', drive(0.1), 0, config);
  ingest(tracker, 'drive', drive(0.12), 50, config);
  const model = robotStateModel(tracker, { link, now: 50 });
  assert.ok(model.wheels.series.rawSpeed.every(([, v]) => Number.isNaN(v)));
  assert.deepEqual(
    model.wheels.series.stripSpeed.map(([, v]) => v),
    [0.1, 0.12],
  );
  assert.deepEqual(stripModel(model).measured, sparkLines(model.wheels.series.speed, 0.3));
});
