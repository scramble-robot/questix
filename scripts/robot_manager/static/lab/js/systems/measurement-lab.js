import { render } from '../vendor/lit-html.js';
import { loadJson, fillSentence as fill } from '../core/content.js';
import { downloadFile } from '../core/dom.js';
import {
  measurementStats,
  fitMeasurement,
  parseMeasurementCSV,
  measurementFileProblem,
  recordingSourceLabel,
  shortFileName,
} from './measurement-core.js';
import { measurementPanel } from './measurement-view.js';
import { CAPTURE_DEFAULTS, onLiveLink, steadyMeasurements } from '../live/capture.js';
import { driveRows, drivesOf } from '../live/recording-core.js';
import { createLiveSession } from '../live/live-session.js';
import { captureNotes } from '../live/live-view.js';
import { openRobotDialog } from '../live/live-ui.js';
import { pickRobotRecord as pickFromRobot } from '../live/record-picker.js';
import { registerRecordTarget } from '../live/record-targets.js';
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
// Every row remembers where it came from (`from`: a group, a file, 実機 and the time), so a table
// that collects several groups' recordings can still be read. A file opened while the table already
// holds measurements does not silently mix in: the learner chooses 置き換える or 追加する.
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
  conditions: () => HOLD_SPEEDS.map((speed) => speed.toFixed(1)).join('／') + ' m/s',
  placement: () =>
    fill(copy.messages.driveHoldsPlacement, {
      space: (Math.max(...HOLD_SPEEDS.map(Math.abs)) * HOLD_SECONDS + 0.3).toFixed(1),
    }),
  program: () =>
    fill(copy.messages.driveHoldsProgram, {
      speeds: [...new Set(HOLD_SPEEDS.map(Math.abs))].join('・'),
      hold: HOLD_SECONDS,
      pause: HOLD_PAUSE,
    }),
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
    fill(copy.messages.driveDistanceProgram, { cm: cm(driveDistance), speed: DRIVE_SPEED }),
  placement: () =>
    fill(copy.messages.driveDistancePlacement, {
      space: (driveDistance + DRIVE_ROOM).toFixed(1),
    }),
  conditions: () => `${cm(driveDistance)} cm`,
  plan() {
    const goal = createOdomGoal({ kind: 'distance', target: driveDistance, speed: DRIVE_SPEED });
    return {
      controller: (elapsed, robot) => goal.update(robot.odom, elapsed),
      seconds: driveDistance / DRIVE_SPEED + DRIVE_SPARE,
      outcome: () =>
        goal.reached
          ? ''
          : fill(copy.messages.driveDistanceShort, { cm: (goal.progress * CM_PER_M).toFixed(1) }),
    };
  },
};

const DRIVES = { holds: holdsDrive, drives: drivesDrive };
// The run report's numbers that matter for each kind of measurement (live-session reportMetrics).
const REPORT_METRICS_OF = {
  holds: ['driveTime', 'distance', 'maxSpeed'],
  drives: ['distance', 'ended', 'turn'],
};

// The first recording replaces the worked example (mixing it with real measurements would leave the
// learner unable to say which number came from where); later recordings add to the real rows, so
// repeated runs collect into one table.
function applyHolds(course, recording) {
  const state = labState(course);
  const { rows, summary } = driveRows(recording);
  const measured = steadyMeasurements(rows);
  if (!measured.rows.length)
    return { ok: false, note: fill(copy.messages.liveNoHold, { seconds: MIN_HOLD_SECONDS }) };
  const from = sourceLabel(recording);
  const incoming = measured.rows.map((row) => ({ ...row, from }));
  if (asksChoice(state))
    return askChoice(state, {
      kind: 'rows',
      where: 'recording',
      rows: incoming,
      source: copy.sources.live,
      notes: captureNotes(summary),
    });
  const first = state.source !== copy.sources.live;
  state.rows = (first ? [] : state.rows).concat(incoming).slice(0, MAX_ROWS);
  state.source = copy.sources.live;
  state.selectedX = incoming[0].x;
  state.correct = false;
  state.jump = true;
  const note = fill(first ? copy.messages.liveRecorded : copy.messages.liveRecordedMore, {
    notes: captureNotes(summary),
    holds: measured.holds.length,
    count: incoming.length,
  });
  // The worked example's reference means nothing for the robot's numbers.
  return { ok: true, note: first ? `${note} ${copy.messages.liveReference}` : note };
}

// The wheel side of each drive is known; the floor side is typed in afterwards (addDrives).
function applyDrives(course, recording) {
  const state = labState(course);
  const drives = drivesOf(recording);
  if (!drives.length) return { ok: false, note: copy.messages.liveNoDrive };
  const from = sourceLabel(recording);
  const found = drives.map((drive) => ({
    wheel: Number((drive.distance * CM_PER_M).toFixed(DRIVE_DIGITS)),
    turn: Math.round(Math.abs(drive.turn) * DEGREES_PER_RADIAN),
    floor: '',
    from,
  }));
  if (asksChoice(state))
    return askChoice(state, { kind: 'drives', where: 'recording', drives: found });
  addPending(state, found);
  state.jump = true;
  return { ok: true, note: fill(copy.messages.liveDrives, { count: drives.length }) };
}

// Drives still waiting for their floor distance stay; the new ones are numbered after them.
function addPending(state, drives) {
  const last = Math.max(0, ...state.pending.map((drive) => drive.number));
  state.pending = state.pending.concat(
    drives.map((drive, index) => ({ ...drive, number: last + index + 1 })),
  );
  state.added = '';
}

// --- a second file: replace or add ------------------------------------------------------------

// Set while a file the learner picked is being read, so `apply` can tell it from a run just
// recorded (repeated runs of one group simply collect into the table).
let openingFile = false;

const sourceLabel = (recording) =>
  recordingSourceLabel(recording, { group: copy.sources.group, live: copy.sources.liveAt }, fill);

// Only a file asks, and only when the table already holds something other than the worked example
// (or drives still wait for their floor distance).
const asksChoice = (state) =>
  openingFile && (state.source !== copy.sources.example || state.pending.length > 0);

// Keeps what the file would put in the table until the learner presses 置き換える or 追加する.
function askChoice(state, incoming) {
  const count = incoming.kind === 'drives' ? incoming.drives.length : incoming.rows.length;
  const ask = fill(copy.messages.choiceAsk, {
    count,
    unit: incoming.kind === 'drives' ? copy.messages.choiceDrives : copy.messages.choiceRows,
  });
  state.incoming = { ...incoming, ask };
  state.jump = false;
  return { ok: true, note: ask };
}

function acceptRows(state, incoming, replace) {
  const fresh = replace || state.source === copy.sources.example;
  state.rows = (fresh ? [] : state.rows).concat(incoming.rows).slice(0, MAX_ROWS);
  const live = state.source === copy.sources.live || incoming.source === copy.sources.live;
  state.source = !fresh && live ? copy.sources.live : incoming.source;
  state.selectedX = incoming.rows[0].x;
  state.correct = false;
  const said = replace ? copy.messages.choiceReplaced : copy.messages.choiceAdded;
  return [incoming.notes, fill(said, { count: incoming.rows.length, total: state.rows.length })]
    .filter(Boolean)
    .join(' ');
}

// Replacing drives starts the table over: the rows measured before and the drives still waiting go,
// and the worked example stands in until the new drives get their floor distance.
function acceptDrives(state, incoming, replace) {
  if (replace) {
    state.pending = [];
    state.rows = exampleRows(scenarioOf(shown));
    state.source = copy.sources.example;
    state.reference = scenarioOf(shown).reference;
    state.correct = false;
  }
  addPending(state, incoming.drives);
  return fill(replace ? copy.messages.choiceDrivesReplaced : copy.messages.choiceDrivesAdded, {
    count: incoming.drives.length,
  });
}

function chooseIncoming(how) {
  const state = labState(shown);
  const incoming = state.incoming;
  if (!incoming) return;
  state.incoming = null;
  const replace = how === 'replace';
  const said =
    incoming.kind === 'drives'
      ? acceptDrives(state, incoming, replace)
      : acceptRows(state, incoming, replace);
  state.jump = true;
  if (incoming.where === 'csv') state.message = said;
  else {
    const session = sessionOf(shown);
    // The question was the lesson's part of the session's note; the answer takes its place.
    session.note = session.note.includes(incoming.ask)
      ? session.note.replace(incoming.ask, said)
      : said;
  }
  update();
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
      reportMetrics: REPORT_METRICS_OF[live.kind],
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
  const state = labState(course);
  const model = session.model();
  const driving = Boolean(model.drive?.allowed && model.link.connected);
  return {
    ...model,
    message: session.note,
    // While the page may drive the robot, the record-only way ("走り終えた"…) is not the one shown.
    text: driving ? (scenario.live.driveText ?? scenario.live.text) : scenario.live.text,
    choice: state.incoming?.where === 'recording',
    jump: Boolean(state.jump && session.note),
    referenceNote: scenario.live.referenceNote,
    pending: state.pending,
    added: state.added ?? '',
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
  const rows = measured.map((drive) => ({
    x: Number(drive.floor),
    y: drive.wheel,
    test: false,
    from: drive.from,
  }));
  const kept = state.source === copy.sources.example ? [] : state.rows;
  state.rows = kept.concat(rows).slice(0, MAX_ROWS);
  state.source = copy.sources.live;
  state.selectedX = rows[0].x;
  state.correct = false;
  state.pending = state.pending.filter((drive) => !measured.includes(drive));
  // Said next to the button that did it, not at the top of the panel.
  state.added = fill(copy.messages.liveDrivesAdded, { count: rows.length });
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
    course,
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
    csvChoice: state.incoming?.where === 'csv',
    csvJump: Boolean(state.jump && state.message && !state.incoming),
    plotWidth: plotWidth || fallbackPlotWidth(),
  };
}

const host = () => document.getElementById('measurementEntry');

// The plot is drawn at its on-screen width (measurement-core.js measurementPlotAxes). The panel
// lives in a dialog that is closed at first, so the width is known only once the plot is laid
// out; a ResizeObserver redraws it then and whenever the width changes (rotation, window size).
const PLOT_SIDE_ROOM = 64; // px of dialog padding around the plot, for the first estimate
const PLOT_MAX_WIDTH = 850; // px, .measurement-lab max-width
let plotWidth = 0;
let plotElement = null;
const plotObserver =
  typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
        const width = Math.round(entries.at(-1).contentRect.width);
        if (width > 0 && width !== plotWidth) {
          plotWidth = width;
          update();
        }
      })
    : null;

const fallbackPlotWidth = () =>
  Math.min(PLOT_MAX_WIDTH, Math.max(0, window.innerWidth - PLOT_SIDE_ROOM));

function watchPlot(element) {
  if (!element || element === plotElement) return;
  plotObserver?.disconnect();
  plotElement = element;
  plotObserver?.observe(element);
}

function update() {
  if (!shown) return;
  keepTable(shown);
  render(measurementPanel(buildModel(shown), copy, actions), host());
}

// Press → see inside the dialog: the jump links scroll the part they name into view.
function scrollToPart(selector) {
  const part = plotElement?.closest('.measurement-lab')?.querySelector(selector);
  part?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  return part;
}

// After new numbers arrived: the drives waiting for their floor distance, otherwise the table.
function showTable() {
  const drives = scrollToPart('[data-measure-drives]');
  if (drives) {
    drives.querySelector('input[data-drive-floor]')?.focus({ preventScroll: true });
    return;
  }
  scrollToPart('[data-measure-table]');
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

// Opening a file starts a new question: the answers to the previous one (a file error, a note on
// the last recording, a choice not made) are cleared first.
function clearNotes(state) {
  state.message = '';
  state.incoming = null;
  state.jump = false;
  const session = sessions.get(shown);
  if (session) session.note = '';
}

// A rosbag, a recording or its CSV picked here by mistake is named as such (from the start of the
// file, before the size limit, which such files usually exceed) rather than reported as a bad row.
const FILE_PROBE_BYTES = 4096;

// The browser's own reading error (a file moved or deleted after it was picked) is in English.
async function fileText(blob) {
  try {
    return await blob.text();
  } catch {
    throw new Error(copy.messages.unreadable);
  }
}

async function readCsv(file) {
  const problem = measurementFileProblem(await fileText(file.slice(0, FILE_PROBE_BYTES)));
  if (problem) {
    const texts = copy.fileProblems[problem];
    throw new Error(scenarioOf(shown).live ? texts.live : texts.plain);
  }
  if (file.size > MAX_CSV_BYTES) throw new Error(copy.messages.tooLarge);
  return parseMeasurementCSV(await fileText(file));
}

async function openCsv(file) {
  if (!file) return;
  const state = labState(shown);
  clearNotes(state);
  try {
    const from = shortFileName(file.name);
    const rows = (await readCsv(file)).map((row) => ({ ...row, from }));
    if (state.source !== copy.sources.example) {
      const ask = fill(copy.messages.choiceAsk, {
        count: rows.length,
        unit: copy.messages.choiceRows,
      });
      state.incoming = { kind: 'rows', where: 'csv', rows, source: file.name, ask };
      state.message = ask;
    } else {
      state.rows = rows;
      state.source = file.name;
      state.selectedX = rows[0].x;
      state.correct = false;
      state.message = fill(copy.messages.loaded, { count: rows.length });
      state.jump = true;
    }
  } catch (error) {
    state.message = error.message;
  }
  update();
}

async function openRecording(file) {
  const session = sessionOf(shown);
  if (!file || !session) return;
  clearNotes(labState(shown));
  openingFile = true;
  try {
    await session.actions.openRecording(file);
  } finally {
    openingFile = false;
  }
}

// A recording kept on the robot takes the way of a file (a table that holds measurements asks
// whether to replace or add).
function openFromRobot(recording) {
  const session = sessionOf(shown);
  if (!recording || !session) return false;
  clearNotes(labState(shown));
  openingFile = true;
  try {
    return session.useRecording(recording, 'robot');
  } finally {
    openingFile = false;
  }
}

async function pickRobotRecord() {
  const scenario = scenarioOf(shown);
  if (!scenario?.live) return;
  const course = shown;
  const recording = await pickFromRobot({
    lesson: `measurement-${course}`,
    needs: scenario.live.streams,
  });
  if (recording && shown === course) openFromRobot(recording);
}

const SUPPLEMENT_TRIGGER = 'button[aria-controls="supplementDialog"]';

// 「測定ラボで開く」 from 記録の一覧: the course is on screen with this panel (series.js
// showMeasurementLab); the recording goes in, then the panel's dialog opens on what it did.
function openFromRecords(course, recording) {
  if (shown !== course) return false;
  const taken = openFromRobot(recording);
  // The panel's trigger button is added by supplement-ui once the new panel is in the page.
  requestAnimationFrame(() => {
    host().querySelector(SUPPLEMENT_TRIGGER)?.click();
    requestAnimationFrame(() => scrollToPart('[data-measure-live-note]'));
  });
  return taken;
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
    state.rows.push({ x: state.selectedX, y: 0, test: false, from: copy.sources.typed });
    update();
  },
  removeRow(index) {
    labState(shown).rows.splice(index, 1);
    update();
  },
  editCell,
  openCsv,
  saveCsv,
  startCapture() {
    clearNotes(labState(shown));
    return sessionOf(shown)?.actions.startCapture();
  },
  startDriveCapture() {
    clearNotes(labState(shown));
    return sessionOf(shown)?.actions.startDriveCapture();
  },
  saveRun: (id, kind) => sessionOf(shown)?.actions.saveRun(id, kind),
  confirmDrive: (value) => sessionOf(shown)?.actions.confirmDrive(value),
  setDriveDistance(value) {
    if (DRIVE_DISTANCES.includes(value)) driveDistance = value;
    update();
  },
  stopCapture: () => sessionOf(shown)?.actions.stopCapture(),
  openRecording,
  pickRobotRecord,
  chooseIncoming,
  showTable,
  jumpToLive: () => scrollToPart('[data-measure-live]'),
  watchPlot,
  saveRecording: (kind) => sessionOf(shown)?.actions.saveRecording(kind),
  setFloor,
  addDrives,
  openLink: openRobotDialog,
};

// Connecting or losing the robot changes what the panel offers, so it is redrawn from here rather
// than leaving a stale "実機とつながっていません" on screen.
onLiveLink(() => update());

for (const course of Object.keys(copy.scenarios).filter((key) => copy.scenarios[key].live))
  registerRecordTarget(`measurement-${course}`, (recording) => openFromRecords(course, recording));

function showMeasurementLab(course) {
  const entry = host();
  if (!entry) return;
  entry.hidden = !scenarioOf(course);
  if (!scenarioOf(course)) return;
  shown = course;
  labState(course).message = '';
  labState(course).incoming = null;
  sessionOf(course); // brings back the recording this browser kept, before the first draw
  // Rebuild the panel so its details element, focus and the supplement trigger start fresh.
  render(null, entry);
  update();
}

export { showMeasurementLab };
