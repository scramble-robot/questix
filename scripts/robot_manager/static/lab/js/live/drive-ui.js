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
import { recordRobot, liveLink, openRecordingFile, groupName } from './capture.js';
import { withRunInfo } from './recording-core.js';
import { benchCheck } from './drive-report-core.js';
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
import { keepRunOnRobot } from './run-keeper.js';
import { recordsCopy } from './records-core.js';
import {
  driveReportView,
  driveHistoryList,
  reportCopy,
  compareLimit,
  runStatusText,
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
let historyNote = ''; // what happened to the last file opened into the history

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
  const raw = await recorded;
  if (!result.started || raw instanceof Error || result.elapsed < BENCH_MIN_PRESS) return;
  if (isEmptyRun(raw)) return;
  // Letting go of the button is how a bench move is meant to end.
  const reason = result.reason === 'stopped' ? 'done' : result.reason;
  const conditions = move.linear
    ? { linear: bench.linear, label: `${bench.linear.toFixed(2)} m/s` }
    : { angular: bench.angular, label: `${bench.angular.toFixed(2)} rad/s` };
  const recording = withRunInfo(raw, {
    lesson: 'bench',
    conditions,
    robot: liveLink().robot,
    group: groupName(),
    outcome: { reason, label: runStatusText(reason) },
  });
  bench.note = [bench.note, benchResult(recording, move)].filter(Boolean).join(' ');
  update();
  const run = addDriveRun({
    slot: 'bench',
    lesson: fill(driveCopy.lessons.bench, { move: driveCopy.bench[move.id] }),
    conditions: conditions.label,
    ended: bench.note,
    reason,
    robot: recording.robot?.name ?? '',
    group: recording.group ?? '',
    cut: Boolean(recording.cut),
    recording,
  });
  // Kept on the robot like every lesson run, so the class can find the wiring checks later too.
  const saved = await keepRunOnRobot(recording, run.id);
  if (saved && !bench.held) {
    bench.note = [bench.note, saved.message].join(' ');
    update();
  }
}

const signedRpm = (rpm) => `${rpm >= 0 ? '+' : '−'}${Math.abs(rpm).toFixed(0)}`;

// After release, one line on which way the wheels turned: 「左 +10 rpm・右 +10 rpm：まっすぐ前進」,
// and whether that is what the pressed button asked for.
function benchResult(recording, move) {
  const copy = driveCopy.bench;
  const check = benchCheck(recording);
  if (!check) return copy.noCheck;
  const line = fill(copy.result, {
    left: signedRpm(check.left),
    right: signedRpm(check.right),
    move: copy.moves[check.move],
  });
  if (check.move === 'still') return line;
  const verdict =
    check.move === move.id ? copy.expected : fill(copy.unexpected, { pressed: copy[move.id] });
  return `${line} ${verdict}`;
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
    ${confirmBox(
      model,
      { confirmDrive: confirmDriveSafety },
      bench.held !== null,
      driveCopy.confirmBench,
    )}
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

// Ticking 比べる draws the run over the shown report: its charts come first and are scrolled to.
function toggleCompare(id) {
  const adding = !comparedRuns.includes(id);
  if (!adding) comparedRuns = comparedRuns.filter((other) => other !== id);
  else if (comparedRuns.length < compareLimit) comparedRuns = [...comparedRuns, id];
  update();
  if (!adding) return;
  const charts = document.querySelector('#robotDriveLog [data-drive-report-charts]');
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // The dialog scrolls on its own, so window-based revealElement would not move it.
  charts?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
}

// A recording saved here or by another group, added to the history so it can be compared.
async function openIntoHistory(file) {
  if (!file) return;
  const copy = reportCopy;
  try {
    const { recording } = await openRecordingFile(file);
    if (isEmptyRun(recording)) {
      historyNote = fill(copy.openedEmpty, { name: file.name });
    } else {
      // Files saved before recordings named their lesson still carry it in the file name.
      const named = Object.keys(driveCopy.lessons).find((key) => file.name.includes(key));
      const slot = recording.lesson || named || 'file';
      selectedRun = addDriveRun({
        slot,
        lesson: driveCopy.lessons[slot] ?? copy.fileLesson,
        conditions: recording.conditions?.label ?? '',
        ended: recording.outcome?.label ?? '',
        reason: recording.outcome?.reason ?? '',
        robot: recording.robot?.name ?? '',
        group: recording.group ?? '',
        source: 'file',
        recording,
      }).id;
      newestRun = selectedRun;
      historyNote = fill(copy.opened, { name: file.name });
    }
  } catch (error) {
    historyNote = fill(copy.openFailed, { name: file.name, reason: error.message });
  }
  update();
}

function historyOpen() {
  const copy = reportCopy;
  return html`<div class="drive-history-open">
    <label class="live-capture-open"
      >${copy.openFile}
      <input
        data-drive-history-open
        type="file"
        accept=".json,.mcap,application/json"
        @change=${(event) => {
          openIntoHistory(event.target.files[0]);
          event.target.value = '';
        }}
    /></label>
    <p class="drive-note" role="status">${historyNote || copy.openNote}</p>
  </div>`;
}

// 記録の一覧 holds this list too, and the records every other device kept on the robot.
function recordsLink() {
  return html`<p class="drive-note">
    ${recordsCopy.entry.catalogueLead}
    <button
      class="text-button"
      data-drive-history-records
      @click=${() => {
        document.getElementById('robotDialog').close();
        location.hash = '#records';
      }}
    >
      ${recordsCopy.entry.catalogue}
    </button>
  </p>`;
}

function historyPanel() {
  const copy = reportCopy;
  const runs = driveRuns();
  if (!runs.length)
    return html`<h3>${copy.historyTitle}</h3>
      ${recordsLink()}
      <p>${copy.historyEmpty}</p>
      ${historyOpen()}`;
  const shown = (selectedRun !== null && driveRun(selectedRun)) || runs[0];
  return html`<h3>${copy.historyTitle}</h3>
    <p>${copy.historyLead}</p>
    ${recordsLink()}
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
    ${historyOpen()}
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
