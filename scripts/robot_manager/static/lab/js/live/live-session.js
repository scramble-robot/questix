import { downloadFile } from '../core/dom.js';
import { fillSentence as fill } from '../core/content.js';
import {
  recordRobot,
  openRecordingFile,
  recordingFile,
  keepRecording,
  keptRecording,
  liveLink,
  missingStreams,
  throttleProgress,
} from './capture.js';
import { missingInRecording, recordingSummary } from './recording-core.js';
import { captureCopy } from './live-view.js';

// The state behind one `liveCaptureControls` block: recording from the robot, opening a saved
// recording or a rosbag, saving the one on screen, and bringing it back after a reload. A lesson
// creates one session per block and supplies `apply`, which turns a recording into the lesson's
// own numbers; everything around that (progress, abort, files, storage, the sentence saying where
// the numbers came from) is the same in every course and lives here.

const streamList = (streams) =>
  streams.map((name) => captureCopy.streamNames[name] ?? name).join('と');

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
}

// Where a recording came from, as the first sentence of the lesson's note.
function originNote(recording, origin, assumedConfig) {
  const text = captureCopy.file;
  const seconds = recordingSummary(recording).seconds.toFixed(1);
  if (origin === 'restored') return fill(text.restored, { time: formatTime(recording.recordedAt) });
  if (origin !== 'file') return '';
  if (recording.source !== 'rosbag') return fill(text.opened, { name: recording.name, seconds });
  const topics = Object.values(recording.topics).filter(Boolean).join('・');
  const opened = fill(text.openedBag, { name: recording.name, seconds, topics });
  if (!assumedConfig) return opened;
  return (
    opened +
    fill(text.assumedConfig, {
      radius: recording.config.wheel_radius,
      separation: recording.config.wheel_separation,
    })
  );
}

/**
 * `options`:
 * - `slot`: storage key, one per block (`control-speed`, `measurement-slam`, …)
 * - `lesson`: part of the saved file's name
 * - `needs`: the streams `apply` reads, e.g. `['drive', 'twist']`
 * - `seconds`, `countStream`: passed to `recordRobot`
 * - `finishOnStop`: the stop button ends the recording and keeps it, instead of aborting
 * - `recordLabel`, `stopLabel`: optional sentences for the buttons
 * - `failed`: the lesson's "記録できませんでした：{reason}" sentence
 * - `apply(recording)`: returns `{ok, note}`; `ok: false` keeps the recording already on screen
 * - `applyOnRestore`: false when the lesson keeps its own results across a reload (the recording
 *   then only comes back so it can still be saved)
 * - `update()`: redraws the lesson
 */
function createLiveSession(options) {
  const session = {
    recording: null, // the recording the lesson's numbers were taken from
    note: '',
    busy: false,
    progress: 0,
    controllers: null,
  };

  function show(recording, origin, assumedConfig = false) {
    const result = options.apply(recording);
    const origins = originNote(recording, origin, assumedConfig);
    session.note = [origins, result.note].filter(Boolean).join(' ');
    if (!result.ok) return;
    session.recording = recording;
    if (origin === 'restored') return;
    if (!keepRecording(options.slot, recording)) session.note += ' ' + captureCopy.file.notKept;
  }

  async function startCapture() {
    if (session.busy) return;
    const controllers = { abort: new AbortController(), finish: new AbortController() };
    Object.assign(session, { busy: true, progress: 0, controllers, note: '' });
    options.update();
    try {
      const recording = await recordRobot({
        seconds: options.seconds,
        countStream: options.countStream,
        signal: controllers.abort.signal,
        finish: controllers.finish.signal,
        onProgress: throttleProgress((count) => {
          session.progress = count;
          options.update();
        }),
      });
      show(recording, 'live');
    } catch (error) {
      // A recording that failed does not discard the one already on screen: losing a good
      // measurement because the link dropped during the next attempt would be the worse outcome.
      session.note = fill(options.failed, { reason: error.message });
    }
    Object.assign(session, { busy: false, progress: 0, controllers: null });
    options.update();
  }

  function stopCapture() {
    const controllers = session.controllers;
    if (!controllers) return;
    if (options.finishOnStop) controllers.finish.abort();
    else controllers.abort.abort();
  }

  async function openRecording(file) {
    if (!file || session.busy) return;
    try {
      const { recording, assumedConfig } = await openRecordingFile(file);
      const missing = missingInRecording(recording, options.needs);
      if (missing.length)
        session.note = fill(captureCopy.file.missing, { streams: streamList(missing) });
      else show(recording, 'file', assumedConfig);
    } catch (error) {
      session.note = fill(captureCopy.file.failed, { reason: error.message });
    }
    options.update();
  }

  function saveRecording(kind) {
    if (!session.recording) return;
    const file = recordingFile(session.recording, options.lesson, kind);
    downloadFile(file.name, file.text, file.type);
  }

  // The last recording of this block, if the browser kept one and it still has what is needed.
  function restore() {
    const recording = keptRecording(options.slot);
    if (!recording || missingInRecording(recording, options.needs).length) return;
    if (options.applyOnRestore !== false) {
      show(recording, 'restored');
      return;
    }
    session.recording = recording;
  }

  function clear() {
    session.recording = null;
    session.note = '';
    keepRecording(options.slot, null);
  }

  // The view model `liveCaptureControls` expects.
  function model() {
    return {
      link: { ...liveLink(), missing: missingStreams(options.needs) },
      recording: session.busy,
      progress: session.progress,
      seconds: options.seconds,
      recordLabel: options.recordLabel,
      stopLabel: options.stopLabel,
      message: '',
      file: { canSave: Boolean(session.recording) && !session.busy },
    };
  }

  return {
    get recording() {
      return session.recording;
    },
    get note() {
      return session.note;
    },
    set note(text) {
      session.note = text;
    },
    model,
    restore,
    clear,
    actions: { startCapture, stopCapture, openRecording, saveRecording },
  };
}

export { createLiveSession };
