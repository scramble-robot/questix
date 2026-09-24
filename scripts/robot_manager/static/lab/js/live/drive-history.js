import { driveReport, isEmptyRun } from './drive-report-core.js';
import { recordingFile } from './capture.js';
import { downloadFile } from '../core/dom.js';

// Every driving run of this browser, newest first: the lessons' runs and the bench test's. The
// report (drive-report-core.js, thinned) is kept in localStorage so a class can look back after a
// reload; the full recording only lives in memory, for saving as JSON / CSV right after the run.
// Storage can be blocked or full (or absent, in Node tests), so the history works without it.

const STORE_KEY = 'questix-lab-drive-runs';
const MAX_RUNS = 20;
const MAX_STORED_CHARS = 1024 * 1024;

// Fields added after the first release; entries stored before them get these values.
const RUN_DEFAULTS = {
  conditions: '',
  program: '',
  ended: '',
  reason: '',
  robot: '',
  references: {},
  cut: false,
};

// An `undefined` from the caller (e.g. `program: plan.program` with no program) keeps the default.
const withDefaults = (run) => ({
  ...RUN_DEFAULTS,
  ...Object.fromEntries(Object.entries(run).filter(([, value]) => value !== undefined)),
});

const listeners = new Set();
let runs = load();
let nextId = runs.reduce((max, run) => Math.max(max, run.id), 0) + 1;

function load() {
  try {
    const kept = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? '[]');
    return Array.isArray(kept) ? kept.filter((run) => run?.report?.summary).map(withDefaults) : [];
  } catch {
    return [];
  }
}

function store() {
  try {
    // Recordings are left out: a few minutes of scans would not fit.
    let kept = runs.map(({ recording, ...run }) => run);
    let text = JSON.stringify(kept);
    while (text.length > MAX_STORED_CHARS && kept.length > 1) {
      kept = kept.slice(0, -1);
      text = JSON.stringify(kept);
    }
    globalThis.localStorage?.setItem(STORE_KEY, text);
  } catch {
    /* storage blocked or full: the history lasts until the page is closed */
  }
}

function notify() {
  for (const fn of listeners) fn(runs);
}

/**
 * Add a finished run and return the new entry.
 * - `slot` goes into a saved file's name (e.g. control-speed), `lesson` names where it was run.
 * - `conditions` is a short text of the settings (「0.2 m/s」, 「P 1.2・I 0・D 0.3」), `program`
 *   the sentence that described the run, `ended` how it ended (drive-view driveEndedText) and
 *   `reason` drive-link's reason code (drive-report-view driveRunStatus reads it).
 * - `robot` is the robot's name ('' when unknown).
 * - `references.front` lists wall distances to draw on the wall chart: `[{value: 0.5, label}]` (m).
 * - `cut` is true when the recording was cut off by a lost connection.
 * - `recording` is what was recorded meanwhile (recording-core shape). Callers skip runs where
 *   isEmptyRun(recording) is true.
 */
function addDriveRun({ slot, lesson, recording, ...details }) {
  const run = {
    ...withDefaults(details),
    id: nextId++,
    at: recording.recordedAt ?? new Date().toISOString(),
    slot,
    lesson,
    report: driveReport(recording),
    recording,
  };
  runs = [run, ...runs].slice(0, MAX_RUNS);
  store();
  notify();
  return run;
}

const driveRuns = () => runs;
const driveRun = (id) => runs.find((run) => run.id === id) ?? null;

// Save the full recording of a run of this page (not of a run restored from storage).
function saveDriveRun(id, kind) {
  const run = driveRun(id);
  if (!run?.recording) return;
  const file = recordingFile(run.recording, `drive-${run.slot ?? 'run'}`, kind);
  downloadFile(file.name, file.text, file.type);
}

function clearDriveRuns() {
  runs = [];
  store();
  notify();
}

// Subscribe to changes of the list; returns the unsubscribe function.
function onDriveRuns(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export {
  addDriveRun,
  driveRuns,
  driveRun,
  saveDriveRun,
  clearDriveRuns,
  onDriveRuns,
  isEmptyRun,
  RUN_DEFAULTS,
};
