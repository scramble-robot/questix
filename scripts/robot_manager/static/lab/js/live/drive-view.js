import { html, nothing } from '../vendor/lit-html.js';
import { loadJson, fillSentence as fill } from '../core/content.js';

// The block a lesson shows when it can drive the real robot: why it cannot yet (each blocker with
// what to do about it), the learner's safety tick, the limits, start / stop, and how the last run
// ended. Pure templates; the state is drive-link.js's `driveModel()` plus the lesson's own
// `program` sentence. Sentences live in content/live/drive.json.

const driveCopy = await loadJson('content/live/drive.json');

function blockerItem(blocker) {
  const text = fill(driveCopy.blockers[blocker.code] ?? blocker.code, {
    nodes: (blocker.nodes ?? []).join('、'),
  });
  return html`<li data-drive-blocker=${blocker.code}>
    ${text}
    ${
      blocker.code === 'other_publisher'
        ? html`<code class="drive-relaunch">${driveCopy.relaunch}</code>`
        : nothing
    }
  </li>`;
}

// Everything but the safety tick, which has its own checkbox right below.
function checklist(model) {
  const blockers = model.blockers.filter((blocker) => blocker.code !== 'unconfirmed');
  if (!blockers.length) return html`<p class="drive-ready" data-drive-ready>${driveCopy.ready}</p>`;
  return html`<ul class="drive-blockers">
    ${blockers.map(blockerItem)}
  </ul>`;
}

function confirmBox(model, actions) {
  return html`<label class="drive-confirm">
    <input
      type="checkbox"
      data-drive-confirm
      .checked=${model.confirmed}
      ?disabled=${model.running}
      @change=${(event) => actions.confirmDrive(event.target.checked)}
    />
    ${driveCopy.confirm}
  </label>`;
}

function limitsNote(model) {
  if (!model.limits) return nothing;
  return html`<p class="drive-note">
    ${fill(driveCopy.limits, {
      linear: model.limits.linear.toFixed(2),
      angular: model.limits.angular.toFixed(2),
    })}
  </p>`;
}

/** What happened to a run (drive-link's result), as one sentence for the lesson's note. */
function driveEndedText(result) {
  const ended = driveCopy.ended;
  if (result.reason === 'refused') {
    const first = result.blockers?.find((blocker) => blocker.code !== 'unconfirmed');
    const code = result.refused ?? first?.code;
    const reason = fill(driveCopy.blockers[code] ?? code ?? '', {
      nodes: (first?.nodes ?? []).join('、'),
    });
    return fill(ended.refused, { reason });
  }
  if (result.reason === 'failed') return result.message;
  return fill(ended[result.reason] ?? result.reason, {});
}

function runButton(model, drive, actions) {
  if (model.running)
    return html`<button class="drive-stop" data-drive-stop @click=${actions.stopCapture}>
      ${driveCopy.stop}
    </button>`;
  return html`<button
    class="drive-start"
    data-drive-start
    ?disabled=${!drive.ready || model.recording}
    @click=${actions.startDriveCapture}
  >
    ${drive.startLabel ?? driveCopy.start}
  </button>`;
}

/**
 * `model` is the session model (`recording`, `running`, `elapsed`, `total`), `drive` the lesson's
 * drive part: driveModel() plus `program` (what will happen, one sentence) and `startLabel`.
 * `actions` needs `startDriveCapture`, `stopCapture` and `confirmDrive`.
 */
function driveControls(model, drive, actions) {
  return html`<div class="drive-block" data-drive-block>
    <h4>${driveCopy.title}</h4>
    ${drive.program ? html`<p>${drive.program}</p>` : nothing} ${checklist(drive)}
    ${confirmBox({ ...drive, running: model.running }, actions)} ${limitsNote(drive)}
    <div class="live-capture-actions">${runButton(model, drive, actions)}</div>
    ${
      model.running
        ? html`<p class="drive-progress" role="status">
            ${fill(driveCopy.running, {
              seconds: model.elapsed.toFixed(0),
              total: model.total.toFixed(0),
            })}
          </p>`
        : nothing
    }
    <p class="drive-note">${driveCopy.afterNote}</p>
  </div>`;
}

export { driveControls, driveEndedText, driveCopy, checklist as driveChecklist, confirmBox };
