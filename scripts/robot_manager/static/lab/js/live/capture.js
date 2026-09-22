import { onRobot, robotState } from './robot-link.js';
import {
  CAPTURE_DEFAULTS,
  driveSamples,
  steadyMeasurements,
  liveControlRun,
  captureSummary,
} from './capture-core.js';

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
 * Record the wheels: what the robot was asked to do (`/target_twist`) against what it did
 * (`/drive_status`). Resolves with `{rows, summary, config}` where `rows` are the normalised
 * samples of capture-core, ready for `steadyMeasurements` or `liveControlRun`.
 */
async function recordDrive(options = {}) {
  const { samples, config } = await recordStream({
    trigger: 'drive',
    pair: ['twist'],
    ...options,
  });
  if (!samples.length)
    throw new Error(
      '車輪の状態（/drive_status）と速度の指令（/target_twist）が届きませんでした。走行用のノードが動いているか確かめてください。',
    );
  const rows = driveSamples(samples, config);
  return { rows, summary: captureSummary(rows), config };
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
  recordDrive,
  liveLink,
  missingStreams,
  onLiveLink,
  steadyMeasurements,
  liveControlRun,
};
