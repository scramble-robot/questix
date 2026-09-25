import { html, nothing } from '../vendor/lit-html.js';
import { loadJson, fillSentence as fill } from '../core/content.js';
import { driveControls } from './drive-view.js';
import { setGroupName } from './capture.js';

// The one block of controls a lesson shows when it can take measurements from the real robot:
// the state of the link, which stream is missing, and the record / stop button. Pure templates —
// the lesson owns the state and passes `actions`. Sentences live in content/live/capture.json.

const captureCopy = await loadJson('content/live/capture.json');

const streamLabel = (name) => captureCopy.streamNames[name] ?? name;

// While the page may drive the robot, the controller is off, so /target_twist only flows while
// someone drives: not receiving it then is normal, not a fault worth a warning.
function missingNow(model) {
  if (!drivingAllowed(model)) return model.link.missing;
  return model.link.missing.filter((name) => name !== 'twist');
}

function linkMessage(model) {
  const missing = missingNow(model);
  if (model.link.connected && missing.length)
    return fill(captureCopy.missing, { streams: missing.map(streamLabel).join('と') });
  if (drivingAllowed(model)) return captureCopy.state.openDrive;
  return captureCopy.state[model.link.phase] ?? captureCopy.state.idle;
}

const drivingAllowed = (model) => Boolean(model.drive?.allowed && model.link.connected);
// A driving run (or its tail) owns the block's buttons until it is over.
const driveBusy = (model) => model.running || model.tail;

function recordLabel(model) {
  if (drivingAllowed(model)) return fill(captureCopy.recordOther, { seconds: model.seconds });
  return fill(model.recordLabel ?? captureCopy.record, { seconds: model.seconds });
}

function recordButton(model, actions) {
  if (driveBusy(model)) return nothing;
  if (model.recording)
    return html`<button class="live-capture-stop" @click=${actions.stopCapture}>
      ${model.stopLabel ?? captureCopy.stop}
    </button>`;
  // With driving allowed this is the secondary way: recording a run someone else drives.
  return html`<button
    class=${drivingAllowed(model) ? 'live-capture-record quiet' : 'live-capture-record'}
    ?disabled=${!model.link.connected || model.link.missing.length > 0}
    @click=${actions.startCapture}
  >
    ${recordLabel(model)}
  </button>`;
}

// Opening a recording: a file this material saved, or a rosbag recorded on the robot. Offered
// without a connection too: a class can work from yesterday's recordings with the robot off.
function openControl(model, actions) {
  return html`<label class="live-capture-open"
    >${captureCopy.file.open}
    <input
      data-live-open
      type="file"
      accept=".json,.mcap,application/json"
      ?disabled=${model.recording}
      @change=${(event) => {
        actions.openRecording(event.target.files[0]);
        event.target.value = '';
      }}
  /></label>`;
}

// 班の名前, written into every recording made on this device and into the saved file's name. A
// lesson whose actions do not pass live-session's `setGroup` on still gets the field: the name is
// per browser, not per lesson, so it is stored directly (the input keeps what was typed).
function groupField(model, actions) {
  const text = captureCopy.group;
  const setGroup = actions.setGroup ?? setGroupName;
  return html`<label class="live-capture-group"
    ><span>${text.label}</span>
    <input
      data-live-group
      type="text"
      maxlength="30"
      autocomplete="off"
      placeholder=${text.placeholder}
      .value=${model.file.group ?? ''}
      @change=${(event) => setGroup(event.target.value)}
    />
    <small>${text.note}</small></label
  >`;
}

// Saving the recording on screen (and, unless the block is folded offline, opening one).
function fileControls(model, actions, { open = true } = {}) {
  if (!model.file) return nothing;
  const text = captureCopy.file;
  return html`<div class="live-capture-files">
    ${open ? openControl(model, actions) : nothing} ${groupField(model, actions)}
    <button
      data-live-save
      ?disabled=${!model.file.canSave}
      @click=${() => actions.saveRecording('json')}
    >
      ${text.saveJson}
    </button>
    <button
      data-live-save-csv
      ?disabled=${!model.file.canSave}
      @click=${() => actions.saveRecording('csv')}
    >
      ${text.saveCsv}
    </button>
    <button
      class="quiet"
      data-live-save-raw
      ?disabled=${!model.file.canSave}
      @click=${() => actions.saveRecording('raw-csv')}
    >
      ${text.saveRawCsv}
    </button>
    <p class="live-capture-note">${text.note} ${text.share}</p>
  </div>`;
}

/**
 * `model` is `{ link: {connected, phase, missing}, recording, progress, seconds, message }`, plus
 * optional `recordLabel` / `stopLabel` sentences and `file: {canSave}` to offer saving and opening
 * recordings. `actions` needs `startCapture` and `stopCapture` (and, with `file`, `saveRecording`
 * and `openRecording`); `openLink` is optional and, when given, adds the shortcut to the connection
 * dialog for a learner who has not connected yet. With `drive` (live-session's drive part), the
 * block also offers driving the robot (drive-view.js), which needs `startDriveCapture` and
 * `confirmDrive` in `actions`.
 */
function captureNote(model) {
  if (!model.drive) return captureCopy.readOnly;
  return drivingAllowed(model) ? captureCopy.recordOtherNote : captureCopy.recordOnly;
}

// The recording part: link state, the record button (the main one unless the page may drive),
// progress, the lesson's message and the files.
const messageLine = (model) =>
  model.message
    ? html`<p class="live-capture-message" role="status" data-live-message>${model.message}</p>`
    : nothing;

function capturePart(model, actions, options) {
  return html`<div class="live-capture" data-live-capture>
    <p class="live-capture-state" data-live-state>${linkMessage(model)}</p>
    <div class="live-capture-actions">
      ${recordButton(model, actions)}
      ${
        !model.link.connected && actions.openLink
          ? html`<button class="quiet" @click=${actions.openLink}>${captureCopy.connect}</button>`
          : nothing
      }
    </div>
    ${
      model.recording && !driveBusy(model)
        ? html`<p class="live-capture-progress" role="status">
            ${fill(captureCopy.progress, { count: model.progress })}
          </p>`
        : nothing
    }
    ${options?.open === false ? nothing : messageLine(model)}
    ${fileControls(model, actions, options)}
    <p class="live-capture-note">${captureNote(model)}</p>
  </div>`;
}

// Without a robot the block is folded into one line: a learner who has no robot must not have to
// read past disabled buttons to reach the next experiment, and can still open it to connect or to
// save. Opening a recording stays outside the fold, since that is what a class without a robot
// does (next to the lesson's own "compare with other groups" input, which follows the block), and
// so does the sentence saying what was opened.
function offlineBlock(model, actions) {
  return html`<div class="live-offline-block">
    ${model.file ? html`<div class="live-offline-open">${openControl(model, actions)}</div>` : nothing}
    ${messageLine(model)}
    <details class="live-offline" data-live-offline>
      <summary>${captureCopy.offline}</summary>
      ${capturePart(model, actions, { open: false })}
    </details>
  </div>`;
}

function liveCaptureControls(model, actions) {
  const busy = model.recording || driveBusy(model);
  if (!model.link.connected && !busy) return offlineBlock(model, actions);
  const drive =
    model.drive && model.link.connected ? driveControls(model, model.drive, actions) : nothing;
  // When the page may drive, driving comes first; otherwise the one-line note follows recording.
  if (drivingAllowed(model) || driveBusy(model))
    return html`<div class="live-block">${drive} ${capturePart(model, actions)}</div>`;
  return html`<div class="live-block">${capturePart(model, actions)} ${drive}</div>`;
}

// The sentences a lesson adds after a recording, so every course reports the same conditions.
function captureNotes(summary) {
  const notes = [
    fill(captureCopy.summary.recorded, {
      seconds: summary.seconds.toFixed(1),
      samples: summary.samples,
    }),
  ];
  if (!summary.moved) notes.push(captureCopy.summary.notMoved);
  if (!summary.commanded) notes.push(captureCopy.summary.notCommanded);
  if (summary.emergencyStop) notes.push(captureCopy.summary.emergencyStop);
  return notes.join(' ');
}

export { liveCaptureControls, captureNotes, captureCopy };
