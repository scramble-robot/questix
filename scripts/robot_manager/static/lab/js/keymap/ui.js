import { render } from '../vendor/lit-html.js';
import { loadJson } from '../core/content.js';
import { reportLessonProgress } from '../shell/lesson-progress.js';
import {
  KEYMAP_TOPICS,
  STANDARD_AXES,
  STANDARD_BUTTONS,
  commandFromInput,
  mappingProblems,
  refusedByRobotManager,
  newRobot,
  stepRobot,
  readGamepad,
  strongestInput,
  robotManagerRows,
  KEYMAP_SCALES,
  KEYMAP_DEADZONE,
} from './core.js';
import { keymapPage, fixed } from './view.js';

// Controller key-mapping course: state and behaviour. view.js turns the model into markup,
// core.js holds the rules the robot's nodes follow. Texts live in content/keymap.json.
//
// Input comes from a controller plugged into this computer (the browser's Gamepad API) or from
// the on-screen controller. Nothing here talks to the robot: the learner's mapping reaches the
// robot only when the teacher enters it in Robot Manager (the 実機に反映する topic says how).

const copy = await loadJson('content/keymap.json');

// A mapping the robot would accept, in the browser's standard layout: left stick up/down drives,
// right stick left/right turns (both negative: the browser reports up and left as −1), R2 turns
// the roller, R1 fires, the d-pad raises and lowers the launcher.
const BASE_MAPPING = {
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
// Each experiment starts from the problem it is about.
const TOPIC_MAPPINGS = {
  read: BASE_MAPPING,
  assign: { ...BASE_MAPPING, fire: 7 }, // roller and fire on one button
  direction: { ...BASE_MAPPING, forwardScale: 0.5, turnScale: 2.0 }, // reversed for this input
  deadzone: { ...BASE_MAPPING, deadzone: 0 },
  apply: BASE_MAPPING,
};
// Where the on-screen sticks come to rest in the dead-zone experiment (a worn stick).
const DRIFT = { left: [0.03, -0.08], right: [0.06, 0.0] };
const KEY_TILT = 1; // an arrow key tilts the on-screen stick all the way
const MAX_DT = 0.05; // s: a longer frame (tab in the background) is not simulated in one step
const TRAIL_POINTS = 160;

const mappings = new Map(KEYMAP_TOPICS.map((topic) => [topic.id, { ...TOPIC_MAPPINGS[topic.id] }]));
let topicId = 'read';
let lastEdited = null; // the topic whose mapping the learner changed last (carried into 実機に反映する)

const virtual = {
  axes: Array(STANDARD_AXES).fill(0),
  buttons: Array(STANDARD_BUTTONS).fill(false),
  held: new Set(), // sticks being dragged or tilted with keys
  keys: { left: new Set(), right: new Set() },
};
let source = 'virtual';
let gamepadIndex = null;
let robot = newRobot();
let trail = [];
const found = {}; // 入力を番号で読む: { r1, bottom, up, axis: { axis, value } }
let findNotice = '';
let copyNotice = '';
let frame = 0;
let lastTime = 0;

const page = () => document.getElementById('keymapPage');
const mapping = () => mappings.get(topicId);
const gamepadSupported = () =>
  typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';

function drift() {
  return topicId === 'deadzone' ? DRIFT : null;
}

// The rest position of an on-screen stick: the centre, or the worn stick's offset.
function restAxes(stickId) {
  const offset = drift()?.[stickId] || [0, 0];
  return offset;
}

function settleSticks() {
  for (const [stickId, [ax, ay]] of [
    ['left', [0, 1]],
    ['right', [2, 3]],
  ]) {
    if (virtual.held.has(stickId)) continue;
    const [rx, ry] = restAxes(stickId);
    virtual.axes[ax] = rx;
    virtual.axes[ay] = ry;
  }
}

function connectedPad() {
  if (!gamepadSupported()) return null;
  let pads = [];
  try {
    pads = Array.from(navigator.getGamepads() || []);
  } catch {
    return null; // blocked (insecure context or a permissions policy)
  }
  const pad =
    (gamepadIndex !== null && pads[gamepadIndex]) || pads.find((item) => item && item.connected);
  if (pad) gamepadIndex = pad.index;
  return readGamepad(pad);
}

function currentInput(pad) {
  if (source === 'gamepad' && pad) return { axes: pad.axes, buttons: pad.buttons };
  return { axes: [...virtual.axes], buttons: [...virtual.buttons] };
}

function buildModel() {
  const pad = connectedPad();
  if (!pad && source === 'gamepad') source = 'virtual';
  const input = currentInput(pad);
  const current = mapping();
  const sizes = { axes: input.axes.length, buttons: input.buttons.length };
  const problems = mappingProblems(current, sizes);
  return {
    topic: topicId,
    input,
    strongest: strongestInput(input),
    gamepad: pad,
    gamepadSupported: gamepadSupported(),
    secure: typeof window === 'undefined' || window.isSecureContext !== false,
    source,
    drift: drift()?.left || null,
    mapping: current,
    problems,
    refused: refusedByRobotManager(problems),
    command: commandFromInput(input, current),
    robot,
    trail,
    found,
    findNotice,
    copyNotice,
  };
}

function update() {
  if (!page()) return;
  render(keymapPage(buildModel(), copy, actions), page());
}

// --- The frame loop: read the controller, move the model, redraw ---------------------------------

function tick(time) {
  frame = 0;
  if (!page() || page().hidden || document.hidden) return;
  const dt = lastTime ? Math.min(MAX_DT, (time - lastTime) / 1000) : 0;
  lastTime = time;
  settleSticks();
  const model = buildModel();
  robot = stepRobot(robot, model.command, dt);
  if (dt > 0) {
    const last = trail[trail.length - 1];
    if (!last || Math.hypot(last[0] - robot.x, last[1] - robot.y) > 0.02) {
      // A wrap-around at the field edge starts a new line.
      trail = last && Math.hypot(last[0] - robot.x, last[1] - robot.y) > 1 ? [] : trail;
      trail = [...trail, [robot.x, robot.y]].slice(-TRAIL_POINTS);
    }
  }
  update();
  frame = requestAnimationFrame(tick);
}

function start() {
  if (frame || !page() || page().hidden) return;
  lastTime = 0;
  frame = requestAnimationFrame(tick);
}

function pause() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  virtual.buttons.fill(false);
  virtual.held.clear();
  virtual.keys.left.clear();
  virtual.keys.right.clear();
  settleSticks();
}

// --- On-screen controller ------------------------------------------------------------------------

function stickFromPointer(event, stick) {
  const svgElement = event.currentTarget.ownerSVGElement;
  const point = svgElement.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const local = point.matrixTransform(svgElement.getScreenCTM().inverse());
  const reach = 26; // px, the same as view.js STICK_RADIUS
  let dx = (local.x - stick.x) / reach;
  let dy = (local.y - stick.y) / reach;
  const length = Math.hypot(dx, dy);
  if (length > 1) {
    dx /= length;
    dy /= length;
  }
  const [ax, ay] = stick.axes;
  virtual.axes[ax] = dx;
  virtual.axes[ay] = dy;
}

function keyStickAxes(stick) {
  const keys = virtual.keys[stick.id];
  const [rx, ry] = restAxes(stick.id);
  let x = rx;
  let y = ry;
  if (keys.has('ArrowLeft')) x = -KEY_TILT;
  if (keys.has('ArrowRight')) x = KEY_TILT;
  if (keys.has('ArrowUp')) y = -KEY_TILT;
  if (keys.has('ArrowDown')) y = KEY_TILT;
  const [ax, ay] = stick.axes;
  virtual.axes[ax] = x;
  virtual.axes[ay] = y;
}

const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

const actions = {
  openTopic,
  pressButton(event, index) {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    virtual.buttons[index] = true;
    start();
  },
  releaseButton(event, index) {
    if (!virtual.buttons[index]) return;
    virtual.buttons[index] = false;
  },
  keyButton(event, index, down) {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    virtual.buttons[index] = down;
    start();
  },
  grabStick(event, stick) {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    virtual.held.add(stick.id);
    stickFromPointer(event, stick);
    start();
  },
  moveStick(event, stick) {
    if (!virtual.held.has(stick.id) || virtual.keys[stick.id].size) return;
    stickFromPointer(event, stick);
  },
  dropStick(event, stick) {
    virtual.held.delete(stick.id);
    virtual.keys[stick.id].clear();
    settleSticks();
  },
  keyStick(event, stick, down) {
    if (!ARROWS.has(event.key)) return;
    event.preventDefault();
    const keys = virtual.keys[stick.id];
    if (down) keys.add(event.key);
    else keys.delete(event.key);
    if (keys.size) virtual.held.add(stick.id);
    else virtual.held.delete(stick.id);
    keyStickAxes(stick);
    start();
  },
  toggleSource() {
    source = source === 'gamepad' ? 'virtual' : 'gamepad';
    update();
  },
  setIndex(id, value) {
    mapping()[id] = value;
    lastEdited = topicId;
    update();
  },
  setNumber(id, text) {
    const limits = KEYMAP_SCALES[id] || KEYMAP_DEADZONE;
    const value = Number(text);
    // An out-of-range number is kept as typed, so the check below the fields can explain it.
    if (text === '' || !Number.isFinite(value)) return update();
    mapping()[id] = limits === KEYMAP_DEADZONE ? Math.round(value * 100) / 100 : value;
    lastEdited = topicId;
    update();
  },
  resetMapping() {
    mappings.set(topicId, { ...TOPIC_MAPPINGS[topicId] });
    update();
  },
  resetRobot() {
    robot = newRobot();
    trail = [];
    update();
  },
  recordButton(targetId) {
    const { button } = strongestInput(buildModel().input);
    if (button < 0) findNotice = copy.find.noPress;
    else {
      found[targetId] = button;
      findNotice = '';
    }
    update();
  },
  recordAxis() {
    const { axis, axisValue } = strongestInput(buildModel().input);
    if (axis < 0) findNotice = copy.find.noAxis;
    else {
      found.axis = { axis, value: axisValue };
      findNotice = '';
    }
    update();
  },
  async copyTable() {
    const rows = robotManagerRows(mapping());
    const header = copy.apply.columns.join('\t');
    const body = rows
      .map((row) =>
        [row.node, row.param, Number.isInteger(row.value) ? row.value : fixed(row.value)].join(
          '\t',
        ),
      )
      .join('\n');
    try {
      await navigator.clipboard.writeText(`${header}\n${body}\n`);
      copyNotice = copy.apply.copied;
    } catch {
      copyNotice = copy.apply.copyFailed;
    }
    update();
  },
};

// A topic page is rebuilt from scratch so details, focus and scroll start fresh.
function openTopic(id) {
  if (!KEYMAP_TOPICS.some((topic) => topic.id === id)) return;
  pause();
  // 実機に反映する summarises the mapping the learner worked on last.
  if (id === 'apply' && lastEdited && lastEdited !== 'apply')
    mappings.set('apply', { ...mappings.get(lastEdited) });
  topicId = id;
  robot = newRobot();
  trail = [];
  findNotice = '';
  copyNotice = '';
  render(null, page());
  update();
  reportLessonProgress('keymap', {
    topics: KEYMAP_TOPICS.map((topic) => ({ id: topic.id, title: topic.label })),
    current: topicId,
    open: openTopic,
  });
  start();
}

function initKeymap() {
  settleSticks();
  update();
  window.addEventListener('gamepadconnected', () => {
    // The first press of a controller announces it: use it straight away.
    source = 'gamepad';
    update();
    start();
  });
  window.addEventListener('gamepaddisconnected', () => {
    gamepadIndex = null;
    update();
  });
  document.addEventListener('series-leave', pause);
  document.addEventListener('supplement-open', pause);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
    else start();
  });
}

function activateKeymap() {
  reportLessonProgress('keymap', {
    topics: KEYMAP_TOPICS.map((topic) => ({ id: topic.id, title: topic.label })),
    current: topicId,
    open: openTopic,
  });
  update();
  start();
}

function reviewKeymap(id) {
  if (!KEYMAP_TOPICS.some((topic) => topic.id === id)) return false;
  openTopic(id);
  return true;
}

export { initKeymap, activateKeymap, reviewKeymap };
