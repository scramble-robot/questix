import { pidStep, STOP_DISTANCE } from './core.js';
import { frontDistance } from '../live/capture-core.js';
import { stepProgram, programSeconds, programCommand } from '../live/drive-core.js';

// What the feedback-control course asks the real robot to do. No DOM: ui.js turns these into
// drive-link runs, test/control-live-drive.test.mjs checks them with made-up scans.
//
// - Speed topics: a step input, the same experiment as the simulation but at a speed the lab may
//   command (the simulated 20–80 rpm would be 0.2–0.8 m/s with QUESTiX's 0.1 m wheels).
// - Distance topics: the learner's own P/I/D gains close the loop on the LiDAR's distance to the
//   wall, exactly as in the simulation (error = distance − 0.50 m, output −1…1), with the output
//   scaled to the lab's speed limit instead of the simulated motor's full speed.

const STEP_SPEEDS = [0.1, 0.2, 0.3]; // m/s offered for the real step
const STEP_HOLD = 5; // seconds at the step speed; the simulation settles within about 3 s
const STEP_LEAD = 1; // seconds standing still before the step, so the recording shows rest
const STEP_TAIL = 2; // seconds standing still after it
const WALL_SECONDS = 16; // as long as a simulated run (core.js DURATION)
const WALL_MAX_SPEED = 0.25; // m/s at output 100 %, never above the bridge's limit
const WALL_START_MIN = 0.9; // m: closer than this, the approach is too short to show anything
const WALL_MIN_GAP = 0.25; // m: the run ends at once when the LiDAR sees the wall this close
const SCAN_STALE = 0.6; // seconds without a scan: stand still (the controller would be blind)
const SCAN_LOST = 1.5; // seconds without a scan: end the run
// The run ends by itself once the robot has held the stop distance: within this band of it and
// slower than SETTLE_SPEED for SETTLE_SECONDS (the simulation's settling band is 5 cm).
const SETTLE_BAND = 0.05; // m
const SETTLE_SPEED = 0.02; // m/s, measured (/drive_status)
const SETTLE_SECONDS = 1.5;

/** The step program for `speed` [m/s] and the space it needs ahead, in metres. */
function speedStep(speed) {
  const steps = stepProgram({ speed, lead: STEP_LEAD, hold: STEP_HOLD, tail: STEP_TAIL });
  return {
    steps,
    seconds: programSeconds(steps),
    distance: speed * STEP_HOLD,
    controller: (elapsed) => programCommand(steps, elapsed),
  };
}

/**
 * A controller for drive-link that stops the robot `STOP_DISTANCE` in front of the wall with the
 * given gains (`kp`, `ki`, `kd`, `filter`, `antiWindup` as in the simulation's config). It runs
 * once per new scan (the LiDAR's rate is the control rate on the robot) and holds its output in
 * between. `messages.tooClose` / `.noWall` / `.lost` / `.hit` are the sentences it ends a run with.
 * It returns null (run over) once the robot has settled at the stop distance. `trace` receives
 * `{time, distance, command}` per control step. The returned function carries `result`:
 * `{settled, distance}` — whether it settled, and the last distance it measured.
 */
function wallApproach(gains, messages, trace = () => {}) {
  const pid = {};
  let lastStamp = null;
  let output = 0;
  let steadySince = null;
  const result = { settled: false, distance: null };
  const controller = (elapsed, robot) => {
    const scan = robot.scan;
    const age = robot.age('scan');
    if (!scan || age > SCAN_LOST) {
      if (elapsed > SCAN_LOST) throw new Error(messages.lost);
      return { linear: 0, angular: 0 };
    }
    if (age > SCAN_STALE) return { linear: 0, angular: 0 };
    const distance = frontDistance(scan);
    if (distance === null) throw new Error(messages.noWall);
    if (distance < WALL_MIN_GAP) throw new Error(messages.hit);
    if (lastStamp === null && distance < WALL_START_MIN) throw new Error(messages.tooClose);
    result.distance = distance;
    const speed = Math.abs(robot.drive?.v ?? Infinity);
    const steady = Math.abs(distance - STOP_DISTANCE) < SETTLE_BAND && speed < SETTLE_SPEED;
    steadySince = steady ? (steadySince ?? elapsed) : null;
    if (steadySince !== null && elapsed - steadySince >= SETTLE_SECONDS) {
      result.settled = true;
      return null;
    }
    if (scan.stamp !== lastStamp) {
      const dt = lastStamp === null ? 0.2 : Math.max(0.01, scan.stamp - lastStamp);
      lastStamp = scan.stamp;
      output = pidStep(pid, {
        error: distance - STOP_DISTANCE,
        measurement: -distance,
        kp: gains.kp,
        ki: gains.ki,
        kd: gains.kd,
        dt,
        filter: gains.filter,
        antiWindup: gains.antiWindup,
      }).command;
      trace({ time: elapsed, distance, command: output });
    }
    const top = Math.min(WALL_MAX_SPEED, robot.limits?.linear ?? WALL_MAX_SPEED);
    return { linear: output * top, angular: 0 };
  };
  return Object.assign(controller, { result });
}

export {
  STEP_SPEEDS,
  STEP_HOLD,
  WALL_SECONDS,
  WALL_MAX_SPEED,
  WALL_START_MIN,
  WALL_MIN_GAP,
  speedStep,
  wallApproach,
};
