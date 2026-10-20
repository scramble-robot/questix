import { controlStatus, hardBlocked } from './control-status.js';
import { freshInteraction } from './press-guard.js';
import { html, nothing } from '../vendor/lit-html.js';
import { loadJson, fillSentence as fill } from '../core/content.js';
import { driveReportView } from './drive-report-view.js';

// The block a lesson shows when it can drive the real robot. Pure templates; the state is
// drive-link.js's `driveModel()` plus the lesson's `program` / `placement` sentences and the
// session's run state. Sentences live in content/live/drive.json.
//
// Two readers: the learner sees one sentence per reason they cannot drive yet (and what to do,
// usually "tell the teacher"); what a teacher or technician needs (node names, commands) is folded
// into one details element below it.

const driveCopy = await loadJson('content/live/drive.json');

const DEGREES_PER_RADIAN = 180 / Math.PI;
// Reasons the learner deals with at the button (tick the box, wait); the others need the teacher
// and are listed above the button.
const LEARNER_BLOCKERS = ['unconfirmed', 'busy', 'running_here'];
const isLearners = (blocker) => LEARNER_BLOCKERS.includes(blocker.code);

const blockerCopy = (code) => driveCopy.blockers[code] ?? { student: code };

function blockerValues(blocker) {
  return { nodes: (blocker.nodes ?? []).join('、'), streams: blocker.streams ?? '' };
}

const studentText = (blocker) => fill(blockerCopy(blocker.code).student, blockerValues(blocker));

// What the learner can do about a disabled start button, as one line under it.
function firstReason(drive) {
  const first = drive.blockers.find(isLearners);
  return first ? studentText(first) : '';
}

function teacherDetails(drive) {
  const entries = drive.blockers.filter((blocker) => blockerCopy(blocker.code).teacher);
  if (!entries.length) return nothing;
  return html`<details class="drive-teacher">
    <summary>${driveCopy.teacherDetails}</summary>
    ${entries.map((blocker) => {
      const copy = blockerCopy(blocker.code);
      return html`<p data-drive-teacher=${blocker.code}>
        ${fill(copy.teacher, blockerValues(blocker))}
        ${copy.command ? html`<code class="drive-relaunch">${copy.command}</code>` : nothing}
      </p>`;
    })}
  </details>`;
}

// The reasons that need the teacher, in the learner's words (the learner's own ones are shown
// under the button).
function checklist(drive) {
  const teacherSide = drive.blockers.filter((blocker) => !isLearners(blocker));
  if (!drive.blockers.length)
    return html`<p class="drive-ready" data-drive-ready>${driveCopy.ready}</p>`;
  if (!teacherSide.length) return nothing;
  return html`<ul class="drive-blockers">
    ${teacherSide.map(
      (blocker) => html`<li data-drive-blocker=${blocker.code}>${studentText(blocker)}</li>`,
    )}
  </ul>`;
}

// `sentence`: what the learner confirms; the lesson blocks' default is about the placement line.
function confirmBox(drive, actions, running = false, sentence = driveCopy.confirm) {
  return html`<label class="drive-confirm">
    <input
      type="checkbox"
      data-drive-confirm
      .checked=${drive.confirmed}
      ?disabled=${running || hardBlocked(drive)}
      @change=${(event) => actions.confirmDrive(event.target.checked)}
    />
    ${sentence}
  </label>`;
}

function limitsNote(drive) {
  if (!drive.limits) return nothing;
  return html`<p class="drive-note">
    ${fill(driveCopy.limits, {
      linear: drive.limits.linear.toFixed(2),
      angular: drive.limits.angular.toFixed(2),
      degrees: Math.round(drive.limits.angular * DEGREES_PER_RADIAN),
    })}
  </p>`;
}

/** What happened to a run (drive-link's result), as one sentence. */
function driveEndedText(result) {
  const ended = driveCopy.ended;
  if (result.reason === 'refused') {
    const first = result.blockers?.find((blocker) => blocker.code !== 'unconfirmed');
    const code = result.refused ?? first?.code;
    const reason = code ? studentText({ ...first, code }) : '';
    return fill(ended.refused, { reason });
  }
  if (result.reason === 'failed') return result.message;
  return ended[result.reason] ?? ended.done;
}

function placementLine(drive) {
  if (!drive.placement) return nothing;
  return html`<p class="drive-placement">
    <strong>${driveCopy.placement}</strong> ${drive.placement}
  </p>`;
}

function progressLine(model) {
  if (model.tail) return html`<p class="drive-progress" role="status">${driveCopy.tail}</p>`;
  if (!model.running) return nothing;
  return html`<p class="drive-progress" role="status">
    ${fill(driveCopy.running, {
      seconds: model.elapsed.toFixed(0),
      total: model.total.toFixed(0),
    })}
  </p>`;
}

function runControls(model, drive, actions) {
  return html`<button
      class="drive-start"
      data-drive-start
      data-live-start-action
      ?disabled=${!drive.ready || model.recording || model.tail}
      @click=${(event) => freshInteraction(event, actions.startDriveCapture)}
    >
      ${drive.startLabel ?? driveCopy.start}</button
    ><button
      class="drive-stop"
      data-drive-stop
      ?disabled=${!model.running}
      @click=${actions.stopCapture}
    >
      ■ ${driveCopy.stop}
    </button>`;
}

/**
 * `model` is the session model (`recording`, `running`, `tail`, `elapsed`, `total`), `drive` the
 * lesson's drive part: driveModel() plus `program`, `placement`, `confirmLabel`, `startLabel`,
 * `report` (null for none) and `metrics` (the numbers of the report, null for all). `actions`
 * needs `startDriveCapture`, `stopCapture` and `confirmDrive`. `parts.strip` goes right under the
 * start button (the live strip), `parts.result` under that (how the last run went).
 */
function driveControls(model, drive, actions, parts = {}) {
  return html`<div class="drive-block" data-drive-block>
    <h4>${driveCopy.title}</h4>
    ${controlStatus(drive.blockers, model.running ? 'driving' : model.tail ? 'tail' : '', 'drive', drive.reconfirm)}
    ${confirmBox(drive, actions, model.running, drive.confirmLabel ?? driveCopy.confirm)}
    <div class="live-run" data-live-run>
      <div class="live-capture-actions drive-actions live-fixed-actions">
        ${runControls(model, drive, actions)}
      </div>
      ${progressLine(model)} ${parts.strip ?? nothing}
    </div>
    ${
      drive.reconfirm
        ? html`<p class="drive-result" role="status" data-drive-reconfirm>
            ${driveCopy.reconfirm[drive.reconfirm]}
          </p>`
        : nothing
    }
    ${drive.program ? html`<p>${drive.program}</p>` : nothing} ${placementLine(drive)}
    ${checklist(drive)} ${teacherDetails(drive)} ${parts.result ?? nothing}
    ${drive.report && !model.running && !model.tail ? driveReportView(drive.report, { compact: true, metrics: drive.metrics }) : nothing}
    ${limitsNote(drive)}
  </div>`;
}

export {
  driveControls,
  driveEndedText,
  driveCopy,
  checklist as driveChecklist,
  teacherDetails as driveTeacherDetails,
  firstReason as driveFirstReason,
  confirmBox,
};
