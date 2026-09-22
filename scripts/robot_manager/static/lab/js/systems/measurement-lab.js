import { render } from '../vendor/lit-html.js';
import { loadJson } from '../core/content.js';
import { downloadFile } from '../core/dom.js';
import { measurementStats, fitMeasurement, parseMeasurementCSV } from './measurement-core.js';
import { measurementPanel } from './measurement-view.js';

// The measurement lab: a panel offered under the control, launch and SLAM courses where the
// learner looks at repeated measurements, compares them with an independent reference and fits a
// straight line. State and behaviour live here, measurement-view.js turns the model into markup,
// measurement-core.js does the arithmetic. Texts and the scenarios are in
// content/systems/measurement-lab.json.

const copy = await loadJson('content/systems/measurement-lab.json');

const MAX_ROWS = 200;
const MAX_CSV_BYTES = 100000; // 100 KB, as the on-screen note says
const FIRST_SELECTED_INPUT = 40;
const SAMPLE_INPUTS = [20, 40, 60]; // inputs the worked example was "measured" at
const SAMPLE_SPREADS = [-1, 0.4, 0.6]; // repeats at each input, in units of the scenario's spread
const CHECK_INPUT = 50; // the one point held back to check a fitted line with
const CHECK_SPREAD = 0.7;
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
    });
  }
  return states.get(course);
}

function buildModel(course) {
  const state = labState(course);
  const inputs = [...new Set(state.rows.map((row) => row.x))].sort((a, b) => a - b);
  const selected = state.rows.filter((row) => row.x === state.selectedX).map((row) => row.y);
  const stats = measurementStats(selected);
  return {
    scenario: scenarioOf(course),
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
};

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
