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
import { driveModel, onDrive, confirmDriveSafety, runDrive } from './drive-link.js';
import { driveEndedText, driveCopy } from './drive-view.js';
import { addDriveRun, driveRun, saveDriveRun } from './drive-history.js';

// The state behind one `liveCaptureControls` block: recording from the robot, opening a saved
// recording or a rosbag, saving the one on screen, and bringing it back after a reload. A lesson
// creates one session per block and supplies `apply`, which turns a recording into the lesson's
// own numbers; everything around that (progress, abort, files, storage, the sentence saying where
// the numbers came from) is the same in every course and lives here.
//
// A lesson that can also drive the robot passes `drive`; then the block offers "走らせて記録する",
// which records while drive-link.js runs the lesson's controller, keeps recording for a moment after
// the robot stops (so the stop is in the data), and says how the run ended.

const DRIVE_PROGRESS_MS = 250;
const DEFAULT_TAIL_SECONDS = 1.5;
const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const MOVING_COMMAND = 1e-3; // m/s or rad/s: a smaller command is a stop

// Whether the page actually told the robot to move during the recording (its own commands are on
// /target_twist, which the bridge mirrors back).
function commanded(recording) {
  return (recording.streams.twist ?? []).some(
    (twist) => Math.abs(twist.linear) > MOVING_COMMAND || Math.abs(twist.angular) > MOVING_COMMAND,
  );
}

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
 * - `drive` (optional): `{ plan(), program(), placement(), conditions(), startLabel }`. `plan()`
 *   returns `{controller, seconds, tail, references, outcome}` for drive-link's runDrive (tail =
 *   seconds recorded after the robot stops; references = drive-history's chart reference lines;
 *   outcome() = an optional sentence on how the run went, e.g. whether the goal was reached) or
 *   throws an Error whose message is shown. `program()` says what the robot will do, `placement()`
 *   how to place it, `conditions()` the settings in a few words for the run history.
 */
function createLiveSession(options) {
  const session = {
    recording: null, // the recording the lesson's numbers were taken from
    note: '',
    busy: false,
    progress: 0,
    controllers: null,
    driving: false,
    driveElapsed: 0,
    driveTotal: 0,
    driveAbort: null,
    tail: false, // recording the stop after the robot was told to stop
    driveNote: '', // how the last run ended, shown under the start button
    driveRunId: null, // the history entry (drive-history.js) of this block's last run
  };
  if (options.drive) onDrive(() => options.update());

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
    // While driving, "止める" stops the robot; the recording then keeps the stop and ends itself.
    if (session.driving) {
      session.driveAbort?.abort();
      return;
    }
    const controllers = session.controllers;
    if (!controllers) return;
    if (options.finishOnStop) controllers.finish.abort();
    else controllers.abort.abort();
  }

  async function startDriveCapture() {
    if (session.busy || !options.drive) return;
    let plan;
    try {
      plan = options.drive.plan();
    } catch (error) {
      session.driveNote = error.message;
      options.update();
      return;
    }
    Object.assign(session, { busy: true, driveNote: '' });
    try {
      await driveAndRecord(plan);
    } finally {
      Object.assign(session, {
        busy: false,
        driving: false,
        tail: false,
        progress: 0,
        controllers: null,
        driveAbort: null,
      });
      options.update();
    }
  }

  // Records while drive-link runs the plan, then keeps recording for `tail` seconds so the stop is
  // in the data. A run that never moved the robot (refused, or failed before it started) changes
  // nothing on the page but the sentence under the button.
  async function driveAndRecord(plan) {
    const tail = plan.tail ?? DEFAULT_TAIL_SECONDS;
    const controllers = { abort: new AbortController(), finish: new AbortController() };
    const driveAbort = new AbortController();
    Object.assign(session, {
      driving: true,
      controllers,
      driveAbort,
      driveElapsed: 0,
      driveTotal: plan.seconds,
    });
    options.update();
    const recorded = recordRobot({
      // An upper bound only: the recording is finished below, right after the tail.
      seconds: plan.seconds + tail + 5,
      countStream: options.countStream,
      signal: controllers.abort.signal,
      finish: controllers.finish.signal,
      keepOnLost: true,
    }).catch((error) => error);
    const startedAt = performance.now();
    const progress = setInterval(() => {
      session.driveElapsed = (performance.now() - startedAt) / 1000;
      options.update();
    }, DRIVE_PROGRESS_MS);
    const result = await runDrive({
      controller: plan.controller,
      seconds: plan.seconds,
      signal: driveAbort.signal,
    });
    clearInterval(progress);
    Object.assign(session, { driving: false, driveAbort: null, tail: result.started });
    options.update();
    if (result.started) {
      await sleep(tail);
      controllers.finish.abort();
    } else controllers.abort.abort();
    finishRun(result, await recorded, plan);
  }

  function finishRun(result, recording, plan) {
    const ended = driveEndedText(result);
    if (!result.started || recording instanceof Error || !commanded(recording)) {
      session.driveNote = ended;
      return;
    }
    // The next run is a new situation (the robot has moved): the learner confirms again.
    confirmDriveSafety(false);
    show(recording, 'live');
    const outcome = plan.outcome?.() ?? '';
    const cut = recording.cut ? driveCopy.ended.cut : '';
    session.driveNote = [ended, outcome, cut].filter(Boolean).join(' ');
    session.driveRunId = addDriveRun({
      slot: options.slot,
      lesson: driveCopy.lessons[options.slot] ?? options.lesson,
      conditions: options.drive.conditions?.() ?? '',
      program: options.drive.program(),
      ended: session.driveNote,
      reason: result.reason,
      robot: liveLink().robot?.name ?? '',
      references: plan.references ?? {},
      cut: Boolean(recording.cut),
      recording,
    }).id;
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
      running: session.driving,
      tail: session.tail,
      driveNote: session.driveNote,
      elapsed: session.driveElapsed,
      total: session.driveTotal,
      progress: session.progress,
      seconds: options.seconds,
      recordLabel: options.recordLabel,
      stopLabel: options.stopLabel,
      message: '',
      file: { canSave: Boolean(session.recording) && !session.busy },
      drive: options.drive ? driveBlockModel() : null,
    };
  }

  function driveBlockModel() {
    // /target_twist is what the run itself publishes, so it cannot be required before it starts.
    const missing = missingStreams(options.needs.filter((name) => name !== 'twist'));
    const drive = driveModel();
    // A stream the lesson needs but does not receive would make the run worthless.
    const blockers = missing.length
      ? [...drive.blockers, { code: 'missing_streams', nodes: null, streams: streamList(missing) }]
      : drive.blockers;
    return {
      ...drive,
      blockers,
      ready: drive.ready && missing.length === 0,
      program: options.drive.program(),
      placement: options.drive.placement?.() ?? '',
      startLabel: options.drive.startLabel,
      // Shown under the block until the next run (null after a reload: see the 実機 dialog).
      report: session.driveRunId === null ? null : driveRun(session.driveRunId),
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
    actions: {
      startCapture,
      stopCapture,
      openRecording,
      saveRecording,
      startDriveCapture,
      confirmDrive: confirmDriveSafety,
      saveRun: saveDriveRun,
    },
  };
}

export { createLiveSession };
