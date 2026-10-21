const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
// Follow the page's dependency order, including future Manager scripts before app.js.
const scripts = [];
for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)) {
  const src = match[1].split(/[?#]/)[0];
  if (!src.startsWith('/static/')) continue;
  const file = src.slice('/static/'.length);
  scripts.push({ file, source: fs.readFileSync(path.join(__dirname, '../static', file), 'utf8') });
  if (file === 'app.js') break;
}
assert.equal(scripts.at(-1)?.file, 'app.js', 'index.html must load the Manager app');

function fixture() {
  const elements = new Map();
  const inputs = [];
  const element = () => ({ textContent: '', hidden: false, value: '', dataset: {},
    events: {}, children: [],
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    setAttribute() {}, removeAttribute() {},
    addEventListener(name, fn) { this.events[name] = fn; } });
  for (const key of ['MIN_FREE_GB', 'MAX_SPLIT_MB', 'MAX_DURATION_SEC']) {
    const tag = html.match(new RegExp(`<input[^>]*data-rec-config="${key}"[^>]*>`))[0];
    const attrs = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    const input = { value: attrs.value, min: attrs.min, max: attrs.max, type: 'number',
      dataset: { recConfig: key, unit: attrs['data-unit'], zeroMeaning: attrs['data-zero-meaning'] },
      checked: 0, reported: 0, message: '',
      setCustomValidity(message) { this.message = message; },
      checkValidity() { this.checked++; return this.value !== '' && Number(this.value) >= +this.min &&
        Number(this.value) <= +this.max && Number.isInteger(Number(this.value)); },
      reportValidity() { this.reported++; } };
    inputs.push(input);
    elements.set(attrs.id, input);
  }
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const document = { getElementById: get, createElement: element, addEventListener() {},
    querySelectorAll(selector) { return selector === '[data-rec-config][type="number"]' ||
      selector === '[data-rec-config]' ? inputs : []; } };
  const calls = [];
  const context = vm.createContext({ document, URL, location: { href: 'http://127.0.0.1:8888/' },
    fetch: async (url) => { calls.push(url); return { ok: false, status: 422,
      json: async () => ({ detail: 'サーバーの拒否理由：1〜16 GB。0は使用できません。' }) }; } });
  for (const { file, source } of scripts) vm.runInContext(source, context, { filename: file });
  const run = (code) => vm.runInContext(code, context);
  run('setupRecorderEvents()');
  return { inputs, get, calls, run, context };
}

test('numeric fields declare complete bounds, required, units and zero meanings', () => {
  const f = fixture();
  for (const input of f.inputs) {
    const tag = html.match(new RegExp(`<input[^>]*data-rec-config="${input.dataset.recConfig}"[^>]*>`))[0];
    assert.match(tag, /step="1"/);
    assert.match(tag, /\brequired\b/);
    assert.match(tag, /aria-describedby=/);
    assert.match(input.dataset.zeroMeaning, /0/);
  }
  assert.match(html, /1 GB＝1024³ バイト/);
  assert.match(html, /1 MB＝1000² バイト/);
  assert.match(html, /ファイルを時間で分ける間隔/);
  assert.doesNotMatch(html, /記録する時間（秒 \/ 0=無制限）/);
});

test('invalid numeric input is reported and never sends a PUT', async () => {
  for (const index of [0, 1, 2]) {
    for (const raw of ['', '²', '５', '-1', '1.5', '1e1', '+1', ' 1', '999999999999999']) {
      const f = fixture();
      f.inputs[index].value = raw;
      await f.get('rec-save-config').events.click();
      assert.deepEqual(f.calls, []);
      assert.equal(f.inputs[index].reported, 1);
      assert.ok(f.inputs[index].checked >= 1);
      assert.match(f.inputs[index].message, /半角の数字/);
      assert.match(f.inputs[index].message, /0/);
    }
  }
});

test('boundaries and repaired values pass validation without stale custom errors', () => {
  const f = fixture();
  for (const input of f.inputs) {
    input.value = '²';
    assert.equal(f.run('validateRecNumericInputs()'), false);
    for (const good of [input.min, input.max, '000' + input.min]) {
      input.value = good;
      assert.equal(f.run('validateRecNumericInputs()'), true);
      assert.equal(input.message, '');
    }
  }
});

test('server rejection is displayed verbatim after successful client validation', async () => {
  const f = fixture();
  const reasons = [];
  f.context.showIssue = (_path, _status, detail) => reasons.push(detail);
  f.context.toast = () => {};
  await f.get('rec-save-config').events.click();
  assert.deepEqual(f.calls, ['/api/rosbag/config']);
  assert.deepEqual(reasons, ['サーバーの拒否理由：1〜16 GB。0は使用できません。']);
});

test('warnings are persistent text in both panels and clear after repair', () => {
  const f = fixture();
  f.run('renderRecConfigWarnings({config_warnings: ["<img src=x>既定の5 GB"]})');
  for (const id of ['rec-config-warnings', 'rec-status-warnings']) {
    assert.equal(f.get(id).textContent, '<img src=x>既定の5 GB');
    assert.equal(f.get(id).hidden, false);
  }
  f.run('renderRecConfigWarnings({config_warnings: []})');
  assert.equal(f.get('rec-config-warnings').hidden, true);
  assert.equal(f.get('rec-status-warnings').textContent, '');
});
