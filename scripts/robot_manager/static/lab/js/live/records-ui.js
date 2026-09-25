import { render } from '../vendor/lit-html.js';
import { downloadFile } from '../core/dom.js';
import { fillSentence as fill } from '../core/content.js';
import { onRobot, robotState } from './robot-link.js';
import {
  recordsCopy as copy,
  describeEntry,
  localEntry,
  lessonName,
  filterEntries,
  filterChoices,
  bagWindow,
  defaultBagWindow,
} from './records-core.js';
import { recordingFile } from './recording-core.js';
import { driveReport } from './drive-report-core.js';
import { reportCopy } from './drive-report-view.js';
import {
  RUN_DEFAULTS,
  driveRuns,
  driveRunRecording,
  hasRecording,
  onDriveRuns,
} from './drive-history.js';
import { groupName } from './capture.js';
import { robotRecordsClient, robotRecordsInfo, onRobotRecords } from './robot-records.js';
import { openRecordInLesson } from './record-targets.js';
import { recordsPage } from './records-view.js';
import { openRobotDialog } from './live-ui.js';

// 記録の一覧 (route #records): every recording a learner can reach from here — those kept on the
// connected robot (lab runs and 「記録だけする」 of every device, and the robot's own recordings of
// controller driving), Robot Manager's rosbags (converted on the robot, a time window at a time),
// and this browser's run history. Each can be looked at (the run report of the 実機 dialog, with
// its charts), saved as JSON or a spreadsheet CSV, and opened in the lessons that take it.
// State and behaviour here; records-view.js draws, records-core.js holds the rules.

const TICK_MS = 1000; // how often the "converting… N秒" line counts
const KEPT_RECORDINGS = 6; // recordings fetched from the robot kept in memory (a few MB each)

const state = {
  shown: false, // the page is on screen
  loading: false,
  error: '',
  list: null, // records-core recordList() of the robot, null before the first answer
  bags: { loading: false, error: '', list: [] },
  filters: { lesson: '', group: '', mine: false, controller: true },
  openKey: null, // the item whose report is shown
  recordings: new Map(), // key → recording fetched (or converted) for it
  runs: new Map(), // key → run-report entry built from the recording
  busy: new Set(),
  errors: new Map(),
  windows: new Map(), // bag name → {start, seconds} typed
  converting: null, // {key, startedAt, abort, timer}
  converted: new Map(), // bag name → {entry, recording}: the last window converted
};

const page = () => document.getElementById('recordsPage');

// --- items ------------------------------------------------------------------------------------------

function itemOf(key, entry, extra = {}) {
  return {
    ...describeEntry(entry),
    key,
    open: state.openKey === key,
    run: state.runs.get(key) ?? null,
    busy: state.busy.has(key),
    error: state.errors.get(key) ?? '',
    message: '',
    onRobot: false,
    fromFile: false,
    ...extra,
  };
}

// The robot's lab and controller recordings; the bags it converted are listed with the bags.
const robotRecords = () =>
  (state.list?.records ?? []).filter((entry) => entry.source !== 'rosbag-cache');

function robotItems() {
  const shown = filterEntries(robotRecords(), state.filters, groupName());
  return shown.map((entry) => itemOf(`robot:${entry.id}`, entry));
}

// Converted on this page first (named after their window), then those the robot kept.
function convertedItems() {
  const here = [...state.converted.entries()].map(([name, { entry }]) =>
    itemOf(`converted:${name}`, entry),
  );
  const kept = (state.list?.records ?? [])
    .filter((entry) => entry.source === 'rosbag-cache')
    .map((entry) => itemOf(`robot:${entry.id}`, entry));
  return [...here, ...kept];
}

function bagItems() {
  return state.bags.list.map((bag) => {
    const key = `bag:${bag.name}`;
    const converting = state.converting?.key === key ? state.converting : null;
    return {
      key,
      bag,
      window: state.windows.get(bag.name) ?? defaultBagWindow(bag),
      error: state.errors.get(key) ?? '',
      converting: converting
        ? { seconds: Math.round((performance.now() - converting.startedAt) / 1000) }
        : null,
    };
  });
}

function localItems() {
  return driveRuns().map((run) => {
    const entry = localEntry(run);
    const item = itemOf(`local:${run.id}`, entry, {
      onRobot: Boolean(run.robotId),
      fromFile: run.source === 'file',
      // The history's own entry is its report; its recording may be gone after a reload.
      run: state.openKey === `local:${run.id}` ? run : null,
    });
    return {
      ...item,
      label: run.conditions || lessonName(item.lesson),
      targets: hasRecording(run) ? item.targets : [],
    };
  });
}

function model() {
  const info = robotRecordsInfo();
  const records = robotRecords();
  const shown = robotItems();
  return {
    connected: info.connected,
    robot: robotState().hello?.robot?.name ?? '',
    list: Boolean(state.list),
    save: state.list?.save ?? info.save,
    quota: state.list?.quota ?? null,
    loading: state.loading,
    error: state.error,
    filters: state.filters,
    choices: filterChoices(records),
    myGroup: groupName(),
    records: shown,
    total: records.length,
    bags: {
      supported: info.rosbags,
      loading: state.bags.loading,
      error: state.bags.error,
      list: bagItems(),
      converted: convertedItems(),
    },
    local: localItems(),
  };
}

function update() {
  if (!state.shown) return;
  render(recordsPage(model(), actions), page());
}

// --- loading the lists ------------------------------------------------------------------------

async function loadBags(client) {
  if (!robotRecordsInfo().rosbags) return;
  state.bags = { ...state.bags, loading: true, error: '' };
  update();
  try {
    state.bags = { loading: false, error: '', list: (await client.bags()).bags };
  } catch (error) {
    state.bags = { loading: false, error: error.message, list: [] };
  }
  update();
}

async function reload() {
  const client = robotRecordsClient();
  if (!client || state.loading) {
    update();
    return;
  }
  // A bridge from before records says so in its hello: no need to ask it.
  if (!robotRecordsInfo().list) {
    Object.assign(state, { list: null, error: copy.errors.oldBridge });
    update();
    return;
  }
  Object.assign(state, { loading: true, error: '' });
  update();
  const bags = loadBags(client);
  try {
    state.list = await client.list();
  } catch (error) {
    state.error = error.message;
  }
  state.loading = false;
  update();
  await bags;
}

// --- one item's recording ------------------------------------------------------------------------

function keepRecording(key, recording) {
  state.recordings.set(key, recording);
  for (const old of state.recordings.keys()) {
    if (state.recordings.size <= KEPT_RECORDINGS) break;
    if (old !== state.openKey && !old.startsWith('converted:')) state.recordings.delete(old);
  }
}

// Item keys are `<kind>:<id>`: robot:<record id>, converted:<bag name>, local:<run id>.
function splitKey(key) {
  const colon = key.indexOf(':');
  return { kind: key.slice(0, colon), id: key.slice(colon + 1) };
}

async function fetchRecording(key) {
  const { kind, id } = splitKey(key);
  if (kind === 'converted') return state.converted.get(id)?.recording ?? null;
  if (kind === 'local') {
    const recording = await driveRunRecording(Number(id));
    if (!recording) throw new Error(reportCopy.notKept);
    return recording;
  }
  const client = robotRecordsClient();
  if (!client) throw new Error(copy.offline);
  const entry = state.list?.records.find((candidate) => candidate.id === id);
  const recording = await client.recording(id);
  return { ...recording, name: entry ? describeEntry(entry).label : recording.name };
}

// The recording behind `key`, fetched once; null (and the item's error set) when it cannot be had.
async function recordingOf(key) {
  if (state.recordings.has(key)) return state.recordings.get(key);
  state.busy.add(key);
  state.errors.delete(key);
  update();
  try {
    const recording = await fetchRecording(key);
    keepRecording(key, recording);
    return recording;
  } catch (error) {
    state.errors.set(key, error.message);
    return null;
  } finally {
    state.busy.delete(key);
    update();
  }
}

function entryOf(key) {
  const { kind, id } = splitKey(key);
  if (kind === 'robot') return state.list?.records.find((entry) => entry.id === id);
  if (kind === 'converted') return state.converted.get(id)?.entry;
  return null;
}

/** A run of the report view (drive-report-view driveReportView) for a recording of the robot. */
function reportRun(key, recording) {
  const item = describeEntry(entryOf(key));
  const entry = item.entry;
  // The robot's own recordings and 「記録だけする」 were not driven by the page that made them.
  const reason = entry.source === 'lab' ? (recording.outcome?.reason ?? 'recorded') : 'recorded';
  return {
    ...RUN_DEFAULTS,
    id: key,
    key,
    at: recording.recordedAt || entry.recordedAt,
    slot: item.lesson,
    lesson: lessonName(item.lesson),
    conditions: recording.conditions?.label ?? '',
    reason,
    robot: recording.robot?.name ?? entry.robot ?? '',
    group: recording.group ?? entry.group ?? '',
    source: 'robot',
    report: driveReport(recording),
    recording,
    cut: Boolean(recording.cut),
  };
}

async function toggleView(key) {
  if (state.openKey === key) {
    state.openKey = null;
    update();
    return;
  }
  if (key.startsWith('local:')) {
    state.openKey = key;
    update();
    return;
  }
  const recording = await recordingOf(key);
  if (!recording) return;
  if (!state.runs.has(key)) state.runs.set(key, reportRun(key, recording));
  state.openKey = key;
  update();
}

async function save(key, kind) {
  const recording = await recordingOf(key);
  if (!recording) return;
  const lesson = recording.lesson || entryOf(key)?.lesson || 'robot';
  const file = recordingFile(recording, lesson, kind);
  downloadFile(file.name, file.text, file.type);
}

async function openIn(key, targetId, compare) {
  const recording = await recordingOf(key);
  if (!recording) return;
  const opened = await openRecordInLesson(targetId, recording, { compare });
  // A lesson that refused it says why in its own block; this only covers not getting there.
  if (opened === false && state.shown) {
    state.errors.set(key, fill(copy.open.failed, { lesson: lessonName(targetId) }));
    update();
  }
}

// --- rosbags ------------------------------------------------------------------------------------

async function convertBag(key) {
  const client = robotRecordsClient();
  const bag = state.bags.list.find((candidate) => `bag:${candidate.name}` === key);
  if (!client || !bag || state.converting) return;
  const wanted = state.windows.get(bag.name) ?? defaultBagWindow(bag);
  const part = bagWindow(bag, wanted.start, wanted.seconds);
  if (part.error) {
    state.errors.set(key, part.error);
    update();
    return;
  }
  const abort = new AbortController();
  const timer = setInterval(update, TICK_MS);
  state.converting = { key, startedAt: performance.now(), abort, timer };
  state.errors.delete(key);
  update();
  try {
    const recording = await client.convert(bag.name, part, abort.signal);
    const label = `${bag.name}（${part.start}秒から${part.seconds}秒）`;
    const entry = {
      id: bag.name,
      source: 'rosbag-cache',
      lesson: null,
      label,
      group: null,
      robot: recording.robot?.name ?? null,
      recordedAt: recording.recordedAt,
      seconds: part.seconds,
      outcome: null,
      bytes: 0,
    };
    const converted = `converted:${bag.name}`;
    state.converted.set(bag.name, { entry, recording: { ...recording, name: label } });
    state.recordings.delete(converted);
    state.runs.delete(converted);
    state.openKey = null;
    await toggleView(converted);
  } catch (error) {
    state.errors.set(key, abort.signal.aborted ? copy.bag.cancelled : error.message);
  } finally {
    clearInterval(timer);
    state.converting = null;
    update();
  }
}

const actions = {
  reload,
  connect: openRobotDialog,
  setFilter(key, value) {
    state.filters = { ...state.filters, [key]: value };
    update();
  },
  toggleView,
  save,
  openIn,
  convertBag,
  cancelConvert: () => state.converting?.abort.abort(),
  setBagWindow(key, field, value) {
    const bag = state.bags.list.find((candidate) => `bag:${candidate.name}` === key);
    if (!bag) return;
    const current = state.windows.get(bag.name) ?? defaultBagWindow(bag);
    state.windows.set(bag.name, { ...current, [field]: value });
    state.errors.delete(key);
    update();
  },
};

// --- entry points -------------------------------------------------------------------------------

/** The shell shows the page (series.js); the lists are loaded again each time. */
function activateRecords() {
  state.shown = true;
  render(null, page());
  update();
  reload();
}

function leaveRecords() {
  state.shown = false;
}

function initRecords() {
  document.addEventListener('series-leave', leaveRecords);
  onDriveRuns(update);
  onRobotRecords(() => {
    if (state.shown) reload();
  });
  // Connecting or losing the robot changes what the page offers.
  let connected = robotRecordsInfo().connected;
  onRobot('state', () => {
    const now = robotRecordsInfo().connected;
    if (now === connected) return;
    connected = now;
    update();
  });
}

initRecords();

export { activateRecords };
