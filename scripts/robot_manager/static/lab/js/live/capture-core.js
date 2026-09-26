// Turning a live recording from the robot into the numbers a lesson already knows how to use.
// No DOM and no WebSocket: capture.js collects the raw messages, this module does the arithmetic,
// so every rule below can be checked in Node (test/live-capture-core.test.mjs).
//
// Units follow REP-103 and the rest of the course material: metres, radians, seconds, and wheel
// speed in rpm counted forward-positive for both wheels.

// A command older than this no longer describes what the robot was being asked to do, so the
// sample is kept as a measurement without a command rather than paired with a stale one.
const COMMAND_FRESH_SECONDS = 1;

// How a held command becomes one row of the measurement table.
const CAPTURE_DEFAULTS = {
  settleSeconds: 1, // skipped at the start of a hold: the wheel is still speeding up
  minHoldSeconds: 2, // a shorter hold is not a measurement, it is a moment on the way
  commandTolerance: 2, // rpm: a change smaller than this is still the same command
  repeats: 3, // rows kept per hold, so repeatability is visible
  maxRows: 200, // the measurement table refuses more
};

const INPUT_DIGITS = 1; // rows of one hold must share the exact same input to be grouped
const VALUE_DIGITS = 3;
const MOVING_RPM = 1; // rpm below which the robot counts as standing still

// Forward-positive wheel speed [rpm] for both wheels. The raw per-wheel feedback cannot be used
// directly (the right motor is mirrored on the wire), so the differential-drive kinematics are
// inverted from the chassis velocity, which already carries the robot's own sign convention:
// v_left = v - w*L/2, v_right = v + w*L/2.
function wheelRpm(drive, config) {
  const toRpm = (speed) => (speed / (2 * Math.PI * config.wheel_radius)) * 60;
  const half = (drive.w * config.wheel_separation) / 2;
  return { left: toRpm(drive.v - half), right: toRpm(drive.v + half) };
}

// The speed both wheels turn at while the robot drives straight, i.e. the average of the two.
// This is the quantity the speed lessons call "車輪の回転数".
function forwardRpm(metresPerSecond, config) {
  return (metresPerSecond / (2 * Math.PI * config.wheel_radius)) * 60;
}

function requireConfig(config) {
  if (!config || !(config.wheel_radius > 0) || !(config.wheel_separation > 0))
    throw new Error('ロボットから車輪の寸法を受け取れませんでした。');
}

/**
 * Normalise raw `{drive, twist}` samples into one row per moment, with the time counted from the
 * first sample. `twist` may be null or older than the drive feedback; then the row has no command
 * (`commandRpm` is NaN) instead of being paired with a command that has already been replaced.
 */
function driveSamples(raw, config) {
  requireConfig(config);
  if (!raw.length) return [];
  const start = raw[0].drive.stamp;
  const rows = [];
  let previous = -Infinity;
  for (const sample of raw) {
    const drive = sample.drive;
    const time = drive.stamp - start;
    if (!(time > previous) && rows.length) continue;
    if (!Number.isFinite(drive.v) || !Number.isFinite(drive.w)) continue;
    previous = time;
    const twist = sample.twist;
    const fresh =
      twist && Number.isFinite(twist.linear) && drive.stamp - twist.stamp < COMMAND_FRESH_SECONDS;
    rows.push({
      time,
      measuredRpm: forwardRpm(drive.v, config),
      commandRpm: fresh ? forwardRpm(twist.linear, config) : NaN,
      measuredV: drive.v,
      measuredW: drive.w,
      commandV: fresh ? twist.linear : NaN,
      commandW: fresh ? twist.angular : NaN,
      wheels: wheelRpm(drive, config),
      emergencyStop: Boolean(drive.emergency_stop),
    });
  }
  return rows;
}

// Consecutive rows whose command stays within `commandTolerance` of the first one form a hold.
// Rows without a command end the current hold: what the robot was asked to do is unknown there.
function commandHolds(rows, tolerance) {
  const holds = [];
  let hold = null;
  for (const row of rows) {
    if (!Number.isFinite(row.commandRpm)) {
      hold = null;
      continue;
    }
    if (hold && Math.abs(row.commandRpm - hold.rows[0].commandRpm) <= tolerance) {
      hold.rows.push(row);
      continue;
    }
    hold = { rows: [row] };
    holds.push(hold);
  }
  return holds.map((entry) => ({
    rows: entry.rows,
    command: entry.rows[0].commandRpm,
    from: entry.rows[0].time,
    to: entry.rows[entry.rows.length - 1].time,
  }));
}

// `count` rows spread evenly over `rows`, keeping the first and the last one.
function spread(rows, count) {
  if (rows.length <= count) return rows;
  const step = (rows.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => rows[Math.round(i * step)]);
}

/**
 * Rows for the measurement lab: one input per held command, repeated `repeats` times from the part
 * of the hold that has settled. `test` is left false on every row — which measurement to hold back
 * as a check is the learner's decision, not the recorder's.
 *
 * Returns `{rows, holds, skipped}`; `skipped` counts holds that were too short to measure.
 */
function steadyMeasurements(rows, options = {}) {
  const settings = { ...CAPTURE_DEFAULTS, ...options };
  const holds = commandHolds(rows, settings.commandTolerance);
  const kept = [];
  let skipped = 0;
  for (const hold of holds) {
    const settled = hold.rows.filter((row) => row.time >= hold.from + settings.settleSeconds);
    if (hold.to - hold.from < settings.minHoldSeconds || !settled.length) {
      skipped += 1;
      continue;
    }
    // Every row of a hold reports the same input, so the lab groups them as repeats of one
    // measurement; the mean is used because the command is only constant within the tolerance.
    const mean = hold.rows.reduce((sum, row) => sum + row.commandRpm, 0) / hold.rows.length;
    kept.push({
      input: Number(mean.toFixed(INPUT_DIGITS)),
      seconds: hold.to - hold.from,
      values: spread(settled, settings.repeats).map((row) =>
        Number(row.measuredRpm.toFixed(VALUE_DIGITS)),
      ),
    });
  }
  const measurements = kept.flatMap((hold) =>
    hold.values.map((value) => ({ x: hold.input, y: value, test: false })),
  );
  return { rows: measurements.slice(0, settings.maxRows), holds: kept, skipped };
}

// Where a step response starts: the first row that asks the wheels to turn. A recording usually
// begins a few seconds before the learner moves the stick, and a bag long before; counting time
// from this row puts the real step at t = 0, where the simulation makes its own. A recording that
// is already moving at its first row keeps that row as the start.
function commandStart(rows) {
  const first = rows.find((row) => Math.abs(row.commandRpm) > MOVING_RPM);
  return first ? first.time : (rows[0]?.time ?? 0);
}

/**
 * A recording shaped like a simulated control run, so the speed charts can draw it next to the
 * simulation: `time` from the first command (see commandStart), `measured` and `target` in rpm.
 * Samples after `duration` are dropped rather than squeezed, so the time axis keeps its meaning.
 */
function liveControlRun(rows, duration) {
  const start = commandStart(rows.filter((row) => Number.isFinite(row.commandRpm)));
  const samples = rows
    .filter((row) => Number.isFinite(row.commandRpm))
    .map((row) => ({
      time: row.time - start,
      measured: row.measuredRpm,
      target: row.commandRpm,
    }))
    .filter((sample) => sample.time >= 0 && sample.time <= duration);
  return { samples, seconds: samples.length ? samples[samples.length - 1].time : 0 };
}

// --- the wall ahead, from the LiDAR ----------------------------------------------------------

// The distance lessons stop the robot in front of a wall and measure the gap with the LiDAR. On
// the robot the beams within this angle of the robot's forward direction stand in for that one
// measurement; the median keeps a single spurious beam (a cable, a table leg) from moving it. The
// distance is the LiDAR's own reading (from the sensor to the wall), as in the lessons.
//
// Where the LiDAR sits comes with every scan (`mount`, looked up in TF by questix_lab_bridge, or
// read from /tf_static in a rosbag). Without it, the static transform QUESTiX publishes is assumed:
// keep LIDAR_DEFAULT_MOUNT equal to launcher/launch/lidar_driver.launch.xml (base_link ->
// laser_frame, 0.2 m ahead of the centre, facing forward).
const LIDAR_DEFAULT_MOUNT = { x: 0.2, y: 0, yaw: 0 };

/** Pose of the scan frame on the robot: `{x, y, yaw}` in metres and radians. */
function scanMount(scan) {
  const mount = scan?.mount;
  if (mount && [mount.x, mount.y, mount.yaw].every(Number.isFinite)) return mount;
  return LIDAR_DEFAULT_MOUNT;
}

const FRONT_HALF_ANGLE = (5 * Math.PI) / 180; // rad either side of straight ahead
const FRONT_MIN_BEAMS = 3; // fewer valid beams than this ahead: no measurement
// The robot counts as approaching once the gap has shrunk by this much from where it stood.
const APPROACH_START = 0.03; // m, about three times the LiDAR's noise at 1–2 m

const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Distance [m] to whatever is straight ahead in one scan, or null when too few beams hit it. */
function frontDistance(scan, halfAngle = FRONT_HALF_ANGLE) {
  const ahead = [];
  const yaw = scanMount(scan).yaw;
  scan.ranges.forEach((range, index) => {
    const angle = wrapAngle(yaw + scan.angle_min + index * scan.angle_increment);
    if (range !== null && Number.isFinite(range) && Math.abs(angle) <= halfAngle) ahead.push(range);
  });
  return ahead.length >= FRONT_MIN_BEAMS ? median(ahead) : null;
}

/** One row per scan with a wall ahead: `{time, distance}`, time from the first scan. */
function distanceSamples(scans) {
  if (!scans.length) return [];
  const start = scans[0].stamp;
  const rows = [];
  let previous = -Infinity;
  for (const scan of scans) {
    const time = scan.stamp - start;
    if (!(time > previous)) continue;
    const distance = frontDistance(scan);
    if (distance === null) continue;
    previous = time;
    rows.push({ time, distance });
  }
  return rows;
}

// Where an approach starts: the last row before the gap first shrinks by APPROACH_START from the
// distance the robot stood at. -1 when it never does.
function approachStart(rows) {
  if (!rows.length) return -1;
  const standing = median(rows.slice(0, 3).map((row) => row.distance));
  const moving = rows.findIndex((row) => standing - row.distance >= APPROACH_START);
  return moving < 0 ? -1 : Math.max(0, moving - 1);
}

/**
 * A wall-distance recording shaped like a simulated distance run: `measured` in metres, time from
 * the start of the approach (see approachStart). The real robot has no distance target of its own
 * — the learner drives it — so `target` is NaN and the chart draws no target line for it.
 * `approached` is false when the robot never moved towards the wall.
 */
function liveDistanceRun(rows, duration) {
  const first = approachStart(rows);
  if (first < 0) return { samples: [], seconds: 0, approached: false };
  const start = rows[first].time;
  const samples = rows
    .slice(first)
    .map((row) => ({ time: row.time - start, measured: row.distance, target: NaN }))
    .filter((sample) => sample.time <= duration);
  return { samples, seconds: samples[samples.length - 1].time, approached: true };
}

// --- distance travelled, from the wheels -----------------------------------------------------

// /odom integrates the wheel rotation, so the distance it reports for one drive is exactly the
// "車輪から求めた距離" the measurement lab compares with a tape measure. A drive is a stretch where
// the robot moves, between two stops.
const MOVE_SPEED = 0.01; // m/s: slower than this counts as standing still
const STOP_SECONDS = 0.5; // a pause at least this long ends a drive
const MIN_MOVE = 0.02; // m: a shorter drive is a nudge, not a measurement

function finishMove(poses) {
  const first = poses[0];
  const last = poses[poses.length - 1];
  let path = 0;
  for (let i = 1; i < poses.length; i += 1)
    path += Math.hypot(poses[i].x - poses[i - 1].x, poses[i].y - poses[i - 1].y);
  return {
    from: first.time,
    to: last.time,
    // A tape measures the straight line between the two marks, so that is what is compared.
    distance: Math.hypot(last.x - first.x, last.y - first.y),
    path,
    turn: wrapAngle(last.theta - first.theta),
  };
}

/**
 * The drives in a stretch of /odom messages: `[{from, to, distance, path, turn}]` in metres and
 * radians, time from the first message. A drive starts at the last pose before the robot moves and
 * ends at the pose where it has stood still for STOP_SECONDS (or at the end of the recording).
 */
function odomMoves(odoms) {
  const poses = odoms
    .filter((odom) => [odom.x, odom.y, odom.theta, odom.v].every(Number.isFinite))
    .map((odom) => ({ ...odom, time: odom.stamp - odoms[0].stamp }));
  const moves = [];
  let current = null;
  let stillSince = null;
  poses.forEach((pose, index) => {
    const moving = Math.abs(pose.v) >= MOVE_SPEED;
    if (!current) {
      if (moving) current = [poses[Math.max(0, index - 1)], pose];
      return;
    }
    current.push(pose);
    if (moving) {
      stillSince = null;
      return;
    }
    stillSince ??= pose.time;
    if (pose.time - stillSince < STOP_SECONDS) return;
    moves.push(finishMove(current));
    current = null;
    stillSince = null;
  });
  if (current) moves.push(finishMove(current));
  return moves.filter((move) => move.distance >= MIN_MOVE);
}

// --- the same numbers the simulation reports ------------------------------------------------

// The control course judges a run by its final error, overshoot and settling time
// (js/control/core.js controlMetrics). A recording is judged by the same definitions, so the table
// that puts the robot next to the simulation compares like with like.
const RUN_TAIL_SECONDS = 2; // the last seconds averaged into the final error (core.js TAIL_SECONDS)
const SETTLE_BAND = { speed: 3, distance: 0.05 }; // rpm / m around the target (core.js tolerance)
const STILL_SPEED = 0.03; // m/s: a gap changing slower than this means the robot has stopped
// A first-order model y(t) = K·target·(1 − e^−(t−L)/τ) read off the step: L when the response
// first reaches 5 % of its final value, τ from there to 63.2 %.
const DELAY_FRACTION = 0.05;
const TAU_FRACTION = 1 - Math.exp(-1);

/**
 * The first command of a speed run and what the wheels did while it lasted: the samples up to
 * the moment the target moves more than the hold tolerance away from its first value. A recording
 * (or a bag) usually goes on after the step — stopping, another speed — and judging that part
 * against the first target would count it as error.
 */
function firstHold(samples) {
  if (!samples.length) return [];
  const target = samples[0].target;
  const end = samples.findIndex(
    (sample) => Math.abs(sample.target - target) > CAPTURE_DEFAULTS.commandTolerance,
  );
  return end < 0 ? samples : samples.slice(0, end);
}

const meanOf = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

// Settling, read backwards from the end like core.js: a value that only touches the band and
// leaves again has not settled. For the wall, the robot must also have stopped.
function settledFrom(samples, { key, target, band, distance }) {
  let settling = null;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const sample = samples[i];
    const previous = samples[i - 1];
    const speed = previous
      ? Math.abs(sample[key] - previous[key]) / (sample.time - previous.time)
      : 0;
    if (Math.abs(sample[key] - target) > band || (distance && speed > STILL_SPEED)) break;
    settling = sample.time;
  }
  return settling;
}

function firstOrderFit(samples, key, final) {
  if (!(Math.abs(final) > MOVING_RPM)) return { delay: null, tau: null };
  const reach = (fraction) =>
    samples.find((sample) => sample[key] / final >= fraction)?.time ?? null;
  const delay = reach(DELAY_FRACTION);
  const rise = reach(TAU_FRACTION);
  return { delay, tau: delay === null || rise === null ? null : rise - delay };
}

/**
 * Final error, overshoot and settling time of a run (`samples` of `{time, [key]}` from t = 0), by
 * the definitions of the control course. For a speed step also the first-order model: `delay` L
 * and time constant `tau` in seconds, and `gain` K = final / target. `distance` runs count
 * overshoot towards the wall (below the target). Values that do not exist are null.
 */
function stepMetrics(samples, { key = 'measured', target, distance = false }) {
  if (!samples.length) return null;
  const end = samples[samples.length - 1].time;
  const tail = samples.filter((sample) => sample.time >= end - RUN_TAIL_SECONDS);
  const final = meanOf(tail.map((sample) => sample[key]));
  const overshoot = Math.max(
    0,
    ...samples.map((sample) => (distance ? target - sample[key] : sample[key] - target)),
  );
  const band = distance ? SETTLE_BAND.distance : SETTLE_BAND.speed;
  const settling = settledFrom(samples, { key, target, band, distance });
  const metrics = {
    target,
    final,
    finalError: meanOf(tail.map((sample) => Math.abs(sample[key] - target))),
    overshoot,
    // Settled only if it stays so for at least a second before the end, as in core.js.
    settling: settling !== null && end - settling >= 1 ? settling : null,
  };
  if (distance) return metrics;
  return {
    ...metrics,
    gain: target ? final / target : null,
    ...firstOrderFit(samples, key, final),
  };
}

// What the learner is told about a recording: how long it ran, whether the robot moved at all,
// and whether an emergency stop was active (which explains a flat measurement).
function captureSummary(rows) {
  return {
    samples: rows.length,
    seconds: rows.length ? rows[rows.length - 1].time : 0,
    moved: rows.some((row) => Math.abs(row.measuredRpm) > MOVING_RPM),
    commanded: rows.some((row) => Number.isFinite(row.commandRpm)),
    emergencyStop: rows.some((row) => row.emergencyStop),
  };
}

export {
  CAPTURE_DEFAULTS,
  COMMAND_FRESH_SECONDS,
  wheelRpm,
  forwardRpm,
  driveSamples,
  commandHolds,
  steadyMeasurements,
  commandStart,
  liveControlRun,
  FRONT_HALF_ANGLE,
  LIDAR_DEFAULT_MOUNT,
  scanMount,
  frontDistance,
  distanceSamples,
  liveDistanceRun,
  odomMoves,
  firstHold,
  stepMetrics,
  captureSummary,
};
