// Controller key-mapping course: the numbers a controller sends and what the robot does with them.
// No DOM: the same functions run in the browser and in the Node tests (test/keymap-core.test.mjs).
//
// The rules follow the robot's own nodes, so what learners see here is what the robot does:
// - joy_controller: linear.x = axes[linear_x_axis] × longitudinal_input_ratio, angular.z =
//   axes[angular_z_axis] × angular_input_ratio; an axis number the message does not have means no
//   drive command at all (joy_controller skips the twist).
// - joy_launcher: full_speed_button controls the roller, fire_button acts on the press, and
//   the tilt buttons select the angle while held. The nodes read its /launcher_command.
// - Robot Manager's 調整 tab (scripts/robot_manager/controls.py) checks the same number ranges and
//   refuses the same raise / lower button.
// The dead zone is the input driver's setting (joy_node / uart_joy_driver `deadzone`).

// What can be assigned, in the order of Robot Manager's form. `param` is the ROS parameter the
// teacher sets on the robot.
const KEYMAP_FUNCTIONS = [
  { id: 'forward', kind: 'axis', node: 'joy_controller', param: 'linear_x_axis' },
  { id: 'turn', kind: 'axis', node: 'joy_controller', param: 'angular_z_axis' },
  { id: 'roller', kind: 'button', node: 'joy_launcher', param: 'full_speed_button' },
  { id: 'fire', kind: 'button', node: 'joy_launcher', param: 'fire_button' },
  { id: 'tiltUp', kind: 'button', node: 'joy_launcher', param: 'tilt_up_button_index' },
  { id: 'tiltDown', kind: 'button', node: 'joy_launcher', param: 'tilt_down_button_index' },
];
// Speeds for a full tilt of the stick; a negative value reverses the direction.
// Bounds repeat scripts/robot_manager/controls.py GROUPS['joy_controller'];
// test/keymap-tuning.test.mjs reads that source to keep them in step.
const KEYMAP_SCALES = {
  forwardScale: {
    node: 'joy_controller',
    param: 'longitudinal_input_ratio',
    min: -2.0,
    max: 2.0,
    unit: 'm/s',
  },
  turnScale: {
    node: 'joy_controller',
    param: 'angular_input_ratio',
    min: -6.0,
    max: 6.0,
    unit: 'rad/s',
  },
};
const KEYMAP_DEADZONE = { node: 'joy_node', param: 'deadzone', min: 0, max: 0.99 };
const INDEX_RANGE = { min: 0, max: 63 }; // Robot Manager accepts button and axis numbers 0..63

const KEYMAP_TOPICS = [
  { id: 'read', label: '入力を番号で読む' },
  { id: 'assign', label: '働きを割り当てる' },
  { id: 'direction', label: '向きと速さを合わせる' },
  { id: 'deadzone', label: '触れていない入力' },
  { id: 'apply', label: '実機に反映する' },
];

// The browser's "standard" gamepad layout (W3C Gamepad, standard mapping): the numbers a
// controller has in this page. The robot's joy_node numbers the same controller its own way.
const STANDARD_BUTTONS = 17;
const STANDARD_AXES = 4;

// W3C standard axes 0/2: horizontal, right positive; axes 1/3: vertical, down positive.
// The lesson uses joy_node's direction convention: left/up positive for BOTH sticks.
// Apply this once at the raw-input boundary, never again in commands or the exported table.
// Extra axes keep their sign: their numbering/orientation needs checking on the actual device.
const ROBOT_AXIS_SIGNS = [-1, -1, -1, -1]; // left x/y, right x/y
function robotOrientedInput(input) {
  return {
    ...input,
    axes: (input.axes || []).map((raw, index) => {
      const value =
        typeof raw === 'number' && Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      return value === 0 ? 0 : value * (ROBOT_AXIS_SIGNS[index] ?? 1);
    }),
  };
}

// Speed defaults repeat the distributed controls.*.yaml joy_controller values; contract-tested.
// Button numbers remain this lesson's browser layout, not the robot driver's input numbers.
const KEYMAP_DEFAULT_MAPPING = {
  forward: 1,
  turn: 2,
  roller: 7,
  fire: 5,
  tiltUp: 12,
  tiltDown: 13,
  forwardScale: 1.0,
  turnScale: 3.0,
  deadzone: 0.1,
};

// Every stage starts with the correct drive direction and separate roller/fire buttons.
// Only the dead-zone experiment starts with its deliberately unfiltered drift input.
const KEYMAP_TOPIC_MAPPINGS = Object.fromEntries(
  KEYMAP_TOPICS.map(({ id }) => [
    id,
    {
      ...KEYMAP_DEFAULT_MAPPING,
      ...(id === 'deadzone' ? { deadzone: 0 } : {}),
    },
  ]),
);

// The simulated robot and launcher (a model for the lesson, not measured dynamics).
// accel / turnAccel: questix_control_config/config/controls.*.yaml, drive_component defaults.
// maxSpeed / maxTurn: controls.py's joy_controller saving bounds above, not wheel saturation.
// This model uses a constant rate of change only; real drive_component also tapers near a stop
// and scales both wheels together at saturation (#248). Shared DEFAULT_PHYSICS is independent.
const SIM = {
  maxSpeed: 2.0, // m/s
  maxTurn: 6.0, // rad/s
  accel: 1.5, // m/s² towards the command
  turnAccel: 1.5, // rad/s²
  robotSize: 0.5, // m: description_launch/urdf/questix.xacro collision box; visual footprint only
  tiltRate: 30, // degrees per second while a tilt button is held
  spinUp: 0.8, // s the roller needs after it starts before a disc flies
  tiltMin: 0,
  tiltMax: 45,
  field: { width: 4, height: 2.4 }, // m; the robot wraps around at the edges
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Dead zone as the input driver applies it: a value within `deadzone` of the centre becomes 0,
 * a larger one is stretched back to the full range so a full tilt still reads ±1.
 */
function applyDeadzone(value, deadzone) {
  if (!finite(value)) return 0;
  const zone = clamp(finite(deadzone) ? deadzone : 0, 0, 0.99);
  const magnitude = Math.min(1, Math.abs(value));
  if (magnitude <= zone) return 0;
  return (Math.sign(value) * (magnitude - zone)) / (1 - zone);
}

/**
 * What the robot's nodes would do with robot-oriented `{ axes: number[], buttons: boolean[] }`.
 * Browser input must pass robotOrientedInput once before this function; table values stay signed.
 * `drive` is null when an assigned axis is not in the input: joy_controller then sends nothing.
 */
function commandFromInput(input, mapping) {
  const axes = input.axes || [];
  const buttons = input.buttons || [];
  const axis = (index) =>
    Number.isInteger(index) && index >= 0 && index < axes.length
      ? applyDeadzone(axes[index], mapping.deadzone)
      : null;
  const button = (index) =>
    Number.isInteger(index) && index >= 0 && index < buttons.length && Boolean(buttons[index]);
  const forward = axis(mapping.forward);
  const turn = axis(mapping.turn);
  const drive =
    forward === null || turn === null
      ? null
      : { linear: forward * mapping.forwardScale, angular: turn * mapping.turnScale };
  return {
    drive,
    roller: button(mapping.roller),
    fire: button(mapping.fire),
    tiltUp: button(mapping.tiltUp),
    tiltDown: button(mapping.tiltDown),
  };
}

/**
 * Problems a mapping has, most serious first: [{ code, ids }] with the function ids involved.
 * `sizes` { axes, buttons } are the numbers the controller in use has.
 */
function mappingProblems(mapping, sizes = { axes: STANDARD_AXES, buttons: STANDARD_BUTTONS }) {
  const problems = [];
  for (const fn of KEYMAP_FUNCTIONS) {
    const value = mapping[fn.id];
    if (!Number.isInteger(value) || value < INDEX_RANGE.min || value > INDEX_RANGE.max) {
      problems.push({ code: 'range', ids: [fn.id] });
    } else if (value >= (fn.kind === 'axis' ? sizes.axes : sizes.buttons)) {
      problems.push({ code: 'missing', ids: [fn.id] });
    }
  }
  for (const [id, scale] of Object.entries(KEYMAP_SCALES)) {
    const value = mapping[id];
    if (!finite(value) || value < scale.min || value > scale.max)
      problems.push({ code: 'range', ids: [id] });
  }
  if (
    !finite(mapping.deadzone) ||
    mapping.deadzone < KEYMAP_DEADZONE.min ||
    mapping.deadzone > KEYMAP_DEADZONE.max
  )
    problems.push({ code: 'range', ids: ['deadzone'] });
  // Robot Manager refuses the same input for raising and lowering the launcher.
  if (mapping.tiltUp === mapping.tiltDown)
    problems.push({ code: 'tilt_same', ids: ['tiltUp', 'tiltDown'] });
  // One input, two jobs: pressing it does both at once.
  for (const kind of ['axis', 'button']) {
    const byIndex = new Map();
    for (const fn of KEYMAP_FUNCTIONS.filter((item) => item.kind === kind)) {
      const list = byIndex.get(mapping[fn.id]) || [];
      list.push(fn.id);
      byIndex.set(mapping[fn.id], list);
    }
    for (const ids of byIndex.values()) {
      if (ids.length < 2) continue;
      if (ids.length === 2 && ids.includes('tiltUp') && ids.includes('tiltDown')) continue; // reported above
      problems.push({ code: 'shared', ids });
    }
  }
  if (finite(mapping.forwardScale) && mapping.forwardScale === 0)
    problems.push({ code: 'zero_scale', ids: ['forwardScale'] });
  if (finite(mapping.turnScale) && mapping.turnScale === 0)
    problems.push({ code: 'zero_scale', ids: ['turnScale'] });
  return problems;
}

// Problems Robot Manager itself would refuse when the teacher saves (the others are advice).
const REFUSED = new Set(['range', 'tilt_same']);
const refusedByRobotManager = (problems) => problems.filter((problem) => REFUSED.has(problem.code));

/** A fresh simulated robot: in the middle of the field, facing right, roller stopped. */
function newRobot() {
  return {
    x: SIM.field.width / 2,
    y: SIM.field.height / 2,
    heading: 0, // rad, 0 = +x, counter-clockwise positive
    speed: 0,
    turnRate: 0,
    tilt: 20, // degrees
    roller: false,
    rollerTime: 0, // s the roller has been turning without a pause
    firePressed: false, // the fire button's state at the last step (fire acts on the press)
    discs: [], // [{ x, y, heading, distance, flown, weak }]
    shots: 0,
    weakShots: 0,
    travelled: 0, // m driven, summed
    lastCommand: null,
  };
}

const approach = (value, target, step) =>
  value < target ? Math.min(target, value + step) : Math.max(target, value - step);
const wrap = (value, size) => ((value % size) + size) % size;

/** Advances the model by `dt` seconds under `command` (commandFromInput). Returns a new state. */
function stepRobot(state, command, dt) {
  const next = { ...state, discs: state.discs.map((disc) => ({ ...disc })) };
  const drive = command.drive || { linear: 0, angular: 0 };
  const targetSpeed = clamp(drive.linear, -SIM.maxSpeed, SIM.maxSpeed);
  const targetTurn = clamp(drive.angular, -SIM.maxTurn, SIM.maxTurn);
  next.speed = approach(state.speed, targetSpeed, SIM.accel * dt);
  next.turnRate = approach(state.turnRate, targetTurn, SIM.turnAccel * dt);
  next.heading = state.heading + next.turnRate * dt;
  const distance = next.speed * dt;
  next.x = wrap(state.x + Math.cos(next.heading) * distance, SIM.field.width);
  next.y = wrap(state.y + Math.sin(next.heading) * distance, SIM.field.height);
  next.travelled = state.travelled + Math.abs(distance);
  next.roller = command.roller;
  next.rollerTime = command.roller ? state.rollerTime + dt : 0;
  if (command.tiltUp && !command.tiltDown)
    next.tilt = Math.min(SIM.tiltMax, state.tilt + SIM.tiltRate * dt);
  if (command.tiltDown && !command.tiltUp)
    next.tilt = Math.max(SIM.tiltMin, state.tilt - SIM.tiltRate * dt);
  if (command.fire && !state.firePressed) {
    // A disc pushed into a roller that is stopped or still starting barely leaves the launcher.
    const weak = next.rollerTime < SIM.spinUp;
    const reach = weak ? 0.15 : 0.8 + 0.02 * next.tilt; // m, a simple model of the flight
    next.discs.push({
      x: next.x,
      y: next.y,
      heading: next.heading,
      distance: reach,
      flown: 0,
      weak,
    });
    next.shots = state.shots + 1;
    next.weakShots = state.weakShots + (weak ? 1 : 0);
  }
  next.firePressed = command.fire;
  for (const disc of next.discs) disc.flown = Math.min(disc.distance, disc.flown + 3 * dt);
  next.discs = next.discs.slice(-6);
  next.lastCommand = command;
  return next;
}

/** World position of a disc: its centre starts at the robot's front edge. */
function discPosition(disc) {
  const ahead = SIM.robotSize / 2 + disc.flown;
  return { x: disc.x + Math.cos(disc.heading) * ahead, y: disc.y + Math.sin(disc.heading) * ahead };
}

/**
 * Reads the raw browser Gamepad (caller then applies robotOrientedInput once) into `{ axes, buttons }`; null for none.
 * A trigger counts as pressed like the robot's button messages (pressed flag, or value ≥ 0.5).
 */
function readGamepad(pad) {
  if (!pad || !pad.connected) return null;
  return {
    id: String(pad.id || ''),
    mapping: pad.mapping || '',
    axes: Array.from(pad.axes || [], (value) => (finite(value) ? clamp(value, -1, 1) : 0)),
    buttons: Array.from(pad.buttons || [], (item) =>
      typeof item === 'object' ? Boolean(item.pressed || item.value >= 0.5) : Boolean(item),
    ),
  };
}

/** The first pressed button and the axis moved furthest from the centre (at least `threshold`). */
function strongestInput(input, threshold = 0.5) {
  const button = (input.buttons || []).findIndex(Boolean);
  let axis = -1;
  let best = threshold;
  (input.axes || []).forEach((value, index) => {
    if (Math.abs(value) >= best) {
      best = Math.abs(value);
      axis = index;
    }
  });
  return { button, axis, axisValue: axis >= 0 ? input.axes[axis] : 0 };
}

/** Rows for Robot Manager's 調整 tab: [{ node, param, value }] in its form order. */
function robotManagerRows(mapping) {
  return [
    ...KEYMAP_FUNCTIONS.filter((fn) => fn.kind === 'axis').map((fn) => ({
      node: fn.node,
      param: fn.param,
      value: mapping[fn.id],
    })),
    ...Object.entries(KEYMAP_SCALES).map(([id, scale]) => ({
      node: scale.node,
      param: scale.param,
      value: mapping[id],
    })),
    // The lesson assigns tilt BUTTONS. Select button mode explicitly: the distributed
    // profiles may currently select a trigger axis, which would ignore these button numbers.
    { node: 'joy_launcher', param: 'tilt_up_axis', value: -1 },
    { node: 'joy_launcher', param: 'tilt_down_axis', value: -1 },
    ...KEYMAP_FUNCTIONS.filter((fn) => fn.kind === 'button').map((fn) => ({
      node: fn.node,
      param: fn.param,
      value: mapping[fn.id],
    })),
    { node: KEYMAP_DEADZONE.node, param: KEYMAP_DEADZONE.param, value: mapping.deadzone },
  ];
}

export {
  KEYMAP_FUNCTIONS,
  KEYMAP_DEFAULT_MAPPING,
  KEYMAP_TOPIC_MAPPINGS,
  ROBOT_AXIS_SIGNS,
  robotOrientedInput,
  discPosition,
  KEYMAP_SCALES,
  KEYMAP_DEADZONE,
  KEYMAP_TOPICS,
  INDEX_RANGE,
  STANDARD_BUTTONS,
  STANDARD_AXES,
  SIM,
  applyDeadzone,
  commandFromInput,
  mappingProblems,
  refusedByRobotManager,
  newRobot,
  stepRobot,
  readGamepad,
  strongestInput,
  robotManagerRows,
};
