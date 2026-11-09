// Production session functions and templates with fake recording, timers and sender state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fillSentence as fill } from '../js/core/content.js';
import { isEmptyRun, runStatusKey } from '../js/live/drive-report-core.js';
import * as shootCore from '../js/live/shoot-core.js';
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const json = (file) => JSON.parse(read(`content/live/${file}.json`));
const driveCopy = json('drive');
const shootCopy = json('shoot');
const bandCopy = json('control-status');
const html = (strings, ...values) =>
  strings.reduce(
    (s, v, i) => s + v + (typeof values[i] === 'function' ? '' : (values[i] ?? '')),
    '',
  );
function strip(source) {
  return source.replace(/^import[^]*?from ['"][^'"]+['"];\n/gm, '');
}
async function view(name, extras = {}) {
  const source = read(`js/live/${name}.js`);
  const names = source.match(/export \{([^]*?)\};/)[1].replace(/(\w+) as (\w+)/g, '$2: $1');
  return vm.runInNewContext(
    `(async()=>{${strip(source).replace(/export \{[^]*?\};/, `return {${names}};`)}})()`,
    {
      html,
      nothing: '',
      fill,
      loadJson: async (f) => JSON.parse(read(f)),
      unsafeHTML: (x) => x,
      runModeBadgeHtml: () => '',
      freshInteraction: () => {},
      ...extras,
    },
  );
}
const status = await view('control-status');
const driveView = await view('drive-view', { ...status, driveReportView: () => '' });
const shootView = await view('shoot-view', { ...status, ...shootCore });
const motion = {
  streams: {
    twist: [
      { stamp: 1, linear: 0.1, angular: 0 },
      { stamp: 2, linear: 0, angular: 0 },
    ],
  },
};
const empty = { streams: { twist: [] } };
const actions = new Proxy({}, { get: () => () => {} });
function drivePage(result, raw, planError = null) {
  let confirmed = true;
  const listeners = [];
  const history = [];
  const model = () => ({
    confirmed,
    allowed: true,
    ready: confirmed,
    blockers: confirmed ? [] : [{ code: 'unconfirmed' }],
    limits: { linear: 0.15, angular: 0.5 },
  });
  const ctx = {
    Error,
    AbortController,
    performance: { now: () => 0 },
    setTimeout: (fn) => queueMicrotask(fn),
    setInterval: () => 1,
    clearInterval: () => {},
    fill,
    driveCopy,
    captureCopy: json('capture'),
    driveEndedText: driveView.driveEndedText,
    isEmptyRun,
    runStatusText: (r) => json('drive-report').status[runStatusKey(r)],
    driveModel: model,
    onDrive: (fn) => listeners.push(fn),
    confirmDriveSafety: (v) => {
      confirmed = v;
      for (const fn of listeners) fn(model());
    },
    runDrive: async () => result,
    recordRobot: async () => {
      if (raw instanceof Error) throw raw;
      return raw;
    },
    revealLiveRun: () => {},
    cleanConditions: (x) => x,
    withRunInfo: (r, info) => ({ ...r, ...info }),
    liveLink: () => ({ connected: true, robot: { name: 'DEMO' } }),
    missingStreams: () => [],
    groupName: () => '',
    recordingSummary: () => ({ seconds: 1 }),
    keepRecording: () => true,
    addDriveRun: (r) => {
      history.push(r);
      return { id: 1 };
    },
    driveRun: () => null,
    keepRunOnRobot: async () => ({}),
    saveDriveRun: () => {},
  };
  vm.runInNewContext(
    strip(read('js/live/live-session.js')).replace(
      'export { createLiveSession };',
      'globalThis.create = createLiveSession;',
    ),
    ctx,
  );
  const session = ctx.create({
    slot: 'control-speed',
    lesson: 'DEMO',
    needs: [],
    seconds: 1,
    apply: () => ({ ok: true, note: '' }),
    update: () => {},
    drive: {
      plan: () => {
        if (planError) throw planError;
        return { seconds: 1, tail: 0 };
      },
      program: () => '',
      conditions: () => ({}),
    },
  });
  return { session, history, checked: () => confirmed };
}
const driveCases = [
  ['done-valid', { started: true, reason: 'done' }, motion, true],
  ['stopped-valid', { started: true, reason: 'stopped' }, motion, true],
  [
    'failed-after-start-valid',
    { started: true, reason: 'failed', message: 'DEMO: failed' },
    motion,
    true,
  ],
  ['record-failed', { started: true, reason: 'done' }, new Error('DEMO: recording failed'), true],
  [
    'refused',
    { started: false, reason: 'refused', blockers: [{ code: 'not_allowed' }] },
    motion,
    false,
  ],
  [
    'never-started-failed',
    { started: false, reason: 'failed', message: 'DEMO: failed' },
    motion,
    false,
  ],
  ['empty-record', { started: true, reason: 'done' }, empty, false],
  ['stopped-empty', { started: true, reason: 'stopped' }, empty, false],
];
for (const [name, result, raw, cleared] of driveCases)
  test(`drive ${name}: confirmation, band and paragraph agree`, async () => {
    const p = drivePage(result, raw);
    await p.session.actions.startDriveCapture();
    const m = p.session.model();
    assert.equal(p.checked(), !cleared);
    assert.equal(Boolean(m.drive.reconfirm), cleared);
    const markup = driveView.driveControls(m, m.drive, actions);
    assert.equal(markup.includes('data-drive-reconfirm'), cleared);
    assert.equal(markup.includes(bandCopy.reconfirm.drive[0]), cleared);
    if (raw instanceof Error) {
      assert.match(m.driveNote, /記録に失敗/);
      assert.match(m.driveNote, /DEMO: recording failed/);
      assert.equal(p.history.length, 0);
    }
    if (cleared) {
      assert(markup.includes(driveCopy.reconfirm[m.drive.reconfirm]));
      p.session.actions.confirmDrive(true);
      assert.equal(p.session.model().drive.reconfirm, '');
    }
  });
test('a failed plan leaves the confirmation and shows its actual failure', async () => {
  const p = drivePage({}, motion, new Error('DEMO: plan failed'));
  await p.session.actions.startDriveCapture();
  assert.equal(p.checked(), true);
  assert.equal(p.session.model().drive.reconfirm, '');
  assert.equal(p.session.model().driveNote, 'DEMO: plan failed');
});
function shootPage({ started, shots, reason, lastStop = null, checked = true }) {
  const session = { started, shots, timer: 0 };
  const callbacks = {};
  const sender = {
    ...shootCore,
    current: session,
    confirmed: checked,
    note: reason === 'fired' ? { kind: 'fired', row: { percent: 50, tilt: 40 } } : null,
    desired: { tilt: null },
    tiltTimer: 0,
    tiltAwaiting: null,
    firePending: null,
    clearInterval: () => {},
    clearTimeout: () => {},
    mayStopOwn: () => true,
    sendRobot: () => true,
    latestRobot: () => ({ last_stop: lastStop }),
    robotState: () => ({ session: 'demo' }),
    tellSession: (e) => callbacks.session?.(e),
    notify: () => callbacks.shoot?.(getModel()),
  };
  const getModel = () => ({
    confirmed: sender.confirmed,
    session: Boolean(sender.current),
    limits: { seconds: 30 },
    blockers: sender.confirmed ? [] : [{ code: 'unconfirmed' }],
  });
  const ui = {
    html,
    render: () => {},
    ref: () => {},
    nothing: '',
    fill,
    shootModel: getModel,
    shootCopy,
    shootBlock: () => '',
    liveStatus: () => ({ estop: 'released' }),
    onLiveStatus: () => {},
    onShoot: (fn) => {
      callbacks.shoot = fn;
    },
    onShotFired: () => {},
    onShootSession: (fn) => {
      callbacks.session = fn;
    },
    setInterval: () => 1,
    clearInterval: () => {},
    confirmShootSafety: () => {},
    setRollerPercent: () => {},
    stopOwn: () => {},
    fireOne: () => {},
  };
  vm.runInNewContext(
    strip(read('js/live/shoot-ui.js')).replace(
      'export { launcherPanel };',
      'globalThis.notice = () => reconfirm;',
    ),
    ui,
  );
  const source = read('js/live/shoot-link.js');
  const body = source.slice(
    source.indexOf('function finishSession('),
    source.indexOf('\n/** Start the roller'),
  );
  vm.runInNewContext(body + '\nglobalThis.finish = finishSession;', sender);
  return {
    end: () => sender.finish(session, reason),
    notice: () => ui.notice(),
    sender,
    reconfirm: () => {
      sender.confirmed = true;
      callbacks.shoot(getModel());
    },
    start: () => callbacks.shoot({ ...getModel(), session: true }),
  };
}
const shootCases = [
  ['fired', { started: true, shots: 1, reason: 'fired' }, true],
  ['own-stop', { started: true, shots: 0, reason: 'stopped' }, true],
  ['tilt-idle', { started: true, shots: 0, reason: 'idle' }, false],
  ['tilt-idle-after-shot', { started: true, shots: 1, reason: 'idle' }, true],
  [
    'blocker',
    { started: true, shots: 0, reason: 'bridge', lastStop: { reason: 'emergency_stop' } },
    true,
  ],
  ['lost', { started: true, shots: 0, reason: 'lost' }, true],
  ['refused-before-start', { started: false, shots: 0, reason: 'refused' }, false],
  ['no-answer', { started: false, shots: 0, reason: 'no_answer' }, false],
  ['left', { started: true, shots: 0, reason: 'left' }, true],
  ['already-unchecked', { started: true, shots: 0, reason: 'stopped', checked: false }, false],
];
for (const [name, input, cleared] of shootCases)
  test(`launcher ${name}: actual session reset agrees with UI notice`, () => {
    const p = shootPage(input);
    p.end();
    assert.equal(Boolean(p.notice()), cleared);
    const ready = {
      allowed: true,
      confirmed: p.sender.confirmed,
      blockers: p.sender.confirmed ? [] : [{ code: 'unconfirmed' }],
      limits: {
        max_power: 0.8,
        min_fire_power: 0.2,
        tilt_min: 0,
        tilt_max: 120,
        fire_interval_sec: 2,
      },
      launcher: { roller: null, shot: null, heard: {} },
      percent: 50,
      tilt: 40,
      estopState: 'released',
      reconfirm: p.notice(),
    };
    ready.controls = shootCore.shootControls(ready, { tiltKnown: true });
    const markup = shootView.shootBlock(ready, { tiltPreview: null }, actions);
    assert.equal(markup.includes('data-shoot-reconfirm'), cleared);
    assert.equal(markup.includes(bandCopy.reconfirm.shoot[0]), cleared);
    if (cleared) {
      assert(markup.includes(shootCopy.reconfirm[p.notice()]));
      p.reconfirm();
      assert.equal(p.notice(), '');
    }
  });
test('starting a new launcher session clears the old explanation', () => {
  const p = shootPage({ started: true, shots: 0, reason: 'stopped' });
  p.end();
  assert(p.notice());
  p.start();
  assert.equal(p.notice(), '');
});
for (const kind of ['drive', 'shoot'])
  test(`${kind} auto-reset never overrides the first blocker or active phase`, () => {
    const blocked = status.controlStatus(
      [{ code: 'not_allowed' }, { code: 'unconfirmed' }],
      '',
      kind,
      'done',
    );
    assert(!blocked.includes(bandCopy.reconfirm[kind][0]));
    assert(blocked.includes('許可を待っています'));
    const active = status.controlStatus(
      [{ code: 'unconfirmed' }],
      kind === 'drive' ? 'tail' : 'spinning',
      kind,
      'done',
    );
    assert(!active.includes(bandCopy.reconfirm[kind][0]));
  });
