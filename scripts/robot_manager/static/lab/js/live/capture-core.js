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

/**
 * A recording shaped like a simulated control run, so the speed charts can draw it next to the
 * simulation: `time` from the start of the recording, `measured` and `target` in rpm. Samples
 * after `duration` are dropped rather than squeezed, so the time axis keeps its meaning.
 */
function liveControlRun(rows, duration) {
  const samples = rows
    .filter((row) => row.time <= duration && Number.isFinite(row.commandRpm))
    .map((row) => ({
      time: row.time,
      measured: row.measuredRpm,
      target: row.commandRpm,
    }));
  return { samples, seconds: samples.length ? samples[samples.length - 1].time : 0 };
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
  liveControlRun,
  captureSummary,
};
