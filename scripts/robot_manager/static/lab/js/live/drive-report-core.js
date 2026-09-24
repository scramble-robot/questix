// What one driving run did, from its recording: the numbers and the curves the run report draws.
// No DOM: test/drive-report-core.test.mjs checks it with made-up recordings.
//
// Time is counted from the first command the run sent (the moment the page took over), in the
// robot's own clock (message stamps), so a reopened file gives the same report. The path is turned
// so the robot starts at the origin facing up the page: x forward, y left at the start (REP-103).

import { frontDistance } from './capture-core.js';

const STILL_LINEAR = 0.02; // m/s: slower than this counts as standing
const STILL_ANGULAR = 0.05; // rad/s
const COMMANDED = 1e-3; // |command| above this is "moving"
const REPORT_PERIOD = 0.1; // s: the kept report is thinned to 10 samples a second
const PATH_STEP = 0.01; // m: path points closer than this to the previous one are dropped

const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
const finite = (...values) => values.every(Number.isFinite);

function startTime(recording) {
  const twist = recording.streams.twist ?? [];
  const firstCommand = twist.find((message) => finite(message.linear, message.angular));
  if (firstCommand) return firstCommand.stamp;
  const stamps = Object.values(recording.streams).flatMap((list) =>
    list.length ? [list[0].stamp] : [],
  );
  return stamps.length ? Math.min(...stamps) : 0;
}

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

/**
 * How the robot stopped at the end: from the first zero command after the last moving one, how
 * long until the measured speed fell below STILL_* and how far it rolled meanwhile. Null when the
 * run never commanded motion, or the robot had not come to rest by the end of the recording.
 */
function stopping(command, measured, path) {
  let last = -1;
  command.forEach((sample, index) => {
    if (Math.abs(sample.v) > COMMANDED || Math.abs(sample.w) > COMMANDED) last = index;
  });
  const zero = command[last + 1];
  if (last < 0 || !zero) return null;
  const still = measured.find(
    (sample) =>
      sample.t >= zero.t && Math.abs(sample.v) < STILL_LINEAR && Math.abs(sample.w) < STILL_ANGULAR,
  );
  if (!still) return null;
  return { at: zero.t, delay: still.t - zero.t, distance: pathLength(path, zero.t, still.t) };
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
 * for display and storage. `summary` has `seconds`, `distance` (path length, m), `forward` / `left`
 * (where it ended, m), `turn` (rad), `maxSpeed`, `maxTurnRate`, `maxCommand`, `stop` (stopping(),
 * or null), `emergencyStop` and `closest` (nearest wall ahead, m, or null).
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
  return {
    series: {
      command: thin(command, REPORT_PERIOD / 2),
      measured: thin(measured, REPORT_PERIOD),
      path: thinPath(path),
      front: front.map((sample) => ({ t: sample.t, d: sample.d })),
    },
    summary: {
      seconds: times.length ? Math.max(0, ...times) : 0,
      distance: pathLength(path),
      forward: end?.x ?? null,
      left: end?.y ?? null,
      turn: end?.turn ?? null,
      maxSpeed: peak(measured, 'v'),
      maxTurnRate: peak(measured, 'w'),
      maxCommand: peak(command, 'v'),
      stop: stopping(command, measured, path),
      emergencyStop: measured.some((sample) => sample.estop),
      closest: front.length ? Math.min(...front.map((sample) => sample.d)) : null,
    },
  };
}

export { driveReport, STILL_LINEAR, STILL_ANGULAR };
