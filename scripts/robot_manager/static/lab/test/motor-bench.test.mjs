// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// The motor course's bench measurement (js/motor/bench-core.js): the staircase the page commands
// and the table 「指示 → 測った回転数（左・右）」 it fills from the recording.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BENCH_PERCENTS,
  benchSteps,
  benchPlan,
  benchStepAt,
  benchTable,
  benchSummary,
} from '../js/motor/bench-core.js';
import {
  makeRecording,
  withRunInfo,
  serializeRecording,
  parseRecording,
} from '../js/live/recording-core.js';
import { programSeconds } from '../js/live/drive-core.js';

const config = { wheel_radius: 0.1, wheel_separation: 0.5 };
const MAX_LINEAR = 0.3; // m/s, lab_bridge.yaml drive_max_linear
const RATE = 20; // Hz, drive_max_hz / twist_max_hz
const LAG = 0.2; // s, the wheels' first-order lag in the fake measurement
const RPM_PER_MPS = 60 / (2 * Math.PI * config.wheel_radius);

// What the robot would send while the page runs the staircase: the command the page held
// (/target_twist) and a wheel speed that follows it with a lag; the right wheel turns `skew` m/s
// faster than the left (a robot that pulls to the left), the stamps start at `start`.
function staircaseRecording({ skew = 0, start = 100, conditions = { maxLinear: MAX_LINEAR } }) {
  const steps = benchSteps(MAX_LINEAR);
  const plan = benchPlan(MAX_LINEAR);
  const drive = [];
  const twist = [];
  let speed = 0;
  const count = Math.round((plan.seconds + plan.tail) * RATE);
  for (let index = 0; index < count; index++) {
    const elapsed = index / RATE;
    const command = plan.controller(elapsed) ?? { linear: 0, angular: 0 };
    speed += ((command.linear - speed) / LAG) * (1 / RATE);
    const stamp = start + elapsed;
    twist.push({ type: 'twist', stamp, linear: command.linear, angular: command.angular });
    // v and w of /drive_status: the mean of both wheels, and their difference over the track.
    const w = skew / config.wheel_separation;
    drive.push({ type: 'drive', stamp: stamp + 0.01, v: speed, w, emergency_stop: false });
  }
  assert.equal(steps.length, BENCH_PERCENTS.length + 2);
  const recording = makeRecording({
    source: 'live',
    name: '',
    recordedAt: '2026-09-25T01:00:00.000Z',
    config,
    streams: { drive, twist },
  });
  return conditions ? withRunInfo(recording, { conditions }) : recording;
}

test('the staircase goes up to 70 % of the limit and back, then stops', () => {
  const steps = benchSteps(MAX_LINEAR);
  assert.deepEqual(
    steps.map((step) => step.percent),
    [0, 30, 50, 70, 50, 30, 0],
  );
  assert.ok(steps.every((step) => step.angular === 0));
  // Never faster than the bridge's clamp, and short enough for one run (drive_max_run_sec 30 s).
  assert.ok(Math.max(...steps.map((step) => step.linear)) <= MAX_LINEAR);
  assert.ok(programSeconds(steps) < 30);
  assert.throws(() => benchSteps(0));
  assert.throws(() => benchSteps(NaN));
});

test('the plan holds each step and ends the run after the last one', () => {
  const plan = benchPlan(MAX_LINEAR);
  assert.deepEqual(plan.controller(0.5), { linear: 0, angular: 0 });
  assert.equal(plan.controller(1.1).linear.toFixed(3), (0.3 * MAX_LINEAR).toFixed(3));
  assert.equal(plan.controller(6.2).linear.toFixed(3), (0.7 * MAX_LINEAR).toFixed(3));
  assert.equal(plan.controller(plan.seconds + 0.01), null);
  assert.ok(plan.tail > 0);
});

test('benchStepAt names the step a moment of the run belongs to', () => {
  const steps = benchSteps(MAX_LINEAR);
  assert.equal(benchStepAt(steps, 0), 0);
  assert.equal(benchStepAt(steps, 0.99), 0);
  assert.equal(benchStepAt(steps, 1), 1);
  assert.equal(benchStepAt(steps, 6.1), 3);
  assert.equal(benchStepAt(steps, 999), steps.length - 1);
});

test('the table has one row per step with the steady mean of each wheel', () => {
  const { rows, skipped } = benchTable(staircaseRecording({}));
  // The one second standing still before the first step is too short to measure; it is rest, so
  // it is left out without being reported as a step that could not be measured.
  assert.equal(skipped, 0);
  assert.deepEqual(
    rows.map((row) => row.percent),
    [30, 50, 70, 50, 30, 0],
  );
  assert.deepEqual(
    rows.map((row) => row.number),
    [1, 2, 3, 4, 5, 6],
  );
  for (const row of rows) {
    const expected = (row.percent / 100) * MAX_LINEAR * RPM_PER_MPS;
    assert.ok(Math.abs(row.command - expected) < 0.06, `command ${row.command} vs ${expected}`);
    // Past the first second the lagged wheel has settled to within a few hundredths of an rpm.
    assert.ok(Math.abs(row.left - expected) < 0.2, `left ${row.left} vs ${expected}`);
    assert.ok(Math.abs(row.right - expected) < 0.2, `right ${row.right} vs ${expected}`);
    assert.ok(row.samples >= 20);
  }
});

test('the two wheels are measured separately', () => {
  const skew = 0.02; // m/s faster on the right
  const { rows } = benchTable(staircaseRecording({ skew }));
  const gap = skew * RPM_PER_MPS; // right minus left, rpm
  for (const row of rows) assert.ok(Math.abs(row.right - row.left - gap) < 0.1);
  const summary = benchSummary(rows);
  assert.equal(summary.fastest.percent, 70);
  assert.ok(Math.abs(summary.wheelGap - gap) < 0.1);
  assert.ok(Math.abs(summary.meanGap) < 0.2);
});

test('a reopened file gives the same table as the recording', () => {
  const recording = staircaseRecording({ skew: 0.01 });
  const reopened = parseRecording(serializeRecording(recording));
  assert.deepEqual(benchTable(reopened), benchTable(recording));
});

test('a controller run (no staircase conditions) has no percent', () => {
  const { rows } = benchTable(staircaseRecording({ conditions: null }));
  assert.ok(rows.length >= 5);
  assert.ok(rows.every((row) => row.percent === null));
});

test('a moving step too short to measure is counted as skipped', () => {
  const recording = staircaseRecording({});
  // Cut the recording 1.1 s into the third step (70 %): its steady part is too short.
  const end = 100 + 1 + 2 * 2.5 + 1.1;
  const cut = {
    ...recording,
    streams: {
      drive: recording.streams.drive.filter((message) => message.stamp < end),
      twist: recording.streams.twist.filter((message) => message.stamp < end),
    },
  };
  const { rows, skipped } = benchTable(cut);
  assert.deepEqual(
    rows.map((row) => row.percent),
    [30, 50],
  );
  assert.equal(skipped, 1);
});

test('a recording without a held command gives an empty table, and no summary', () => {
  const recording = makeRecording({
    source: 'live',
    name: '',
    recordedAt: '2026-09-25T01:00:00.000Z',
    config,
    streams: {
      drive: [0, 0.05, 0.1].map((stamp) => ({ type: 'drive', stamp, v: 0, w: 0 })),
      twist: [],
    },
  });
  assert.deepEqual(benchTable(recording), { rows: [], skipped: 0 });
  assert.equal(benchSummary([]), null);
  assert.equal(
    benchSummary([
      { number: 1, percent: 0, command: 0, left: 0, right: 0, samples: 10, seconds: 2 },
    ]),
    null,
  );
});
