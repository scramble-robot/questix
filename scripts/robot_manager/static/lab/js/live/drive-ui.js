import { html, nothing, render, unsafeHTML } from '../vendor/lit-html.js';
import { fillSentence as fill } from '../core/content.js';
import { driveModel, onDrive, confirmDriveSafety, stopDrive, runDrive } from './drive-link.js';
import {
  driveCopy,
  driveChecklist,
  driveTeacherDetails,
  driveFirstReason,
  confirmBox,
  driveEndedText,
} from './drive-view.js';
import { recordRobot, liveLink } from './capture.js';
import { runModeBadgeHtml } from '../shell/run-mode.js';
import {
  addDriveRun,
  driveRuns,
  driveRun,
  saveDriveRun,
  clearDriveRuns,
  onDriveRuns,
  isEmptyRun,
} from './drive-history.js';
import {
  driveReportView,
  driveHistoryList,
  reportCopy,
  compareLimit,
} from './drive-report-view.js';

// The pieces of the driving experiments that belong to no lesson:
// - the stop bar, fixed at the bottom of every page while the robot drives on a lesson's command —
//   this page's or another one's — so a stop is always one tap (or Esc) away;
// - the bench test in the 実機 dialog: hold a button and the robot moves slowly, release and it stops,
//   for checking wheel directions and left/right after assembly. Each press is recorded;
// - the history of every run of this browser (drive-history.js) in the same dialog, with the
//   report of the one selected.

const BENCH_DEFAULTS = { linear: 0.1, angular: 0.5 }; // m/s, rad/s
const BENCH_MIN = { linear: 0.06, angular: 0.3 }; // below drive_component's dead band (drive-core)
const BENCH_STEP = { linear: 0.02, angular: 0.1 };
const BENCH_MAX_SECONDS = 20; // one press; the bridge's own limit is longer
const BENCH_TAIL_SECONDS = 1; // recorded after release, so the report shows the robot stopping
const BENCH_MIN_PRESS = 0.5; // s: a shorter tap is not worth an entry in the run history
const RECORD_SPARE_SECONDS = 5; // the recording's own time limit, only a backstop
const BENCH_MOVES = [
  { id: 'forward', linear: 1, angular: 0 },
  { id: 'left', linear: 0, angular: 1 },
  { id: 'right', linear: 0, angular: -1 },
  { id: 'backward', linear: -1, angular: 0 },
];

const bench = { ...BENCH_DEFAULTS, held: null, abort: null, note: '' };
let selectedRun = null; // id of the run whose report the dialog shows; null = the newest
let newestRun = null; // id of the newest run seen, so a new run (from any block) is shown at once
let comparedRuns = []; // ids ticked to be drawn over the shown report (at most compareLimit)

// --- stop bar --------------------------------------------------------------------------------

function stopBar(model) {
  if (!model.active && !model.running) return nothing;
  const mine = model.running || model.owner === 'me';
  // Esc only stops this page's own run (drive-link.js), so the key is only named for that one;
  // CSS hides the hint on touch screens, which have no Esc key.
  return html`<div class="drive-bar" role="alert" data-drive-bar>
    <span class="drive-bar-dot" aria-hidden="true"></span>
    <strong>${mine ? driveCopy.bar.mine : driveCopy.bar.other}</strong>
    <button class="drive-bar-stop" data-drive-bar-stop @click=${stopDrive}>
      ${driveCopy.bar.stop}${
        mine ? html`<span class="drive-bar-esc">${driveCopy.bar.esc}</span>` : nothing
      }
    </button>
  </div>`;
}

// --- bench test --------------------------------------------------------------------------------

function limitOf(model, key) {
  return model.limits ? model.limits[key] : BENCH_DEFAULTS[key];
}

async function hold(move) {
  if (bench.held) return;
  const abort = new AbortController();
  Object.assign(bench, { held: move.id, abort, note: '' });
  update();
  const finish = new AbortController();
  const recorded = recordRobot({
    seconds: BENCH_MAX_SECONDS + RECORD_SPARE_SECONDS,
    finish: finish.signal,
  }).catch((error) => error);
  const result = await runDrive({
    controller: () => ({
      linear: move.linear * bench.linear,
      angular: move.angular * bench.angular,
    }),
    seconds: BENCH_MAX_SECONDS,
    signal: abort.signal,
  });
  Object.assign(bench, { held: null, abort: null, note: benchNote(result) });
  update();
  if (result.started)
    await new Promise((resolve) => setTimeout(resolve, BENCH_TAIL_SECONDS * 1000));
  finish.abort();
  const recording = await recorded;
  if (!result.started || recording instanceof Error || result.elapsed < BENCH_MIN_PRESS) return;
  if (isEmptyRun(recording)) return;
  addDriveRun({
    slot: 'bench',
    lesson: fill(driveCopy.lessons.bench, { move: driveCopy.bench[move.id] }),
    conditions: move.linear
      ? `${bench.linear.toFixed(2)} m/s`
      : `${bench.angular.toFixed(2)} rad/s`,
    ended: bench.note,
    // Letting go of the button is how a bench move is meant to end.
    reason: result.reason === 'stopped' ? 'done' : result.reason,
    robot: liveLink().robot?.name ?? '',
    cut: Boolean(recording.cut),
    recording,
  });
}

// Releasing the button is the normal end of a bench move; anything else is worth a sentence.
function benchNote(result) {
  if (result.reason === 'stopped') return '';
  if (result.reason === 'done')
    return fill(driveCopy.bench.timeLimit, { seconds: BENCH_MAX_SECONDS });
  return driveEndedText(result);
}

function release() {
  bench.abort?.abort();
}

function benchButton(model, move) {
  // The held button stays enabled while it drives (this page's own run makes `ready` false).
  const held = bench.held === move.id;
  const disabled = bench.held !== null ? !held : !model.ready;
  return html`<button
    class="drive-bench-move ${held ? 'held' : ''}"
    data-drive-bench=${move.id}
    ?disabled=${disabled}
    @pointerdown=${(event) => {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      hold(move);
    }}
    @pointerup=${release}
    @pointercancel=${release}
    @lostpointercapture=${release}
    @keydown=${(event) => {
      if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
        event.preventDefault();
        hold(move);
      }
    }}
    @keyup=${release}
    @blur=${release}
    @contextmenu=${(event) => event.preventDefault()}
  >
    ${driveCopy.bench[move.id]}
  </button>`;
}

function speedSlider(model, key, label) {
  const max = limitOf(model, key);
  return html`<label class="drive-bench-speed">
    ${label}
    <input
      type="range"
      data-drive-bench-speed=${key}
      min=${BENCH_MIN[key]}
      max=${max}
      step=${BENCH_STEP[key]}
      .value=${String(Math.min(bench[key], max))}
      @input=${(event) => {
        bench[key] = Number(event.target.value);
        update();
      }}
    />
    <output>${Math.min(bench[key], max).toFixed(2)} ${key === 'linear' ? 'm/s' : 'rad/s'}</output>
  </label>`;
}

function benchPanel(model) {
  const heading = html`<h3>${unsafeHTML(runModeBadgeHtml('drive'))} ${driveCopy.bench.title}</h3>`;
  if (!model.allowed)
    return html`${heading}
      <p>${driveCopy.notAllowed}</p>
      ${driveTeacherDetails(model)}`;
  const reason = bench.held === null ? driveFirstReason(model) : '';
  return html`${heading}
    <p>${fill(driveCopy.bench.lead, { seconds: BENCH_MAX_SECONDS })}</p>
    ${driveChecklist(model)} ${driveTeacherDetails(model)}
    ${confirmBox(model, { confirmDrive: confirmDriveSafety }, bench.held !== null)}
    <div class="drive-bench-speeds">
      ${speedSlider(model, 'linear', driveCopy.bench.speed)}
      ${speedSlider(model, 'angular', driveCopy.bench.turnSpeed)}
    </div>
    <div class="drive-bench-pad">${BENCH_MOVES.map((move) => benchButton(model, move))}</div>
    ${reason ? html`<p class="drive-why">${reason}</p>` : nothing}
    ${bench.note ? html`<p class="drive-result" role="status">${bench.note}</p>` : nothing}`;
}

// A modal dialog sits in the browser's top layer, above any z-index, so the bar moves into the open
// dialog (where position: fixed still means the viewport) and back to the page when it closes.
function placeStopBar() {
  const host = document.getElementById('driveBar');
  const dialogs = [...document.querySelectorAll('dialog[open]')];
  const parent = dialogs.at(-1) ?? document.body;
  if (host.parentElement !== parent) parent.append(host);
}

// --- history -----------------------------------------------------------------------------------

function toggleCompare(id) {
  if (comparedRuns.includes(id)) comparedRuns = comparedRuns.filter((other) => other !== id);
  else if (comparedRuns.length < compareLimit) comparedRuns = [...comparedRuns, id];
  update();
}

function historyPanel() {
  const copy = reportCopy;
  const runs = driveRuns();
  if (!runs.length)
    return html`<h3>${copy.historyTitle}</h3>
      <p>${copy.historyEmpty}</p>`;
  const shown = (selectedRun !== null && driveRun(selectedRun)) || runs[0];
  return html`<h3>${copy.historyTitle}</h3>
    <p>${copy.historyLead}</p>
    ${driveHistoryList({
      runs,
      selected: shown.id,
      compared: comparedRuns,
      select: (id) => {
        selectedRun = id;
        update();
      },
      toggleCompare,
    })}
    ${driveReportView(shown, {
      saveRun: saveDriveRun,
      compare: comparedRuns.map(driveRun).filter(Boolean),
    })}
    <button
      class="quiet"
      data-drive-history-clear
      @click=${() => {
        if (window.confirm(copy.clearConfirm)) clearDriveRuns();
      }}
    >
      ${copy.clear}
    </button>`;
}

function update() {
  const model = driveModel();
  placeStopBar();
  render(stopBar(model), document.getElementById('driveBar'));
  // Room at the bottom of the page, so the bar never hides its last buttons.
  document.body.classList.toggle('driving', model.active || model.running);
  const newest = driveRuns()[0]?.id ?? null;
  if (newest !== newestRun) {
    newestRun = newest;
    selectedRun = null;
  }
  // Runs that fell off the history (or were cleared) cannot be compared any more.
  comparedRuns = comparedRuns.filter((id) => driveRun(id));
  render(historyPanel(), document.getElementById('robotDriveLog'));
  const panel = document.getElementById('robotDrive');
  // Driving needs a connection; before that the dialog is about connecting.
  panel.hidden = model.blockers.some((blocker) => blocker.code === 'no_link');
  render(panel.hidden ? nothing : benchPanel(model), panel);
}

function initDriveUi() {
  onDrive(update);
  onDriveRuns(update);
  new MutationObserver(placeStopBar).observe(document.body, {
    subtree: true,
    attributeFilter: ['open'],
  });
  update();
}

initDriveUi();

export { initDriveUi };
