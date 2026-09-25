// What one driving run did, from its recording: the numbers and the curves the run report draws,
// plus the small wording helpers of the report. No DOM: test/drive-report-core.test.mjs checks it
// with made-up recordings.
//
// Time is counted from the first moving command of the run (the moment the page took over), in the
// robot's own clock (message stamps), so a reopened file gives the same report. The path is turned
// so the robot starts at the origin facing up the page: x forward, y left at the start (REP-103).

import { frontDistance, wheelRpm } from './capture-core.js';
import { commandZero } from './recording-core.js';
import { fillSentence as fill } from '../core/content.js';

const STILL_LINEAR = 0.02; // m/s: slower than this counts as standing
const STILL_ANGULAR = 0.05; // rad/s
const COMMANDED = 1e-3; // |command| above this is "moving"
const REPORT_PERIOD = 0.1; // s: the kept report is thinned to 10 samples a second
const PATH_STEP = 0.01; // m: path points closer than this to the previous one are dropped
// A run below all three of these did practically nothing and is not worth a report.
const MOVED_DISTANCE = 0.01; // m of path
const MOVED_TURN = (2 * Math.PI) / 180; // rad of heading change

const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
const finite = (...values) => values.every(Number.isFinite);

// The first moving command (recording-core commandZero): the same zero as the lesson charts and
// the saved table.
const startTime = commandZero;

const commandSeries = (recording, t0) =>
  (recording.streams.twist ?? [])
    .filter((message) => finite(message.linear, message.angular))
    .map((message) => ({ t: message.stamp - t0, v: message.linear, w: message.angular }));

const measuredSeries = (recording, t0) =>
  (recording.streams.drive ?? [])
    .filter((message) => finite(message.v, message.w))
    .map((message) => ({
      t: message.stamp - t0,
      v: message.v,
      w: message.w,
      estop: Boolean(message.emergency_stop),
    }));

// Odometry relative to the first pose, rotated so the start heading is +x; `turn` is unwrapped.
function pathSeries(recording, t0) {
  const odoms = (recording.streams.odom ?? []).filter((message) =>
    finite(message.x, message.y, message.theta),
  );
  if (!odoms.length) return [];
  const start = odoms[0];
  const cos = Math.cos(-start.theta);
  const sin = Math.sin(-start.theta);
  let turn = 0;
  let previous = start.theta;
  return odoms.map((message) => {
    turn += wrapAngle(message.theta - previous);
    previous = message.theta;
    const dx = message.x - start.x;
    const dy = message.y - start.y;
    return { t: message.stamp - t0, x: dx * cos - dy * sin, y: dx * sin + dy * cos, turn };
  });
}

const frontSeries = (recording, t0) =>
  (recording.streams.scan ?? [])
    .map((scan) => ({ t: scan.stamp - t0, d: frontDistance(scan) }))
    .filter((sample) => sample.d !== null);

function pathLength(path, from = -Infinity, to = Infinity) {
  let length = 0;
  for (let index = 1; index < path.length; index++) {
    if (path[index].t <= from || path[index - 1].t >= to) continue;
    length += Math.hypot(path[index].x - path[index - 1].x, path[index].y - path[index - 1].y);
  }
  return length;
}

// Indices of the first and the last command that asked for motion, or null when none did.
function movingSpan(command) {
  const moving = (sample) => Math.abs(sample.v) > COMMANDED || Math.abs(sample.w) > COMMANDED;
  const first = command.findIndex(moving);
  if (first < 0) return null;
  return { first, last: command.findLastIndex(moving) };
}

/**
 * How long the page asked the robot to move: from the first moving command to the zero command
 * that followed the last one (or to the last moving command when no zero came). Null when the run
 * never commanded motion. Unlike `seconds`, this leaves out the recording after the stop.
 */
function driveTime(command) {
  const span = movingSpan(command);
  if (!span) return null;
  const end = command[span.last + 1] ?? command[span.last];
  return end.t - command[span.first].t;
}

/**
 * How the robot stopped at the end: from the first zero command after the last moving one, how
 * long until the measured speed fell below STILL_* and how far it rolled meanwhile. Null when the
 * run never commanded motion, or the robot had not come to rest by the end of the recording.
 * drive_component low-pass filters the measured speed, so `delay` includes that filter's lag.
 */
function stopping(command, measured, path) {
  const span = movingSpan(command);
  const zero = span && command[span.last + 1];
  if (!zero) return null;
  const still = measured.find(
    (sample) =>
      sample.t >= zero.t && Math.abs(sample.v) < STILL_LINEAR && Math.abs(sample.w) < STILL_ANGULAR,
  );
  if (!still) return null;
  return { at: zero.t, delay: still.t - zero.t, distance: pathLength(path, zero.t, still.t) };
}

// False when the robot practically stood still: under MOVED_DISTANCE of path, under MOVED_TURN
// of heading change, and no command ever asked it to move.
function hasMoved(distance, turn, command) {
  if (distance >= MOVED_DISTANCE) return true;
  if (Number.isFinite(turn) && Math.abs(turn) >= MOVED_TURN) return true;
  return movingSpan(command) !== null;
}

const peak = (samples, key) => Math.max(0, ...samples.map((sample) => Math.abs(sample[key])));

// Keeps at most one sample per `period` seconds (the first of each), for a report small enough
// to store in the browser; the full recording stays available for saving.
function thin(samples, period) {
  const kept = [];
  let next = -Infinity;
  for (const sample of samples) {
    if (sample.t < next) continue;
    kept.push(sample);
    next = sample.t + period;
  }
  return kept;
}

function thinPath(path) {
  const kept = [];
  for (const point of path) {
    const last = kept[kept.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= PATH_STEP) kept.push(point);
  }
  const end = path[path.length - 1];
  if (end && kept[kept.length - 1] !== end) kept.push(end);
  return kept;
}

/**
 * The report of one run: `{series: {command, measured, path, front}, summary}`. Series are thinned
 * for display and storage. `summary` has `seconds` (length of the recording, including the tail
 * recorded after the stop), `driveSeconds` (driveTime(), or null), `distance` (path length, m),
 * `forward` / `left` (where it ended, m), `turn` (rad, + = left), `maxSpeed`, `maxTurnRate`,
 * `maxCommand`, `stop` (stopping(), or null), `emergencyStop`, `closest` (nearest wall ahead, m,
 * or null) and `moved` (hasMoved()).
 */
function driveReport(recording) {
  const t0 = startTime(recording);
  const command = commandSeries(recording, t0);
  const measured = measuredSeries(recording, t0);
  const path = pathSeries(recording, t0);
  const front = frontSeries(recording, t0);
  const times = [command, measured, path, front].flatMap((list) =>
    list.length ? [list[list.length - 1].t] : [],
  );
  const end = path[path.length - 1];
  const distance = pathLength(path);
  return {
    series: {
      command: thin(command, REPORT_PERIOD / 2),
      measured: thin(measured, REPORT_PERIOD),
      path: thinPath(path),
      front: front.map((sample) => ({ t: sample.t, d: sample.d })),
    },
    summary: {
      seconds: times.length ? Math.max(0, ...times) : 0,
      driveSeconds: driveTime(command),
      distance,
      forward: end?.x ?? null,
      left: end?.y ?? null,
      turn: end?.turn ?? null,
      maxSpeed: peak(measured, 'v'),
      maxTurnRate: peak(measured, 'w'),
      maxCommand: peak(command, 'v'),
      stop: stopping(command, measured, path),
      emergencyStop: measured.some((sample) => sample.estop),
      closest: front.length ? Math.min(...front.map((sample) => sample.d)) : null,
      moved: hasMoved(distance, end?.turn, command),
    },
  };
}

// True when the recording shows the robot practically not moving (see hasMoved); such a run is
// not worth keeping in the history.
const isEmptyRun = (recording) => !driveReport(recording).summary.moved;

// --- wording helpers (the sentences come from content/live/drive-report.json) ------------------

// How a run ended, from drive-link's reason: 'ok' ran as planned, 'stopped' the learner (or the
// page being hidden) stopped it, 'problem' the robot or the link stopped it. Unknown: 'stopped'.
const RUN_STATUS = {
  done: 'ok',
  stopped: 'stopped',
  stopped_other: 'stopped',
  hidden: 'stopped',
  timeout: 'problem',
  time_limit: 'problem',
  disconnected: 'problem',
  lost: 'problem',
  emergency_stop: 'problem',
  other_publisher: 'problem',
  no_drive_node: 'problem',
  not_allowed: 'problem',
  invalid: 'problem',
  failed: 'problem',
  no_answer: 'problem',
  // A hand on the controller's stick took the robot over: meant to happen, not a fault.
  controller: 'stopped',
};
const runStatusKind = (reason) => RUN_STATUS[reason] ?? 'stopped';

/**
 * The key of the words for how a run ended (drive-report.json `status`): the kind of
 * runStatusKind, except that a controller takeover has words of its own.
 */
const runStatusKey = (reason) => (reason === 'controller' ? 'controller' : runStatusKind(reason));

// --- the bench test: which way did the wheels turn? ---------------------------------------------

const BENCH_SETTLE = 0.3; // s after the first command before the wheels count as up to speed
const BENCH_TURNING = 2; // rpm: a wheel slower than this counts as standing
const BENCH_EVEN = 0.25; // wheels within this share of each other count as equally fast

/**
 * What the wheels did during a bench press, from its recording: the mean measured rpm of each
 * wheel (forward positive) while the press lasted, and the movement that follows from them —
 * 'forward', 'backward', 'left', 'right' (on the spot), 'forwardLeft', 'forwardRight',
 * 'backwardLeft', 'backwardRight' (driving while turning), or 'still'. Null when the recording has no wheel measurement then.
 */
function benchCheck(recording) {
  const zero = commandZero(recording);
  const commands = (recording.streams.twist ?? []).filter((message) =>
    finite(message.linear, message.angular),
  );
  const moving = commands.filter(
    (message) => Math.abs(message.linear) > COMMANDED || Math.abs(message.angular) > COMMANDED,
  );
  const end = moving.length ? moving[moving.length - 1].stamp : Infinity;
  const held = (recording.streams.drive ?? []).filter(
    (message) =>
      finite(message.v, message.w) && message.stamp >= zero + BENCH_SETTLE && message.stamp <= end,
  );
  if (!held.length) return null;
  const wheels = held.map((message) => wheelRpm(message, recording.config));
  const mean = (side) => wheels.reduce((sum, rpm) => sum + rpm[side], 0) / wheels.length;
  const left = mean('left');
  const right = mean('right');
  return { left, right, move: benchMove(left, right) };
}

function benchMove(left, right) {
  const turningLeft = Math.abs(left) >= BENCH_TURNING;
  const turningRight = Math.abs(right) >= BENCH_TURNING;
  if (!turningLeft && !turningRight) return 'still';
  const turn = right - left; // + = the robot turns left (REP-103)
  if (turningLeft && turningRight && Math.sign(left) !== Math.sign(right))
    return turn > 0 ? 'left' : 'right';
  const direction = left + right > 0 ? 'forward' : 'backward';
  const even = Math.abs(turn) <= BENCH_EVEN * Math.max(Math.abs(left), Math.abs(right));
  if (even) return direction;
  return direction + (turn > 0 ? 'Left' : 'Right');
}

const degreesOf = (radians) => (radians * 180) / Math.PI;

/** 「左へ43°」 / 「右へ12°」 / 「0°」 from a heading change in rad (+ = left, REP-103). */
function describeTurn(radians, copy) {
  if (!Number.isFinite(radians)) return copy.none;
  const degrees = Math.round(Math.abs(degreesOf(radians)));
  if (degrees === 0) return copy.turnNone;
  return fill(radians > 0 ? copy.turnLeft : copy.turnRight, { degrees });
}

// One axis of the end position: the word follows the sign, the number is always positive.
function describeAxis(metres, [positive, negative, zero]) {
  const centimetres = Math.abs(metres * 100).toFixed(1);
  if (Number(centimetres) === 0) return zero;
  return fill(metres > 0 ? positive : negative, { cm: centimetres });
}

/** 「前へ 60.0 cm・右へ 1.2 cm」 from where the run ended (m, x forward, y left at the start). */
function describeOffset(forward, left, copy) {
  if (!Number.isFinite(forward) || !Number.isFinite(left)) return copy.none;
  return [
    describeAxis(forward, [copy.offsetForward, copy.offsetBackward, copy.offsetNoForward]),
    describeAxis(left, [copy.offsetLeft, copy.offsetRight, copy.offsetNoLeft]),
  ].join('・');
}

/** 「0.50 rad/s（約29°/秒）」 */
function describeTurnRate(radiansPerSecond, copy) {
  if (!Number.isFinite(radiansPerSecond)) return copy.none;
  return fill(copy.turnRateValue, {
    rate: radiansPerSecond.toFixed(2),
    degrees: Math.round(degreesOf(radiansPerSecond)),
  });
}

export {
  driveReport,
  isEmptyRun,
  runStatusKind,
  runStatusKey,
  benchCheck,
  describeTurn,
  describeOffset,
  describeTurnRate,
  STILL_LINEAR,
  STILL_ANGULAR,
  MOVED_DISTANCE,
  MOVED_TURN,
};
