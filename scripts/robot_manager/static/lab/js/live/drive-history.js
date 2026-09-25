import { driveReport, isEmptyRun, runStatusKind } from './drive-report-core.js';
import { recordingFile, recordingLabel } from './recording-core.js';
import { downloadFile } from '../core/dom.js';

// Every driving run of this browser, newest first: the lessons' runs, the bench test's, and
// recordings opened into the history from a file. The report (drive-report-core.js, thinned) is
// kept in localStorage so a class can look back after a reload. The full recording is kept in
// IndexedDB, so a run's raw data can still be saved (or redrawn by a lesson) after a reload; where
// IndexedDB is blocked or missing (private windows, Node tests) it only lives in memory until the
// page closes. IndexedDB rather than one "save every run" file: a bundle written from memory would
// be lost on the reload it is meant to survive, and localStorage cannot hold minutes of scans.

const STORE_KEY = 'questix-lab-drive-runs';
const MAX_RUNS = 20;
const MAX_STORED_CHARS = 1024 * 1024;
const DB_NAME = 'questix-lab-drive';
const DB_STORE = 'recordings';

// Fields added after the first release; entries stored before them get these values.
const RUN_DEFAULTS = {
  conditions: '',
  program: '',
  ended: '',
  reason: '',
  robot: '',
  group: '',
  source: 'live', // 'live' = run from this device, 'file' = opened into the history
  references: {},
  cut: false,
  kept: false, // the full recording is in IndexedDB
  robotId: '', // the id the robot gave its copy (robot-records.js keepOnRobot), '' when none
};

// An `undefined` from the caller (e.g. `program: plan.program` with no program) keeps the default.
const withDefaults = (run) => ({
  ...RUN_DEFAULTS,
  ...Object.fromEntries(Object.entries(run).filter(([, value]) => value !== undefined)),
  key: run.key ?? `run-${run.id}`,
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

// --- recordings in IndexedDB ------------------------------------------------------------------

// Every call resolves (with null on any failure): the history never depends on the database.
function openDatabase() {
  try {
    if (!globalThis.indexedDB) return Promise.resolve(null);
    return new Promise((resolve) => {
      const request = globalThis.indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  } catch {
    return Promise.resolve(null);
  }
}

const database = openDatabase();

async function inDatabase(mode, action) {
  const db = await database;
  if (!db) return null;
  try {
    return await new Promise((resolve) => {
      const request = action(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function keepInDatabase(run) {
  const done = await inDatabase('readwrite', (objects) => objects.put(run.recording, run.key));
  if (done === null || !runs.includes(run)) return;
  run.kept = true;
  store();
  notify();
}

const forget = (keys) => {
  for (const key of keys) inDatabase('readwrite', (objects) => objects.delete(key));
};

// After a reload: which runs still have their recording, and drop recordings of runs that are
// gone (fell off the list, or the list was cleared in storage).
async function syncDatabase() {
  const keys = await inDatabase('readonly', (objects) => objects.getAllKeys());
  if (!keys) return;
  const present = new Set(keys);
  let changed = false;
  for (const run of runs) {
    const kept = present.has(run.key);
    if (run.kept !== kept) changed = true;
    run.kept = kept;
  }
  forget(keys.filter((key) => !runs.some((run) => run.key === key)));
  if (!changed) return;
  store();
  notify();
}

syncDatabase();

// --- the list -----------------------------------------------------------------------------------

const newKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Add a finished run and return the new entry.
 * - `slot` names the lesson block (e.g. control-speed) and goes into a saved file's name, `lesson`
 *   names where it was run in words.
 * - `conditions` is a short text of the settings (「0.20 m/s」, 「P 1.2・I 0・D 0.3」), `program`
 *   the sentence that described the run, `ended` how it ended (drive-view driveEndedText) and
 *   `reason` drive-link's reason code (drive-report-view driveRunStatus reads it).
 * - `robot` is the robot's name ('' when unknown), `group` the 班の名前 ('' when none).
 * - `source` is 'file' for a recording opened into the history, 'live' otherwise.
 * - `references.front` lists wall distances to draw on the wall chart: `[{value: 0.5, label}]` (m).
 * - `cut` is true when the recording was cut off by a lost connection.
 * - `recording` is what was recorded meanwhile (recording-core shape). Callers skip runs where
 *   isEmptyRun(recording) is true.
 */
function addDriveRun({ slot, lesson, recording, ...details }) {
  const run = {
    ...withDefaults({ ...details, key: newKey() }),
    id: nextId++,
    at: recording.recordedAt ?? new Date().toISOString(),
    slot,
    lesson,
    report: driveReport(recording),
    recording,
  };
  const dropped = [run, ...runs].slice(MAX_RUNS);
  runs = [run, ...runs].slice(0, MAX_RUNS);
  forget(dropped.map((old) => old.key));
  store();
  notify();
  keepInDatabase(run);
  return run;
}

const driveRuns = () => runs;
const driveRun = (id) => runs.find((run) => run.id === id) ?? null;

/** Whether the run's full recording can still be had (in memory, or kept in IndexedDB). */
const hasRecording = (run) => Boolean(run?.recording || run?.kept);

/**
 * The full recording of a run: a Promise of the recording-core shape, or null when it is gone
 * (the run is from before recordings were kept, or storage was blocked and the page reloaded).
 */
async function driveRunRecording(id) {
  const run = driveRun(id);
  if (!run) return null;
  if (run.recording) return run.recording;
  if (!run.kept) return null;
  const recording = await inDatabase('readonly', (objects) => objects.get(run.key));
  if (recording && runs.includes(run)) run.recording = recording;
  return recording;
}

/**
 * The runs of one lesson block (`slot`, e.g. 'control-speed'), newest first, for a lesson that
 * offers them for comparison after a reload:
 * `[{id, at, label, conditions, reason, status, ok, kept}]` — `label` is recordingLabel()'s
 * 「0.20 m/s 10:51:02」, `status` 'ok' | 'stopped' | 'problem', `ok` true for a run that went as
 * planned, `kept` whether driveRunRecording(id) can return its recording.
 */
function driveRunsFor(slot) {
  return runs
    .filter((run) => run.slot === slot)
    .map((run) => ({
      id: run.id,
      at: run.at,
      label: driveRunName(run),
      conditions: run.conditions,
      reason: run.reason,
      status: runStatusKind(run.reason),
      ok: run.reason === 'done',
      kept: hasRecording(run),
    }));
}

/** The run's short name, as recordingLabel() names a recording: 「3班 0.20 m/s 10:51:02」. */
const driveRunName = (run) =>
  recordingLabel({
    group: run.group,
    conditions: run.conditions ? { label: run.conditions } : null,
    recordedAt: run.at,
  });

/** Save a run's full recording as JSON, the tidy CSV table or every message (`kind`). */
async function saveDriveRun(id, kind) {
  const run = driveRun(id);
  const recording = await driveRunRecording(id);
  if (!recording) return false;
  const file = recordingFile(recording, run.slot ?? 'run', kind);
  downloadFile(file.name, file.text, file.type);
  return true;
}

/** Note that the run's recording is also kept on the robot, under `robotId`. */
function markRunOnRobot(id, robotId) {
  const run = driveRun(id);
  if (!run || !robotId) return;
  run.robotId = robotId;
  store();
  notify();
}

function clearDriveRuns() {
  forget(runs.map((run) => run.key));
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
  driveRunsFor,
  driveRunName,
  driveRunRecording,
  hasRecording,
  saveDriveRun,
  markRunOnRobot,
  clearDriveRuns,
  onDriveRuns,
  isEmptyRun,
  RUN_DEFAULTS,
};
