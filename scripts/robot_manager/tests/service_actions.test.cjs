const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const OperatorGuide = require('../static/operator-guide.js');
const ControlLabels = require('../static/control-labels.js');
const StatusView = require('../static/status-view.js');

function fixture(fetch, extra = {}) {
  const elements = new Map();
  function element() {
    const classes = new Set();
    const el = { textContent: '', hidden: true, disabled: false, dataset: {}, children: [],
      classList: { toggle(name, on) { if (on ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
        contains: (name) => classes.has(name), add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
      appendChild(child) { el.children.push(child); }, append(...items) { el.children.push(...items); },
      replaceChildren(...items) { el.children = items; }, setAttribute() {}, focus() {} };
    return el;
  }
  const buttons = ['start', 'restart', 'stop', 'stop'].map((action) =>
    ({ ...element(), dataset: { serviceAction: action } }));
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement: element,
    querySelector: () => null,
    querySelectorAll: (selector) => selector === '[data-service-action]' ? buttons : [],
    addEventListener() {},
  };
  const toasts = [];
  const context = vm.createContext({ document, OperatorGuide, ControlLabels, StatusView, fetch,
    confirm: () => true, setTimeout() {}, setInterval() {}, location: { href: 'http://127.0.0.1:8888/' },
    WebJoyConnection: { defaultUrl: () => '', suggest() {} }, qrSvg: () => ({}), wifiQrText: () => '',
    ...extra });
  context.toast = (message, type) => toasts.push([message, type]);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8'), context);
  return { context, document, buttons, toasts };
}
const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

test('stop stays available during a pending start and failures have persistent guidance', async () => {
  let finish;
  const calls = [];
  const f = fixture(async (url) => {
    calls.push(url);
    if (url === '/api/service/start') return new Promise((resolve) => { finish = resolve; });
    if (url === '/api/status') return response(200, { service: 'inactive', mode: 'practice', launch_config: {} });
    return response(200, { result: 'ok' });
  });
  const start = vm.runInContext('serviceAction("start")', f.context);
  assert.equal(f.buttons[0].disabled, true);
  assert.equal(f.buttons[2].disabled, false);
  assert.equal(f.buttons[3].disabled, false);
  await vm.runInContext('serviceAction("stop")', f.context);
  assert.ok(calls.includes('/api/service/stop'));
  finish(response(504, { detail: 'systemctl timed out' }));
  await start;
  assert.equal(f.document.getElementById('operation-issue').hidden, false);
  assert.match(f.document.getElementById('issue-next').textContent, /操作が続いている可能性/);
  assert.equal(f.buttons[0].disabled, false);
});

test('status disconnection is persistent and never presents the last active state as current', async () => {
  const f = fixture(async () => { throw Error('offline'); });
  await vm.runInContext('refreshStatus()', f.context);
  assert.equal(f.document.getElementById('connection-warning').hidden, false);
  assert.equal(f.document.getElementById('service-status-text').textContent, '状態未確認');
});

test('older services without readiness still show saved settings without a global error', async () => {
  const f = fixture(async (url) => {
    if (url === '/api/readiness') return response(404, { detail: 'Not Found' });
    if (url === '/api/launch-config') return response(200, { CONTROLLER_TYPE: 'uart' });
    if (url === '/api/control-config/uart') return response(200, { values: {} });
    throw Error(`unexpected URL: ${url}`);
  });
  await vm.runInContext('refreshReadiness()', f.context);
  assert.equal(f.document.getElementById('operation-issue').hidden, true);
  assert.equal(f.document.getElementById('ready-controller').textContent, 'UART / Switch');
  assert.match(f.document.getElementById('ready-profile').textContent, /読み込みました/);
  assert.match(f.document.getElementById('ready-workspace').textContent, /更新・再起動が必要/);
  assert.equal(f.document.getElementById('readiness-refresh').disabled, false);
});

test('the browser controller is named in readiness and selected in the admin controller choice', async () => {
  const f = fixture(async (url) => {
    if (url === '/api/readiness') {
      return response(200, { controller: 'web', profile: { ok: true, message: '読み込み・入力値の確認済み' },
        workspace: { ok: true, message: 'ok' } });
    }
    if (url === '/api/status') {
      return response(200, { service: 'inactive', mode: 'practice', launch_config: { CONTROLLER_TYPE: 'web' } });
    }
    throw Error(`unexpected URL: ${url}`);
  });
  await vm.runInContext('refreshReadiness()', f.context);
  assert.equal(f.document.getElementById('ready-controller').textContent, 'Web（ブラウザ・スマホ）');
  await vm.runInContext('refreshStatus()', f.context);
  assert.equal(f.document.getElementById('ready-controller').textContent, 'Web（ブラウザ・スマホ）');
  // The admin choice is a three-way select whose value is saved as CONTROLLER_TYPE.
  assert.equal(f.document.getElementById('controller-type').value, 'web');
  const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
  const options = (id) => {
    const select = html.slice(html.indexOf(`<select id="${id}"`));
    return [...select.slice(0, select.indexOf('</select>')).matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
  };
  assert.deepEqual(options('controller-type'), ['uart', 'dualshock', 'web']);
  // The browser controller's buttons are fixed by its page: the tuning tab does not edit it.
  assert.deepEqual(options('controls-profile'), ['uart', 'dualshock']);
  assert.doesNotMatch(html, /controller-type-toggle/);
});

test('older services validate a web launch profile through the web profile API', async () => {
  const calls = [];
  const f = fixture(async (url) => {
    calls.push(url);
    if (url === '/api/readiness') return response(404, { detail: 'Not Found' });
    if (url === '/api/launch-config') return response(200, { CONTROLLER_TYPE: 'web' });
    if (url === '/api/control-config/web') return response(200, { values: {} });
    throw Error(`unexpected URL: ${url}`);
  });
  await vm.runInContext('refreshReadiness()', f.context);
  assert.ok(calls.includes('/api/control-config/web'));
  assert.match(f.document.getElementById('ready-profile').textContent, /読み込みました/);
});

test('a start that did not start says so and never claims completion', async () => {
  const f = fixture(async (url) => {
    if (url === '/api/service/start') {
      return response(200, { ok: false, result: 'ok', state: 'inactive',
        message: '起動できませんでした：ロボットの起動スクリプトが練習モードの起動に対応していないか、応答がありません。' });
    }
    if (url === '/api/status') return response(200, { service: 'inactive', mode: 'practice', launch_config: {} });
    throw Error(`unexpected URL: ${url}`);
  });
  const toasts = [];
  f.context.toast = (message, type) => toasts.push([message, type]);
  await vm.runInContext('serviceAction("start")', f.context);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0][0], /^起動できませんでした/);
  assert.equal(toasts[0][1], 'error');
  assert.doesNotMatch(toasts[0][0], /完了/);
  assert.equal(f.document.getElementById('operation-issue').hidden, false);
  assert.equal(f.document.getElementById('issue-title').textContent, 'ロボット制御を起動できませんでした');
});

test('a practice start that worked says which configuration runs', async () => {
  const f = fixture(async (url) => {
    if (url === '/api/service/start') {
      return response(200, { ok: true, result: 'ok', state: 'active', message: '練習用の構成で起動しました' });
    }
    return response(200, { service: 'active', mode: 'practice', running_mode: 'practice', launch_config: {} });
  });
  const toasts = [];
  f.context.toast = (message, type) => toasts.push([message, type]);
  await vm.runInContext('serviceAction("start")', f.context);
  assert.deepEqual(toasts, [['練習用の構成で起動しました', 'success']]);
});

test('start is disabled while the robot runs, stop never is', async () => {
  const f = fixture(async () => response(200, {
    service: 'active', mode: 'practice', running_mode: 'practice', launch_config: {} }));
  await vm.runInContext('refreshStatus()', f.context);
  assert.equal(f.buttons[0].disabled, true);
  assert.equal(f.buttons[1].disabled, false);
  assert.equal(f.buttons[2].disabled, false);
  assert.equal(f.document.getElementById('header-mode').textContent, '動作中: 練習');
});

test('a practice launch that ends by itself is reported (it is not restarted)', async () => {
  let service = 'active';
  const f = fixture(async () => response(200, {
    service, mode: 'practice', running_mode: service === 'active' ? 'practice' : null, launch_config: {},
    stop_requested_at: null, server_time: 1000 }));
  await vm.runInContext('refreshStatus()', f.context);
  assert.equal(f.document.getElementById('operation-issue').hidden, true);
  service = 'inactive';
  await vm.runInContext('refreshStatus()', f.context);
  assert.equal(f.document.getElementById('operation-issue').hidden, false);
  assert.match(f.document.getElementById('issue-next').textContent, /自動で起動し直しません/);
});

test('a stop through the manager is not reported as a crash', async () => {
  let service = 'active';
  const f = fixture(async () => response(200, {
    service, mode: 'practice', running_mode: service === 'active' ? 'practice' : null, launch_config: {},
    stop_requested_at: service === 'active' ? null : 995, server_time: 1000 }));
  await vm.runInContext('refreshStatus()', f.context);
  service = 'inactive';
  await vm.runInContext('refreshStatus()', f.context);
  assert.equal(f.document.getElementById('operation-issue').hidden, true);
});

test('すべて止める needs no confirmation and shows what was stopped', async () => {
  const calls = [];
  const f = fixture(async (url, opts) => {
    calls.push([url, opts?.method]);
    if (url === '/api/stop-all') {
      return response(200, { ok: true,
        service: { ok: true, state: 'inactive', message: 'ロボット制御を止めました' },
        lab: { ok: true, message: '教材の走行・発射を止めました' } });
    }
    if (url === '/api/status') return response(200, { service: 'inactive', mode: 'practice', launch_config: {} });
    if (url === '/api/lab/status') return response(500, { detail: 'x' });
    throw Error(`unexpected URL: ${url}`);
  }, { confirm: () => { throw Error('no confirmation for stopping'); } });
  await vm.runInContext('stopAll()', f.context);
  assert.deepEqual(calls[0], ['/api/stop-all', 'POST']);
  assert.equal(f.document.getElementById('stop-all-result').hidden, false);
  assert.equal(f.document.getElementById('stop-all-title').textContent, 'すべて止めました');
  assert.deepEqual(f.document.getElementById('stop-all-parts').children.map((c) => c.textContent),
    ['ロボット制御を止めました', '教材の走行・発射を止めました']);
  assert.equal(f.document.getElementById('stop-all').textContent, 'すべて止める');
  const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  assert.match(header, /id="stop-all"/); // always visible, in the sticky header
});

test('after a mode switch to a running robot, a restart is offered', async () => {
  let mode = 'practice';
  const f = fixture(async (url) => {
    if (url === '/api/mode') {
      mode = 'competition';
      return response(200, { mode, lab: null, restart_needed: true, running_mode: 'practice', service: 'active' });
    }
    if (url === '/api/lab/status') return response(500, { detail: 'x' });
    return response(200, { service: 'active', mode, running_mode: 'practice', launch_config: {} });
  });
  await vm.runInContext('refreshStatus()', f.context);
  // What the mode switch handler does with the answer.
  await vm.runInContext(`(async () => {
    const answer = await api('/api/mode', { method: 'POST', body: '{}' });
    await refreshStatus();
    if (answer.restart_needed) offerApply('大会モード');
  })()`, f.context);
  assert.equal(f.document.getElementById('apply-offer').hidden, false);
  assert.match(f.document.getElementById('apply-offer-text').textContent, /再起動するまで前の設定のまま/);
});
