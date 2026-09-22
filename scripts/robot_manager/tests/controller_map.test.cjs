const test = require('node:test');
const assert = require('node:assert/strict');
const map = require('../static/controller-map.js');

test('Switch and DualShock face buttons map to the correct physical positions', () => {
  assert.equal(map.location('uart', 'fire_button', 0), 'face-right');
  assert.equal(map.location('uart', 'fire_button', 1), 'face-bottom');
  assert.equal(map.location('dualshock', 'fire_button', 0), 'face-bottom');
  assert.equal(map.location('dualshock', 'fire_button', 1), 'face-right');
  assert.equal(map.location('uart', 'fire_button', 13), 'right-stick');
  assert.equal(map.location('dualshock', 'fire_button', 13), null);
});

test('axis and button namespaces are kept separate and unmapped indices stay off the drawing', () => {
  assert.equal(map.location('uart', 'tilt_axis', 7), 'dpad');
  assert.equal(map.location('uart', 'fire_button', 7), 'right-trigger');
  assert.equal(map.location('uart', 'tilt_axis', 2), null);
  assert.equal(map.location('dualshock', 'tilt_axis', 2), 'left-trigger');
  assert.equal(map.location('dualshock', 'fire_button', 63), null);
  assert.equal(map.location('uart', 'tilt_axis', -1), null);
});

test('tilt mode only shows effective assignments and preserves unknown mappings', () => {
  const saved = { shot_component: { fire_button: 5, tilt_axis: 7,
    tilt_up_button_index: 4, tilt_down_button_index: 6 } };
  const draft = structuredClone(saved);
  assert.deepEqual(map.bindings('uart', draft, saved).map((item) => item.key),
    ['fire_button', 'tilt_axis']);
  draft.shot_component.tilt_axis = -1;
  draft.shot_component.fire_button = 63;
  const assignments = map.bindings('uart', draft, saved);
  assert.deepEqual(assignments.map((item) => item.key),
    ['fire_button', 'tilt_up_button_index', 'tilt_down_button_index']);
  assert.equal(assignments[0].spot, null);
  assert.equal(assignments[0].changed, true);
  assert.equal(assignments[0].target, 'control-shot_component-fire_button');
  assert.equal(assignments[1].spot, 'left-shoulder');
  assert.equal(assignments[2].spot, 'left-trigger');
});

test('editable inputs respect controller-specific button and axis layouts', () => {
  assert.deepEqual(map.inputs('uart', 'left-stick').map((item) => item.id),
    ['axis:0', 'axis:1', 'button:12']);
  assert.deepEqual(map.inputs('dualshock', 'left-stick').map((item) => item.id),
    ['axis:0', 'axis:1', 'button:11']);
  assert.deepEqual(map.inputs('dualshock', 'left-trigger').map((item) => item.id),
    ['axis:2', 'button:6']);
  assert.deepEqual(map.inputs('uart', 'left-trigger').map((item) => item.id), ['button:6']);
  assert.deepEqual(map.inputs('dualshock', 'face-bottom').map((item) => item.id), ['button:0']);
});

test('assignment plans reject incompatible inputs and preserve the source values', () => {
  const values = { shot_component: { fire_button: 5, tilt_axis: 7,
    tilt_up_button_index: 4, tilt_down_button_index: 6 } };
  const original = structuredClone(values);
  assert.throws(() => map.planAssignment('uart', values, 'left-stick', 'axis:0', 'shot_component.fire_button'));
  assert.throws(() => map.planAssignment('uart', values, 'face-right', 'button:7', 'shot_component.fire_button'));
  assert.deepEqual(map.planAssignment('dualshock', values, 'face-bottom', 'button:0', 'shot_component.fire_button'),
    [{ node: 'shot_component', key: 'fire_button', value: 0 }]);
  assert.deepEqual(map.planAssignment('uart', values, 'face-right', 'button:0', 'shot_component.tilt_up_button_index'),
    [{ node: 'shot_component', key: 'tilt_up_button_index', value: 0 },
      { node: 'shot_component', key: 'tilt_axis', value: -1 }]);
  assert.deepEqual(values, original);
});

test('function numbers remain stable across remapping and tilt modes', () => {
  const values = { joy_controller: { linear_x_axis: 1, angular_z_axis: 3, linear_y_axis: 0 },
    shot_component: { fire_button: 5, tilt_axis: 7, tilt_up_button_index: 4, tilt_down_button_index: 6 },
    esc_motor_control: { full_speed_button: 7 } };
  const numbers = () => Object.fromEntries(map.bindings('uart', values, values).map((item) => [item.key, item.number]));
  assert.deepEqual(numbers(), { linear_x_axis: 1, angular_z_axis: 2, linear_y_axis: 6,
    fire_button: 3, full_speed_button: 4, tilt_axis: 5 });
  values.shot_component.fire_button = 0;
  values.shot_component.tilt_axis = -1;
  assert.equal(numbers().fire_button, 3);
  assert.equal(numbers().tilt_up_button_index, 5);
  assert.equal(numbers().tilt_down_button_index, 5);
  assert.deepEqual(map.destinations('uart', 'tilt_axis').map((item) => item.value), [0, 1, 3, 4, 6, 7]);
});

test('tilt plans update both buttons atomically and reject invalid or duplicate indices', () => {
  assert.deepEqual(map.planTiltAssignment({ mode: 'buttons', up: 2, down: 1 }), [
    { node: 'shot_component', key: 'tilt_axis', value: -1 },
    { node: 'shot_component', key: 'tilt_up_button_index', value: 2 },
    { node: 'shot_component', key: 'tilt_down_button_index', value: 1 },
  ]);
  assert.deepEqual(map.planTiltAssignment({ mode: 'axis', axis: 7 }),
    [{ node: 'shot_component', key: 'tilt_axis', value: 7 }]);
  for (const invalid of [
    { mode: 'buttons', up: 2, down: 2 }, { mode: 'buttons', up: -1, down: 0 },
    { mode: 'buttons', up: 64, down: 1 }, { mode: 'buttons', up: 2.5, down: 1 },
    { mode: 'axis', axis: -1 }, { mode: 'axis', axis: null }, { mode: 'invalid', axis: 7 },
  ]) assert.throws(() => map.planTiltAssignment(invalid));
});
