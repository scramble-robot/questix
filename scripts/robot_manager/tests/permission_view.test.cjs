const test = require('node:test');
const assert = require('node:assert/strict');
const View = require('../static/permission-view.js');
const Status = require('../static/status-view.js');
const snapshot = (revision = 0, choices = {}, extra = {}) => ({
  instance: 'manager-a', revision, mode: 'lesson', running_mode: 'lesson', available: true,
  choices: { drive: 'none', launcher: 'none', ...choices }, ...extra,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
};
function fixture(options = {}) {
  let actual = snapshot(), failRead = false;
  const frames = [], writes = [];
  const controller = View.createController({
    read: async () => { if (failRead) throw Error('offline'); return actual; },
    write: async (kind, body) => {
      writes.push({ kind, body });
      actual = snapshot(actual.revision + 1, { ...actual.choices, [kind]: body.choice });
      return actual;
    },
    render: state => frames.push(structuredClone(state)), ...options,
  });
  return { controller, frames, writes, set: state => { actual = state; },
    fail: value => { failRead = value; } };
}

test('F21: confirmed permission names never claim that motion is possible', async () => {
  const f = fixture();
  await f.controller.refresh();
  await f.controller.choose('drive', 'controller_and_lab');
  assert.equal(f.controller.view().state.choices.drive, 'controller_and_lab');
  for (const state of ['pressed', 'unknown']) {
    const row = Status.overview({ service: 'active', mode: 'lesson', running_mode: 'lesson',
      emergency_stop: { state } }, null).estop;
    assert.equal(row.text, state === 'pressed' ? '押されています' : '不明');
    assert.equal(f.controller.view().state.choices.drive, 'controller_and_lab');
  }
  assert.doesNotMatch(JSON.stringify(View.LABELS), /動かせます|停止|止める|■/);
});

test('F22: pending renders before write and at 80 ms; rapid events cannot duplicate writes', async () => {
  const answer = deferred();
  let called = 0;
  const f = fixture({ write: async () => {
    assert.equal(f.frames.at(-1).pending.choice, 'controller');
    called++;
    return answer.promise;
  } });
  await f.controller.refresh();
  const first = f.controller.choose('drive', 'controller');
  assert.equal(f.controller.view().pending.kind, 'drive');
  assert.equal(f.controller.view().state.choices.drive, 'none');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(f.controller.view().pending.choice, 'controller');
  await f.controller.choose('launcher', 'controller_and_lab');
  assert.equal(called, 1);
  await new Promise(resolve => setTimeout(resolve, 720));
  answer.resolve(snapshot(1, { drive: 'controller' }));
  await first;
  assert.equal(f.controller.view().pending, null);
  assert.equal(f.controller.view().state.choices.drive, 'controller');
});

test('C07: a failed permission GET is distinct from confirmed OFF and recovery does not write', async () => {
  const f = fixture();
  await f.controller.refresh();
  assert.equal(f.controller.view().known, true);
  f.fail(true);
  await f.controller.refresh();
  assert.equal(f.controller.view().known, false);
  assert.equal(f.controller.view().state.choices.drive, 'none'); // historical data only
  await f.controller.choose('drive', 'controller');
  assert.equal(f.writes.length, 0);
  f.fail(false);
  await f.controller.refresh();
  assert.equal(f.controller.view().known, true);
  assert.equal(f.writes.length, 0);
});

test('C35: stop response renders OFF before poll; older poll and pending grant cannot restore ON', async () => {
  const old = deferred(), grant = deferred(), fresh = deferred();
  let reading = 0;
  const f = fixture({ read: () => [snapshot(1, { drive: 'controller' }), old.promise,
    fresh.promise][reading++], write: () => grant.promise });
  await f.controller.refresh();
  const poll = f.controller.refresh();
  const change = f.controller.choose('launcher', 'controller');
  f.controller.block();
  const stop = f.controller.settle(snapshot(5));
  assert.equal(f.frames.at(-1).state.choices.drive, 'none');
  assert.equal(f.frames.at(-1).known, true);
  old.resolve(snapshot(2, { drive: 'controller_and_lab' }));
  grant.resolve(snapshot(3, { launcher: 'controller' }));
  await Promise.all([poll, change]);
  assert.equal(f.controller.view().state.revision, 5);
  fresh.resolve(snapshot(5)); await stop;
  assert.equal(f.controller.view().state.choices.drive, 'none');
});

test('C35: a failed stop and unavailable re-read never assert confirmed OFF', async () => {
  const f = fixture(); await f.controller.refresh();
  await f.controller.choose('drive', 'controller');
  f.fail(true); f.controller.block(); await f.controller.settle(null);
  assert.equal(f.controller.view().known, false);
});

test('reverse polls, stale revisions and retired Manager instances never roll back confirmation', async () => {
  const a = deferred(), b = deferred(), f = fixture();
  let count = 0;
  const c = View.createController({ read: () => [a.promise, b.promise, snapshot(1, {}, {
    instance: 'manager-b' }), snapshot(999)][count++], write: async () => {}, render() {} });
  const first = c.refresh(), second = c.refresh();
  b.resolve(snapshot(8, { drive: 'controller' })); await second;
  a.resolve(snapshot(4)); await first;
  assert.equal(c.view().state.revision, 8);
  await c.refresh(); assert.equal(c.view().state.instance, 'manager-b');
  await c.refresh(); assert.equal(c.view().state.instance, 'manager-b');
  assert.equal(f.writes.length, 0);
});

test('409 stale grants explain the conflict and re-read without automatically retrying', async () => {
  let calls = 0;
  const f = fixture({ write: async () => {
    calls++;
    throw Object.assign(Error('conflict'), { reason: 'stale_revision', state: snapshot(3) });
  } });
  await f.controller.refresh();
  await f.controller.choose('drive', 'controller_and_lab');
  assert.equal(f.controller.view().error, View.CONFLICT);
  assert.equal(f.controller.view().state.revision, 3);
  assert.equal(calls, 1);
});

test('timeouts release pending, show unknown, read state, and ignore a late success', async () => {
  const late = deferred();
  const f = fixture({ timeoutMs: 15, write: () => late.promise });
  await f.controller.refresh(); f.fail(true);
  await f.controller.choose('drive', 'controller');
  assert.equal(f.controller.view().pending, null);
  assert.equal(f.controller.view().known, false);
  assert.match(f.controller.view().error, /時間切れ/);
  late.resolve(snapshot(2, { drive: 'controller' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.view().known, false);
  assert.equal(f.controller.view().state.choices.drive, 'none');
  assert.equal(View.TIMEOUT_MS, 5000);
});

test('permission reductions from streaming stop and reset are adopted without restoring prior choices', async () => {
  const f = fixture(); await f.controller.refresh();
  for (const kind of ['drive', 'launcher']) await f.controller.choose(kind, 'controller_and_lab');
  f.set(snapshot(3, { drive: 'controller', launcher: 'controller' }));
  await f.controller.refresh();
  assert.equal(f.controller.view().state.choices.drive, 'controller');
  f.set(snapshot(4)); await f.controller.refresh();
  assert.equal(f.controller.view().state.choices.launcher, 'none');
  assert.equal(f.writes.length, 2);
});

test('unavailable choices remain disabled with mode/stopped/unknown/mismatch reasons', () => {
  for (const mode of ['practice', 'competition']) assert.equal(View.unavailable(snapshot(1, {}, { mode })),
    '練習モードと大会モードでは、この許可は使いません（教材モードだけで使います）');
  assert.match(View.unavailable(snapshot(1, {}, { running_mode: null })), /停止中/);
  assert.match(View.unavailable(snapshot(1, {}, { running_mode: 'unknown' })), /確認できません/);
  assert.match(View.unavailable(snapshot(1, {}, { running_mode: 'practice' })), /一致しません/);
});

test('C37: status failure is unknown, not stopped, and never falls back to an old bridge release', () => {
  const rows = Status.overview(null, { bridge: { emergency_stop: false } });
  assert.equal(rows.estop.text, '確認不能');
  assert.equal(rows.driver.text, '確認不能');
  assert.equal(Status.headerEstop(rows.estop).label, '確認不能');
});
