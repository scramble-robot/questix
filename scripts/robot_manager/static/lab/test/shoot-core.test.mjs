// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// Operating the real launcher from a lesson: which buttons a learner may press and why not, the
// countdowns between the bridge's shoot_state frames, which fired_count increase was this page's
// disc, and the words for every reason (content/live/shoot.json). The bridge enforces the rules
// itself (questix_lab_bridge/shoot.py); these tests pin what the page says about them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  SHOOT_BLOCKERS,
  DEFAULT_LIMITS,
  FIRE_CONFIRM_MS,
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
  launcherRecordSummary,
} from '../js/live/shoot-core.js';

const copy = JSON.parse(
  fs.readFileSync(new URL('../content/live/shoot.json', import.meta.url), 'utf8'),
);

const SESSION = 7;
const HELLO = {
  shoot: {
    allowed: true,
    max_power: 0.8,
    tilt_min: 0,
    tilt_max: 120,
    fire_interval_sec: 2,
    min_fire_power: 0.2,
    spin_up_sec: 1,
    deadman_sec: 0.5,
    max_spin_sec: 30,
  },
};
const link = (hello = HELLO) => ({ phase: 'open', session: SESSION, hello });
const state = (patch = {}) => ({
  type: 'shoot_state',
  allowed: true,
  blockers: [],
  owner: null,
  active: false,
  roller: { power: 0, since_sec: 0 },
  tilt_deg: null,
  ready_to_fire: false,
  next_fire_in_sec: 0,
  spin_ready_in_sec: null,
  session_sec: 0,
  fired: 0,
  limits: {
    max_power: 0.8,
    min_fire_power: 0.2,
    spin_up_sec: 1,
    fire_interval_sec: 2,
    tilt_min: 0,
    tilt_max: 120,
    deadman: 0.5,
    seconds: 30,
  },
  last_stop: null,
  ...patch,
});
const codes = (readiness) => readiness.blockers.map((blocker) => blocker.code);

test('an older bridge without hello.shoot offers no launcher', () => {
  assert.equal(shootSupport({}), null);
  assert.equal(shootSupport(null), null);
  const readiness = shootReadiness({ link: link({}), shootState: null, confirmed: true });
  assert.deepEqual(codes(readiness), ['old_bridge']);
  assert.equal(readiness.allowed, false);
  assert.equal(shootOffered(readiness), false);
});

test('hello.shoot gives the limits before the first shoot_state', () => {
  const support = shootSupport({ shoot: { allowed: true, max_power: 0.6, max_spin_sec: 20 } });
  assert.equal(support.allowed, true);
  assert.equal(support.limits.max_power, 0.6);
  assert.equal(support.limits.seconds, 20);
  assert.equal(support.limits.deadman, DEFAULT_LIMITS.deadman);
  assert.equal(shootSupport({ shoot: { allowed: 'yes' } }).allowed, false, 'only a JSON true');
});

test('blockers are listed in the order they have to be fixed', () => {
  const offline = shootReadiness({ link: { phase: 'error' }, shootState: null });
  assert.deepEqual(codes(offline), ['no_link', 'unconfirmed']);
  assert.equal(shootOffered(offline), false);
  const off = shootReadiness({
    link: link({ shoot: { allowed: false } }),
    shootState: state({ allowed: false }),
    confirmed: true,
  });
  assert.deepEqual(codes(off), ['not_allowed']);
  const blocked = shootReadiness({
    link: link(),
    shootState: state({
      blockers: [
        { code: 'controller', nodes: null, parts: ['roller'] },
        { code: 'no_launcher', nodes: null, parts: ['shot'] },
        { code: 'emergency_stop', nodes: null, parts: ['topic'] },
      ],
      active: true,
      owner: 3,
    }),
  });
  assert.deepEqual(codes(blocked), [
    'no_launcher',
    'emergency_stop',
    'controller',
    'busy',
    'unconfirmed',
  ]);
  assert.equal(blocked.owner, 'other');
  for (const code of codes(blocked)) assert.ok(SHOOT_BLOCKERS.includes(code));
  assert.equal(shootOffered(blocked), true, 'the block stays to say what is missing');
});

test('ready once allowed, nothing blocks and the learner ticked the check', () => {
  const unticked = shootReadiness({ link: link(), shootState: state() });
  assert.deepEqual(codes(unticked), ['unconfirmed']);
  const ready = shootReadiness({ link: link(), shootState: state(), confirmed: true });
  assert.equal(ready.ready, true);
  assert.equal(ready.owner, null);
  // Allowed but no shoot_state yet (the frame follows hello): not offered as ready.
  const waiting = shootReadiness({ link: link(), shootState: null, confirmed: true });
  assert.deepEqual(codes(waiting), ['no_launcher']);
});

test('the bridge times are counted down between its frames', () => {
  const mine = state({
    active: true,
    owner: SESSION,
    roller: { power: 0.5, since_sec: 0.4 },
    spin_ready_in_sec: 0.6,
    next_fire_in_sec: 1.5,
    session_sec: 4,
  });
  const readiness = shootReadiness({
    link: link(),
    shootState: mine,
    receivedAt: 1000,
    now: 1400,
    confirmed: true,
  });
  assert.equal(readiness.owner, 'me');
  assert.ok(Math.abs(readiness.spinReadyIn - 0.2) < 1e-9);
  assert.ok(Math.abs(readiness.nextFireIn - 1.1) < 1e-9);
  assert.ok(Math.abs(readiness.sessionLeft - 25.6) < 1e-9);
  const later = shootReadiness({ link: link(), shootState: mine, receivedAt: 1000, now: 9000 });
  assert.equal(later.spinReadyIn, 0, 'never below zero');
  assert.equal(later.nextFireIn, 0);
  // Not spinning fast enough: the bridge says null, and so does the page.
  const idle = shootReadiness({
    link: link(),
    shootState: state({ active: true, owner: SESSION }),
    confirmed: true,
  });
  assert.equal(idle.spinReadyIn, null);
});

test('「1枚発射」 is enabled only when this page spins, the roller is steady and the interval is over', () => {
  const ready = (patch, now = 0) =>
    shootReadiness({
      link: link(),
      shootState: state({ active: true, owner: SESSION, ...patch }),
      receivedAt: 0,
      now,
      confirmed: true,
    });
  const spinning = { spinning: true, session: true };
  const steady = { spin_ready_in_sec: 0, ready_to_fire: true };
  assert.deepEqual(shootControls(ready(steady), spinning).fire, { enabled: true, reason: null });
  const fire = (patch, local = spinning, now = 0) => shootControls(ready(patch, now), local).fire;
  assert.equal(fire(steady, { spinning: false, session: true }).reason.key, 'not_spinning');
  assert.deepEqual(fire({ spin_ready_in_sec: 0.6 }).reason, {
    key: 'spinning_up',
    values: { seconds: '0.6' },
  });
  assert.equal(fire({ spin_ready_in_sec: null }).reason.key, 'spinning_up');
  assert.deepEqual(fire({ ...steady, next_fire_in_sec: 1.25 }).reason, {
    key: 'interval',
    values: { seconds: '1.3' },
  });
  assert.equal(fire({ ...steady, next_fire_in_sec: 1.25 }, spinning, 2000).enabled, true);
  assert.equal(fire(steady, { ...spinning, firePending: true }).reason.key, 'fire_pending');
  assert.equal(fire(steady, { ...spinning, shooting: true }).reason.key, 'shooting');
  // Before the bridge named this page the owner.
  const starting = shootReadiness({ link: link(), shootState: state(), confirmed: true });
  assert.equal(shootControls(starting, spinning).fire.reason.key, 'starting');
});

test('the tick and every blocker keep the buttons off, but a spinning roller can always be stopped', () => {
  const unticked = shootReadiness({ link: link(), shootState: state() });
  const controls = shootControls(unticked, {});
  assert.equal(controls.spin.enabled, false);
  assert.equal(controls.spin.reason.key, 'unconfirmed');
  assert.equal(controls.tilt.enabled, false);
  assert.equal(controls.fire.reason.key, 'unconfirmed');
  const estop = shootReadiness({
    link: link(),
    shootState: state({ blockers: [{ code: 'emergency_stop', parts: ['roller'] }] }),
    confirmed: true,
  });
  assert.equal(shootControls(estop, {}).spin.reason.key, 'emergency_stop');
  assert.deepEqual(shootControls(estop, { spinning: true }).spin, {
    enabled: true,
    stop: true,
    reason: null,
  });
  const ready = shootReadiness({ link: link(), shootState: state(), confirmed: true });
  assert.equal(shootControls(ready, { firePending: true }).tilt.reason.key, 'shooting');
  assert.equal(shootControls(ready, {}).tilt.enabled, true);
});

test('the sliders stay within the limits, and the roller never below what can fire', () => {
  assert.deepEqual(powerRange(DEFAULT_LIMITS), { min: 20, max: 80 });
  assert.deepEqual(powerRange({ ...DEFAULT_LIMITS, max_power: 0.15 }), { min: 15, max: 15 });
  assert.equal(clampPercent(95, DEFAULT_LIMITS), 80);
  assert.equal(clampPercent(5, DEFAULT_LIMITS), 20);
  assert.equal(clampPercent(Number.NaN, DEFAULT_LIMITS), 20);
  assert.equal(clampPercent(49.6, DEFAULT_LIMITS), 50);
  const tilt = { ...DEFAULT_LIMITS, tilt_min: 10.5, tilt_max: 60.2 };
  assert.equal(clampTilt(0, tilt), 11);
  assert.equal(clampTilt(90, tilt), 60);
  assert.equal(clampTilt(null, tilt), 11);
});

test("a fired_count increase from the lab while this page waits is this page's disc", () => {
  const tracker = createShotTracker();
  assert.equal(ingestShot(tracker, { fired_count: 3 }, 0), null, 'the first status only counts');
  noteFireSent(tracker, { at: 100, percent: 50, tilt: 30 });
  assert.equal(ingestShot(tracker, { fired_count: 3 }, 300), null);
  assert.deepEqual(
    ingestShot(tracker, { fired_count: 4, last_fire_source: 'lab', tilt_deg: 29.6 }, 400),
    { kind: 'fired', row: { percent: 50, tilt: 29.6 } },
  );
  assert.equal(tracker.pending, null);
  // The controller fired: not this page's row.
  assert.deepEqual(ingestShot(tracker, { fired_count: 5, last_fire_source: 'joy' }, 900), {
    kind: 'other_fired',
    source: 'joy',
  });
  // Waiting, but the increase is the controller's: the page keeps waiting for its own.
  noteFireSent(tracker, { at: 1000, percent: 60, tilt: 40 });
  assert.equal(
    ingestShot(tracker, { fired_count: 6, last_fire_source: 'joy' }, 1100).kind,
    'other_fired',
  );
  assert.notEqual(tracker.pending, null);
  // No tilt in the status: the tilt the page asked for.
  assert.deepEqual(ingestShot(tracker, { fired_count: 7, last_fire_source: 'lab' }, 1200).row, {
    percent: 60,
    tilt: 40,
  });
});

test('a fire the robot never confirmed is reported with its reason, once', () => {
  const tracker = createShotTracker();
  ingestShot(tracker, { fired_count: 0 }, 0);
  noteFireSent(tracker, { at: 0, percent: 40, tilt: 20 });
  assert.equal(expireFire(tracker, FIRE_CONFIRM_MS), null);
  assert.deepEqual(
    ingestShot(tracker, { fired_count: 0, lab_refused: 'interval' }, FIRE_CONFIRM_MS + 1),
    { kind: 'not_fired', reason: 'interval' },
  );
  assert.equal(expireFire(tracker, FIRE_CONFIRM_MS * 3), null, 'said once');
  noteFireSent(tracker, { at: 0, percent: 40, tilt: 20 });
  dropPendingFire(tracker);
  assert.equal(expireFire(tracker, FIRE_CONFIRM_MS * 3), null, 'a refused fire is not waited for');
  // A restarted node counts from zero again: its next increase is still seen.
  ingestShot(tracker, { fired_count: 5 }, 0);
  ingestShot(tracker, { fired_count: 0 }, 0);
  noteFireSent(tracker, { at: 0, percent: 40, tilt: 20 });
  assert.equal(ingestShot(tracker, { fired_count: 1, last_fire_source: 'lab' }, 10).kind, 'fired');
});

test('why a session ended, and whether the safety tick survives it', () => {
  assert.equal(sessionEndKey({ local: 'fired' }), null);
  assert.equal(sessionEndKey({ local: 'idle' }), null);
  assert.equal(sessionEndKey({ local: 'hidden' }), 'hidden');
  const bridge = (reason, by = null) =>
    sessionEndKey({ local: 'bridge', lastStop: { reason, by }, session: SESSION });
  assert.equal(bridge('controller'), 'controller');
  assert.equal(bridge('emergency_stop'), 'emergency_stop');
  assert.equal(bridge('timeout'), 'timeout');
  assert.equal(bridge('stopped', SESSION), 'stopped');
  assert.equal(bridge('stopped', 3), 'stopped_other');
  assert.equal(sessionEndKey({ local: 'bridge', lastStop: null }), 'stopped_other');
  assert.equal(keepsConfirmation('idle'), true);
  for (const reason of ['fired', 'stopped', 'bridge', 'hidden', 'lost'])
    assert.equal(keepsConfirmation(reason), false, reason);
});

test('every reason the page or the bridge can give has a sentence', () => {
  for (const code of SHOOT_BLOCKERS) assert.ok(copy.blockers[code]?.student, code);
  for (const code of ['no_launcher', 'other_publisher', 'not_allowed', 'old_bridge'])
    assert.ok(copy.blockers[code].teacher, code);
  // shoot_refused reasons (shoot.py) and the page's own button reasons.
  const refusals = [
    'not_allowed',
    'no_launcher',
    'other_publisher',
    'emergency_stop',
    'controller',
    'busy',
    'invalid',
    'no_confirm',
    'not_spinning',
    'shooting',
    'interval',
  ];
  for (const reason of refusals) assert.ok(copy.refused[reason], reason);
  for (const key of [
    'not_spinning',
    'starting',
    'fire_pending',
    'shooting',
    'spinning_up',
    'interval',
  ])
    assert.ok(copy.why[key], key);
  // last_stop reasons (shoot.py) and the page's own ends.
  const ends = [
    'stopped',
    'stopped_other',
    'timeout',
    'time_limit',
    'disconnected',
    'invalid',
    'not_allowed',
    'no_launcher',
    'other_publisher',
    'emergency_stop',
    'controller',
    'hidden',
    'lost',
    'stalled',
    'left',
    'no_answer',
    'refused',
  ];
  for (const key of ends) assert.ok(copy.ended[key], key);
});

test('sentences are filled with the numbers and names they mention', () => {
  assert.equal(
    reasonSentence('spinning_up', copy, { seconds: '0.6' }),
    '回転が安定するまで、あと0.6秒',
  );
  assert.equal(reasonSentence('made_up', copy), 'made_up', 'an unknown key stays visible');
  const values = blockerValues({ code: 'no_launcher', parts: ['roller', 'shot'] }, copy);
  assert.equal(values.parts, 'ローラー・発射機構');
  assert.equal(
    blockerValues({ code: 'other_publisher', nodes: ['/a', '/b'] }, copy).nodes,
    '/a、/b',
  );
  const interval = refusalSentence(
    { reason: 'interval', next_fire_in_sec: 1.24, spin_ready_in_sec: 0 },
    copy,
    DEFAULT_LIMITS,
  );
  assert.match(interval, /2秒たっていない/);
  assert.match(interval, /あと1\.2秒/);
  assert.match(refusalSentence({ reason: 'emergency_stop' }, copy), /非常停止/);
  assert.match(refusalSentence({ reason: 'brand_new' }, copy), /brand_new/);
});

test('a recorded launcher session is summed up for 記録の一覧', () => {
  assert.equal(launcherRecordSummary({ streams: { drive: [] } }), null);
  const summary = launcherRecordSummary({
    streams: {
      roller: [
        { stamp: 1, command: 0, source: 'idle' },
        { stamp: 2, command: 0.55, source: 'lab' },
        { stamp: 3, command: 1, source: 'joy', estop: false },
      ],
      shot: [
        { stamp: 1, fired_count: 4, tilt_deg: 30 },
        { stamp: 2, fired_count: 5, tilt_deg: 30 },
        { stamp: 3, fired_count: 0, tilt_deg: 35, estop: true }, // node restarted
        { stamp: 4, fired_count: 1, tilt_deg: 35 },
      ],
    },
  });
  assert.deepEqual(summary, {
    maxPercent: 100,
    tilt: 35,
    fired: 2,
    controller: true,
    estop: true,
  });
});

test('the launcher state shows fresh statuses only', () => {
  const roller = { command: 0.504, source: 'lab', lab_locked: false, estop: false };
  const shot = { tilt_deg: 30, fired_count: 2, shooting: true, last_fire_source: 'lab' };
  const fresh = launcherState({ roller, rollerAt: 0, shot, shotAt: 0, now: 500 });
  assert.deepEqual(fresh.roller, { percent: 50, source: 'lab', locked: false, estop: false });
  assert.equal(fresh.shot.tilt, 30);
  assert.equal(fresh.shot.fired, 2);
  assert.equal(fresh.shot.shooting, true);
  const stale = launcherState({ roller, rollerAt: 0, shot, shotAt: 0, now: 5000 });
  assert.equal(stale.roller, null);
  assert.equal(stale.shot, null);
  assert.deepEqual(stale.heard, { roller: true, shot: true });
  const never = launcherState({ roller: null, rollerAt: 0, shot: null, shotAt: 0, now: 0 });
  assert.deepEqual(never.heard, { roller: false, shot: false });
  const odd = launcherState({
    roller: { source: 'x' },
    rollerAt: 0,
    shot: null,
    shotAt: 0,
    now: 0,
  });
  assert.equal(odd.roller.source, 'idle');
  assert.equal(odd.roller.percent, null);
});
