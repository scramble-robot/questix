const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const TrialView = require('../static/trial-view.js');
const StatusView = require('../static/status-view.js');

function ready(state = 'pass', blockers = []) {
  const now = new Date();
  return { checked_at: now.toISOString(), common_checks: blockers,
    normal: { ready: !blockers.length }, trial: { ready: state === 'pass' && !blockers.length,
      preflight: { state, message: state === 'pass' ? '確認済み' : '再確認してください',
        checked_at: now.toISOString(), expires_at: new Date(+now + 60000).toISOString() } } };
}

function fixture(fetch) {
  const elements = new Map();
  const created = [];
  function element() {
    const el = { textContent: '', hidden: false, checked: false, value: '', disabled: false,
      dataset: {}, style: {}, children: [], events: {}, classList: { toggle() {}, add() {}, remove() {} },
      append(...items) { el.children.push(...items); }, appendChild(item) { el.children.push(item); },
      replaceChildren(...items) { el.children = items; },
      addEventListener(name, callback) { el.events[name] = callback; }, setAttribute() {} };
    return el;
  }
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    createElement() { const el = element(); created.push(el); return el; },
    querySelectorAll(selector) { return selector === '[data-trial]' ? created.filter((el) => el.dataset.trial) : []; },
    querySelector() { return null; }, addEventListener() {},
  };
  const context = vm.createContext({ document, TrialView, StatusView, fetch, setTimeout() {}, setInterval() {},
    location: { href: 'http://127.0.0.1:8888/' } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8'), context);
  vm.runInContext('setupRecorderEvents(); recBusy = false;', context);
  return { context, document, get: (id) => document.getElementById(id),
    run: (code) => vm.runInContext(code, context) };
}
const response = (data) => ({ ok: true, status: 200, json: async () => data });

for (const code of ['recorder_idle', 'robot_service', 'output_path', 'free_space', 'config_unreadable']) {
  test(`${code} disables start and renders the server reason as text`, async () => {
    const f = fixture(async () => response(ready('pass', [{ code, state: 'fail', message: '<理由>' }])));
    await f.run('refreshRecReadiness()');
    assert.equal(f.get('rec-start').disabled, true);
    assert.equal(f.get('rec-readiness-reasons').children[0].textContent, '<理由>');
  });
}

test('normal recording ignores trial-only checks; evidence waits for pass', async () => {
  const f = fixture(async () => response(ready('not_checked')));
  await f.run('refreshRecReadiness()');
  assert.equal(f.get('rec-start').disabled, false);
  f.get('rec-trial-mode').checked = true;
  f.run('renderRecReadiness()');
  assert.equal(f.get('rec-start').disabled, true);
  assert.match(f.get('rec-readiness-reasons').children[0].textContent, /再確認/);
});

test('polling does not query ROS; opening and explicit retry request preflight', async () => {
  const calls = [];
  const f = fixture(async (url) => { calls.push(url); return response(ready('not_checked')); });
  f.get('rec-trial-mode').checked = true;
  await f.run('refreshRecReadiness()');
  assert.deepEqual(calls, ['/api/rosbag/readiness']);
  await f.run('refreshRecReadiness(true)');
  assert.equal(calls.at(-1), '/api/rosbag/readiness?scope=trial&refresh=true');
  await f.get('rec-readiness-refresh').events.click();
  assert.equal(calls.at(-1), '/api/rosbag/readiness?scope=trial&refresh=true');
});

test('a fresh preflight is reused on a tab event, but explicit retry refreshes it', async () => {
  const calls = [];
  const f = fixture(async (url) => { calls.push(url); return response(ready()); });
  f.get('rec-trial-mode').checked = true;
  await f.run('refreshRecReadiness(true)');
  assert.equal(calls.length, 1);
  await f.run('refreshRecReadiness(true, true)');
  assert.equal(calls.length, 3);
});

test('expiry disables evidence without another ROS query and keeps stop available', async () => {
  const f = fixture(async () => response(ready()));
  f.get('rec-trial-mode').checked = true;
  f.get('rec-stop').disabled = false;
  await f.run('refreshRecReadiness()');
  assert.equal(f.get('rec-start').disabled, false);
  f.run('recReadinessExpires = Date.now() - 1; renderRecReadiness();');
  assert.equal(f.get('rec-start').disabled, true);
  assert.equal(f.get('rec-stop').disabled, false);
  assert.match(f.get('rec-readiness-reasons').children[0].textContent, /古く/);
});

test('communication loss discards the last pass', async () => {
  let offline = false;
  const f = fixture(async () => { if (offline) throw Error('offline'); return response(ready()); });
  await f.run('refreshRecReadiness()');
  assert.equal(f.get('rec-start').disabled, false);
  offline = true;
  await f.run('refreshRecReadiness()');
  assert.equal(f.get('rec-start').disabled, true);
  assert.match(f.get('rec-readiness-reasons').children[0].textContent, /確認できません/);
});

test('a late pass never overrides a newer refusal', async () => {
  let finish;
  let count = 0;
  const f = fixture(async () => ++count === 1 ? new Promise((resolve) => { finish = resolve; })
    : response(ready('pass', [{ code: 'robot_service', state: 'fail', message: '停止中' }])));
  const old = f.run('refreshRecReadiness()');
  await f.run('refreshRecReadiness()');
  finish(response(ready()));
  await old;
  assert.equal(f.get('rec-start').disabled, true);
  assert.equal(f.get('rec-readiness-reasons').children[0].textContent, '停止中');
});

test('form errors and pending sends disable start', async () => {
  const f = fixture(async () => response(ready()));
  f.get('rec-trial-mode').checked = true;
  await f.run('refreshRecReadiness()');
  const input = f.document.querySelectorAll('[data-trial]').find((el) => el.dataset.trial === 'battery_voltage');
  input.value = '101';
  input.events.input();
  assert.equal(f.get('rec-start').disabled, true);
  assert.match(f.get('rec-readiness-reasons').children[0].textContent, /バッテリー/);
  input.value = '';
  f.run('recSending = true; renderRecReadiness();');
  assert.equal(f.get('rec-start').disabled, true);
});

test('a pending start is sent once, while stop remains available after recording begins', async () => {
  let finish;
  let starts = 0;
  const f = fixture(async (url) => {
    if (url === '/api/rosbag/start') {
      starts++;
      return new Promise((resolve) => { finish = resolve; });
    }
    if (url === '/api/rosbag/status') return response({ recording: true, elapsed_sec: 0, size_bytes: 0 });
    return response(ready());
  });
  await f.run('refreshRecReadiness()');
  const sending = f.get('rec-start').events.click();
  await f.get('rec-start').events.click();
  assert.equal(starts, 1);
  assert.equal(f.get('rec-start').disabled, true);
  finish(response({ mode: 'generic', bag_name: 'robot_mock' }));
  await sending;
  assert.equal(f.get('rec-stop').disabled, false);
  assert.equal(f.get('rec-start').disabled, true);
});

test('opening the recording tab and toggling evidence run the event flow', async () => {
  const calls = [];
  const f = fixture(async (url) => { calls.push(url); return response(ready('not_checked')); });
  f.run('activatePanel("rec")');
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['/api/rosbag/readiness']);
  f.get('rec-trial-mode').checked = true;
  f.get('rec-trial-mode').events.change();
  await new Promise(setImmediate);
  assert.equal(calls.at(-1), '/api/rosbag/readiness?scope=trial&refresh=true');
  assert.equal(f.get('trial-form').hidden, false);
});

for (const state of ['not_checked', 'checking', 'fail', 'stale', 'error']) {
  test(`evidence state ${state} fails closed`, () => {
    assert.equal(TrialView.readiness(ready(state), true).ready, false);
  });
}
