import { render } from '../vendor/lit-html.js';
import { loadJson, loadText, fillSentence as fill } from '../core/content.js';
import { downloadFile } from '../core/dom.js';
import { revealElement, revealIfHidden } from '../core/reveal.js';
import { createLiveSession } from '../live/live-session.js';
import { forwardRpm } from '../live/capture-core.js';
import { liveLink } from '../live/capture.js';
import { driveModel } from '../live/drive-link.js';
import { programSeconds } from '../live/drive-core.js';
import { openRobotDialog } from '../live/live-ui.js';
import { registerRecordTarget, revealAfterRender } from '../live/record-targets.js';
import { stateMemo } from '../live/robot-state.js';
import { useMeasurements } from '../systems/measurement-lab.js';
import { recordingSourceLabel } from '../systems/measurement-core.js';
import {
  BENCH_PERCENTS,
  BENCH_HOLD,
  BENCH_SAMPLE_ROWS,
  SETTLE_SECONDS,
  benchSteps,
  benchPlan,
  benchStepAt,
  benchTable,
  benchSummary,
  benchMeasurementRows,
} from './bench-core.js';
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
import { reportLessonProgress } from '../shell/lesson-progress.js';

// Motor course (電気で回転を生み出す): state and behaviour. view.js turns the model into markup,
// render.js draws the figures, core.js simulates. Texts live in content/motor.json and
// content/motor/*.html. Its last topic plans a measurement and, on the real robot, measures the
// drive wheels lifted on a stand: the page commands a staircase of speeds through js/live
// (live-session, whose drive-link.js is the only sender, with its live strip and the folded
// 「実機の状態」 panel; bench-core.js turns the recording into the table). 「分析に使う」 hands the
// table to the shared measurement lab (js/systems/measurement-lab.js) without retyping; without a
// robot, an example table can be analysed the same way.

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

// The bench measurement of the drive wheels (topic `real`): the table from the last recording, or
// the example table (`sample`) a class without a robot analyses; `handed` what 分析に使う said.
const bench = { rows: [], summary: null, sample: false, handed: '' };
const BENCH_RECORD_SECONDS = 40; // 「記録だけする」: the learner drives with the controller
const BENCH_MIN_HOLD_SECONDS = 2; // said in the sentence when no step was found
const MEMO_PLACE = 'motor-real';

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

// --- Bench measurement of the drive wheels (topic `real`) ---------------------------------------

// The fastest forward speed the bridge lets a page ask for, and the robot's wheel geometry. Read
// from drive-link / the link itself: the session's model() asks benchDrive.program() for its text.
const benchLimits = () => driveModel().limits;
const benchConfig = () => liveLink().config;
const stepsText = () => BENCH_PERCENTS.join('→');
const rpmOf = (linear) => {
  const config = benchConfig();
  return config ? forwardRpm(linear, config).toFixed(1) : '—';
};

const benchDrive = {
  startLabel: copy.bench.start,
  confirmLabel: copy.bench.confirm,
  program() {
    const limits = benchLimits();
    if (!(limits?.linear > 0))
      return fill(copy.bench.programUnknown, { steps: stepsText(), hold: BENCH_HOLD });
    return fill(copy.bench.program, {
      steps: stepsText(),
      hold: BENCH_HOLD,
      total: Math.round(programSeconds(benchSteps(limits.linear))),
      linear: limits.linear.toFixed(2),
      rpm: rpmOf(limits.linear),
    });
  },
  placement: () => copy.bench.placement,
  conditions() {
    const linear = benchLimits()?.linear ?? 0;
    return {
      maxLinear: linear,
      label: fill(copy.bench.conditions, { linear: linear.toFixed(2), steps: stepsText() }),
    };
  },
  plan() {
    const limits = benchLimits();
    if (!(limits?.linear > 0)) throw new Error(copy.bench.noLimits);
    return benchPlan(limits.linear);
  },
};

// A recording (this page's run, the controller's, a file or a record on the robot) becomes the
// table; one without a steady step leaves the table on screen as it was.
function applyBench(recording) {
  let table;
  try {
    table = benchTable(recording);
  } catch (error) {
    return { ok: false, note: error.message };
  }
  if (!table.rows.length)
    return { ok: false, note: fill(copy.bench.noSteps, { seconds: BENCH_MIN_HOLD_SECONDS }) };
  Object.assign(bench, {
    rows: table.rows,
    summary: benchSummary(table.rows),
    sample: false,
    handed: '',
  });
  const notes = [fill(copy.bench.filled, { count: table.rows.length })];
  if (table.skipped) notes.push(fill(copy.bench.skipped, { count: table.skipped }));
  return { ok: true, note: notes.join(' ') };
}

const benchSession = createLiveSession({
  slot: 'motor-bench',
  lesson: 'motor-bench',
  needs: ['drive', 'twist'],
  seconds: BENCH_RECORD_SECONDS,
  countStream: 'drive',
  finishOnStop: true,
  recordLabel: copy.bench.recordLabel,
  stopLabel: copy.bench.stopLabel,
  failed: copy.bench.failed,
  apply: applyBench,
  update: () => {
    if (topicId === 'real') update();
  },
  drive: benchDrive,
  reportMetrics: ['driveTime', 'maxSpeed', 'stop'], // the wheels turn in the air: no distance
  // The strip under the button shows the wheels; the full panel (and its memo) is folded under it.
  state: {
    place: MEMO_PLACE,
    name: copy.bench.memoName,
    placeholder: copy.bench.memoPlaceholder,
    status: () => benchStatus(),
  },
});

// While the staircase runs: which step, what it asks for, how long it still holds.
function benchProgress(capture) {
  const limits = benchLimits();
  if (!capture.running || !(limits?.linear > 0)) return null;
  const steps = benchSteps(limits.linear);
  const index = benchStepAt(steps, capture.elapsed);
  const end = steps.slice(0, index + 1).reduce((sum, step) => sum + step.seconds, 0);
  return {
    steps,
    index,
    left: Math.max(0, end - capture.elapsed),
    rpm: steps.map((step) => rpmOf(step.linear)),
  };
}

// The line at the top of the 「実機の状態」 panel during a run (redrawn by the panel itself).
function benchStatus() {
  const capture = benchSession.model();
  if (capture.tail) return copy.bench.nowTail;
  const progress = benchProgress(capture);
  if (!progress) return '';
  // Numbered as the table: the first step only stands still before the run.
  if (progress.index === 0) return copy.bench.nowLead;
  const step = progress.steps[progress.index];
  const values = {
    number: progress.index,
    total: progress.steps.length - 1,
    percent: step.percent,
    rpm: progress.rpm[progress.index],
    seconds: progress.left.toFixed(0),
  };
  return fill(step.percent ? copy.bench.nowStep : copy.bench.nowStop, values);
}

function benchModel() {
  const capture = benchSession.model();
  return {
    capture: { ...capture, message: benchSession.note },
    rows: bench.rows,
    summary: bench.summary,
    sample: bench.sample,
    handed: bench.handed,
    progress: benchProgress(capture),
    settle: SETTLE_SECONDS,
    source: benchSession.recording?.name ?? '',
  };
}

// Where the rows handed to the measurement lab came from (its 「どこから：…」 line).
function benchSource() {
  if (bench.sample) return copy.bench.sampleSource;
  const recording = benchSession.recording;
  const texts = { group: copy.bench.fromGroup, live: copy.bench.fromLive };
  return recording ? recordingSourceLabel(recording, texts, fill) : copy.bench.fromLive;
}

// 「分析に使う」: the table goes into 測定データを分析する as it is — both wheels as repeats of
// each step, the way back down kept for checking the line (bench-core benchMeasurementRows).
function analyseBench() {
  const { rows, input } = benchMeasurementRows(bench.rows, benchSource());
  if (!rows.length) {
    bench.handed = copy.bench.analyseEmpty;
    update();
    return;
  }
  const note = bench.sample ? copy.bench.analyseSampleNote : copy.bench.analyseNote;
  const taken = useMeasurements('motor', {
    rows,
    source: bench.sample ? copy.bench.sampleSource : copy.bench.analyseSource,
    labels: copy.bench.analyseLabels[input],
    note,
  });
  bench.handed = taken ? '' : copy.bench.analyseEmpty;
  update();
}

// Without a robot: the example table, clearly named as one, to try the analysis at home.
function useSampleBench() {
  Object.assign(bench, {
    rows: BENCH_SAMPLE_ROWS.map((row) => ({ ...row })),
    summary: benchSummary(BENCH_SAMPLE_ROWS),
    sample: true,
    handed: '',
  });
  update();
  revealIfHidden(document.getElementById('motorBenchTable'));
}

const benchActions = {
  ...benchSession.actions,
  openLink: openRobotDialog,
  // The shared block brings the button and its live strip on screen when the run starts
  // (live-session revealLiveRun); once the run is over, its result is the table.
  async startDriveCapture() {
    await benchSession.actions.startDriveCapture();
    if (bench.rows.length) revealIfHidden(document.getElementById('motorBenchTable'));
  },
  analyse: analyseBench,
  useSample: useSampleBench,
};

function buildModel() {
  const current = state();
  const group = topicOf(topicId).group;
  const voltage = current.config.voltage;
  return {
    topic: topicId,
    group,
    groupTopics: MOTOR_TOPICS.filter((topic) => topic.group === group).map((topic) => topic.id),
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
    bench: topicId === 'real' ? benchModel() : null,
  };
}

function update() {
  render(motorPage(buildModel(), copy, fragments, actions), page());
  reportLessonProgress('motor', {
    topics: MOTOR_TOPICS.map((topic) => ({ id: topic.id, title: copy.topics[topic.id].label })),
    current: topicId,
    open: openTopic,
  });
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

// The bench table as lines of the saved text: "1. 20%（5.7 rpm） → 左 5.6 rpm・右 5.7 rpm".
function benchLines() {
  return bench.rows.map((row) => {
    const percent = row.percent === null ? '' : `${row.percent}%`;
    return `${row.number}. ${percent}（${row.command} rpm） → 左 ${row.left} rpm・右 ${row.right} rpm`;
  });
}

function planText() {
  const current = state();
  const text = copy.real;
  const plan = text.plans[current.config.part];
  const lines = [
    text.fileHeading,
    plan.name,
    text.planLabels.change + plan.change,
    text.planLabels.record + plan.record,
    text.planLabels.compare + plan.compare,
    text.filePrediction + current.prediction,
    text.fileReflection + current.reflection,
  ];
  if (bench.rows.length) lines.push(text.fileTable, ...benchLines());
  const memo = stateMemo(MEMO_PLACE).trim();
  if (memo) lines.push(text.fileMemo, memo);
  return lines.join('\n');
}

const actions = {
  openTopic,
  openGroup(group) {
    openTopic(MOTOR_TOPICS.find((topic) => topic.group === group).id);
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
  bench: benchActions,
};

// 「モーターの教材で開く」 from 記録の一覧: the recording takes the way of a file into the table.
registerRecordTarget('motor-bench', (recording) => {
  openTopic('real');
  const taken = benchSession.useRecording(recording, 'robot');
  revealAfterRender(() => document.getElementById('motorBenchTable'));
  return taken;
});

function initMotor() {
  benchSession.restore(); // the table of the last recording this browser kept
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
