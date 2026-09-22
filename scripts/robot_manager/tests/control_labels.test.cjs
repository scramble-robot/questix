const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const labels = require('../static/control-labels.js');

test('UART protocol names and DualShock shoulder names remain distinct', () => {
  for (const [index, uart, dualshock] of [[4, 'L', 'L1'], [5, 'R', 'R1'],
    [6, 'ZL', 'L2'], [7, 'ZR', 'R2']]) {
    assert.equal(labels.valueLabel('uart', 'fire_button', index), `${uart}（ボタン ${index}）`);
    assert.equal(labels.valueLabel('dualshock', 'fire_button', index), `${dualshock}（ボタン ${index}）`);
  }
  const source = fs.readFileSync(path.join(__dirname,
    '../../../uart_joy_driver/src/joy_line_parser.cpp'), 'utf8');
  for (const [index, name] of ['A', 'B', 'X', 'Y', 'L', 'R', 'ZL', 'ZR'].entries()) {
    assert.match(source, new RegExp(`buttons\\[${index}\\].*// ${name}\\n`));
    assert.equal(labels.valueLabel('uart', 'fire_button', index), `${name}（ボタン ${index}）`);
  }
});

test('axis sentinels and nonstandard indices remain selectable without renumbering', () => {
  const options = labels.options('uart', { key: 'tilt_axis', min: -1, max: 63 });
  assert.equal(options[0].label, 'ボタンで操作（-1）');
  assert.equal(options[8].label, '十字キー 上下（軸 7）');
  assert.equal(options[64].value, 63);
  assert.match(options[64].label, /名前未登録/);
  assert.equal(labels.valueLabel('uart', 'linear_y_axis', -1), '使用しない（-1）');
  assert.equal(labels.kind('max_motor_rpm'), null);
});

// Minimal DOM fixture exercises the actual form code without a browser or dependencies.
class Element {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.events = {};
    this.className = '';
    this.classList = { toggle: (name, on) => { this[name] = on; } };
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  addEventListener(name, handler) { this.events[name] = handler; }
  all() { return this.children.flatMap((child) => [child, ...child.all()]); }
  querySelector(selector) { return this.all().find((child) => child.className === selector.slice(1)); }
}

function editorFixture() {
  const elements = new Map();
  const document = {
    events: {},
    getElementById(id) {
      const found = elements.get('controls-fields')?.all().find((element) => element.id === id);
      if (found) return found;
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement: (tag) => new Element(tag),
    addEventListener(name, handler) { this.events[name] = handler; },
    querySelector: () => document.getElementById('tuning-tab'),
    querySelectorAll(selector) {
      const all = document.getElementById('controls-fields').all();
      return selector === '.control-field' ? all.filter((element) => element.className === 'control-field')
        : all.filter((element) => element.tag === 'input' || element.tag === 'select');
    },
  };
  const profile = {
    controller: 'uart', revision: 'initial',
    values: { shot_component: { fire_button: 5, tilt_axis: 7 } },
    defaults: { shot_component: { fire_button: 4, tilt_axis: 7 } },
    groups: [{ node: 'shot_component', label: '射出', fields: [
      { key: 'fire_button', label: '射出ボタン番号', type: 'int', min: 0, max: 63 },
      { key: 'tilt_axis', label: 'チルト軸番号', type: 'int', min: -1, max: 63 },
    ] }],
  };
  let savedPayload;
  const context = vm.createContext({ document, ControlLabels: labels, structuredClone,
    window: { addEventListener() {} }, confirm: () => true, toast() {},
    api: async (url, options) => {
      if (!options) return structuredClone(profile);
      savedPayload = JSON.parse(options.body);
      return { ...structuredClone(profile), values: savedPayload.values, revision: 'saved' };
    },
  });
  document.getElementById('controls-profile').value = 'uart';
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/controls.js'), 'utf8'), context);
  document.events.DOMContentLoaded();
  return { document, context, getPayload: () => savedPayload };
}

test('editing keeps saved names stable, highlights changes and submits numeric indices', async () => {
  const { document, context, getPayload } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  const saved = document.getElementById('control-shot_component-fire_button-saved');
  const input = document.getElementById('control-shot_component-fire_button');
  assert.equal(saved.children[1].textContent, 'R（ボタン 5）');
  assert.equal(input.tag, 'select');
  input.value = '7';
  input.events.input();
  assert.equal(saved.children[1].textContent, 'R（ボタン 5）');
  assert.equal(document.getElementById('controls-change-count').textContent, '未保存の変更: 1 項目');
  input.value = '5';
  input.events.input();
  assert.equal(document.getElementById('controls-change-count').textContent, '未保存の変更: 0 項目');
  input.value = '7';
  input.events.input();
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.equal(getPayload().values.shot_component.fire_button, 7);
  assert.equal(document.getElementById('control-shot_component-fire_button-saved')
    .children[1].textContent, 'ZR（ボタン 7）');
  assert.equal(document.getElementById('controls-change-count').textContent, '未保存の変更: 0 項目');
});

test('reset modifies only the draft, preserving the saved value for comparison', async () => {
  const { document, context } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  document.getElementById('controls-reset').events.click();
  assert.equal(document.getElementById('control-shot_component-fire_button').value, 4);
  assert.equal(document.getElementById('control-shot_component-fire_button-saved')
    .children[1].textContent, 'R（ボタン 5）');
  assert.equal(document.getElementById('controls-change-count').textContent, '未保存の変更: 1 項目');
});

test('runtime values are independent snapshots and unavailable nodes never use saved defaults', async () => {
  const { document, context } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  vm.runInContext(`controlRuntime = { nodes: {
    shot_component: { status: "ok", values: { fire_button: 2 } }
  } }; renderRuntimeValues();`, context);
  let rows = document.querySelectorAll('.control-field');
  assert.equal(rows[0].querySelector('.control-runtime-value').textContent, '2');
  assert.equal(rows[0].querySelector('.control-runtime-state').textContent, '保存済みと異なる');
  assert.equal(rows[1].querySelector('.control-runtime-value').textContent, 'パラメータ未宣言');
  vm.runInContext(`controlRuntime.nodes.shot_component = { status: "unavailable", values: {} };
    renderRuntimeValues();`, context);
  rows = document.querySelectorAll('.control-field');
  assert.equal(rows[0].querySelector('.control-runtime-value').textContent, 'ノード未検出');
  assert.equal(document.getElementById('control-shot_component-fire_button-saved')
    .children[1].textContent, 'R（ボタン 5）');
});

test('an older backend disables runtime reads without breaking saved-profile editing', async () => {
  const { document, context } = editorFixture();
  context.apiSilent = async (url) => url === '/api/launch-config'
    ? { CONTROLLER_TYPE: 'uart' } : { paths: {} };
  await document.getElementById('tuning-tab').events.click();
  assert.equal(document.getElementById('controls-runtime-load').disabled, true);
  assert.equal(document.getElementById('controls-save').disabled, false);
  assert.match(document.getElementById('controls-runtime-message').textContent, /再起動/);
  context.apiSilent = async (url) => url === '/api/launch-config'
    ? { CONTROLLER_TYPE: 'uart' } : { paths: { '/api/control-runtime': { get: {} } } };
  await document.getElementById('tuning-tab').events.click();
  assert.equal(document.getElementById('controls-runtime-load').disabled, false);
  assert.equal(document.getElementById('controls-runtime-message').textContent, '実行中の値は未取得です。');
});
