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


const defaults = () => ({ shot_component: { fire_button: 5,
  tilt_up_axis: 7, tilt_down_axis: 7, tilt_up_axis_sign: 1, tilt_down_axis_sign: -1,
  tilt_up_button_index: 4, tilt_down_button_index: 6 } });

test('both tilt directions are always visible with their effective input and change state', () => {
  const saved = defaults(), draft = structuredClone(saved);
  let assignments = map.bindings('uart', draft, saved);
  assert.deepEqual(assignments.map((a) => a.inputId), ['button:5', 'direction:7:1', 'direction:7:-1']);
  assert.match(assignments[1].label, /十字キー 上（軸 7）/);
  assert.match(assignments[2].label, /十字キー 下（軸 7）/);
  draft.shot_component.tilt_up_axis = -1;
  draft.shot_component.tilt_up_button_index = 63;
  assignments = map.bindings('uart', draft, saved);
  assert.equal(assignments[1].spot, null);
  assert.equal(assignments[1].changed, true);
  assert.equal(assignments[2].changed, false);
  draft.shot_component.tilt_up_axis = 7;
  draft.shot_component.tilt_up_axis_sign = -1;
  assert.equal(map.bindings('uart', draft, saved)[1].changed, true);
});

test('diagram inputs distinguish full axes, individual directions and pressing', () => {
  assert.deepEqual(map.inputs('uart', 'left-stick').map((item) => item.id),
    ['axis:0', 'direction:0:1', 'direction:0:-1', 'axis:1', 'direction:1:1', 'direction:1:-1', 'button:12']);
  assert.equal(map.inputs('dualshock', 'left-stick').at(-1).id, 'button:11');
  assert.deepEqual(map.inputs('dualshock', 'left-trigger').map((item) => item.id), ['axis:2', 'button:6']);
  assert.deepEqual(map.actions(defaults(), 'direction').map((a) => a.key),
    ['tilt_up_button_index', 'tilt_down_button_index']);
  assert.equal(map.actions(defaults(), 'axis').length, 0);
});

test('direction edits preserve all opposite inputs and permit a mixed axis/button pair', () => {
  const values = defaults();
  const original = structuredClone(values);
  const apply = (changes) => changes.forEach(({node, key, value}) => { values[node][key] = value; });
  apply(map.planTiltDirection('uart', values, 'tilt_down_button_index', 'button:1'));
  assert.equal(values.shot_component.tilt_up_axis, 7);
  assert.equal(values.shot_component.tilt_up_axis_sign, 1);
  assert.equal(values.shot_component.tilt_up_button_index, 4);
  assert.equal(values.shot_component.tilt_down_axis, -1);
  assert.equal(values.shot_component.tilt_down_button_index, 1);
  apply(map.planAssignment('uart', values, 'dpad', 'direction:6:-1', 'shot_component.tilt_up_button_index'));
  assert.equal(values.shot_component.tilt_up_axis, 6);
  assert.equal(values.shot_component.tilt_up_axis_sign, -1);
  assert.equal(values.shot_component.tilt_down_button_index, 1);
  assert.throws(() => map.planTiltDirection('uart', values, 'tilt_up_button_index', 'button:1'));
  assert.throws(() => map.planTiltDirection('uart', original, 'tilt_up_button_index', 'direction:7:-1'));
  for (const invalid of ['button:-1', 'button:64', 'button:', 'direction:7:0', 'axis:7', 'direction:1.5:1']) {
    assert.throws(() => map.planTiltDirection('uart', values, 'tilt_up_button_index', invalid));
  }
  assert.throws(() => map.planAssignment('uart', values, 'dpad', 'direction:7:1', 'shot_component.fire_button'));
  assert.throws(() => map.planAssignment('uart', values, 'face-right', 'button:7', 'shot_component.fire_button'));
  assert.deepEqual(original, defaults());
});

test('function numbers stay stable when tilt changes inputs', () => {
  const values = defaults();
  const before = map.bindings('uart', values, values).map((a) => [a.key, a.number]);
  values.shot_component.tilt_up_axis = -1;
  assert.deepEqual(map.bindings('uart', values, values).map((a) => [a.key, a.number]), before);
  assert.deepEqual(before.map((a) => a[1]), [3, 5, 5]);
});
