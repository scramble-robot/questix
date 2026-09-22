import { render } from '../vendor/lit-html.js';
import { loadJson, loadText } from '../core/content.js';
import { downloadFile } from '../core/dom.js';
import {
  CONTROL_TOPICS,
  CONTROL_PERIOD,
  LAST_SAMPLE,
  BLOCK_WINDOW,
  DRAG_START,
  START_DISTANCE,
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
import { fillSentence as fill } from '../core/content.js';

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
}

export { activateControl, reviewControl, initControl };
