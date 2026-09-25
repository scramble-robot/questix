import { render } from '../vendor/lit-html.js';
import { fillSentence as fill } from '../core/content.js';
import {
  recordsCopy as copy,
  describeEntry,
  lessonKey,
  bagWindow,
  defaultBagWindow,
} from './records-core.js';
import { missingInRecording } from './recording-core.js';
import { robotRecordsClient, robotRecordsInfo } from './robot-records.js';
import { recordPicker } from './records-view.js';
import { captureCopy } from './live-view.js';
import { openRobotDialog } from './live-ui.js';

// 「ロボットの記録から選ぶ」: the dialog every lesson opens next to its file input. It lists the
// records kept on the connected robot — those of the lesson first, all of them (and Robot
// Manager's rosbags) on request — fetches the one chosen and hands it back, so the lesson opens
// it exactly as it opens a file. One dialog for the page (#recordPicker in index.html).

const TICK_MS = 1000; // how often the "converting… N秒" line counts

const picker = {
  resolve: null, // the pending pickRobotRecord promise
  lesson: '',
  needs: [],
  compare: false,
  showAll: false,
  loading: false,
  error: '',
  message: '',
  records: [],
  bags: [],
  busy: null, // key of the record being fetched
  itemErrors: new Map(),
  windows: new Map(), // bag name → {start, seconds}
  converting: null, // {key, startedAt, abort, timer}
};

const dialog = () => document.getElementById('recordPicker');
const streamList = (names) => names.map((name) => captureCopy.streamNames[name] ?? name).join('と');

function finish(recording) {
  const resolve = picker.resolve;
  picker.resolve = null;
  picker.converting?.abort.abort();
  clearInterval(picker.converting?.timer);
  picker.converting = null;
  if (dialog().open) dialog().close();
  resolve?.(recording);
}

// --- the model ------------------------------------------------------------------------------------

function recordItems() {
  const shown = picker.showAll
    ? picker.records
    : picker.records.filter((entry) => lessonKey(entry) === picker.lesson);
  return shown.map((entry) => ({
    ...describeEntry(entry),
    key: `robot:${entry.id}`,
    busy: picker.busy === `robot:${entry.id}`,
    error: picker.itemErrors.get(`robot:${entry.id}`) ?? '',
    message: '',
  }));
}

function bagItems() {
  if (!picker.showAll) return [];
  return picker.bags.map((bag) => {
    const key = `bag:${bag.name}`;
    return {
      key,
      bag,
      window: picker.windows.get(bag.name) ?? defaultBagWindow(bag),
      error: picker.itemErrors.get(key) ?? '',
      converting:
        picker.converting?.key === key
          ? { seconds: Math.round((performance.now() - picker.converting.startedAt) / 1000) }
          : null,
    };
  });
}

function model() {
  return {
    connected: robotRecordsInfo().connected,
    lesson: picker.lesson,
    streams: streamList(picker.needs),
    compare: picker.compare,
    showAll: picker.showAll,
    loading: picker.loading,
    error: picker.error,
    message: picker.message,
    records: recordItems(),
    bags: bagItems(),
  };
}

function update() {
  if (dialog()) render(recordPicker(model(), actions), dialog());
}

// --- loading --------------------------------------------------------------------------------------

async function load() {
  const client = robotRecordsClient();
  if (!client) {
    update();
    return;
  }
  if (!robotRecordsInfo().list) {
    picker.error = copy.errors.oldBridge;
    update();
    return;
  }
  Object.assign(picker, { loading: true, error: '' });
  update();
  try {
    const [list, bags] = await Promise.all([
      client.list(),
      robotRecordsInfo().rosbags ? client.bags().catch(() => ({ bags: [] })) : { bags: [] },
    ]);
    picker.records = list.records;
    picker.bags = bags.bags.filter((bag) => bag.usable);
  } catch (error) {
    picker.error = error.message;
  }
  picker.loading = false;
  update();
}

// A recording that lacks what the lesson needs is refused here, where another can still be chosen.
function accept(recording, key) {
  const missing = missingInRecording(recording, picker.needs);
  if (missing.length) {
    picker.itemErrors.set(key, fill(copy.picker.missing, { streams: streamList(missing) }));
    return;
  }
  finish(recording);
}

async function use(key) {
  const client = robotRecordsClient();
  const entry = picker.records.find((candidate) => `robot:${candidate.id}` === key);
  if (!client || !entry || picker.busy) return;
  picker.busy = key;
  picker.itemErrors.delete(key);
  update();
  try {
    const recording = await client.recording(entry.id);
    picker.busy = null;
    // The lesson's note names it as the list did.
    accept({ ...recording, name: describeEntry(entry).label }, key);
  } catch (error) {
    picker.busy = null;
    picker.itemErrors.set(key, error.message);
  }
  update();
}

async function convertBag(key) {
  const client = robotRecordsClient();
  const bag = picker.bags.find((candidate) => `bag:${candidate.name}` === key);
  if (!client || !bag || picker.converting) return;
  const wanted = picker.windows.get(bag.name) ?? defaultBagWindow(bag);
  const part = bagWindow(bag, wanted.start, wanted.seconds);
  if (part.error) {
    picker.itemErrors.set(key, part.error);
    update();
    return;
  }
  const abort = new AbortController();
  const timer = setInterval(update, TICK_MS);
  picker.converting = { key, startedAt: performance.now(), abort, timer };
  picker.itemErrors.delete(key);
  update();
  try {
    const recording = await client.convert(bag.name, part, abort.signal);
    clearInterval(timer);
    picker.converting = null;
    accept({ ...recording, name: bag.name }, key);
  } catch (error) {
    clearInterval(timer);
    picker.converting = null;
    picker.itemErrors.set(key, abort.signal.aborted ? copy.bag.cancelled : error.message);
  }
  update();
}

const actions = {
  use,
  convertBag,
  cancelConvert: () => picker.converting?.abort.abort(),
  setBagWindow(key, field, value) {
    const bag = picker.bags.find((candidate) => `bag:${candidate.name}` === key);
    if (!bag) return;
    const current = picker.windows.get(bag.name) ?? defaultBagWindow(bag);
    picker.windows.set(bag.name, { ...current, [field]: value });
    picker.itemErrors.delete(key);
    update();
  },
  setShowAll(value) {
    picker.showAll = Boolean(value);
    update();
  },
  close: () => finish(null),
  connect() {
    finish(null);
    openRobotDialog();
  },
  openRecords() {
    finish(null);
    location.hash = '#records';
  },
};

/**
 * Open the picker for lesson `lesson` (a slot such as 'control-speed'), which needs the streams
 * `needs`. Resolves with the chosen recording (recording-core shape, `name` = what the list called
 * it), or null when the learner closed the picker. `compare`: the chosen record is drawn next to
 * the one on screen (the button says so).
 */
function pickRobotRecord({ lesson, needs = [], compare = false }) {
  finish(null);
  Object.assign(picker, {
    lesson,
    needs,
    compare,
    showAll: false,
    error: '',
    message: '',
    busy: null,
    records: [],
    bags: [],
  });
  picker.itemErrors.clear();
  const promise = new Promise((resolve) => {
    picker.resolve = resolve;
  });
  update();
  dialog().showModal();
  load();
  return promise;
}

// Esc and the dialog's own closing end the pick without a recording.
dialog()?.addEventListener('close', () => {
  if (picker.resolve) finish(null);
});

export { pickRobotRecord };
