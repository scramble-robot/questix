import { programCommand, programSeconds } from '../live/drive-core.js';
import { commandHolds } from '../live/capture-core.js';
import { driveRows } from '../live/recording-core.js';

// The motor course's bench measurement of the drive wheels (topic `real`): with the wheels lifted
// on a stand, the page asks for a staircase of speeds and the table 「指示 → 測った回転数（左・右）」
// is filled from what the wheels reported. No DOM (test/motor-bench.test.mjs); ui.js hands the
// program to live-session.js (whose drive-link.js is the only sender) and the recording back here.
//
// Speeds are fractions of the fastest forward speed the bridge lets a page ask for
// (drive_state.limits.linear), so the staircase stays inside the bridge's clamp on every robot.

const BENCH_PERCENTS = [20, 40, 60, 40, 20]; // % of the allowed forward speed, up and back down
const BENCH_LEAD = 1; // s standing still before the first step, so the recording starts at rest
const BENCH_HOLD = 2.5; // s per step: about 1 s to settle, the rest is measured
const BENCH_STOP = 2; // s at 0 after the last step: the stop is a step of the table too
const BENCH_TAIL = 1.5; // s recorded after the run, so the wheels are seen standing still
// The first second of every step is the wheel speeding up or slowing down, not the steady speed.
const SETTLE_SECONDS = 1;
const MIN_STEADY_SAMPLES = 5; // fewer steady samples than this (0.25 s at 20 Hz): not a step
// Steps the page commanded differ by several rpm; a controller's stick wobbles, so commands that
// came from it are grouped more loosely (capture-core's measurement-lab tolerance).
const PROGRAM_TOLERANCE = 0.5; // rpm
const STICK_TOLERANCE = 2; // rpm
const RPM_DIGITS = 1;
const STILL_RPM = 0.5; // a command below this asks the wheels to stand still

/** The staircase as drive-core program steps; `maxLinear` is the bridge's limit [m/s]. */
function benchSteps(maxLinear) {
  if (!(maxLinear > 0)) throw new Error('maxLinear must be positive');
  const steps = [{ seconds: BENCH_LEAD, linear: 0, angular: 0, percent: 0 }];
  for (const percent of BENCH_PERCENTS)
    steps.push({ seconds: BENCH_HOLD, linear: (maxLinear * percent) / 100, angular: 0, percent });
  steps.push({ seconds: BENCH_STOP, linear: 0, angular: 0, percent: 0 });
  return steps;
}

/** What live-session's `drive.plan()` returns for the staircase (controller, length, tail). */
function benchPlan(maxLinear) {
  const steps = benchSteps(maxLinear);
  return {
    controller: (elapsed) => programCommand(steps, elapsed),
    seconds: programSeconds(steps),
    tail: BENCH_TAIL,
  };
}

/** Index of the step running `elapsed` seconds into the staircase (the last one after the end). */
function benchStepAt(steps, elapsed) {
  let start = 0;
  for (const [index, step] of steps.entries()) {
    if (elapsed < start + step.seconds) return index;
    start += step.seconds;
  }
  return steps.length - 1;
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value) => Number(value.toFixed(RPM_DIGITS));

/**
 * The table from a recording (the run, a saved file, a record on the robot): one row per held
 * command, in the order they were held, with the mean of each wheel over the steady part of the
 * step (after SETTLE_SECONDS). `recording.conditions.maxLinear` (the staircase's 100 %) turns a
 * command into its percent; without it (a controller run) the percent is null.
 *
 * Returns `{rows: [{number, percent, command, left, right, samples, seconds}], skipped}` —
 * rpm, forward-positive — where `skipped` counts moving holds too short to measure (a short stop
 * is left out without counting).
 */
function benchTable(recording) {
  const { rows } = driveRows(recording);
  const maxLinear = recording.conditions?.maxLinear;
  const programmed = maxLinear > 0;
  const holds = commandHolds(rows, programmed ? PROGRAM_TOLERANCE : STICK_TOLERANCE);
  const table = [];
  let skipped = 0;
  for (const hold of holds) {
    const steady = hold.rows.filter((row) => row.time >= hold.from + SETTLE_SECONDS);
    if (steady.length < MIN_STEADY_SAMPLES) {
      // A short stop (the moment before the first step) is rest, not a step that went unmeasured.
      if (Math.abs(hold.command) > STILL_RPM) skipped += 1;
      continue;
    }
    const commandV = mean(hold.rows.map((row) => row.commandV));
    table.push({
      number: table.length + 1,
      percent: programmed ? Math.round((commandV / maxLinear) * 100) : null,
      command: round(mean(hold.rows.map((row) => row.commandRpm))),
      left: round(mean(steady.map((row) => row.wheels.left))),
      right: round(mean(steady.map((row) => row.wheels.right))),
      samples: steady.length,
      seconds: Number((hold.to - hold.from).toFixed(2)),
    });
  }
  return { rows: table, skipped };
}

/**
 * The numbers the result sentence uses: the fastest step (its percent, command and both wheels),
 * the mean gap between command and measurement over the steps that turned the wheels, and the
 * largest difference between the wheels. null when no step turned the wheels.
 */
function benchSummary(rows) {
  const moving = rows.filter((row) => Math.abs(row.command) > STILL_RPM);
  if (!moving.length) return null;
  const fastest = moving.reduce((best, row) =>
    Math.abs(row.command) > Math.abs(best.command) ? row : best,
  );
  const gaps = moving.map((row) => (row.left + row.right) / 2 - row.command);
  return {
    fastest,
    meanGap: round(mean(gaps)),
    wheelGap: round(Math.max(...moving.map((row) => Math.abs(row.left - row.right)))),
  };
}

export {
  BENCH_PERCENTS,
  BENCH_HOLD,
  SETTLE_SECONDS,
  benchSteps,
  benchPlan,
  benchStepAt,
  benchTable,
  benchSummary,
};
