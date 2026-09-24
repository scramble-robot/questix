// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// Driving the real robot from a lesson (js/live/drive-core.js): what the page tells the learner
// before anything moves, and what the programs command.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  driveReadiness,
  limitCommand,
  stepProgram,
  staircaseProgram,
  programSeconds,
  programCommand,
  createOdomGoal,
  MIN_LINEAR,
} from '../js/live/drive-core.js';

const OPEN = { phase: 'open', session: 3 };
const readyState = {
  allowed: true,
  blockers: [],
  owner: null,
  active: false,
  limits: { linear: 0.3, angular: 1 },
  last_stop: null,
};

test('ready only with a link, a bridge that allows driving, no blockers and the safety tick', () => {
  assert.equal(driveReadiness({ link: OPEN, driveState: readyState, confirmed: true }).ready, true);
  const codes = (input) => driveReadiness(input).blockers.map((blocker) => blocker.code);
  assert.deepEqual(codes({ link: { phase: 'idle' }, driveState: null, confirmed: true }), [
    'no_link',
  ]);
  assert.deepEqual(codes({ link: OPEN, driveState: null, confirmed: false }), [
    'old_bridge',
    'unconfirmed',
  ]);
  assert.deepEqual(codes({ link: OPEN, driveState: readyState, confirmed: false }), [
    'unconfirmed',
  ]);
});

test("the bridge's blockers come first, in the order they have to be fixed", () => {
  const driveState = {
    ...readyState,
    blockers: [
      { code: 'emergency_stop', nodes: null },
      { code: 'other_publisher', nodes: ['/joy_controller'] },
    ],
  };
  const readiness = driveReadiness({ link: OPEN, driveState, confirmed: false });
  assert.deepEqual(readiness.blockers, [
    { code: 'other_publisher', nodes: ['/joy_controller'] },
    { code: 'emergency_stop', nodes: null },
    { code: 'unconfirmed', nodes: null },
  ]);
});

test('another page driving blocks this one; driving ourselves does not', () => {
  const other = { ...readyState, active: true, owner: 9 };
  const busy = driveReadiness({ link: OPEN, driveState: other, confirmed: true });
  assert.equal(busy.owner, 'other');
  assert.deepEqual(
    busy.blockers.map((blocker) => blocker.code),
    ['busy'],
  );
  const mine = driveReadiness({
    link: OPEN,
    driveState: { ...other, owner: 3 },
    confirmed: true,
  });
  assert.equal(mine.owner, 'me');
  assert.equal(mine.ready, true);
});

test('a lost link hides what a stale drive_state said', () => {
  const stale = { ...readyState, active: true, owner: 9 };
  const readiness = driveReadiness({
    link: { phase: 'error' },
    driveState: stale,
    confirmed: true,
  });
  assert.equal(readiness.owner, null);
  assert.equal(readiness.active, false);
});

test('commands are clamped to the limits', () => {
  assert.deepEqual(limitCommand({ linear: 1, angular: -3 }, { linear: 0.3, angular: 1 }), {
    linear: 0.3,
    angular: -1,
  });
  assert.deepEqual(limitCommand({ linear: 1, angular: 0 }, null), { linear: 1, angular: 0 });
});

test('a step program stands still, jumps, holds and stops', () => {
  const steps = stepProgram({ speed: 0.2, lead: 1, hold: 4, tail: 2 });
  assert.equal(programSeconds(steps), 7);
  assert.deepEqual(programCommand(steps, 0.5), { linear: 0, angular: 0 });
  assert.deepEqual(programCommand(steps, 1), { linear: 0.2, angular: 0 });
  assert.deepEqual(programCommand(steps, 4.99), { linear: 0.2, angular: 0 });
  assert.deepEqual(programCommand(steps, 6), { linear: 0, angular: 0 });
  assert.equal(programCommand(steps, 7), null);
});

test('a staircase holds each speed with a stop in between', () => {
  const steps = staircaseProgram([0.1, -0.1], { lead: 1, hold: 3, pause: 1.5 });
  assert.equal(programSeconds(steps), 1 + 2 * (3 + 1.5));
  assert.equal(programCommand(steps, 2).linear, 0.1);
  assert.equal(programCommand(steps, 4.5).linear, 0);
  assert.equal(programCommand(steps, 6).linear, -0.1);
});

// A robot that does exactly what it is told, integrated at 10 Hz (drive-link's heartbeat).
function simulate(goal, { heading = 0, seconds = 20 } = {}) {
  const pose = { x: 1, y: 2, theta: heading };
  const commands = [];
  for (let time = 0; time <= seconds; time += 0.1) {
    const command = goal.update({ ...pose }, time);
    if (!command) return { pose, commands, time };
    commands.push(command);
    pose.x += command.linear * Math.cos(pose.theta) * 0.1;
    pose.y += command.linear * Math.sin(pose.theta) * 0.1;
    pose.theta += command.angular * 0.1;
  }
  return { pose, commands, time: Infinity };
}

test('an odometry goal drives the distance along its start heading, easing in', () => {
  const goal = createOdomGoal({ kind: 'distance', target: 0.5, speed: 0.2 });
  const { commands, time } = simulate(goal, { heading: Math.PI / 2 });
  assert.ok(Number.isFinite(time), 'the goal ends');
  assert.ok(Math.abs(goal.progress - 0.5) < 0.01, `progress ${goal.progress}`);
  assert.ok(commands.every((command) => command.linear <= 0.2 && command.angular === 0));
  const moving = commands.filter((command) => command.linear > 0);
  // Slows down near the goal, but never below the drive's dead band.
  assert.ok(moving.at(-1).linear < 0.2);
  assert.ok(moving.every((command) => command.linear >= MIN_LINEAR - 1e-9));
  // It stands still for a second after the goal, so the recording shows the stop.
  assert.deepEqual(commands.at(-1), { linear: 0, angular: 0 });
});

test('a turn goal counts the angle across the ±180° wrap', () => {
  const goal = createOdomGoal({ kind: 'turn', target: Math.PI / 2, speed: 0.8 });
  const { time } = simulate(goal, { heading: Math.PI - 0.3 });
  assert.ok(Number.isFinite(time));
  assert.ok(Math.abs(goal.progress - Math.PI / 2) < 0.03, `progress ${goal.progress}`);
});

test('a goal without odometry stands still instead of guessing', () => {
  const goal = createOdomGoal({ kind: 'distance', target: 0.5, speed: 0.2 });
  assert.deepEqual(goal.update(null, 0), { linear: 0, angular: 0 });
  assert.deepEqual(goal.update({ x: NaN, y: 0, theta: 0 }, 0.1), { linear: 0, angular: 0 });
});
