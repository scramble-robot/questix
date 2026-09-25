import { onRobot, robotState, latestRobot, sendRobot } from './robot-link.js';
import {
  shootReadiness,
  shootControls,
  clampPercent,
  clampTilt,
  createShotTracker,
  noteFireSent,
  dropPendingFire,
  ingestShot,
  expireFire,
  sessionEndKey,
  keepsConfirmation,
  launcherState,
} from './shoot-core.js';

// The one module that may send launcher frames (roller, roller_stop, tilt, fire) to the robot.
//
// A session is this page operating the launcher: it starts with 「ローラーを回す」 (or a tilt) and
// lasts while this module repeats `roller` ten times a second (the bridge's dead-man is 0.5 s;
// power 0 while it only tilts). The roller is a toggle with a heartbeat rather than hold-to-run:
// the learner's hand has to be free for 「1枚発射」 (a Chromebook has one pointer), and the
// heartbeat, the bridge's dead-man and its 30 s limit stop it whenever the page cannot keep it
// under control. It stops by itself
// - after every shot, once the shot's motion is over (the pupil then walks to the target);
// - on the learner's stop, Esc, the page hidden or closed, the link lost;
// - when the bridge ends it (a blocker such as the controller or the E-stop, the dead-man, the
//   time limit, another page's stop).
// A session that ends on this page sends `roller_stop` only when this page owns the launcher (the
// bridge lets any page stop any session, so a refused page must not); the stop bar (`stopLauncher`)
// is the one deliberate way to stop another page's session. `fire` carries `confirm: true` only
// while the learner's safety tick is set, and the tick is cleared after every session that fired
// or was stopped: one tick per firing.

const HEARTBEAT_MS = 100;
// Longer than this between two heartbeats and the bridge's dead-man (0.5 s) may have fired.
const STALL_MS = 400;
// The bridge answers the first roller/tilt with a shoot_state naming this page as the owner.
const START_TIMEOUT_MS = 1500;
// A session that only tilts (no roller) ends by itself this long after the last tilt.
const TILT_HOLD_MS = 3000;
// After this page's disc was fired, the roller keeps turning until the shot's motion is over plus
// this margin, so the disc is never left half-way through a stopping roller.
const AFTER_SHOT_MS = 800;
// Tilt frames while the slider moves: at most one per this many ms, the last one always sent.
const TILT_GAP_MS = 120;
const DEFAULT_PERCENT = 50;

let confirmed = false;
let current = null; // the session: { mode: 'spin' | 'tilt', started, finish(reason), ... }
let firePending = null; // { at } while a fire waits for its disc
let note = null; // the last thing to tell the learner: { kind, key, values, reason }
const desired = { percent: DEFAULT_PERCENT, tilt: null };
const tracker = createShotTracker();
const listeners = new Set();
const shotListeners = new Set();
const sessionListeners = new Set();
const arrived = { shoot_state: 0, roller: 0, shot: 0 }; // performance.now() of the latest
let shotsThisPage = 0;
let tiltTimer = 0;
let tiltSentAt = -Infinity;

const now = () => performance.now();

function readiness() {
  return shootReadiness({
    link: robotState(),
    shootState: latestRobot('shoot_state'),
    receivedAt: arrived.shoot_state,
    now: now(),
    confirmed,
  });
}

/** Everything a view needs: readiness, the buttons, this page's session and the last note. */
function shootModel() {
  const ready = readiness();
  const launcher = launcherState({
    roller: latestRobot('roller'),
    rollerAt: arrived.roller,
    shot: latestRobot('shot'),
    shotAt: arrived.shot,
    now: now(),
  });
  const local = {
    spinning: current?.mode === 'spin',
    session: Boolean(current),
    firePending: Boolean(firePending),
    shooting: Boolean(launcher.shot?.shooting),
  };
  const percent = clampPercent(desired.percent, ready.limits);
  const tilt = clampTilt(
    desired.tilt ?? launcher.shot?.tilt ?? ready.limits.tilt_min,
    ready.limits,
  );
  return {
    ...ready,
    controls: shootControls(ready, local),
    ...local,
    confirmed,
    percent,
    tilt,
    launcher,
    shotsThisPage,
    afterShot: Boolean(current?.stopAfter),
    note,
  };
}

function notify() {
  const model = shootModel();
  for (const fn of listeners) fn(model);
}

/** Subscribe to changes of shootModel(); returns the unsubscribe function. */
function onShoot(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Subscribe to this page's confirmed shots: `fn({percent, tilt, at})`. */
function onShotFired(fn) {
  shotListeners.add(fn);
  return () => shotListeners.delete(fn);
}

/** Subscribe to this page's sessions: `fn({type: 'start'})`, `fn({type: 'end', reason, shots})`. */
function onShootSession(fn) {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

function tellSession(event) {
  for (const fn of sessionListeners) fn(event);
}

/** The learner's "the surroundings are clear, one disc loaded" tick. Forgotten on reload. */
function confirmShootSafety(value) {
  confirmed = Boolean(value);
  if (confirmed && note?.kind === 'ended') note = null;
  notify();
}

// The learner's roller power kept within the limits in force now.
const chosenPercent = () => clampPercent(desired.percent, readiness().limits);

/** Roller power in whole percent for this page's next session (and the running one). */
function setRollerPercent(percent) {
  desired.percent = clampPercent(percent, readiness().limits);
  if (current?.mode === 'spin') current.percent = desired.percent;
  notify();
}

// This page may end its own session with roller_stop only while no other page owns the launcher.
function mayStopOwn() {
  const state = latestRobot('shoot_state');
  return !(state?.active && state.owner !== null && state.owner !== robotState().session);
}

/** Stop the roller, whichever page operates it (the stop bar). Always allowed. */
function stopLauncher() {
  sendRobot({ type: 'roller_stop' });
  current?.finish('stopped');
  notify();
}

/**
 * Stop this page's own session (「ローラーを止める」, Esc); never another page's. `reason` 'left':
 * the launcher block is no longer on screen (another topic or course).
 */
function stopOwn(reason) {
  current?.finish(reason === 'left' ? 'left' : 'stopped');
}

function heartbeat(session) {
  const at = now();
  // The page's script stood still (a stalled or sleeping tab): the bridge's dead-man may already
  // have ended the session, and a late heartbeat would start the roller again. Stop instead.
  if (at - session.beatAt > STALL_MS) return session.finish('stalled');
  session.beatAt = at;
  if (!session.started && at - session.startedAt > START_TIMEOUT_MS)
    return session.finish('no_answer');
  if (session.mode === 'tilt' && at - session.lastTiltAt > TILT_HOLD_MS)
    return session.finish('idle');
  const shooting = latestRobot('shot')?.shooting === true;
  if (session.stopAfter && !shooting && at >= session.stopAfter) return session.finish('fired');
  const percent = session.mode === 'spin' ? session.percent : 0;
  if (!sendRobot({ type: 'roller', power: percent / 100 })) return session.finish('lost');
  const expired = expireFire(tracker, at, latestRobot('shot')?.lab_refused ?? null);
  if (expired) missed(expired);
  return null;
}

function startSession(mode) {
  if (current) return current;
  const session = {
    mode,
    percent: chosenPercent(),
    started: false,
    startedAt: now(),
    beatAt: now(),
    lastTiltAt: now(),
    stopAfter: 0,
    shots: 0,
    timer: 0,
  };
  session.finish = (reason) => finishSession(session, reason);
  current = session;
  note = null;
  session.timer = setInterval(() => heartbeat(session), HEARTBEAT_MS);
  heartbeat(session);
  return session;
}

function finishSession(session, reason) {
  if (current !== session) return;
  current = null;
  clearInterval(session.timer);
  clearTimeout(tiltTimer);
  tiltTimer = 0;
  // A fire already sent stays in the tracker: its disc may still fly and becomes a row then.
  firePending = null;
  const local = reason;
  // Ended by the bridge or the link: nothing to send. Otherwise tell the bridge at once rather
  // than waiting for its dead-man, unless another page owns the launcher.
  if (!['bridge', 'lost', 'refused'].includes(local) && mayStopOwn())
    sendRobot({ type: 'roller_stop' });
  // One tick per firing: a session that fired, or that anything but the page's quiet end of a
  // tilt stopped, needs a fresh look around. A request that never started changes nothing.
  if (session.started && (session.shots > 0 || !keepsConfirmation(local))) confirmed = false;
  const key = sessionEndKey({
    local,
    lastStop: latestRobot('shoot_state')?.last_stop ?? null,
    session: robotState().session,
  });
  if (key && !(note?.kind === 'refused' && local === 'refused'))
    note = { kind: 'ended', key, values: {} };
  if (session.started) tellSession({ type: 'end', reason: key ?? local, shots: session.shots });
  notify();
}

/** Start the roller at the chosen power (「ローラーを回す」); a tilt-only session carries on. */
function startRoller() {
  const model = shootModel();
  if (!model.controls.spin.enabled || model.controls.spin.stop) return;
  if (current) {
    current.mode = 'spin';
    current.percent = chosenPercent();
    notify();
    return;
  }
  startSession('spin');
  notify();
}

function sendTilt() {
  tiltTimer = 0;
  if (!current) return;
  tiltSentAt = now();
  current.lastTiltAt = now();
  sendRobot({ type: 'tilt', deg: desired.tilt });
}

/** Tilt the launcher to `deg` (the slider); starts a tilt-only session when none runs. */
function setTilt(deg) {
  const model = shootModel();
  desired.tilt = clampTilt(deg, model.limits);
  if (!model.controls.tilt.enabled) {
    notify();
    return;
  }
  startSession('tilt');
  if (!current) {
    notify(); // the link went away while starting
    return;
  }
  current.lastTiltAt = now();
  clearTimeout(tiltTimer);
  const wait = Math.max(0, TILT_GAP_MS - (now() - tiltSentAt));
  tiltTimer = setTimeout(sendTilt, wait);
  notify();
}

/** Fire one disc (「1枚発射」): sent only with the tick set and the bridge ready. */
function fireOne() {
  const model = shootModel();
  if (!confirmed || !model.controls.fire.enabled || !current) return;
  firePending = { at: now() };
  // The power the roller really runs at: the page's choice within the limits in force now (the
  // nodes may have narrowed them since the session started; the bridge clamps to the same).
  const percent = clampPercent(current.percent, model.limits);
  noteFireSent(tracker, { at: now(), percent, tilt: model.tilt });
  note = null;
  if (!sendRobot({ type: 'fire', confirm: confirmed === true })) current.finish('lost');
  notify();
}

function missed(result) {
  firePending = null;
  note = { kind: 'not_fired', key: 'not_fired', reason: result.reason };
  notify();
}

// --- what the bridge says ----------------------------------------------------------------------

function onShootState(state) {
  arrived.shoot_state = now();
  const session = current;
  if (session) {
    const mine = state.active && state.owner === robotState().session;
    if (mine && !session.started) {
      session.started = true;
      tellSession({ type: 'start' });
    } else if (session.started && !mine) session.finish('bridge');
  }
  notify();
}

function onRefused(refused) {
  if (refused.request === 'fire') {
    firePending = null;
    dropPendingFire(tracker);
  }
  note = { kind: 'refused', refused };
  if (current && !current.started && refused.request !== 'fire') current.finish('refused');
  notify();
}

function onShot(shot) {
  arrived.shot = now();
  const result = ingestShot(tracker, shot, now());
  if (result?.kind === 'fired') {
    firePending = null;
    shotsThisPage += 1;
    if (current) {
      current.shots += 1;
      current.stopAfter = now() + AFTER_SHOT_MS;
    }
    note = { kind: 'fired', row: result.row };
    for (const fn of shotListeners) fn({ ...result.row, at: new Date() });
  } else if (result?.kind === 'not_fired') missed(result);
  notify();
}

function initShootLink() {
  onRobot('shoot_state', onShootState);
  onRobot('shoot_refused', onRefused);
  onRobot('shot', onShot);
  onRobot('roller', () => {
    arrived.roller = now();
  });
  onRobot('state', (link) => {
    if (link.phase !== 'open') current?.finish('lost');
    notify();
  });
  // A hidden page throttles its timers, so it could not keep the roller under control: stop.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) current?.finish('hidden');
  });
  window.addEventListener('pagehide', () => current?.finish('hidden'));
  // Esc stops this page's own session only (it also closes dialogs; see drive-link.js).
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && current) current.finish('stopped');
  });
}

initShootLink();

export {
  shootModel,
  onShoot,
  onShotFired,
  onShootSession,
  confirmShootSafety,
  setRollerPercent,
  setTilt,
  startRoller,
  stopOwn,
  stopLauncher,
  fireOne,
};
