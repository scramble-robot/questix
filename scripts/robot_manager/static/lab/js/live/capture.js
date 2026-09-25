import { onRobot, robotState } from './robot-link.js';
import { CAPTURE_DEFAULTS, steadyMeasurements, liveControlRun } from './capture-core.js';
import {
  RECORDING_STREAMS,
  makeRecording,
  parseRecording,
  serializeRecording,
  recordingFile,
} from './recording-core.js';
import { BAG_DEFAULT_CONFIG, readRosbag } from './rosbag-core.js';

// Recording a stretch of live robot data for a lesson. Every course that compares its simulation
// with the real machine goes through `recordStream` here, so the connection checks, the timeout,
// the abort and the learner-facing messages exist once. The link stays observation-only: nothing
// in this module sends anything to the robot.

// A paired stream older than this is not attached to the sample: the two values would not describe
// the same moment. Measured on arrival, because only some streams carry a stamp of their own.
const PAIR_FRESH_MS = 500;
const DEFAULT_SECONDS = 12;

const MESSAGES = {
  notConnected: '先に画面右上の「実機」からロボットに接続してください。',
  lost: '記録の途中でロボットとの接続が切れました。',
  aborted: '記録を中止しました。',
  noSamples: '記録が届きませんでした。ロボットのノードが動いているか確かめてください。',
};

const isConnected = () => robotState().phase === 'open';

/**
 * Collect samples for `seconds`. Every message on the `trigger` stream makes one sample, with the
 * latest message of each `pair` stream attached; a sample whose paired message is older than
 * PAIR_FRESH_MS is dropped and counted in `missed`.
 *
 * Resolves with `{samples, missed, config}`; rejects with an Error whose message is meant to be
 * shown to the learner. `signal` stops the recording early.
 */
function recordStream({ trigger, pair = [], seconds = DEFAULT_SECONDS, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const state = robotState();
    if (state.phase !== 'open') {
      reject(new Error(MESSAGES.notConnected));
      return;
    }
    const samples = [];
    const latest = new Map();
    const unsubscribe = [];
    let missed = 0;
    let timer = 0;

    const stop = () => {
      for (const off of unsubscribe) off();
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const fail = (error) => {
      stop();
      reject(error);
    };
    const finish = () => {
      stop();
      resolve({ samples, missed, config: state.hello.config });
    };
    const abort = () => fail(new Error(MESSAGES.aborted));

    for (const name of pair)
      unsubscribe.push(
        onRobot(name, (message) => latest.set(name, { message, at: performance.now() })),
      );
    unsubscribe.push(
      onRobot(trigger, (message) => {
        const now = performance.now();
        const attached = {};
        for (const name of pair) {
          const held = latest.get(name);
          attached[name] = held && now - held.at <= PAIR_FRESH_MS ? held.message : null;
        }
        if (pair.some((name) => attached[name] === null)) {
          missed += 1;
          return;
        }
        samples.push({ [trigger]: message, ...attached });
        onProgress?.(samples.length);
      }),
    );
    unsubscribe.push(
      onRobot('state', (next) => {
        if (next.phase !== 'open') fail(new Error(MESSAGES.lost));
      }),
    );
    timer = setTimeout(finish, seconds * 1000);
    signal?.addEventListener('abort', abort);
  });
}

/**
 * Record every lesson stream the robot publishes (drive, twist, scan, odom, and the launcher's
 * roller and shot) — or only `streams` — for `seconds`, as a
 * recording of recording-core — the shape that is saved, reopened and read from a rosbag, so a
 * lesson has one code path for all three. Progress counts the messages of `countStream`.
 *
 * `signal` aborts (rejects with MESSAGES.aborted); `finish` ends the recording early and keeps
 * what was collected, for lessons where the learner says when the robot is done. With `keepOnLost`,
 * a lost link resolves with what was collected so far, marked `cut: true`, instead of rejecting —
 * for driving runs, whose first seconds are worth keeping even when the phone drops off the Wi-Fi.
 */
function recordRobot({
  seconds = DEFAULT_SECONDS,
  countStream = 'drive',
  onProgress,
  signal,
  finish,
  keepOnLost = false,
  streams: names = RECORDING_STREAMS,
} = {}) {
  return new Promise((resolve, reject) => {
    const state = robotState();
    if (state.phase !== 'open') {
      reject(new Error(MESSAGES.notConnected));
      return;
    }
    const streams = Object.fromEntries(names.map((name) => [name, []]));
    const unsubscribe = [];
    let timer = 0;
    const stop = () => {
      for (const off of unsubscribe) off();
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      finish?.removeEventListener('abort', finished);
    };
    const fail = (error) => {
      stop();
      reject(error);
    };
    const done = (cut = false) => {
      stop();
      const recording = makeRecording({
        source: 'live',
        name: '',
        recordedAt: new Date().toISOString(),
        config: state.hello.config,
        topics: Object.fromEntries(
          names.map((name) => [name, state.hello.streams?.[name] ?? null]),
        ),
        streams,
      });
      resolve(cut === true ? { ...recording, cut: true } : recording);
    };
    const abort = () => fail(new Error(MESSAGES.aborted));
    const finished = () => done();
    for (const name of names)
      unsubscribe.push(
        onRobot(name, (message) => {
          streams[name].push(message);
          if (name === countStream) onProgress?.(streams[name].length);
        }),
      );
    unsubscribe.push(
      onRobot('state', (next) => {
        if (next.phase === 'open') return;
        if (keepOnLost) done(true);
        else fail(new Error(MESSAGES.lost));
      }),
    );
    timer = setTimeout(done, seconds * 1000);
    signal?.addEventListener('abort', abort);
    finish?.addEventListener('abort', finished);
  });
}

// --- recordings as files ---------------------------------------------------------------------

const MAX_JSON_BYTES = 50 * 1024 * 1024; // a saved recording; 45 minutes of every stream is ~30 MB
const MAX_BAG_BYTES = 1024 * 1024 * 1024; // a rosbag recorded with -a also holds camera images
const MCAP_MAGIC = 0x89; // first byte of an MCAP file; a JSON file starts with "{" or a BOM

/**
 * Open a file the learner picked: a recording this material saved (.json) or a rosbag the robot
 * recorded (.mcap, robot_manager's recording card). A bag carries no wheel geometry, so the
 * connected robot's is used, or the robot's defaults when none is connected (`assumedConfig`).
 * Resolves with the recording; rejects with a message meant for the learner.
 */
async function openRecordingFile(file) {
  const bytes = await file.slice(0, 1).arrayBuffer();
  const isBag = new Uint8Array(bytes)[0] === MCAP_MAGIC || /\.mcap$/i.test(file.name);
  if (file.size > (isBag ? MAX_BAG_BYTES : MAX_JSON_BYTES))
    throw new Error(
      isBag ? '1 GBより大きいrosbagは開けません。' : '50 MBより大きい記録ファイルは開けません。',
    );
  if (!isBag) {
    // The note names the file the learner picked, whatever the recording was called when saved.
    const recording = { ...parseRecording(await file.text()), name: file.name };
    return { recording, assumedConfig: false };
  }
  const bag = readRosbag(await file.arrayBuffer());
  const hello = robotState().phase === 'open' ? robotState().hello : null;
  const recording = makeRecording({
    source: 'rosbag',
    name: file.name,
    recordedAt: new Date(bag.start * 1000).toISOString(),
    config: hello?.config ?? BAG_DEFAULT_CONFIG,
    topics: bag.topics,
    streams: bag.streams,
  });
  return { recording, assumedConfig: !hello };
}

// --- keeping the last recording across a reload ----------------------------------------------

// Per-browser convenience only: storage can be blocked, full or cleared, so a lesson must work
// without it, and saving the file stays the way to keep a recording. Large recordings (a long
// rosbag) do not fit and are simply not kept.
const STORE_PREFIX = 'questix-lab-recording:';
const MAX_KEPT_CHARS = 3 * 1024 * 1024;

function keepRecording(slot, recording) {
  try {
    if (!recording) {
      localStorage.removeItem(STORE_PREFIX + slot);
      return true;
    }
    const text = serializeRecording(recording);
    if (text.length > MAX_KEPT_CHARS) {
      localStorage.removeItem(STORE_PREFIX + slot);
      return false;
    }
    localStorage.setItem(STORE_PREFIX + slot, text);
    return true;
  } catch {
    return false;
  }
}

function keptRecording(slot) {
  try {
    const text = localStorage.getItem(STORE_PREFIX + slot);
    return text ? parseRecording(text) : null;
  } catch {
    return null;
  }
}

// --- 班の名前: which group made a recording ----------------------------------------------------

// Typed once per browser (a class shares robots, not devices) and written into every recording
// made here, so a file handed to the teacher or to another group says whose run it was.
const GROUP_KEY = 'questix-lab-group';
const MAX_GROUP_CHARS = 30;
let group = readGroup();

function readGroup() {
  try {
    return (localStorage.getItem(GROUP_KEY) ?? '').slice(0, MAX_GROUP_CHARS);
  } catch {
    return '';
  }
}

const groupName = () => group.trim();

function setGroupName(text) {
  group = String(text ?? '').slice(0, MAX_GROUP_CHARS);
  try {
    if (group.trim()) localStorage.setItem(GROUP_KEY, group);
    else localStorage.removeItem(GROUP_KEY);
  } catch {
    /* storage blocked: the name lasts until the page closes */
  }
}

// Redrawing a lesson page on every message would repaint it 20 times a second for no visible gain,
// so progress is reported at most this often. The final result is always reported.
const PROGRESS_PERIOD_MS = 400;

// Wraps an `onProgress` handler so it runs at most every PROGRESS_PERIOD_MS.
function throttleProgress(handler) {
  let last = 0;
  return (count) => {
    const now = performance.now();
    if (now - last < PROGRESS_PERIOD_MS) return;
    last = now;
    handler(count);
  };
}

// The connection as a view model: what a lesson needs to decide whether it can offer a recording.
function liveLink() {
  const state = robotState();
  return {
    phase: state.phase,
    connected: state.phase === 'open',
    url: state.url,
    streams: state.hello?.streams ?? {},
    rates: state.rates ?? {},
    config: state.hello?.config ?? null, // wheel_radius, wheel_separation of this robot
    robot: state.hello?.robot ?? null, // {name, domain}; null on bridges older than that
  };
}

// Whether the robot is publishing everything a recording needs, so a lesson can say which stream
// is missing instead of offering a button that always fails.
function missingStreams(names) {
  const link = liveLink();
  if (!link.connected) return names.slice();
  return names.filter((name) => !link.streams[name] || !(link.rates[name] > 0));
}

// Subscribe to connection changes; returns the unsubscribe function.
const onLiveLink = (fn) => onRobot('state', () => fn(liveLink()));

export {
  CAPTURE_DEFAULTS,
  MESSAGES,
  PAIR_FRESH_MS,
  DEFAULT_SECONDS,
  isConnected,
  throttleProgress,
  recordStream,
  recordRobot,
  openRecordingFile,
  recordingFile,
  keepRecording,
  keptRecording,
  groupName,
  setGroupName,
  MAX_GROUP_CHARS,
  liveLink,
  missingStreams,
  onLiveLink,
  steadyMeasurements,
  liveControlRun,
};
