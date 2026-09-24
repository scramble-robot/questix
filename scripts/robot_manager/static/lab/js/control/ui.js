import { render } from '../vendor/lit-html.js';
import { loadJson, loadText } from '../core/content.js';
import { downloadFile } from '../core/dom.js';
import {
  CONTROL_TOPICS,
  CONTROL_PERIOD,
  DURATION,
  LAST_SAMPLE,
  BLOCK_WINDOW,
  DRAG_START,
  START_DISTANCE,
  STOP_DISTANCE,
  controlDefaults,
  normalizeControlConfig,
  simulateControl,
  controlCSV,
  controlLoad,
  controlCalibration,
} from './core.js';
import { controlWheelAngle, drawControlStage, COMPARE_COLOURS } from './render.js';
import { controlPage, gainText, COMMAND_OPEN_TOPICS } from './view.js';
import { conceptState, advanceConcept, resetConcept } from './concepts.js';
import { liveControlRun, liveLink, onLiveLink, openRecordingFile } from '../live/capture.js';
import { liveDistanceRun, stepMetrics, firstHold, forwardRpm } from '../live/capture-core.js';
import { driveRows, wallRows } from '../live/recording-core.js';
import { createLiveSession } from '../live/live-session.js';
import { captureNotes } from '../live/live-view.js';
import { openRobotDialog } from '../live/live-ui.js';
import { fillSentence as fill } from '../core/content.js';
import {
  STEP_SPEEDS,
  STEP_HOLD,
  WALL_SECONDS,
  WALL_MAX_SPEED,
  WALL_START_MIN,
  WALL_MIN_GAP,
  speedStep,
  wallApproach,
} from './live-drive.js';

// Feedback-control course: state and behaviour. view.js turns the model into markup, render.js
// draws the robot and the charts, core.js simulates. Texts live in content/control/ui.json.

const copy = await loadJson('content/control/ui.json');
const hardwareHtml = await loadText('content/control/hardware.html');

const FIRST_TOPIC = 'output';
const CHART_MIN_WIDTH = 320; // px
const CHART_MAX_WIDTH = 740; // px
const CHART_GUTTER = 32; // px of the container the chart leaves to its own padding
// The result card is only scrolled to when it has left this comfortable band on screen.
const VISIBLE_BAND = { top: 80, bottom: 200 }; // px

// One experiment per topic, kept while the learner moves between topics and courses.
const experiments = new Map(
  CONTROL_TOPICS.map((topic) => [
    topic.id,
    {
      config: controlDefaults(topic.id),
      runs: [],
      result: null,
      previous: null, // the run drawn in grey behind this one
      index: 0, // sample currently shown
      observedMax: 0, // furthest sample watched; the scrubber stays within it
      complete: false,
      note: '',
    },
  ]),
);

let topicId = FIRST_TOPIC;
// Which of the three sources last wrote the line under the run button.
let statusMode = 'playback'; // 'playback' | 'changed' | 'saved'
let savedRun = null;
let compare = true;
let showIntegral = false;
let integralTitled = false; // the command chart keeps the "with I" title once it has been toggled
let commandOpen = COMMAND_OPEN_TOPICS.includes(FIRST_TOPIC);
let chartWidth = CHART_MAX_WIDTH;
let concept = conceptState(FIRST_TOPIC);
const playback = { playing: false, frame: 0, startTime: 0, startIndex: 0, speed: 1 };
const calibration = controlCalibration();
// One recording from the real robot per kind of topic: the speed topics share the wheels' step
// response, the distance topics the LiDAR's view of the wall. It is the same machine whichever
// experiment is on screen, so switching between topics of one kind keeps the recording.
const liveRuns = { speed: null, distance: null };

const page = () => document.getElementById('controlPage');
const experiment = () => experiments.get(topicId);
const topic = () => CONTROL_TOPICS.find((entry) => entry.id === topicId);
const isDistance = () => topic().mode === 'distance';

// The settings no longer match the run on screen, so the graphs are one experiment behind.
function isStale() {
  const current = experiment();
  if (!current.result) return false;
  return JSON.stringify(current.config) !== JSON.stringify(current.result.config);
}

function currentFrame() {
  const current = experiment();
  if (current.result) return current.result.samples[current.index];
  const resting = isDistance() ? START_DISTANCE : 0;
  return { time: 0, actual: resting, measured: resting, command: 0, rpm: 0 };
}

// --- status line --------------------------------------------------------------------------

function playbackStatus() {
  const current = experiment();
  if (isStale()) return copy.status.staleWhileStopped;
  if (!current.result) return copy.status.idle;
  if (current.complete) return playback.playing ? copy.status.replaying : copy.status.finished;
  return playback.playing ? copy.status.running : copy.status.paused;
}

function changedStatus() {
  if (isStale()) return copy.status.staleAfterChange;
  return experiment().result ? copy.status.currentSettings : copy.status.readyToRun;
}

function statusText() {
  if (statusMode === 'saved')
    return fill(copy.status.csvSaved, { settings: gainText(savedRun.config, topicId, copy) });
  if (statusMode === 'changed') return changedStatus();
  return playbackStatus();
}

// --- what the wheel is up against -----------------------------------------------------------

function blockedLoadText(time) {
  if (time === null) return copy.load.limitsIdle;
  if (time >= BLOCK_WINDOW.from && time < BLOCK_WINDOW.to) return copy.load.limitsBlocked;
  return time >= BLOCK_WINDOW.to ? copy.load.limitsReleased : copy.load.limitsBefore;
}

function dragLoadText(time) {
  if (time === null) return copy.load.dragIdle;
  return time >= DRAG_START ? copy.load.dragAfter : copy.load.dragBefore;
}

// `time` is null for the caption under the graphs, or a moment of the run for the robot figure.
function loadDescription(run, time = null) {
  const id = run?.id || topicId;
  const config = run?.config || experiment().config;
  if (id === 'limits') return blockedLoadText(time);
  if (isDistance()) return copy.load.distance;
  const load = controlLoad(id, config);
  if (load === 'nominal') return copy.load.nominal;
  if (load === 'mismatch') return copy.load.mismatch;
  return dragLoadText(time);
}

// --- rendering ------------------------------------------------------------------------------

function buildModel() {
  const current = experiment();
  return {
    topicId,
    topic: topic(),
    distance: isDistance(),
    withFeedforward: ['feedforward', 'combined', 'reference'].includes(topicId),
    config: current.config,
    result: current.result,
    previous: current.previous,
    comparison: compare ? current.previous : null,
    runs: current.runs,
    index: current.index,
    complete: current.complete,
    finishedRun: current.complete ? current.result : null,
    note: current.note,
    frame: currentFrame(),
    playing: playback.playing,
    speed: playback.speed,
    status: statusText(),
    loadNote: loadDescription(current.result),
    compare,
    showIntegral,
    integralTitled,
    commandOpen,
    chartWidth,
    calibration,
    concept,
    live: {
      run: liveRuns[liveKind()],
      note: liveSession().note,
      capture: liveSession().model(),
      stepSpeed: liveStepSpeed,
      stepSpeeds: stepSpeedOptions(),
      compared: comparedRuns[liveKind()].map((entry, index) => ({
        ...entry,
        colour: COMPARE_COLOURS[index],
      })),
      compareNote,
      table: comparisonRows(),
    },
  };
}

function drawStage() {
  const canvas = document.getElementById('controlRobot');
  if (!canvas) return;
  const current = experiment();
  const frame = currentFrame();
  drawControlStage(canvas, {
    distance: isDistance(),
    angle: current.result ? controlWheelAngle(current.result.samples, current.index) : 0,
    frame,
    started: Boolean(current.result),
    blocked: frame.blocked,
    description: loadDescription(current.result, frame.time),
  });
}

function update() {
  render(controlPage(buildModel(), copy, hardwareHtml, actions), page());
  drawStage();
}

// The charts are laid out for the width they are given, so the width is measured whenever they
// are rebuilt rather than on every frame of playback.
function measureChartWidth() {
  const container = document.getElementById('controlCharts');
  const available = (container?.clientWidth || CHART_MAX_WIDTH) - CHART_GUTTER;
  chartWidth = Math.max(CHART_MIN_WIDTH, Math.min(CHART_MAX_WIDTH, available));
}

// Rebuilding the charts also returns the "show I" switch and the open/closed command panel to
// the state they have when a topic is opened.
function resetChartView() {
  showIntegral = false;
  integralTitled = false;
  commandOpen = COMMAND_OPEN_TOPICS.includes(topicId);
}

function refreshCharts() {
  resetChartView();
  measureChartWidth();
}

// A topic page is built from scratch so details, focus, scroll and the worked example start
// fresh, as learners expect when they open another experiment.
function rebuild() {
  stop();
  render(null, page());
  compare = true;
  concept = conceptState(topicId);
  resetChartView();
  update();
  measureChartWidth();
  if (isStale()) changed();
  else update();
}

function selectTopic(id) {
  topicId = id;
  rebuild();
  page().scrollIntoView({ block: 'start', behavior: 'instant' });
}

// --- playback ---------------------------------------------------------------------------------

function stop() {
  playback.playing = false;
  cancelAnimationFrame(playback.frame);
  statusMode = 'playback';
}

function startPlayback() {
  const current = experiment();
  if (!current.result) return;
  if (current.index >= LAST_SAMPLE) current.index = 0;
  playback.startIndex = current.index;
  playback.startTime = performance.now();
  playback.playing = true;
  statusMode = 'playback';
  tick();
}

function tick() {
  if (!playback.playing) return;
  const current = experiment();
  const elapsed = (performance.now() - playback.startTime) / 1000;
  current.index = Math.min(
    LAST_SAMPLE,
    Math.floor((elapsed * playback.speed) / CONTROL_PERIOD) + playback.startIndex,
  );
  current.observedMax = Math.max(current.observedMax, current.index);
  if (current.index >= LAST_SAMPLE) {
    completeRun();
    stop();
  } else playback.frame = requestAnimationFrame(tick);
  update();
}

function completeRun() {
  const current = experiment();
  if (current.complete) return;
  current.complete = true;
  current.runs.push(current.result);
  refreshCharts();
}

function stopAndShow() {
  stop();
  update();
}

// --- experiments --------------------------------------------------------------------------

// The comparison line prefers the most recent run made under the same conditions, so that
// changing one gain compares like with like.
function previousRun(current) {
  const comparable = [...current.runs]
    .reverse()
    .find(
      (run) =>
        run.config.scenario === current.config.scenario &&
        run.config.loadCase === current.config.loadCase &&
        run.config.targetRPM === current.config.targetRPM,
    );
  return comparable || current.runs.at(-1) || null;
}

function startRun() {
  stop();
  const current = experiment();
  current.config = normalizeControlConfig(topicId, current.config);
  current.previous = previousRun(current);
  current.result = simulateControl(topicId, current.config);
  current.index = 0;
  current.observedMax = 0;
  current.complete = false;
  refreshCharts();
  update();
  keepFigureInView();
  startPlayback();
}

function keepFigureInView() {
  const figure = document.getElementById('controlVisual');
  const bounds = figure.getBoundingClientRect();
  if (bounds.top < VISIBLE_BAND.top || bounds.top > window.innerHeight - VISIBLE_BAND.bottom)
    figure.scrollIntoView({ block: 'start', behavior: 'instant' });
}

// A setting was changed: the graphs still show the previous run until it is repeated.
function changed() {
  stop();
  statusMode = 'changed';
  if (!experiment().result) refreshCharts();
  update();
}

function saveCsv(run) {
  downloadFile(`QUESTiX-LAB-control-${run.id}.csv`, controlCSV(run), 'text/csv;charset=utf-8');
  // The CSV contains simulation readings and the configuration used for this run.
  savedRun = run;
  statusMode = 'saved';
  update();
}

// --- the real robot next to the simulation ---------------------------------------------------

// The wheels: /target_twist against /drive_status, time counted from the first command.
// A recording as the run a chart draws, for either kind of topic: `{run, note}`, or `{note}` alone
// when the recording holds nothing that can be drawn.
function speedRun(recording) {
  const { rows, summary } = driveRows(recording);
  const run = liveControlRun(rows, DURATION);
  if (!run.samples.length) return { note: copy.live.noCommand };
  return { run, note: fill(copy.live.recorded, { notes: captureNotes(summary) }) };
}

// The wall: the LiDAR's distance straight ahead, time counted from the start of the approach.
function distanceRun(recording) {
  const run = liveDistanceRun(wallRows(recording), DURATION);
  if (!run.approached) return { note: copy.live.noApproach };
  const note = fill(copy.live.distanceRecorded, {
    closest: Math.min(...run.samples.map((sample) => sample.measured)).toFixed(2),
    final: run.samples[run.samples.length - 1].measured.toFixed(2),
  });
  return { run, note };
}

const RUN_OF = { speed: speedRun, distance: distanceRun };

function applyRecording(kind, recording) {
  const { run, note } = RUN_OF[kind](recording);
  if (!run) return { ok: false, note };
  liveRuns[kind] = run;
  return { ok: true, note };
}

// Other groups' recordings, drawn next to this one so a class can compare machines and drivers.
const MAX_COMPARED = 5;
const comparedRuns = { speed: [], distance: [] };
let compareNote = '';

async function addComparisons(files) {
  const kind = liveKind();
  const notes = [];
  for (const file of files) {
    if (comparedRuns[kind].length >= MAX_COMPARED) {
      notes.push(fill(copy.live.compareTooMany, { count: MAX_COMPARED }));
      break;
    }
    try {
      const { recording } = await openRecordingFile(file);
      const { run, note } = RUN_OF[kind](recording);
      if (run) comparedRuns[kind].push({ name: file.name, run });
      else notes.push(`${file.name}：${note}`);
    } catch (error) {
      notes.push(`${file.name}：${error.message}`);
    }
  }
  compareNote = notes.join(' ');
  update();
}

// One row per run in the comparison table: the simulation on screen, this recording, the others.
function comparisonRows() {
  const kind = liveKind();
  const distance = kind === 'distance';
  const current = experiment();
  const rows = [];
  const add = (label, samples, key, target) =>
    rows.push({ label, metrics: stepMetrics(samples, { key, target, distance }) });
  // A speed recording is judged over its first command only (firstHold).
  const judged = (run) => (distance ? run.samples : firstHold(run.samples));
  if (current.result?.mode === kind)
    add(copy.live.compareSimulation, current.result.samples, 'actual', current.result.target);
  const liveTarget = (run) => (distance ? STOP_DISTANCE : run.samples[0].target);
  if (liveRuns[kind])
    add(copy.live.compareThis, liveRuns[kind], 'measured', liveTarget(liveRuns[kind]));
  for (const entry of comparedRuns[kind])
    add(entry.name, entry.run, 'measured', liveTarget(entry.run));
  return rows;
}

// Driving the real robot from this card (live-drive.js): the speed of the real step input, and
// the robot's wheel radius for the rpm shown next to it (as the bridge reported it).
let liveStepSpeed = STEP_SPEEDS[1];
const REAL_WHEEL_RADIUS = 0.1; // m, until the robot has told us (launcher/config/drive_component.yaml)

function stepSpeedOptions() {
  const config = { wheel_radius: liveLink().config?.wheel_radius ?? REAL_WHEEL_RADIUS };
  return STEP_SPEEDS.map((speed) => ({
    speed,
    label: fill(copy.live.driveSpeedOption, {
      speed: speed.toFixed(1),
      rpm: forwardRpm(speed, config).toFixed(0),
    }),
  }));
}

const speedDrive = {
  startLabel: undefined,
  program: () => {
    const step = speedStep(liveStepSpeed);
    return fill(copy.live.driveSpeedProgram, {
      speed: liveStepSpeed.toFixed(1),
      hold: STEP_HOLD,
      distance: (step.distance + 0.5).toFixed(1),
      target: experiment().config.targetRPM,
    });
  },
  plan: () => {
    const step = speedStep(liveStepSpeed);
    return { controller: step.controller, seconds: step.seconds, tail: 1 };
  },
};

const wallMessages = () => ({
  tooClose: fill(copy.live.driveWallTooClose, { start: WALL_START_MIN.toFixed(1) }),
  noWall: copy.live.driveWallNoWall,
  lost: copy.live.driveWallLost,
  hit: fill(copy.live.driveWallHit, { gap: WALL_MIN_GAP.toFixed(2) }),
});

const wallDrive = {
  startLabel: copy.live.driveWallStart,
  program: () => {
    const config = experiment().config;
    return fill(copy.live.driveWallProgram, {
      kp: config.kp,
      ki: config.ki,
      kd: config.kd,
      top: WALL_MAX_SPEED.toFixed(2),
      start: WALL_START_MIN.toFixed(1),
      gap: WALL_MIN_GAP.toFixed(2),
    });
  },
  plan: () => ({
    controller: wallApproach({ ...experiment().config }, wallMessages()),
    seconds: WALL_SECONDS,
    tail: 1,
  }),
};

const liveSessions = {
  speed: createLiveSession({
    slot: 'control-speed',
    lesson: 'control-speed',
    needs: ['drive', 'twist'],
    seconds: copy.live.seconds,
    countStream: 'drive',
    failed: copy.live.failed,
    apply: (recording) => applyRecording('speed', recording),
    update: () => update(),
    drive: speedDrive,
  }),
  distance: createLiveSession({
    slot: 'control-distance',
    lesson: 'control-distance',
    needs: ['scan'],
    seconds: copy.live.distanceSeconds,
    countStream: 'scan',
    failed: copy.live.failed,
    apply: (recording) => applyRecording('distance', recording),
    update: () => update(),
    drive: wallDrive,
  }),
};

const liveKind = () => (isDistance() ? 'distance' : 'speed');
const liveSession = () => liveSessions[liveKind()];

const actions = {
  openGroup(index) {
    selectTopic(CONTROL_TOPICS.find((entry) => entry.group === index).id);
  },
  openTopic: selectTopic,
  setNumber(key, value) {
    experiment().config[key] = value;
    changed();
  },
  setChoice(key, value) {
    experiment().config[key] = value;
    changed();
  },
  setFlag(key, value) {
    experiment().config[key] = value;
    changed();
  },
  run: startRun,
  reset() {
    experiment().config = controlDefaults(topicId);
    rebuild();
    changed();
  },
  save() {
    saveCsv(experiment().result);
  },
  toggleReplay() {
    if (!playback.playing) {
      startPlayback();
      return;
    }
    stop();
    update();
  },
  seek(index) {
    stop();
    const current = experiment();
    current.index = Math.min(current.observedMax, Math.max(0, index));
    update();
  },
  setSpeed(speed) {
    const resume = playback.playing;
    stop();
    playback.speed = speed === 2 ? 2 : 1;
    if (resume) startPlayback();
    else update();
  },
  setCompare(value) {
    compare = value;
    refreshCharts();
    update();
  },
  setShowIntegral(value) {
    showIntegral = value;
    integralTitled = true;
    update();
  },
  setCommandOpen(value) {
    if (commandOpen === value) return;
    commandOpen = value;
    update();
  },
  setNote(value) {
    experiment().note = value;
  },
  next() {
    const position = CONTROL_TOPICS.findIndex((entry) => entry.id === topicId);
    const next = CONTROL_TOPICS[position + 1];
    if (next) selectTopic(next.id);
    else document.dispatchEvent(new CustomEvent('quiz-open', { detail: 'control' }));
  },
  setConceptValue(value) {
    concept = { ...concept, value };
    update();
  },
  advanceConcept() {
    concept = advanceConcept(concept);
    update();
  },
  resetConcept() {
    concept = resetConcept(concept);
    update();
  },
  startCapture: () => liveSession().actions.startCapture(),
  startDriveCapture: () => liveSession().actions.startDriveCapture(),
  confirmDrive: (value) => liveSession().actions.confirmDrive(value),
  setLiveStepSpeed(value) {
    if (STEP_SPEEDS.includes(value)) liveStepSpeed = value;
    update();
  },
  stopCapture: () => liveSession().actions.stopCapture(),
  openRecording: (file) => liveSession().actions.openRecording(file),
  saveRecording: (kind) => liveSession().actions.saveRecording(kind),
  clearLive() {
    liveRuns[liveKind()] = null;
    liveSession().clear();
    update();
  },
  addComparisons: (files) => addComparisons([...files]),
  clearComparisons() {
    comparedRuns[liveKind()] = [];
    compareNote = '';
    update();
  },
  openLink: openRobotDialog,
};

function activateControl() {
  refreshCharts();
  update();
}

function reviewControl(id) {
  if (!CONTROL_TOPICS.some((entry) => entry.id === id)) return false;
  selectTopic(id);
  return true;
}

function initControl() {
  // A recording taken before the page was reloaded comes back, as far as this browser kept it.
  liveSessions.speed.restore();
  liveSessions.distance.restore();
  rebuild();
  document.addEventListener('series-leave', stopAndShow);
  document.addEventListener('supplement-open', stopAndShow);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAndShow();
  });
  window.addEventListener('resize', () => {
    if (page().hidden) return;
    refreshCharts();
    update();
  });
  // Connecting or losing the robot changes what the recording card offers.
  onLiveLink(() => {
    if (!page().hidden) update();
  });
}

export { activateControl, reviewControl, initControl };
