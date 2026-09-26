import { mountUsb, stopUsb } from './usb-ui.js';
import { render } from '../vendor/lit-html.js';
import { loadJson, loadText } from '../core/content.js';
import { downloadFile } from '../core/dom.js';
import { lessonGuide, figureGuide } from '../shell/lesson-guide.js';
import { generateSlamLog, estimateSlam, slamMetrics, validateSlamLog } from './engine.js';
import { slamLogFromFile, slamLogFromRecording } from '../live/slam-recorder.js';
import { recordRobot, recordingFile, liveLink, onLiveLink, groupName } from '../live/capture.js';
import { missingInRecording, withRunInfo } from '../live/recording-core.js';
import { openRobotDialog } from '../live/live-ui.js';
import { keepCapture } from '../live/run-keeper.js';
import { pickRobotRecord } from '../live/record-picker.js';
import { registerRecordTarget, revealAfterRender } from '../live/record-targets.js';
import { basicsTemplate, initSlamBasics, reviewSlamBasics } from './basics.js';
import { SLAM_CHAPTERS } from './concepts.js';
import { reportLessonProgress } from '../shell/lesson-progress.js';
import { drawMaps, drawSensorChart, drawTilt, tiltAcceleration } from './render.js';
import { slamPage } from './view.js';
import { fillSentence as fill } from '../core/content.js';

// SLAM course, main experiment: state and behaviour. view.js turns the model into markup,
// render.js draws the canvases, engine.js simulates and estimates, basics.js owns the
// "仕組みを知る" part. Learner-facing sentences live in content/slam/ui.json.

const copy = await loadJson('content/slam/ui.json');
const methodNoteHtml = await loadText('content/slam/method-note.html');
const basicsHtml = basicsTemplate();

const RECORD_SECONDS = 15;
const RECORDING_LESSON = 'slam'; // lesson id and file-name part of a saved robot recording
const MAX_LOG_BYTES = 12_000_000;
// The estimate blocks the main thread, so the "computing" label gets one turn to paint first.
const COMPUTE_DELAY_MS = 20;
const GOAL_ERROR = 0.15; // metres; the lesson's target for the error after one loop
const MAX_STEP_SECONDS = 0.1; // playback never jumps more than this per animation frame
const DEFAULT_CASE = 'slip';
const DEFAULT_SPEED = 2; // × real time, matching the selected option
const NARROW_LAYOUT = '(max-width: 900px)';
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const WATCHED_CANVASES = ['slamTruth', 'slamMap', 'slamSensorCanvas', 'slamTiltCanvas'];
// Where each step of the experiment puts the learner.
const STAGE_TARGETS = {
  setup: '.slam-guide',
  learn: '.slam-scene',
  test: '#slamComparison',
  improve: '#slamReflection',
};
const NEXT_METHOD = { wheel: 'imu', imu: 'slam', slam: null };

let log = null; // the sensor log being studied: generated or read from a real robot
let runs = []; // every estimate computed from this log, oldest first
let active = null; // the estimate shown on the map
let cursor = 0; // frame currently shown
// The seek range is set when an estimate exists and, as in the original, is left alone
// afterwards; it is only reachable while a run is loaded.
let seekMax = 1;
let view = 'basics'; // basics | experiment
let real = false; // the experiment runs on a recorded robot log rather than the simulator
let stage = 'setup'; // setup | learn | test | improve
let busy = false;
let runError = null; // message of a failed estimate, shown until the next update
let basicsChapter = SLAM_CHAPTERS[0].id; // the ① 仕組み chapter basics.js has open
let importStatus = copy.hardware.importIdle;
let recording = null; // AbortController while recording from the robot
// The robot recording (questix-lab-recording, capture.js) the last live log was built from, so the
// learner can save it and open it again here or in another course; null until one is recorded.
let robotRecording = null;
let caseId = DEFAULT_CASE;
let method = 'wheel';
let calibrate = false;
let hardware = { html: '', guide: '', python: '' }; // texts and files of the real-robot panel

const playback = { playing: false, elapsed: 0, lastFrame: 0, speed: DEFAULT_SPEED };
const sensors = { open: false, sensor: 'lidar', cameraMode: 'rgb' };
const tilt = { pitchDegrees: 0, rollDegrees: 0, drawn: false };

const page = () => document.getElementById('slamPage');
const canvas = (id) => document.getElementById(id);
const lastFrameIndex = () => log.frames.length - 1;
const isHardwareLog = () => log.source === 'hardware';

// --- Model --------------------------------------------------------------------------------------

// The brief above the experiment names the situation and what to compare; it depends only on
// which experiment is open, so recomputing it per update leaves the markup untouched.
function experimentBrief() {
  const key = real ? 'slam-real' : 'slam-compare';
  if (real) return lessonGuide(key) + figureGuide(key);
  const goal = caseId === 'corridor' ? copy.goals.corridor : copy.goals.default;
  return lessonGuide(key, goal) + figureGuide(key);
}

function reflectionKind() {
  if (isHardwareLog()) return 'hardware';
  if (caseId === 'corridor') return 'corridor';
  if (caseId === 'bias' && active.method === 'imu' && !active.calibrate) return 'biasUncalibrated';
  return active.method;
}

function reflectionNext(kind) {
  if (kind === 'corridor') return active.method === 'slam' ? null : 'slam';
  if (kind === 'biasUncalibrated') return 'calibrate';
  return NEXT_METHOD[active.method];
}

// The closing panel only makes sense once the whole run has been watched.
function buildReflection(finished) {
  if (!finished || stage !== 'improve') return null;
  const kind = reflectionKind();
  return {
    kind,
    reachedGoal: active.metrics.endError <= GOAL_ERROR,
    next: reflectionNext(kind),
    caseId,
    note: active.note || '',
  };
}

function buildSettings() {
  const effectiveCalibrate = method !== 'wheel' && calibrate;
  return {
    method,
    caseId,
    calibrate,
    // A finished estimate stays on screen while other conditions are being prepared.
    comparesToOtherRun:
      Boolean(active) && (active.method !== method || active.calibrate !== effectiveCalibrate),
  };
}

function buildModel() {
  const ready = Boolean(active);
  const finished = ready && cursor >= lastFrameIndex();
  return {
    view,
    real,
    stage,
    busy,
    ready,
    finished,
    hardware: isHardwareLog(),
    // QUESTiX has no IMU: a log recorded on it carries gyroZ = 0 throughout.
    noGyro: isHardwareLog() && log.frames.every((frame) => frame.gyroZ === 0),
    hardwareVisible: view === 'experiment' && real,
    experimentVisible: view === 'experiment' && (!real || isHardwareLog()),
    hardwareGuideHtml: hardware.html,
    briefHtml: experimentBrief(),
    importStatus,
    recording: Boolean(recording),
    recordButton: fill(copy.hardware.recordButton, { seconds: RECORD_SECONDS }),
    connected: liveLink().connected,
    canSaveRecording: Boolean(robotRecording) && !recording,
    log,
    runs,
    active,
    reference: log.reference,
    cursor,
    seekMax,
    frame: log.frames[cursor],
    endTime: log.frames.at(-1).t,
    frameTimes: log.frames.map((entry) => entry.t),
    playing: playback.playing,
    speed: playback.speed,
    runError,
    sensors: {
      ...sensors,
      tilt: { ...tilt, acceleration: tiltAcceleration(tilt.pitchDegrees, tilt.rollDegrees) },
    },
    settings: buildSettings(),
    reflection: buildReflection(finished),
  };
}

// --- Drawing ------------------------------------------------------------------------------------

function paintMaps() {
  drawMaps(canvas('slamTruth'), canvas('slamMap'), {
    log,
    run: active,
    cursor,
    labels: {
      start: copy.scene.startMarker,
      unknownTruth: copy.scene.unknownTruth,
      unknownTruthNote: copy.scene.unknownTruthNote,
      gap: copy.scene.gapLabel,
    },
  });
}

function paintSensor() {
  if (!sensors.open) return;
  drawSensorChart(canvas('slamSensorCanvas'), {
    log,
    cursor,
    sensor: sensors.sensor,
    cameraMode: sensors.cameraMode,
  });
}

// The tilt demo is a side experiment: it is redrawn when it is opened, when a slider moves and
// when its canvas is resized, not on every update.
function paintTilt() {
  drawTilt(canvas('slamTiltCanvas'), tilt);
}

// basics.js owns the "仕組みを知る" markup and wires it by id, so it is inserted once and never
// re-rendered; its visibility is the one flag this module sets on the DOM directly.
function showBasicsSection() {
  const section = document.getElementById('slamBasics');
  if (section) section.hidden = view !== 'basics';
}

// The shared experiment footer counts each ① 仕組み chapter, the ② 総合実験 and the ③ 実機 page as
// one experiment each, in the order of the mode tabs. The four steps inside the 総合実験 and its
// conditions (next method, next case) stay the page's own controls.
const FOOTER_TOPICS = [
  ...SLAM_CHAPTERS.map((chapter) => ({ id: chapter.id, title: chapter.title })),
  { id: 'compare', title: copy.lessonTopics.compare },
  { id: 'real', title: copy.lessonTopics.real },
  { id: 'usb', title: 'USB LiDARでSLAM' },
];

function footerTopic() {
  if (view === 'basics') return basicsChapter;
  if (view === 'usb') return 'usb';
  return real ? 'real' : 'compare';
}

function openFooterTopic(id) {
  if (id === 'compare') actions.setReal(false);
  else if (id === 'real') actions.setReal(true);
  else if (id === 'usb') actions.showUsb();
  else {
    // Set first, so switching to ① does not report the previously open chapter on the way.
    basicsChapter = id;
    reviewSlam(id);
  }
}

function reportProgress() {
  reportLessonProgress('slam', {
    topics: FOOTER_TOPICS,
    current: footerTopic(),
    open: openFooterTopic,
  });
}

function update() {
  render(slamPage(buildModel(), copy, { basicsHtml, methodNoteHtml }, actions), page());
  reportProgress();
  showBasicsSection();
  paintMaps();
  paintSensor();
}

// Keeps the canvases sharp when the layout, the window or the screen density changes.
function watchCanvasSize() {
  let pending = false;
  const redraw = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (!log || page().hidden) return;
      paintMaps();
      paintSensor();
      const demo = document.getElementById('slamTiltDemo');
      if (demo.open && !demo.hidden) paintTilt();
    });
  };
  const observer = new ResizeObserver(redraw);
  for (const id of WATCHED_CANVASES) observer.observe(canvas(id));
  const watchDensity = () => {
    const query = matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
    query.addEventListener(
      'change',
      () => {
        redraw();
        watchDensity();
      },
      { once: true },
    );
  };
  watchDensity();
  window.addEventListener('resize', redraw);
}

// --- Log and playback ---------------------------------------------------------------------------

// A new log invalidates every estimate made from the previous one.
function resetLog(data) {
  stage = 'setup';
  log = data;
  runs = [];
  active = null;
  cursor = 0;
  playback.playing = false;
  playback.elapsed = 0;
  method = 'wheel';
  calibrate = false;
}

function scrollToStage(next) {
  page().querySelector(STAGE_TARGETS[next])?.scrollIntoView({ block: 'start' });
}

function goStage(next) {
  if (busy || (!active && next !== 'setup')) return;
  playback.playing = false;
  stage = next;
  if (next === 'test' || next === 'improve') cursor = lastFrameIndex();
  update();
  scrollToStage(next);
}

function tick(now) {
  const seconds = Math.min(MAX_STEP_SECONDS, (now - playback.lastFrame) / 1000 || 0);
  playback.lastFrame = now;
  if (playback.playing && !page().hidden && active) {
    playback.elapsed += seconds * playback.speed;
    let next = cursor;
    while (next < lastFrameIndex() && log.frames[next].t < playback.elapsed) next++;
    if (next !== cursor) {
      cursor = next;
      if (cursor === lastFrameIndex()) {
        playback.playing = false;
        stage = 'test';
      }
      update();
    }
  }
  requestAnimationFrame(tick);
}

async function runEstimate() {
  if (busy) return;
  busy = true;
  stage = 'learn';
  playback.playing = false;
  update();
  await new Promise((resolve) => setTimeout(resolve, COMPUTE_DELAY_MS));
  let failure = null;
  try {
    const result = estimateSlam(log.frames, log.config, {
      method,
      calibrate: method !== 'wheel' && calibrate,
      stationarySeconds: log.stationarySeconds,
    });
    result.metrics = slamMetrics(result, log);
    result.id = runs.length;
    active = result;
    runs.push(result);
    cursor = 0;
    playback.elapsed = 0;
    playback.playing = !matchMedia(REDUCED_MOTION).matches;
    if (!playback.playing) {
      cursor = lastFrameIndex();
      stage = 'test';
    }
    seekMax = lastFrameIndex();
  } catch (error) {
    stage = 'setup';
    failure = error.message;
  }
  busy = false;
  // The failure replaces the caption until something else happens, as before.
  runError = failure;
  update();
  runError = null;
  if (!failure && matchMedia(NARROW_LAYOUT).matches) scrollToStage('learn');
}

// --- Real-robot logs ----------------------------------------------------------------------------

// A file and a live recording enter through the same validation.
function acceptLog(input, name, note = '') {
  const parsed = validateSlamLog(input);
  resetLog(parsed);
  importStatus = fill(copy.hardware.imported, {
    name,
    frames: parsed.frames.length,
    note,
  });
  update();
}

async function openLogFile(event) {
  const input = event.target;
  const file = input.files[0];
  if (!file) return;
  try {
    const converted = await slamLogFromFile(file);
    if (converted) {
      const assumed = converted.assumedConfig ? copy.hardware.assumedConfig : '';
      acceptLog(converted.log, file.name, copy.hardware.recordedNote + assumed);
    } else {
      if (file.size > MAX_LOG_BYTES) throw Error(copy.hardware.fileTooLarge);
      acceptLog(parseLogJson(await file.text()), file.name);
    }
  } catch (error) {
    importStatus = fill(copy.hardware.importFailed, { message: error.message });
    update();
  }
  input.value = '';
}

// A file that is not JSON at all (a recording's CSV, a picture…) gets a sentence, not the parser's
// English "Unexpected token".
function parseLogJson(text) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw Error(copy.hardware.notJson);
  }
}

// The live recording is a questix-lab-recording like every other course's, turned into the SLAM
// log exactly as a saved one is when it is opened again (slamLogFromFile): scans paired with the
// wheel feedback of the same moment by their stamps.
function slamLogOfRecording(recorded) {
  if (missingInRecording(recorded, ['scan', 'drive']).length)
    throw Error(copy.hardware.recordMissing);
  return slamLogFromRecording(recorded);
}

// Without a robot on the other end this reports why nothing was recorded.
async function toggleRecording() {
  if (recording) {
    recording.abort();
    return;
  }
  recording = new AbortController();
  update();
  try {
    const recorded = await recordRobot({
      seconds: RECORD_SECONDS,
      countStream: 'scan',
      signal: recording.signal,
      onProgress: (count) => {
        importStatus = fill(copy.hardware.recording, { count });
        update();
      },
    });
    const converted = slamLogOfRecording(recorded);
    const motion = converted.moved ? '' : copy.hardware.recordedWithoutMotion;
    acceptLog(
      converted.log,
      copy.hardware.recordedName,
      copy.hardware.recordedNote + motion + copy.hardware.saveHint,
    );
    // The shared recording fields (lesson, robot, group) say where the file came from once it is
    // saved; like every lesson's recording, it is also kept on the robot and in the run history.
    robotRecording = withRunInfo(recorded, {
      lesson: RECORDING_LESSON,
      robot: liveLink().robot,
      group: groupName(),
    });
    keepCapture(robotRecording, RECORDING_LESSON).then((saved) => {
      if (!saved) return;
      importStatus = `${importStatus} ${saved.message}`;
      update();
    });
  } catch (error) {
    importStatus = fill(copy.hardware.recordFailed, { message: error.message });
  } finally {
    recording = null;
    update();
  }
}

// A recording kept on the robot (the picker, or 記録の一覧) enters as a saved one opened from a file.
function openRobotRecording(recording) {
  try {
    const converted = slamLogFromRecording(recording);
    acceptLog(converted.log, recording.name, copy.hardware.recordedNote);
    robotRecording = recording;
    return true;
  } catch (error) {
    importStatus = fill(copy.hardware.importFailed, { message: error.message });
    update();
    return false;
  }
}

async function pickRecording() {
  const recording = await pickRobotRecord({ lesson: RECORDING_LESSON, needs: ['scan', 'drive'] });
  if (recording) openRobotRecording(recording);
}

function estimatesCsv() {
  const rows = ['experiment,method,gyro_calibrated,time_s,x_m,y_m,yaw_rad,position_error_m'];
  runs.forEach((run, index) => {
    run.states.forEach((state, i) => {
      const truth = log.reference?.[i];
      const error = truth ? Math.hypot(state.x - truth.x, state.y - truth.y) : '';
      const pose = [state.t, state.x, state.y, state.theta];
      rows.push([index + 1, run.method, run.calibrate, ...pose, error].join(','));
    });
  });
  return rows.join('\n');
}

// --- Actions ------------------------------------------------------------------------------------

const actions = {
  mountUsb,
  showUsb() {
    playback.playing = false;
    view = 'usb';
    update();
  },
  showBasics() {
    stopUsb();
    view = 'basics';
    playback.playing = false;
    update();
  },
  setReal(value) {
    stopUsb();
    const wasReal = real;
    real = value;
    view = 'experiment';
    playback.playing = false;
    // Leaving the real-robot tab returns to the generated log of the selected condition.
    if (!real && wasReal) resetLog(generateSlamLog(caseId));
    update();
  },
  goStage,
  run: runEstimate,
  setCase(value) {
    caseId = value;
    resetLog(generateSlamLog(caseId));
    update();
  },
  setMethod(value) {
    method = value;
    stage = 'setup';
    update();
  },
  setCalibrate(checked) {
    calibrate = checked;
    stage = 'setup';
    update();
  },
  togglePlay() {
    if (!active) return;
    if (cursor >= lastFrameIndex()) {
      cursor = 0;
      playback.elapsed = 0;
    }
    stage = 'learn';
    playback.playing = !playback.playing;
    update();
  },
  restart() {
    if (!active) return;
    cursor = 0;
    playback.elapsed = 0;
    playback.playing = true;
    stage = 'learn';
    update();
  },
  showEnd() {
    playback.playing = false;
    cursor = lastFrameIndex();
    stage = 'test';
    update();
  },
  seek(index) {
    playback.playing = false;
    cursor = index;
    playback.elapsed = log.frames[cursor].t;
    stage = cursor === lastFrameIndex() ? 'test' : 'learn';
    update();
  },
  setSpeed(speed) {
    playback.speed = speed;
    update();
  },
  selectRun(index) {
    active = runs[index];
    cursor = lastFrameIndex();
    playback.playing = false;
    stage = 'test';
    update();
  },
  toggleSensors() {
    sensors.open = !sensors.open;
    update();
  },
  selectSensor(sensor) {
    sensors.sensor = sensor;
    update();
  },
  setCameraMode(mode) {
    sensors.cameraMode = mode;
    update();
  },
  toggleTilt() {
    tilt.drawn = true;
    update();
    paintTilt();
  },
  setTilt(key, degrees) {
    tilt[key] = degrees;
    tilt.drawn = true;
    update();
    paintTilt();
  },
  // The learner keeps their own note with the estimate it belongs to; the textarea already
  // shows what they typed, so nothing has to be re-rendered.
  setNote(text) {
    if (active) active.note = text;
  },
  takeNextStep() {
    const next = buildReflection(true)?.next;
    if (next === 'calibrate') calibrate = true;
    else method = next;
    stage = 'setup';
    update();
    document.getElementById('slamRun').focus();
  },
  // The last case hands over to the footer's 次の実験 (③ 実機), so it has no case button.
  nextCase() {
    if (isHardwareLog() || caseId === 'corridor') return;
    caseId = caseId === 'slip' ? 'bias' : 'corridor';
    resetLog(generateSlamLog(caseId));
    update();
  },
  openLogFile,
  pickRecording,
  toggleRecording,
  openLink: openRobotDialog,
  saveRecording() {
    if (!robotRecording) return;
    const file = recordingFile(robotRecording, RECORDING_LESSON, 'json');
    downloadFile(file.name, file.text, file.type);
  },
  saveRecorderScript() {
    downloadFile('robo_lab_record.py', hardware.python, 'text/x-python');
  },
  saveProcedure() {
    downloadFile('QUESTiX-LAB-ROS2-実験手順.md', hardware.guide, 'text/markdown');
  },
  saveSampleLog() {
    const sample = JSON.stringify(generateSlamLog(DEFAULT_CASE), null, 2);
    downloadFile('robo-lab-sample.json', sample, 'application/json');
  },
  exportResults() {
    if (!runs.length) return;
    downloadFile('robo-lab-estimates.csv', estimatesCsv(), 'text/csv');
  },
};

// --- Entry points -------------------------------------------------------------------------------

function pauseSlam() {
  stopUsb();
  playback.playing = false;
}

function initSlam(hardwareContent) {
  hardware = hardwareContent;
  resetLog(generateSlamLog());
  update();
  // basics.js wires its own markup, which update() has just inserted.
  initSlamBasics((id) => {
    basicsChapter = id;
    reportProgress();
  });
  document.addEventListener('series-leave', pauseSlam);
  document.addEventListener('supplement-open', pauseSlam);
  // Connecting or losing the robot changes what the real-robot panel offers.
  onLiveLink(() => {
    if (real) update();
  });
  // 「自己位置推定で開く」 from 記録の一覧: the real-robot tab, with the recording as its log.
  registerRecordTarget('slam', (recording) => {
    actions.setReal(true);
    const taken = openRobotRecording(recording);
    revealAfterRender(() => document.getElementById('slamHardware'));
    return taken;
  });
  watchCanvasSize();
  requestAnimationFrame(tick);
}

function reviewSlam(id) {
  pauseSlam();
  actions.showBasics();
  return reviewSlamBasics(id);
}

export { initSlam, pauseSlam, reviewSlam };
