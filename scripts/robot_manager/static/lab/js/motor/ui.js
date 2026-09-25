import { render } from '../vendor/lit-html.js';
import { loadJson, loadText } from '../core/content.js';
import { downloadFile } from '../core/dom.js';
import { revealElement, revealIfHidden } from '../core/reveal.js';
import {
  MOTOR_TOPICS,
  PLAYED_TOPICS,
  ESC_KV,
  motorDefaults,
  simulateMotor,
  motorRunSummary,
  transmissionValues,
  kvSpeed,
  lipoCells,
  evaluateMotorChoices,
} from './core.js';
import { motorPage } from './view.js';

// Motor course (電気で回転を生み出す): state and behaviour. view.js turns the model into markup,
// render.js draws the figures, core.js simulates. Texts live in content/motor.json and
// content/motor/*.html. The course never talks to the robot: its last topic plans a measurement
// and points to the shared measurement lab (js/systems/measurement-lab.js) for the typed data.

const copy = await loadJson('content/motor.json');
const fragments = {
  hardware: await loadText('content/motor/hardware.html'),
  loadHelp: await loadText('content/motor/load-help.html'),
  brushHelp: await loadText('content/motor/brush-help.html'),
  realRos: await loadText('content/motor/real-ros.html'),
};

const PLAYBACK_MS_PER_SAMPLE = 20; // 301 samples of a 6-second run play back in real time
const NUMBER_SETTINGS = ['direction', 'power', 'load', 'ratio', 'voltage', 'throttle', 'target'];
const BOOLEAN_SETTINGS = ['loaded', 'feedback'];
const STRUCTURE_STEPS = 3;

// One state per topic, kept while the learner moves between topics.
const states = new Map(
  MOTOR_TOPICS.map((topic) => [
    topic.id,
    {
      config: motorDefaults(),
      result: null, // the run on screen
      previous: null, // the run before it that was watched to the end
      summary: null, // numbers of the run on screen once it has been watched to the end
      index: 0, // sample on screen
      dirty: false, // settings changed since the run on screen
      choices: {},
      checked: false,
      prediction: '',
      reflection: '',
      gearTurns: 0,
    },
  ]),
);

let topicId = MOTOR_TOPICS[0].id;
const structure = { step: 0, coil: 0 };
const playback = { playing: false, frame: 0, startTime: 0, startIndex: 0 };

const page = () => document.getElementById('motorPage');
const state = () => states.get(topicId);
const topicOf = (id) => MOTOR_TOPICS.find((topic) => topic.id === id);
const lastIndex = (result) => (result ? result.samples.length - 1 : 0);

// The sample drawn before a run: the motor at rest.
const RESTING_SAMPLE = Object.freeze({
  time: 0,
  angle: 0,
  degrees: 0,
  rpm: 0,
  current: 0,
  heating: 0,
  torque: 0,
  field: 0,
  reference: 0,
});

function runModel(current) {
  const result = current.result;
  return {
    result,
    previous: current.previous,
    summary: current.summary,
    index: current.index,
    last: lastIndex(result),
    sample: result ? result.samples[current.index] : RESTING_SAMPLE,
    playing: playback.playing,
    atEnd: Boolean(result) && current.index === lastIndex(result),
    dirty: current.dirty,
  };
}

function buildModel() {
  const current = state();
  const position = MOTOR_TOPICS.findIndex((topic) => topic.id === topicId);
  const group = topicOf(topicId).group;
  const voltage = current.config.voltage;
  return {
    topic: topicId,
    group,
    groupTopics: MOTOR_TOPICS.filter((topic) => topic.group === group).map((topic) => topic.id),
    position,
    total: MOTOR_TOPICS.length,
    next: MOTOR_TOPICS[position + 1]?.id ?? null,
    played: PLAYED_TOPICS.includes(topicId),
    config: current.config,
    run: runModel(current),
    structure: { ...structure },
    gear: { values: transmissionValues(current.config.ratio), turns: current.gearTurns },
    choose: {
      choices: current.choices,
      checked: current.checked,
      evaluation: evaluateMotorChoices(current.choices),
    },
    real: {
      part: current.config.part,
      prediction: current.prediction,
      reflection: current.reflection,
    },
    kv: { voltage, rpm: kvSpeed(ESC_KV, voltage), cells: lipoCells(voltage) },
  };
}

function update() {
  render(motorPage(buildModel(), copy, fragments, actions), page());
}

// Opening another topic rebuilds the page, so details, focus and scroll start fresh.
function rebuildPage() {
  render(null, page());
  update();
}

function openTopic(id) {
  if (!topicOf(id)) return;
  pause();
  topicId = id;
  rebuildPage();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

// --- Playback --------------------------------------------------------------------------------

function pause() {
  playback.playing = false;
  cancelAnimationFrame(playback.frame);
}

function pauseAndShow() {
  if (!playback.playing) return;
  pause();
  update();
}

// A run counts as watched once its last sample has been on screen; only then does it become the
// "previous run" of the next one and get its result sentence.
function finish(current) {
  if (!current.summary) current.summary = motorRunSummary(current.result);
}

function tick() {
  if (!playback.playing) return;
  const current = state();
  const elapsed = performance.now() - playback.startTime;
  const index = playback.startIndex + Math.floor(elapsed / PLAYBACK_MS_PER_SAMPLE);
  current.index = Math.min(lastIndex(current.result), index);
  if (current.index === lastIndex(current.result)) {
    pause();
    finish(current);
  } else playback.frame = requestAnimationFrame(tick);
  update();
}

function play() {
  const current = state();
  if (!current.result) return;
  if (current.index >= lastIndex(current.result)) current.index = 0;
  playback.startIndex = current.index;
  playback.startTime = performance.now();
  playback.playing = true;
  tick();
}

function run() {
  pause();
  const current = state();
  if (current.summary) current.previous = current.result;
  current.result = simulateMotor(topicId, current.config);
  current.summary = null;
  current.index = 0;
  current.dirty = false;
  update();
  // Press → see: on a phone the settings are under the figure, so bring the figure back up.
  revealIfHidden(document.getElementById('motorMain'));
  play();
}

// --- Settings --------------------------------------------------------------------------------

function parseSetting(key, value) {
  if (BOOLEAN_SETTINGS.includes(key)) return value === 'true';
  if (NUMBER_SETTINGS.includes(key)) return Number(value);
  return value;
}

function setSetting(key, value) {
  const current = state();
  current.config[key] = parseSetting(key, value);
  if (PLAYED_TOPICS.includes(topicId)) {
    pause();
    current.dirty = Boolean(current.result);
  }
  update();
}

// --- Structure (field topic) --------------------------------------------------------------------

function setStructure(step) {
  pause();
  structure.step = step;
  update();
}

function structureNext() {
  if (structure.step < STRUCTURE_STEPS - 1) {
    setStructure(structure.step + 1);
    document.getElementById('motorStructureNext')?.focus({ preventScroll: true });
    return;
  }
  revealElement(document.querySelector('#motorPage .motor-layout'));
  document.getElementById('motorRun')?.focus({ preventScroll: true });
}

// --- Real topic ----------------------------------------------------------------------------------

function planText() {
  const current = state();
  const text = copy.real;
  const plan = text.plans[current.config.part];
  return [
    text.fileHeading,
    plan.name,
    text.planLabels.change + plan.change,
    text.planLabels.record + plan.record,
    text.planLabels.compare + plan.compare,
    text.filePrediction + current.prediction,
    text.fileReflection + current.reflection,
  ].join('\n');
}

const actions = {
  openTopic,
  openGroup(group) {
    openTopic(MOTOR_TOPICS.find((topic) => topic.group === group).id);
  },
  next() {
    const position = MOTOR_TOPICS.findIndex((topic) => topic.id === topicId);
    const next = MOTOR_TOPICS[position + 1];
    if (next) openTopic(next.id);
    else document.dispatchEvent(new CustomEvent('quiz-open', { detail: 'motor' }));
  },
  run,
  togglePlay() {
    if (playback.playing) {
      pause();
      update();
    } else play();
  },
  seek(index) {
    pause();
    const current = state();
    current.index = Math.min(index, lastIndex(current.result));
    if (current.index === lastIndex(current.result)) finish(current);
    update();
  },
  setSetting,
  setStructure,
  structureNext,
  setCoil(current) {
    structure.coil = current;
    update();
  },
  turnGear(turns) {
    state().gearTurns = turns;
    update();
  },
  choose(job, value) {
    state().choices[job] = value;
    update();
  },
  checkChoices() {
    state().checked = true;
    update();
    revealIfHidden(document.getElementById('motorChoiceFeedback'));
  },
  write(field, value) {
    state()[field] = value;
  },
  savePlan() {
    // BOM so that text editors on Windows read UTF-8.
    downloadFile(copy.real.fileName, '﻿' + planText());
  },
  jumpToMeasurements() {
    revealElement(document.getElementById('measurementEntry'));
  },
};

function initMotor() {
  rebuildPage();
  document.addEventListener('series-leave', pauseAndShow);
  document.addEventListener('supplement-open', pauseAndShow);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseAndShow();
  });
}

function reviewMotor(id) {
  openTopic(topicOf(id) ? id : MOTOR_TOPICS[0].id);
  return true;
}

export { initMotor, reviewMotor };
