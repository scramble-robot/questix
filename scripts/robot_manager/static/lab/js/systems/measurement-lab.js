import { render } from '../vendor/lit-html.js';
import { loadJson, fillSentence as fill } from '../core/content.js';
import { downloadFile } from '../core/dom.js';
import { measurementStats, fitMeasurement, parseMeasurementCSV } from './measurement-core.js';
import { measurementPanel } from './measurement-view.js';
import { CAPTURE_DEFAULTS, onLiveLink, steadyMeasurements } from '../live/capture.js';
import { driveRows, drivesOf } from '../live/recording-core.js';
import { createLiveSession } from '../live/live-session.js';
import { captureNotes } from '../live/live-view.js';
import { openRobotDialog } from '../live/live-ui.js';
import {
  staircaseProgram,
  programSeconds,
  programCommand,
  createOdomGoal,
} from '../live/drive-core.js';

// The measurement lab: a panel offered under the control, launch and SLAM courses where the
// learner looks at repeated measurements, compares them with an independent reference and fits a
// straight line. State and behaviour live here, measurement-view.js turns the model into markup,
// measurement-core.js does the arithmetic. A scenario with a `live` block can also fill the table
// from the connected robot (or a saved recording / rosbag) instead of the worked example or a CSV;
// recording, files and storage are js/live/live-session.js. Two kinds of `live` block exist:
// - `holds` (control): every held speed command becomes one input with repeated measurements;
// - `drives` (SLAM): every drive between two stops gives the wheel-odometry distance, and the
//   learner types in the distance measured on the floor for it — the robot cannot measure that.
// Texts and the scenarios are in content/systems/measurement-lab.json.

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
const CM_PER_M = 100;
const DRIVE_DIGITS = 1; // cm: a tape measure is read to the millimetre at best
const DEGREES_PER_RADIAN = 180 / Math.PI;

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

// Whatever table the learner is working on (typed in, opened from CSV, recorded) survives a reload
// of the page in this browser; the worked example is simply rebuilt. Storage can be blocked or
// full, so this is a convenience only — saving the CSV is the reliable way to keep a table.
const TABLE_PREFIX = 'questix-lab-measurement-table:';
const KEPT_FIELDS = ['rows', 'pending', 'selectedX', 'source', 'reference', 'mode'];

function keptTable(course) {
  try {
    const kept = JSON.parse(localStorage.getItem(TABLE_PREFIX + course) ?? 'null');
    return Array.isArray(kept?.rows) && Array.isArray(kept.pending) ? kept : null;
  } catch {
    return null;
  }
}

function keepTable(course) {
  const state = states.get(course);
  try {
    if (!state || state.source === copy.sources.example)
      localStorage.removeItem(TABLE_PREFIX + course);
    else
      localStorage.setItem(
        TABLE_PREFIX + course,
        JSON.stringify(Object.fromEntries(KEPT_FIELDS.map((key) => [key, state[key]]))),
      );
  } catch {
    /* storage blocked or full: the table simply does not survive a reload */
  }
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
      // Drives found in a recording that still wait for the learner's floor measurement.
      pending: [],
      ...keptTable(course),
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

// --- the real robot --------------------------------------------------------------------------

const sessions = new Map();

// Driving the robot for a table (drive-core.js). Holds alternate forward and backward, so the
// robot ends near where it started and needs little room; every hold is one input of the table.
const HOLD_SPEEDS = [0.1, -0.1, 0.2, -0.2]; // m/s
const HOLD_SECONDS = 3; // settleSeconds + minHoldSeconds of CAPTURE_DEFAULTS
const HOLD_PAUSE = 1.5; // s standing still between holds, so each hold starts from rest
// Drives measured by /odom for the SLAM table; the learner measures the same drive on the floor.
const DRIVE_DISTANCES = [0.5, 1]; // m
const DRIVE_SPEED = 0.2; // m/s
const DRIVE_SPARE = 4; // s on top of distance / speed for speeding up, slowing down and settling
const DRIVE_ROOM = 0.5; // m of free floor asked for beyond the drive itself
let driveDistance = DRIVE_DISTANCES[0];

const holdsDrive = {
  program() {
    const largest = Math.max(...HOLD_SPEEDS.map(Math.abs));
    return fill(copy.messages.driveHoldsProgram, {
      speeds: [...new Set(HOLD_SPEEDS.map(Math.abs))].join('・'),
      hold: HOLD_SECONDS,
      pause: HOLD_PAUSE,
      space: (largest * HOLD_SECONDS + 0.3).toFixed(1),
    });
  },
  plan() {
    const steps = staircaseProgram(HOLD_SPEEDS, { hold: HOLD_SECONDS, pause: HOLD_PAUSE });
    return {
      controller: (elapsed) => programCommand(steps, elapsed),
      seconds: programSeconds(steps),
    };
  },
};

const cm = (metres) => Math.round(metres * CM_PER_M);

const drivesDrive = {
  get startLabel() {
    return fill(copy.messages.driveDistanceStart, { cm: cm(driveDistance) });
  },
  program: () =>
    fill(copy.messages.driveDistanceProgram, {
      cm: cm(driveDistance),
      speed: DRIVE_SPEED,
      space: (driveDistance + DRIVE_ROOM).toFixed(1),
    }),
  plan() {
    const goal = createOdomGoal({ kind: 'distance', target: driveDistance, speed: DRIVE_SPEED });
    return {
      controller: (elapsed, robot) => goal.update(robot.odom, elapsed),
      seconds: driveDistance / DRIVE_SPEED + DRIVE_SPARE,
    };
  },
};

const DRIVES = { holds: holdsDrive, drives: drivesDrive };

// A recording replaces the table: mixing a worked example with real measurements would leave the
// learner unable to say which number came from where.
function applyHolds(course, recording) {
  const state = labState(course);
  const { rows, summary } = driveRows(recording);
  const measured = steadyMeasurements(rows);
  if (!measured.rows.length)
    return { ok: false, note: fill(copy.messages.liveNoHold, { seconds: MIN_HOLD_SECONDS }) };
  state.rows = measured.rows;
  state.source = copy.sources.live;
  state.selectedX = measured.rows[0].x;
  state.correct = false;
  const note = fill(copy.messages.liveRecorded, {
    notes: captureNotes(summary),
    holds: measured.holds.length,
    count: measured.rows.length,
  });
  return { ok: true, note };
}

// The wheel side of each drive is known; the floor side is typed in afterwards (addDrives).
function applyDrives(course, recording) {
  const state = labState(course);
  const drives = drivesOf(recording);
  if (!drives.length) return { ok: false, note: copy.messages.liveNoDrive };
  state.pending = drives.map((drive, index) => ({
    number: index + 1,
    wheel: Number((drive.distance * CM_PER_M).toFixed(DRIVE_DIGITS)),
    turn: Math.round(Math.abs(drive.turn) * DEGREES_PER_RADIAN),
    floor: '',
  }));
  return { ok: true, note: fill(copy.messages.liveDrives, { count: drives.length }) };
}

const APPLY = { holds: applyHolds, drives: applyDrives };

function sessionOf(course) {
  const scenario = scenarioOf(course);
  if (!scenario?.live) return null;
  if (!sessions.has(course)) {
    const live = scenario.live;
    const session = createLiveSession({
      slot: `measurement-${course}`,
      lesson: `measurement-${course}`,
      needs: live.streams,
      seconds: live.seconds,
      countStream: live.streams[0],
      finishOnStop: live.kind === 'drives',
      applyOnRestore: false, // the table itself comes back (keptTable)
      recordLabel: live.recordLabel,
      stopLabel: live.stopLabel,
      failed: copy.messages.liveFailed,
      apply: (recording) => APPLY[live.kind](course, recording),
      update: () => {
        if (shown === course) update();
      },
      drive: DRIVES[live.kind],
    });
    sessions.set(course, session);
    session.restore();
  }
  return sessions.get(course);
}

function liveModel(course) {
  const scenario = scenarioOf(course);
  const session = sessionOf(course);
  if (!session) return null;
  return {
    ...session.model(),
    message: session.note,
    text: scenario.live.text,
    referenceNote: scenario.live.referenceNote,
    pending: labState(course).pending,
    driveDistance: scenario.live.kind === 'drives' ? driveDistance : null,
    driveDistances: scenario.live.kind === 'drives' ? DRIVE_DISTANCES : [],
  };
}

// The drives the learner has measured on the floor go into the table as (floor, wheel) rows. The
// first batch replaces the worked example; later ones add to what is there, so repeated drives
// collect into one table.
function addDrives() {
  const state = labState(shown);
  const measured = state.pending.filter(
    (drive) => drive.floor !== '' && Number.isFinite(Number(drive.floor)),
  );
  if (!measured.length) {
    state.message = copy.messages.liveNeedFloor;
    update();
    return;
  }
  const rows = measured.map((drive) => ({ x: Number(drive.floor), y: drive.wheel, test: false }));
  const kept = state.source === copy.sources.example ? [] : state.rows;
  state.rows = kept.concat(rows).slice(0, MAX_ROWS);
  state.source = copy.sources.live;
  state.selectedX = rows[0].x;
  state.correct = false;
  state.pending = state.pending.filter((drive) => !measured.includes(drive));
  state.message = fill(copy.messages.liveDrivesAdded, { count: rows.length });
  update();
}

function setFloor(index, value) {
  const drive = labState(shown).pending[index];
  if (drive) drive.floor = value.trim();
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
  keepTable(shown);
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
  startCapture: () => sessionOf(shown)?.actions.startCapture(),
  startDriveCapture: () => sessionOf(shown)?.actions.startDriveCapture(),
  saveRun: (id, kind) => sessionOf(shown)?.actions.saveRun(id, kind),
  confirmDrive: (value) => sessionOf(shown)?.actions.confirmDrive(value),
  setDriveDistance(value) {
    if (DRIVE_DISTANCES.includes(value)) driveDistance = value;
    update();
  },
  stopCapture: () => sessionOf(shown)?.actions.stopCapture(),
  openRecording: (file) => sessionOf(shown)?.actions.openRecording(file),
  saveRecording: (kind) => sessionOf(shown)?.actions.saveRecording(kind),
  setFloor,
  addDrives,
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
  sessionOf(course); // brings back the recording this browser kept, before the first draw
  // Rebuild the panel so its details element, focus and the supplement trigger start fresh.
  render(null, entry);
  update();
}

export { showMeasurementLab };
