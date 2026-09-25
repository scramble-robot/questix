// Records kept on the robot (questix_lab_bridge): the HTTP client and the rules around it — where
// the bridge's API is, how long to wait, what the learner is told when it fails, which entries a
// filter keeps and which lessons can open an entry. No DOM and no WebSocket: `fetch` and the page's
// location are passed in or read when used, so every rule is a Node test
// (test/records-core.test.mjs).
//
// The bridge's API (plain GET on the WebSocket's host and port):
// - /api/records → { records: [Entry…] newest first, quota: {used_bytes, limit_bytes}, save }
//   Entry = { id, source: 'lab'|'auto'|'rosbag-cache', lesson|null, label, group|null, robot|null,
//             recordedAt, seconds, outcome|null, bytes }
// - /api/records/<id> → a questix-lab-recording (recording-core.js)
// - /api/rosbags → { bags: [{name, startedAt, seconds, bytes, topics, usable, reason}], dir }
// - /api/rosbags/<name>/recording?start=<s>&seconds=<s> → a questix-lab-recording from the bag
// Errors come back as JSON `{ error: <Japanese> }` with a 4xx/5xx status.

import { loadJson, fillSentence as fill } from '../core/content.js';
import {
  parseRecording,
  missingInRecording,
  RECORDING_STREAMS,
  UNKNOWN_CONDITIONS,
} from './recording-core.js';
import { runStatusKey } from './drive-report-core.js';

const copy = await loadJson('content/live/records.json');
const statusCopy = (await loadJson('content/live/drive-report.json')).status;

const LIST_TIMEOUT_MS = 8000;
const RECORD_TIMEOUT_MS = 30000;
// Converting five minutes of a bag with every topic takes the robot a while.
const CONVERT_TIMEOUT_MS = 180000;
// Keep in sync with rosbag_max_seconds in questix_lab_bridge/config/lab_bridge.yaml.
const BAG_MAX_SECONDS = 300;
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const SOURCES = ['lab', 'auto', 'rosbag-cache'];
const BYTES_PER_MB = 1024 * 1024;
const MAX_LABEL = 60;
const MAX_GROUP = 30;
// Lessons whose recordings are not tied to one lesson: they can be opened wherever the streams fit.
const OPEN_ANYWHERE = ['free-drive', 'bench', 'rosbag', 'unknown'];
// The ROS topic behind each stream, as a bag names it (namespaced topics end the same way).
const BAG_TOPICS = {
  drive: '/drive_status',
  twist: '/target_twist',
  scan: '/scan',
  odom: '/odom',
};

// Every lesson that can take a recording. `lessons`: the recordings made for it; `needs`: the
// streams its `apply` reads; `topic`: the course topic to open first (null: the lesson picks);
// `compare`: whether it can also draw a recording next to the one on screen.
const RECORD_TARGETS = [
  {
    id: 'control-speed',
    course: 'control',
    topic: null,
    needs: ['drive', 'twist'],
    compare: true,
  },
  { id: 'control-distance', course: 'control', topic: null, needs: ['scan'], compare: true },
  { id: 'measurement-control', course: 'control', topic: null, needs: ['drive', 'twist'] },
  { id: 'measurement-slam', course: 'slam', topic: null, needs: ['odom'] },
  { id: 'slam', course: 'slam', topic: null, needs: ['scan', 'drive'] },
  { id: 'planning-room', course: 'planning', topic: 'room', needs: ['scan', 'odom'] },
  { id: 'motor-bench', course: 'motor', topic: 'real', needs: ['drive', 'twist'] },
];

class RecordsError extends Error {}
const recordsError = (text) => new RecordsError(text);

const cleanText = (value, max = MAX_LABEL) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';
const finiteOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

// --- where the API is --------------------------------------------------------------------------

/**
 * The HTTP base of the bridge behind the WebSocket `wsUrl` (robot-link's `url`, ws://host:port):
 * the page's own origin when the page was served by that bridge, otherwise http(s)://host:port.
 * '' when there is no usable address.
 */
function recordsBaseUrl(wsUrl, page = globalThis.location) {
  let url;
  try {
    url = new URL(wsUrl);
  } catch {
    return '';
  }
  if (!['ws:', 'wss:'].includes(url.protocol)) return '';
  const scheme = url.protocol === 'wss:' ? 'https:' : 'http:';
  if (page?.host === url.host && page.protocol === scheme && page.origin) return page.origin;
  return `${scheme}//${url.host}`;
}

// --- fetching with a time limit and Japanese errors -------------------------------------------

// Aborts when either the caller's signal does or `ms` pass; says which one it was.
function limitedSignal(ms, signal) {
  const controller = new AbortController();
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, ms);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel);
  if (signal?.aborted) controller.abort();
  const release = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  };
  return { signal: controller.signal, state, release };
}

async function errorOf(response, notFound) {
  let message = '';
  try {
    message = cleanText((await response.json())?.error, 300);
  } catch {
    /* not JSON: the status says enough */
  }
  if (message) return recordsError(message);
  if (response.status === 404) return recordsError(notFound);
  return recordsError(fill(copy.errors.status, { status: response.status }));
}

/**
 * GET `url` and resolve with the body as text. Rejects with a RecordsError whose message is the
 * learner's sentence: the bridge's own `error`, no answer within `timeoutMs`, no connection, or
 * `notFound` for a 404 without a message.
 */
async function fetchText(url, { timeoutMs, signal, fetchImpl = globalThis.fetch, notFound }) {
  const limit = limitedSignal(timeoutMs, signal);
  try {
    const response = await fetchImpl(url, { signal: limit.signal, cache: 'no-store' });
    if (!response.ok) throw await errorOf(response, notFound);
    return await response.text();
  } catch (error) {
    if (error instanceof RecordsError) throw error;
    if (limit.state.timedOut)
      throw recordsError(fill(copy.errors.timeout, { seconds: Math.round(timeoutMs / 1000) }));
    if (limit.signal.aborted) throw recordsError(copy.errors.cancelled);
    throw recordsError(copy.errors.network);
  } finally {
    limit.release();
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw recordsError(copy.errors.notJson);
  }
}

// --- what the bridge lists ----------------------------------------------------------------------

const robotNameOf = (robot) =>
  cleanText(typeof robot === 'string' ? robot : (robot?.name ?? ''), MAX_LABEL);

function cleanOutcome(outcome) {
  const reason = cleanText(outcome?.reason, 40);
  return reason ? { reason, label: cleanText(outcome.label) } : null;
}

/** One entry of /api/records, cleaned; null for an entry that cannot be used (bad id). */
function normalizeEntry(raw) {
  const id = typeof raw?.id === 'string' ? raw.id : '';
  if (!ID_PATTERN.test(id)) return null;
  return {
    id,
    source: SOURCES.includes(raw.source) ? raw.source : 'lab',
    lesson: cleanText(raw.lesson, 40) || null,
    label: cleanText(raw.label),
    group: cleanText(raw.group, MAX_GROUP) || null,
    robot: robotNameOf(raw.robot) || null,
    recordedAt: typeof raw.recordedAt === 'string' ? raw.recordedAt : '',
    seconds: Math.max(0, finiteOr(raw.seconds, 0)),
    outcome: cleanOutcome(raw.outcome),
    bytes: Math.max(0, finiteOr(raw.bytes, 0)),
  };
}

/** The streams a bag holds, from its topic names. */
function bagStreams(topics) {
  const names = Array.isArray(topics) ? topics.filter((topic) => typeof topic === 'string') : [];
  // Only the streams a bag is converted into (the launcher's statuses are not).
  return RECORDING_STREAMS.filter(
    (stream) =>
      BAG_TOPICS[stream] &&
      names.some((topic) => topic === BAG_TOPICS[stream] || topic.endsWith(BAG_TOPICS[stream])),
  );
}

/** One entry of /api/rosbags, cleaned; null without a name. */
function normalizeBag(raw) {
  const name = cleanText(raw?.name, 200);
  if (!name || name.includes('/') || name.startsWith('.')) return null;
  const topics = Array.isArray(raw.topics) ? raw.topics.filter((t) => typeof t === 'string') : [];
  return {
    name,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    seconds: Math.max(0, finiteOr(raw.seconds, 0)),
    bytes: Math.max(0, finiteOr(raw.bytes, 0)),
    topics,
    streams: bagStreams(topics),
    usable: raw.usable !== false,
    reason: cleanText(raw.reason, 200) || null,
  };
}

function recordList(data) {
  const records = Array.isArray(data?.records) ? data.records.map(normalizeEntry) : [];
  const quota = data?.quota ?? {};
  return {
    records: records.filter(Boolean),
    quota: {
      used: Math.max(0, finiteOr(quota.used_bytes, 0)),
      limit: Math.max(0, finiteOr(quota.limit_bytes, 0)),
    },
    save: data?.save === true,
  };
}

function bagList(data) {
  const bags = Array.isArray(data?.bags) ? data.bags.map(normalizeBag) : [];
  return { bags: bags.filter(Boolean), dir: cleanText(data?.dir, 300) };
}

// --- a time window of a bag ----------------------------------------------------------------------

/**
 * The part of a bag to convert: `start` and `seconds` clamped to the bag and to BAG_MAX_SECONDS.
 * Returns `{start, seconds}`, or `{error}` with the learner's sentence for numbers that make no
 * sense (negative, not numbers). A start past the end moves back to leave at least one second.
 */
function bagWindow(bag, start, seconds) {
  const from = Number(start);
  const length = Number(seconds);
  if (!Number.isFinite(from) || !Number.isFinite(length) || from < 0 || length <= 0)
    return { error: copy.bag.badNumber };
  if (length > BAG_MAX_SECONDS) return { error: fill(copy.bag.tooLong, { max: BAG_MAX_SECONDS }) };
  const total = bag.seconds > 0 ? bag.seconds : Infinity;
  const clampedStart = Math.min(from, Math.max(0, total - 1));
  const clampedLength = Math.min(length, total - clampedStart);
  return { start: +clampedStart.toFixed(1), seconds: +clampedLength.toFixed(1) };
}

/** The window offered first: the start of the bag, as much as may be converted at once. */
const defaultBagWindow = (bag) => ({
  start: 0,
  seconds: Math.min(BAG_MAX_SECONDS, bag.seconds > 0 ? Math.ceil(bag.seconds) : BAG_MAX_SECONDS),
});

// --- the client ------------------------------------------------------------------------------------

/**
 * The API of the bridge at `base` (recordsBaseUrl). Every method takes an optional AbortSignal
 * and rejects with a RecordsError whose message is meant for the learner.
 */
function recordsClient(base, { fetchImpl } = {}) {
  const get = (path, timeoutMs, signal, notFound) =>
    fetchText(base + path, { timeoutMs, signal, fetchImpl, notFound });
  const checkedId = (id) => {
    if (!ID_PATTERN.test(String(id))) throw recordsError(copy.errors.badId);
    return id;
  };
  return {
    base,
    async list(signal) {
      const text = await get('/api/records', LIST_TIMEOUT_MS, signal, copy.errors.oldBridge);
      return recordList(parseJson(text));
    },
    async recording(id, signal) {
      const path = `/api/records/${checkedId(id)}`;
      return parseRecording(await get(path, RECORD_TIMEOUT_MS, signal, copy.errors.gone));
    },
    async bags(signal) {
      const text = await get('/api/rosbags', LIST_TIMEOUT_MS, signal, copy.errors.oldBridge);
      return bagList(parseJson(text));
    },
    async convert(name, window, signal) {
      const query = `?start=${window.start}&seconds=${window.seconds}`;
      const path = `/api/rosbags/${encodeURIComponent(name)}/recording${query}`;
      return parseRecording(await get(path, CONVERT_TIMEOUT_MS, signal, copy.errors.gone));
    },
  };
}

// --- filters ------------------------------------------------------------------------------------

/**
 * The entries a learner asked for. `filters`: `lesson` ('' = all), `group` ('' = all), `mine`
 * (only `myGroup`'s), `controller` (keep the bridge's own recordings of controller driving).
 */
function filterEntries(
  entries,
  { lesson = '', group = '', mine = false, controller = true },
  myGroup = '',
) {
  return entries.filter((entry) => {
    if (!controller && entry.source === 'auto') return false;
    if (lesson && lessonKey(entry) !== lesson) return false;
    if (group && entry.group !== group) return false;
    if (mine && (!myGroup || entry.group !== myGroup)) return false;
    return true;
  });
}

/** Which lesson an entry belongs to, for the filter and the name shown: 'rosbag' for bags. */
function lessonKey(entry) {
  if (entry.source === 'rosbag-cache') return 'rosbag';
  if (entry.source === 'auto') return 'free-drive';
  return entry.lesson && copy.lessons[entry.lesson] ? entry.lesson : 'unknown';
}

/** The lessons and groups present in `entries`, for the filter's choices (sorted, no repeats). */
function filterChoices(entries) {
  const lessons = [...new Set(entries.map(lessonKey))];
  const groups = [...new Set(entries.map((entry) => entry.group).filter(Boolean))].sort();
  return { lessons, groups };
}

// --- which lessons can open an entry -----------------------------------------------------------

const targetById = (id) => RECORD_TARGETS.find((target) => target.id === id) ?? null;

/**
 * The lessons an entry can be opened in: the lesson it was made for, or — for a controller drive,
 * a bench test, a bag or an entry of unknown lesson — every lesson whose streams it has
 * (`streams`: known for bags; a recording of the bridge holds every stream otherwise).
 */
function targetsFor(entry, streams = RECORDING_STREAMS) {
  const key = lessonKey(entry);
  const own = RECORD_TARGETS.filter((target) => target.id === key);
  if (own.length) return own;
  if (!OPEN_ANYWHERE.includes(key)) return [];
  return RECORD_TARGETS.filter((target) => target.needs.every((name) => streams.includes(name)));
}

/** The streams a lesson needs that `recording` lacks, as stream names (recording-core). */
const missingFor = (target, recording) => missingInRecording(recording, target.needs);

// --- words ------------------------------------------------------------------------------------------

const recordedOnly = (entry) => !entry.outcome || entry.outcome.reason === 'recorded';

/** How an entry ended, in a word or two: 「予定どおり走り終えた」「記録だけ」「コントローラーで走行」. */
function outcomeWord(entry) {
  if (entry.source === 'auto') return copy.outcomes.controller;
  if (entry.source === 'rosbag-cache') return copy.outcomes.rosbag;
  if (recordedOnly(entry)) return copy.outcomes.recorded;
  return statusCopy[runStatusKey(entry.outcome.reason)];
}

/** 'ok' | 'stopped' | 'problem' | 'none': the icon next to the outcome word. */
function outcomeKind(entry) {
  if (!['lab', 'local'].includes(entry.source) || recordedOnly(entry)) return 'none';
  const key = runStatusKey(entry.outcome.reason);
  if (key === 'controller') return 'stopped';
  return ['ok', 'stopped', 'problem'].includes(key) ? key : 'none';
}

/**
 * A run of this browser's history (drive-history.js) in the shape of a robot's entry, so both
 * lists read the same: `source: 'local'`, `id` the run's id.
 */
function localEntry(run) {
  const summary = run.report?.summary ?? {};
  return {
    id: run.id,
    source: 'local',
    lesson: run.slot || null,
    label: '',
    group: run.group || null,
    robot: run.robot || null,
    recordedAt: run.at,
    seconds: Math.max(0, finiteOr(summary.seconds, 0)),
    outcome: run.reason ? { reason: run.reason, label: '' } : null,
    bytes: 0,
  };
}

/**
 * What a list shows for an entry: its name (the label, or the lesson when it has none — the
 * bridge's 「設定：不明」 for a lab recording without conditions counts as none), the lesson it
 * belongs to, how it ended and where it can be opened (`streams` as in targetsFor).
 */
function describeEntry(entry, streams = RECORDING_STREAMS) {
  const lesson = lessonKey(entry);
  const named = entry.label && entry.label !== UNKNOWN_CONDITIONS;
  return {
    entry,
    label: named ? entry.label : lessonName(lesson),
    lesson,
    outcome: outcomeWord(entry),
    outcomeKind: outcomeKind(entry),
    targets: targetsFor(entry, streams),
  };
}

const lessonName = (key) => copy.lessons[key] ?? copy.lessons.unknown;

/** Megabytes with one decimal, at least 0.1 for anything above zero. */
function megabytes(bytes) {
  if (!(bytes > 0)) return '0';
  return Math.max(0.1, bytes / BYTES_PER_MB).toFixed(1);
}

export {
  BAG_MAX_SECONDS,
  LIST_TIMEOUT_MS,
  RECORD_TIMEOUT_MS,
  CONVERT_TIMEOUT_MS,
  RECORD_TARGETS,
  RecordsError,
  copy as recordsCopy,
  recordsBaseUrl,
  fetchText,
  normalizeEntry,
  normalizeBag,
  bagStreams,
  recordList,
  bagList,
  bagWindow,
  defaultBagWindow,
  recordsClient,
  filterEntries,
  filterChoices,
  lessonKey,
  lessonName,
  targetById,
  targetsFor,
  missingFor,
  outcomeWord,
  outcomeKind,
  localEntry,
  describeEntry,
  megabytes,
};
