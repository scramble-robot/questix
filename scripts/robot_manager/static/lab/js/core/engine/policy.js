// Linear policy over hand-made features, the rollout loop and the evaluation summary.
// The feature order is FEATURE_NAMES (constants.js); exported policies rely on it.
import { clamp, wrap } from './maths.js';
import { FEATURES } from './constants.js';

const GOAL_OFFSET_SCALE = 2; // metres; goal offsets are clamped to ±2 m and scaled to ±1
const BEARING_GATE_DISTANCE = 0.5; // metres; bearing features fade out inside this radius
const DISTANCE_SCALE = 2; // metres; the distance feature saturates at 2 m
const DOCK_HEADING_FALLOFF = 1.3; // per metre; docking features only matter near the goal
const OBSTACLE_NEAR = 0.75; // metres; a scan ray shorter than this counts as an obstacle
const OBSTACLE_RANGE = 0.6; // metres; the obstacle feature reaches 1 at 0.15 m
const WHEEL_RPM_SCALE = 160; // sum of both wheels at full speed (2 × 80 RPM)
const YAW_RATE_SCALE = 180; // deg/s
const SCAN_FRONT = 0;
const SCAN_LEFT_FRONT = 21; // -45°, clockwise-positive headings so the left is negative
const SCAN_RIGHT_FRONT = 3; // +45°
const SCAN_LEFT = 18; // -90°
const SCAN_RIGHT = 6; // +90°
const SCAN_REAR = 12; // 180°
const TURN_COMMAND_SCALE = 0.7; // the turn output is limited to ±0.7 of a full command
const ROLLOUT_STEPS = 350; // control periods, 35 s at CONTROL_DT

/** Fixed continuous features, shared by browser training and exported policy inference. */
function features(observation) {
  const { x, y, theta } = observation.odometry;
  const goal = observation.goal;
  const dx = goal.x - x;
  const dy = goal.y - y;
  const distance = Math.hypot(dx, dy);
  const bearing = wrap(Math.atan2(dy, dx) - theta);
  const bearingGate = Math.min(1, distance / BEARING_GATE_DISTANCE);
  const nearGoal = Math.exp(-distance * DOCK_HEADING_FALLOFF);
  const obstacle = (index) =>
    clamp((OBSTACLE_NEAR - observation.scan[index]) / OBSTACLE_RANGE, 0, 1);
  const dockHeadingError = wrap(goal.theta - theta);
  const docking = observation.task === 'dock' ? 1 : 0;
  // Goal offset in the robot frame: forward along the heading, left is the clockwise normal.
  const goalForward = clamp((dx * Math.cos(theta) + dy * Math.sin(theta)) / GOAL_OFFSET_SCALE);
  const goalLeft = clamp((-dx * Math.sin(theta) + dy * Math.cos(theta)) / GOAL_OFFSET_SCALE);
  // Lateral offset from the docking axis, positive to the port's left.
  const dockLateral = dy * Math.cos(goal.theta) - dx * Math.sin(goal.theta);
  return [
    goalForward,
    goalLeft,
    Math.sin(bearing) * bearingGate,
    (1 - Math.cos(bearing)) * bearingGate,
    Math.min(1, distance / DISTANCE_SCALE),
    Math.sin(dockHeadingError) * nearGoal * docking,
    (observation.wheelRpm[0] + observation.wheelRpm[1]) / WHEEL_RPM_SCALE,
    observation.imu.gyro[2] / YAW_RATE_SCALE,
    obstacle(SCAN_FRONT),
    obstacle(SCAN_LEFT_FRONT),
    obstacle(SCAN_RIGHT_FRONT),
    obstacle(SCAN_LEFT),
    obstacle(SCAN_RIGHT),
    obstacle(SCAN_REAR),
    Math.cos(bearing) * bearingGate,
    dockLateral * nearGoal * docking,
  ];
}

/** Linear policy: weights [0, FEATURES) drive speed, [FEATURES, 2·FEATURES) drive turning. */
function act(weights, observation) {
  const input = features(observation);
  let speed = 0;
  let turn = 0;
  for (let i = 0; i < FEATURES; i++) {
    speed += weights[i] * input[i];
    turn += weights[FEATURES + i] * input[i];
  }
  speed = Math.tanh(speed);
  turn = Math.tanh(turn) * TURN_COMMAND_SCALE;
  // Positive turn speeds the left wheel: clockwise on screen, as headings are.
  return [clamp(speed + turn), clamp(speed - turn)];
}

/** Sum of the absolute wheel-RPM changes between two commands, averaged over the wheels. */
function commandChangeRpm(command, previous, maxRpm) {
  const change = Math.abs(command[0] - previous[0]) + Math.abs(command[1] - previous[1]);
  return (change * maxRpm) / 2;
}

function traceFrame(world, result, command) {
  return {
    ...world.snapshot(),
    reward: result.reward,
    pieces: result.pieces,
    impact: result.impact,
    axPeak: result.axPeak,
    ayPeak: result.ayPeak,
    events: result.trace,
    command,
  };
}

/** Runs one episode of the policy from a seeded reset and reports its outcome. */
function rollout(
  world,
  weights,
  seed = 10,
  { other = false, startRange = 0, capture = false, initial, randomize } = {},
) {
  world.reset(seed, { other, startRange, initial, randomize });
  const trace = [];
  let last;
  let previousCommand = [0, 0];
  let commandChange = 0;
  if (capture) trace.push({ ...world.snapshot(), reward: 0, pieces: [], impact: 0 });
  for (let i = 0; i < ROLLOUT_STEPS; i++) {
    const command = act(weights, world.observation);
    commandChange += commandChangeRpm(command, previousCommand, world.physics.maxRpm);
    previousCommand = command;
    last = world.step(command, { capture });
    if (capture) trace.push(traceFrame(world, last, command));
    if (last.done) break;
  }
  const state = world.state;
  const distance = Math.hypot(world.goal.x - state.x, world.goal.y - state.y);
  const score = state.total;
  return {
    score,
    totalReward: state.total,
    success: state.success,
    collision: state.collisions > 0,
    emergency: state.latched,
    wrongAngle: state.wrongAngle,
    time: state.t,
    commandRate: state.t > 0 ? commandChange / state.t : 0,
    distance,
    angle: (Math.abs(wrap(state.theta)) * 180) / Math.PI,
    trace,
  };
}

/** Quality statistics are conditioned on successful arrival; failures remain in the success rate. */
function summarizeEvaluation(results) {
  const completed = results.filter((result) => result.success);
  const count = results.length;
  const successCount = completed.length;
  const average = (key) => {
    if (!successCount) return null;
    return completed.reduce((sum, result) => sum + result[key], 0) / successCount;
  };
  return {
    rate: count ? (successCount / count) * 100 : 0,
    count,
    successCount,
    arrivalTime: average('time'),
    commandRate: average('commandRate'),
  };
}

export { features, act, rollout, summarizeEvaluation };
