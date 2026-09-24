import { render } from '../vendor/lit-html.js';
import { loadJson, loadText } from '../core/content.js';
import { downloadFile } from '../core/dom.js';
import {
  ARM_TOPICS,
  ARM_GOALS,
  ARM_OBSTACLE,
  SO101_JOINTS,
  armFK,
  armIK,
  armClearance,
  armTrajectory,
  so101FK,
  armParseJointState,
} from './core.js';
import { armScenePoint, drawArm, drawSO101 } from './render.js';
import { armPage, formatValue } from './view.js';
import { revealElement } from '../core/reveal.js';
import { fillSentence as fill } from '../core/content.js';

// Arm course: state and behaviour. view.js turns the model into markup, render.js draws the scene,
// core.js does the kinematics. Texts live in content/arm.json and content/arm/*.html.

const copy = await loadJson('content/arm.json');
const fragments = {
  formula: await loadText('content/arm/forward-formula.html'),
  urdfNotes: await loadText('content/arm/urdf-notes.html'),
  jointStateIntro: await loadText('content/arm/joint-state-intro.html'),
  procedure: await loadText('content/arm/ros-procedure.html'),
  procedureRun: await loadText('content/arm/ros-procedure-run.html'),
};
const recorderScript = await loadText('content/arm/record_arm_joint_state.py');

const START_ANGLES = [20, 65]; // degrees: shoulder, elbow
const CHALLENGE_START_ANGLES = [80, -20]; // degrees
const DEFAULT_TARGET = { x: 215, z: 105 }; // mm from the shoulder centre
const WAYPOINT_TARGET = { x: 110, z: 240 }; // mm: high point to travel over the post
const GOAL_TOLERANCE = 10; // mm: how close the tip must stop to count as arrived
// The target fields are <input type="number"> with no step, so the browser accepts whole
// millimetres within these bounds; the same rule decides here whether a typed value is usable.
const TARGET_BOUNDS = { x: { min: -350, max: 400 }, z: { min: -100, max: 320 } };
const NUMBER_PATTERN = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const PICK_BOUNDS = { minX: -220, maxX: 400, minZ: -100, maxZ: 300 }; // mm: clickable part of the scene
const MAX_JOINT_FILE_BYTES = 262144; // 256 KB: one JointState message, not a recorded log
const EXAMPLE_JOINT_POSITIONS = [0.2, -0.3, 0.4, -0.2, 0.1]; // radians
const SLIDER_DIGITS = 0; // a slider shows whole degrees…
const READING_DIGITS = 1; // …a pose read from JSON or from the zero button, one decimal
const INVERSE_TOPICS = ['inverse', 'reach', 'challenge'];
const AXES = ['x', 'y', 'z'];
const POSE_LABELS = ['A', 'B'];

const pointText = (point) => ({ x: String(point.x), z: String(point.z) });

// One experiment per topic, kept while the learner moves between topics.
function newExperiment(id) {
  const challenge = id === 'challenge';
  const target = challenge ? { ...ARM_GOALS[0] } : { ...DEFAULT_TARGET };
  return {
    angles: challenge ? [...CHALLENGE_START_ANGLES] : [...START_ANGLES], // where the arm stands now
    desired: [...START_ANGLES], // where the sliders point
    target,
    targetText: pointText(target), // what the number fields contain, valid or not
    solution: null, // last armIK() result
    selected: 0,
    limited: false,
    trace: [], // tip positions of the current motion, drawn as a light trail
    records: [], // challenge: one row per finished motion
    goal: 0,
    hits: [], // goals already reached without touching the post
    waypoint: false, // the current target is a waypoint, not the goal
    notice: '',
    tried: false, // a motion of this topic has finished: its reflection answer opens
  };
}

const experiments = new Map(ARM_TOPICS.map((topic) => [topic.id, newExperiment(topic.id)]));
let topicId = 'joints';

// One motion at a time, whichever topic it belongs to.
const playback = { run: null, index: 0, playing: false, frame: 0, startTime: 0, offset: 0 };

// SO-ARM101 pose, kept while the learner moves between topics.
const hardware = {
  angles: SO101_JOINTS.map(() => 0), // degrees
  sourceKey: 'slider',
  jointInput: '',
  error: '',
  measurements: [],
};
// Per-joint decimals of the slider read-out, and the record confirmation: both belong to the page
// as it is built, so a rebuilt page starts at whole degrees with no confirmation, as before.
let jointDigits = SO101_JOINTS.map(() => SLIDER_DIGITS);
let measureStatus = '';

const page = () => document.getElementById('armPage');
const experiment = () => experiments.get(topicId);
const isInverse = () => INVERSE_TOPICS.includes(topicId);
const topicPosition = () => ARM_TOPICS.findIndex((topic) => topic.id === topicId);
const lastIndex = (run) => run.samples.length - 1;
const sourceText = () => copy.hardware.sources[hardware.sourceKey];

// What a target field accepts, mirroring the browser's own check on the same <input type="number">
// (a valid floating-point number, whole millimetres because the field has no step, within bounds).
function fieldValid(axis, text) {
  if (!NUMBER_PATTERN.test(text.trim())) return false;
  const value = Number(text);
  if (!Number.isInteger(value)) return false;
  return value >= TARGET_BOUNDS[axis].min && value <= TARGET_BOUNDS[axis].max;
}

const targetTyped = (current) =>
  fieldValid('x', current.targetText.x) && fieldValid('z', current.targetText.z);

// The reachable poses, with the note the learner needs to choose between them.
function buildCandidates(current) {
  if (!current.solution) return null;
  return current.solution.solutions.map((candidate) => ({
    q: candidate.q,
    allowed: candidate.allowed,
    endsOnObstacle: topicId === 'challenge' && armClearance(candidate.q) <= 0,
  }));
}

function buildModel() {
  const current = experiment();
  const run = playback.run;
  const candidates = buildCandidates(current);
  return {
    topic: topicId,
    position: topicPosition(),
    inverse: isInverse(),
    playing: playback.playing,
    motion: run
      ? { time: run.samples[playback.index].t, atEnd: playback.index === lastIndex(run) }
      : null,
    angles: current.angles,
    desired: current.desired,
    pose: armFK(current.angles),
    status: current.notice || copy.status.initial,
    targetText: current.targetText,
    targetBounds: TARGET_BOUNDS,
    limited: current.limited,
    candidates,
    selected: current.selected,
    solvePrimary: !current.solution || current.solution.reason !== 'ok',
    hasAllowedSolution: Boolean(candidates?.some((candidate) => candidate.allowed)),
    canMove: Boolean(candidates?.[current.selected]?.allowed),
    goal: current.goal,
    hits: current.hits,
    records: current.records,
    tried: current.tried,
    hardware: {
      angles: hardware.angles,
      digits: jointDigits,
      tip: so101FK(hardware.angles).tip,
      source: sourceText(),
      jointInput: hardware.jointInput,
      error: hardware.error,
      measurements: hardware.measurements,
      measureStatus,
    },
  };
}

// Thin outlines of where the arm may stop: the sliders' pose, or every pose the inverse
// kinematics found, named A/B so both can be compared at once (A6).
function ghostPoses(current) {
  if (!isInverse()) return [{ q: current.desired }];
  const solutions = current.solution?.solutions ?? [];
  return solutions.map((candidate, index) => ({
    q: candidate.q,
    label: solutions.length > 1 ? POSE_LABELS[index] : '',
    selected: index === current.selected,
  }));
}

function drawScene() {
  const canvas = document.getElementById('armScene');
  if (!canvas) return;
  if (topicId === 'hardware') {
    drawSO101(canvas, hardware.angles);
    return;
  }
  const current = experiment();
  const challenge = topicId === 'challenge';
  drawArm(canvas, {
    q: current.angles,
    target: ['joints', 'forward'].includes(topicId) ? null : current.target,
    ghosts: ghostPoses(current),
    trace: current.trace,
    reach: topicId === 'reach',
    obstacle: challenge,
    contact: challenge && armClearance(current.angles) <= 0,
    projections: topicId === 'forward',
    angles: !isInverse(),
  });
}

function update() {
  render(armPage(buildModel(), copy, fragments, actions), page());
  drawScene();
}

// A topic page is rebuilt from scratch so details, focus and scroll start fresh, as learners
// expect when they open another experiment.
function rebuildPage() {
  pause();
  playback.run = null;
  jointDigits = SO101_JOINTS.map(() => SLIDER_DIGITS);
  measureStatus = '';
  render(null, page());
  update();
}

function openTopic(id) {
  pause();
  if (playback.run && playback.index < lastIndex(playback.run))
    experiment().notice = copy.status.leftMidway;
  topicId = id;
  rebuildPage();
  page().scrollIntoView({ block: 'start', behavior: 'instant' });
}

function setStatus(message) {
  experiment().notice = message;
}

function pause() {
  const wasPlaying = playback.playing;
  playback.playing = false;
  cancelAnimationFrame(playback.frame);
  if (wasPlaying) setStatus(copy.status.paused);
}

function clearMotion() {
  pause();
  playback.run = null;
  playback.index = 0;
}

function startMotion(to) {
  pause();
  revealElement(document.getElementById('armScene'));
  const current = experiment();
  playback.run = armTrajectory(current.angles, to, topicId === 'challenge' ? ARM_OBSTACLE : null);
  playback.index = 0;
  current.trace = [];
  setStatus(copy.status.moving);
  play();
}

function play() {
  const run = playback.run;
  if (!run) return;
  setStatus(copy.status.moving);
  if (playback.index === lastIndex(run)) {
    playback.index = 0;
    experiment().trace = [];
  }
  playback.offset = run.samples[playback.index].t;
  playback.startTime = performance.now();
  playback.playing = true;
  tick();
}

function tick() {
  if (!playback.playing) return;
  const run = playback.run;
  const current = experiment();
  const time = playback.offset + (performance.now() - playback.startTime) / 1000; // seconds
  while (playback.index < lastIndex(run) && run.samples[playback.index + 1].t <= time) {
    playback.index++;
    current.trace.push(run.samples[playback.index].tip);
  }
  current.angles = [...run.samples[playback.index].q];
  if (playback.index === lastIndex(run)) {
    pause();
    finish();
  } else playback.frame = requestAnimationFrame(tick);
  update();
}

function finish() {
  const current = experiment();
  current.tried = true;
  const pose = armFK(current.angles);
  const error = Math.hypot(pose.tip.x - current.target.x, pose.tip.z - current.target.z); // mm
  if (topicId === 'challenge') {
    finishChallenge(current, error);
    return;
  }
  if (isInverse()) {
    const advice =
      current.solution?.solutions.length > 1
        ? copy.status.compareOtherPose
        : copy.status.changeTarget;
    setStatus(fill(copy.status.finishedInverse, { error: formatValue(error) }) + advice);
    return;
  }
  setStatus(
    fill(copy.status.finishedAngles, {
      shoulder: formatValue(current.angles[0], 0),
      elbow: formatValue(current.angles[1], 0),
      x: formatValue(pose.tip.x),
      z: formatValue(pose.tip.z),
    }),
  );
}

function challengeStatus(run, current, reached, error) {
  if (run.collision) return copy.status.collision;
  if (current.waypoint) return copy.status.waypointReached;
  if (reached) return copy.status.goalReached;
  return fill(copy.status.goalMissed, { error: formatValue(error) });
}

function finishChallenge(current, error) {
  const run = playback.run;
  const reached = !run.collision && !current.waypoint && error <= GOAL_TOLERANCE;
  if (reached && !current.hits.includes(current.goal)) current.hits.push(current.goal);
  setStatus(challengeStatus(run, current, reached, error));
  if (run.recorded) return;
  current.records.push({
    goal: current.goal + 1,
    error,
    collision: run.collision,
    clearance: run.minClearance,
    waypoint: current.waypoint,
  });
  run.recorded = true; // replaying the same motion must not record it twice
}

function solveStatus(solution) {
  if (solution.reason !== 'ok') return copy.status.solved[solution.reason];
  return solution.singular ? copy.status.solved.singular : copy.status.solved.ok;
}

function solve() {
  clearMotion();
  const current = experiment();
  // The challenge sets its own goals, so only typed targets can be out of range.
  if (topicId !== 'challenge' && !targetTyped(current)) {
    current.solution = null;
    setStatus(copy.status.targetInvalid);
    update();
    return;
  }
  current.solution = armIK(current.target, topicId === 'challenge' || current.limited);
  current.selected = Math.max(
    0,
    current.solution.solutions.findIndex((candidate) => candidate.allowed),
  );
  setStatus(solveStatus(current.solution));
  update();
}

function setTarget(point, waypoint = false) {
  clearMotion();
  const current = experiment();
  current.target = { ...point };
  current.targetText = pointText(point);
  current.waypoint = waypoint;
  current.solution = null;
  setStatus(copy.status.targetChanged);
  update();
}

function setJointAngles(angles, sourceKey, digits) {
  hardware.angles = angles;
  hardware.sourceKey = sourceKey;
  jointDigits = SO101_JOINTS.map(() => digits);
}

function readJointState(text) {
  hardware.angles = armParseJointState(text); // throws before anything is kept
  hardware.jointInput = text;
  hardware.sourceKey = JSON.parse(text).source === 'simulated' ? 'simulated' : 'loaded';
  jointDigits = SO101_JOINTS.map(() => READING_DIGITS);
}

function measurementRecord(measured) {
  const expected = so101FK(hardware.angles).tip;
  return {
    q: [...hardware.angles],
    source: sourceText(),
    measured,
    expected,
    error: Math.hypot(...AXES.map((axis) => measured[axis] - expected[axis])), // mm
  };
}

function comparisonCsv() {
  const head = [
    'source',
    ...SO101_JOINTS.map((joint) => joint.name + '_deg'),
    'expected_x_mm',
    'expected_y_mm',
    'expected_z_mm',
    'measured_x_mm',
    'measured_y_mm',
    'measured_z_mm',
    'error_mm',
  ];
  const rows = hardware.measurements.map((record) =>
    [
      record.source,
      ...record.q,
      ...Object.values(record.expected),
      ...Object.values(record.measured),
      record.error,
    ].join(','),
  );
  return [head.join(','), ...rows].join('\n');
}

const actions = {
  openTopic,
  solve,
  previous() {
    openTopic(ARM_TOPICS[topicPosition() - 1].id);
  },
  next() {
    const position = topicPosition();
    if (position < ARM_TOPICS.length - 1) {
      openTopic(ARM_TOPICS[position + 1].id);
      return;
    }
    document.dispatchEvent(new CustomEvent('quiz-open', { detail: 'arm' }));
  },
  togglePlay() {
    if (playback.playing) {
      pause();
      update();
      return;
    }
    play();
  },
  setDesiredAngle(index, degrees) {
    clearMotion();
    const current = experiment();
    current.desired = current.desired.map((value, i) => (i === index ? degrees : value));
    update();
  },
  usePreset(angles) {
    clearMotion();
    experiment().desired = [...angles];
    update();
  },
  run() {
    startMotion(experiment().desired);
  },
  move() {
    const current = experiment();
    const chosen = current.solution?.solutions[current.selected];
    if (chosen?.allowed) startMotion(chosen.q);
  },
  selectPose(index) {
    clearMotion();
    experiment().selected = index;
    update();
  },
  editTarget(axis, text) {
    const current = experiment();
    current.targetText = { ...current.targetText, [axis]: text };
    if (targetTyped(current)) {
      setTarget({ x: Number(current.targetText.x), z: Number(current.targetText.z) });
      return;
    }
    current.solution = null;
    setStatus(copy.status.inputInvalid);
    update();
  },
  useTargetPreset(point) {
    setTarget(point);
  },
  pickTarget(event) {
    if (playback.playing) return;
    const point = armScenePoint(event.currentTarget, event);
    const inside =
      point.x >= PICK_BOUNDS.minX &&
      point.x <= PICK_BOUNDS.maxX &&
      point.z >= PICK_BOUNDS.minZ &&
      point.z <= PICK_BOUNDS.maxZ;
    if (inside) setTarget(point);
  },
  setLimited(limited) {
    const current = experiment();
    current.limited = limited;
    current.solution = null;
    setStatus(copy.status.limitsChanged);
    update();
  },
  nextGoal() {
    const current = experiment();
    if (current.goal >= ARM_GOALS.length - 1 || !current.hits.includes(current.goal)) return;
    current.goal++;
    current.target = { ...ARM_GOALS[current.goal] };
    current.targetText = pointText(current.target);
    current.solution = null;
    current.waypoint = false;
    rebuildPage();
  },
  useWaypoint() {
    setTarget(WAYPOINT_TARGET, true);
  },
  backToGoal() {
    setTarget(ARM_GOALS[experiment().goal]);
  },
  resetPose() {
    clearMotion();
    const current = experiment();
    current.angles = [...CHALLENGE_START_ANGLES];
    current.trace = [];
    setStatus(copy.status.reset);
    update();
  },
  setJointAngle(index, degrees) {
    hardware.angles = hardware.angles.map((value, i) => (i === index ? degrees : value));
    hardware.sourceKey = 'slider';
    jointDigits = jointDigits.map((digits, i) => (i === index ? SLIDER_DIGITS : digits));
    update();
  },
  showZeroPose() {
    setJointAngles(
      SO101_JOINTS.map(() => 0),
      'zero',
      READING_DIGITS,
    );
    update();
  },
  editJointInput(text) {
    hardware.jointInput = text;
  },
  fillJointExample() {
    hardware.jointInput = JSON.stringify(
      {
        source: 'simulated',
        name: SO101_JOINTS.map((joint) => joint.name),
        position: EXAMPLE_JOINT_POSITIONS,
      },
      null,
      2,
    );
    update();
  },
  readJointInput() {
    try {
      readJointState(hardware.jointInput);
      hardware.error = copy.hardware.loaded;
    } catch (error) {
      hardware.error = error.message;
    }
    update();
  },
  async openJointFile(event) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > MAX_JOINT_FILE_BYTES) throw new Error(copy.hardware.fileTooLarge);
      readJointState(await file.text());
      hardware.error = copy.hardware.fileLoaded;
    } catch (error) {
      hardware.error = error.message;
    }
    update();
    input.value = ''; // so the same file can be opened again
  },
  recordMeasurement(event) {
    event.preventDefault();
    const fields = AXES.map((axis) => event.target.elements['armMeasured' + axis]);
    const usable = fields.every(
      (field) => field.value.trim() && field.checkValidity() && Number.isFinite(+field.value),
    );
    if (!usable) return;
    const measured = Object.fromEntries(AXES.map((axis, i) => [axis, +fields[i].value]));
    const record = measurementRecord(measured);
    hardware.measurements.push(record);
    measureStatus = fill(copy.hardware.recorded, { error: formatValue(record.error) });
    update();
  },
  saveCsv() {
    downloadFile('questix-arm-comparison.csv', comparisonCsv(), 'text/csv;charset=utf-8');
  },
  saveRecorderScript() {
    downloadFile('record_arm_joint_state.py', recorderScript);
  },
};

function pauseAndShow() {
  if (!playback.playing) return;
  pause();
  update();
}

function initArm() {
  update();
  document.addEventListener('series-leave', pauseAndShow);
  document.addEventListener('supplement-open', pauseAndShow);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseAndShow();
  });
  window.addEventListener('resize', () => {
    if (!page().hidden) drawScene();
  });
}

function activateArm() {
  drawScene();
}

function reviewArm(id) {
  if (!ARM_TOPICS.some((topic) => topic.id === id)) return false;
  openTopic(id);
  return true;
}

export { initArm, activateArm, reviewArm };
