import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  STANDARD_AXES,
  ROBOT_AXIS_SIGNS,
  ROBOT_STICK_AXES,
  KEYMAP_DEFAULT_MAPPING as defaults,
  KEYMAP_TOPIC_MAPPINGS,
  robotOrientedInput,
  readGamepad,
  commandFromInput,
  robotManagerRows,
  newRobot,
  stepRobot,
  SIM,
  discPosition,
} from '../js/keymap/core.js';
import { tableText } from '../js/keymap/format.js';
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const copy = JSON.parse(read('../content/keymap.json'));
const raw = (axes) => ({ axes, buttons: Array(17).fill(false) });
const close = (a, b) => assert(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('all four standard axes are reoriented once; raw input, numbers and buttons are retained', () => {
  assert.equal(STANDARD_AXES, 4);
  assert.deepEqual(ROBOT_AXIS_SIGNS, [-1, -1, -1, -1]);
  const pad = readGamepad({
    connected: true,
    id: 'Synthetic',
    mapping: 'standard',
    axes: [-0.25, -1, -0.5, 0.75, 0.4],
    buttons: [{ pressed: true, value: 1 }],
  });
  const oriented = robotOrientedInput(pad);
  assert.deepEqual(pad.axes, [-0.25, -1, -0.5, 0.75, 0.4]);
  assert.deepEqual(oriented.axes, [0.25, 1, 0.5, -0.75, 0.4]);
  assert.deepEqual(oriented.buttons, pad.buttons);
  assert.equal(oriented.axes.length, pad.axes.length);
  assert.deepEqual(robotOrientedInput(raw([0, -0, NaN, Infinity])).axes, [0, 0, 0, 0]);
});

test('every stage starts with forward/left-positive speeds and separate roller/fire buttons', () => {
  for (const mapping of Object.values(KEYMAP_TOPIC_MAPPINGS)) {
    assert.equal(mapping.forwardScale, 1);
    assert.equal(mapping.turnScale, 3);
    assert.equal(mapping.roller, 7);
    assert.equal(mapping.fire, 5);
  }
});

test('positive distributed defaults and exported signs drive forward and turn left', () => {
  const input = robotOrientedInput(raw([0, -1, -1, 0]));
  const command = commandFromInput(input, defaults);
  assert.equal(command.drive.linear, 1);
  assert.equal(command.drive.angular, 3);
  const rows = robotManagerRows(defaults);
  const settings = Object.fromEntries(
    rows.filter((r) => r.node === 'joy_controller').map((r) => [r.param, r.value]),
  );
  const robotAxes = Array(8).fill(0);
  ROBOT_STICK_AXES.forEach((robot, browser) => {
    robotAxes[robot] = input.axes[browser];
  });
  assert.equal(
    robotAxes[settings.linear_x_axis] * settings.longitudinal_input_ratio,
    command.drive.linear,
  );
  assert.equal(
    robotAxes[settings.angular_z_axis] * settings.angular_input_ratio,
    command.drive.angular,
  );
  assert(tableText(rows, copy).includes('longitudinal_input_ratio\t1'));
  assert(tableText(rows, copy).includes('angular_input_ratio\t旋回 3.00 rad/s（約 172°/s）'));
  let forward = newRobot(),
    left = newRobot();
  for (let i = 0; i < 50; i++) {
    forward = stepRobot(
      forward,
      commandFromInput(robotOrientedInput(raw([0, -1, 0, 0])), defaults),
      0.02,
    );
    left = stepRobot(
      left,
      commandFromInput(robotOrientedInput(raw([0, 0, -1, 0])), defaults),
      0.02,
    );
  }
  assert(forward.x > newRobot().x);
  close(forward.y, newRobot().y);
  assert(left.heading > 0);
  close(left.x, newRobot().x);
  close(left.y, newRobot().y);
  const reversed = { ...defaults, forwardScale: -1, turnScale: -3 };
  assert.deepEqual(commandFromInput(input, reversed).drive, { linear: -1, angular: -3 });
  assert.equal(
    robotManagerRows(reversed).find((r) => r.param === 'longitudinal_input_ratio').value,
    -1,
  );
  assert.equal(robotManagerRows(reversed).find((r) => r.param === 'angular_input_ratio').value, -3);
});

test('every table row names a field in its actual Robot Manager form group', () => {
  const controls = read('../../../controls.py');
  const formStart = controls.indexOf('GROUPS = {');
  const form = controls.slice(formStart, controls.indexOf('\n}\n', formStart) + 2);
  const groups = new Map(
    [...form.matchAll(/^    '([^']+)':\s*\(([^]*?)(?=^    '[^']+':|^})/gm)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  const rows = robotManagerRows(defaults);
  for (const row of rows) {
    const group = groups.get(row.node);
    assert(group, row.node);
    const fields = [...group.matchAll(/\('([a-z_]+)',/g)].map((m) => m[1]);
    assert(fields.includes(row.param), `${row.node}.${row.param}`);
  }
  const launcher = rows.filter((r) => r.node === 'joy_launcher');
  assert.deepEqual(
    launcher.map((r) => [r.param, r.value]),
    [
      ['full_speed_button', 7],
      ['fire_button', 5],
      ['tilt_up_axis', 7],
      ['tilt_up_axis_sign', 1],
      ['tilt_down_axis', 7],
      ['tilt_down_axis_sign', -1],
    ],
  );
});

test('the visual size follows the URDF box and disc centres start at the front edge', () => {
  const urdf = read('../../../../../description_launch/urdf/questix.xacro');
  const side = Number(urdf.match(/name="side" value="([\d.]+)"/)[1]);
  assert.equal(SIM.robotSize, side);
  assert.equal(SIM.robotSize * 150, 75);
  const disc = { x: 2, y: 1.2, heading: 0, flown: 0 };
  assert.deepEqual(discPosition(disc), { x: 2.25, y: 1.2 });
  const left = discPosition({ ...disc, heading: Math.PI / 2 });
  close(left.x, 2);
  close(left.y, 1.45);
  assert.equal(discPosition({ ...disc, flown: 0.5 }).x, 2.75);
});

// No Image/global browser is installed: the shared artwork must not require a decoded image.
globalThis.document ??= {
  createComment: () => ({}),
  createTreeWalker: () => ({}),
  createElement: () => ({}),
  importNode: () => ({}),
  addEventListener() {},
};
const { keymapPage } = await import('../js/keymap/view.js');
function flatten(x) {
  if (x == null || typeof x === 'symbol') return '';
  if (Array.isArray(x)) return x.map(flatten).join('');
  if (x.strings) return x.strings.reduce((s, t, i) => s + t + flatten(x.values[i]), '');
  return typeof x === 'function' ? '' : String(x);
}
test('existing top artwork, front cue and fallback outline render in Node without an image', () => {
  const input = robotOrientedInput(raw([0, 0, 0, 0]));
  const model = {
    topic: 'direction',
    command: commandFromInput(input, defaults),
    input,
    rawInput: raw([0, 0, 0, 0]),
    strongest: { axis: -1, button: -1 },
    gamepad: null,
    gamepadSupported: false,
    secure: true,
    source: 'virtual',
    drift: null,
    mapping: defaults,
    problems: [],
    refused: [],
    robot: newRobot(),
    trail: [],
    found: {},
    findNotice: '',
    copyNotice: '',
  };
  const zero = flatten(keymapPage(model, copy, {}));
  assert(zero.includes('data-questix-view="top"'));
  assert(zero.includes('assets/questix/top.webp'));
  assert(zero.includes('keymap-footprint'));
  assert.match(zero, /width=75\s+height=75/);
  assert(!zero.includes('keymap-robot-body'));
  assert(!zero.includes('keymap-robot-nose'));
  assert(zero.includes('translate(300 180) rotate(0)'));
  const left = flatten(
    keymapPage({ ...model, robot: { ...model.robot, heading: Math.PI / 2 } }, copy, {}),
  );
  assert(left.includes('translate(300 180) rotate(-90)'));
  assert(left.includes('上から見たロボットの模型'));
});
