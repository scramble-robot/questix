import { wheelRpm, forwardRpm, frontDistance, scanMount } from './capture-core.js';
import { fillSentence as fill } from '../core/content.js';

// The 「実機の状態」 panel's arithmetic, with no DOM and no WebSocket (test/robot-state-core.test.mjs):
// what the robot's streams say right now — who drives it, the emergency stop, both wheels with the
// last ten seconds of their speed, the chassis speed, where it went since the panel opened and what
// is in front of it — and how fresh each of those values is. robot-state.js feeds it the messages
// with their arrival time; robot-state-view.js draws the model.
//
// Units follow REP-103 (metres, radians, seconds; x forward, y left, theta counter-clockwise).
// Wheel speeds are rpm counted forward-positive for both wheels, from the chassis velocity as
// everywhere in the material (capture-core wheelRpm: the raw right-wheel feedback is mirrored).
// Times given to this module (`now`, arrival times) are milliseconds of one monotonic clock.

const HISTORY_SECONDS = 10; // the wheel charts show this much
// Older than this, a value no longer describes the robot now: it is shown grey and left out of a
// memo line. The LiDAR sends 5 scans a second at most (lab_bridge.yaml scan_max_hz), the rest 20.
const STALE_SECONDS = { drive: 1, odom: 1, scan: 2, twist: 1 };
const STREAMS = ['drive', 'odom', 'scan', 'twist'];
const MOVING_RPM = 1; // a wheel below this counts as standing still
const COMMAND_MOVING = 1e-3; // |command| above this asks the robot to move (m/s or rad/s)
const TRAIL_STEP = 0.01; // m the robot must move before the trail gets a new point
const TRAIL_MAX_POINTS = 3000;
// Top view: at least ±1 m around the start, grown in 0.5 m steps (never shrunk while the panel
// stays open) so the drawing does not jump while the robot moves.
const POSE_MIN_HALF = 1; // m
const POSE_STEP = 0.5; // m
const POSE_MARGIN = 0.4; // m kept between the robot and the edge of the view
// The front view: beams within this angle either side of straight ahead, up to this far.
const FRONT_ARC = (35 * Math.PI) / 180; // rad
const FRONT_RANGE = 3; // m
// Before the bridge says how fast a page may drive, the wheel axis spans ±60 rpm.
const DEFAULT_WHEEL_RPM = 60;
// The wheel axis tops, in rpm: a round number the ticks can halve (±top, ±top/2 and 0 are
// labelled, five labels on a chart of about 130 px). niceScale would give 7 ticks or a range twice
// as wide for the same span, which leaves the lines flat on a phone.
const WHEEL_AXIS_TOPS = [10, 20, 30, 40, 60, 80, 100, 120, 160, 200, 300, 400, 600, 800, 1000];
const TIME_AXIS = { min: -HISTORY_SECONDS, max: 0, step: 5, ticks: [-10, -5, 0] };
const DEGREES_PER_RADIAN = 180 / Math.PI;

const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
const finite = (...values) => values.every(Number.isFinite);

/** A fresh state: nothing received, no trail. */
function createStateTracker() {
  return {
    history: [], // {at, left, right, targetLeft, targetRight} of the last HISTORY_SECONDS
    received: {}, // stream -> arrival time [ms] of its latest message
    latest: {}, // stream -> its latest message
    origin: null, // odom pose the trail is measured from
    pose: null, // {forward, left, heading} relative to origin
    trail: [], // [{forward, left}]
    poseHalf: POSE_MIN_HALF,
    peakRpm: 0, // largest wheel speed seen, so the axis only grows
  };
}

/** Forget the trail; the next /odom becomes its start (「ここを起点にする」, a panel opened). */
function resetPose(tracker) {
  Object.assign(tracker, { origin: null, pose: null, trail: [], poseHalf: POSE_MIN_HALF });
}

// The command a message of /target_twist stands for, while it is fresh.
function freshCommand(tracker, now) {
  const twist = tracker.latest.twist;
  if (!twist || !finite(twist.linear, twist.angular)) return null;
  if (now - tracker.received.twist > STALE_SECONDS.twist * 1000) return null;
  return { linear: twist.linear, angular: twist.angular };
}

function addWheels(tracker, drive, now, config) {
  if (!config || !finite(drive.v, drive.w)) return;
  const measured = wheelRpm(drive, config);
  const command = freshCommand(tracker, now);
  const target = command
    ? wheelRpm({ v: command.linear, w: command.angular }, config)
    : { left: NaN, right: NaN };
  tracker.history.push({
    at: now,
    left: measured.left,
    right: measured.right,
    targetLeft: target.left,
    targetRight: target.right,
  });
  const values = [measured.left, measured.right, target.left, target.right].filter(Number.isFinite);
  tracker.peakRpm = Math.max(tracker.peakRpm, ...values.map(Math.abs));
  while (tracker.history.length && now - tracker.history[0].at > HISTORY_SECONDS * 1000)
    tracker.history.shift();
}

function addPose(tracker, odom) {
  if (!finite(odom.x, odom.y, odom.theta)) return;
  tracker.origin ??= { x: odom.x, y: odom.y, theta: odom.theta };
  const origin = tracker.origin;
  const dx = odom.x - origin.x;
  const dy = odom.y - origin.y;
  const cos = Math.cos(origin.theta);
  const sin = Math.sin(origin.theta);
  const pose = {
    forward: cos * dx + sin * dy,
    left: -sin * dx + cos * dy,
    heading: wrapAngle(odom.theta - origin.theta),
  };
  tracker.pose = pose;
  const last = tracker.trail.at(-1);
  if (!last || Math.hypot(pose.forward - last.forward, pose.left - last.left) >= TRAIL_STEP) {
    tracker.trail.push({ forward: pose.forward, left: pose.left });
    if (tracker.trail.length > TRAIL_MAX_POINTS) tracker.trail.shift();
  }
  const extent = Math.max(Math.abs(pose.forward), Math.abs(pose.left)) + POSE_MARGIN;
  tracker.poseHalf = Math.max(tracker.poseHalf, Math.ceil(extent / POSE_STEP) * POSE_STEP);
}

/**
 * Take one message of `type` ('drive', 'odom', 'scan', 'twist' or 'drive_state') that arrived at
 * `now` [ms]. `config` is the robot's wheel geometry (hello.config), needed for the wheel speeds.
 */
function ingest(tracker, type, message, now, config) {
  if (!message) return;
  tracker.received[type] = now;
  tracker.latest[type] = message;
  if (type === 'drive') addWheels(tracker, message, now, config);
  else if (type === 'odom') addPose(tracker, message);
}

/** The wheel axis: fixed from the bridge's speed limits, grown only if a wheel ever went faster. */
function wheelAxis(tracker, limits, config) {
  const base =
    limits && config && finite(limits.linear, limits.angular)
      ? forwardRpm(limits.linear + (limits.angular * config.wheel_separation) / 2, config)
      : DEFAULT_WHEEL_RPM;
  const high = Math.max(base, tracker.peakRpm);
  const top = WHEEL_AXIS_TOPS.find((value) => value >= high) ?? Math.ceil(high / 1000) * 1000;
  return { min: -top, max: top, step: top / 2, ticks: [-top, -top / 2, 0, top / 2, top] };
}

// Seconds since a stream last arrived, or null when it never has.
const ageOf = (tracker, name, now) =>
  tracker.received[name] === undefined ? null : (now - tracker.received[name]) / 1000;
const isStale = (tracker, name, now) => {
  const age = ageOf(tracker, name, now);
  return age === null || age > STALE_SECONDS[name];
};

function streamStates(tracker, streams, now) {
  return STREAMS.map((name) => {
    const age = ageOf(tracker, name, now);
    return {
      name,
      offered: Boolean(streams?.[name]),
      age,
      stale: isStale(tracker, name, now),
    };
  });
}

// Who makes the robot move, as far as the streams tell: a page's run (drive_state names its owner),
// otherwise a fresh command on /target_twist (the controller through twist_arbiter, or another
// node), otherwise wheels turning with no command at all (pushed by hand, or a stale command).
function driverOf({ driveState, session, command, wheels }) {
  if (driveState?.active && driveState.owner !== null && driveState.owner !== undefined)
    return driveState.owner === session ? 'me' : 'page';
  const commanding =
    command &&
    (Math.abs(command.linear) > COMMAND_MOVING || Math.abs(command.angular) > COMMAND_MOVING);
  if (commanding) return 'controller';
  const turning =
    wheels && (Math.abs(wheels.left) > MOVING_RPM || Math.abs(wheels.right) > MOVING_RPM);
  return turning ? 'unknown' : 'none';
}

function wheelsModel(tracker, now) {
  const last = tracker.history.at(-1);
  if (!last) return null;
  const toPoints = (key) =>
    tracker.history
      .map((entry) => [(entry.at - now) / 1000, entry[key]])
      .filter(([, v]) => finite(v));
  return {
    left: last.left,
    right: last.right,
    targetLeft: last.targetLeft,
    targetRight: last.targetRight,
    stale: isStale(tracker, 'drive', now),
    series: {
      left: toPoints('left'),
      right: toPoints('right'),
      targetLeft: toPoints('targetLeft'),
      targetRight: toPoints('targetRight'),
    },
  };
}

function frontModel(tracker, now) {
  const scan = tracker.latest.scan;
  if (!scan || !Array.isArray(scan.ranges)) return null;
  const mount = scanMount(scan);
  const points = [];
  scan.ranges.forEach((range, index) => {
    if (range === null || !Number.isFinite(range) || range > FRONT_RANGE) return;
    const angle = wrapAngle(mount.yaw + scan.angle_min + index * scan.angle_increment);
    if (Math.abs(angle) > FRONT_ARC) return;
    points.push({ forward: range * Math.cos(angle), left: range * Math.sin(angle) });
  });
  return {
    distance: frontDistance(scan),
    points,
    range: FRONT_RANGE,
    arc: FRONT_ARC,
    stale: isStale(tracker, 'scan', now),
  };
}

function motionModel(tracker, now) {
  const drive = tracker.latest.drive;
  if (!drive || !finite(drive.v, drive.w)) return null;
  return { speed: drive.v, turn: drive.w, stale: isStale(tracker, 'drive', now) };
}

function poseModel(tracker, now) {
  if (!tracker.pose) return null;
  return {
    ...tracker.pose,
    trail: tracker.trail,
    half: tracker.poseHalf,
    stale: isStale(tracker, 'odom', now),
  };
}

/**
 * Everything the panel shows. `link` is capture.js liveLink() (connected, streams, config, robot),
 * `silent` robot-link's "no stream delivers", `driveState` the bridge's latest drive_state (or
 * null), `session` this page's id on the bridge, `now` [ms].
 */
function robotStateModel(
  tracker,
  { link, silent = false, driveState = null, session = null, now },
) {
  if (!link?.connected) return { connected: false, phase: link?.phase ?? 'idle' };
  const drive = tracker.latest.drive;
  const driveFresh = !isStale(tracker, 'drive', now);
  const command = freshCommand(tracker, now);
  const wheels = wheelsModel(tracker, now);
  const motion = motionModel(tracker, now);
  return {
    connected: true,
    robot: link.robot?.name ?? '',
    silent,
    estop: drive && driveFresh ? Boolean(drive.emergency_stop) : null,
    driver: driverOf({ driveState, session, command, wheels: driveFresh ? wheels : null }),
    command,
    motion,
    wheels,
    wheelAxis: wheelAxis(tracker, driveState?.limits ?? null, link.config),
    timeAxis: TIME_AXIS,
    historySeconds: HISTORY_SECONDS,
    pose: poseModel(tracker, now),
    front: frontModel(tracker, now),
    streams: streamStates(tracker, link.streams, now),
  };
}

// --- one line for the learner's memo ----------------------------------------------------------

// A signed number as the learner reads it: "+3", "-0.12", and never "-0" or "+0".
function signed(value, digits) {
  const rounded = Number(value.toFixed(digits));
  if (rounded === 0) return (0).toFixed(digits);
  return (rounded > 0 ? '+' : '') + rounded.toFixed(digits);
}

function clock(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * The state at `date` as one line of the memo, from `text` (content/live/robot-state.json memo):
 * wheel speeds, chassis speed, heading since the panel opened, the distance ahead and the
 * emergency stop. A value that is stale (or missing) is written as `text.unknown` rather than
 * as the last number that arrived, which would describe an earlier moment.
 */
function snapshotLine(model, date, text) {
  const unknown = text.unknown;
  const wheels = model.wheels && !model.wheels.stale ? model.wheels : null;
  const motion = model.motion && !model.motion.stale ? model.motion : null;
  const pose = model.pose && !model.pose.stale ? model.pose : null;
  const front = model.front && !model.front.stale ? model.front : null;
  const estop =
    model.estop === null ? unknown : model.estop ? text.estopPressed : text.estopReleased;
  return fill(text.line, {
    time: clock(date),
    left: wheels ? wheels.left.toFixed(1) : unknown,
    right: wheels ? wheels.right.toFixed(1) : unknown,
    speed: motion ? signed(motion.speed, 2) : unknown,
    turn: motion ? signed(motion.turn, 2) : unknown,
    heading: pose ? signed(pose.heading * DEGREES_PER_RADIAN, 0) : unknown,
    front: front && front.distance !== null ? front.distance.toFixed(2) : unknown,
    estop,
  });
}

/** How long ago a stream arrived, in the learner's words (`text` is robot-state.json `fresh`). */
function freshnessText(stream, text) {
  if (stream.age === null) return stream.name === 'twist' ? text.idle : text.never;
  if (stream.age >= 10) return fill(text.long, { seconds: 10 });
  return fill(text.ago, { seconds: stream.age.toFixed(1) });
}

export {
  HISTORY_SECONDS,
  STALE_SECONDS,
  FRONT_RANGE,
  DEGREES_PER_RADIAN,
  createStateTracker,
  resetPose,
  ingest,
  wheelAxis,
  driverOf,
  robotStateModel,
  snapshotLine,
  freshnessText,
  signed,
};
