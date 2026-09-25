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
  groupName,
  setGroupName,
} from './capture.js';
import {
  missingInRecording,
  recordingSummary,
  withRunInfo,
  cleanConditions,
} from './recording-core.js';
import { captureCopy, revealLiveRun } from './live-view.js';
import { driveModel, onDrive, confirmDriveSafety, runDrive } from './drive-link.js';
import { driveEndedText, driveCopy } from './drive-view.js';
import { runStatusText } from './drive-report-view.js';
import { addDriveRun, driveRun, saveDriveRun, isEmptyRun } from './drive-history.js';
import { addCaptureRun, keepRunOnRobot } from './run-keeper.js';
import { chooseRobotRecord } from './record-picker.js';

// The state behind one `liveCaptureControls` block: recording from the robot, opening a saved
// recording or a rosbag, saving the one on screen, and bringing it back after a reload. A lesson
// creates one session per block and supplies `apply`, which turns a recording into the lesson's
// own numbers; everything around that (progress, abort, files, storage, the sentence saying where
// the numbers came from) is the same in every course and lives here.
//
// A lesson that can also drive the robot passes `drive`; then the block offers "走らせて記録する",
// which records while drive-link.js runs the lesson's controller, keeps recording for a moment after
// the robot stops (so the stop is in the data), and says how the run ended.
//
// Every finished run and every 「記録だけする」 recording goes into this browser's run history
// (drive-history.js, when the robot moved) and to the robot itself (robot-records.js, when the
// robot keeps records), so any device connected to the robot can find it in 記録の一覧 later. The
// block says whether the robot kept it. A recording on the robot can be opened here as well
// (「ロボットの記録から選ぶ」, record-picker.js), through the same path as a file — or, for a
// lesson that passes `compare`, drawn over the one on screen (the picker offers both).
//
// Press → see: starting a run or a recording brings the block's button and the live strip under
// it on screen (live-view revealLiveRun), the same in every course.

const DRIVE_PROGRESS_MS = 250;
const DEFAULT_TAIL_SECONDS = 1.5;
const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const streamList = (streams) =>
  streams.map((name) => captureCopy.streamNames[name] ?? name).join('と');

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
}

// What a saved recording says about itself: when, which robot and group, which settings.
function recordingFacts(recording) {
  const text = captureCopy.file;
  return [
    formatTime(recording.recordedAt),
    recording.group ?? '',
    recording.robot?.name ? fill(text.robot, { robot: recording.robot.name }) : '',
    recording.conditions?.label
      ? fill(text.conditions, { conditions: recording.conditions.label })
      : text.conditionsUnknown,
  ]
    .filter(Boolean)
    .join('・');
}

// Where a recording came from, as the first sentence of the lesson's note.
function originNote(recording, origin, assumedConfig) {
  const text = captureCopy.file;
  const seconds = recordingSummary(recording).seconds.toFixed(1);
  if (origin === 'restored') return fill(text.restored, { time: formatTime(recording.recordedAt) });
  if (origin !== 'file' && origin !== 'robot') return '';
  if (origin === 'robot' && recording.source !== 'rosbag')
    return fill(text.openedRobot, {
      name: recording.name,
      seconds,
      facts: recordingFacts(recording),
    });
  if (recording.source !== 'rosbag')
    return fill(text.opened, { name: recording.name, seconds, facts: recordingFacts(recording) });
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
 * - `reportMetrics` (optional): the numbers the run report under the block shows, as keys of
 *   drive-report-view's REPORT_METRICS (e.g. `['driveTime', 'distance', 'maxSpeed', 'stop']`);
 *   all of them when left out. `report: false` shows no run report under the block (a lesson
 *   whose own chart and table are the result); the run stays in 記録の一覧.
 * - `state` (optional): `{ place, name, placeholder, status }` — the block then offers the full
 *   「実機の状態」 panel of `place` folded under the live strip (robot-state.js robotStatePanel
 *   with `folded`; `name` / `placeholder` as there). `status()` is the lesson's line about the run
 *   in progress, shown at the top of the strip and of the panel. Without `state`, only the strip.
 * - `compare` (optional): `{ add(recording), addFiles(files), clear(), model() }` for a lesson that
 *   draws other recordings over the one on screen: `add` takes one recording (a record picked on
 *   the robot with 重ねる), `addFiles` a FileList, both resolving with whether one was drawn;
 *   `model()` returns `{count, note, help}` (how many are drawn, what happened to the last ones,
 *   the lesson's sentence on how they are drawn). The files section then offers 重ねる too.
 * - `drive` (optional): `{ plan(), program(), placement(), conditions(), startLabel, confirmLabel }`
 *   (`confirmLabel`: the safety tick's sentence when the default one about the placement does not fit,
 *   e.g. wheels lifted on a stand). `plan()`
 *   returns `{controller, seconds, tail, references, outcome}` for drive-link's runDrive (tail =
 *   seconds recorded after the robot stops; references = drive-history's chart reference lines;
 *   outcome() = an optional sentence on how the run went, e.g. whether the goal was reached) or
 *   throws an Error whose message is shown. `program()` says what the robot will do, `placement()`
 *   how to place it, `conditions()` the settings the run is made with — an object of numbers
 *   plus `label`, the few words readers show (`{ speed: 0.2, label: '0.20 m/s' }`), or just the
 *   words as a string. It is written into the recording (`conditions`) and the run history.
 *
 * Every recording made here carries `lesson` (the slot), `robot` (from the bridge's hello) and
 * `group` (班の名前); a driving run also `conditions` and `outcome` (recording-core runInfo). Only a
 * run that went as planned (reason 'done') reaches `apply`: a run stopped part-way would be judged
 * like a whole one, so it goes to the run history only, with a sentence saying so.
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
    origin: '', // where session.recording came from: 'live', 'file', 'robot' or 'restored'
    robotSave: null, // how keeping the last run on the robot went: {state, message}, or null
  };
  if (options.drive) onDrive(() => options.update());

  function show(recording, origin, assumedConfig = false) {
    const result = options.apply(recording);
    const origins = originNote(recording, origin, assumedConfig);
    session.note = [origins, result.note].filter(Boolean).join(' ');
    if (!result.ok) return;
    session.recording = recording;
    session.origin = origin;
    if (origin === 'restored') return;
    if (!keepRecording(options.slot, recording)) session.note += ' ' + captureCopy.file.notKept;
  }

  // The robot's copy of a finished recording; `runId` is its entry in the run history, if any.
  async function keepCopyOnRobot(recording, runId) {
    session.robotSave = await keepRunOnRobot(recording, runId);
    options.update();
  }

  // The run fields every recording made here carries (recording-core runInfo).
  const stamp = (recording, info = {}) =>
    withRunInfo(recording, {
      lesson: options.slot,
      robot: liveLink().robot,
      group: groupName(),
      ...info,
    });

  async function startCapture() {
    if (session.busy) return;
    const controllers = { abort: new AbortController(), finish: new AbortController() };
    Object.assign(session, { busy: true, progress: 0, controllers, note: '', robotSave: null });
    options.update();
    revealLiveRun(options.slot);
    try {
      const raw = await recordRobot({
        seconds: options.seconds,
        countStream: options.countStream,
        signal: controllers.abort.signal,
        finish: controllers.finish.signal,
        onProgress: throttleProgress((count) => {
          session.progress = count;
          options.update();
        }),
      });
      const recording = stamp(raw);
      show(recording, 'live');
      keepCopyOnRobot(recording, addCaptureRun(recording, options.slot));
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
      // Taken now: the settings the robot is driven with, whatever the page shows afterwards.
      plan = { ...plan, conditions: cleanConditions(options.drive.conditions?.()) };
    } catch (error) {
      session.driveNote = error.message;
      options.update();
      return;
    }
    Object.assign(session, { busy: true, driveNote: '', robotSave: null });
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
    revealLiveRun(options.slot);
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

  function finishRun(result, raw, plan) {
    const ended = driveEndedText(result);
    if (!result.started || raw instanceof Error || isEmptyRun(raw)) {
      session.driveNote = ended;
      return;
    }
    // The next run is a new situation (the robot has moved): the learner confirms again.
    confirmDriveSafety(false);
    const status = runStatusText(result.reason);
    const recording = stamp(raw, {
      conditions: plan.conditions,
      outcome: { reason: result.reason, label: status },
    });
    const done = result.reason === 'done';
    if (done) show(recording, 'live');
    const outcome = plan.outcome?.() ?? '';
    const cut = recording.cut ? driveCopy.ended.cut : '';
    const notShown = done ? '' : fill(driveCopy.notShown, { status });
    session.driveNote = [ended, outcome, cut, notShown].filter(Boolean).join(' ');
    session.driveRunId = addDriveRun({
      slot: options.slot,
      lesson: driveCopy.lessons[options.slot] ?? options.lesson,
      conditions: plan.conditions?.label ?? '',
      program: options.drive.program(),
      ended: [ended, outcome, cut].filter(Boolean).join(' '),
      reason: result.reason,
      robot: recording.robot?.name ?? '',
      group: recording.group ?? '',
      references: plan.references ?? {},
      cut: Boolean(recording.cut),
      recording,
    }).id;
    keepCopyOnRobot(recording, session.driveRunId);
  }

  // A file and a recording from the robot take the same way into the lesson.
  function openParsed(recording, origin, assumedConfig = false) {
    const missing = missingInRecording(recording, options.needs);
    if (missing.length)
      session.note = fill(captureCopy.file.missing, { streams: streamList(missing) });
    else show(recording, origin, assumedConfig);
  }

  async function openRecording(file) {
    if (!file || session.busy) return;
    try {
      const { recording, assumedConfig } = await openRecordingFile(file);
      openParsed(recording, 'file', assumedConfig);
    } catch (error) {
      session.note = fill(captureCopy.file.failed, { reason: error.message });
    }
    options.update();
  }

  /**
   * Show a recording that did not come from a file: one kept on the robot (the picker, or a link
   * from 記録の一覧). `recording.name` is what the note calls it. Returns whether the lesson took
   * it (false: it lacks a stream the lesson needs, or the lesson refused it; the note says why).
   */
  function useRecording(recording, origin = 'robot') {
    if (session.busy) return false;
    openParsed(recording, origin);
    options.update();
    return session.recording === recording;
  }

  // 「ロボットの記録から選ぶ」: the shared picker, filtered to this block's lesson; with `compare`,
  // each record offers 開く and 重ねる.
  async function pickFromRobot() {
    if (session.busy) return;
    const chosen = await chooseRobotRecord({
      lesson: options.slot,
      needs: options.needs,
      both: Boolean(options.compare),
    });
    if (!chosen) return;
    if (chosen.compare) await options.compare.add(chosen.recording);
    else useRecording(chosen.recording, 'robot');
  }

  // A recording made on this device takes the group typed after it was made; a file opened from
  // another group keeps its own.
  function saveRecording(kind) {
    if (!session.recording) return;
    const own = !['file', 'robot'].includes(session.origin) && !session.recording.group;
    const recording = own
      ? withRunInfo(session.recording, { group: groupName() })
      : session.recording;
    const file = recordingFile(recording, options.lesson, kind);
    downloadFile(file.name, file.text, file.type);
  }

  function setGroup(text) {
    setGroupName(text);
    options.update();
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
    session.origin = 'restored';
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
      robotSave: session.robotSave,
      file: { canSave: Boolean(session.recording) && !session.busy, group: groupName() },
      drive: options.drive ? driveBlockModel() : null,
      slot: options.slot,
      state: options.state
        ? { ...options.state, place: options.state.place ?? options.slot }
        : null,
      compare: options.compare ? options.compare.model() : null,
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
      confirmLabel: options.drive.confirmLabel ?? null,
      startLabel: options.drive.startLabel,
      metrics: options.reportMetrics ?? null,
      // Shown under the block until the next run (null after a reload: see 記録の一覧).
      report:
        session.driveRunId === null || options.report === false
          ? null
          : driveRun(session.driveRunId),
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
    useRecording,
    actions: {
      startCapture,
      stopCapture,
      openRecording,
      pickRobotRecord: pickFromRobot,
      saveRecording,
      setGroup,
      startDriveCapture,
      confirmDrive: confirmDriveSafety,
      saveRun: saveDriveRun,
      ...(options.compare
        ? {
            addComparisons: (files) => options.compare.addFiles(files),
            clearComparisons: () => options.compare.clear(),
          }
        : {}),
    },
  };
}

export { createLiveSession };
