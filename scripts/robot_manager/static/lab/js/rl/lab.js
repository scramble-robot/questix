import { render } from '../vendor/lit-html.js';
import { loadJson } from '../core/content.js';
import { downloadFile, formatNumber } from '../core/dom.js';
import { lessonGuide, figureGuide } from '../shell/lesson-guide.js';
import { SENSOR_COPY } from '../shell/lesson-ui.js';
import { World, COURSES, DEFAULT_REWARD, FEATURE_NAMES } from '../core/engine.js';
import { drawArena, drawCamera, drawTrajectory, drawStartMap } from '../core/renderer.js';
import { drawLidar, drawGraph, graphSpec, graphReadings } from './sensors.js';
import { drawStartMarks } from './lab-render.js';
import { revealElement } from './reveal.js';
import {
  Experiment,
  clone,
  statistics,
  resultName,
  REWARDS,
  CHECKPOINT_LABELS,
  CLEARED_ARRIVALS,
  TEST_PLACES,
} from './experiment.js';
import { labPage } from './lab-view.js';
import { stickyRange } from './curve-core.js';

// Reinforcement-learning lab: state and behaviour. lab-view.js turns the model into markup,
// core/renderer.js and sensors.js draw the figures, experiment.js runs the training and the test
// batch. Texts live in content/rl/lab.json.

const copy = await loadJson('content/rl/lab.json');

const CONTROL_PERIOD = 0.1; // seconds of simulated time per manual drive command
const MAX_FRAME = 0.1; // seconds; a long browser stall must not teleport the robot
const MANUAL_TRAIL = 1000; // frames of manual driving kept for the trail and the sensor plot
const FRAME_EPSILON = 0.001; // seconds of slack when looking up the frame at the playback cursor
const NARROW_LAYOUT = '(max-width: 900px)'; // below this the arena is scrolled to instead of focused
const RESULT_STAGES = ['test', 'improve'];
const DRIVE_COMMANDS = {
  forward: [0.6, 0.6],
  back: [-0.45, -0.45],
  left: [-0.4, 0.4],
  right: [0.4, -0.4],
};
const DRIVE_KEYS = {
  ArrowUp: 'forward',
  ArrowDown: 'back',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};
const TYPING_TAGS = ['INPUT', 'SELECT', 'TEXTAREA'];
// Steps the "次の実験で何を変える？" choices take, and the point at which they stop helping.
const CLEARANCE_STEP = 4; // points per second added to the clearance penalty
const MAX_CLEARANCE = 20;
const TIME_STEP = 1; // points per second added to the time penalty
const MAX_TIME = 8;

const byId = (id) => document.getElementById(id);
const page = () => byId('labPage');
const arena = byId('arena');
const camera = byId('cameraView');
const scanToggle = byId('sensorToggle'); // read by core/renderer.js when it draws the arena
const toDegrees = (radians) => (radians * 180) / Math.PI;
const wait = () => new Promise((resolve) => setTimeout(resolve, 0));

// One experiment per mission and course, kept while the tab stays open.
const sessions = new Map();
const taskCourses = new Map();

let experiment = null;
let activeTask = 'delivery';
let activeCourse = 'standard';
let world = null;
let stage = 'setup';
let busy = false;
let token = 0; // cancels a training run the learner has navigated away from
let errorMessage = null;
let guideGeneration = 0; // bumped whenever the guide panel should start fresh (details, focus)

let displayFrame = null;
let shownTrace = [];
let playback = null; // { result, label, cursor }
let playing = false;
let speed = 1;
let runRewardsOpen = false;

let trainProgress = null;
let chartRanges = {}; // per metric: the y range of the training chart so far (stickyRange)
let chartMetric = 'rate'; // the guide asks learners to read the arrival rate first
const briefVisits = new Map(); // how often each stage's guide text has been reached
let briefKey = null;

let sensorsOpen = false;
let sensor = 'lidar';
let imuView = 'impact';
let scanVisible = false;

let manual = false;
let manualStopped = false;
let manualReason = '';
let manualPressed = null;
let manualHistory = [];
let manualAccumulator = 0;
let command = [0, 0];
let returnStage = 'setup';

let lastTick = 0;
let supplementOpen = false;

const labVisible = () => !byId('introPage').hidden && !page().hidden;
const testResults = () => experiment?.run?.results ?? [];

// ---------------------------------------------------------------- model

function openingStage() {
  if (!experiment.run) return 'setup';
  return experiment.run.results.length === TEST_PLACES ? 'test' : 'learn';
}

function disabledSteps() {
  if (!experiment) return [];
  if (busy) return ['setup', 'learn', 'test', 'improve'];
  const run = experiment.run;
  const disabled = run ? [] : ['learn', 'test'];
  if (run?.results.length !== TEST_PLACES) disabled.push('improve');
  return disabled;
}

function startCaption() {
  const config = experiment.draft;
  const dock = config.task === 'dock' ? copy.scene.startCaption.dockCondition : '';
  return (
    copy.scene.startCaption.prefix +
    copy.startModes[config.startMode] +
    '。' +
    dock +
    copy.scene.startCaption.rule
  );
}

function sceneTitle() {
  if (manual) return manualStopped ? copy.scene.titles.stopped : copy.scene.titles.manual;
  if (playback) return playback.label;
  return stage === 'setup' ? copy.scene.titles.setup : copy.scene.titles.review;
}

function sceneCaption() {
  if (!experiment) return copy.scene.initialCaption;
  if (manual) return manualStopped ? copy.scene.stoppedCaption : copy.scene.manualCaption;
  if (!playback) return startCaption();
  if (playback.cursor >= playback.result.time)
    return resultName(playback.result) + copy.scene.endedCaption;
  return playing ? copy.scene.playingCaption : copy.scene.pausedCaption;
}

function sceneNextLabel() {
  if (!displayFrame) return '';
  if (stage === 'test' && testResults().length < TEST_PLACES) return copy.scene.next.testRemaining;
  if (stage === 'learn') return copy.scene.next.learn;
  if (stage === 'improve') return copy.scene.next.improve;
  return copy.scene.next.results;
}

function trainingModel() {
  const progress = trainProgress || {};
  const checkpoints = progress.checkpoints || [];
  const history = progress.history || [];
  chartRanges[chartMetric] = stickyRange(
    chartRanges[chartMetric],
    history.map((point) => point[chartMetric]),
  );
  return {
    episodes: progress.episodes || 0,
    history,
    yRange: chartRanges[chartMetric] || [],
    checkpoints,
    checkpointResults: checkpoints.map((checkpoint) => resultName(checkpoint.result)),
    metricKey: chartMetric,
    metric: copy.training.metrics[chartMetric],
  };
}

function comparisonVerdict(after, before) {
  const words = copy.results.comparison;
  const delta = after.successCount - before.successCount;
  if (delta > 0) return words.moreArrivalsPrefix + delta + words.moreArrivalsSuffix;
  if (delta < 0) return words.moreArrivalsPrefix + -delta + words.fewerArrivalsSuffix;
  if (after.contacts < before.contacts) return words.fewerContacts;
  if (after.contacts > before.contacts) return words.moreContacts;
  return words.same;
}

function resultsModel(stats, before) {
  const run = experiment.run;
  return {
    cleared: stats.cleared,
    revision: run.revision,
    successCount: stats.successCount,
    contacts: stats.contacts,
    arrivalTime: stats.arrivalTime,
    commandRate: stats.commandRate,
    // The same figures from the experiment this one is compared against, or null on a first run.
    previous: before && {
      successCount: before.successCount,
      contacts: before.contacts,
      arrivalTime: before.arrivalTime,
      commandRate: before.commandRate,
    },
    trials: run.results,
    names: run.results.map(resultName),
    verdict: before ? comparisonVerdict(stats, before) : null,
    startSummary: copy.startModes[run.config.startMode],
    episodes: run.episodes,
    change: run.change,
    note: run.note,
    log: experiment.records.map((record) => {
      const summary = statistics(record.results);
      return {
        revision: record.revision,
        change: record.change,
        successCount: summary.successCount,
        contacts: summary.contacts,
        arrivalTime: summary.arrivalTime,
      };
    }),
  };
}

function testModel(stats) {
  const results = testResults();
  const first = results[0];
  return {
    done: results.length,
    complete: results.length === TEST_PLACES,
    successCount: stats.successCount,
    cleared: stats.cleared,
    firstResult:
      playing || !first
        ? copy.playback.playing
        : resultName(first) + ' · ' + formatNumber(first.time) + ' 秒',
  };
}

function improveExample(results) {
  const collision = results.findIndex((result) => result.collision);
  if (collision >= 0) return collision;
  const failure = results.findIndex((result) => !result.success);
  return failure >= 0 ? failure : 0;
}

function improveHint(config, risky) {
  const words = copy.improve;
  if (!risky) return config.startMode === 'near' ? words.hintNear : words.hintMetrics;
  if (!config.rewards.enabled.clearance) return words.hintNoClearance;
  return words.hintClearancePrefix + config.rewards.clearance + words.hintClearanceSuffix;
}

function improveChoices(config) {
  const clearanceOn = config.rewards.enabled.clearance;
  const choices = [];
  if (config.startMode === 'near')
    choices.push({ key: 'starts', ...copy.improve.choices.starts, disabled: false });
  choices.push({
    key: 'clearance',
    ...(clearanceOn ? copy.improve.choices.clearanceOn : copy.improve.choices.clearanceOff),
    disabled: clearanceOn && config.rewards.clearance >= MAX_CLEARANCE,
  });
  choices.push({
    key: 'time',
    ...copy.improve.choices.time,
    disabled: config.rewards.time >= MAX_TIME,
  });
  choices.push({ key: 'custom', ...copy.improve.choices.custom, disabled: false });
  return choices;
}

function improveTitleAndIntro(stats) {
  const words = copy.improve;
  if (stats.contacts > 0)
    return {
      title: words.titleContacts,
      intro: words.introContactsPrefix + stats.contacts + words.introContactsSuffix,
    };
  if (stats.successCount < CLEARED_ARRIVALS)
    return { title: words.titleFailures, intro: words.introFailures };
  return { title: words.titleCleared, intro: words.introCleared };
}

function improveModel(stats) {
  const config = experiment.run.config;
  const reflection = experiment.reflection;
  return {
    ...improveTitleAndIntro(stats),
    exampleIndex: improveExample(experiment.run.results),
    hint: improveHint(config, stats.contacts > 0),
    choices: improveChoices(config).map((choice) => ({
      ...choice,
      selected: choice.key === reflection.choice,
    })),
    choice: reflection.choice,
    note: reflection.note,
  };
}

function graphMode() {
  if (sensor === 'wheels') return 'wheels';
  return imuView === 'impact' ? 'impact' : 'attitude';
}

function graphNote() {
  if (sensor === 'wheels') return copy.sensors.wheelsNote;
  return imuView === 'impact' ? copy.sensors.impactNote : copy.sensors.attitudeNote;
}

function sensorHistory() {
  return shownTrace.flatMap((frame) => {
    const imu = frame.observation.imu;
    const point = {
      t: frame.state.t,
      impact: frame.impact || 0,
      left: frame.observation.wheelRpm[0],
      right: frame.observation.wheelRpm[1],
      pitch: toDegrees(imu.pitch),
      roll: toDegrees(imu.roll),
      yaw: toDegrees(imu.yaw),
      gyro: imu.gyro[2],
    };
    // On the impact trace a spike between two drawn frames still has to be visible, so every
    // recorded event becomes its own point.
    const spikes = sensor === 'imu' && imuView === 'impact' && frame.events?.length;
    if (!spikes) return point;
    return frame.events.map((event) => ({ ...point, t: event.t, impact: event.impact }));
  });
}

function lidarModel(observation) {
  const nearest = Math.min(...observation.scan) - world.physics.bodyRadius;
  return {
    kind: 'lidar',
    name: SENSOR_COPY.lidar.name,
    title: SENSOR_COPY.lidar.title,
    description: copy.sensors.lidar.description,
    note: copy.sensors.lidar.note,
    reading: { kind: 'lidar', centimetres: Math.round(Math.max(0, nearest) * 100) },
  };
}

function cameraModel(observation) {
  const marker = observation.camera;
  return {
    kind: 'camera',
    name: SENSOR_COPY.camera.name,
    title: SENSOR_COPY.camera.title,
    description: copy.sensors.camera.description,
    note: copy.sensors.camera.note,
    reading: {
      kind: 'camera',
      visible: marker.visible,
      // Z is the depth straight ahead, which is what an RGB-D frame reports.
      depth: formatNumber(marker.distance * Math.cos(marker.bearing), 2),
    },
  };
}

function plotModel() {
  const spec = graphSpec(graphMode(), imuView);
  return {
    kind: sensor,
    name: SENSOR_COPY[sensor].name,
    title: spec.title,
    description: spec.note,
    note: graphNote(),
    unit: spec.unit,
    spec,
    reading: { kind: 'graph', values: graphReadings(sensorHistory(), spec) },
  };
}

function sensorModel() {
  if (!displayFrame)
    return { kind: sensor, name: '', title: '', description: '', note: '', reading: null };
  if (sensor === 'lidar') return lidarModel(displayFrame.observation);
  if (sensor === 'camera') return cameraModel(displayFrame.observation);
  return plotModel();
}

function runRewardsModel() {
  if (!playback || !runRewardsOpen) return { open: runRewardsOpen, rows: [], total: '' };
  const totals = new Map();
  for (const frame of shownTrace)
    for (const piece of frame.pieces || [])
      totals.set(piece.text, (totals.get(piece.text) || 0) + piece.value);
  return {
    open: true,
    rows: [...totals].filter(([, value]) => Math.abs(value) > 0.0001),
    total: formatNumber(displayFrame.state.total || 0) + ' 点',
  };
}

// Counts a stage's guide text as reached again only when the learner arrives from another stage.
function countBriefVisit(key) {
  if (key !== briefKey) {
    briefKey = key;
    briefVisits.set(key, (briefVisits.get(key) || 0) + 1);
  }
  return briefVisits.get(key);
}

function buildModel() {
  const run = experiment?.run ?? null;
  const results = testResults();
  const trainingVisible = Boolean(experiment) && !manual && stage === 'learn' && !playback;
  const resultsVisible =
    Boolean(run) &&
    !manual &&
    !busy &&
    !playback &&
    RESULT_STAGES.includes(stage) &&
    results.length === TEST_PLACES;
  const stats = run ? statistics(results) : null;
  const before = experiment?.previous ? statistics(experiment.previous.results) : null;
  const guideKey = 'lab-' + (manual ? 'manual' : stage);
  return {
    briefFolded: countBriefVisit(guideKey) > 1,
    ready: Boolean(experiment),
    generation: guideGeneration,
    stage,
    manual,
    busy,
    error: errorMessage,
    task: activeTask,
    course: activeCourse,
    missionTitle: experiment ? copy.tasks[activeTask].title : '',
    lessonBrief: experiment
      ? lessonGuide(guideKey, manual ? '' : copy.tasks[activeTask].goal) + figureGuide(guideKey)
      : '',
    currentStep: manual ? null : stage,
    disabledSteps: disabledSteps(),
    trainingVisible,
    resultsVisible,
    arenaVisible: manual || (!trainingVisible && !resultsVisible),
    playbackVisible: Boolean(playback) && !manual,
    playback: playback && {
      label: playback.label,
      cursor: playback.cursor,
      duration: playback.result.time,
    },
    playing,
    speed,
    runRewards: runRewardsModel(),
    sceneTitle: sceneTitle(),
    sceneTime: playback || manual ? formatNumber(displayFrame.state.t) + ' s' : '',
    sceneCaption: sceneCaption(),
    sceneNextHidden: !displayFrame || !playback || manual || playback.cursor < playback.result.time,
    sceneNextLabel: sceneNextLabel(),
    scanVisible,
    sensorsOpen,
    sensor: sensorModel(),
    imuView,
    draft: experiment?.draft ?? null,
    hasRun: Boolean(run),
    hasPrevious: Boolean(experiment?.previous),
    change: experiment?.change ?? '',
    training: trainingVisible ? trainingModel() : null,
    results: resultsVisible ? resultsModel(stats, before) : null,
    test: stage === 'test' && run ? testModel(stats) : null,
    improve: stage === 'improve' && run ? improveModel(stats) : null,
    manualStopped,
    manualReason,
    manualPressed,
  };
}

// ---------------------------------------------------------------- drawing

function paintArena() {
  drawArena(
    world,
    displayFrame.state,
    shownTrace.map((frame) => frame.state),
    displayFrame.observation,
  );
  drawCamera(world, displayFrame.state, displayFrame.observation);
}

// The trajectory and start-map helpers expect the context state a freshly created canvas has: they
// leave `lineJoin` on "round", which would round the corners of the next frame they stroke. These
// canvases are now kept between renders, so the defaults are put back before each drawing.
function freshCanvas(id) {
  const canvas = byId(id);
  const context = canvas.getContext('2d');
  context.lineJoin = 'miter';
  context.lineCap = 'butt';
  context.setLineDash([]);
  return canvas;
}

function paintCheckpoints(model) {
  const config = experiment.draft;
  const env = new World(config.task, config.rewards, config.physics);
  env.reset(100);
  for (let index = 0; index < CHECKPOINT_LABELS.length; index++)
    drawTrajectory(
      freshCanvas('checkpoint' + index),
      env,
      model.training.checkpoints[index]?.result,
    );
}

function paintTestMap() {
  const config = experiment.run.config;
  const env = new World(config.task, config.rewards, config.physics);
  const canvas = freshCanvas('testMap');
  // The shared map draws floor, shelves and goal; the course adds its own outcome marks
  // (● × △), the same symbols as the list of runs beside the map.
  drawStartMap(canvas, env, { results: [] });
  drawStartMarks(canvas, env, experiment.run.results);
}

function paintSensor(model) {
  if (sensor === 'lidar') drawLidar(byId('lidarView'), displayFrame.observation.scan);
  else if (sensor === 'camera') drawCamera(world, displayFrame.state, displayFrame.observation);
  else
    drawGraph(
      byId('sensorGraph'),
      sensorHistory(),
      model.sensor.spec,
      world.settings.threshold,
      [],
    );
}

function paint(model) {
  if (world && displayFrame && model.arenaVisible) paintArena();
  if (model.trainingVisible) paintCheckpoints(model);
  if (model.resultsVisible) paintTestMap();
  if (model.arenaVisible && sensorsOpen && displayFrame) paintSensor(model);
}

// `fresh` rebuilds the guide panel and the results board, the way the original page replaced their
// markup: open <details> and the focus helper start over, as learners expect on a new step.
function update({ fresh = false } = {}) {
  if (fresh) guideGeneration++;
  // While the conditions are being chosen, the arena previews where the next training run starts,
  // so it follows the draft settings on every update.
  if (experiment && !manual && !playback && stage === 'setup') resetWorld();
  const model = buildModel();
  render(labPage(model, copy, actions), page());
  lockCourseNavigation();
  paint(model);
}

// The chapter and topic buttons of the RL course live outside the lab page but must not take the
// learner away in the middle of a training run, so they follow the lab's busy flag.
function lockCourseNavigation() {
  for (const button of document.querySelectorAll('[data-rl-group],[data-rl-topic]'))
    button.disabled = busy;
}

function focusWorkspace() {
  revealElement(document.querySelector('#labPage .step-nav'));
  const heading = byId('guidePanel').querySelector('h2');
  heading?.setAttribute('tabindex', '-1');
  heading?.focus({ preventScroll: true });
}

// While the robot trains (about 18 s) the progress bar and the curve are what to watch.
function revealTraining() {
  revealElement(byId('trainingBoard'));
  const heading = byId('learningTitle');
  heading?.setAttribute('tabindex', '-1');
  heading?.focus({ preventScroll: true });
}

function revealArena() {
  if (matchMedia(NARROW_LAYOUT).matches) revealElement(byId('arenaCard'));
  else focusWorkspace();
}

// ---------------------------------------------------------------- lab lifecycle

function openLab(task = 'delivery', course = 'standard') {
  if (busy) return;
  sensorsOpen = false;
  token++;
  playing = false;
  playback = null;
  manual = false;
  manualStopped = false;
  command = [0, 0];
  activeTask = task;
  activeCourse = course;
  const key = task + ':' + course;
  if (!sessions.has(key)) sessions.set(key, new Experiment(task, course));
  experiment = sessions.get(key);
  byId('introPage').hidden = false;
  page().hidden = false;
  taskCourses.set(task, course);
  stage = openingStage();
  resetWorld();
  trainProgress = experiment.run;
  chartRanges = {};
  update({ fresh: true });
}

function activateLab(task = 'delivery') {
  if (busy) return;
  // Returning to the same experiment preserves the current stage, settings and replay.
  if (experiment && activeTask === task) {
    update({ fresh: true });
    return;
  }
  openLab(task, taskCourses.get(task) || 'standard');
}

// The arena shows where the next training run would start, so it follows the draft settings.
function resetWorld() {
  const config = experiment.draft;
  world = new World(config.task, config.rewards, config.physics);
  world.reset(100);
  displayFrame = world.snapshot();
  shownTrace = [displayFrame];
}

function navigate(next) {
  sensorsOpen = false;
  if (busy) {
    update();
    return;
  }
  const run = experiment.run;
  if (!run && next !== 'setup') return;
  if (next === 'improve' && run.results.length !== TEST_PLACES) return;
  playing = false;
  manual = false;
  command = [0, 0];
  playback = null;
  stage = next;
  update({ fresh: true });
  focusWorkspace();
}

async function startTraining() {
  if (busy) return;
  sensorsOpen = false;
  busy = true;
  stage = 'learn';
  playback = null;
  playing = false;
  trainProgress = { episodes: 0, history: [], checkpoints: [] };
  chartRanges = {};
  update({ fresh: true });
  revealTraining();
  const currentToken = ++token;
  try {
    await experiment.train(
      (progress) => {
        trainProgress = progress;
        update();
      },
      () => token !== currentToken,
    );
    if (currentToken !== token) return;
    trainProgress = experiment.run;
    busy = false;
    update({ fresh: true });
  } catch (error) {
    busy = false;
    stage = 'setup';
    showError(copy.errors.training, error);
  }
}

function showError(message, error) {
  errorMessage = message;
  update({ fresh: true });
  errorMessage = null; // the next render drops it, as replacing the panel's markup used to
  console.error(error);
}

function startTest() {
  if (!experiment.run || busy) return;
  if (experiment.run.results.length) experiment.freshTest();
  stage = 'test';
  experiment.run.results = [];
  const result = experiment.testOne(0);
  playRecord(result, copy.playback.labels.firstTest);
}

async function testRemaining() {
  if (busy) return;
  sensorsOpen = false;
  playing = false;
  playback = null;
  busy = true;
  update({ fresh: true });
  try {
    for (let index = experiment.run.results.length; index < TEST_PLACES; index++) {
      experiment.testOne(index);
      update({ fresh: true });
      await wait();
    }
    experiment.record();
    busy = false;
    update({ fresh: true });
    focusWorkspace();
  } catch (error) {
    busy = false;
    showError(copy.errors.test, error);
  }
}

// ---------------------------------------------------------------- playback

function playRecord(result, label) {
  manual = false;
  manualStopped = false;
  command = [0, 0];
  playback = { result, label, cursor: 0 };
  playing = true;
  const config = experiment.run.config;
  world = new World(config.task, config.rewards, config.physics);
  seekFrame();
  update({ fresh: true });
  revealArena();
}

function seekFrame() {
  const trace = playback.result.trace;
  const index = Math.max(
    0,
    trace.findLastIndex((frame) => frame.state.t <= playback.cursor + FRAME_EPSILON),
  );
  displayFrame = trace[index];
  shownTrace = trace.slice(0, index + 1);
}

function closePlayback() {
  playing = false;
  playback = null;
  update({ fresh: true });
}

function advancePlayback(dt) {
  playback.cursor = Math.min(playback.result.time, playback.cursor + dt * speed);
  seekFrame();
  const ended = playback.cursor >= playback.result.time;
  if (ended) playing = false;
  // The test guide swaps "走行を再生中" for the result, so that panel is rebuilt on arrival.
  update({ fresh: ended && stage === 'test' });
}

// ---------------------------------------------------------------- manual driving

function startManual() {
  if (busy) return;
  returnStage = stage;
  manual = true;
  playback = null;
  playing = false;
  manualStopped = false;
  manualReason = copy.manual.impactNote;
  manualPressed = null;
  command = [0, 0];
  resetWorld();
  manualHistory = [displayFrame];
  shownTrace = manualHistory;
  update({ fresh: true });
  revealArena();
}

function stopReason(outcome) {
  if (outcome.emergency) return copy.manual.reasons.impact;
  if (outcome.collision) return copy.manual.reasons.collision;
  if (outcome.success) return copy.manual.reasons.success;
  return copy.manual.reasons.timeout;
}

function stopManual(reason) {
  command = [0, 0];
  manualPressed = null;
  manualStopped = true;
  const state = world.state;
  state.latched = true;
  state.done = true;
  state.left = 0;
  state.right = 0;
  state.targetL = 0;
  state.targetR = 0;
  state.v = 0;
  state.omega = 0;
  world.queue = [];
  world.observe();
  displayFrame = { ...world.snapshot(), impact: displayFrame?.impact || 0 };
  manualReason = reason + copy.manual.reasonSuffix;
  update({ fresh: true });
}

function releaseManual() {
  const { x, y, theta } = world.state;
  command = [0, 0];
  world.reset(100, { initial: { x, y, theta } });
  manualStopped = false;
  manualReason = copy.manual.impactNote;
  displayFrame = world.snapshot();
  manualHistory = [displayFrame];
  shownTrace = manualHistory;
  update({ fresh: true });
}

function advanceManual(dt) {
  manualAccumulator += dt;
  if (manualAccumulator < CONTROL_PERIOD) return;
  manualAccumulator = 0;
  const outcome = world.step(command, { capture: true });
  displayFrame = { ...world.snapshot(), impact: outcome.impact, events: outcome.trace };
  manualHistory.push(displayFrame);
  if (manualHistory.length > MANUAL_TRAIL) manualHistory.shift();
  shownTrace = manualHistory;
  if (outcome.done) stopManual(stopReason(outcome));
  else update();
}

function tick(now) {
  const dt = Math.min(MAX_FRAME, (now - lastTick) / 1000 || 0);
  lastTick = now;
  if (labVisible() && !supplementOpen) {
    if (manual && !manualStopped) advanceManual(dt);
    else if (playing && playback) advancePlayback(dt);
  }
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- actions

function applyImprovement() {
  const run = experiment.run;
  const choice = experiment.reflection.choice;
  const offered = improveChoices(run.config).find((option) => option.key === choice);
  if (!offered || offered.disabled) return;
  const draft = clone(run.config);
  experiment.draft = draft;
  const words = copy.improve.changes;
  let change = words.custom;
  if (choice === 'starts') {
    draft.startMode = 'varied';
    change = words.starts;
  }
  if (choice === 'clearance') {
    draft.rewards.enabled.clearance = true;
    draft.rewards.clearance = run.config.rewards.enabled.clearance
      ? Math.min(MAX_CLEARANCE, run.config.rewards.clearance + CLEARANCE_STEP)
      : CLEARANCE_STEP;
    change = words.clearancePrefix + draft.rewards.clearance + words.clearanceSuffix;
  }
  if (choice === 'time') {
    draft.rewards.enabled.time = true;
    draft.rewards.time = Math.min(MAX_TIME, draft.rewards.time + TIME_STEP);
    change = words.timePrefix + draft.rewards.time + words.timeSuffix;
  }
  experiment.prepareRevision(change, experiment.reflection.note);
  stage = 'setup';
  playback = null;
  playing = false;
  update({ fresh: true });
  focusWorkspace();
  if (choice === 'custom') byId('rewardSettings').open = true;
}

function exportPolicy() {
  const run = experiment.run;
  if (!run) return;
  const policy = {
    format: 'robo-lab-policy-v1',
    config: run.config,
    weights: [...run.weights],
    features: FEATURE_NAMES,
    controlDt: CONTROL_PERIOD,
    note: copy.method.exportNote,
  };
  downloadFile(
    'robo-lab-' + run.config.task + '-policy.json',
    JSON.stringify(policy, null, 2),
    'application/json',
  );
}

function sceneNext() {
  if (stage === 'test' && experiment.run.results.length < TEST_PLACES) {
    testRemaining();
    return;
  }
  if (stage === 'learn') {
    startTest();
    return;
  }
  playing = false;
  playback = null;
  sensorsOpen = false;
  update({ fresh: true });
  focusWorkspace();
}

const controls = {
  openCourse: (course) => openLab(activeTask, course),
  navigate,
  startManual,
  startTraining,
  startTest,
  testRemaining,
  sceneNext,
  closePlayback,
  exportPolicy,
  applyImprovement,
  togglePlay() {
    playing = !playing;
    if (playback && playback.cursor >= playback.result.time) playback.cursor = 0;
    update();
  },
  replayFromStart() {
    if (!playback) return;
    playback.cursor = 0;
    playing = true;
    seekFrame();
    update();
  },
  seek(seconds) {
    if (!playback) return;
    playback.cursor = seconds;
    playing = false;
    seekFrame();
    update();
  },
  setSpeed(value) {
    speed = value;
  },
  showRunRewards(open) {
    runRewardsOpen = open;
    update();
  },
  showScan(visible) {
    scanVisible = visible;
    scanToggle.checked = visible;
    update();
  },
  showSensors(open) {
    sensorsOpen = open;
    update();
  },
  showSensor(kind) {
    sensor = kind;
    update();
  },
  showImuView(view) {
    imuView = view;
    update();
  },
  showMetric(key) {
    chartMetric = key;
    update();
  },
  replayCheckpoint(index) {
    const checkpoint = trainProgress.checkpoints[index];
    playRecord(checkpoint.result, CHECKPOINT_LABELS[index] + copy.playback.labels.checkpointSuffix);
  },
  replayLearned() {
    playRecord(experiment.run.checkpoints.at(-1).result, copy.playback.labels.learned);
  },
  replayTrial(index) {
    playRecord(
      experiment.run.results[index],
      copy.playback.labels.testPrefix + (index + 1) + copy.playback.labels.testSuffix,
    );
  },
  freshBatch() {
    experiment.freshTest();
    startTest();
  },
  nextCourse() {
    const names = Object.keys(COURSES);
    openLab(activeTask, names[(names.indexOf(experiment.draft.course) + 1) % names.length]);
  },
  considerChange() {
    playing = false;
    playback = null;
    stage = 'improve';
    update({ fresh: true });
    focusWorkspace();
  },
  showOverview() {
    playing = false;
    playback = null;
    update({ fresh: true });
  },
  inspectExample() {
    const index = improveExample(experiment.run.results);
    const risky = statistics(experiment.run.results).contacts > 0;
    playRecord(
      experiment.run.results[index],
      copy.playback.labels.testPrefix + (index + 1) + copy.playback.labels.testSuffix,
    );
    if (!risky) return;
    sensor = 'lidar';
    sensorsOpen = true;
    update();
  },
  setReward(key, raw) {
    const reward = REWARDS.find((item) => item.key === key);
    experiment.draft.rewards[key] = Math.max(0, Math.min(reward.max, Number(raw) || 0));
    update();
  },
  enableReward(key, enabled) {
    experiment.draft.rewards.enabled[key] = enabled;
    update();
  },
  useRecommendedRewards() {
    experiment.draft.rewards = clone(DEFAULT_REWARD);
    update({ fresh: true });
    byId('rewardSettings').open = true;
  },
  setStartMode(mode) {
    experiment.draft.startMode = mode;
    update();
  },
  chooseImprovement(choice) {
    experiment.reflection.choice = choice;
    update();
  },
  setHypothesis(note) {
    experiment.reflection.note = note;
  },
  pressDrive(event, direction) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    command = DRIVE_COMMANDS[direction];
    manualPressed = direction;
    update();
  },
  releaseDrive() {
    command = [0, 0];
    manualPressed = null;
    update();
  },
  toggleEmergencyStop() {
    if (manualStopped) releaseManual();
    else stopManual(copy.manual.reasons.button);
  },
  leaveManual() {
    manual = false;
    command = [0, 0];
    manualPressed = null;
    stage = returnStage;
    playback = null;
    update({ fresh: true });
  },
};

// The lab page exists — hidden — from start-up, so its controls can be reached (by a script, or by
// a stray click while it is still hidden) before a mission has been opened. Every control needs an
// experiment; without one they do nothing instead of throwing and taking the whole site down.
const actions = Object.fromEntries(
  Object.entries(controls).map(([name, control]) => [
    name,
    (...args) => {
      if (experiment) control(...args);
    },
  ]),
);

// ---------------------------------------------------------------- wiring

function driveFromKeyboard(event) {
  if (supplementOpen || !labVisible() || !manual) return;
  const typing = TYPING_TAGS.includes(event.target.tagName);
  if (!manualStopped && DRIVE_KEYS[event.key] && !typing) {
    event.preventDefault();
    command = DRIVE_COMMANDS[DRIVE_KEYS[event.key]];
  }
  if (event.code === 'Space' && !typing && event.target.tagName !== 'BUTTON') {
    event.preventDefault();
    stopManual(copy.manual.reasons.keyboard);
  }
}

function stopEverything() {
  command = [0, 0];
  playing = false;
}

function init() {
  update();
  byId('arenaHost').append(arena);
  byId('cameraHost').append(camera);
  requestAnimationFrame(tick);
  document.addEventListener('keydown', driveFromKeyboard);
  document.addEventListener('keyup', (event) => {
    if (DRIVE_KEYS[event.key]) command = [0, 0];
  });
  window.addEventListener('blur', stopEverything);
  document.addEventListener('visibilitychange', stopEverything);
  document.addEventListener('open-lab', (event) => activateLab(event.detail.task));
  document.addEventListener('series-leave', stopEverything);
  document.addEventListener('rl-topic-change', stopEverything);
  document.addEventListener('supplement-open', () => {
    stopEverything();
    supplementOpen = true;
  });
  document.addEventListener('supplement-close', () => {
    supplementOpen = false;
  });
}

init();
