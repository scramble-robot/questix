import { onRobot, robotState, latestRobot, sendRobot } from './robot-link.js';
import { driveReadiness, limitCommand } from './drive-core.js';

// The one module that may send commands to the robot. Lessons describe what to do as a
// `controller(elapsed, robot)` function and hand it to `runDrive`; this module repeats the command
// ten times a second (the bridge's dead-man timeout is 0.5 s), watches whether the bridge still
// lets this page drive, and sends "stop" whenever the run ends for any reason: finished, the
// learner's stop, the page hidden or closed, Esc, the link lost. A run that ends on this page sends
// a stop scoped to this page (`scope: 'mine'`), so a refused request can never end another pupil's
// run; the stop bar (`stopDrive`) is the one deliberate way to stop any run, which is why every
// connected page shows it while the robot drives.

const HEARTBEAT_MS = 100;
// The bridge answers the first command with a drive_state naming this page as the owner.
const START_TIMEOUT_MS = 1500;
const SENSOR_STREAMS = ['scan', 'odom', 'drive'];

let confirmed = false;
let current = null; // the run in progress: { finish(reason), started }
const listeners = new Set();
const received = new Map(); // stream -> performance.now() of its latest message

function notify() {
  const model = driveModel();
  for (const fn of listeners) fn(model);
}

/** Everything a view needs: driveReadiness plus whether this page runs something itself. */
function driveModel() {
  const link = robotState();
  const readiness = driveReadiness({
    link,
    driveState: latestRobot('drive_state'),
    confirmed,
    runningHere: Boolean(current),
  });
  return { ...readiness, confirmed, running: Boolean(current) };
}

// Subscribe to changes of driveModel(); returns the unsubscribe function.
function onDrive(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// The learner's "the surroundings are clear" tick. It is forgotten when the page reloads.
function confirmDriveSafety(value) {
  confirmed = Boolean(value);
  notify();
}

// Stop the robot, whichever page drives it (the stop bar). Always allowed.
function stopDrive() {
  sendRobot({ type: 'stop' });
  current?.finish('stopped');
}

// Stop this page's own run only; the bridge ignores it when another page drives.
const stopMine = () => sendRobot({ type: 'stop', scope: 'mine' });

/**
 * Run `controller(elapsed, robot)` on the robot for at most `seconds`. `robot` has the latest
 * `scan`, `odom` and `drive` messages, `age(stream)` (seconds since that stream last arrived) and
 * the bridge's `limits`. The controller returns `{linear, angular}`, null to end the run, or throws
 * an Error to end it with that message (result reason `failed`, e.g. "the wall is too close").
 *
 * Resolves with `{reason, by, elapsed}` whatever happened — `done` when the controller or the time
 * ran out, `stopped`, `hidden`, `lost`, `refused` (with `blockers`), `no_answer` (the bridge did
 * not confirm the start in time), or the bridge's own reason (`timeout`, `time_limit`,
 * `emergency_stop`, `other_publisher`, …). Never rejects: stopping is a normal outcome, and the
 * lesson says what happened. `started` tells whether the bridge ever let this page drive.
 */
function runDrive({ controller, seconds, signal }) {
  const readiness = driveModel();
  if (current)
    return Promise.resolve({ reason: 'refused', blockers: [{ code: 'running_here' }], elapsed: 0 });
  if (!readiness.ready)
    return Promise.resolve({ reason: 'refused', blockers: readiness.blockers, elapsed: 0 });
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const elapsed = () => (performance.now() - startedAt) / 1000;
    const unsubscribe = [];
    let timer = 0;
    const run = { started: false };
    const finish = (reason, extra = {}) => {
      if (current !== run) return;
      current = null;
      clearInterval(timer);
      for (const off of unsubscribe) off();
      signal?.removeEventListener('abort', abort);
      // A run that ends on this page tells the bridge at once instead of waiting for the dead-man;
      // scoped to this page, so a refused request cannot stop someone else's run.
      if (!['stopped_by_bridge', 'lost'].includes(extra.kind)) stopMine();
      notify();
      resolve({
        started: run.started,
        reason,
        by: extra.by ?? null,
        blockers: extra.blockers,
        refused: extra.refused ?? null,
        message: extra.message ?? '',
        elapsed: elapsed(),
      });
    };
    run.finish = finish;
    const abort = () => finish('stopped');
    const robot = {
      get scan() {
        return latestRobot('scan');
      },
      get odom() {
        return latestRobot('odom');
      },
      get drive() {
        return latestRobot('drive');
      },
      get limits() {
        return driveModel().limits;
      },
      age: (stream) =>
        received.has(stream) ? (performance.now() - received.get(stream)) / 1000 : Infinity,
    };
    const tick = () => {
      const now = elapsed();
      if (now > seconds) return finish('done');
      let command;
      try {
        command = controller(now, robot);
      } catch (error) {
        return finish('failed', { message: error.message });
      }
      if (!command) return finish('done');
      const limited = limitCommand(command, driveModel().limits);
      if (!sendRobot({ type: 'drive', linear: limited.linear, angular: limited.angular }))
        return finish('lost', { kind: 'lost' });
      // No confirmation yet: the robot may be moving (a busy Wi-Fi), so this is not a refusal.
      if (!run.started && now * 1000 > START_TIMEOUT_MS) finish('no_answer');
    };
    unsubscribe.push(
      onRobot('drive_state', (state) => {
        const session = robotState().session;
        if (state.active && state.owner === session) run.started = true;
        else if (!run.started && state.refused)
          finish('refused', { blockers: driveModel().blockers, refused: state.refused });
        else if (run.started) {
          // The bridge ended the run: say why, and who pressed stop if it was another page.
          const stop = state.last_stop ?? { reason: 'stopped', by: null };
          const reason =
            stop.reason === 'stopped' && stop.by !== session ? 'stopped_other' : stop.reason;
          finish(reason, { kind: 'stopped_by_bridge', by: stop.by });
        }
      }),
      onRobot('state', (link) => {
        if (link.phase !== 'open') finish('lost', { kind: 'lost' });
      }),
    );
    current = run;
    signal?.addEventListener('abort', abort);
    timer = setInterval(tick, HEARTBEAT_MS);
    tick();
    notify();
  });
}

function initDriveLink() {
  onRobot('drive_state', notify);
  onRobot('state', notify);
  for (const stream of SENSOR_STREAMS)
    onRobot(stream, () => received.set(stream, performance.now()));
  // A hidden page throttles its timers, so it could not keep the robot under control: stop.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) current?.finish('hidden');
  });
  window.addEventListener('pagehide', () => {
    if (current) current.finish('hidden');
  });
  // Esc stops this page's own run from anywhere on the page. It never stops another pupil's run:
  // Esc also closes dialogs, and closing one must not end someone else's experiment.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && current) current.finish('stopped');
  });
}

initDriveLink();

export { driveModel, onDrive, confirmDriveSafety, stopDrive, runDrive };
