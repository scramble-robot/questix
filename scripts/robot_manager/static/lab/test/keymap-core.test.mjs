// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// The key-mapping course follows the robot's nodes (joy_controller, esc_motor_control,
// shot_component) and Robot Manager's 調整 tab; these tests pin those rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  KEYMAP_FUNCTIONS,
  KEYMAP_TOPICS,
  STANDARD_AXES,
  STANDARD_BUTTONS,
  applyDeadzone,
  commandFromInput,
  mappingProblems,
  refusedByRobotManager,
  newRobot,
  stepRobot,
  readGamepad,
  strongestInput,
  robotManagerRows,
} from '../js/keymap/core.js';

const MAPPING = {
  forward: 1,
  turn: 2,
  roller: 7,
  fire: 5,
  tiltUp: 12,
  tiltDown: 13,
  forwardScale: -0.5,
  turnScale: -2.0,
  deadzone: 0.1,
};
const idle = () => ({
  axes: Array(STANDARD_AXES).fill(0),
  buttons: Array(STANDARD_BUTTONS).fill(false),
});
const codes = (problems) => problems.map((problem) => problem.code).sort();

test('the dead zone zeroes small inputs and stretches the rest back to the full range', () => {
  assert.equal(applyDeadzone(0.08, 0.1), 0);
  assert.equal(applyDeadzone(-0.1, 0.1), 0);
  assert.ok(Math.abs(applyDeadzone(0.55, 0.1) - 0.5) < 1e-12);
  assert.equal(applyDeadzone(1, 0.1), 1);
  assert.equal(applyDeadzone(-1, 0.5), -1);
  assert.equal(applyDeadzone(0.3, 0), 0.3);
  assert.equal(applyDeadzone(2, 0), 1, 'a value beyond ±1 is a full tilt');
  assert.equal(applyDeadzone(Number.NaN, 0.1), 0);
});

test('drive follows joy_controller: axis value × ratio, with the sign of the ratio', () => {
  const input = idle();
  input.axes[1] = -1; // browser: stick up
  input.axes[2] = -1; // browser: stick left
  const { drive } = commandFromInput(input, MAPPING);
  assert.equal(drive.linear, 0.5, 'up with a negative ratio drives forwards');
  assert.equal(drive.angular, 2, 'left with a negative ratio turns left (counter-clockwise)');
  const reversed = commandFromInput(input, { ...MAPPING, forwardScale: 0.5, turnScale: 2 });
  assert.equal(reversed.drive.linear, -0.5);
  assert.equal(reversed.drive.angular, -2);
});

test('an assigned axis the controller lacks means no drive command at all', () => {
  const input = { axes: [0, 0], buttons: Array(STANDARD_BUTTONS).fill(false) };
  assert.equal(commandFromInput(input, MAPPING).drive, null);
  const problems = mappingProblems(MAPPING, { axes: 2, buttons: STANDARD_BUTTONS });
  assert.deepEqual(problems, [{ code: 'missing', ids: ['turn'] }]);
});

test('buttons: roller while held, fire and tilt as assigned; one button can do two jobs', () => {
  const input = idle();
  input.buttons[7] = true;
  const command = commandFromInput(input, { ...MAPPING, fire: 7 });
  assert.equal(command.roller, true);
  assert.equal(command.fire, true, 'the shared button fires as it starts the roller');
  assert.equal(commandFromInput(input, MAPPING).fire, false);
});

test('a sensible mapping has no problems; each kind of mistake is reported', () => {
  assert.deepEqual(mappingProblems(MAPPING), []);
  assert.deepEqual(codes(mappingProblems({ ...MAPPING, fire: 7 })), ['shared']);
  assert.deepEqual(mappingProblems({ ...MAPPING, fire: 7 })[0].ids, ['roller', 'fire']);
  assert.deepEqual(codes(mappingProblems({ ...MAPPING, turn: 1 })), ['shared']);
  assert.deepEqual(codes(mappingProblems({ ...MAPPING, tiltDown: 12 })), ['tilt_same']);
  assert.deepEqual(codes(mappingProblems({ ...MAPPING, fire: 64 })), ['range']);
  assert.deepEqual(codes(mappingProblems({ ...MAPPING, fire: 40 })), ['missing']);
  assert.deepEqual(codes(mappingProblems({ ...MAPPING, forwardScale: 12 })), ['range']);
  assert.deepEqual(codes(mappingProblems({ ...MAPPING, deadzone: 1 })), ['range']);
  assert.deepEqual(codes(mappingProblems({ ...MAPPING, turnScale: 0 })), ['zero_scale']);
});

test('Robot Manager refuses only what its own check refuses', () => {
  // controls.py: numbers 0..63, ratios within the form's range, different raise / lower inputs.
  assert.deepEqual(codes(refusedByRobotManager(mappingProblems({ ...MAPPING, tiltDown: 12 }))), [
    'tilt_same',
  ]);
  assert.deepEqual(refusedByRobotManager(mappingProblems({ ...MAPPING, fire: 7 })), []);
  assert.deepEqual(codes(refusedByRobotManager(mappingProblems({ ...MAPPING, fire: -1 }))), [
    'range',
  ]);
});

test('the model accelerates towards the command and fires on the press only', () => {
  let robot = newRobot();
  const input = idle();
  input.axes[1] = -1;
  for (let i = 0; i < 20; i += 1) robot = stepRobot(robot, commandFromInput(input, MAPPING), 0.02);
  assert.ok(robot.speed > 0 && robot.speed <= 0.5, `speed ${robot.speed}`);
  assert.ok(robot.x > newRobot().x, 'it moved forwards (+x at heading 0)');
  const fire = idle();
  fire.buttons[5] = true;
  robot = stepRobot(robot, commandFromInput(fire, MAPPING), 0.02);
  robot = stepRobot(robot, commandFromInput(fire, MAPPING), 0.02); // still held: no second shot
  assert.equal(robot.shots, 1);
  assert.equal(robot.weakShots, 1, 'the roller was not turning');
  const roller = idle();
  roller.buttons[7] = true;
  for (let i = 0; i < 50; i += 1) robot = stepRobot(robot, commandFromInput(roller, MAPPING), 0.02);
  const both = idle();
  both.buttons[5] = true;
  both.buttons[7] = true;
  robot = stepRobot(robot, commandFromInput(both, MAPPING), 0.02);
  assert.equal(robot.shots, 2);
  assert.equal(robot.weakShots, 1, 'after the roller has spun up the disc flies');
});

test('one button for roller and fire fires before the roller has spun up', () => {
  let robot = newRobot();
  const shared = { ...MAPPING, fire: 7 };
  const press = idle();
  press.buttons[7] = true;
  for (let i = 0; i < 60; i += 1) robot = stepRobot(robot, commandFromInput(press, shared), 0.02);
  assert.equal(robot.shots, 1, 'holding it fires once');
  assert.equal(robot.weakShots, 1, 'at the press the roller had only just started');
  assert.equal(robot.roller, true);
});

test('tilt buttons move the launcher angle within its limits while held', () => {
  let robot = newRobot();
  const up = idle();
  up.buttons[12] = true;
  for (let i = 0; i < 200; i += 1) robot = stepRobot(robot, commandFromInput(up, MAPPING), 0.02);
  assert.equal(robot.tilt, 45);
  const down = idle();
  down.buttons[13] = true;
  for (let i = 0; i < 200; i += 1) robot = stepRobot(robot, commandFromInput(down, MAPPING), 0.02);
  assert.equal(robot.tilt, 0);
});

test('a browser gamepad is read like the robot reads buttons (pressed or at least half way)', () => {
  const pad = {
    connected: true,
    id: 'Test pad',
    mapping: 'standard',
    axes: [0.2, -1.2, 0, Number.NaN],
    buttons: [
      { pressed: false, value: 0 },
      { pressed: true, value: 1 },
      { pressed: false, value: 0.6 },
    ],
  };
  const input = readGamepad(pad);
  assert.deepEqual(input.axes, [0.2, -1, 0, 0]);
  assert.deepEqual(input.buttons, [false, true, true]);
  assert.equal(readGamepad(null), null);
  assert.equal(readGamepad({ ...pad, connected: false }), null);
  assert.deepEqual(strongestInput(input), { button: 1, axis: 1, axisValue: -1 });
  assert.deepEqual(strongestInput(idle()), { button: -1, axis: -1, axisValue: 0 });
});

test('the Robot Manager table names every parameter the 調整 tab edits', () => {
  const rows = robotManagerRows(MAPPING);
  assert.deepEqual(
    rows.map((row) => row.param),
    [
      'linear_x_axis',
      'angular_z_axis',
      'longitudinal_input_ratio',
      'angular_input_ratio',
      'full_speed_button',
      'fire_button',
      'tilt_up_button_index',
      'tilt_down_button_index',
      'deadzone',
    ],
  );
  // Every parameter exists in Robot Manager's form (scripts/robot_manager/controls.py).
  const controls = fs.readFileSync(new URL('../../../controls.py', import.meta.url), 'utf8');
  for (const row of rows) assert.ok(controls.includes(`('${row.param}'`), row.param);
  for (const fn of KEYMAP_FUNCTIONS) assert.ok(controls.includes(`'${fn.node}'`), fn.node);
});

test('every topic has its texts', () => {
  const copy = JSON.parse(
    fs.readFileSync(new URL('../content/keymap.json', import.meta.url), 'utf8'),
  );
  for (const topic of KEYMAP_TOPICS) {
    const text = copy.topics[topic.id];
    assert.ok(text, topic.id);
    for (const key of ['scene', 'purpose', 'first'])
      assert.ok(text.brief[key], `${topic.id}.${key}`);
    for (const key of ['question', 'answer', 'hint'])
      assert.ok(text.reflection[key], `${topic.id}.${key}`);
  }
  for (const fn of KEYMAP_FUNCTIONS) assert.ok(copy.functions[fn.id], fn.id);
  for (const code of ['range', 'missing', 'tilt_same', 'shared', 'zero_scale', 'none'])
    assert.ok(copy.problems[code], code);
});
