import { render } from '../vendor/lit-html.js';
import { loadJson, loadText } from '../core/content.js';
import { downloadFile, formatNumber } from '../core/dom.js';
import {
  LAUNCH_TOPICS,
  LAUNCH_TARGETS,
  launchHit,
  launchExperiment,
  launchEstimate,
  launchGroups,
  launchParseCSV,
  launchCSV,
} from './core.js';
import { drawLaunch, drawLaunchRobot } from './render.js';
import { launchPage } from './view.js';
import { fillSentence } from '../core/content.js';

// Disc-launcher course: state and behaviour. view.js turns the model into markup, render.js draws
// the flight and the charts, core.js simulates and estimates. Texts live in content/launch.json.

const copy = await loadJson('content/launch.json');
const fragments = {
  reflections: {
    power: await loadText('content/launch/reflection-power.html'),
    forces: await loadText('content/launch/reflection-forces.html'),
    target: await loadText('content/launch/reflection-target.html'),
  },
  measureReflection: await loadText('content/launch/measure-reflection.html'),
};

const PLAYBACK_RATE = 0.2; // simulated seconds per real second: the flight is shown 5x slower
const ARROW_MOMENT = 0.5; // share of the flight time where 「矢印を見る」 stops the disc
const CHART_GUTTER = 44; // px of the card the record chart leaves to its padding
const CHART_MIN_WIDTH = 300; // px
const CHART_MAX_WIDTH = 820; // px
const MAX_RECORDS = 60; // launches kept per topic
const MAX_MEASUREMENTS = 300; // rows of real-robot measurements
const MAX_CSV_BYTES = 100000;
const DEFAULT_POWER = 40; // percent
const DEFAULT_MEASUREMENT_TARGET = 1.6; // metres
const FIRST_SEED = 104; // the seeded release-speed variation makes the target topic repeatable
const MEASUREMENT_CSV_TEMPLATE = '﻿output_pct,range_m\n'; // BOM so spreadsheets read UTF-8
const CSV_TYPE = 'text/csv;charset=utf-8';
const EXAMPLE_MEASUREMENTS = [
  { power: 30, range: 0.7 },
  { power: 30, range: 0.8 },
  { power: 50, range: 1.25 },
  { power: 50, range: 1.4 },
  { power: 70, range: 1.85 },
  { power: 70, range: 2.0 },
];

// One experiment per topic, kept while the learner moves between topics. `records` holds only
// launches that landed, newest last.
const experiments = new Map(
  LAUNCH_TOPICS.map((topic) => [
    topic.id,
    {
      power: DEFAULT_POWER,
      run: null,
      index: 0, // sample currently shown
      observed: 0, // furthest sample the learner has watched; seeking stays within it
      complete: false,
      records: [],
    },
  ]),
);

let topicId = 'power';
let status = copy.status.initial;
let seed = FIRST_SEED;
let targetIndex = 0;
const hitTargets = new Set(); // indices into LAUNCH_TARGETS
let showForces = true;
let showReference = true;
// `stopAt`: a flight time (s) at which playback pauses by itself (「矢印を見る」), or null.
const playback = { playing: false, frame: 0, startTime: 0, startOffset: 0, stopAt: null };
let chartWidth = CHART_MAX_WIDTH;
const measurements = {
  // 'measured' (the learner's rows) or 'example'; the example is shown until there are real rows.
  source: 'example',
  measured: [],
  target: DEFAULT_MEASUREMENT_TARGET,
  importStatus: '',
};

const page = () => document.getElementById('launchPage');
const experiment = () => experiments.get(topicId);
const lastIndex = (run) => run.samples.length - 1;
const currentTarget = () => (topicId === 'target' ? LAUNCH_TARGETS[targetIndex] : null);
// `target` is the target of that launch (null outside the target topic): the chart rings a hit.
const recordRows = (records) =>
  records.map((run) => ({ power: run.config.power, range: run.range, target: run.target }));

// Where the disc came down relative to the target of that launch (null when there was none).
function landingOutcome(run) {
  if (run.status !== 'landed') return { released: false, run, error: null, hit: false };
  const error = run.target === null ? null : run.range - run.target;
  const hit = error !== null && launchHit(run.range, run.target);
  return { released: true, run, error, hit };
}

function outcomeLabel({ error, hit }) {
  if (error === null) return copy.results.landed;
  if (hit) return copy.results.hit;
  return error < 0 ? copy.results.short : copy.results.long;
}

function landingAdvice(outcome) {
  if (topicId !== 'target') return copy.topics[topicId].afterLanding;
  if (!outcome.hit) return copy.topics.target.afterMiss;
  if (hitTargets.size === LAUNCH_TARGETS.length) return copy.topics.target.afterHitAll;
  return copy.topics.target.afterHit;
}

function finishedStatus(outcome) {
  if (!outcome.released) return copy.status.notReleased;
  return `${outcomeLabel(outcome)}。${landingAdvice(outcome)}`;
}

// The line under the flight follows what is on screen: while the disc is shown mid-flight (paused
// or dragged back with the slider) it says where the disc is, not how the launch ended.
function statusText() {
  const current = experiment();
  const run = current.run;
  if (!run || run.status !== 'landed') return status;
  if (playback.playing) return copy.status.running;
  if (current.index >= lastIndex(run)) return status;
  const sample = run.samples[current.index];
  return fillSentence(copy.status.pausedAt, {
    time: formatNumber(sample.t, 2),
    distance: formatNumber(sample.x, 2),
    height: formatNumber(sample.z * 100, 0),
  });
}

function measurementModel() {
  const measuredShown = measurements.source === 'measured';
  const rows = measuredShown ? measurements.measured : EXAMPLE_MEASUREMENTS;
  const target = measurements.target;
  return {
    source: measurements.source,
    rows,
    estimate: launchEstimate(rows, target),
    target,
    chartTarget: Number.isFinite(target) && target > 0 ? target : null,
    editable: measuredShown,
    canRemove: measuredShown && measurements.measured.length > 0,
    importStatus: measurements.importStatus,
  };
}

function buildModel() {
  const current = experiment();
  const run = current.run;
  const rows = recordRows(current.records);
  const target = currentTarget();
  const pending = Boolean(run) && !current.complete;
  return {
    topic: topicId,
    power: current.power,
    run,
    sample: run?.samples[current.index],
    index: current.index,
    observed: current.observed,
    playing: playback.playing,
    pending,
    canPlay: Boolean(run) && run.samples.length >= 2,
    atEnd: Boolean(run) && current.index === lastIndex(run),
    status: statusText(),
    chartWidth,
    result: current.complete ? landingOutcome(run) : null,
    rows,
    target,
    estimate: topicId === 'target' ? launchEstimate(rows, target) : null,
    hitCount: hitTargets.size,
    canAdvanceTarget: !playback.playing && !pending && hitTargets.has(targetIndex),
    lastTarget: targetIndex === LAUNCH_TARGETS.length - 1,
    showForces,
    showReference,
    measurement: topicId === 'measure' ? measurementModel() : null,
  };
}

function drawFlight() {
  const canvas = document.getElementById('launchFlight');
  if (!canvas) return;
  const current = experiment();
  const run = current.run;
  const inForcesTopic = topicId === 'forces';
  drawLaunch(canvas, {
    run,
    index: current.index,
    reference: inForcesTopic && showReference && run ? run.reference : null,
    forces: inForcesTopic && showForces,
    target: run?.target ?? currentTarget(),
    previous: topicId === 'power' ? previousLanding(current) : null,
    copy: copy.scene,
  });
}

// The record chart is laid out at the width of its card, so its text is not shrunk on a phone.
// Returns whether the width changed (the chart then has to be drawn again).
function measureChartWidth() {
  const container = document.querySelector('#launchPage .launch-data');
  if (!container?.clientWidth) return false; // hidden page: keep the last width
  const available = container.clientWidth - CHART_GUTTER;
  const width = Math.round(Math.max(CHART_MIN_WIDTH, Math.min(CHART_MAX_WIDTH, available)));
  if (width === chartWidth) return false;
  chartWidth = width;
  return true;
}

// The dashed trace of the launch before the one being shown.
function previousLanding(current) {
  return current.records.filter((run) => run !== current.run).at(-1) ?? null;
}

function drawRobot() {
  const canvas = document.getElementById('launchRobot');
  if (canvas) drawLaunchRobot(canvas);
}

function drawCanvases() {
  drawFlight();
  drawRobot();
}

function update() {
  render(launchPage(buildModel(), copy, fragments, actions), page());
  drawFlight();
}

// A topic page is rebuilt from scratch so details, focus and scroll start fresh, as learners expect
// when they open another experiment. The status line restarts with it.
function rebuildPage() {
  const current = experiment();
  status = current.complete ? finishedStatus(landingOutcome(current.run)) : copy.status.initial;
  measurements.importStatus = '';
  render(null, page());
  update();
  if (measureChartWidth()) update();
  drawRobot();
}

function openTopic(id) {
  pause();
  topicId = id;
  rebuildPage();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function pause() {
  playback.playing = false;
  playback.stopAt = null;
  cancelAnimationFrame(playback.frame);
}

// The last sample at or before flight time `time` (s).
function sampleIndexAt(run, time) {
  const next = run.samples.findIndex((sample) => sample.t > time);
  return next < 0 ? lastIndex(run) : Math.max(0, next - 1);
}

function pauseAndShow() {
  if (!playback.playing) return;
  pause();
  update();
}

function finish() {
  const current = experiment();
  if (current.complete) return;
  current.complete = true;
  const run = current.run;
  if (run.status === 'landed') {
    current.records.push(run);
    if (current.records.length > MAX_RECORDS) current.records.shift();
  }
  const outcome = landingOutcome(run);
  if (outcome.hit) hitTargets.add(targetIndex);
  status = finishedStatus(outcome);
}

function play() {
  const current = experiment();
  if (!current.run || current.run.samples.length < 2) return;
  if (current.index === lastIndex(current.run)) current.index = 0;
  playback.startOffset = current.run.samples[current.index].t;
  playback.startTime = performance.now();
  playback.playing = true;
  tick();
}

function tick() {
  if (!playback.playing) return;
  const current = experiment();
  const run = current.run;
  const elapsed = (performance.now() - playback.startTime) / 1000;
  const shownTime = playback.startOffset + elapsed * PLAYBACK_RATE;
  const stopAt = playback.stopAt;
  const until = stopAt === null ? shownTime : Math.min(shownTime, stopAt);
  while (current.index < lastIndex(run) && run.samples[current.index + 1].t <= until)
    current.index += 1;
  current.observed = Math.max(current.observed, current.index);
  if (stopAt !== null && shownTime >= stopAt && current.index < lastIndex(run)) pause();
  else if (current.index === lastIndex(run)) {
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
}

function launch() {
  document.getElementById('launchFlight').scrollIntoView({ block: 'center', behavior: 'instant' });
  const current = experiment();
  if (current.run && !current.complete) {
    play();
    return;
  }
  pause();
  seed += 1;
  const run = launchExperiment({ power: current.power, variation: topicId === 'target', seed });
  run.target = currentTarget();
  if (topicId === 'forces') run.reference = launchExperiment({ power: current.power, air: false });
  resetRun(current, run);
  status = copy.status.running;
  if (run.status === 'not-released') {
    finish();
    update();
  } else play();
}

// 「矢印を見る」: the force box needs the disc held still in mid-air. A launch already on screen is
// moved to the middle of its flight; otherwise a new one is launched and stops there by itself.
function showArrows() {
  showForces = true;
  const current = experiment();
  const run = current.run;
  if (run?.status === 'landed') {
    pause();
    current.index = sampleIndexAt(run, run.time * ARROW_MOMENT);
    current.observed = Math.max(current.observed, current.index);
    update();
    document
      .getElementById('launchFlight')
      .scrollIntoView({ block: 'center', behavior: 'instant' });
    return;
  }
  launch();
  const started = experiment().run;
  if (started?.status === 'landed' && playback.playing)
    playback.stopAt = started.time * ARROW_MOMENT;
}

function nextTarget() {
  const lastTarget = targetIndex === LAUNCH_TARGETS.length - 1;
  if (!hitTargets.has(targetIndex) || lastTarget) return;
  pause();
  targetIndex += 1;
  resetRun(experiment(), null);
  rebuildPage();
}

function readMeasurement(fields) {
  if (!fields.launchMeasuredRange.value.trim()) throw new Error(copy.measurement.rangeRequired);
  const row = {
    power: Number(fields.launchMeasuredPower.value),
    range: Number(fields.launchMeasuredRange.value),
  };
  launchGroups([row]); // rejects values outside 0-100 % and 0-30 m with the learner's message
  if (measurements.measured.length >= MAX_MEASUREMENTS)
    throw new Error(copy.measurement.tooManyRows);
  return row;
}

function addMeasurement(event) {
  event.preventDefault();
  if (measurements.source !== 'measured') return;
  const fields = event.currentTarget.elements;
  try {
    measurements.measured.push(readMeasurement(fields));
    fields.launchMeasuredRange.value = '';
    measurements.importStatus = copy.measurement.added;
  } catch (error) {
    measurements.importStatus = error.message;
  }
  update();
}

// The file is read asynchronously; the learner may have opened another topic meanwhile, in which
// case the rows are kept but no message is shown.
async function importCsv(event) {
  const input = event.target;
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > MAX_CSV_BYTES) throw new Error(copy.measurement.fileTooLarge);
    const rows = launchParseCSV(await file.text());
    measurements.measured = rows;
    measurements.source = 'measured';
    if (topicId === 'measure')
      measurements.importStatus = fillSentence(copy.measurement.imported, {
        count: String(rows.length),
      });
  } catch (error) {
    if (topicId === 'measure') measurements.importStatus = error.message;
  } finally {
    input.value = '';
  }
  if (topicId === 'measure') update();
}

const actions = {
  openTopic,
  launch,
  togglePlay() {
    if (playback.playing) {
      pause();
      update();
    } else play();
  },
  seek(index) {
    pause();
    const current = experiment();
    current.index = Math.min(index, current.observed); // the unwatched part cannot be jumped to
    update();
  },
  setPower(power) {
    const current = experiment();
    current.power = power;
    if (current.run) status = copy.status.powerChanged;
    update();
  },
  showForces(visible) {
    showForces = visible;
    update();
  },
  showReference(visible) {
    showReference = visible;
    update();
  },
  nextTarget,
  showArrows,
  saveCsv() {
    const rows = recordRows(experiment().records);
    downloadFile('QUESTiX-LAB-射出-模擬.csv', launchCSV(rows, 'simulation'), CSV_TYPE);
  },
  setSource(source) {
    measurements.source = source;
    update();
  },
  addMeasurement,
  removeLastMeasurement() {
    if (measurements.source !== 'measured') return;
    measurements.measured.pop();
    update();
  },
  setMeasurementTarget(metres) {
    measurements.target = metres;
    update();
  },
  saveMeasurementsCsv() {
    const measured = measurements.source === 'measured';
    const name = `QUESTiX-LAB-射出-${measured ? '実測' : '入力例'}.csv`;
    const rows = measured ? measurements.measured : EXAMPLE_MEASUREMENTS;
    downloadFile(name, launchCSV(rows, measured ? 'measured' : 'example'), CSV_TYPE);
  },
  saveCsvTemplate() {
    downloadFile('QUESTiX-LAB-射出-測定用.csv', MEASUREMENT_CSV_TEMPLATE, CSV_TYPE);
  },
  importCsv,
  openQuiz() {
    document.dispatchEvent(new CustomEvent('quiz-open', { detail: 'launch' }));
  },
};

function initLaunch() {
  rebuildPage();
  document.addEventListener('series-leave', pauseAndShow);
  document.addEventListener('supplement-open', pauseAndShow);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseAndShow();
  });
  window.addEventListener('resize', () => {
    if (page().hidden) return;
    if (measureChartWidth()) update();
    drawCanvases();
  });
}

function activateLaunch() {
  if (measureChartWidth()) update();
  drawCanvases();
}

function reviewLaunch(id) {
  if (!LAUNCH_TOPICS.some((topic) => topic.id === id)) return false;
  openTopic(id);
  return true;
}

export { initLaunch, activateLaunch, reviewLaunch };
