import { html, nothing } from '../vendor/lit-html.js';
import { loadJson, fillSentence as fill } from '../core/content.js';

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
  if (model.recording)
    return html`<button class="live-capture-stop" @click=${actions.stopCapture}>
      ${captureCopy.stop}
    </button>`;
  return html`<button
    class="live-capture-record"
    ?disabled=${!model.link.connected || model.link.missing.length > 0}
    @click=${actions.startCapture}
  >
    ${fill(captureCopy.record, { seconds: model.seconds })}
  </button>`;
}

/**
 * `model` is `{ link: {connected, phase, missing}, recording, progress, seconds, message }`.
 * `actions` needs `startCapture` and `stopCapture`; `openLink` is optional and, when given, adds
 * the shortcut to the connection dialog for a learner who has not connected yet.
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
      model.recording
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
    <p class="live-capture-note">${captureCopy.readOnly}</p>
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
