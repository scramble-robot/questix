import { html, render, ref } from '../vendor/lit-html.js';
import { fillSentence as fill } from '../core/content.js';
import { revealElement } from '../core/reveal.js';
import {
  shootModel,
  onShoot,
  onShotFired,
  onShootSession,
  confirmShootSafety,
  setRollerPercent,
  setTilt,
  startRoller,
  stopOwn,
  stopLauncher,
  fireOne,
} from './shoot-link.js';
import { shootCopy, shootBlock, shootStopBar } from './shoot-view.js';
import { recordRobot, liveLink, groupName } from './capture.js';
import { withRunInfo, serializeRecording } from './recording-core.js';
import { robotRecordsInfo } from './robot-records.js';
import { saveRecordOnRobot } from './robot-link.js';

// The launcher block a lesson puts where learners fire discs (`launcherPanel(place, options)` in
// its view), and the stop bar every page shows while a roller turns on a page's command.
// - The block draws itself into its element (at most every REDRAW_MS while it is on screen), so
//   the lesson's page is not redrawn ten times a second for a countdown.
// - Each of this page's shots is handed to the lesson (`options.onShot`), which adds the row the
//   learner completes with the measured distance.
// - Each session of this page is recorded (the launcher's roller and shot statuses, plus the
//   wheels and the command, which show that the robot stood still) and kept on the robot as a
//   record of `options.lesson`.
// Only shoot-link.js sends anything to the robot.

const REDRAW_MS = 100;
// Recorded after the session ends, so the record shows the roller running down.
const RECORD_TAIL_MS = 1000;
const RECORD_STREAMS = ['roller', 'shot', 'drive', 'twist'];
const RECORD_SPARE_SECONDS = 5; // the recording's own time limit is only a backstop
// How a session ends when all went as meant: after its shot, the learner's stop, a tilt alone.
const QUIET_ENDS = ['stopped', 'fired', 'idle'];

const panels = new Map(); // place -> { element, options, view }
let timer = 0;
let leftSince = null; // performance.now() since when no launcher block has been on screen
const LEFT_GRACE_MS = 1000; // a redraw or a topic being rebuilt is not leaving
let recording = null; // { finish: AbortController, done: Promise, lesson, start: {percent, tilt} }

const visible = (element) =>
  element.isConnected &&
  (typeof element.checkVisibility === 'function'
    ? element.checkVisibility()
    : element.offsetParent !== null);

function actionsOf(entry) {
  return {
    confirm: confirmShootSafety,
    setPercent: setRollerPercent,
    previewTilt(deg) {
      entry.view.tiltPreview = deg;
      draw(entry, shootModel());
    },
    setTilt(deg) {
      entry.view.tiltPreview = null;
      setTilt(deg);
    },
    // Press → see: the fire button and the spin-up bar go to the top of the screen, clear of the
    // stop bar that comes up at the bottom.
    startRoller() {
      startRoller();
      revealElement(entry.element?.querySelector('[data-shoot-run]'));
    },
    stopOwn,
    fire: fireOne,
  };
}

function draw(entry, model) {
  if (!entry.element?.isConnected) return;
  render(shootBlock(model, entry.view, entry.actions), entry.element);
}

// --- the stop bar --------------------------------------------------------------------------------

// Like the drive bar (drive-ui.js): moved into an open modal dialog, which sits above any z-index.
function placeBar(host) {
  const dialogs = [...document.querySelectorAll('dialog[open]')];
  const parent = dialogs.at(-1) ?? document.body;
  if (host.parentElement !== parent) parent.append(host);
}

function drawBar(model) {
  const host = document.getElementById('shootBar');
  if (!host) return;
  placeBar(host);
  render(shootStopBar(model, stopLauncher), host);
  const turning = model.spinning || (model.active && model.power > 0);
  document.body.classList.toggle('shooting', turning);
}

// --- redrawing -----------------------------------------------------------------------------------

function redraw() {
  const model = shootModel();
  drawBar(model);
  for (const entry of panels.values())
    if (entry.element && visible(entry.element)) draw(entry, model);
}

// This page's session needs its block on screen (the fire button, the countdown): a learner who
// opens another topic or course while the roller turns has left it, and the roller stops.
function stopIfLeft(model, shown) {
  if (!model.session || shown) {
    leftSince = null;
    return;
  }
  leftSince ??= performance.now();
  if (performance.now() - leftSince > LEFT_GRACE_MS) {
    leftSince = null;
    stopOwn('left');
  }
}

function tick() {
  if (document.hidden) return;
  const attached = [...panels.values()].some((entry) => entry.element?.isConnected);
  const model = shootModel();
  drawBar(model);
  const shown = [...panels.values()].filter((entry) => entry.element && visible(entry.element));
  stopIfLeft(model, shown.length > 0);
  if (!attached && !model.spinning && !model.active) {
    clearInterval(timer);
    timer = 0;
    return;
  }
  for (const entry of shown) draw(entry, model);
}

function startTimer() {
  if (!timer) timer = setInterval(tick, REDRAW_MS);
}

// --- recording each session ----------------------------------------------------------------------

function lessonOfPanels() {
  for (const entry of panels.values()) if (entry.options.lesson) return entry.options.lesson;
  return null;
}

function startRecording() {
  const lesson = lessonOfPanels();
  if (!lesson || recording) return;
  const model = shootModel();
  const finish = new AbortController();
  const done = recordRobot({
    seconds: model.limits.seconds + RECORD_SPARE_SECONDS,
    finish: finish.signal,
    keepOnLost: true,
    countStream: 'roller',
    streams: RECORD_STREAMS,
  }).catch((error) => error);
  recording = { finish, done, lesson, start: { percent: model.percent, tilt: model.tilt } };
}

function setRecordNote(text) {
  for (const entry of panels.values()) entry.view.recordNote = text;
  redraw();
}

async function endRecording({ reason, shots }) {
  const current = recording;
  if (!current) return;
  recording = null;
  await new Promise((resolve) => setTimeout(resolve, RECORD_TAIL_MS));
  current.finish.abort();
  const raw = await current.done;
  if (raw instanceof Error || !robotRecordsInfo().save) return;
  // A spin the learner stopped without firing (or a tilt alone) is not worth a record; a session
  // the robot ended (E-stop, controller, dead-man) is, even without a shot.
  if (shots === 0 && QUIET_ENDS.includes(reason)) return;
  const values = { ...current.start, shots };
  const record = withRunInfo(raw, {
    lesson: current.lesson,
    conditions: {
      power: values.percent / 100,
      tilt: values.tilt,
      shots,
      label: fill(shootCopy.record.label, values),
    },
    robot: liveLink().robot,
    group: groupName(),
    // A session that ended as meant (after its shot, or the learner's stop) has no outcome of its
    // own: the record list then calls it 「記録だけ」 instead of borrowing a driving run's words.
    outcome: QUIET_ENDS.includes(reason) ? null : { reason },
  });
  try {
    await saveRecordOnRobot(serializeRecording(record));
    setRecordNote(shootCopy.record.saved);
  } catch (error) {
    setRecordNote(fill(shootCopy.record.failed, { reason: error.message }));
  }
}

// --- one panel per place ---------------------------------------------------------------------------

function entryOf(place) {
  if (panels.has(place)) return panels.get(place);
  const entry = {
    place,
    element: null,
    options: {},
    view: { tiltPreview: null, recordNote: '', rowAdded: null },
  };
  entry.actions = actionsOf(entry);
  // A stable callback: lit calls a changed ref callback again.
  entry.mount = (element) => {
    entry.element = element ?? null;
    if (!element) return;
    draw(entry, shootModel());
    startTimer();
  };
  panels.set(place, entry);
  return entry;
}

/**
 * The launcher block for `place` as a lit template for the lesson's own view. `options`:
 * - `onShot({percent, tilt, at})`: one of this page's discs was fired; returns whether the lesson
 *   kept a row for it (false: its table is full);
 * - `lesson`: the lesson key the session recordings are kept under on the robot.
 */
function launcherPanel(place, options = {}) {
  const entry = entryOf(place);
  entry.options = options;
  if (entry.element?.isConnected) startTimer();
  return html`<div class="shoot-host" data-shoot-place=${place} ${ref(entry.mount)}></div>`;
}

function initShootUi() {
  onShoot(() => {
    startTimer();
    redraw();
  });
  onShotFired((shot) => {
    for (const entry of panels.values()) {
      entry.view.recordNote = '';
      if (entry.options.onShot) entry.view.rowAdded = entry.options.onShot(shot) !== false;
    }
    redraw();
  });
  onShootSession((event) => {
    if (event.type === 'start') {
      for (const entry of panels.values()) entry.view.recordNote = '';
      startRecording();
    } else endRecording(event);
  });
  new MutationObserver(() => {
    const host = document.getElementById('shootBar');
    if (host) placeBar(host);
  }).observe(document.body, { subtree: true, attributeFilter: ['open'] });
  redraw();
}

initShootUi();

export { launcherPanel };
