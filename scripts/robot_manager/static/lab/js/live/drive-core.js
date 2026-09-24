// Driving the real robot from a lesson: the arithmetic, with no DOM and no WebSocket, so every
// rule is a Node test (test/drive-core.test.mjs). drive-link.js sends what these functions decide.
//
// The bridge (questix_lab_bridge/questix_lab_bridge/drive.py) enforces the safety rules itself:
// allow_drive, no other /target_twist publisher, a drive node listening, emergency stop released,
// one page at a time, speed limits, a dead-man timeout. This module only mirrors them so the page
// can say *why* it cannot drive before the learner presses anything.
//
// Units follow REP-103: metres, radians, seconds; linear > 0 forward, angular > 0 turns left.

// Why this page cannot drive now, in the order they are shown and have to be fixed.
const DRIVE_BLOCKERS = [
  'no_link', // not connected to a robot
  'old_bridge', // the bridge predates driving (no drive_state)
  'not_allowed', // robot_manager has not allowed driving
  'no_drive_node', // nothing subscribes to /target_twist
  'other_publisher', // the controller (or anything else) publishes /target_twist
  'emergency_stop',
  'busy', // another page drives the robot
  'running_here', // this page already runs something (another block, the bench test)
  'missing_streams', // the lesson needs a stream the robot does not send (added by live-session)
  'unconfirmed', // the learner has not confirmed the surroundings are clear
];

/**
 * What the page may do right now. `link` is robot-link's state (`phase`, `session`),
 * `driveState` the bridge's latest `drive_state` (or null), `confirmed` the learner's safety tick.
 * Returns `{ready, blockers: [{code, nodes}], owner: 'me' | 'other' | null, active, limits,
 * lastStop}`; `owner` is who drives the robot at the moment, whatever this page wants.
 */
function driveReadiness({ link, driveState, confirmed, runningHere = false }) {
  const blockers = [];
  const connected = link?.phase === 'open';
  if (!connected) blockers.push({ code: 'no_link', nodes: null });
  else if (!driveState) blockers.push({ code: 'old_bridge', nodes: null });
  const state = connected ? driveState : null;
  for (const blocker of state?.blockers ?? []) {
    if (DRIVE_BLOCKERS.includes(blocker.code))
      blockers.push({ code: blocker.code, nodes: blocker.nodes ?? null });
  }
  const active = Boolean(state?.active);
  const owner = ownerOf(state, link?.session);
  if (owner === 'other') blockers.push({ code: 'busy', nodes: null });
  if (runningHere) blockers.push({ code: 'running_here', nodes: null });
  if (!confirmed) blockers.push({ code: 'unconfirmed', nodes: null });
  blockers.sort((a, b) => DRIVE_BLOCKERS.indexOf(a.code) - DRIVE_BLOCKERS.indexOf(b.code));
  return {
    ready: blockers.length === 0,
    blockers,
    owner,
    active,
    limits: state?.limits ?? null,
    lastStop: state?.last_stop ?? null,
    allowed: Boolean(state?.allowed),
  };
}

function ownerOf(state, session) {
  if (!state?.active || state.owner === null || state.owner === undefined) return null;
  return state.owner === session ? 'me' : 'other';
}

// --- open-loop programs --------------------------------------------------------------------
// A program is a list of `{seconds, linear, angular}` held one after another.

const clampTo = (value, limit) => Math.max(-limit, Math.min(limit, value));

/** Clamp a command to the bridge's limits, so the page never asks for what will be cut anyway. */
function limitCommand(command, limits) {
  if (!limits) return command;
  return {
    linear: clampTo(command.linear, limits.linear),
    angular: clampTo(command.angular, limits.angular),
  };
}

/**
 * The step input of the speed lessons: stand still for `lead` seconds (so the recording shows the
 * robot at rest), jump to `speed` [m/s] for `hold` seconds, then stand still for `tail` seconds.
 */
function stepProgram({ speed, lead = 1, hold = 4, tail = 2 }) {
  return [
    { seconds: lead, linear: 0, angular: 0 },
    { seconds: hold, linear: speed, angular: 0 },
    { seconds: tail, linear: 0, angular: 0 },
  ];
}

/**
 * Several held speeds with a stop between them, for the measurement table: each hold becomes one
 * input with repeated measurements (capture-core steadyMeasurements needs >= minHoldSeconds).
 */
function staircaseProgram(speeds, { lead = 1, hold = 3, pause = 1.5 } = {}) {
  const steps = [{ seconds: lead, linear: 0, angular: 0 }];
  for (const speed of speeds) {
    steps.push({ seconds: hold, linear: speed, angular: 0 });
    steps.push({ seconds: pause, linear: 0, angular: 0 });
  }
  return steps;
}

const programSeconds = (steps) => steps.reduce((sum, step) => sum + step.seconds, 0);

/** The command at `elapsed` seconds into the program, or null once it is over. */
function programCommand(steps, elapsed) {
  let start = 0;
  for (const step of steps) {
    if (elapsed < start + step.seconds) return { linear: step.linear, angular: step.angular };
    start += step.seconds;
  }
  return null;
}

// --- closed loop on odometry: drive a distance or turn an angle ------------------------------

// Below these the wheels fall into drive_component's min_command_rpm dead band (5 rpm is about
// 0.05 m/s with 0.1 m wheels) and the robot would stop short instead of creeping to the goal.
const MIN_LINEAR = 0.06; // m/s
const MIN_ANGULAR = 0.3; // rad/s (the wheels then turn at about 0.075 m/s)
const SLOWDOWN = 1.5; // 1/s: speed = SLOWDOWN × what is left, so the robot eases into the goal
const GOAL_TOLERANCE = { distance: 0.005, turn: (1 * Math.PI) / 180 }; // m, rad
const SETTLE_SECONDS = 1; // standing still after the goal, so the recording shows the stop

const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

/**
 * A goal measured by /odom: `{kind: 'distance', target}` drives `target` metres (negative =
 * backwards), `{kind: 'turn', target}` turns `target` radians (positive = left), at up to `speed`
 * (m/s or rad/s). `update(odom, elapsed)` returns the command, or null once the goal has been
 * reached and the robot has stood still for SETTLE_SECONDS. `progress` is how far it got.
 */
function createOdomGoal({ kind, target, speed }) {
  let start = null;
  let previousTheta = null;
  let turned = 0;
  let reachedAt = null;
  const goal = {
    progress: 0,
    reached: false,
    update(odom, elapsed) {
      if (!odom || ![odom.x, odom.y, odom.theta].every(Number.isFinite)) return stopped();
      if (!start) start = { x: odom.x, y: odom.y, theta: odom.theta };
      if (previousTheta !== null) turned += wrapAngle(odom.theta - previousTheta);
      previousTheta = odom.theta;
      goal.progress = kind === 'turn' ? turned : alongStart(start, odom);
      const left = target - goal.progress;
      if (!goal.reached && Math.abs(left) <= GOAL_TOLERANCE[kind] + 1e-12) goal.reached = true;
      // Past the goal counts as reached too: backing up to it would be a second, different drive.
      if (!goal.reached && Math.sign(left) !== Math.sign(target)) goal.reached = true;
      if (goal.reached) {
        reachedAt ??= elapsed;
        return elapsed - reachedAt >= SETTLE_SECONDS ? null : stopped();
      }
      const minimum = kind === 'turn' ? MIN_ANGULAR : MIN_LINEAR;
      const magnitude = Math.min(speed, Math.max(minimum, SLOWDOWN * Math.abs(left)));
      const value = Math.sign(left) * magnitude;
      return kind === 'turn' ? { linear: 0, angular: value } : { linear: value, angular: 0 };
    },
  };
  return goal;
}

const stopped = () => ({ linear: 0, angular: 0 });

// Distance along the heading the robot started with (a sideways slip does not count as progress).
function alongStart(start, odom) {
  return (odom.x - start.x) * Math.cos(start.theta) + (odom.y - start.y) * Math.sin(start.theta);
}

export {
  DRIVE_BLOCKERS,
  driveReadiness,
  limitCommand,
  stepProgram,
  staircaseProgram,
  programSeconds,
  programCommand,
  createOdomGoal,
  MIN_LINEAR,
  MIN_ANGULAR,
};
