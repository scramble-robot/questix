import { wheelRpm, wheelAuthority, forwardRpm, frontDistance, scanMount } from './capture-core.js';
import { fillSentence as fill } from '../core/content.js';

// The 「実機の状態」 panel's arithmetic, with no DOM and no WebSocket (test/robot-state-core.test.mjs):
// what the robot's streams say right now — who drives it, the emergency stop, both wheels with the
// last ten seconds of their speed, the chassis speed, where it went since the panel opened and what
// is in front of it — and how fresh each of those values is. robot-state.js feeds it the messages
// with their arrival time; robot-state-view.js draws the model.
//
// Units follow REP-103 (metres, radians, seconds; x forward, y left, theta counter-clockwise).
// Wheel speeds are rpm counted forward-positive for both wheels. A /drive_status with each
// wheel's own values (newer bridges) is read from them (capture-core wheelAuthority: filtered,
// raw and the generated target, the right wheel negated only here); an older one falls back to
// the chassis velocity (capture-core wheelRpm) with the fresh /target_twist as its target.
// Times given to this module (`now`, arrival times) are milliseconds of one monotonic clock.

const HISTORY_SECONDS = 10; // the wheel charts show this much
// Two /drive_status further apart than this are not joined by a line. The bridge forwards at most
// drive_max_hz (lab_bridge.yaml, 20) of drive_component's 50 Hz, newest wins with at least
// 1/drive_max_hz between two: every third message, 0.06 s apart (about 17 Hz). 0.5 s is about
// eight missed messages, a gap (the link stalled, the node restarted) the chart must show rather
// than draw a straight line over.
const WHEEL_GAP_SECONDS = 0.5;
// Older than this, a value no longer describes the robot now: it is shown grey and left out of a
// memo line. The LiDAR sends 5 scans a second at most (lab_bridge.yaml scan_max_hz), the rest 20.
// /emergency_stop comes at 10 Hz from operation_manager: silent for a second, its state is stale.
const STALE_SECONDS = { drive: 1, odom: 1, scan: 2, twist: 1, estop: 1 };
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
// The strip's sparkline: chassis speed, ±top m/s. Before the bridge says its limit, ±0.3 m/s.
const DEFAULT_SPEED_TOP = 0.3; // m/s
const SPEED_AXIS_TOPS = [0.1, 0.2, 0.3, 0.5, 1, 2, 3]; // m/s
const SPARK_WIDTH = 120; // SVG user units across the sparkline (= HISTORY_SECONDS)
const SPARK_HEIGHT = 32; // SVG user units down
const TIME_AXIS = { min: -HISTORY_SECONDS, max: 0, step: 5, ticks: [-10, -5, 0] };
const DEGREES_PER_RADIAN = 180 / Math.PI;

const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
const finite = (...values) => values.every(Number.isFinite);

/** A fresh state: nothing received, no trail. */
function createStateTracker() {
  return {
    // {at, left, right (filtered measurement), rawLeft, rawRight, targetLeft, targetRight (the
    // generated wheel target; the command's wheels for an older bridge), requestLeft, requestRight
    // (the upstream /target_twist as wheels), speed (the node's chassis speed, from the filtered
    // wheels), rawSpeed (the chassis speed from the raw wheels), command, measurementValid,
    // authority}
    history: [],
    received: {}, // stream -> arrival time [ms] of its latest message
    latest: {}, // stream -> its latest message
    origin: null, // odom pose the trail is measured from
    pose: null, // {forward, left, heading} relative to origin
    trail: [], // [{forward, left}]
    poseHalf: POSE_MIN_HALF,
    peakRpm: 0, // largest wheel speed seen, so the axis only grows
    peakSpeed: 0, // largest chassis speed (measured or commanded) seen, m/s: the strip's axis
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

const NO_WHEELS = { left: NaN, right: NaN };

// The chassis speed [m/s] of forward-positive wheels [rpm]: their average times the wheel's
// circumference per minute. NaN without both wheels or the wheel radius.
function chassisSpeed(wheels, config) {
  if (!finite(wheels.left, wheels.right) || !(config?.wheel_radius > 0)) return NaN;
  return (((wheels.left + wheels.right) / 2) * 2 * Math.PI * config.wheel_radius) / 60;
}

// One /drive_status into the history. Four quantities stay apart: the upstream request
// (/target_twist), the generated wheel target, the filtered and the raw measurement. With each
// wheel's own values, a measurement whose feedback is not valid is left unknown (never replaced by
// the chassis velocity) while the generated target, the node's own, is kept.
function addWheels(tracker, drive, now, config) {
  const command = freshCommand(tracker, now);
  const request =
    command && config ? wheelRpm({ v: command.linear, w: command.angular }, config) : NO_WHEELS;
  const direct = wheelAuthority(drive);
  let entry;
  if (direct) {
    entry = {
      measured: direct.filtered ?? NO_WHEELS,
      raw: direct.raw ?? NO_WHEELS,
      target: direct.target ?? NO_WHEELS,
      speed: direct.valid && finite(drive.v) ? drive.v : NaN,
      measurementValid: direct.valid,
      authority: 'wheel',
    };
  } else {
    if (!config || !finite(drive.v, drive.w)) return;
    entry = {
      measured: wheelRpm(drive, config),
      raw: NO_WHEELS,
      target: request,
      speed: drive.v,
      measurementValid: true,
      authority: 'legacy',
    };
  }
  const { measured, raw, target } = entry;
  tracker.history.push({
    at: now,
    left: measured.left,
    right: measured.right,
    rawLeft: raw.left,
    rawRight: raw.right,
    targetLeft: target.left,
    targetRight: target.right,
    requestLeft: request.left,
    requestRight: request.right,
    speed: entry.speed,
    rawSpeed: chassisSpeed(raw, config),
    command: command ? command.linear : NaN,
    measurementValid: entry.measurementValid,
    authority: entry.authority,
  });
  const values = [measured.left, measured.right, raw.left, raw.right, target.left, target.right];
  tracker.peakRpm = Math.max(tracker.peakRpm, ...values.filter(Number.isFinite).map(Math.abs));
  const speeds = [entry.speed, tracker.history.at(-1).rawSpeed, command?.linear].filter(
    Number.isFinite,
  );
  tracker.peakSpeed = Math.max(tracker.peakSpeed, ...speeds.map(Math.abs));
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

/** The strip's speed axis top (m/s): the bridge's limit or what was seen, rounded up, never shrunk. */
function speedTop(tracker, limits) {
  const limit = Number.isFinite(limits?.linear) ? limits.linear : DEFAULT_SPEED_TOP;
  const high = Math.max(limit, tracker.peakSpeed);
  return SPEED_AXIS_TOPS.find((value) => value >= high - 1e-9) ?? Math.ceil(high);
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

// The history of `value(entry)` as chart points [[seconds before now, value]]. A missing value
// stays in as NaN and a pause longer than WHEEL_GAP_SECONDS gets a NaN point of its own, so the
// charts (html-chart, sparkLines) break the line there instead of joining across the gap.
function historyPoints(history, now, value) {
  const points = [];
  let previous = null;
  for (const entry of history) {
    const seconds = (entry.at - now) / 1000;
    if (previous !== null && (entry.at - previous) / 1000 > WHEEL_GAP_SECONDS)
      points.push([seconds, NaN]);
    points.push([seconds, value(entry)]);
    previous = entry.at;
  }
  return points;
}

function wheelsModel(tracker, now) {
  const last = tracker.history.at(-1);
  if (!last) return null;
  const toPoints = (key) => historyPoints(tracker.history, now, (entry) => entry[key]);
  return {
    left: last.left,
    right: last.right,
    rawLeft: last.rawLeft,
    rawRight: last.rawRight,
    targetLeft: last.targetLeft,
    targetRight: last.targetRight,
    requestLeft: last.requestLeft,
    requestRight: last.requestRight,
    authority: last.authority,
    measurementValid: last.measurementValid,
    // Stale when /drive_status stopped, and when its wheel feedback is not valid: then the
    // measurement is unknown (the target stays).
    stale: isStale(tracker, 'drive', now) || last.measurementValid === false,
    series: {
      left: toPoints('left'),
      right: toPoints('right'),
      rawLeft: toPoints('rawLeft'),
      rawRight: toPoints('rawRight'),
      targetLeft: toPoints('targetLeft'),
      targetRight: toPoints('targetRight'),
      requestLeft: toPoints('requestLeft'),
      requestRight: toPoints('requestRight'),
      speed: toPoints('speed'),
      rawSpeed: toPoints('rawSpeed'),
      // The strip's line: the speed from the raw wheels, or the node's speed where there are no
      // raw wheels (an older bridge, no wheel radius). Invalid feedback has neither: a gap.
      stripSpeed: historyPoints(tracker.history, now, (entry) =>
        Number.isFinite(entry.rawSpeed) ? entry.rawSpeed : entry.speed,
      ),
      command: toPoints('command'),
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
  // The chassis velocity is computed from the wheel feedback: not valid there, not valid here.
  const invalid = wheelAuthority(drive)?.valid === false;
  return { speed: drive.v, turn: drive.w, stale: invalid || isStale(tracker, 'drive', now) };
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
 * The emergency stop as the panel shows it: `{state, source}`, `state` one of 'pressed',
 * 'released', 'stale' (heard, then silent for STALE_SECONDS.estop) or 'unknown' (never heard),
 * `source` 'estop' (/emergency_stop itself) or 'drive' (the derived flag of /drive_status).
 * Only /emergency_stop itself can say "released"; the derived flag may add a pressed E-stop but
 * its false never counts as released (an older bridge without the estop stream stays unknown).
 */
function estopModel(tracker, now) {
  const drive = tracker.latest.drive;
  const derivedPressed = Boolean(
    drive && !isStale(tracker, 'drive', now) && drive.emergency_stop === true,
  );
  const message = tracker.latest.estop;
  if (message && !isStale(tracker, 'estop', now) && message.active === true)
    return { state: 'pressed', source: 'estop' };
  if (derivedPressed) return { state: 'pressed', source: 'drive' };
  if (!message) return { state: 'unknown', source: null };
  if (isStale(tracker, 'estop', now)) return { state: 'stale', source: 'estop' };
  return { state: 'released', source: 'estop' };
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
  const driveFresh = !isStale(tracker, 'drive', now);
  const command = freshCommand(tracker, now);
  const wheels = wheelsModel(tracker, now);
  const motion = motionModel(tracker, now);
  const estop = estopModel(tracker, now);
  return {
    connected: true,
    robot: link.robot?.name ?? '',
    silent,
    // true pressed, false released, null unknown or stale (estopState tells which).
    estop: estop.state === 'pressed' ? true : estop.state === 'released' ? false : null,
    estopState: estop.state,
    estopSource: estop.source,
    driver: driverOf({
      driveState,
      session,
      command,
      wheels: driveFresh && wheels && !wheels.stale ? wheels : null,
    }),
    command,
    motion,
    wheels,
    wheelAxis: wheelAxis(tracker, driveState?.limits ?? null, link.config),
    speedTop: speedTop(tracker, driveState?.limits ?? null),
    timeAxis: TIME_AXIS,
    historySeconds: HISTORY_SECONDS,
    pose: poseModel(tracker, now),
    front: frontModel(tracker, now),
    streams: streamStates(tracker, link.streams, now),
  };
}

// --- the compact strip under a lesson's start button ------------------------------------------

/**
 * `points` ([[seconds before now (<= 0), value], …]) as an SVG polyline's `points` in a
 * SPARK_WIDTH × SPARK_HEIGHT box: now at the right edge, HISTORY_SECONDS ago at the left, `top` at
 * the top and `-top` at the bottom (values beyond are drawn at the edge). A gap in the data (a
 * value missing between two samples) is not bridged: each run of samples is its own polyline.
 */
function sparkLines(points, top) {
  const x = (seconds) => ((seconds + HISTORY_SECONDS) / HISTORY_SECONDS) * SPARK_WIDTH;
  const y = (value) => {
    const clamped = Math.max(-top, Math.min(top, value));
    return ((top - clamped) / (2 * top)) * SPARK_HEIGHT;
  };
  const lines = [];
  let current = [];
  for (const [seconds, value] of points) {
    if (!Number.isFinite(value) || seconds < -HISTORY_SECONDS) {
      if (current.length) lines.push(current);
      current = [];
      continue;
    }
    current.push(`${+x(seconds).toFixed(1)},${+y(value).toFixed(1)}`);
  }
  if (current.length) lines.push(current);
  return lines.filter((line) => line.length > 1).map((line) => line.join(' '));
}

/**
 * The strip's model from robotStateModel(): the emergency stop ('pressed' | 'released' |
 * 'unknown'), who drives, both wheels (rpm, forward positive) and the chassis speed (m/s) — null
 * where nothing fresh arrived — and the last HISTORY_SECONDS of the measured speed and of the
 * command as sparkline polylines (`measured`, `command`: lists of `points` strings) on ±`top`.
 * The measured line is the chassis speed from the raw wheel feedback (unsmoothed), the node's
 * filtered speed only where the raw wheels are missing.
 */
function stripModel(model) {
  if (!model.connected) return { connected: false, phase: model.phase };
  const wheels = model.wheels && !model.wheels.stale ? model.wheels : null;
  const motion = model.motion && !model.motion.stale ? model.motion : null;
  const top = model.speedTop ?? DEFAULT_SPEED_TOP;
  const series = model.wheels?.series;
  let estop = 'unknown';
  if (model.estop !== null) estop = model.estop ? 'pressed' : 'released';
  return {
    connected: true,
    estop,
    driver: model.driver,
    left: wheels ? wheels.left : null,
    right: wheels ? wheels.right : null,
    speed: motion ? motion.speed : null,
    command: model.command ? model.command.linear : null,
    top,
    width: SPARK_WIDTH,
    height: SPARK_HEIGHT,
    measured: sparkLines(series?.stripSpeed ?? [], top),
    commanded: sparkLines(series?.command ?? [], top),
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
  WHEEL_GAP_SECONDS,
  STALE_SECONDS,
  estopModel,
  FRONT_RANGE,
  DEGREES_PER_RADIAN,
  createStateTracker,
  resetPose,
  ingest,
  wheelAxis,
  driverOf,
  robotStateModel,
  speedTop,
  sparkLines,
  stripModel,
  snapshotLine,
  freshnessText,
  signed,
};
