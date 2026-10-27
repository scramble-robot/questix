import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  KEYMAP_SCALES,
  KEYMAP_DEFAULT_MAPPING,
  SIM,
  mappingProblems,
  refusedByRobotManager,
  robotManagerRows,
  newRobot,
  stepRobot,
} from '../js/keymap/core.js';
import { degreesText, angularParts, tableText } from '../js/keymap/format.js';
import { fillSentence as fill } from '../js/core/content.js';

const copy = JSON.parse(fs.readFileSync(new URL('../content/keymap.json', import.meta.url)));
const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const controls = read('../../../controls.py');
// Scope to joy_controller: the standalone dual-stick group has different, unrelated ratios.
const group = controls.match(/'joy_controller': \([^]*?\n    \]\),/)[0];
const managerBounds = (key) => {
  const row = group.match(
    new RegExp("\\('" + key + "', [^\\n]*'float', (-?[\\d.]+), (-?[\\d.]+)\\)"),
  );
  assert(row, key);
  return row.slice(1).map(Number);
};
const profiles = ['dualshock', 'uart', 'web'].map((name) => ({
  name,
  text: read(`../../../../../questix_control_config/config/controls.${name}.yaml`),
}));
function nodeValue(text, node, key) {
  const block = text.match(new RegExp('^' + node + ':\\n([^]*?)(?=^[^\\s#]|$(?![^]))', 'm'))?.[1];
  assert(block, node);
  const value = block.match(new RegExp('^\\s+' + key + ':\\s*(-?[\\d.]+)', 'm'));
  assert(value, `${node}.${key}`);
  return Number(value[1]);
}
const mapping = {
  forward: 1,
  turn: 2,
  roller: 7,
  fire: 5,
  tiltUp: 12,
  tiltDown: 13,
  forwardScale: -0.5,
  turnScale: -2,
  deadzone: 0.1,
};
const close = (actual, expected) =>
  assert(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const command = (linear, angular) => ({
  drive: { linear, angular },
  roller: false,
  fire: false,
  tiltUp: false,
  tiltDown: false,
});

test('lesson speed bounds match the actual Robot Manager joy_controller fields', () => {
  for (const scale of Object.values(KEYMAP_SCALES))
    assert.deepEqual([scale.min, scale.max], managerBounds(scale.param));
  assert.equal(SIM.maxSpeed, managerBounds('longitudinal_input_ratio')[1]);
  assert.equal(SIM.maxTurn, managerBounds('angular_input_ratio')[1]);
});

test('acceleration and the stated default speed match every distributed controls profile', () => {
  for (const { name, text } of profiles) {
    assert.equal(SIM.accel, nodeValue(text, 'drive_component', 'max_linear_accel'), name);
    assert.equal(SIM.turnAccel, nodeValue(text, 'drive_component', 'max_angular_accel'), name);
    assert.equal(
      KEYMAP_DEFAULT_MAPPING.forwardScale,
      nodeValue(text, 'joy_controller', 'longitudinal_input_ratio'),
      name,
    );
    assert.equal(
      KEYMAP_DEFAULT_MAPPING.turnScale,
      nodeValue(text, 'joy_controller', 'angular_input_ratio'),
      name,
    );
    assert(copy.topics.direction.brief.first[0].includes('1.0 m/s'));
    assert(copy.topics.direction.brief.first[0].includes('3.0 rad/s'));
    const geometry = read('../../../../../launcher/config/drive_component.yaml');
    const radius = nodeValue(geometry, 'drive_component', 'wheel_radius');
    const separation = nodeValue(geometry, 'drive_component', 'wheel_separation');
    const wheelSpeed =
      ((nodeValue(text, 'drive_component', 'max_motor_rpm') * 2 * Math.PI) / 60) * radius;
    assert(SIM.maxSpeed < wheelSpeed, name);
    assert(SIM.maxTurn < (2 * wheelSpeed) / separation, name);
  }
});

test('out-of-range speeds are reported, kept in the table, and never silently clamped', () => {
  for (const [id, scale] of Object.entries(KEYMAP_SCALES)) {
    for (const value of [scale.min, 0, scale.max])
      assert.equal(refusedByRobotManager(mappingProblems({ ...mapping, [id]: value })).length, 0);
    for (const value of [scale.min - 0.1, scale.max + 0.1, NaN, Infinity]) {
      const candidate = { ...mapping, [id]: value };
      assert(
        refusedByRobotManager(mappingProblems(candidate)).some(
          (p) => p.code === 'range' && p.ids.includes(id),
        ),
      );
      assert.equal(robotManagerRows(candidate).find((r) => r.param === scale.param).value, value);
    }
  }
  const candidate = { ...mapping, forwardScale: 2.1, turnScale: -6.1 };
  const text = tableText(robotManagerRows(candidate), copy);
  assert(text.includes('longitudinal_input_ratio\t2.10'));
  assert(text.includes('angular_input_ratio\t旋回 -6.10 rad/s（約 -350°/s）'));
  assert.equal(text.split('\n').filter(Boolean).length, robotManagerRows(candidate).length + 1);
});

test('degree annotation uses the unrounded rad value and the 10 degree boundary', () => {
  const rad = (d) => (d * Math.PI) / 180;
  assert.equal(degreesText(0), '0.0');
  assert.equal(degreesText(-0), '0.0');
  assert.equal(degreesText(-1e-8), '0.0');
  assert.equal(degreesText(rad(9.94)), '9.9');
  assert.equal(degreesText(rad(10 - 1e-7)), '10.0');
  assert.equal(degreesText(rad(10)), '10');
  assert.equal(degreesText(rad(10 + 1e-7)), '10');
  assert.equal(degreesText(rad(-9.94)), '-9.9');
  assert.equal(degreesText(rad(-10)), '-10');
  assert.equal(degreesText(-6), '-344');
  assert.equal(degreesText(6), '344');
  const parts = angularParts(rad(10));
  assert.equal(parts.value, '0.17');
  assert.equal(parts.degrees, '10', 'do not convert the already rounded 0.17 rad/s');
  const text = tableText(robotManagerRows({ ...mapping, turnScale: rad(10) }), copy);
  assert(text.includes('旋回 0.17 rad/s（約 10°/s）'));
  assert.equal(fill(copy.sim.angular, angularParts(-0.1, true)), '旋回 -0.10 rad/s（約 -5.7°/s）');
});

test('the local model reaches the full offered speeds and uses the same ramp when stopping', () => {
  let state = newRobot();
  for (let i = 0; i < 400; i++) {
    const next = stepRobot(state, command(2, 6), 0.02);
    assert(Math.abs(next.speed - state.speed) <= SIM.accel * 0.02 + 1e-12);
    assert(Math.abs(next.turnRate - state.turnRate) <= SIM.turnAccel * 0.02 + 1e-12);
    assert(next.x >= 0 && next.x < SIM.field.width && next.y >= 0 && next.y < SIM.field.height);
    state = next;
  }
  close(state.speed, 2);
  close(state.turnRate, 6);
  const speedStart = state.speed,
    turnStart = state.turnRate;
  state = stepRobot(state, command(0, 0), 0.02);
  close(state.speed, speedStart - SIM.accel * 0.02);
  close(state.turnRate, turnStart - SIM.turnAccel * 0.02);
  for (let i = 0; i < 210; i++) state = stepRobot(state, command(0, 0), 0.02);
  close(state.speed, 0);
  close(state.turnRate, 0);
  close(SIM.field.width, 4);
  close(SIM.field.height, 2.4);
});
