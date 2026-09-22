import { render } from '../vendor/lit-html.js';
import { loadJson, fillSentence as fill } from '../core/content.js';
import { downloadFile } from '../core/dom.js';
import { measurementStats, fitMeasurement, parseMeasurementCSV } from './measurement-core.js';
import { measurementPanel } from './measurement-view.js';
import {
  CAPTURE_DEFAULTS,
  recordDrive,
  liveLink,
  missingStreams,
  onLiveLink,
  steadyMeasurements,
  throttleProgress,
} from '../live/capture.js';
import { captureNotes } from '../live/live-view.js';
import { openRobotDialog } from '../live/live-ui.js';

// The measurement lab: a panel offered under the control, launch and SLAM courses where the
// learner looks at repeated measurements, compares them with an independent reference and fits a
// straight line. State and behaviour live here, measurement-view.js turns the model into markup,
// measurement-core.js does the arithmetic. A scenario with a `live` block can also fill the table
// from the connected robot instead of the worked example or a CSV; the recording itself is done by
// js/live/capture.js. Texts and the scenarios are in content/systems/measurement-lab.json.

const copy = await loadJson('content/systems/measurement-lab.json');

const MAX_ROWS = 200;
const MAX_CSV_BYTES = 100000; // 100 KB, as the on-screen note says
const FIRST_SELECTED_INPUT = 40;
const SAMPLE_INPUTS = [20, 40, 60]; // inputs the worked example was "measured" at
const SAMPLE_SPREADS = [-1, 0.4, 0.6]; // repeats at each input, in units of the scenario's spread
const CHECK_INPUT = 50; // the one point held back to check a fitted line with
const CHECK_SPREAD = 0.7;
const MIN_HOLD_SECONDS = CAPTURE_DEFAULTS.minHoldSeconds;
const VALUE_DIGITS = 3;

const states = new Map();
let shown = null; // scenario currently in the panel, or null when no course offers one

const scenarioOf = (course) => copy.scenarios[course] ?? null;
const roundValue = (value) => Number(value.toFixed(VALUE_DIGITS));
const measuredValue = (scenario, input, spreads) =>
  roundValue(scenario.slope * input + scenario.offset + spreads * scenario.spread);

// A plausible set of measurements to start from, so the panel is never empty.
function exampleRows(scenario) {
  const repeats = SAMPLE_INPUTS.flatMap((input) =>
    SAMPLE_SPREADS.map((spreads) => ({
      x: input,
      y: measuredValue(scenario, input, spreads),
      test: false,
    })),
  );
  return repeats.concat([
    { x: CHECK_INPUT, y: measuredValue(scenario, CHECK_INPUT, CHECK_SPREAD), test: true },
  ]);
}

function labState(course) {
  if (!states.has(course)) {
    const scenario = scenarioOf(course);
    states.set(course, {
      rows: exampleRows(scenario),
      reference: scenario.reference,
      selectedX: FIRST_SELECTED_INPUT,
      mode: 'repeat',
      source: copy.sources.example,
      correct: false,
      message: '',
      capture: { recording: false, progress: 0, controller: null },
    });
  }
  return states.get(course);
}

// While the table holds a recording, the axes are named after what the robot actually measured,
// not after the worked example's quantities.
function shownScenario(course) {
  const scenario = scenarioOf(course);
  const state = labState(course);
  if (state.source !== copy.sources.live || !scenario.live) return scenario;
  return { ...scenario, ...scenario.live };
}

function liveModel(course) {
  const scenario = scenarioOf(course);
  const state = labState(course);
  if (!scenario.live) return null;
  const link = liveLink();
  return {
    link: { ...link, missing: missingStreams(scenario.live.streams) },
    recording: state.capture.recording,
    progress: state.capture.progress,
    seconds: scenario.live.seconds,
    message: '',
    text: scenario.live.text,
  };
}

function buildModel(course) {
  const state = labState(course);
  const inputs = [...new Set(state.rows.map((row) => row.x))].sort((a, b) => a - b);
  const selected = state.rows.filter((row) => row.x === state.selectedX).map((row) => row.y);
  const stats = measurementStats(selected);
  return {
    scenario: shownScenario(course),
    live: liveModel(course),
    mode: state.mode,
    rows: state.rows,
    groups: inputs.map((input) => ({
      input,
      stats: measurementStats(state.rows.filter((row) => row.x === input).map((row) => row.y)),
    })),
    stats,
    fit: fitMeasurement(state.rows),
    correction: state.correct && stats ? state.reference - stats.mean : 0,
    selectedX: state.selectedX,
    reference: state.reference,
    correct: state.correct,
    source: state.source,
    message: state.message,
  };
}

const host = () => document.getElementById('measurementEntry');

function update() {
  if (!shown) return;
  render(measurementPanel(buildModel(shown), copy, actions), host());
}

function editCell(index, column, value) {
  const state = labState(shown);
  const row = state.rows[index];
  if (column === 'test') row.test = value;
  else if (value !== '' && Number.isFinite(Number(value))) row[column] = Number(value);
  else {
    // Keep the stored number and say why the typed one was refused.
    state.message = copy.messages.notFinite;
    update();
    return;
  }
  // Editing the table means the numbers are no longer the worked example.
  state.source = copy.sources.edited;
  update();
}

async function openCsv(file) {
  if (!file) return;
  const state = labState(shown);
  try {
    if (file.size > MAX_CSV_BYTES) throw new Error(copy.messages.tooLarge);
    state.rows = parseMeasurementCSV(await file.text());
    state.source = file.name;
    state.message = copy.messages.loaded.replace('{count}', String(state.rows.length));
  } catch (error) {
    state.message = error.message;
  }
  update();
}

function saveCsv() {
  const state = labState(shown);
  const lines = state.rows.map((row) => [row.x, row.y, row.test ? 1 : 0].join(','));
  downloadFile(
    `QUESTiX-measurements-${shown}.csv`,
    '﻿x,y,test\n' + lines.join('\n'),
    'text/csv;charset=utf-8',
  );
}

// --- recording from the real robot ---------------------------------------------------------

// A recording replaces the table: mixing a worked example with real measurements would leave the
// learner unable to say which number came from where.
async function startCapture() {
  const course = shown;
  const scenario = course && scenarioOf(course);
  if (!scenario?.live) return;
  const state = labState(course);
  if (state.capture.recording) return;
  const controller = new AbortController();
  state.capture = { recording: true, progress: 0, controller };
  state.message = '';
  update();
  try {
    const { rows, summary } = await recordDrive({
      seconds: scenario.live.seconds,
      signal: controller.signal,
      onProgress: throttleProgress((count) => {
        state.capture.progress = count;
        if (shown === course) update();
      }),
    });
    const measured = steadyMeasurements(rows);
    if (!measured.rows.length) {
      state.message = fill(copy.messages.liveNoHold, { seconds: MIN_HOLD_SECONDS });
    } else {
      state.rows = measured.rows;
      state.source = copy.sources.live;
      state.selectedX = measured.rows[0].x;
      state.correct = false;
      state.message = fill(copy.messages.liveRecorded, {
        notes: captureNotes(summary),
        holds: measured.holds.length,
        count: measured.rows.length,
      });
    }
  } catch (error) {
    state.message = fill(copy.messages.liveFailed, { reason: error.message });
  }
  state.capture = { recording: false, progress: 0, controller: null };
  if (shown === course) update();
}

function stopCapture() {
  if (shown) labState(shown).capture.controller?.abort();
}

// A typed number is taken only when it is a finite number; anything else leaves the stored value
// alone, and the field keeps showing what the learner typed.
function setNumber(key, value) {
  const state = labState(shown);
  if (value !== '' && Number.isFinite(Number(value))) state[key] = Number(value);
  update();
}

const actions = {
  selectMode(mode) {
    labState(shown).mode = mode;
    update();
  },
  setSelectedInput: (value) => setNumber('selectedX', value),
  setReference: (value) => setNumber('reference', value),
  setCorrect(correct) {
    labState(shown).correct = correct;
    update();
  },
  addRow() {
    const state = labState(shown);
    if (state.rows.length >= MAX_ROWS) return;
    state.rows.push({ x: state.selectedX, y: 0, test: false });
    update();
  },
  removeRow(index) {
    labState(shown).rows.splice(index, 1);
    update();
  },
  editCell,
  openCsv,
  saveCsv,
  startCapture,
  stopCapture,
  openLink: openRobotDialog,
};

// Connecting or losing the robot changes what the panel offers, so it is redrawn from here rather
// than leaving a stale "実機とつながっていません" on screen.
onLiveLink(() => update());

function showMeasurementLab(course) {
  const entry = host();
  if (!entry) return;
  entry.hidden = !scenarioOf(course);
  if (!scenarioOf(course)) return;
  shown = course;
  labState(course).message = '';
  // Rebuild the panel so its details element, focus and the supplement trigger start fresh.
  render(null, entry);
  update();
}

export { showMeasurementLab };
