import { programCommand, programSeconds } from '../live/drive-core.js';
import { commandHolds } from '../live/capture-core.js';
import { driveRows } from '../live/recording-core.js';

// The motor course's bench measurement of the drive wheels (topic `real`): with the wheels lifted
// on a stand, the page asks for a staircase of speeds and the table 「指令 → 測った回転数（左・右）」
// is filled from what the wheels reported. No DOM (test/motor-bench.test.mjs); ui.js hands the
// program to live-session.js (whose drive-link.js is the only sender) and the recording back here.
//
// Speeds are fractions of the fastest forward speed the bridge lets a page ask for
// (drive_state.limits.linear), so the staircase stays inside the bridge's clamp on every robot.

const BENCH_PERCENTS = [30, 50, 70, 50, 30]; // % of the allowed forward speed, up and back down; 30 % (about 9 rpm) stays clear of the drive's ~5 rpm dead band
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

/**
 * The bench table as rows of the measurement lab (js/systems/measurement-lab.js, 「分析に使う」):
 * every step that turned the wheels gives two measurements of the same input, the left and the
 * right wheel. The input is the step's percent (a staircase of this page) or, for a table from a
 * controller run, the commanded rpm. On a staircase, the steps after the fastest one (the way back
 * down) are kept for checking the line (`test`), so the fitted line is tried on steps it was not
 * made from. The stop step is left out: standing still says nothing about the slope.
 *
 * Returns `{rows: [{x, y, test, from}], input: 'percent' | 'rpm'}`.
 */
function benchMeasurementRows(rows, from = '') {
  const moving = rows.filter((row) => Math.abs(row.command) > STILL_RPM);
  const byPercent = moving.length > 0 && moving.every((row) => row.percent !== null);
  let peak = 0;
  for (const [index, row] of moving.entries())
    if (Math.abs(row.command) > Math.abs(moving[peak].command)) peak = index;
  const measured = moving.flatMap((row, index) => {
    const x = byPercent ? row.percent : row.command;
    const test = byPercent && index > peak;
    return [
      { x, y: row.left, test, from },
      { x, y: row.right, test, from },
    ];
  });
  return { rows: measured, input: byPercent ? 'percent' : 'rpm' };
}

// For a class without a robot: a table as the staircase gives it on a robot whose fastest allowed
// forward speed turns the wheels at about 30 rpm (a little slower than asked, the left wheel a
// little slower than the right). An example, never shown as a measurement.
const BENCH_SAMPLE_ROWS = Object.freeze(
  [
    [30, 9.1, 8.4, 8.8],
    [50, 15.2, 14.5, 15.0],
    [70, 21.3, 20.6, 21.0],
    [50, 15.2, 14.7, 15.1],
    [30, 9.1, 8.6, 8.9],
    [0, 0, 0, 0],
  ].map(([percent, command, left, right], index) =>
    Object.freeze({
      number: index + 1,
      percent,
      command,
      left,
      right,
      samples: 30,
      seconds: BENCH_HOLD,
    }),
  ),
);

export {
  BENCH_SAMPLE_ROWS,
  benchMeasurementRows,
  BENCH_PERCENTS,
  BENCH_HOLD,
  SETTLE_SECONDS,
  benchSteps,
  benchPlan,
  benchStepAt,
  benchTable,
  benchSummary,
};
