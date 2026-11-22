import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  KEYMAP_DEFAULT_MAPPING as defaults,
  ROBOT_STICK_AXES,
  ROBOT_DPAD_INPUTS,
  ROBOT_COMMON_BUTTONS,
  ROBOT_PROFILE_BUTTONS,
  robotManagerRows,
  robotManagerWarnings,
  robotOrientedInput,
  commandFromInput,
} from '../js/keymap/core.js';
import { rowValue, rowNote, tableText } from '../js/keymap/format.js';
const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const copy = JSON.parse(read('../content/keymap.json'));
const values = (mapping) =>
  Object.fromEntries(robotManagerRows(mapping).map((r) => [r.param, r.value]));
const yamlGroup = (text, node) =>
  text.match(new RegExp(`^${node}:\\n([^]*?)(?=^\\S|$(?![^]))`, 'm'))[1];
const yamlValue = (group, key) =>
  Number(group.match(new RegExp(`^\\s+${key}:\\s*(-?[\\d.]+)`, 'm'))[1]);

test('the initial D-pad tilt export matches both distributed profiles, with no unused button rows', () => {
  const rows = robotManagerRows(defaults),
    actual = values(defaults);
  for (const profile of ['dualshock', 'uart']) {
    const text = read(`../../../../../questix_control_config/config/controls.${profile}.yaml`);
    const launcher = yamlGroup(text, 'joy_launcher');
    for (const param of [
      'tilt_up_axis',
      'tilt_up_axis_sign',
      'tilt_down_axis',
      'tilt_down_axis_sign',
    ])
      assert.equal(actual[param], yamlValue(launcher, param), `${profile}.${param}`);
    const drive = yamlGroup(text, 'joy_controller');
    for (const param of ['linear_x_axis', 'angular_z_axis'])
      assert.equal(actual[param], yamlValue(drive, param), `${profile}.${param}`);
  }
  assert(!rows.some((r) => r.param.endsWith('_button_index')));
  assert.equal(actual.tilt_up_axis, 7);
  assert.equal(actual.tilt_down_axis, 7);
  assert.deepEqual(robotManagerWarnings(defaults), []);
});

test('all four standard sticks export robot numbers without changing model input numbers', () => {
  assert.deepEqual(ROBOT_STICK_AXES, [0, 1, 3, 4]);
  for (let browser = 0; browser < 4; browser++) {
    const mapping = { ...defaults, forward: browser, turn: browser };
    const rows = values(mapping);
    assert.equal(rows.linear_x_axis, ROBOT_STICK_AXES[browser]);
    assert.equal(rows.angular_z_axis, ROBOT_STICK_AXES[browser]);
    const axes = [0, 0, 0, 0];
    axes[browser] = -1;
    const command = commandFromInput(robotOrientedInput({ axes, buttons: [] }), mapping);
    assert.equal(command.drive.linear, rows.longitudinal_input_ratio);
    assert.equal(command.drive.angular, rows.angular_input_ratio);
  }
});

test('every D-pad direction exports its half-axis, including reassigned or reversed tilt', () => {
  assert.deepEqual(ROBOT_DPAD_INPUTS, {
    12: { axis: 7, sign: 1 },
    13: { axis: 7, sign: -1 },
    14: { axis: 6, sign: 1 },
    15: { axis: 6, sign: -1 },
  });
  for (const [button, input] of Object.entries(ROBOT_DPAD_INPUTS)) {
    const rows = values({ ...defaults, tiltUp: Number(button), tiltDown: Number(button) });
    assert.equal(rows.tilt_up_axis, input.axis);
    assert.equal(rows.tilt_up_axis_sign, input.sign);
    assert.equal(rows.tilt_down_axis, input.axis);
    assert.equal(rows.tilt_down_axis_sign, input.sign);
  }
});

test('one custom tilt selects button mode for that direction only and warns in the table and copy', () => {
  const mapping = { ...defaults, tiltUp: 4 };
  const rows = robotManagerRows(mapping),
    actual = values(mapping);
  assert.equal(actual.tilt_up_axis, -1);
  assert.equal(actual.tilt_up_button_index, 4);
  assert.equal(actual.tilt_down_axis, 7);
  assert.equal(actual.tilt_down_axis_sign, -1);
  assert(!Object.hasOwn(actual, 'tilt_down_button_index'));
  assert.deepEqual(robotManagerWarnings(mapping), ['tiltButtons']);
  const mode = rows.find((r) => r.param === 'tilt_up_axis');
  assert(rowNote(mode, copy).includes('ロボットで番号を確かめ'));
  assert(tableText(rows, copy).includes('tilt_up_axis\t-1\t十字キーから別のボタン'));
  assert(copy.apply.tiltButtons.includes('射出角度の操作が十字キーから別のボタン'));
  assert(copy.apply.steps.some((s) => s.includes('ロボットで確かめたボタン番号')));
});

test('uncertain face/stick buttons show profile candidates, never a guessed numeric value', () => {
  for (const [browser, choices] of Object.entries(ROBOT_PROFILE_BUTTONS)) {
    const rows = robotManagerRows({ ...defaults, tiltUp: Number(browser) });
    const field = rows.find((r) => r.param === 'tilt_up_button_index');
    assert.equal(field.value, null);
    assert.equal(rowValue(field, copy), 'ロボットで確かめる');
    const note = rowNote(field, copy);
    assert(note.includes(`DualShockでは${choices.dualshock}`));
    assert(note.includes(`UARTでは${choices.uart}`));
    assert(robotManagerWarnings({ ...defaults, tiltUp: Number(browser) }).includes('unresolved'));
  }
});

test('button-only launcher fields cannot receive D-pad axes; unknown inputs require checking', () => {
  for (const mapping of [
    { ...defaults, roller: 12 },
    { ...defaults, fire: 13 },
    { ...defaults, forward: 8 },
  ]) {
    const unknown = robotManagerRows(mapping).filter((r) => r.value === null);
    assert(unknown.length > 0);
    for (const row of unknown) {
      assert.equal(rowValue(row, copy), copy.apply.verify);
      assert(rowNote(row, copy).includes('ロボットで確かめ'));
    }
  }
});

test('known button translations match Robot Manager physical labels for BOTH profiles', () => {
  const context = {};
  vm.runInNewContext(
    read('../../../static/control-labels.js') + '\nglobalThis.labels = ControlLabels;',
    context,
  );
  const expected = {
    2: ['□', 'Y'],
    3: ['△', 'X'],
    4: ['L1', 'L'],
    5: ['R1', 'R'],
    6: ['L2', 'ZL'],
    7: ['R2', 'ZR'],
    8: ['SHARE', '−'],
    9: ['OPTIONS', '＋'],
    16: ['PS', 'HOME'],
  };
  for (const [browser, robot] of Object.entries(ROBOT_COMMON_BUTTONS)) {
    for (const [i, profile] of ['dualshock', 'uart'].entries()) {
      assert(
        context.labels.valueLabel(profile, 'fire_button', robot).includes(expected[browser][i]),
      );
    }
    const row = robotManagerRows({ ...defaults, fire: Number(browser) }).find(
      (r) => r.param === 'fire_button',
    );
    assert.equal(row.value, robot);
  }
});

test('triggers remain thresholded buttons, not DualShock continuous axes', () => {
  for (const button of [6, 7]) {
    const row = robotManagerRows({ ...defaults, tiltUp: button }).find(
      (r) => r.param === 'tilt_up_button_index',
    );
    assert.equal(row.value, button);
    assert(rowNote(row, copy).includes('連続量の軸にはしません'));
  }
});

test('the difference list and warnings cover sticks, D-pad, triggers, profile-only numbers', () => {
  const text = copy.apply.differences.join('\n');
  for (const term of [
    '右スティック',
    '十字キー',
    'トリガー',
    '押し込み',
    'DualShock',
    'UART',
    'Web',
  ])
    assert(text.includes(term), term);
  for (const rows of [
    robotManagerRows(defaults),
    robotManagerRows({ ...defaults, tiltUp: 0, fire: 12 }),
  ])
    for (const row of rows) if (row.note) assert(rowNote(row, copy).length > 0);
});
