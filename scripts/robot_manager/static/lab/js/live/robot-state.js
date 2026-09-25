import { html, render, nothing, ref } from '../vendor/lit-html.js';
import { loadJson, fillSentence as fill } from '../core/content.js';
import { downloadFile } from '../core/dom.js';
import { onRobot, robotState, latestRobot } from './robot-link.js';
import { liveLink } from './capture.js';
import { openRobotDialog } from './live-ui.js';
import {
  createStateTracker,
  ingest,
  resetPose,
  robotStateModel,
  snapshotLine,
  stripModel,
} from './robot-state-core.js';
import { robotStateView, memoView, stripView } from './robot-state-view.js';

// The 「実機の状態」 panel a lesson puts where learners measure on the real robot, and the 測定メモ
// under it. A lesson only writes `${robotStatePanel('motor-real')}` into its template; the panel
// draws itself into that element, so the lesson page is not redrawn ten times a second:
// - every message of the robot's streams goes into one tracker (robot-state-core.js) as it arrives;
// - while a panel is on screen, it is redrawn at most every REDRAW_MS (nothing is drawn for a panel
//   in a closed dialog, a hidden page or a background tab);
// - the memo is redrawn only when it changes from outside the typing (a snapshot line) or the link
//   comes or goes, never while the learner types.
// Listening only: nothing here sends anything to the robot.
//
// The same tracker feeds the compact strip (`liveStateStrip`) a live block shows right under its
// start button: the few values to watch while the robot runs, where the button was pressed.

const text = await loadJson('content/live/robot-state.json');

const REDRAW_MS = 100; // about 10 redraws a second
const MEMO_PREFIX = 'questix-lab-state-memo:';
const MEMO_MAX_CHARS = 20000;
const STREAMS = ['drive', 'odom', 'scan', 'twist', 'drive_state'];

const tracker = createStateTracker();
const panels = new Map(); // place -> entry (see entryOf)
const strips = new Map(); // place -> strip entry (see stripOf)
let timer = 0;

// --- the memo, kept per place in this browser (a convenience: saving the text is the real copy) ---

function readMemo(place) {
  try {
    return localStorage.getItem(MEMO_PREFIX + place) ?? '';
  } catch {
    return '';
  }
}

function keepMemo(place, memo) {
  try {
    if (memo) localStorage.setItem(MEMO_PREFIX + place, memo);
    else localStorage.removeItem(MEMO_PREFIX + place);
  } catch {
    /* storage blocked or full: the memo lasts until the page closes */
  }
}

// --- drawing ------------------------------------------------------------------------------------

function currentModel() {
  const state = robotState();
  return robotStateModel(tracker, {
    link: liveLink(),
    silent: state.silent,
    driveState: latestRobot('drive_state'),
    session: state.session,
    now: performance.now(),
  });
}

const visible = (element) =>
  element.isConnected &&
  (typeof element.checkVisibility === 'function'
    ? element.checkVisibility()
    : element.offsetParent !== null);

function drawLive(entry, model) {
  const hidden = entry.options.hideOffline && !model.connected;
  const status = hidden ? '' : (entry.options.status?.() ?? '');
  render(hidden ? nothing : robotStateView(model, text, entry.actions, status), entry.live);
}

// Offline an empty memo is left out: the place's own inputs are where a class without a robot
// works. A memo that holds something stays, so it can still be read and saved.
function drawMemo(entry, connected) {
  entry.memoConnected = connected;
  const hidden = !connected && (entry.options.hideOffline || !entry.memo.trim());
  const memo = { text: entry.memo, connected, placeholder: entry.options.placeholder ?? null };
  render(hidden ? nothing : memoView(memo, text, entry.actions), entry.memoPart);
}

function drawStrip(entry, model) {
  const status = entry.options.status?.() ?? '';
  render(stripView(stripModel(model), text, status), entry.element);
}

function tick() {
  if (typeof document !== 'undefined' && document.hidden) return;
  const attached = [...panels.values()].filter((entry) => entry.element?.isConnected);
  const stripsShown = [...strips.values()].filter(
    (entry) => entry.element?.isConnected && visible(entry.element),
  );
  const stripsAttached = [...strips.values()].some((entry) => entry.element?.isConnected);
  if (!attached.length && !stripsAttached) {
    stopTimer();
    return;
  }
  const onScreen = attached.filter((entry) => visible(entry.element));
  // "Since the panel opened": a panel that comes into view (its topic opened, its dialog shown)
  // starts the trail afresh. A panel on a page that is not shown does not.
  if (onScreen.some((entry) => !entry.onScreen)) resetPose(tracker);
  for (const entry of attached) entry.onScreen = onScreen.includes(entry);
  if (!onScreen.length && !stripsShown.length) return;
  const model = currentModel();
  for (const entry of onScreen) {
    drawLive(entry, model);
    if (entry.memoConnected !== model.connected) drawMemo(entry, model.connected);
  }
  for (const entry of stripsShown) drawStrip(entry, model);
}

function startTimer() {
  if (!timer) timer = setInterval(tick, REDRAW_MS);
}

function stopTimer() {
  clearInterval(timer);
  timer = 0;
}

// --- one panel per place --------------------------------------------------------------------------

function attach(entry, element) {
  if (entry.element === element) return;
  entry.element = element;
  entry.live = document.createElement('div');
  entry.live.className = 'robot-state-live';
  entry.memoPart = document.createElement('div');
  entry.memoPart.className = 'robot-state-memo';
  element.replaceChildren(entry.live, entry.memoPart);
  entry.onScreen = false; // the next redraw that finds it visible restarts the trail
  const model = currentModel();
  drawLive(entry, model);
  drawMemo(entry, model.connected);
  startTimer();
}

function snapshot(entry) {
  const line = snapshotLine(currentModel(), new Date(), text.memo);
  const before = entry.memo.replace(/\s+$/, '');
  entry.memo = (before ? `${before}\n${line} ` : `${line} `).slice(-MEMO_MAX_CHARS);
  keepMemo(entry.place, entry.memo);
  drawMemo(entry, entry.memoConnected);
  // The learner writes the measured value right after the line: the caret waits there.
  const field = entry.memoPart?.querySelector('textarea');
  if (field) {
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  }
}

function saveMemo(entry) {
  const name = entry.options.name ?? entry.place;
  const heading = fill(text.memo.fileHeading, { place: name });
  // BOM so that text editors on Windows read UTF-8.
  downloadFile(fill(text.memo.fileName, { place: name }), `\uFEFF${heading}\n\n${entry.memo}\n`);
}

function entryOf(place) {
  if (panels.has(place)) return panels.get(place);
  const entry = {
    place,
    options: {},
    element: null,
    onScreen: false,
    live: null,
    memoPart: null,
    memoConnected: null,
    memo: readMemo(place),
  };
  entry.actions = {
    connect: openRobotDialog,
    resetPose() {
      resetPose(tracker);
      drawLive(entry, currentModel());
    },
    write(value) {
      entry.memo = value.slice(0, MEMO_MAX_CHARS);
      keepMemo(place, entry.memo);
    },
    snapshot: () => snapshot(entry),
    save: () => saveMemo(entry),
  };
  // A stable callback: lit calls a changed ref callback again, which would restart the trail.
  entry.mount = (element) => {
    if (element) attach(entry, element);
    else if (entry.element) entry.element = null;
  };
  panels.set(place, entry);
  return entry;
}

/**
 * The panel and its memo for `place` (a key such as 'motor-real', also the memo's storage key), as
 * a lit template for the lesson's own view. `options`:
 * - `name`: the words the saved memo file is named after (default: the place key);
 * - `placeholder`: an example of what to write in this place's memo;
 * - `hideOffline`: show nothing without a robot (a block that already offers the connection);
 * - `status()`: the lesson's line about what happens now (a run's step), drawn at the panel's top
 *   with every redraw, or '';
 * - `folded`: inside a closed 「実機の状態をくわしく見る」 <details> (a block that shows the strip
 *   under its button already has the values to watch; the panel is only drawn once opened).
 */
function robotStatePanel(place, options = {}) {
  const entry = entryOf(place);
  entry.options = options;
  // A panel moved back on screen (a dialog's content returned to the page) redraws again.
  if (entry.element?.isConnected) startTimer();
  const host = html`<div
    class="robot-state-host"
    data-robot-state-place=${place}
    ${ref(entry.mount)}
  ></div>`;
  if (!options.folded) return host;
  return html`<details class="rs-more" data-rs-more=${place}>
    <summary>${text.more}</summary>
    ${host}
  </details>`;
}

function stripOf(place) {
  if (strips.has(place)) return strips.get(place);
  const entry = { place, options: {}, element: null };
  entry.mount = (element) => {
    entry.element = element ?? null;
    if (!element) return;
    drawStrip(entry, currentModel());
    startTimer();
  };
  strips.set(place, entry);
  return entry;
}

/**
 * The compact strip for `place` (one per block: a session's slot, 'bench' …) as a lit template:
 * the emergency stop, who drives, both wheels, the speed and its last ten seconds. It draws itself
 * like the panel (at most 10 Hz, only while on screen). `options.status()`: the lesson's line about
 * the run in progress (a step of a staircase), or ''.
 */
function liveStateStrip(place, options = {}) {
  const entry = stripOf(place);
  entry.options = options;
  if (entry.element?.isConnected) startTimer();
  return html`<div class="rs-strip-host" data-rs-strip-place=${place} ${ref(entry.mount)}></div>`;
}

/** The memo of `place` as typed so far (e.g. for a lesson's own saved file). */
const stateMemo = (place) => entryOf(place).memo;

function listen() {
  for (const type of STREAMS)
    onRobot(type, (message) =>
      ingest(tracker, type, message, performance.now(), robotState().hello?.config),
    );
  // A new link is a new robot, or the same one after a restart: nothing of the old one is kept.
  onRobot('state', (link) => {
    if (link.phase !== 'open') Object.assign(tracker, createStateTracker());
    tick();
  });
}

listen();

export { robotStatePanel, liveStateStrip, stateMemo };
