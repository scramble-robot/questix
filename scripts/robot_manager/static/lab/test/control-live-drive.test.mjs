// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// The feedback-control course on the real robot (js/control/live-drive.js): the step input and the
// learner's PID stopping in front of a wall, checked against a made-up LiDAR.
import test from 'node:test';
import assert from 'node:assert/strict';

import { speedStep, wallApproach, WALL_MIN_GAP, WALL_MAX_SPEED } from '../js/control/live-drive.js';
import { STOP_DISTANCE } from '../js/control/core.js';

const MESSAGES = { tooClose: 'close', noWall: 'none', lost: 'lost', hit: 'hit' };

// A scan with the wall `distance` metres straight ahead (and nothing measured elsewhere).
function wallScan(distance, stamp) {
  const count = 360;
  const increment = (2 * Math.PI) / count;
  return {
    stamp,
    angle_min: -Math.PI,
    angle_increment: increment,
    mount: { x: 0, y: 0, yaw: 0 },
    ranges: Array.from({ length: count }, (_, index) =>
      Math.abs(-Math.PI + index * increment) < 0.1 ? distance : null,
    ),
  };
}

const robotAt = (scan, age = 0, limits = { linear: 0.3, angular: 1 }) => ({
  scan,
  age: () => age,
  limits,
});

test('the real step jumps to the chosen speed and says how much room it needs', () => {
  const step = speedStep(0.2);
  assert.equal(step.controller(0.5).linear, 0);
  assert.equal(step.controller(1.5).linear, 0.2);
  assert.equal(step.controller(step.seconds + 0.1), null);
  assert.ok(Math.abs(step.distance - 1) < 1e-9);
});

test("the learner's PID drives towards the wall and settles at the stop distance", () => {
  const controller = wallApproach(
    { kp: 1.2, ki: 0, kd: 0.3, filter: 0, antiWindup: true },
    MESSAGES,
  );
  let distance = 1.5;
  let time = 0;
  for (let step = 0; step < 150; step++) {
    const command = controller(time, robotAt(wallScan(distance, time)));
    assert.ok(Math.abs(command.linear) <= WALL_MAX_SPEED + 1e-9);
    distance -= command.linear * 0.2; // the wall comes closer as the robot moves forward
    time += 0.2;
  }
  assert.ok(Math.abs(distance - STOP_DISTANCE) < 0.03, `ended at ${distance}`);
});

test('the controller holds its output between scans instead of re-integrating', () => {
  const controller = wallApproach({ kp: 1, ki: 1, kd: 0, filter: 0, antiWindup: true }, MESSAGES);
  const scan = wallScan(1.2, 0);
  const first = controller(0, robotAt(scan));
  assert.deepEqual(controller(0.1, robotAt(scan)), first);
});

test('a stale scan stands still, a lost one ends the run', () => {
  const controller = wallApproach({ kp: 1, ki: 0, kd: 0 }, MESSAGES);
  controller(0, robotAt(wallScan(1.2, 0)));
  assert.deepEqual(controller(0.8, robotAt(wallScan(1.2, 0), 0.8)), { linear: 0, angular: 0 });
  assert.throws(() => controller(2, robotAt(wallScan(1.2, 0), 2)), /lost/);
  const blind = wallApproach({ kp: 1, ki: 0, kd: 0 }, MESSAGES);
  assert.deepEqual(blind(0.2, robotAt(null, Infinity)), { linear: 0, angular: 0 });
  assert.throws(() => blind(2, robotAt(null, Infinity)), /lost/);
});

test('too close to start, no wall ahead, or too close while driving all end the run', () => {
  const gains = { kp: 1, ki: 0, kd: 0 };
  assert.throws(() => wallApproach(gains, MESSAGES)(0, robotAt(wallScan(0.6, 0))), /close/);
  const noWall = { ...wallScan(1, 0), ranges: new Array(360).fill(null) };
  assert.throws(() => wallApproach(gains, MESSAGES)(0, robotAt(noWall)), /none/);
  const controller = wallApproach(gains, MESSAGES);
  controller(0, robotAt(wallScan(1.2, 0)));
  assert.throws(() => controller(1, robotAt(wallScan(WALL_MIN_GAP - 0.01, 1))), /hit/);
});

test("the output is scaled to the bridge's limit when that is lower", () => {
  const controller = wallApproach({ kp: 8, ki: 0, kd: 0 }, MESSAGES);
  const command = controller(0, robotAt(wallScan(2, 0), 0, { linear: 0.1, angular: 1 }));
  assert.ok(Math.abs(command.linear - 0.1) < 1e-9);
});
