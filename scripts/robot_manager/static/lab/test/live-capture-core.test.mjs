// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTURE_DEFAULTS,
  forwardRpm,
  wheelRpm,
  driveSamples,
  commandHolds,
  steadyMeasurements,
  liveControlRun,
  captureSummary,
  commandStart,
  FRONT_HALF_ANGLE,
  LIDAR_DEFAULT_MOUNT,
  scanMount,
  frontDistance,
  distanceSamples,
  liveDistanceRun,
  odomMoves,
  firstHold,
  stepMetrics,
} from '../js/live/capture-core.js';

const config = { wheel_radius: 0.1, wheel_separation: 0.5 };
const rpmToSpeed = (rpm) => (rpm / 60) * 2 * Math.PI * config.wheel_radius;

// One /drive_status and one /target_twist as the bridge sends them.
const drive = (stamp, rpm) => ({ stamp, v: rpmToSpeed(rpm), w: 0, emergency_stop: false });
const twist = (stamp, rpm) => ({ stamp, linear: rpmToSpeed(rpm), angular: 0 });

// `plan` is [seconds, commandRpm, measuredRpm] segments sampled at 20 Hz.
function recording(plan, { commandAge = 0 } = {}) {
  const samples = [];
  let stamp = 100;
  for (const [seconds, command, measured] of plan) {
    for (let i = 0; i < Math.round(seconds * 20); i += 1) {
      samples.push({ drive: drive(stamp, measured), twist: twist(stamp - commandAge, command) });
      stamp += 0.05;
    }
  }
  return samples;
}

test('wheelRpm is forward-positive for both wheels', () => {
  const straight = wheelRpm({ v: 0.2, w: 0 }, config);
  assert.ok(straight.left > 0 && Math.abs(straight.left - straight.right) < 1e-9);
  const turnLeft = wheelRpm({ v: 0, w: 1 }, config); // counter-clockwise: right wheel forward
  assert.ok(turnLeft.right > 0 && turnLeft.left < 0);
});

test('forwardRpm and wheelRpm agree while driving straight', () => {
  const speed = rpmToSpeed(42);
  assert.ok(Math.abs(forwardRpm(speed, config) - 42) < 1e-9);
  assert.ok(Math.abs(wheelRpm({ v: speed, w: 0 }, config).left - 42) < 1e-9);
});

test('a recording without wheel geometry is refused', () => {
  assert.throws(() => driveSamples(recording([[1, 30, 30]]), null), /車輪の寸法/);
  assert.throws(() => driveSamples(recording([[1, 30, 30]]), { wheel_radius: 0 }), /車輪の寸法/);
});

test('a command older than a second is not paired with the measurement', () => {
  const fresh = driveSamples(recording([[1, 30, 28]]), config);
  assert.ok(Number.isFinite(fresh[0].commandRpm));
  const stale = driveSamples(recording([[1, 30, 28]], { commandAge: 2 }), config);
  assert.ok(stale.every((row) => Number.isNaN(row.commandRpm)));
  assert.ok(stale.every((row) => Number.isFinite(row.measuredRpm)));
});

test('time is counted from the first sample and repeats are dropped', () => {
  const rows = driveSamples(recording([[1, 30, 30]]), config);
  assert.equal(rows[0].time, 0);
  assert.ok(rows[rows.length - 1].time > 0.9);
  const repeated = [
    { drive: drive(100, 10), twist: twist(100, 10) },
    { drive: drive(100, 20), twist: twist(100, 20) }, // same stamp: not a later moment
    { drive: drive(100.1, 30), twist: twist(100.1, 30) },
  ];
  assert.deepEqual(
    driveSamples(repeated, config).map((row) => Math.round(row.measuredRpm)),
    [10, 30],
  );
});

test('each held command becomes one input with repeated measurements', () => {
  const rows = driveSamples(
    recording([
      [3, 20, 19],
      [3, 40, 41],
      [3, 60, 58],
    ]),
    config,
  );
  const measured = steadyMeasurements(rows);
  assert.equal(measured.holds.length, 3);
  assert.equal(measured.skipped, 0);
  assert.equal(measured.rows.length, 3 * CAPTURE_DEFAULTS.repeats);
  const inputs = [...new Set(measured.rows.map((row) => row.x))];
  assert.deepEqual(inputs, [20, 40, 60]);
  // Rows of one hold must share the exact input, otherwise the lab cannot group them as repeats.
  assert.equal(measured.rows.filter((row) => row.x === 40).length, CAPTURE_DEFAULTS.repeats);
  assert.ok(measured.rows.every((row) => row.test === false));
});

test('a hold shorter than the minimum is skipped, not measured', () => {
  const rows = driveSamples(
    recording([
      [1, 20, 19],
      [3, 40, 41],
    ]),
    config,
  );
  const measured = steadyMeasurements(rows);
  assert.equal(measured.skipped, 1);
  assert.deepEqual([...new Set(measured.rows.map((row) => row.x))], [40]);
});

test('the settling part of a hold is left out of the measurements', () => {
  // The command is held at 40 rpm while the wheel is still at 5 rpm for the first second.
  const plan = [
    [1, 40, 5],
    [3, 40, 40],
  ];
  const measured = steadyMeasurements(driveSamples(recording(plan), config));
  assert.equal(measured.holds.length, 1);
  assert.ok(
    measured.rows.every((row) => row.y > 30),
    'the speeding-up part is not a measurement',
  );
});

test('a run without a command yields no measurements', () => {
  const rows = driveSamples(recording([[4, 40, 40]], { commandAge: 2 }), config);
  const measured = steadyMeasurements(rows);
  assert.equal(measured.rows.length, 0);
  assert.equal(measured.holds.length, 0);
});

test('commandHolds treats a change within the tolerance as the same command', () => {
  const rows = driveSamples(
    recording([
      [1, 40, 40],
      [1, 41, 40], // 1 rpm apart: still the same command
      [1, 50, 48],
    ]),
    config,
  );
  const holds = commandHolds(rows, CAPTURE_DEFAULTS.commandTolerance);
  assert.equal(holds.length, 2);
  assert.ok(holds[0].to - holds[0].from > 1.5);
});

test('liveControlRun keeps only the samples inside the chart window', () => {
  const rows = driveSamples(recording([[20, 40, 38]]), config);
  const run = liveControlRun(rows, 16);
  assert.ok(run.samples.length > 0);
  assert.ok(run.samples.every((sample) => sample.time <= 16));
  assert.ok(run.seconds <= 16 && run.seconds > 15);
  assert.ok(Math.abs(run.samples[0].target - 40) < 1e-6);
  assert.ok(Math.abs(run.samples[0].measured - 38) < 1e-6);
});

test('captureSummary reports the conditions the learner needs to read the result', () => {
  const still = captureSummary(driveSamples(recording([[2, 0, 0]]), config));
  assert.equal(still.moved, false);
  assert.equal(still.commanded, true);
  assert.equal(still.emergencyStop, false);
  const moving = captureSummary(driveSamples(recording([[2, 40, 39]]), config));
  assert.equal(moving.moved, true);
  assert.ok(moving.seconds > 1.9);
  const stopped = recording([[2, 40, 0]]).map((sample) => ({
    ...sample,
    drive: { ...sample.drive, emergency_stop: true },
  }));
  assert.equal(captureSummary(driveSamples(stopped, config)).emergencyStop, true);
});

// --- step alignment, the wall ahead and the drives between stops ----------------------------

test('liveControlRun counts time from the first command, where the simulation steps', () => {
  const rows = driveSamples(
    recording([
      [3, 0, 0],
      [10, 40, 38],
    ]),
    config,
  );
  const run = liveControlRun(rows, 16);
  assert.equal(run.samples[0].time, 0);
  assert.ok(Math.abs(run.samples[0].target - 40) < 1e-6);
  assert.ok(Math.abs(commandStart(rows) - 3) < 1e-6);
});

// A scan whose beams all see a flat wall `wall` metres straight ahead.
function wallScan(stamp, wall, { beams = 360, blocked = [] } = {}) {
  const increment = (2 * Math.PI) / beams;
  const ranges = Array.from({ length: beams }, (_, index) => {
    const angle = -Math.PI + index * increment;
    if (blocked.includes(index)) return 0.2;
    return Math.abs(angle) < 1.2 ? Number((wall / Math.cos(angle)).toFixed(3)) : null;
  });
  return { stamp, angle_min: -Math.PI, angle_increment: increment, range_max: 12, ranges };
}

test('frontDistance is the median of the beams straight ahead', () => {
  assert.ok(Math.abs(frontDistance(wallScan(0, 1.5)) - 1.5) < 0.005);
  // One stray beam (a cable in front of the LiDAR) does not move it.
  assert.ok(Math.abs(frontDistance(wallScan(0, 1.5, { blocked: [180] })) - 1.5) < 0.005);
  const nothingAhead = { ...wallScan(0, 1.5), ranges: new Array(360).fill(null) };
  assert.equal(frontDistance(nothingAhead), null);
  // Angles are wrapped: a LiDAR reporting 0…2π still finds straight ahead.
  const wrapped = wallScan(0, 1.5);
  const shifted = {
    ...wrapped,
    angle_min: 0,
    ranges: [...wrapped.ranges.slice(180), ...wrapped.ranges.slice(0, 180)],
  };
  assert.ok(Math.abs(frontDistance(shifted) - 1.5) < 0.005);
  assert.ok(FRONT_HALF_ANGLE > 0);
});

test('liveDistanceRun starts where the robot starts to approach the wall', () => {
  const scans = [];
  for (let i = 0; i < 60; i += 1) {
    const time = i * 0.2; // 5 Hz
    const wall = time < 2 ? 1.5 : Math.max(0.5, 1.5 - 0.25 * (time - 2));
    scans.push(wallScan(50 + time, wall));
  }
  const rows = distanceSamples(scans);
  assert.equal(rows.length, 60);
  const run = liveDistanceRun(rows, 16);
  assert.equal(run.approached, true);
  assert.equal(run.samples[0].time, 0);
  assert.ok(Math.abs(run.samples[0].measured - 1.5) < 0.01);
  assert.ok(run.samples.every((sample) => Number.isNaN(sample.target)));
  assert.ok(Math.abs(run.samples[run.samples.length - 1].measured - 0.5) < 0.01);
  const still = liveDistanceRun(distanceSamples(scans.slice(0, 10)), 16);
  assert.equal(still.approached, false);
});

test('odomMoves finds each drive between two stops', () => {
  const odoms = [];
  let x = 0;
  const plan = [
    [1, 0],
    [2, 0.2], // 40 cm
    [1, 0],
    [1.5, 0.2], // 30 cm
    [1, 0],
    [0.05, 0.2], // 1 cm: a nudge
    [1, 0],
  ];
  let stamp = 20;
  for (const [seconds, speed] of plan)
    for (let i = 0; i < Math.round(seconds * 20); i += 1) {
      odoms.push({ stamp, x, y: 0, theta: 0, v: speed, w: 0 });
      x += speed * 0.05;
      stamp += 0.05;
    }
  const moves = odomMoves(odoms);
  assert.equal(moves.length, 2);
  assert.ok(Math.abs(moves[0].distance - 0.4) < 0.011);
  assert.ok(Math.abs(moves[1].distance - 0.3) < 0.011);
  assert.ok(moves[0].to < moves[1].from);
  assert.equal(moves[0].turn, 0);
});

test('the LiDAR mount turns beams into the robot frame; without one the QUESTiX mount is used', () => {
  assert.deepEqual(scanMount({}), LIDAR_DEFAULT_MOUNT);
  assert.deepEqual(scanMount({ mount: null }), LIDAR_DEFAULT_MOUNT);
  // A LiDAR mounted backwards sees the wall ahead of the robot at its own angle π.
  const scan = wallScan(0, 1.5);
  const backwards = {
    ...scan,
    ranges: [...scan.ranges.slice(180), ...scan.ranges.slice(0, 180)],
    mount: { x: 0.2, y: 0, yaw: Math.PI },
  };
  assert.ok(Math.abs(frontDistance(backwards) - 1.5) < 0.005);
});

test('stepMetrics reads a recording by the definitions of the control course', () => {
  // A first-order step to 40 rpm: 0.2 s delay, 0.5 s time constant, 1 rpm short at the end.
  const samples = [];
  for (let i = 0; i <= 320; i += 1) {
    const time = i * 0.05;
    const moving = Math.max(0, time - 0.2);
    samples.push({ time, measured: 39 * (1 - Math.exp(-moving / 0.5)), target: 40 });
  }
  const metrics = stepMetrics(samples, { target: 40 });
  assert.ok(Math.abs(metrics.finalError - 1) < 0.01);
  assert.equal(metrics.overshoot, 0);
  // Read off 20 Hz samples, so within about one sample period.
  assert.ok(Math.abs(metrics.delay - 0.2) <= 0.06);
  assert.ok(Math.abs(metrics.tau - 0.5) <= 0.06);
  assert.ok(Math.abs(metrics.gain - 39 / 40) < 0.001);
  assert.ok(metrics.settling > 1 && metrics.settling < 2.5);
  // Approaching a wall: 0.1 m past the 0.5 m target, then back and still.
  const wall = [];
  for (let i = 0; i <= 200; i += 1) {
    const time = i * 0.1;
    const gap = time < 5 ? 1.5 - 0.22 * time : time < 7 ? 0.4 + 0.05 * (time - 5) : 0.5;
    wall.push({ time, measured: gap });
  }
  const stop = stepMetrics(wall, { target: 0.5, distance: true });
  assert.ok(Math.abs(stop.overshoot - 0.1) < 1e-9);
  assert.equal(stop.finalError, 0);
  assert.ok(stop.settling >= 6 && stop.settling <= 7.2);
  assert.equal(stop.tau, undefined);
});

test('firstHold keeps a speed run up to its first change of command', () => {
  const samples = [0, 1, 2, 3].map((time) => ({ time, target: time < 2 ? 40 : 0, measured: 0 }));
  assert.deepEqual(
    firstHold(samples).map((sample) => sample.time),
    [0, 1],
  );
  assert.deepEqual(firstHold([]), []);
});
