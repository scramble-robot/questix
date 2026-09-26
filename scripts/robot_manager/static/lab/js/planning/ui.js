import { render } from '../vendor/lit-html.js';
import { loadJson, loadText } from '../core/content.js';
import { downloadFile } from '../core/dom.js';
import {
  PLAN_TOPICS,
  planningDefaults,
  planningMap,
  planningClearance,
  planningExperiment,
  planningCSV,
} from './core.js';
import { PLAN_PLOT, drawPlanning, noGoReach } from './render.js';
import { planningPage } from './view.js';
import { createRoom } from './room-ui.js';
import { onLiveLink } from '../live/capture.js';
import { openRobotDialog } from '../live/live-ui.js';
import { revealIfHidden } from '../core/reveal.js';
import { reportLessonProgress } from '../shell/lesson-progress.js';

// Path-planning course: state and behaviour. view.js turns the model into markup, render.js draws
// the map, core.js plans and simulates. Texts live in content/planning.json.

const copy = await loadJson('content/planning.json');
const hardwareHtml = await loadText('content/planning/hardware.html');

const SAMPLE_PERIOD = 0.04; // seconds of simulated time between recorded samples
const MAX_WAYPOINTS = 10;
const MAX_RECORDS = 5;
const MIN_WAYPOINT_CLEARANCE = 0.01; // metres
const CURSOR_STEP = 0.1; // metres per arrow key
const CURSOR_BOUNDS = { minX: 0.1, maxX: 5.9, minY: 0.1, maxY: 3.9 };
const EXAMPLE_ROUTES = {
  near: [
    { x: 2.25, y: 1.1 },
    { x: 3.75, y: 1.1 },
  ],
  wide: [
    { x: 1.9, y: 0.8 },
    { x: 4.1, y: 0.8 },
  ],
};
const ARROW_KEYS = {
  ArrowLeft: [-CURSOR_STEP, 0],
  ArrowRight: [CURSOR_STEP, 0],
  ArrowUp: [0, -CURSOR_STEP],
  ArrowDown: [0, CURSOR_STEP],
};

// One experiment per topic, kept while the learner moves between topics.
const experiments = new Map(
  PLAN_TOPICS.map((topic) => [
    topic.id,
    {
      config: planningDefaults(topic.id),
      run: null,
      index: 0, // sample currently shown
      observed: 0, // furthest sample the learner has watched; seeking stays within it
      complete: false,
      newPlanSeen: false, // the pause at the re-planning moment happens once per run
      records: [],
    },
  ]),
);

let topicId = 'draw';
let status = copy.topics.draw.initialStatus;
let countedRun = null; // run whose searched-cell count is shown
let showSearch = false;
let cursor = { x: 1.8, y: 0.8 };
const playback = { playing: false, frame: 0, startTime: 0, startIndex: 0, speed: 1 };

// --- the measured room -----------------------------------------------------------------------

// A new or changed room map makes the run on screen belong to other conditions: it is cleared,
// and the key goes into the room topic's conditions (see planningDefaults).
const room = createRoom({
  copy,
  changed(key) {
    const current = experiments.get('room');
    current.config.room = key;
    if (topicId === 'room') pause();
    resetRun(current, null);
    if (topicId === 'room') status = firstStatus('room');
  },
  update: () => {
    if (topicId === 'room') update();
  },
});

// What to do first in a topic; the room topic says so once its map exists.
function firstStatus(id) {
  const topic = copy.topics[id];
  return id === 'room' && room.map ? topic.readyStatus : topic.initialStatus;
}

const page = () => document.getElementById('planningPage');
const experiment = () => experiments.get(topicId);
const lastIndex = (run) => run.samples.length - 1;

function conditionsChanged(current) {
  return (
    Boolean(current.run) && JSON.stringify(current.config) !== JSON.stringify(current.run.config)
  );
}
function awaitingNewPlan(current) {
  const run = current.run;
  return Boolean(run?.newPlan) && current.index === run.eventIndex && !current.newPlanSeen;
}

function buildModel() {
  const current = experiment();
  const run = current.run;
  return {
    topic: topicId,
    config: current.config,
    run,
    index: current.index,
    observed: current.observed,
    records: current.records,
    sample: run?.samples[current.index],
    finishedRun: current.complete ? run : null,
    finished: current.complete && Boolean(run) && current.index === lastIndex(run),
    atEnd: Boolean(run) && current.index >= lastIndex(run),
    canPlay: Boolean(run) && run.samples.length >= 2,
    resumable: Boolean(run) && !current.complete && !conditionsChanged(current),
    awaitingNewPlan: awaitingNewPlan(current),
    playing: playback.playing,
    speed: playback.speed,
    status: conditionsChanged(current) ? copy.status.stale : status,
    showSearch,
    noGoShown: noGoReach(topicId, current.config, run?.plan, run) > 0,
    countedRun,
    room: room.model(),
  };
}

function drawMap() {
  const canvas = document.getElementById('planningCanvas');
  if (!canvas) return;
  const current = experiment();
  drawPlanning(canvas, {
    topic: topicId,
    config: current.config,
    run: current.run,
    index: current.index,
    showSearch,
    cursor,
    room: topicId === 'room' ? room.drawing : null,
  });
}

function update() {
  render(planningPage(buildModel(), copy, hardwareHtml, actions), page());
  reportLessonProgress('planning', {
    topics: PLAN_TOPICS.map((topic) => ({ id: topic.id, title: topic.label })),
    current: topicId,
    open: openTopic,
  });
  drawMap();
}

// A topic page is rebuilt from scratch so details, focus and scroll start fresh, as learners expect
// when they open another experiment.
function openTopic(id) {
  pause();
  topicId = id;
  const current = experiment();
  countedRun = current.complete ? current.run : null;
  if (current.complete) status = finishedStatus(current.run);
  else status = current.run ? copy.status.resumable : firstStatus(id);
  render(null, page());
  update();
}

function finishedStatus(run) {
  const advice = run.status === 'contact' ? copy.status.finishedContact : copy.status.finished;
  return `${copy.results.names[run.status]}。${advice}`;
}

function pause() {
  playback.playing = false;
  cancelAnimationFrame(playback.frame);
}

function finish() {
  const current = experiment();
  if (current.complete) return;
  current.complete = true;
  current.records.push(current.run);
  if (current.records.length > MAX_RECORDS) current.records.shift();
  status = finishedStatus(current.run);
  countedRun = current.run;
}

function play() {
  const current = experiment();
  if (!current.run || current.run.samples.length < 2) return;
  if (current.index >= lastIndex(current.run)) {
    current.index = 0;
    current.newPlanSeen = false;
  } else if (current.index === current.run.eventIndex) current.newPlanSeen = true;
  playback.startIndex = current.index;
  playback.startTime = performance.now();
  playback.playing = true;
  tick();
}

function tick() {
  const current = experiment();
  const run = current.run;
  if (!playback.playing || !run) return;
  const elapsed = (performance.now() - playback.startTime) / 1000;
  let next = Math.min(
    lastIndex(run),
    playback.startIndex + Math.floor((elapsed * playback.speed) / SAMPLE_PERIOD),
  );
  const reachedNewPlan =
    run.newPlan && !current.newPlanSeen && run.eventIndex !== null && next >= run.eventIndex;
  if (reachedNewPlan) next = run.eventIndex;
  current.index = next;
  current.observed = Math.max(current.observed, next);
  if (reachedNewPlan) {
    pause();
    status = copy.status.replanned;
  } else if (next === lastIndex(run)) {
    pause();
    finish();
  } else playback.frame = requestAnimationFrame(tick);
  update();
}

function resetRun(current, run) {
  current.run = run;
  current.index = 0;
  current.observed = 0;
  current.complete = false;
  current.newPlanSeen = false;
}

function startRun() {
  pause();
  const current = experiment();
  if (topicId === 'room' && !room.map) return;
  resetRun(current, planningExperiment(current.config, topicId === 'room' ? room.map : undefined));
  status = copy.status.running;
  if (current.run.samples.length === 1) {
    finish();
    update();
  } else play();
}

function redraw() {
  pause();
  resetRun(experiment(), null);
  status = copy.status.editing;
}

function addWaypoint(point) {
  const current = experiment();
  if (topicId !== 'draw') return;
  if (current.run) status = copy.status.redrawFirst;
  else if (planningClearance(point, planningMap(topicId)) <= MIN_WAYPOINT_CLEARANCE)
    status = copy.status.pointOnObstacle;
  else if (current.config.points.length >= MAX_WAYPOINTS) status = copy.status.tooManyPoints;
  else {
    const toCentimetre = (metres) => Math.round(metres * 100) / 100;
    current.config.points.push({ x: toCentimetre(point.x), y: toCentimetre(point.y) });
    status = current.config.points.length + copy.status.pointsAdded;
  }
  update();
}

function undoWaypoint() {
  const current = experiment();
  if (current.run) redraw();
  current.config.points.pop();
  update();
}

function canvasToMap(event) {
  const box = event.currentTarget.getBoundingClientRect();
  return {
    x: (((event.clientX - box.left) / box.width) * PLAN_PLOT.width - PLAN_PLOT.x) / PLAN_PLOT.k,
    y: (((event.clientY - box.top) / box.height) * PLAN_PLOT.height - PLAN_PLOT.y) / PLAN_PLOT.k,
  };
}

function moveCursor([dx, dy]) {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  cursor = {
    x: clamp(cursor.x + dx, CURSOR_BOUNDS.minX, CURSOR_BOUNDS.maxX),
    y: clamp(cursor.y + dy, CURSOR_BOUNDS.minY, CURSOR_BOUNDS.maxY),
  };
  drawMap();
}

const actions = {
  openTopic,
  runOrResume() {
    const current = experiment();
    if (current.run && !current.complete && !conditionsChanged(current)) play();
    else startRun();
    // Press → see: on a phone the conditions card sits above the map, so bring the map on screen.
    revealIfHidden(document.getElementById('planningCanvas'));
  },
  togglePlay() {
    if (playback.playing) {
      pause();
      update();
    } else play();
  },
  seek(index) {
    pause();
    const current = experiment();
    current.index = Math.min(current.observed, index);
    update();
  },
  setSpeed(speed) {
    playback.speed = speed;
    if (!playback.playing) return;
    playback.startIndex = experiment().index;
    playback.startTime = performance.now();
  },
  setCondition(key, value) {
    pause();
    const current = experiment();
    current.config[key] = value;
    if (!current.run) status = copy.status.changed;
    update();
  },
  showSearch(visible) {
    showSearch = visible;
    update(); // the map's key names the searched cells while they are shown
  },
  redraw() {
    redraw();
    update();
  },
  undoPoint: undoWaypoint,
  clearPoints() {
    redraw();
    experiment().config.points = [];
    update();
  },
  useExample(name) {
    redraw();
    experiment().config.points = EXAMPLE_ROUTES[name].map((point) => ({ ...point }));
    status = name === 'near' ? copy.status.exampleNear : copy.status.exampleWide;
    update();
  },
  clickMap(event) {
    if (topicId === 'room') room.place(canvasToMap(event));
    else addWaypoint(canvasToMap(event));
  },
  keyOnMap(event) {
    if (ARROW_KEYS[event.key]) moveCursor(ARROW_KEYS[event.key]);
    else if (event.key === 'Enter') addWaypoint(cursor);
    else if (event.key === 'Backspace') undoWaypoint();
    else return;
    event.preventDefault();
  },
  saveCsv() {
    const name = `QUESTiX-LAB-経路計画-${topicId}.csv`;
    downloadFile(name, planningCSV(experiment().run), 'text/csv;charset=utf-8');
  },
  saveHardwareGuide() {
    const procedure = document.getElementById('planningHardware').innerText;
    downloadFile('QUESTiX-LAB-経路計画-実機手順.txt', procedure + copy.hardwareGuideReferences);
  },
  openLink: openRobotDialog,
  ...room.actions,
};

function pauseAndShow() {
  if (!playback.playing) return;
  pause();
  update();
}

function initPlanning() {
  room.restore(); // the room measured before a reload, as far as this browser kept it
  openTopic(topicId);
  onLiveLink(() => {
    if (topicId === 'room' && !page().hidden) update();
  });
  document.addEventListener('series-leave', pauseAndShow);
  document.addEventListener('supplement-open', pauseAndShow);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseAndShow();
  });
  window.addEventListener('resize', drawMap);
}

function activatePlanning() {
  openTopic(topicId);
}

function reviewPlanning(id) {
  if (!PLAN_TOPICS.some((topic) => topic.id === id)) return false;
  openTopic(id);
  return true;
}

export { initPlanning, activatePlanning, reviewPlanning };
