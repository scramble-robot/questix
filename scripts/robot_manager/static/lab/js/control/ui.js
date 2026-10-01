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
import { controlWheelAngle, drawControlStage } from './render.js';
import { controlPage, gainText, COMMAND_OPEN_TOPICS } from './view.js';
import { conceptState, advanceConcept, resetConcept } from './concepts.js';
import {
  runLabelParts,
  compareLetter,
  labelPoint,
  commandRpm,
  comparisonRows as buildComparisonRows,
  comparisonConclusion,
} from './compare.js';
import { liveControlRun, liveLink, onLiveLink, openRecordingFile } from '../live/capture.js';
import { liveDistanceRun, forwardRpm } from '../live/capture-core.js';
import { reportLessonProgress } from '../shell/lesson-progress.js';
import { revealElement } from '../core/reveal.js';
import { driveRows, wallRows } from '../live/recording-core.js';
import { createLiveSession } from '../live/live-session.js';
import { captureNotes } from '../live/live-view.js';
import { openRobotDialog } from '../live/live-ui.js';
import { registerRecordTarget } from '../live/record-targets.js';
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
const CHART_MAX_WIDTH = 900; // px: as wide as the card, so chart text is not scaled up
const CHART_GUTTER = 32; // px of the container the chart leaves to its own padding
const SCROLL_MARGIN = 12; // px left between the part scrolled to and the edge of the screen
const PHONE_QUERY = '(max-width: 600px)'; // matches the tucking header in css/navigation.css

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
// Each entry: `{run, parts, conditions, recordedAt, point, command}` (see realEntry).
const liveRuns = { speed: null, distance: null };
// Press → see: a real run that finished, or a file that was opened, brings the chart on screen
// once it is drawn — but not the recording that comes back after a reload.
let restoring = false;
let revealPending = false;

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
    doneTopics: CONTROL_TOPICS.filter((entry) => experiments.get(entry.id).runs.length).map(
      (entry) => entry.id,
    ),
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
    live: liveModel(),
  };
}

function liveModel() {
  const kind = liveKind();
  const current = liveRuns[kind];
  const table = comparisonRows();
  return {
    run: current?.run ?? null,
    current,
    chart: current ? { ...current.run, point: current.point, command: current.command } : null,
    // The lesson's note on the recording goes into the block's one result box.
    capture: { ...liveSession().model(), message: liveSession().note },
    stepSpeed: liveStepSpeed,
    stepSpeeds: stepSpeedOptions(),
    compared: comparedRuns[kind],
    table,
    conclusion: comparisonConclusion(table, { distance: kind === 'distance', text: copy.live }),
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
  reportLessonProgress('control', {
    topics: CONTROL_TOPICS.map((topic) => ({ id: topic.id, title: topic.name })),
    current: topicId,
    open: selectTopic,
  });
  drawStage();
  if (revealPending && !page().hidden) {
    revealPending = false;
    showCharts();
  }
}

// The chart with the real runs and the comparison table under it.
function showCharts() {
  revealElement(document.getElementById('controlGraphs'));
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
  showRunOnScreen();
  startPlayback();
}

// Press → see: after 実験, the rpm chart the brief talks about is on screen, with the figure above
// it when both fit, otherwise with the chart's bottom at the bottom of the screen (the readings
// and the playback bar stay just above it). The settings stay beside it (sticky, css/control.css).
function showRunOnScreen() {
  const figure = document.getElementById('controlVisual');
  const chart = document.querySelector('#controlCharts .control-chart');
  if (!figure || !chart) return;
  const header = stickyHeaderHeight();
  const figureTop = figure.getBoundingClientRect().top + window.scrollY;
  const chartBottom = chart.getBoundingClientRect().bottom + window.scrollY;
  const top = Math.max(
    figureTop - header - SCROLL_MARGIN,
    chartBottom - window.innerHeight + SCROLL_MARGIN,
  );
  window.scrollTo({ top, behavior: 'instant' });
}

// The site header stays on top of the page on wide screens; phones tuck it away while scrolling
// down (shell/series.js), so it does not cover the page there.
function stickyHeaderHeight() {
  if (window.matchMedia(PHONE_QUERY).matches) return 0;
  return document.querySelector('.site-header')?.getBoundingClientRect().height ?? 0;
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

// A drawable run with what the recording says about itself (settings, time, group, robot: the
// optional fields the live layer writes, 「設定：不明」 for older files).
function realEntry(kind, run, recording) {
  const distance = kind === 'distance';
  return {
    run,
    parts: runLabelParts(recording, copy.live),
    conditions: typeof recording.conditions === 'object' ? recording.conditions : null,
    recordedAt: recording.recordedAt ?? null,
    point: labelPoint(run, distance),
    command: commandRpm(run, distance),
  };
}

function applyRecording(kind, recording) {
  const { run, note } = RUN_OF[kind](recording);
  if (!run) return { ok: false, note };
  keepPrevious(kind);
  liveRuns[kind] = realEntry(kind, run, recording);
  if (!restoring && kind === liveKind()) revealPending = true;
  return { ok: true, note };
}

// A new real run pushes the one on screen into the comparison lines (grey, dotted, with the
// settings it was run with), so tuning a gain on the robot compares like with like instead of
// overwriting the last try.
function keepPrevious(kind) {
  if (!liveRuns[kind]) return;
  addCompared(kind, { ...liveRuns[kind], source: 'past' });
}

// Other groups' recordings, drawn next to this one so a class can compare machines and drivers.
// Every compared run keeps its letter (A, B …) until the comparisons are cleared, so a letter
// written in a note still means the same run.
const MAX_COMPARED = 5;
const comparedRuns = { speed: [], distance: [] };
const nextLetter = { speed: 0, distance: 0 };
let compareNote = '';

function addCompared(kind, entry) {
  const index = nextLetter[kind]++;
  comparedRuns[kind].push({ ...entry, index, letter: compareLetter(index) });
  if (comparedRuns[kind].length <= MAX_COMPARED) return;
  // Full: the oldest earlier run of this page goes first; a file was opened on purpose.
  const oldestPast = comparedRuns[kind].findIndex((other) => other.source === 'past');
  comparedRuns[kind].splice(Math.max(0, oldestPast), 1);
}

// `sources` are `{name, load()}`: files picked here, or a recording kept on the robot (the picker
// or 記録の一覧), which take the same way onto the chart.
async function addComparisons(sources) {
  const kind = liveKind();
  const notes = [];
  let added = 0;
  for (const source of sources) {
    if (comparedRuns[kind].length >= MAX_COMPARED) {
      notes.push(fill(copy.live.compareTooMany, { count: MAX_COMPARED }));
      break;
    }
    try {
      const recording = await source.load();
      const { run, note } = RUN_OF[kind](recording);
      if (!run) {
        notes.push(`${source.name}：${note}`);
        continue;
      }
      addCompared(kind, { ...realEntry(kind, run, recording), source: 'file', file: source.name });
      added += 1;
    } catch (error) {
      notes.push(`${source.name}：${error.message}`);
    }
  }
  compareNote = notes.join(' ');
  if (added) revealPending = true;
  update();
  return added > 0;
}

const fileSource = (file) => ({
  name: file.name,
  load: async () => (await openRecordingFile(file)).recording,
});
const recordingSource = (recording) => ({ name: recording.name, load: async () => recording });

function clearComparisons() {
  comparedRuns[liveKind()] = [];
  nextLetter[liveKind()] = 0;
  compareNote = '';
  update();
}

// Drawing other recordings over this one, offered in the shared block's 記録ファイルと保存 (files)
// and in its one picker (a record's 「これを重ねる」).
const liveCompare = {
  add: (recording) => addComparisons([recordingSource(recording)]),
  addFiles: (files) => addComparisons([...files].map(fileSource)),
  clear: clearComparisons,
  model: () => ({
    count: comparedRuns[liveKind()].length,
    note: compareNote,
    help: copy.live.compareNote,
  }),
};

// 「フィードバック制御で開く／比べる」 from 記録の一覧: the course is on screen (series.js); a topic of
// the recording's kind is opened if the one on screen is of the other kind, then the recording goes
// the way a file would, and the chart comes on screen (revealPending).
function openFromRecords(kind, recording, compare) {
  if (liveKind() !== kind) {
    const first = CONTROL_TOPICS.find(
      (entry) => (entry.mode === 'distance') === (kind === 'distance'),
    );
    selectTopic(first.id);
  }
  if (compare) return addComparisons([recordingSource(recording)]);
  const taken = liveSessions[kind].useRecording(recording, 'robot');
  if (!taken) revealElement(document.getElementById('controlLive'));
  return taken;
}

// One row per run in the comparison table: the simulation on screen (marked when the settings
// have changed since), this recording, the others.
function comparisonRows() {
  const kind = liveKind();
  const current = experiment();
  const result = current.result?.mode === kind ? current.result : null;
  return buildComparisonRows({
    simulation: result && {
      samples: result.samples,
      target: result.target,
      settings: gainText(result.config, topicId, copy),
      stale: isStale(),
    },
    current: liveRuns[kind],
    compared: comparedRuns[kind],
    distance: kind === 'distance',
    stopDistance: STOP_DISTANCE,
    text: copy.live,
  });
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

const gainsText = (config) =>
  fill(copy.live.driveGains, { kp: config.kp, ki: config.ki, kd: config.kd });

// What a run was made with, for the recording's `conditions` (read back by compare.js) and the
// run history: the values plus a short label. Code that still expects the text gets the label.
function runConditions(values, label) {
  const conditions = { ...values, label };
  Object.defineProperty(conditions, 'toString', { value: () => label });
  return conditions;
}

const speedDrive = {
  startLabel: undefined,
  program: () =>
    fill(copy.live.driveSpeedProgram, {
      speed: liveStepSpeed.toFixed(1),
      hold: STEP_HOLD,
    }),
  placement: () =>
    fill(copy.live.driveSpeedPlacement, {
      distance: (speedStep(liveStepSpeed).distance + 0.5).toFixed(1),
    }),
  conditions: () => runConditions({ speed: liveStepSpeed }, `${liveStepSpeed.toFixed(1)} m/s`),
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

function wallOutcome(result) {
  if (result.settled) return copy.live.driveWallSettled;
  if (result.distance === null) return '';
  return fill(copy.live.driveWallNotSettled, { distance: result.distance.toFixed(2) });
}

const wallDrive = {
  startLabel: copy.live.driveWallStart,
  program: () =>
    fill(copy.live.driveWallProgram, {
      gains: gainsText(experiment().config),
      top: WALL_MAX_SPEED.toFixed(2),
      gap: WALL_MIN_GAP.toFixed(2),
    }),
  placement: () => fill(copy.live.driveWallPlacement, { start: WALL_START_MIN.toFixed(1) }),
  conditions: () => {
    const { kp, ki, kd } = experiment().config;
    return runConditions({ kp, ki, kd, stop: STOP_DISTANCE }, gainsText({ kp, ki, kd }));
  },
  plan: () => {
    const controller = wallApproach({ ...experiment().config }, wallMessages());
    return {
      controller,
      seconds: WALL_SECONDS,
      tail: 1,
      outcome: () => wallOutcome(controller.result),
      references: {
        front: [
          { value: STOP_DISTANCE, label: fill(copy.live.driveTargetLine, { value: '0.50' }) },
          {
            value: WALL_MIN_GAP,
            label: fill(copy.live.driveLimitLine, { value: WALL_MIN_GAP.toFixed(2) }),
          },
        ],
      },
    };
  },
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
    // The chart and the comparison table above are this block's result; the run's own report
    // stays in 記録の一覧.
    report: false,
    state: { place: 'control-live', name: copy.live.memoName },
    compare: liveCompare,
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
    report: false,
    state: { place: 'control-live', name: copy.live.memoName },
    compare: liveCompare,
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
  saveRun: (id, kind) => liveSession().actions.saveRun(id, kind),
  confirmDrive: (value) => liveSession().actions.confirmDrive(value),
  setLiveStepSpeed(value) {
    if (STEP_SPEEDS.includes(value)) liveStepSpeed = value;
    update();
  },
  stopCapture: () => liveSession().actions.stopCapture(),
  openRecording: (file) => liveSession().actions.openRecording(file),
  pickRobotRecord: () => liveSession().actions.pickRobotRecord(),
  saveRecording: (kind) => liveSession().actions.saveRecording(kind),
  clearLive() {
    liveRuns[liveKind()] = null;
    liveSession().clear();
    update();
  },
  addComparisons: (files) => liveCompare.addFiles(files),
  clearComparisons,
  openLink: openRobotDialog,
  showCharts,
  showLive: () => revealElement(document.getElementById('controlLive')),
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
  restoring = true;
  liveSessions.speed.restore();
  liveSessions.distance.restore();
  restoring = false;
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
  registerRecordTarget('control-speed', (recording, { compare }) =>
    openFromRecords('speed', recording, compare),
  );
  registerRecordTarget('control-distance', (recording, { compare }) =>
    openFromRecords('distance', recording, compare),
  );
}

export { activateControl, reviewControl, initControl };
