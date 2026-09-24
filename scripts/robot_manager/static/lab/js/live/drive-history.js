import { driveReport } from './drive-report-core.js';
import { recordingFile } from './capture.js';
import { downloadFile } from '../core/dom.js';

// Every driving run of this browser, newest first: the lessons' runs and the bench test's. The
// report (drive-report-core.js, thinned) is kept in localStorage so a class can look back after a
// reload; the full recording only lives in memory, for saving as JSON / CSV right after the run.
// Storage can be blocked or full, so the history works without it.

const STORE_KEY = 'questix-lab-drive-runs';
const MAX_RUNS = 20;
const MAX_STORED_CHARS = 1024 * 1024;

const listeners = new Set();
let runs = load();
let nextId = runs.reduce((max, run) => Math.max(max, run.id), 0) + 1;

function load() {
  try {
    const kept = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
    return Array.isArray(kept) ? kept.filter((run) => run?.report?.summary) : [];
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
    localStorage.setItem(STORE_KEY, text);
  } catch {
    /* storage blocked or full: the history lasts until the page is closed */
  }
}

function notify() {
  for (const fn of listeners) fn(runs);
}

/**
 * Add a finished run. `slot` goes into a saved file's name, `lesson` names where it was run (shown in the list), `program` is the
 * sentence that described it, `ended` how it ended (drive-view driveEndedText), `recording` what
 * was recorded meanwhile (recording-core shape). Returns the new entry.
 */
function addDriveRun({ slot, lesson, program = '', ended = '', reason = '', recording }) {
  const run = {
    id: nextId++,
    at: recording.recordedAt ?? new Date().toISOString(),
    slot, // file-name part, e.g. control-speed
    lesson,
    program,
    ended,
    reason,
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

export { addDriveRun, driveRuns, driveRun, saveDriveRun, clearDriveRuns, onDriveRuns };
