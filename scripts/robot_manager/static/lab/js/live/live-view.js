import { html, nothing } from '../vendor/lit-html.js';
import { loadJson, fillSentence as fill } from '../core/content.js';
import { driveControls } from './drive-view.js';

// The one block of controls a lesson shows when it can take measurements from the real robot:
// the state of the link, which stream is missing, and the record / stop button. Pure templates —
// the lesson owns the state and passes `actions`. Sentences live in content/live/capture.json.

const captureCopy = await loadJson('content/live/capture.json');

const streamLabel = (name) => captureCopy.streamNames[name] ?? name;

function linkMessage(model) {
  if (model.link.connected && model.link.missing.length)
    return fill(captureCopy.missing, { streams: model.link.missing.map(streamLabel).join('と') });
  return captureCopy.state[model.link.phase] ?? captureCopy.state.idle;
}

function recordButton(model, actions) {
  // A driving run has its own stop button in the drive block.
  if (model.running) return nothing;
  if (model.recording)
    return html`<button class="live-capture-stop" @click=${actions.stopCapture}>
      ${model.stopLabel ?? captureCopy.stop}
    </button>`;
  return html`<button
    class="live-capture-record"
    ?disabled=${!model.link.connected || model.link.missing.length > 0}
    @click=${actions.startCapture}
  >
    ${fill(model.recordLabel ?? captureCopy.record, { seconds: model.seconds })}
  </button>`;
}

// Saving the recording on screen and opening one again — a file this material saved, or a rosbag
// recorded on the robot. Offered without a connection too: a class can work from yesterday's
// recordings with the robot switched off.
function fileControls(model, actions) {
  if (!model.file) return nothing;
  const text = captureCopy.file;
  return html`<div class="live-capture-files">
    <label class="live-capture-open"
      >${text.open}
      <input
        data-live-open
        type="file"
        accept=".json,.mcap,application/json"
        ?disabled=${model.recording}
        @change=${(event) => {
          actions.openRecording(event.target.files[0]);
          event.target.value = '';
        }}
    /></label>
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
    <p class="live-capture-note">${text.note}</p>
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
function liveCaptureControls(model, actions) {
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
      model.recording && !model.running
        ? html`<p class="live-capture-progress" role="status">
            ${fill(captureCopy.progress, { count: model.progress })}
          </p>`
        : nothing
    }
    ${
      model.message
        ? html`<p class="live-capture-message" role="status" data-live-message>${model.message}</p>`
        : nothing
    }
    ${model.drive && model.link.connected ? driveControls(model, model.drive, actions) : nothing}
    ${fileControls(model, actions)}
    <p class="live-capture-note">${model.drive ? captureCopy.recordOnly : captureCopy.readOnly}</p>
  </div>`;
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
