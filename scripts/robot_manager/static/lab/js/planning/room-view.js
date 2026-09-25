import { html, nothing, unsafeHTML } from '../vendor/lit-html.js';
import { fillSentence as fill } from '../core/content.js';
import { liveCaptureControls } from '../live/live-view.js';
import { robotStatePanel } from '../live/robot-state.js';
import { runModeBadgeHtml } from '../shell/run-mode.js';

// Templates of the measured room (planning topic `room`): measuring it with the robot, opening a
// phone's 3D scan and choosing where to cut it, and placing the start and goal. Pure functions of
// `model.room` (room-ui.js `model()`); sentences come from content/planning.json `room`.

const CM = 100;
const cm = (metres) => Math.round(metres * CM);
// The select's option values back to scanRoom's `rotate`: 'auto', false or true.
const rotateValue = (value) => (value === 'auto' ? 'auto' : value === 'true');

function robotSection(room, text, actions) {
  return html`<section class="planning-room-source">
    <h3>${unsafeHTML(runModeBadgeHtml('live'))} ${text.robotTitle}</h3>
    ${text.steps.map((step) => html`<p>${step}</p>`)} ${liveCaptureControls(room.live, actions)}
    ${
      room.live.note
        ? html`<p class="planning-room-note" role="status">${room.live.note}</p>`
        : nothing
    }
    <p class="helper">${text.stateNote}</p>
    ${robotStatePanel('planning-room', { name: text.memoName, placeholder: text.memoPlaceholder })}
  </section>`;
}

// A number field in centimetres for a setting kept in metres.
function centimetreField(id, label, value, onChange, { min, max }) {
  return html`<label class="planning-scan-field" for=${id}
    >${label}<input
      id=${id}
      type="number"
      min=${min}
      max=${max}
      step="1"
      .value=${String(cm(value))}
      @change=${(event) => {
        const typed = Number(event.target.value);
        if (Number.isFinite(typed) && typed >= min && typed <= max) onChange(typed / CM);
      }}
    />
    cm</label
  >`;
}

function offsetSlider(axis, label, scan, actions) {
  const max = scan.maxOffset[axis];
  if (!(max > 0)) return nothing;
  return html`<label class="planning-scan-field" for=${'planningScanOffset-' + axis}
    >${label}<input
      id=${'planningScanOffset-' + axis}
      type="range"
      min="0"
      max=${max.toFixed(1)}
      step="0.1"
      .value=${String(scan.offset[axis])}
      @change=${(event) => actions.setScanOffset(axis, Number(event.target.value))}
  /></label>`;
}

function bandChoice(value, label, settings, actions) {
  return html`<label class="planning-check"
    ><input
      type="radio"
      name="planningScanBand"
      value=${value}
      .checked=${settings.band === value}
      @change=${() => actions.setScanSetting('band', value)}
    /><span>${label}</span></label
  >`;
}

function bodyFields(settings, text, actions) {
  return html`${centimetreField(
    'planningScanLowest',
    text.lowest,
    settings.lowest,
    (value) => actions.setScanSetting('lowest', value),
    { min: 1, max: 30 },
  )}
  ${centimetreField(
    'planningScanBody',
    text.bodyHeight,
    settings.bodyHeight,
    (value) => actions.setScanSetting('bodyHeight', value),
    { min: 5, max: 200 },
  )}`;
}

function lidarFields(settings, text, actions) {
  return html`${centimetreField(
    'planningScanLidar',
    text.lidarHeight,
    settings.lidarHeight,
    (value) => actions.setScanSetting('lidarHeight', value),
    { min: 1, max: 150 },
  )}
  ${centimetreField(
    'planningScanThickness',
    text.thickness,
    settings.thickness,
    (value) => actions.setScanSetting('thickness', value),
    { min: 1, max: 20 },
  )}`;
}

function scanSettings(scan, text, actions) {
  const { settings } = scan;
  const disabled = !scan.open;
  return html`<fieldset class="planning-scan-settings" ?disabled=${disabled}>
    <legend>${text.settingsTitle}</legend>
    ${bandChoice('body', text.bandBody, settings, actions)}
    ${bandChoice('lidar', text.bandLidar, settings, actions)}
    ${settings.band === 'body' ? bodyFields(settings, text, actions) : lidarFields(settings, text, actions)}
    <label class="planning-scan-field" for="planningScanUp"
      >${text.up}<select
        id="planningScanUp"
        .value=${settings.up}
        @change=${(event) => actions.setScanSetting('up', event.target.value)}
      >
        <option value="y">${text.upY}</option>
        <option value="z">${text.upZ}</option>
      </select></label
    >
    <label class="planning-scan-field" for="planningScanRotate"
      >${text.rotate}<select
        id="planningScanRotate"
        .value=${String(settings.rotate)}
        @change=${(event) => actions.setScanSetting('rotate', rotateValue(event.target.value))}
      >
        <option value="auto">${text.rotateAuto}</option>
        <option value="false">${text.rotateNone}</option>
        <option value="true">${text.rotateQuarter}</option>
      </select></label
    >
    ${offsetSlider('x', text.offsetX, scan, actions)}
    ${offsetSlider('y', text.offsetY, scan, actions)}
    <p class="helper">
      ${
        scan.open
          ? fill(text.info, {
              floor: scan.floor.toFixed(2),
              triangles: scan.triangles,
              points: scan.points,
            })
          : text.reopen
      }
    </p>
  </fieldset>`;
}

function scanSection(room, text, actions) {
  return html`<section class="planning-room-source">
    <h3>${unsafeHTML(runModeBadgeHtml('data'))} ${text.title}</h3>
    ${text.steps.map((step) => html`<p>${step}</p>`)}
    <label class="planning-scan-open"
      >${text.open}<input
        data-scan-open
        type="file"
        accept=".ply,.obj,.glb"
        @change=${(event) => {
          actions.openScan(event.target.files[0]);
          event.target.value = '';
        }}
    /></label>
    ${room.scan.open || room.scan.shown ? scanSettings(room.scan, text, actions) : nothing}
    <p class="helper">${text.privacy}</p>
  </section>`;
}

function placeButtons(room, text, actions) {
  return html`<div class="planning-room-place">
    ${['start', 'goal'].map(
      (what) =>
        html`<button
          data-room-place=${what}
          aria-pressed=${String(room.placing === what)}
          ?disabled=${!room.ready}
          @click=${() => actions.startPlacing(what)}
        >
          ${text.placeButtons[what]}
        </button>`,
    )}
  </div>`;
}

// Measuring the room with the robot, or opening a phone's 3D scan of it (room topic only).
function roomCard(model, copy, actions) {
  if (model.topic !== 'room') return nothing;
  const text = copy.room;
  const room = model.room;
  return html`<section class="card planning-room">
    <h2>${text.title}</h2>
    <p>${text.intro}</p>
    ${robotSection(room, text, actions)}${scanSection(room, text.scan, actions)}
    ${placeButtons(room, text, actions)}
    ${room.note ? html`<p class="planning-room-note" role="status">${room.note}</p>` : nothing}
    <p class="helper">${text.limits}</p>
  </section>`;
}

export { roomCard };
