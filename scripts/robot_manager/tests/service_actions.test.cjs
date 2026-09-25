const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const OperatorGuide = require('../static/operator-guide.js');

function fixture(fetch) {
  const elements = new Map();
  function element() {
    return { textContent: '', hidden: true, disabled: false, dataset: {},
      classList: { toggle() {} }, appendChild() {}, setAttribute() {} };
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
  const context = vm.createContext({ document, OperatorGuide, fetch, confirm: () => true,
    setTimeout() {}, setInterval() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8'), context);
  return { context, document, buttons };
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
