import { render } from '../vendor/lit-html.js';
import { loadJson } from '../core/content.js';
import { downloadFile } from '../core/dom.js';
import { SYSTEM_COURSES, SYSTEM_TOPICS, SYSTEM_REAL, systemDefaults } from './data.js';
import {
  simulateSystem,
  systemCSV,
  calibrationPairs,
  fitCameraTransform,
  canRestart,
  stopCause,
  groupEvents,
  compareRuns,
} from './core.js';
import { systemState } from './narration.js';
import { systemPage, initialChart, chartChoices } from './view.js';
import { reportLessonProgress } from '../shell/lesson-progress.js';

// The six "systems" courses (mechanics, tracking, timing, coordination, behavior, diagnostics)
// share one page: state and behaviour live here, view.js turns the model into markup, render.js
// draws scenes and charts, core.js simulates. Texts live in content/systems/ui.json.

const copy = await loadJson('content/systems/ui.json');

const MAX_FRAME_STEP = 0.1; // seconds of experiment time per animation frame (tab was hidden)
const REPLAY_LEAD = 0.8; // seconds before a transition at which its replay starts
const MAX_HISTORY = 12; // finished runs kept per topic
const MAX_EVENTS_SHOWN = 6;
const TIME_EPSILON = 1e-8; // seconds; sample times are multiples of 0.05 with rounding noise
const CAMERA_KEYS = ['cameraX', 'cameraZ', 'cameraAngle'];
const NARROW_FIGURE = 560; // px; below this width figures use their narrow layout
const WAITING_BOOST = 4; // playback runs this many times faster while the robot only waits
const MAX_BOOSTED_SPEED = 4;
const SEEK_KEYS = [
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
];

// One experiment per topic, kept while the learner moves between topics and courses.
const experiments = new Map();
// Per course: the topic shown, and the page-level state that starts fresh when the page is rebuilt
// (edited-but-not-started settings, notes, the stop-release checklist, calibration messages).
const selectedTopic = new Map(
  SYSTEM_COURSES.map((course) => [course.id, SYSTEM_TOPICS[course.id][0].id]),
);
const pages = new Map();

let active = null; // experiment whose playback owns the animation frame
let frameRequest = 0;
let lastFrameTime = 0;

const pageElement = (course) => document.getElementById(course + 'Page');
const topicsOf = (course) => SYSTEM_TOPICS[course];
const topicOf = (course, id) => topicsOf(course).find((topic) => topic.id === id);
const lastIndex = (run) => run.samples.length - 1;
const latchedAtEnd = (run) => Boolean(run?.samples.at(-1).latched);
const roundToHundredth = (value) => Math.round(value * 100) / 100;

function experiment(course, id) {
  const key = course + '/' + id;
  if (!experiments.has(key))
    experiments.set(key, {
      course,
      id,
      config: systemDefaults(course, id),
      run: null,
      previous: null, // the run before this one, drawn dashed for comparison
      index: 0, // sample currently shown
      elapsed: 0, // seconds of experiment time reached by playback
      playing: false,
      completed: false,
      released: false, // a latched stop was released by the learner
      speed: 1,
      chart: initialChart(course, id),
      history: [],
      pairs: null, // calibration measurements (coordination/calibrate)
    });
  return experiments.get(key);
}

const current = (course) => experiment(course, selectedTopic.get(course));

function freshPage(state) {
  return {
    draft: { ...state.config }, // settings as edited in the form, applied when a run starts
    note: 'before', // 'before' | 'changed' | 'running'
    cleared: false, // the learner picked the recorded cause of the latched stop
    picked: null, // the cause the learner picked, right or wrong
    releaseMessageShown: false,
    // The checklist card stays on screen after the stop is released, so the learner can read the
    // confirmation; it is taken down only when the next run starts or ends.
    restartVisible: releaseNeeded(state),
    fitted: null, // camera settings found from the calibration pairs
    figure: null, // { sceneWidth, chartWidth } the figures were last drawn at
  };
}

// A run needs releasing when it ended in a latched stop that the learner has not cleared yet.
const releaseNeeded = (state) => state.completed && latchedAtEnd(state.run) && !state.released;

// Called where the run as a whole changes (page rebuilt, run started, run finished): the result,
// the checklist card and the saved records follow the run, not every frame.
function syncRunPanels(state) {
  const page = pages.get(state.course);
  page.cleared = false;
  page.picked = null;
  page.restartVisible = releaseNeeded(state);
}

// Figures are drawn at the width they are shown. Until the page has been laid out (or while it
// is hidden) the widths are estimated from the window.
function figureWidths(course) {
  const page = pages.get(course);
  const measured = measureFigures(course);
  if (measured) return measured;
  if (page.figure) return page.figure;
  const estimate = Math.max(300, Math.min(790, window.innerWidth - 32));
  return { sceneWidth: estimate, chartWidth: estimate - 36 };
}

function measureFigures(course) {
  const root = pageElement(course);
  const scene = root?.querySelector('[data-sys-scene]')?.clientWidth ?? 0;
  const chart = root?.querySelector('[data-sys-chartview]')?.clientWidth ?? 0;
  if (!scene || !chart) return null;
  return { sceneWidth: scene, chartWidth: chart };
}

// While the delivery robot only stands and waits, playback runs faster so the learner does not
// watch nothing happen for ten seconds.
function waitingBoost(state) {
  if (state.course !== 'behavior' || !state.run) return false;
  const sample = state.run.samples[state.index];
  const before = state.run.samples[state.index - 1];
  return Boolean(before) && sample.waitTotal > before.waitTotal && state.speed < MAX_BOOSTED_SPEED;
}

function buildModel(course) {
  const state = current(course);
  const page = pages.get(course);
  const topics = topicsOf(course);
  const topic = topicOf(course, state.id);
  const started = Boolean(state.run);
  const run = state.run || simulateSystem(course, state.id, state.config); // preview before a run
  const sample = run.samples[state.index];
  const figure = page.figure ?? figureWidths(course);
  return {
    course,
    meta: SYSTEM_COURSES.find((entry) => entry.id === course),
    topics,
    topic,
    real: SYSTEM_REAL[course],
    run,
    sample,
    index: state.index,
    started,
    playing: state.playing,
    completed: state.completed,
    finished: state.completed && state.index === lastIndex(run),
    atEnd: state.index === lastIndex(run),
    speed: state.speed,
    drive: systemState(run, state.index, started),
    fastForward: state.playing && waitingBoost(state),
    figure: {
      ...figure,
      narrow: figure.sceneWidth < NARROW_FIGURE,
      started,
      // The calibration scene shows where the settings being edited would put the markers.
      settings: page.draft,
    },
    chartIndex: state.chart,
    chartChoices: chartChoices(course, state.id),
    previous: state.previous,
    events: started
      ? groupEvents(run.events.filter((event) => event.t <= sample.t + TIME_EPSILON)).slice(
          -MAX_EVENTS_SHOWN,
        )
      : [],
    draft: page.draft,
    note: page.note,
    releaseNeeded: releaseNeeded(state),
    calibration:
      course === 'coordination' && state.id === 'calibrate'
        ? { pairs: state.pairs, fitted: page.fitted }
        : null,
    result: state.completed ? resultModel(state, topic) : null,
    restart: {
      visible: page.restartVisible,
      released: state.released,
      cause: state.completed ? stopCause(run) : null,
      picked: page.picked,
      cleared: page.cleared,
      releaseEnabled: page.cleared && !state.released,
      messageShown: page.releaseMessageShown,
    },
    history: state.history,
  };
}

function resultModel(state, topic) {
  const previous = state.previous;
  const changed = previous
    ? Object.keys(state.config)
        .filter((key) => state.run.config[key] !== previous.config[key])
        .map((key) => topic.controls.find((control) => control.key === key).label)
    : [];
  return {
    outcome: state.run.outcome,
    comparison: compareRuns(state.run, previous),
    metrics: state.run.metrics,
    previous,
    changed,
  };
}

const sameWidths = (a, b) =>
  Boolean(a && b) &&
  Math.abs(a.sceneWidth - b.sceneWidth) < 1 &&
  Math.abs(a.chartWidth - b.chartWidth) < 1;

function update(course) {
  const root = pageElement(course);
  if (!root) return;
  const page = pages.get(course);
  page.figure = figureWidths(course);
  render(systemPage(buildModel(course), copy, actionsOf(course)), root);
  reportLessonProgress(course, {
    topics: topicsOf(course).map((topic) => ({ id: topic.id, title: topic.label })),
    current: selectedTopic.get(course),
    open: (id) => reviewSystem(course, id),
  });
  // The first drawing (or one after a resize) may have been made at an estimated width.
  const measured = measureFigures(course);
  if (measured && !sameWidths(measured, page.figure)) {
    page.figure = measured;
    render(systemPage(buildModel(course), copy, actionsOf(course)), root);
  }
}

// A topic page is rebuilt from scratch so details, focus and the edited settings start fresh.
function rebuild(course) {
  pages.set(course, freshPage(current(course)));
  render(null, pageElement(course));
  update(course);
}

function stopPlayback() {
  if (active) active.playing = false;
  cancelAnimationFrame(frameRequest);
  lastFrameTime = 0;
}

function pause() {
  stopPlayback();
  if (active) update(active.course);
}

function play(state) {
  state.playing = true;
  active = state;
  lastFrameTime = 0;
  update(state.course);
  scrollToScene(state.course);
  tick();
}

function scrollToScene(course) {
  pageElement(course).querySelector('.sys-live-head').scrollIntoView({ block: 'start' });
}

function tick(stamp) {
  if (!active?.playing) return;
  const state = active;
  const run = state.run;
  const boost = waitingBoost(state) ? WAITING_BOOST : 1;
  if (stamp !== undefined && lastFrameTime)
    state.elapsed += Math.min((stamp - lastFrameTime) / 1000, MAX_FRAME_STEP) * state.speed * boost;
  lastFrameTime = stamp ?? 0;
  while (state.index + 1 < run.samples.length && run.samples[state.index + 1].t <= state.elapsed)
    state.index++;
  if (state.index === lastIndex(run)) {
    state.playing = false;
    complete(state);
  }
  update(state.course);
  if (state.playing) frameRequest = requestAnimationFrame(tick);
}

function complete(state) {
  if (state.completed) return;
  state.completed = true;
  state.history.push(state.run);
  if (state.history.length > MAX_HISTORY) state.history.shift();
  syncRunPanels(state);
}

function start(state) {
  pause();
  const page = pages.get(state.course);
  page.note = 'running';
  if (state.completed) state.previous = state.run;
  state.run = simulateSystem(state.course, state.id, state.config);
  state.completed = false;
  state.released = false;
  state.index = 0;
  state.elapsed = 0;
  syncRunPanels(state);
  play(state);
}

function replayTransition(state) {
  const event = systemState(state.run, state.index)?.event;
  if (!event) return;
  pause();
  state.elapsed = Math.max(0, event.t - REPLAY_LEAD);
  state.index = state.run.samples.findLastIndex((sample) => sample.t <= state.elapsed);
  state.speed = 1;
  play(state);
}

function togglePlay(state) {
  if (state.playing) {
    pause();
    return;
  }
  if (!state.run) return;
  if (state.index === lastIndex(state.run)) {
    state.elapsed = 0;
    state.index = 0;
  }
  state.playing = true;
  active = state;
  lastFrameTime = 0;
  tick();
}

function seekTo(state, requested) {
  if (!state.run) return;
  stopPlayback();
  state.index = Math.max(0, Math.min(lastIndex(state.run), Math.round(requested)));
  state.elapsed = state.run.samples[state.index].t;
  if (state.index === lastIndex(state.run)) complete(state);
  update(state.course);
}

function validNumber(raw, control) {
  const text = String(raw);
  const value = Number(text);
  return text !== '' && Number.isFinite(value) && value >= control.min && value <= control.max;
}

// Applies the edited settings and starts a run; an out-of-range number shows the browser's
// validation message instead (and nothing is applied).
function submitSettings(state, form) {
  const page = pages.get(state.course);
  const topic = topicOf(state.course, state.id);
  const applied = {};
  for (const control of topic.controls) {
    const raw = page.draft[control.key];
    if (control.type === 'number' && !validNumber(raw, control)) {
      form.querySelector(`[data-setting="${control.key}"]`).reportValidity();
      return;
    }
    applied[control.key] = control.type === 'number' ? Number(raw) : raw;
  }
  Object.assign(state.config, applied);
  start(state);
}

function fitCamera(state) {
  if (!state.pairs) return;
  const page = pages.get(state.course);
  const fit = fitCameraTransform(state.pairs);
  for (const key of CAMERA_KEYS) {
    state.config[key] = roundToHundredth(fit[key]);
    page.draft[key] = state.config[key];
  }
  page.fitted = Object.fromEntries(CAMERA_KEYS.map((key) => [key, state.config[key]]));
}

function release(state) {
  const page = pages.get(state.course);
  if (!canRestart(latchedAtEnd(state.run), page.cleared, true)) return;
  state.released = true;
  page.releaseMessageShown = true;
}

function showRestart(course) {
  const root = pageElement(course);
  root.querySelector('[data-sys-restart]').scrollIntoView({ behavior: 'smooth', block: 'center' });
  root.querySelector('[data-sys-cause]').focus({ preventScroll: true });
}

function pickCause(state, id) {
  const page = pages.get(state.course);
  const cause = stopCause(state.run);
  page.picked = id;
  page.cleared = Boolean(cause) && cause.id === id;
}

function saveCsv(state) {
  if (!state.run || !state.completed) return;
  const name = `QUESTiX-${state.course}-${state.id}.csv`;
  downloadFile(name, '﻿' + systemCSV(state.run), 'text/csv;charset=utf-8');
}

const actionSets = new Map();

function actionsOf(course) {
  if (!actionSets.has(course)) actionSets.set(course, createActions(course));
  return actionSets.get(course);
}

function createActions(course) {
  const state = () => current(course);
  const page = () => pages.get(course);
  const refresh = () => update(course);
  return {
    openTopic: (id) => reviewSystem(course, id),
    refresh,
    togglePlay: () => togglePlay(state()),
    replayTransition: () => replayTransition(state()),
    setSpeed(speed) {
      state().speed = speed;
    },
    selectChart(index) {
      state().chart = index;
      refresh();
    },
    holdPlayback() {
      if (state().run) stopPlayback();
    },
    seekByKey(event) {
      if (state().run && SEEK_KEYS.includes(event.key)) stopPlayback();
    },
    seek: (value) => seekTo(state(), value),
    editSetting(key, value) {
      page().draft[key] = value;
      page().note = 'changed';
      refresh();
    },
    submitSettings(event) {
      event.preventDefault();
      if (state().playing || releaseNeeded(state())) return;
      submitSettings(state(), event.target);
    },
    showRestart: () => showRestart(course),
    pickCause(id) {
      pickCause(state(), id);
      refresh();
    },
    quickRun() {
      if (state().playing || releaseNeeded(state())) return;
      submitSettings(state(), pageElement(course).querySelector('[data-sys-form]'));
    },
    showSettings(event) {
      event.preventDefault();
      pageElement(course)
        .querySelector('.sys-settings')
        .scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    release() {
      release(state());
      refresh();
    },
    measurePairs() {
      state().pairs = calibrationPairs();
      refresh();
    },
    fitCamera() {
      fitCamera(state());
      refresh();
    },
    saveCsv: () => saveCsv(state()),
  };
}

let resizeRequest = 0;

// Figures follow the width of the page (a rotated phone, a resized window).
function redrawAfterResize() {
  cancelAnimationFrame(resizeRequest);
  resizeRequest = requestAnimationFrame(() => {
    for (const course of SYSTEM_COURSES)
      if (pageElement(course.id) && !pageElement(course.id).hidden) update(course.id);
  });
}

function initSystems() {
  for (const course of SYSTEM_COURSES) rebuild(course.id);
  for (const name of ['series-leave', 'supplement-open']) document.addEventListener(name, pause);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });
  window.addEventListener('resize', redrawAfterResize);
}

function activateSystem(course) {
  if (!SYSTEM_TOPICS[course]) return;
  active = current(course);
  update(course);
}

function reviewSystem(course, id) {
  if (!SYSTEM_TOPICS[course]?.some((topic) => topic.id === id)) return false;
  pause();
  selectedTopic.set(course, id);
  rebuild(course);
  active = current(course);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  return true;
}

export { initSystems, activateSystem, reviewSystem };
