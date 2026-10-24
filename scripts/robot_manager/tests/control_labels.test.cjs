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
  assert.equal(Number(options[64].value), 63);
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
    this.attributes = {};
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.className = '';
    this.classList = { toggle: (name, on) => { this[name] = on; },
      add: (name) => { this[name] = true; } };
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus(options) { this.focused = true; this.focusOptions = options; }
  scrollIntoView() { throw new Error('Controller editing must not scroll the page'); }
  showModal() { this.open = true; }
  close() { this.open = false; this.events.close?.(); }
  getBoundingClientRect() { return { left: 100, right: 500, top: 100, bottom: 500 }; }
  checkValidity() { return this.valid !== false; }
  setCustomValidity(message) { this.validationMessage = message; this.valid = !message; }
  addEventListener(name, handler) { this.events[name] = handler; }
  all() { return this.children.flatMap((child) => [child, ...child.all()]); }
  querySelector(selector) {
    return this.all().find((child) => selector === 'input:invalid' ? child.tag === 'input' && child.valid === false
      : (child.className || child.attributes.class || '').split(' ').includes(selector.slice(1)));
  }
}

function editorFixture(extraValues = {}, controller = 'uart') {
  const elements = new Map();
  const document = {
    events: {},
    getElementById(id) {
      const found = ['controls-fields', 'controls-range-warning'].flatMap((host) => elements.get(host)?.all() || []).find((element) => element.id === id);
      if (found) return found;
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement: (tag) => new Element(tag),
    createElementNS: (namespace, tag) => new Element(tag),
    addEventListener(name, handler) { this.events[name] = handler; },
    querySelector(selector) {
      const match = selector?.match(/^\[([^=]+)="([^"]+)"\]$/);
      if (match && match[1] !== 'data-tab') {
        return document.getElementById('controller-map').all()
          .find((element) => element.attributes[match[1]] === match[2]);
      }
      return document.getElementById('tuning-tab');
    },
    querySelectorAll(selector) {
      const all = document.getElementById('controls-fields').all();
      return selector === '.control-field' ? all.filter((element) => element.className === 'control-field')
        : all.filter((element) => element.tag === 'input' || element.tag === 'select' || element.tag === 'button');
    },
  };
  const profile = {
    controller, revision: 'initial',
    geometry: { wheel_radius: 0.05, wheel_separation: 0.5 },
    values: { joy_launcher: { fire_button: 5 } },
    defaults: { joy_launcher: { fire_button: 4 } },
    groups: [{ node: 'joy_launcher', label: '射出', fields: [
      { key: 'fire_button', label: '射出ボタン番号', type: 'int', min: 0, max: 63 },
    ] }],
  };
  extraValues = { ...extraValues,
    joy_controller: { longitudinal_input_ratio: 2, angular_input_ratio: 6, ...extraValues.joy_controller },
    drive_component: { max_motor_rpm: 475, max_linear_accel: 3, max_angular_accel: 3, ...extraValues.drive_component },
    uart_joy_driver: { deadzone: 0.05, ...extraValues.uart_joy_driver },
    joy_node: { deadzone: 0.1, ...extraValues.joy_node },
    joy_launcher: { tilt_up_axis: 7, tilt_down_axis: 7,
    tilt_up_axis_sign: 1, tilt_down_axis_sign: -1, tilt_up_button_index: 4,
    tilt_down_button_index: 6, full_speed_value: 1, ...extraValues.joy_launcher } };
  for (const [node, values] of Object.entries(extraValues)) {
    profile.values[node] = { ...profile.values[node], ...values };
    profile.defaults[node] = { ...profile.defaults[node], ...values };
    let group = profile.groups.find((item) => item.node === node);
    if (!group) { group = { node, label: node, fields: [] }; profile.groups.push(group); }
    for (const key of Object.keys(values)) {
      if (!group.fields.some((field) => field.key === key)) {
        const speedMax = node === 'joy_controller' && key.includes('input_ratio') ? (key === 'angular_input_ratio' ? 6 : 2) : null;
        group.fields.push({ key, label: key, type: 'float', min: speedMax === null ? 0 : -speedMax, max: speedMax ?? (key === 'deadzone' ? 0.99 : key === 'full_speed_value' ? 1 : key === 'max_linear_accel' ? 50 : key === 'max_angular_accel' ? 100 : 475) });
      }
    }
  }
  // The manager's own order (controls.GROUPS): driving first, then the launcher's buttons.
  const order = ['joy_controller', 'drive_component', 'joy_launcher'];
  const rank = (node) => (order.includes(node) ? order.indexOf(node) : order.length);
  profile.groups.sort((a, b) => rank(a.node) - rank(b.node));
  let savedPayload;
  const context = vm.createContext({ document, ControlLabels: labels, structuredClone,
    window: { innerWidth: 1280, innerHeight: 800, addEventListener() {} }, confirm: () => true, toast() {},
    api: async (url, options) => {
      if (!options) return structuredClone(profile);
      savedPayload = JSON.parse(options.body);
      return { ...structuredClone(profile), values: savedPayload.values, revision: 'saved' };
    },
  });
  document.getElementById('controls-profile').value = controller;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/controller-map.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/operator-guide.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/tuning-model.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/tuning-chart.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/controls.js'), 'utf8'), context);
  document.events.DOMContentLoaded();
  return { document, context, getPayload: () => savedPayload };
}

test('speed editing keeps saved values stable and persists numeric values', async () => {
  const { document, context, getPayload } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  const id = 'control-joy_controller-longitudinal_input_ratio';
  const saved = document.getElementById(`${id}-saved`);
  const input = document.getElementById(id);
  assert.equal(saved.children[1].textContent, '2 m/s');
  assert.equal(input.type, 'number');
  assert.equal(saved.hidden, true);
  input.value = '1.5'; input.events.input();
  assert.equal(saved.hidden, false);
  assert.equal(document.getElementById('control-joy_controller-angular_input_ratio-saved').hidden, true);
  assert.equal(saved.children[1].textContent, '2 m/s');
  assert.equal(document.getElementById('controls-change-count').textContent, '未保存の変更: 2 項目');
  input.value = '2'; input.events.input();
  assert.equal(saved.hidden, true);
  assert.equal(document.getElementById('controls-change-count').textContent, '未保存の変更: 0 項目');
  input.value = '1.5'; input.events.input();
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.equal(getPayload().values.joy_controller.longitudinal_input_ratio, 1.5);
  assert.equal(document.getElementById(`${id}-saved`).children[1].textContent, '1.5 m/s');
  assert.equal(document.getElementById(`${id}-saved`).hidden, true);
});

test('reset changes only the visible tuning values, retaining mappings and hidden settings', async () => {
  const { document, context, getPayload } = editorFixture({
    drive_component: { max_motor_rpm: 321, max_linear_accel: 2.5, min_command_rpm: 8 },
    joy_controller: { lateral_input_ratio: -0.6 },
    joy_axis_drive: { max_motor_rpm: 82 },
  });
  await vm.runInContext('loadControls("uart")', context);
  vm.runInContext('controlDraft.joy_launcher.fire_button = 0; controlDraft.joy_node.deadzone = 0.2', context);
  const input = document.getElementById('control-joy_controller-longitudinal_input_ratio');
  input.value = '1'; input.events.input();
  document.getElementById('controls-reset').events.click();
  assert.equal(vm.runInContext('controlDraft.joy_controller.longitudinal_input_ratio', context), 2);
  assert.equal(vm.runInContext('controlDraft.joy_launcher.fire_button', context), 0);
  assert.equal(vm.runInContext('controlDraft.joy_node.deadzone', context), 0.2);
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.deepEqual(getPayload().values.drive_component,
    { max_motor_rpm: 321, max_linear_accel: 2.5, max_angular_accel: 3, min_command_rpm: 8 });
  assert.equal(getPayload().values.joy_controller.lateral_input_ratio, -0.6);
  assert.equal(getPayload().values.joy_axis_drive.max_motor_rpm, 82);
});

test('runtime comparisons show the same units and never substitute saved defaults', async () => {
  const { document, context } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  let rows = document.querySelectorAll('.control-field');
  assert.ok(rows.every((row) => row.querySelector('.control-runtime').hidden));
  vm.runInContext(`controlRuntime = { nodes: {
    joy_controller: { status: "ok", values: { longitudinal_input_ratio: -1.5 } }
  } }; renderRuntimeValues();`, context);
  assert.equal(rows[0].querySelector('.control-runtime-value').textContent, '1.5 m/s（方向反転）');
  assert.equal(rows[0].querySelector('.control-runtime-state').textContent, '保存済みと異なる');
  const angularRow = rows.find(row => row.dataset.node === 'joy_controller' && row.dataset.key === 'angular_input_ratio');
  assert.equal(angularRow.querySelector('.control-runtime-value').textContent, 'この項目は確認できません');
  vm.runInContext(`controlRuntime.nodes.joy_controller = { status: "unavailable", values: {} };
    renderRuntimeValues();`, context);
  assert.equal(rows[0].querySelector('.control-runtime-value').textContent, '対象のプログラムが見つかりません');
  assert.equal(document.getElementById('control-joy_controller-longitudinal_input_ratio-saved')
    .children[1].textContent, '2 m/s');
});

test('an older backend disables runtime reads without breaking saved-profile editing', async () => {
  const { document, context } = editorFixture();
  context.apiSilent = async (url) => url === '/api/launch-config'
    ? { CONTROLLER_TYPE: 'uart' } : { paths: {} };
  await document.getElementById('tuning-tab').events.click();
  assert.equal(document.getElementById('controls-runtime-load').disabled, true);
  assert.equal(document.getElementById('controls-save').disabled, true);
  assert.match(document.getElementById('controls-runtime-message').textContent, /再起動/);
  context.apiSilent = async (url) => url === '/api/launch-config'
    ? { CONTROLLER_TYPE: 'uart' } : { paths: { '/api/control-runtime': { get: {} } } };
  await document.getElementById('tuning-tab').events.click();
  assert.equal(document.getElementById('controls-runtime-load').disabled, false);
  assert.equal(document.getElementById('controls-runtime-message').textContent, 'ロボットが使っている設定は、まだ確認していません。');
});


test('controller drawing follows edits and can show the saved mapping without losing the draft', async () => {
  const { document, context } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  const host = document.getElementById('controller-map');
  assert.equal(host.children[0].tag, 'svg');
  vm.runInContext('controlDraft.joy_launcher.fire_button = 7; refreshControlChanges()', context);
  let list = host.children[1];
  assert.equal(list.children[0].children[1].children[1].textContent, 'ZR（ボタン 7） · 変更あり');
  list.children[0].events.click();
  assert.equal(document.getElementById('controller-map-editor').open, true);
  assert.equal(document.getElementById('map-action').value, 'joy_launcher.fire_button');
  assert.equal(document.getElementById('map-input').value, 'button:7');
  const source = document.getElementById('controller-map-source');
  source.value = 'saved';
  source.events.change();
  list = host.children[1];
  assert.equal(list.children[0].children[1].children[1].textContent, 'R（ボタン 5）');
  assert.equal(vm.runInContext('controlDraft.joy_launcher.fire_button', context), 7);
  source.value = 'draft';
  source.events.change();
  assert.equal(host.children[1].children[0].children[1].children[1].textContent,
    'ZR（ボタン 7） · 変更あり');
});

function chooseSpot(document, spot, keyboard = false) {
  const group = document.getElementById('controller-map').children[0].all()
    .find((item) => item.attributes['data-spot'] === spot);
  assert.equal(group.attributes.role, 'button');
  if (keyboard) group.events.keydown({ key: 'Enter', preventDefault() {} });
  else group.events.click();
}

function selectMap(document, id, value) {
  const input = document.getElementById(id);
  input.value = value;
  input.events.change();
}

test('an unassigned diagram button edits the draft and saves through the existing API', async () => {
  const { document, context, getPayload } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  chooseSpot(document, 'face-right', true);
  assert.equal(document.getElementById('map-input').value, 'button:0');
  assert.match(document.getElementById('map-current').textContent, /なし/);
  assert.equal(document.getElementById('map-apply').disabled, false);
  document.getElementById('map-apply').events.click();
  assert.equal(getPayload(), undefined);
  assert.equal(vm.runInContext('controlDraft.joy_launcher.fire_button', context), 0);
  assert.equal(vm.runInContext('controlProfile.values.joy_launcher.fire_button', context), 5);
  assert.equal(document.getElementById('controls-change-count').textContent, '未保存の変更: 1 項目');
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.equal(getPayload().values.joy_launcher.fire_button, 0);
  assert.equal(document.getElementById('controls-change-count').textContent, '未保存の変更: 0 項目');
});

test('diagram edits are blocked in saved view and while saving, and survive a speed-only reset', async () => {
  const { document, context } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  chooseSpot(document, 'face-right');
  selectMap(document, 'controller-map-source', 'saved');
  assert.equal(document.getElementById('map-apply').disabled, true);
  document.getElementById('map-apply').events.click();
  assert.equal(vm.runInContext('controlDraft.joy_launcher.fire_button', context), 5);
  document.getElementById('map-edit-draft').events.click();
  await vm.runInContext('controlsSetBusy(true)', context);
  assert.equal(document.getElementById('map-apply').disabled, true);
  document.getElementById('map-apply').events.click();
  assert.equal(vm.runInContext('controlDraft.joy_launcher.fire_button', context), 5);
  await vm.runInContext('controlsSetBusy(false)', context);
  document.getElementById('map-apply').events.click();
  assert.equal(vm.runInContext('controlDraft.joy_launcher.fire_button', context), 0);
  document.getElementById('controls-reset').events.click();
  assert.equal(vm.runInContext('controlDraft.joy_launcher.fire_button', context), 0);
  assert.match(document.getElementById('map-preview').textContent, /A（ボタン 0）/);
});

test('diagram distinguishes stick axes from pressing and previews overlapping functions', async () => {
  const { document, context } = editorFixture({
    joy_controller: { linear_x_axis: 1, linear_y_axis: 0, angular_z_axis: 3 },
    joy_launcher: { tilt_down_axis: -1, tilt_up_button_index: 4, tilt_down_button_index: 6,
      full_speed_button: 7 },
  });
  await vm.runInContext('loadControls("uart")', context);
  chooseSpot(document, 'left-stick');
  selectMap(document, 'map-input', 'axis:1');
  selectMap(document, 'map-action', 'joy_controller.angular_z_axis');
  assert.match(document.getElementById('map-preview').textContent, /前進・後退.*同時に動作/);
  document.getElementById('map-apply').events.click();
  assert.equal(vm.runInContext('controlDraft.joy_controller.angular_z_axis', context), 1);
  assert.equal(vm.runInContext('controlDraft.joy_controller.linear_x_axis', context), 1);
  selectMap(document, 'map-input', 'button:12');
  assert.ok(document.getElementById('map-action').children.every((item) => !item.value.startsWith('joy_controller.')));
  selectMap(document, 'map-action', 'joy_launcher.tilt_up_button_index');
  document.getElementById('map-apply').events.click();
  assert.equal(vm.runInContext('controlDraft.joy_launcher.tilt_up_axis', context), -1);
  assert.equal(vm.runInContext('controlDraft.joy_launcher.tilt_up_button_index', context), 12);
  chooseSpot(document, 'left-trigger');
  selectMap(document, 'map-action', 'joy_launcher.tilt_up_button_index');
  assert.equal(document.getElementById('map-apply').disabled, true);
  assert.match(document.getElementById('map-preview').textContent, /異なる入力/);
  document.getElementById('map-apply').events.click();
  assert.equal(vm.runInContext('controlDraft.joy_launcher.tilt_up_button_index', context), 12);
  chooseSpot(document, 'dpad');
  selectMap(document, 'map-input', 'direction:7:1');
  selectMap(document, 'map-action', 'joy_launcher.tilt_up_button_index');
  document.getElementById('map-apply').events.click();
  assert.equal(vm.runInContext('controlDraft.joy_launcher.tilt_up_axis', context), 7);
});

test('numbered function opens a popup and moves its binding without scrolling or renumbering', async () => {
  const { document, context } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  let card = document.querySelector('[data-action="joy_launcher.fire_button"]');
  assert.equal(card.children[0].textContent, 3);
  card.events.click();
  const dialog = document.getElementById('controller-map-editor');
  assert.equal(dialog.open, true);
  assert.equal(document.getElementById('map-input').focusOptions.preventScroll, true);
  assert.equal(document.getElementById('map-action').disabled, true);
  selectMap(document, 'map-input', 'button:0');
  assert.equal(vm.runInContext('controlDraft.joy_launcher.fire_button', context), 5);
  document.getElementById('map-apply').events.click();
  assert.equal(dialog.open, true);
  card = document.querySelector('[data-action="joy_launcher.fire_button"]');
  assert.equal(card.children[0].textContent, 3);
  assert.match(card.children[1].children[1].textContent, /A（ボタン 0）/);
  assert.equal(document.getElementById('controls-save').disabled, false);
  assert.equal(document.getElementById('controls-change-count').textContent, '未保存の変更: 1 項目');
  document.getElementById('map-close').events.click();
  assert.equal(dialog.open, false);
  const callout = document.querySelector('[data-map-function="joy_launcher.fire_button"]');
  assert.equal(callout.focusOptions.preventScroll, true);
});

test('closing or dismissing the popup discards unconfirmed choices and restores focus without scrolling', async () => {
  const { document, context } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  chooseSpot(document, 'face-right');
  const dialog = document.getElementById('controller-map-editor');
  dialog.events.click({ target: dialog, clientX: 200, clientY: 200 });
  assert.equal(dialog.open, true);
  dialog.events.click({ target: dialog, clientX: 20, clientY: 20 });
  assert.equal(dialog.open, false);
  assert.equal(vm.runInContext('controlDraft.joy_launcher.fire_button', context), 5);
  assert.equal(document.querySelector('[data-spot="face-right"]').focusOptions.preventScroll, true);
  chooseSpot(document, 'face-right', true);
  // Native dialog Escape invokes close; check the same cleanup path.
  dialog.close();
  assert.equal(vm.runInContext('mapSelection', context), null);
  assert.equal(document.getElementById('controls-save').disabled, true);
});

test('function popup moves a custom index to a standard input and closes on profile reload', async () => {
  const { document, context } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  vm.runInContext('controlDraft.joy_launcher.fire_button = 63; refreshControlChanges()', context);
  document.querySelector('[data-action="joy_launcher.fire_button"]').events.click();
  assert.match(document.getElementById('map-preview').textContent, /63/);
  selectMap(document, 'map-input', 'button:7');
  document.getElementById('map-apply').events.click();
  assert.equal(vm.runInContext('controlDraft.joy_launcher.fire_button', context), 7);
  await vm.runInContext('loadControls("uart")', context);
  assert.equal(document.getElementById('controller-map-editor').open, false);
});

test('each number on a shared stick opens its own function and restores focus after moving', async () => {
  const { document, context } = editorFixture({
    joy_controller: { linear_x_axis: 1, linear_y_axis: 0, angular_z_axis: 3 },
  });
  await vm.runInContext('loadControls("uart")', context);
  const selector = '[data-map-function="joy_controller.linear_x_axis"]';
  const badge = document.querySelector(selector);
  assert.equal(badge.attributes.role, 'button');
  assert.equal(badge.children[1].textContent, '1');
  badge.events.keydown({ key: ' ', preventDefault() {} });
  assert.equal(document.getElementById('map-action').value, 'joy_controller.linear_x_axis');
  assert.equal(document.getElementById('map-input').value, 'axis:1');
  selectMap(document, 'map-input', 'axis:4');
  document.getElementById('map-apply').events.click();
  document.getElementById('map-close').events.click();
  assert.equal(vm.runInContext('controlDraft.joy_controller.linear_x_axis', context), 4);
  assert.equal(vm.runInContext('controlDraft.joy_controller.linear_y_axis', context), 0);
  assert.equal(document.querySelector(selector).focusOptions.preventScroll, true);
  document.querySelector('[data-map-function="joy_controller.linear_y_axis"]').events.click();
  assert.equal(document.getElementById('map-action').value, 'joy_controller.linear_y_axis');
});

test('shared save reports success and validation failures without sending invalid values', async () => {
  const { document, context, getPayload } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  chooseSpot(document, 'face-right');
  document.getElementById('map-apply').events.click();
  document.getElementById('map-close').events.click();
  const form = document.getElementById('controls-form');
  const input = document.getElementById('control-joy_controller-longitudinal_input_ratio');
  form.valid = false;
  input.valid = false;
  input.validationMessage = '範囲外です。';
  await document.getElementById('controls-save').events.click({ preventDefault() {} });
  assert.equal(getPayload(), undefined);
  assert.match(document.getElementById('controls-message').textContent, /走行速度.*範囲外/);
  assert.equal(document.getElementById('controls-save').disabled, false);
  form.valid = true;
  input.valid = true;
  const toasts = [];
  context.toast = (message) => toasts.push(message);
  await document.getElementById('controls-save').events.click({ preventDefault() {} });
  assert.equal(getPayload().values.joy_launcher.fire_button, 0);
  assert.match(toasts.join(), /操作設定を保存しました/);
  assert.equal(document.getElementById('controls-save').disabled, true);
  // Nothing left to save: the floating bar goes away instead of covering the diagram.
  assert.equal(document.getElementById('controls-savebar').hidden, true);
});

test('a failed save keeps the draft and revision and reports the error in the shared bar', async () => {
  const { document, context } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  chooseSpot(document, 'face-right');
  document.getElementById('map-apply').events.click();
  document.getElementById('map-close').events.click();
  for (const message of ['他の画面で変更されました。再読み込みしてください。', '通信に失敗しました。']) {
    context.api = async () => { throw new Error(message); };
    await document.getElementById('controls-save').events.click({ preventDefault() {} });
    assert.equal(document.getElementById('controls-message').textContent, message);
    assert.equal(vm.runInContext('controlDraft.joy_launcher.fire_button', context), 0);
    assert.equal(vm.runInContext('controlProfile.values.joy_launcher.fire_button', context), 5);
    assert.equal(vm.runInContext('controlProfile.revision', context), 'initial');
    assert.equal(document.getElementById('controls-save').disabled, false);
    assert.equal(document.getElementById('controls-change-count').textContent, '未保存の変更: 1 項目');
  }
});

test('desktop drawing names each function while mobile keeps the compact diagram and named list', async () => {
  const { document, context } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  let badge = document.querySelector('[data-map-function="joy_launcher.fire_button"]');
  assert.ok(badge.children.some((item) => item.tag === 'text' && item.textContent === '射出'));
  assert.ok(badge.querySelector('.map-callout-hit'));
  context.window.innerWidth = 390;
  vm.runInContext('renderControllerMap()', context);
  const host = document.getElementById('controller-map');
  assert.equal(host.children[0].attributes.viewBox, '130 10 460 350');
  badge = document.querySelector('[data-map-function="joy_launcher.fire_button"]');
  assert.equal(badge.children.some((item) => item.attributes.class === 'map-callout-hit'), false);
  const card = document.querySelector('[data-action="joy_launcher.fire_button"]');
  assert.equal(card.children[1].children[0].textContent, 'ディスク射出');
  card.events.click();
  document.getElementById('map-close').events.click();
  assert.equal(document.querySelector('[data-action="joy_launcher.fire_button"]').focusOptions.preventScroll, true);
});

test('popup placement chooses space beside its anchor and fits small viewports', () => {
  const { context } = editorFixture();
  const position = (anchor, width, height, viewportWidth, viewportHeight) => {
    context.placementArgs = [anchor, width, height, viewportWidth, viewportHeight];
    return JSON.parse(JSON.stringify(vm.runInContext('mapPopupPosition(...placementArgs)', context)));
  };
  assert.deepEqual(position({ left: 50, right: 150, top: 100 }, 360, 300, 1280, 800),
    { left: 162, top: 84 });
  assert.deepEqual(position({ left: 1100, right: 1200, top: 700 }, 360, 300, 1280, 800),
    { left: 728, top: 488 });
  assert.deepEqual(position({ left: 40, right: 100, top: 20 }, 366, 400, 390, 700),
    { left: 12, top: 288 });
  assert.deepEqual(position({ left: 40, right: 100, top: 20 }, 366, 900, 390, 700),
    { left: 12, top: 12 });
});

test('profile load failures remain visible even when the diagram and detailed settings are closed', async () => {
  const { document, context } = editorFixture();
  context.api = async () => { throw new Error('設定を読み込めません。'); };
  await vm.runInContext('loadControls("uart")', context);
  assert.equal(document.getElementById('controller-map-panel').hidden, true);
  assert.equal(document.getElementById('controls-load-error').hidden, false);
  assert.equal(document.getElementById('controls-load-error').textContent, '設定を読み込めません。');
});

for (const controller of ['uart', 'dualshock']) {
  test(`${controller}: separate tilt popups preserve the other direction through save and reopen`, async () => {
    const { document, context, getPayload } = editorFixture({}, controller);
    await vm.runInContext(`loadControls("${controller}")`, context);
    const shot = () => JSON.parse(vm.runInContext('JSON.stringify(controlDraft.joy_launcher)', context));
    const open = (dir) => document.querySelector(`[data-map-function="joy_launcher.tilt_${dir}_button_index"]`).events.click();
    open('down');
    assert.equal(document.getElementById('map-input').value, 'direction:7:-1');
    assert.match(document.getElementById('map-tilt-opposite').textContent, /上げる.*十字キー 上/);
    assert.equal(document.getElementById('map-apply').disabled, true);
    selectMap(document, 'map-input', 'button:1');
    assert.equal(shot().tilt_down_axis, 7);
    document.getElementById('map-apply').events.click();
    assert.equal(shot().tilt_down_axis, -1);
    assert.equal(shot().tilt_down_button_index, 1);
    assert.equal(shot().tilt_up_axis, 7);
    assert.equal(shot().tilt_up_axis_sign, 1);
    document.getElementById('map-close').events.click();
    await document.getElementById('controls-save').events.click({ preventDefault() {} });
    assert.deepEqual(getPayload().values.joy_launcher, shot());
    open('up');
    assert.equal(document.getElementById('map-input').value, 'direction:7:1');
    selectMap(document, 'map-input', 'direction:1:-1');
    document.getElementById('map-apply').events.click();
    assert.equal(shot().tilt_up_axis, 1);
    assert.equal(shot().tilt_up_axis_sign, -1);
    assert.equal(shot().tilt_down_axis, -1);
    assert.equal(shot().tilt_down_button_index, 1);
    document.getElementById('map-close').events.click();
    open('down');
    assert.equal(document.getElementById('map-input').value, 'button:1');
    selectMap(document, 'map-input', 'direction:1:-1');
    assert.equal(document.getElementById('map-apply').disabled, true);
    selectMap(document, 'map-input', 'direction:1:1');
    document.getElementById('map-apply').events.click();
    assert.equal(shot().tilt_down_axis, 1);
    assert.equal(shot().tilt_down_axis_sign, 1);
    assert.equal(shot().tilt_up_axis_sign, -1);
  });
}

test('DualShock tilt buttons use their own names and unused central controls stay off the diagram', async () => {
  const { document, context } = editorFixture({
    joy_launcher: { tilt_up_button_index: 4, tilt_down_button_index: 6 },
  }, 'dualshock');
  await vm.runInContext('loadControls("dualshock")', context);
  assert.equal(document.querySelector('[data-spot="touchpad"]'), undefined);
  assert.equal(document.querySelector('[data-spot="home"]'), undefined);
  document.querySelector('[data-map-function="joy_launcher.tilt_up_button_index"]').events.click();
  assert.match(document.getElementById('map-input').children.find((item) => item.value === 'button:4').textContent, /L1/);
  assert.match(document.getElementById('map-input').children.find((item) => item.value === 'button:6').textContent, /L2/);
  selectMap(document, 'map-input', 'button:10');
  document.getElementById('map-apply').events.click();
  assert.ok(document.querySelector('[data-spot="home"]'));
  document.getElementById('map-close').events.click();
  vm.runInContext('controlDraft.joy_launcher.fire_button = 13; refreshControlChanges()', context);
  assert.equal(document.querySelector('[data-spot="touchpad"]'), undefined);
  assert.match(document.querySelector('[data-action="joy_launcher.fire_button"]').children[1].children[1].textContent, /タッチパッド.*図の対象外/);
});

for (const controller of ['uart', 'dualshock']) {
  test(`${controller}: editing tilt up or down changes only the selected direction`, async () => {
    const { document, context, getPayload } = editorFixture({
      joy_launcher: { tilt_up_axis: -1, tilt_down_axis: -1, tilt_up_button_index: 2, tilt_down_button_index: 1 },
    }, controller);
    await vm.runInContext(`loadControls("${controller}")`, context);
    for (const [key, other, value] of [
      ['tilt_up_button_index', 'tilt_down_button_index', 4],
      ['tilt_down_button_index', 'tilt_up_button_index', 6],
    ]) {
      const before = vm.runInContext(`controlDraft.joy_launcher.${other}`, context);
      document.querySelector(`[data-map-function="joy_launcher.${key}"]`).events.click();
      assert.equal(document.getElementById('map-action').value, `joy_launcher.${key}`);
      assert.match(document.getElementById('map-editor-title').textContent, key.includes('_up_') ? /上げる/ : /下げる/);
      assert.equal(document.getElementById('map-tilt-opposite').hidden, false);
      selectMap(document, 'map-input', `button:${value}`);
      document.getElementById('map-apply').events.click();
      assert.equal(vm.runInContext(`controlDraft.joy_launcher.${key}`, context), value);
      assert.equal(vm.runInContext(`controlDraft.joy_launcher.${other}`, context), before);
      assert.equal(vm.runInContext('controlDraft.joy_launcher.tilt_up_axis', context), -1);
      document.getElementById('map-close').events.click();
    }
    await document.getElementById('controls-save').events.click({ preventDefault() {} });
    assert.deepEqual(getPayload().values.joy_launcher,
      { fire_button: 5, tilt_up_axis: -1, tilt_down_axis: -1, tilt_up_axis_sign: 1, tilt_down_axis_sign: -1, tilt_up_button_index: 4, tilt_down_button_index: 6, full_speed_value: 1 });
  });
}

test('single tilt editing rejects the opposite button, cancels local choices, and protects saved values', async () => {
  const { document, context } = editorFixture({
    joy_launcher: { tilt_up_axis: -1, tilt_down_axis: -1, tilt_up_button_index: 2, tilt_down_button_index: 1 },
  });
  await vm.runInContext('loadControls("uart")', context);
  const open = () => document.querySelector('[data-map-function="joy_launcher.tilt_up_button_index"]').events.click();
  open();
  assert.equal(document.getElementById('map-input-caption').textContent, '上げる操作');
  selectMap(document, 'map-input', 'button:1');
  assert.equal(document.getElementById('map-apply').disabled, true);
  assert.match(document.getElementById('map-preview').textContent, /異なる入力/);
  document.getElementById('map-apply').events.click();
  assert.equal(vm.runInContext('controlDraft.joy_launcher.tilt_up_button_index', context), 2);
  selectMap(document, 'map-input', 'button:4');
  document.getElementById('map-close').events.click();
  open();
  assert.equal(document.getElementById('map-input').value, 'button:2');
  selectMap(document, 'controller-map-source', 'saved');
  selectMap(document, 'map-input', 'button:4');
  document.getElementById('map-apply').events.click();
  assert.equal(vm.runInContext('controlDraft.joy_launcher.tilt_up_button_index', context), 2);
  document.getElementById('map-edit-draft').events.click();
  selectMap(document, 'map-input', 'button:4');
  vm.runInContext('controlsSetBusy(true)', context);
  document.getElementById('map-apply').events.click();
  assert.equal(vm.runInContext('controlDraft.joy_launcher.tilt_up_button_index', context), 2);
  vm.runInContext('controlsSetBusy(false)', context);
  document.getElementById('map-apply').events.click();
  assert.equal(vm.runInContext('controlDraft.joy_launcher.tilt_down_button_index', context), 1);
  assert.equal(document.getElementById('controls-change-count').textContent, '未保存の変更: 1 項目');
});

test('single tilt editing preserves a custom index until a replacement is explicitly applied', async () => {
  const { document, context } = editorFixture({
    joy_launcher: { tilt_up_axis: -1, tilt_down_axis: -1, tilt_up_button_index: 63, tilt_down_button_index: 1 },
  });
  await vm.runInContext('loadControls("uart")', context);
  document.querySelector('[data-action="joy_launcher.tilt_up_button_index"]').events.click();
  assert.equal(document.getElementById('map-input').value, 'button:63');
  assert.equal(document.getElementById('map-apply').disabled, true);
  selectMap(document, 'map-input', 'button:4');
  document.getElementById('map-apply').events.click();
  assert.equal(vm.runInContext('controlDraft.joy_launcher.tilt_up_button_index', context), 4);
  assert.equal(vm.runInContext('controlDraft.joy_launcher.tilt_down_button_index', context), 1);
});

test('a stale tilt API explains the required manager update without showing incorrect bindings', async () => {
  const { document, context } = editorFixture();
  const api = context.api;
  context.api = async (...args) => {
    const profile = await api(...args);
    profile.values.joy_launcher = { fire_button: 5, tilt_axis: 7,
      tilt_up_button_index: 4, tilt_down_button_index: 6 };
    return profile;
  };
  await vm.runInContext('loadControls("uart")', context);
  assert.equal(document.getElementById('controller-map-panel').hidden, true);
  assert.equal(document.getElementById('controls-save').disabled, true);
  assert.match(document.getElementById('controls-load-error').textContent, /担当者.*管理画面.*再起動/);
});

for (const controller of ['uart', 'dualshock']) {
  test(`${controller}: only six understandable tuning fields are rendered`, async () => {
    const { document, context } = editorFixture({
      drive_component: { max_motor_rpm: 475, max_linear_accel: 3, slew_taper_band_linear: 0.2 },
      joy_controller: { lateral_input_ratio: 0.3 },
      joy_controller_dual_stick: { longitudinal_input_ratio: 0.05 },
      joy_axis_drive: { max_motor_rpm: 100 },
    }, controller);
    await vm.runInContext(`loadControls("${controller}")`, context);
    assert.deepEqual(document.querySelectorAll('.control-field').map((row) => `${row.dataset.node}.${row.dataset.key}`).sort(),
      ['drive_component.max_linear_accel', 'drive_component.max_angular_accel', 'joy_controller.longitudinal_input_ratio', 'joy_controller.angular_input_ratio',
        'joy_launcher.full_speed_value', `${controller === 'uart' ? 'uart_joy_driver' : 'joy_node'}.deadzone`].sort());
  });
}

test('friendly units preserve precision, inversion and every hidden value when saving', async () => {
  const { document, context, getPayload } = editorFixture({
    joy_controller: { longitudinal_input_ratio: -2, angular_input_ratio: -6, lateral_input_ratio: -0.31 },
    drive_component: { min_command_rpm: 7, slew_taper_band_linear: 0.17 },
  });
  await vm.runInContext('loadControls("uart")', context);
  const before = JSON.parse(vm.runInContext('JSON.stringify(controlDraft)', context));
  const turn = document.getElementById('control-joy_controller-angular_input_ratio');
  assert.equal(Number(turn.value), 6);
  turn.events.input();
  assert.equal(vm.runInContext('controlDraft.joy_controller.angular_input_ratio', context), -6);
  turn.value = '3'; turn.events.input();
  assert.equal(vm.runInContext('controlDraft.joy_controller.angular_input_ratio', context), -3);
  const speed = document.getElementById('control-joy_controller-longitudinal_input_ratio');
  speed.value = '0'; speed.events.input();
  speed.value = '1.5'; speed.events.input();
  const roller = document.getElementById('control-joy_launcher-full_speed_value');
  roller.value = '65'; roller.events.input();
  const deadzone = document.getElementById('control-uart_joy_driver-deadzone');
  deadzone.value = '12'; deadzone.events.input();
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  const expected = structuredClone(before);
  expected.joy_controller.longitudinal_input_ratio = -1.5;
  expected.joy_controller.angular_input_ratio = -3;
  expected.drive_component.max_angular_accel = 1.5;
  expected.joy_launcher.full_speed_value = 0.65;
  expected.uart_joy_driver.deadzone = 0.12;
  assert.deepEqual(getPayload().values, expected);
});

test('rounded upper bounds remain valid and reset retains direction after clearing a value', async () => {
  const { document, context } = editorFixture({ joy_controller: { angular_input_ratio: -6 } });
  await vm.runInContext('loadControls("uart")', context);
  const turn = document.getElementById('control-joy_controller-angular_input_ratio');
  assert.equal(Number(turn.value), Number(turn.max));
  turn.events.input();
  assert.equal(vm.runInContext('controlDraft.joy_controller.angular_input_ratio', context), -6);
  turn.value = ''; turn.events.input();
  document.getElementById('controls-reset').events.click();
  assert.equal(vm.runInContext('controlDraft.joy_controller.angular_input_ratio', context), -6);
});

for (const entered of ['2', '2.0']) {
  test(`typing ${entered} produces numeric payloads for all six tuning fields`, async () => {
    const { document, context, getPayload } = editorFixture({
      joy_controller: { longitudinal_input_ratio: 1.5 },
    });
    await vm.runInContext('loadControls("uart")', context);
    for (const [node, key] of [
      ['joy_controller', 'longitudinal_input_ratio'], ['joy_controller', 'angular_input_ratio'],
      ['joy_launcher', 'full_speed_value'], ['uart_joy_driver', 'deadzone'],
      ['drive_component', 'max_linear_accel'], ['drive_component', 'max_angular_accel'],
    ]) {
      const input = document.getElementById(`control-${node}-${key}`);
      input.value = entered;
      input.events.input();
    }
    await vm.runInContext('saveControls({preventDefault() {}})', context);
    const values = getPayload().values;
    assert.equal(values.joy_controller.longitudinal_input_ratio, 2);
    assert.equal(values.joy_controller.angular_input_ratio, 2);
    assert.equal(values.joy_launcher.full_speed_value, 0.02);
    assert.equal(values.uart_joy_driver.deadzone, 0.02);
    assert.equal(values.drive_component.max_linear_accel, 1);
    assert.equal(values.drive_component.max_angular_accel, 1);
  });
}

test('turn presets keep a fixed standard across save, runtime comparison and reset', async () => {
  const { document, context, getPayload } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  const turnRow = () => document.querySelectorAll('.control-field').find((row) => row.dataset.key === 'angular_input_ratio');
  const presets = () => turnRow().querySelector('.control-presets').children;
  const turnInput = () => document.getElementById('control-joy_controller-angular_input_ratio');
  assert.equal(Number(turnInput().value), 6);
  assert.deepEqual(presets().map((button) => button.textContent), ['ゆっくり 50%', '標準 100%', '速め 150%']);
  presets()[0].events.click();
  assert.equal(turnInput().value, '3.00');
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.equal(getPayload().values.joy_controller.angular_input_ratio, 3);
  assert.equal(Number(turnInput().value), 3);
  vm.runInContext(`controlRuntime = { nodes: { joy_controller: {status: 'ok', values: {angular_input_ratio: 6}} } };
    renderRuntimeValues();`, context);
  assert.equal(turnRow().querySelector('.control-runtime-value').textContent, '6 rad/s（344°/s）');
  assert.equal(turnRow().querySelector('.control-runtime-state').textContent, '保存済みと異なる');
  presets()[2].events.click();
  assert.equal(vm.runInContext('controlDraft.joy_controller.angular_input_ratio', context), 9);
  vm.runInContext('controlsSetBusy(true)', context);
  assert.equal(presets()[0].disabled, true);
  presets()[0].events.click();
  assert.equal(vm.runInContext('controlDraft.joy_controller.angular_input_ratio', context), 9);
  vm.runInContext('controlsSetBusy(false)', context);
  document.getElementById('controls-reset').events.click();
  assert.equal(Number(turnInput().value), 6);
  assert.equal(vm.runInContext('controlDraft.joy_controller.angular_input_ratio', context), 6);
});

test('a custom zero turn default stays editable without division by zero', async () => {
  const { document, context, getPayload } = editorFixture({ joy_controller: { angular_input_ratio: 0 } });
  await vm.runInContext('loadControls("uart")', context);
  const input = document.getElementById('control-joy_controller-angular_input_ratio');
  assert.equal(Number(input.value), 0);
  assert.ok(Number.isFinite(input.max));
  const row = document.querySelectorAll('.control-field').find((item) => item.dataset.key === 'angular_input_ratio');
  assert.match(row.children[0].children[0].textContent, /rad\/s/);
  input.value = '0.5'; input.events.input();
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.equal(getPayload().values.joy_controller.angular_input_ratio, 0.5);
});

test('acceleration presets persist independent limits and keep the standard fixed', async () => {
  const { document, context, getPayload } = editorFixture({ drive_component: { min_command_rpm: 7 } });
  await vm.runInContext('loadControls("uart")', context);
  const row = (key) => document.querySelectorAll('.control-field').find((item) => item.dataset.key === key);
  row('max_linear_accel').querySelector('.control-presets').children[0].events.click();
  row('max_angular_accel').querySelector('.control-presets').children[2].events.click();
  // A rounded preset display must not change its exact acceleration on a repeated input event.
  document.getElementById('control-drive_component-max_angular_accel').events.input();
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.equal(getPayload().values.drive_component.max_linear_accel, 1.5);
  assert.equal(getPayload().values.drive_component.max_angular_accel, 4.5);
  assert.equal(getPayload().values.drive_component.min_command_rpm, 7);
  assert.equal(getPayload().values.joy_controller.longitudinal_input_ratio, 2);
  assert.equal(getPayload().values.joy_controller.angular_input_ratio, 6);
  assert.equal(Number(document.getElementById('control-drive_component-max_linear_accel').value), 1.33);
  vm.runInContext(`controlRuntime = { nodes: { drive_component: {status: 'ok', values: {
    max_linear_accel: 3, max_angular_accel: 0}} } }; renderRuntimeValues();`, context);
  assert.equal(row('max_linear_accel').querySelector('.control-runtime-value').textContent, '加速時間は未確認');
  assert.equal(row('max_angular_accel').querySelector('.control-runtime-value').textContent, '制限なし');
  document.getElementById('controls-reset').events.click();
  assert.equal(vm.runInContext('controlDraft.drive_component.max_linear_accel', context), 3);
  assert.equal(vm.runInContext('controlDraft.drive_component.max_angular_accel', context), 3);
});

test('acceleration editing has no toggle and rejects zero as a gentle setting', async () => {
  const { document, context } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  assert.equal(document.getElementById('controls-fields').all().some((el) => el.type === 'checkbox'), false);
  const input = document.getElementById('control-drive_component-max_linear_accel');
  input.value = '0'; input.events.input();
  assert.equal(input.checkValidity(), false);
  assert.match(input.validationMessage, /プリセット/);
  const row = document.querySelectorAll('.control-field').find((item) => item.dataset.key === 'max_linear_accel');
  row.querySelector('.control-presets').children[0].events.click();
  assert.equal(input.checkValidity(), true);
  assert.equal(vm.runInContext('controlDraft.drive_component.max_linear_accel', context), 1.5);
});

test('legacy zero acceleration survives unrelated saves and accepts direct positive editing', async () => {
  const { document, context, getPayload } = editorFixture({ drive_component: { max_linear_accel: 0 } });
  await vm.runInContext('loadControls("uart")', context);
  let input = document.getElementById('control-drive_component-max_linear_accel');
  assert.equal(input.disabled, false);
  assert.equal(input.required, false);
  assert.equal(input.value, '');
  assert.match(input.placeholder, /制限なし/);
  const speed = document.getElementById('control-joy_controller-longitudinal_input_ratio');
  speed.value = '1'; speed.events.input();
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.equal(getPayload().values.drive_component.max_linear_accel, 0);
  input = document.getElementById('control-drive_component-max_linear_accel');
  input.value = '2'; input.events.input();
  assert.equal(input.required, true);
  assert.equal(vm.runInContext('controlDraft.drive_component.max_linear_accel', context), 0.5);
  input.value = ''; input.events.input();
  assert.equal(vm.runInContext('controlDraft.drive_component.max_linear_accel', context), null);
  assert.equal(input.required, true);
});


test('field help opens on demand without changing or saving values', async () => {
  const { document, context, getPayload } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  for (const row of document.querySelectorAll('.control-field')) {
    const help = row.querySelector('.control-field-help');
    const info = row.querySelector('.control-info');
    assert.equal(help.hidden, true);
    assert.equal(info.type, 'button');
    assert.equal(info.attributes['aria-controls'], help.id);
    assert.equal(info.attributes['aria-expanded'], 'false');
    info.events.click();
    assert.equal(help.hidden, false);
    assert.equal(info.attributes['aria-expanded'], 'true');
    info.events.click();
    assert.equal(help.hidden, true);
    assert.equal(info.attributes['aria-expanded'], 'false');
  }
  assert.equal(document.getElementById('controls-save').disabled, true);
  assert.equal(getPayload(), undefined);
});

test('shared save includes both diagram and tuning changes while details are closed', async () => {
  const { document, context, getPayload } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  document.getElementById('controls-details').open = false;
  vm.runInContext('controlDraft.joy_launcher.fire_button = 0', context);
  const input = document.getElementById('control-joy_controller-longitudinal_input_ratio');
  input.value = '1'; input.events.input();
  assert.equal(document.getElementById('controls-change-count').textContent, '未保存の変更: 3 項目');
  assert.equal(document.getElementById('controls-savebar').hidden, false);
  await document.getElementById('controls-save').events.click({ preventDefault() {} });
  assert.equal(getPayload().values.joy_launcher.fire_button, 0);
  assert.equal(getPayload().values.joy_controller.longitudinal_input_ratio, 1);
  assert.equal(document.getElementById('controls-details').open, false);
  assert.equal(document.getElementById('controls-save').disabled, true);
});

test('restoring previous saved settings changes only the draft until explicit save', async () => {
  const { document, context, getPayload } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  vm.runInContext(`controlProfile.previous_values = structuredClone(controlProfile.values);
    controlProfile.previous_values.joy_controller.longitudinal_input_ratio = 1.25;
    controlsSetBusy(false);`, context);
  assert.equal(document.getElementById('controls-undo').disabled, false);
  document.getElementById('controls-undo').events.click();
  assert.equal(getPayload(), undefined);
  assert.equal(vm.runInContext('controlProfile.values.joy_controller.longitudinal_input_ratio', context), 2);
  assert.equal(vm.runInContext('controlDraft.joy_controller.longitudinal_input_ratio', context), 1.25);
  assert.match(document.getElementById('controls-application-title').textContent, /未保存/);
  await document.getElementById('controls-save').events.click({ preventDefault() {} });
  assert.equal(getPayload().values.joy_controller.longitudinal_input_ratio, 1.25);
});

test('a runtime response arriving after a service change cannot revive a stale comparison', async () => {
  const { document, context } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  vm.runInContext('runtimeAvailable = true', context);
  let finish;
  context.api = () => new Promise((resolve) => { finish = resolve; });
  const pending = vm.runInContext('loadRuntimeValues()', context);
  vm.runInContext('invalidateControlRuntime()', context);
  finish({ captured_at: new Date().toISOString(), nodes: {} });
  await pending;
  assert.equal(vm.runInContext('controlRuntime', context), null);
  assert.match(document.getElementById('controls-runtime-message').textContent, /状態が変わりました/);
  assert.equal(document.getElementById('controls-verify').disabled, false);
});

test('ID15 legacy speed warns, models saturated stopping, and needs repair before save', async () => {
  const { document, context, getPayload } = editorFixture({
    joy_controller: { longitudinal_input_ratio: 10, angular_input_ratio: 4.5 },
    drive_component: { max_linear_accel: 2.25, max_angular_accel: 2.25 },
  });
  await vm.runInContext('loadControls("uart")', context);
  const speed = document.getElementById('control-joy_controller-longitudinal_input_ratio');
  assert.equal(Number(speed.value), 10);
  assert.equal(document.getElementById('controls-range-warning').hidden, false);
  assert.match(speed.validationMessage, /10.0 m\/s.*2.0 m\/s/);
  assert.doesNotMatch(speed.validationMessage, /方向の反転あり/);
  assert.match(document.getElementById(`${speed.id}-estimate`).textContent, /約 2.49 m\/s.*倒し続けて.*3.34 s.*9.68 m.*単独/);
  assert.match(document.getElementById('tuning-linear-summary').textContent, /4.44 s.*9.68 m/);
  assert.equal(Number(document.getElementById('control-drive_component-max_linear_accel').value), 1.11);
  vm.runInContext('controlDraft.joy_launcher.fire_button = 0; refreshControlChanges()', context);
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.equal(getPayload(), undefined);
  speed.value = '2'; speed.events.input();
  const accel = vm.runInContext('controlDraft.drive_component.max_linear_accel', context);
  assert.ok(Math.abs(2 / accel - 475 * 2 * Math.PI * 0.05 / 60 / 2.25) < 1e-12);
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.equal(getPayload().values.joy_controller.longitudinal_input_ratio, 2);
  assert.equal(getPayload().values.drive_component.max_linear_accel, accel);
  assert.equal(document.getElementById('controls-range-warning').hidden, true);
});

test('negative saved speeds and hidden lateral repair retain direction until saved', async () => {
  const { document, context, getPayload } = editorFixture({
    joy_controller: { longitudinal_input_ratio: -10, lateral_input_ratio: -10 },
  });
  await vm.runInContext('loadControls("uart")', context);
  const host = document.getElementById('controls-range-warning');
  assert.match(host.children[0].textContent, /10.0 m\/s（方向の反転あり）/);
  const repair = document.getElementById('control-lateral-repair');
  assert.equal(Number(repair.value), 10);
  assert.match(document.getElementById('control-lateral-repair-help').textContent,
    /この機体（左右 2 輪）では使われませんが、保存するには範囲内にしてください/);
  const speed = document.getElementById('control-joy_controller-longitudinal_input_ratio');
  speed.value = '2'; speed.events.input();
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.equal(getPayload(), undefined);
  assert.equal(vm.runInContext('controlDraft.joy_controller.lateral_input_ratio', context), -10);
  repair.value = '2'; repair.events.input();
  assert.equal(host.hidden, false);
  assert.equal(document.getElementById('control-lateral-repair'), repair);
  assert.match(document.getElementById('controls-range-state').textContent, /まだ保存されていません/);
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.equal(getPayload().values.joy_controller.longitudinal_input_ratio, -2);
  assert.equal(getPayload().values.joy_controller.lateral_input_ratio, -2);
  assert.equal(host.hidden, true);
});

test('restoring out-of-range history cannot save until explicitly repaired', async () => {
  const { document, context, getPayload } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  vm.runInContext(`controlProfile.previous_values = structuredClone(controlProfile.values);
    controlProfile.previous_values.joy_controller.longitudinal_input_ratio = -10;
    controlsSetBusy(false);`, context);
  document.getElementById('controls-undo').events.click();
  assert.equal(document.getElementById('controls-range-warning').hidden, false);
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.equal(getPayload(), undefined);
  assert.match(document.getElementById('controls-message').textContent, /方向の反転あり/);
});

test('the displayed rounded-up minimum time can be entered and saved', async () => {
  const { document, context, getPayload } = editorFixture({
    joy_controller: { longitudinal_input_ratio: 1.234567 },
  });
  await vm.runInContext('loadControls("uart")', context);
  const row = document.querySelectorAll('.control-field').find((r) => r.dataset.key === 'max_linear_accel');
  const displayed = row.querySelector('.control-range').textContent.match(/範囲：(\S+) s/)[1];
  assert.ok(Number(displayed) >= 1.234567 / 50);
  const time = document.getElementById('control-drive_component-max_linear_accel');
  time.value = displayed; time.events.input();
  assert.equal(time.validationMessage, '');
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.ok(getPayload().values.drive_component.max_linear_accel <= 50);
});

test('missing installed geometry explains why the time field cannot be edited', async () => {
  const { document, context } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  vm.runInContext('controlProfile.geometry = null; renderControls()', context);
  assert.equal(document.getElementById('control-drive_component-max_linear_accel').disabled, true);
  assert.match(document.getElementById('control-drive_component-max_linear_accel-estimate').textContent,
    /車輪の寸法.*加速度を計算できず.*編集できません/);
});

for (const carried of [false, true]) {
  test(`server 422 message survives a stale UI schema (carried hidden value: ${carried})`, async () => {
    const { document, context } = editorFixture({ joy_controller: { lateral_input_ratio: 0 } });
    await vm.runInContext('loadControls("uart")', context);
    vm.runInContext(`controlProfile.groups.find(g => g.node === 'joy_controller').fields
      .filter(f => f.key.includes('input_ratio')).forEach(f => {f.min = -20; f.max = 20;});
      controlDraft.joy_controller.${carried ? 'lateral_input_ratio' : 'longitudinal_input_ratio'} = -10;
      renderControls();`, context);
    const message = `${carried ? '左右の速さ' : '走行速度'} 10.0 m/s（方向の反転あり）は、保存できる範囲の外です。大きさを 2.0 m/s 以下にしてください（方向の反転は保存済みのまま）。`;
    let called = false;
    context.api = async () => { called = true; throw new Error(message); };
    await vm.runInContext('saveControls({preventDefault() {}})', context);
    assert.equal(called, true);
    assert.equal(document.getElementById('controls-message').textContent, message);
    assert.equal(vm.runInContext('controlProfile.revision', context), 'initial');
  });
}

test('all visible fields state input ranges and time conversion rejects out-of-range acceleration', async () => {
  const { document, context, getPayload } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  for (const row of document.querySelectorAll('.control-field')) {
    assert.match(row.querySelector('.control-range').textContent, /入力できる範囲/);
  }
  const input = document.getElementById('control-drive_component-max_angular_accel');
  const curves = () => document.getElementById('tuning-angular-chart').all()
    .filter((el) => el.attributes['data-series']).map((el) => el.attributes.points);
  const before = curves();
  input.value = '3'; input.events.input();
  assert.notEqual(curves()[0], before[0]);
  // The common axis may grow but the packaged defaults themselves are unchanged.
  assert.equal(vm.runInContext('controlProfile.defaults.drive_component.max_angular_accel', context), 3);
  input.value = '0.001'; input.events.input();
  assert.equal(input.disabled, false);
  assert.match(input.validationMessage, /範囲の外/);
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.equal(getPayload(), undefined);
  assert.match(document.getElementById('controls-message').textContent, /範囲の外/);
  input.value = '2'; input.events.input();
  assert.equal(input.validationMessage, '');
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.equal(getPayload().values.drive_component.max_angular_accel, 3);
});

test('runtime time uses actual geometry, rpm and speed, and missing speed stays unconfirmed', async () => {
  const { document, context } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  vm.runInContext(`controlRuntime = { nodes: {
    joy_controller: {status: 'ok', values: {longitudinal_input_ratio: 10, angular_input_ratio: 4.5}},
    drive_component: {status: 'ok', values: {max_motor_rpm: 475, wheel_radius: 0.05,
      wheel_separation: 0.5, max_linear_accel: 1.5, max_angular_accel: 2.25}}
  } }; renderRuntimeValues();`, context);
  const row = (key) => document.querySelectorAll('.control-field').find((r) => r.dataset.key === key);
  assert.equal(row('max_linear_accel').querySelector('.control-runtime-value').textContent, '1.66 s');
  assert.equal(row('max_angular_accel').querySelector('.control-runtime-value').textContent, '2 s');
  assert.match(row('max_angular_accel').querySelector('.control-runtime-state').textContent, /加速度/);
  vm.runInContext(`delete controlRuntime.nodes.joy_controller.values.angular_input_ratio;
    renderRuntimeValues();`, context);
  assert.equal(row('max_angular_accel').querySelector('.control-runtime-value').textContent, '加速時間は未確認');
});

test('display-only rounding and zero speed preserve exact raw limits through save', async () => {
  const { document, context, getPayload } = editorFixture({
    drive_component: { max_linear_accel: 3.123456789 },
  });
  await vm.runInContext('loadControls("uart")', context);
  const time = document.getElementById('control-drive_component-max_linear_accel');
  time.events.input();
  assert.equal(vm.runInContext('controlDraft.drive_component.max_linear_accel', context), 3.123456789);
  const speed = document.getElementById('control-joy_controller-longitudinal_input_ratio');
  speed.value = '0'; speed.events.input();
  assert.equal(time.disabled, true);
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.equal(getPayload().values.drive_component.max_linear_accel, 3.123456789);
  const reloadedSpeed = document.getElementById('control-joy_controller-longitudinal_input_ratio');
  reloadedSpeed.value = '1'; reloadedSpeed.events.input();
  assert.equal(document.getElementById('control-drive_component-max_linear_accel').disabled, false);
  assert.equal(vm.runInContext('controlDraft.drive_component.max_linear_accel', context), 3.123456789);
});


test('speed and acceleration-time inputs show two decimals without changing exact saved values', async () => {
  const { document, context } = editorFixture({ joy_controller: { longitudinal_input_ratio: 1.23456789 } });
  await vm.runInContext('loadControls("uart")', context);
  const speed = document.getElementById('control-joy_controller-longitudinal_input_ratio');
  const time = document.getElementById('control-drive_component-max_linear_accel');
  assert.equal(speed.value, '1.23');
  assert.match(String(time.value), /^\d+\.\d{2}$/);
  assert.equal(vm.runInContext('controlDraft.joy_controller.longitudinal_input_ratio', context), 1.23456789);
  speed.value = '1.5'; speed.events.input(); speed.events.blur();
  assert.equal(speed.value, '1.50');
  assert.equal(vm.runInContext('controlDraft.joy_controller.longitudinal_input_ratio', context), 1.5);
});


test('forward-speed presets use fixed defaults and preserve acceleration time through save', async () => {
  const { document, context, getPayload } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  const row = () => document.querySelectorAll('.control-field').find(row => row.dataset.key === 'longitudinal_input_ratio');
  const input = () => document.getElementById('control-joy_controller-longitudinal_input_ratio');
  const time = () => document.getElementById('control-drive_component-max_linear_accel');
  const before = time().value;
  const presets = () => row().querySelector('.control-presets').children;
  assert.deepEqual(presets().map(button => button.textContent), ['ゆっくり 50%', '標準 100%', '速め 150%']);
  presets()[0].events.click();
  assert.equal(input().value, '1.00');
  assert.equal(time().value, before);
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.equal(getPayload().values.joy_controller.longitudinal_input_ratio, 1);
  presets()[1].events.click();
  assert.equal(input().value, '2.00');
  assert.equal(time().value, before);
});

test('paired motion fields precede their matching preview and keep accessible labels', async () => {
  const { document, context } = editorFixture();
  await vm.runInContext('loadControls("uart")', context);
  const groups = document.getElementById('controls-fields').children.filter(group => group.dataset.kind);
  assert.deepEqual(groups.map(group => group.dataset.kind), ['linear', 'angular']);
  assert.deepEqual(groups.map(group => group.children.filter(row => row.className === 'control-field')
    .map(row => row.dataset.key)), [
    ['longitudinal_input_ratio', 'max_linear_accel'], ['angular_input_ratio', 'max_angular_accel'],
  ]);
  for (const group of groups) {
    const preview = group.children.at(-1);
    assert.equal(preview.children[0].id, `tuning-${group.dataset.kind}-heading`);
    for (const row of group.children.filter(row => row.className === 'control-field')) {
      const classes = row.children.map(child => child.className);
      assert.ok(classes.indexOf('control-presets') < classes.indexOf('control-editor'));
    }
  }
  const rows = document.querySelectorAll('.control-field');
  for (const [key, label] of [['angular_input_ratio', '旋回速度（rad/s）'],
    ['max_linear_accel', '走行の加速時間（s）'], ['max_angular_accel', '旋回の加速時間（s）']]) {
    const row = rows.find(row => row.dataset.key === key);
    const input = document.getElementById(`control-${row.dataset.node}-${key}`);
    assert.equal(row.children[0].children[0].textContent, label);
    assert.equal(row.children[0].children[0].htmlFor, input.id);
  }
});

test('two-decimal display and blur never round exact values in an unrelated save', async () => {
  const exact = 1.23456789, accel = 3.123456789;
  const { document, context, getPayload } = editorFixture({
    joy_controller: { longitudinal_input_ratio: exact }, drive_component: { max_linear_accel: accel },
  });
  await vm.runInContext('loadControls("uart")', context);
  const speed = document.getElementById('control-joy_controller-longitudinal_input_ratio');
  assert.equal(speed.value, '1.23');
  speed.events.blur();
  vm.runInContext('controlDraft.joy_launcher.fire_button = 0; refreshControlChanges()', context);
  await vm.runInContext('saveControls({preventDefault() {}})', context);
  assert.equal(getPayload().values.joy_controller.longitudinal_input_ratio, exact);
  assert.equal(getPayload().values.drive_component.max_linear_accel, accel);
});
