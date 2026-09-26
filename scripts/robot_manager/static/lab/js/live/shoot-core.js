// Operating the real launcher (roller, tilt, one disc) from a lesson: the decisions, with no DOM
// and no WebSocket, so every rule is a Node test (test/shoot-core.test.mjs). shoot-link.js sends
// what these functions allow; shoot-view.js shows the reasons they name.
//
// The bridge (questix_lab_bridge/questix_lab_bridge/shoot.py) enforces the safety rules itself:
// allow_shoot, the launcher nodes accepting lab input, no other publisher, E-stop released, the
// controller not in use, one page at a time, the power and tilt limits, a roller dead-man, the
// longest session, the spin-up before a shot and the fire interval. This module only mirrors them
// so the page can say *why* a button is off before the learner presses it, and counts down the
// bridge's times between its shoot_state frames.
//
// Units: roller power is a fraction 0..1 on the wire and a whole percent on the page; tilt in
// degrees; times in seconds (arrival times given to this module in milliseconds of one clock).

import { fillSentence as fill } from '../core/content.js';

// Why this page cannot operate the launcher now, in the order they are shown and fixed.
const SHOOT_BLOCKERS = [
  'no_link', // not connected to a robot
  'old_bridge', // the bridge predates the launcher (no hello.shoot)
  'not_allowed', // robot_manager has not allowed firing from the lessons
  'no_launcher', // esc_motor_control / shot_component missing or not accepting lab input
  'other_publisher', // something else publishes the launcher's lab topics
  'emergency_stop',
  'controller', // the controller uses the launcher (it always wins)
  'busy', // another page operates the launcher
  'unconfirmed', // the learner has not ticked the safety check
];
// Reasons the learner deals with at the buttons (tick the box, wait); the others need the teacher.
const LEARNER_BLOCKERS = ['emergency_stop', 'controller', 'busy', 'unconfirmed'];
// Blockers that say the launcher cannot be offered at all: the block shrinks to one line.
const OFF_BLOCKERS = ['no_link', 'old_bridge', 'not_allowed'];

// What hello.shoot says before the first shoot_state (the bridge's defaults, README).
const DEFAULT_LIMITS = {
  max_power: 0.8,
  min_fire_power: 0.2,
  spin_up_sec: 1,
  fire_interval_sec: 2,
  tilt_min: 0,
  tilt_max: 120,
  deadman: 0.5,
  seconds: 30,
};
// shoot_state.limits keys and the hello.shoot fields that carry the same caps.
const HELLO_LIMITS = {
  max_power: 'max_power',
  min_fire_power: 'min_fire_power',
  spin_up_sec: 'spin_up_sec',
  fire_interval_sec: 'fire_interval_sec',
  tilt_min: 'tilt_min',
  tilt_max: 'tilt_max',
  deadman: 'deadman_sec',
  seconds: 'max_spin_sec',
};
const PERCENT = 100;
// A fire the bridge accepted is confirmed by /shot/status fired_count going up; without that by
// then, the node refused it (its own interval, E-stop) or the status is lost.
const FIRE_CONFIRM_MS = 3000;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const secondsLeft = (value, elapsed) => (finite(value) ? Math.max(0, value - elapsed) : null);

/** The launcher part of the bridge's hello: `{allowed, limits}`, or null (older bridge). */
function shootSupport(hello) {
  const shoot = hello?.shoot;
  if (!shoot || typeof shoot !== 'object') return null;
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, helloKey] of Object.entries(HELLO_LIMITS))
    if (finite(shoot[helloKey])) limits[key] = shoot[helloKey];
  return { allowed: shoot.allowed === true, limits };
}

function ownerOf(state, session) {
  if (!state?.active || state.owner === null || state.owner === undefined) return null;
  return state.owner === session ? 'me' : 'other';
}

function stateBlockers(state) {
  const blockers = [];
  for (const blocker of state?.blockers ?? []) {
    if (SHOOT_BLOCKERS.includes(blocker?.code))
      blockers.push({
        code: blocker.code,
        nodes: blocker.nodes ?? null,
        parts: blocker.parts ?? null,
      });
  }
  return blockers;
}

/**
 * What the page may do right now. `link` is robot-link's state (`phase`, `session`, `hello`),
 * `shootState` the bridge's latest `shoot_state` (or null) and `receivedAt` when it arrived [ms],
 * `now` [ms], `confirmed` the learner's safety tick. Returns `{ready, allowed, blockers, owner,
 * active, limits, lastStop, power, tiltDeg, sessionLeft, spinReadyIn, nextFireIn, readyToFire,
 * fired}`; `owner` is who operates the launcher ('me', 'other' or null), times are counted down
 * from the frame (seconds, null when the bridge says none).
 */
function shootReadiness({ link, shootState, receivedAt = 0, now = 0, confirmed = false }) {
  const blockers = [];
  const connected = link?.phase === 'open';
  const support = connected ? shootSupport(link.hello) : null;
  const state = connected && support?.allowed ? shootState : null;
  if (!connected) blockers.push({ code: 'no_link', nodes: null, parts: null });
  else if (!support) blockers.push({ code: 'old_bridge', nodes: null, parts: null });
  else if (!support.allowed || state?.allowed === false)
    blockers.push({ code: 'not_allowed', nodes: null, parts: null });
  else if (!state) blockers.push({ code: 'no_launcher', nodes: null, parts: null });
  blockers.push(...stateBlockers(state).filter((b) => !blockers.some((o) => o.code === b.code)));
  const owner = ownerOf(state, link?.session);
  if (owner === 'other') blockers.push({ code: 'busy', nodes: null, parts: null });
  if (!confirmed) blockers.push({ code: 'unconfirmed', nodes: null, parts: null });
  blockers.sort((a, b) => SHOOT_BLOCKERS.indexOf(a.code) - SHOOT_BLOCKERS.indexOf(b.code));
  const elapsed = Math.max(0, (now - receivedAt) / 1000);
  const limits = { ...(support?.limits ?? DEFAULT_LIMITS), ...(state?.limits ?? {}) };
  const mine = owner === 'me';
  return {
    ready: blockers.length === 0,
    allowed: Boolean(support?.allowed) && state?.allowed !== false,
    blockers,
    owner,
    active: Boolean(state?.active),
    limits,
    lastStop: state?.last_stop ?? null,
    power: finite(state?.roller?.power) ? state.roller.power : 0,
    tiltDeg: finite(state?.tilt_deg) ? state.tilt_deg : null,
    sessionLeft: mine ? secondsLeft(limits.seconds - (state.session_sec ?? 0), elapsed) : null,
    spinReadyIn: mine ? secondsLeft(state.spin_ready_in_sec, elapsed) : null,
    nextFireIn: secondsLeft(state?.next_fire_in_sec ?? 0, elapsed) ?? 0,
    readyToFire: mine && state.ready_to_fire === true,
    fired: finite(state?.fired) ? state.fired : 0,
  };
}

/** Whether the launcher block can offer anything at all (false: one line instead). */
const shootOffered = (readiness) =>
  !readiness.blockers.some((blocker) => OFF_BLOCKERS.includes(blocker.code));

// --- the buttons ---------------------------------------------------------------------------

/**
 * Which controls are enabled and, for each disabled one, the key of the reason (content
 * shoot.json `why`, or a blocker code) and its values. `readiness` from shootReadiness, `local`
 * the page's own side: `{spinning, session, firePending, shooting}` (`spinning`: this page asked
 * for the roller; `session`: this page has a session at all, tilt only included; `shooting`:
 * /shot/status says a shot is moving).
 */
function shootControls(readiness, local = {}) {
  const firstBlocker = (codes) => readiness.blockers.find((b) => codes.includes(b.code)) ?? null;
  // The reasons that stop anything new: everything except the tick is a blocker for all controls.
  const hard = readiness.blockers.find((blocker) => blocker.code !== 'unconfirmed') ?? null;
  const unconfirmed = firstBlocker(['unconfirmed']);
  const blocked = hard ?? unconfirmed;
  const spin = local.spinning
    ? { enabled: true, stop: true, reason: null }
    : { enabled: !blocked, stop: false, reason: blocked ? { key: blocked.code } : null };
  let tilt = { enabled: !blocked, reason: blocked ? { key: blocked.code } : null };
  if (!blocked && (local.firePending || local.shooting))
    tilt = { enabled: false, reason: { key: 'shooting' } };
  return { spin, tilt, fire: fireControl(readiness, local, blocked) };
}

function fireControl(readiness, local, blocked) {
  const off = (key, values = {}) => ({ enabled: false, reason: { key, values } });
  if (blocked) return off(blocked.code);
  if (!local.spinning) return off('not_spinning');
  if (readiness.owner !== 'me') return off('starting');
  if (local.firePending) return off('fire_pending');
  if (local.shooting) return off('shooting');
  if (readiness.spinReadyIn === null || readiness.spinReadyIn > 0)
    return off('spinning_up', {
      seconds: (readiness.spinReadyIn ?? readiness.limits.spin_up_sec).toFixed(1),
    });
  if (readiness.nextFireIn > 0)
    return off('interval', { seconds: readiness.nextFireIn.toFixed(1) });
  if (!readiness.readyToFire) return off('starting');
  return { enabled: true, reason: null };
}

// --- percent and degrees on the page -------------------------------------------------------

/** The roller slider's range in whole percent: from the least power that can fire to the cap. */
function powerRange(limits) {
  const max = Math.floor(limits.max_power * PERCENT + 1e-9);
  const min = Math.min(max, Math.ceil(limits.min_fire_power * PERCENT - 1e-9));
  return { min: Math.max(0, min), max: Math.max(0, max) };
}

/** A power in percent kept within the slider's range. */
function clampPercent(percent, limits) {
  const { min, max } = powerRange(limits);
  const value = finite(percent) ? Math.round(percent) : min;
  return Math.max(min, Math.min(max, value));
}

/** A tilt in degrees kept within the limits (whole degrees). */
function clampTilt(deg, limits) {
  const low = Math.ceil(limits.tilt_min - 1e-9);
  const high = Math.floor(limits.tilt_max + 1e-9);
  const value = finite(deg) ? Math.round(deg) : low;
  return Math.max(low, Math.min(Math.max(low, high), value));
}

// --- shots: which fired_count increase was this page's disc --------------------------------

/** A fresh tracker: no fired_count seen yet, no fire waiting to be confirmed. */
const createShotTracker = () => ({ count: null, pending: null });

/** This page sent `fire` at `at` [ms] with the roller at `percent` and the tilt it asked for. */
function noteFireSent(tracker, { at, percent, tilt }) {
  tracker.pending = { at, percent, tilt };
}

/** The bridge refused the fire (shoot_refused): nothing will come of it. */
function dropPendingFire(tracker) {
  tracker.pending = null;
}

/**
 * Take one `shot` status message that arrived at `at` [ms]. Returns null, or
 * - `{kind: 'fired', row}` when fired_count went up with `last_fire_source` 'lab' while this page
 *   waited for its disc: `row` is `{percent, tilt}` (the measured tilt when the status has one);
 * - `{kind: 'other_fired', source}` when it went up otherwise (the controller, another page);
 * - `{kind: 'not_fired', reason}` when this page's fire was not confirmed within FIRE_CONFIRM_MS
 *   (`reason`: shot_component's `lab_refused`, or null).
 */
function ingestShot(tracker, shot, at) {
  const count = shot?.fired_count;
  if (!Number.isInteger(count)) return expireFire(tracker, at, shot?.lab_refused ?? null);
  const before = tracker.count;
  tracker.count = count;
  if (before === null || count <= before) return expireFire(tracker, at, shot.lab_refused ?? null);
  const pending = tracker.pending;
  if (pending && shot.last_fire_source === 'lab') {
    tracker.pending = null;
    const tilt = finite(shot.tilt_deg) ? shot.tilt_deg : pending.tilt;
    return { kind: 'fired', row: { percent: pending.percent, tilt } };
  }
  return { kind: 'other_fired', source: shot.last_fire_source ?? null };
}

/** Give up on a fire that was not confirmed in time; `{kind: 'not_fired', reason}` or null. */
function expireFire(tracker, at, reason = null) {
  if (!tracker.pending || at - tracker.pending.at <= FIRE_CONFIRM_MS) return null;
  tracker.pending = null;
  return { kind: 'not_fired', reason };
}

// --- why a session ended ---------------------------------------------------------------------

// Ends the learner does not need a sentence for: the page's own quiet stops.
const QUIET_ENDS = ['fired', 'idle'];

/**
 * The key of the sentence (shoot.json `ended`) for a session that ended: `local` is the page's
 * own reason ('stopped', 'hidden', 'lost', 'fired', 'idle', 'no_answer', 'refused') or 'bridge',
 * when the bridge ended it; then `lastStop` (shoot_state.last_stop) and `session` (this page's id)
 * tell why. Null when nothing needs saying.
 */
function sessionEndKey({ local, lastStop = null, session = null }) {
  if (local !== 'bridge') return QUIET_ENDS.includes(local) ? null : local;
  const reason = lastStop?.reason ?? 'stopped';
  if (reason === 'stopped') return lastStop?.by === session ? 'stopped' : 'stopped_other';
  return reason;
}

/** Whether the safety tick survives this end: only the page's quiet end of a tilt-only session. */
const keepsConfirmation = (local) => local === 'idle';

// --- sentences --------------------------------------------------------------------------------

/**
 * The learner's sentence for a reason key: a blocker code (`copy.blockers[key].student`), a
 * button reason (`copy.why[key]`) or a refusal (`copy.refused[key]`), filled with `values`.
 * An unknown key comes back as itself, so a new bridge reason is visible rather than silent.
 */
function reasonSentence(key, copy, values = {}) {
  const sentence = copy.why?.[key] ?? copy.blockers?.[key]?.student ?? copy.refused?.[key];
  return sentence ? fill(sentence, values) : key;
}

/** Blocker details as sentence values: node names and the parts concerned, in words. */
function blockerValues(blocker, copy) {
  const parts = (blocker.parts ?? []).map((part) => copy.parts?.[part] ?? part);
  return { nodes: (blocker.nodes ?? []).join('、'), parts: parts.join('・') };
}

/** One learner line for a refusal answer (`shoot_refused`), with the next step. */
function refusalSentence(refused, copy, limits = DEFAULT_LIMITS) {
  const values = {
    seconds: finite(refused.next_fire_in_sec) ? refused.next_fire_in_sec.toFixed(1) : '',
    spin: finite(refused.spin_ready_in_sec) ? refused.spin_ready_in_sec.toFixed(1) : '',
    interval: String(limits.fire_interval_sec),
  };
  const sentence = copy.refused?.[refused.reason] ?? copy.blockers?.[refused.reason]?.student;
  return sentence ? fill(sentence, values) : fill(copy.refused.unknown, { reason: refused.reason });
}

// --- the launcher's state, as the block shows it ----------------------------------------------

// Older than this, a status no longer describes the launcher now (both come at 5 Hz).
const STATUS_STALE_MS = 1000;

/**
 * `roller` / `shot` are the latest status messages (or null) with their arrival times [ms]:
 * the roller's command in percent and who gives it, the measured tilt, the shot count, whether a
 * shot is moving, and whether each is fresh.
 */
function launcherState({ roller, rollerAt, shot, shotAt, now }) {
  const rollerFresh = Boolean(roller) && now - rollerAt <= STATUS_STALE_MS;
  const shotFresh = Boolean(shot) && now - shotAt <= STATUS_STALE_MS;
  return {
    roller: rollerFresh
      ? {
          percent: finite(roller.command) ? Math.round(roller.command * PERCENT) : null,
          source: ['joy', 'lab', 'idle'].includes(roller.source) ? roller.source : 'idle',
          locked: roller.lab_locked === true,
          estop: roller.estop === true,
        }
      : null,
    shot: shotFresh
      ? {
          tilt: finite(shot.tilt_deg) ? shot.tilt_deg : null,
          fired: Number.isInteger(shot.fired_count) ? shot.fired_count : null,
          shooting: shot.shooting === true,
          lastSource: shot.last_fire_source ?? null,
          estop: shot.estop === true,
        }
      : null,
    heard: { roller: Boolean(roller), shot: Boolean(shot) },
  };
}

// --- a recorded session, for 記録の一覧 --------------------------------------------------------

/**
 * What a recording of a launcher session shows (its `roller` / `shot` streams): the highest roller
 * command in percent, the tilt at the end, the discs fired while it ran (fired_count going up),
 * and whether the controller or the E-stop took part. Null when it holds no launcher status.
 */
function launcherRecordSummary(recording) {
  const rollers = recording?.streams?.roller ?? [];
  const shots = recording?.streams?.shot ?? [];
  if (!rollers.length && !shots.length) return null;
  const commands = rollers.map((message) => message.command).filter(finite);
  const counts = shots.map((message) => message.fired_count).filter(Number.isInteger);
  const tilts = shots.map((message) => message.tilt_deg).filter(finite);
  let fired = 0;
  for (let index = 1; index < counts.length; index += 1)
    fired += Math.max(0, counts[index] - counts[index - 1]);
  return {
    maxPercent: commands.length ? Math.round(Math.max(...commands) * PERCENT) : null,
    tilt: tilts.length ? tilts.at(-1) : null,
    fired,
    controller: rollers.some((message) => message.source === 'joy'),
    estop: [...rollers, ...shots].some((message) => message.estop === true),
  };
}

export {
  launcherRecordSummary,
  SHOOT_BLOCKERS,
  LEARNER_BLOCKERS,
  DEFAULT_LIMITS,
  FIRE_CONFIRM_MS,
  STATUS_STALE_MS,
  shootSupport,
  shootReadiness,
  shootOffered,
  shootControls,
  powerRange,
  clampPercent,
  clampTilt,
  createShotTracker,
  noteFireSent,
  dropPendingFire,
  ingestShot,
  expireFire,
  sessionEndKey,
  keepsConfirmation,
  reasonSentence,
  blockerValues,
  refusalSentence,
  launcherState,
};
