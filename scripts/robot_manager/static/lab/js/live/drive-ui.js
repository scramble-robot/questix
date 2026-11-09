import { renderLive } from './live-layout.js';
import { controlStatus, hardBlocked } from './control-status.js';
import { html, nothing, render, unsafeHTML } from '../vendor/lit-html.js';
import { fillSentence as fill } from '../core/content.js';
import { driveModel, onDrive, confirmDriveSafety, stopDrive, runDrive } from './drive-link.js';
import { DrivePressLatch } from './drive-core.js';
import {
  driveCopy,
  driveChecklist,
  driveTeacherDetails,
  driveFirstReason,
  confirmBox,
  driveEndedText,
} from './drive-view.js';
import { recordRobot, liveLink, groupName } from './capture.js';
import { withRunInfo } from './recording-core.js';
import { benchCheck } from './drive-report-core.js';
import { runModeBadgeHtml } from '../shell/run-mode.js';
import { addDriveRun, driveRuns, onDriveRuns, isEmptyRun } from './drive-history.js';
import { keepRunOnRobot } from './run-keeper.js';
import { recordsCopy } from './records-core.js';
import { reportCopy, runStatusText } from './drive-report-view.js';
import { liveStateStrip } from './robot-state.js';

// The pieces of the driving experiments that belong to no lesson:
// - the shared header/dialog stop control, fixed in the header after a connection, stopping a lesson's drive —
//   from this page or another one; Esc still stops only this page's own run;
// - the bench test in the 実機 dialog: hold a button and the robot moves slowly, release and it stops,
//   for checking wheel directions and left/right after assembly. Each press is recorded, and the
//   live strip under the buttons shows the wheels while it is held;
// - a short way from the same dialog to 記録の一覧 (#records), which lists every run of this browser
//   together with the records kept on the robot.

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

// --- bench test --------------------------------------------------------------------------------

function limitOf(model, key) {
  return model.limits ? model.limits[key] : BENCH_DEFAULTS[key];
}

const benchPress = new DrivePressLatch();

async function hold(move) {
  if (bench.held || !benchPress.press()) return;
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
  bench.note = [bench.note, benchResult(recording, move, reason)].filter(Boolean).join(' ');
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
// and whether that is what the pressed button asked for. After a controller takeover the wheels
// followed the stick, so nothing is judged (and no verdict goes into the run history).
function benchResult(recording, move, reason) {
  const copy = driveCopy.bench;
  const check = benchCheck(recording, { reason });
  if (!check) return copy.noCheck;
  if (check.skipped) return copy.noVerdictController;
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
  benchPress.release();
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
    @keyup=${(event) => {
      if (event.key === ' ' || event.key === 'Enter') release();
    }}
    @blur=${release}
    @contextmenu=${(event) => event.preventDefault()}
  >
    ${driveCopy.bench[move.id]}
  </button>`;
}

function speedSlider(model, key, label) {
  const max = limitOf(model, key);
  const shown = Number.isFinite(max) ? Math.min(bench[key], max) : null;
  return html`<label class="drive-bench-speed">
    ${label}
    <input
      type="range"
      data-drive-bench-speed=${key}
      min=${BENCH_MIN[key]}
      max=${max}
      step=${BENCH_STEP[key]}
      .value=${shown === null ? '' : String(shown)}
      ?disabled=${hardBlocked(model) || bench.held !== null}
      @input=${(event) => {
        bench[key] = Number(event.target.value);
        update();
      }}
    />
    <output
      >${shown === null ? '—' : shown.toFixed(2)} ${key === 'linear' ? 'm/s' : 'rad/s'}</output
    >
  </label>`;
}

function benchPanel(model) {
  const heading = html`<h3>${unsafeHTML(runModeBadgeHtml('drive'))} ${driveCopy.bench.title}</h3>`;
  const reason = bench.held === null ? driveFirstReason(model) : '';
  return html`${heading}
    <p>${fill(driveCopy.bench.lead, { seconds: BENCH_MAX_SECONDS })}</p>
    ${controlStatus(model.blockers, bench.held !== null ? 'driving' : '')}
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
    <div class="live-run" data-live-run>
      <div class="drive-bench-pad">${BENCH_MOVES.map((move) => benchButton(model, move))}</div>
      ${reason ? html`<p class="drive-why">${reason}</p>` : nothing} ${liveStateStrip('bench')}
    </div>
    ${driveChecklist(model)} ${driveTeacherDetails(model)}
    ${bench.note ? html`<p class="drive-result" role="status">${bench.note}</p>` : nothing}`;
}

// --- the way to 記録の一覧 -------------------------------------------------------------------

// Every run of this browser is listed in 記録の一覧 (#records) with the records kept on the robot,
// with its report, comparing, saving and adding files: the dialog only points there.
function historyPanel() {
  const copy = reportCopy;
  const count = driveRuns().length;
  return html`<h3>${copy.historyTitle}</h3>
    <p class="drive-note">
      ${count ? fill(copy.historyLink, { count }) : copy.historyLinkEmpty}
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

function update() {
  const model = driveModel();
  render(historyPanel(), document.getElementById('robotDriveLog'));
  const panel = document.getElementById('robotDrive');
  // Driving needs a connection; before that the dialog is about connecting.
  panel.hidden = false;
  renderLive(panel.hidden ? nothing : benchPanel(model), panel, { preserve: true });
}

function initDriveUi() {
  onDrive(update);
  onDriveRuns(update);
  update();
}

initDriveUi();

export { initDriveUi };
