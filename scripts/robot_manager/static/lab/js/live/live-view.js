import { html, nothing } from '../vendor/lit-html.js';
import { loadJson, fillSentence as fill } from '../core/content.js';
import { revealElement } from '../core/reveal.js';
import { driveControls, notAllowedLine } from './drive-view.js';
import { setGroupName } from './capture.js';
import { recordsCopy } from './records-core.js';
import { liveStateStrip, robotStatePanel } from './robot-state.js';

// The one block of controls a lesson shows when it can take measurements from the real robot.
// Pure templates — the lesson owns the state (live-session.js) and passes `actions`. Sentences live
// in content/live/capture.json. From the top:
// 1. what the learner does now: 教材から実機を走らせる (drive-view.js) when the page may drive, or
//    the record button otherwise, with the compact live strip right under the button
//    (robot-state.js liveStateStrip) and the result of the last run under that;
// 2. folded, 「実機の状態をくわしく見る」: the full panel, for a session created with `state`;
// 3. folded, 「記録ファイルと保存」: 記録だけする (while the page may drive), opening a file or a
//    record of the robot, drawing other recordings over this one (a lesson with `compare`),
//    班の名前 and the saves — every file and record action of the block in one place.
// Offline, 1. is one line with the way to connect; 3. stays (a class without a robot opens files).

const captureCopy = await loadJson('content/live/capture.json');

const streamLabel = (name) => captureCopy.streamNames[name] ?? name;
// Room kept above the stop bar (css/live.css .drive-bar) when a run area is brought on screen.
const STOP_BAR_ROOM = 96; // px

// While the page may drive the robot, the controller is off, so /target_twist only flows while
// someone drives: not receiving it then is normal, not a fault worth a warning.
function missingNow(model) {
  if (!drivingAllowed(model)) return model.link.missing;
  return model.link.missing.filter((name) => name !== 'twist');
}

const drivingAllowed = (model) => Boolean(model.drive?.allowed && model.link.connected);
// A driving run (or its tail) owns the block's buttons until it is over.
const driveBusy = (model) => model.running || model.tail;
// The record button is the block's main action unless the page may drive (then 記録だけする is
// folded with the files) — or while a recording it started runs, so its stop stays in view.
const recordIsMain = (model) => !drivingAllowed(model) && !driveBusy(model);

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

const progressLine = (model) =>
  model.recording && !driveBusy(model)
    ? html`<p class="live-capture-progress" role="status">
        ${fill(captureCopy.progress, { count: model.progress })}
      </p>`
    : nothing;

/** The strip under a block's button: the session's slot names it, `state.status` its line. */
const stripFor = (model) =>
  model.link.connected
    ? liveStateStrip(model.slot ?? 'live', { status: model.state?.status })
    : nothing;

// --- the result of the last run or recording, in one place ------------------------------------

// Whether the finished run (or recording) was also kept on the robot (live-session robotSave).
function robotSaveLine(model) {
  const save = model.robotSave;
  if (!save?.message) return nothing;
  return html`<p
    class="live-robot-save ${save.state}"
    role=${save.state === 'failed' ? 'alert' : 'status'}
    data-live-robot-save=${save.state}
  >
    ${save.message}
    ${
      save.state === 'saved'
        ? html`<button
            class="text-button"
            data-live-records
            @click=${() => {
              location.hash = '#records';
            }}
          >
            ${recordsCopy.save.openList}
          </button>`
        : nothing
    }
  </p>`;
}

/**
 * How the last run ended (`driveNote`), what the lesson made of it (`message`) and whether the
 * robot kept it, as one box under the button: each fact once.
 */
function resultBox(model) {
  const ended = model.driveNote && !driveBusy(model) ? model.driveNote : '';
  if (!ended && !model.message && !model.robotSave?.message) return nothing;
  return html`<div class="live-result" data-live-result>
    ${ended ? html`<p class="drive-result" role="status" data-drive-result>${ended}</p>` : nothing}
    ${
      model.message
        ? html`<p class="live-capture-message" role="status" data-live-message>${model.message}</p>`
        : nothing
    }
    ${robotSaveLine(model)}
  </div>`;
}

// --- 記録ファイルと保存 ---------------------------------------------------------------------------

function openFileControl(model, actions) {
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

// One picker for the robot's records; with a lesson that compares, each record offers 開く and
// 重ねる there (record-picker.js). Only while connected: the records are on the robot.
function pickControl(model, actions) {
  if (!actions.pickRobotRecord || !model.link.connected) return nothing;
  return html`<button
    class="live-capture-pick"
    data-live-pick
    ?disabled=${model.recording}
    @click=${actions.pickRobotRecord}
  >
    ${model.compare ? captureCopy.file.pickBoth : captureCopy.file.pick}
  </button>`;
}

// Other groups' recordings drawn over this one (a session created with `compare`).
function compareControls(model, actions) {
  const compare = model.compare;
  if (!compare || !actions.addComparisons) return nothing;
  const text = captureCopy.compare;
  return html`<div class="live-compare" data-live-compare-part>
    <label class="live-capture-open"
      >${text.open}
      <input
        data-live-compare
        type="file"
        multiple
        accept=".json,.mcap,application/json"
        @change=${(event) => {
          actions.addComparisons(event.target.files);
          event.target.value = '';
        }}
    /></label>
    ${
      compare.count
        ? html`<button data-live-compare-clear @click=${actions.clearComparisons}>
            ${fill(text.clear, { count: compare.count })}
          </button>`
        : nothing
    }
    ${compare.help ? html`<p class="live-capture-note">${compare.help}</p>` : nothing}
    ${compare.note ? html`<p role="status" data-live-compare-note>${compare.note}</p>` : nothing}
  </div>`;
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

function saveButtons(model, actions) {
  const text = captureCopy.file;
  return html`<div class="live-capture-actions">
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
  </div>`;
}

// 記録だけする, inside the files while the page may drive (its stop and progress stay with it).
function recordOnlyPart(model, actions) {
  if (!drivingAllowed(model) || driveBusy(model)) return nothing;
  return html`<div class="live-record-only">
    <div class="live-capture-actions">${recordButton(model, actions)}</div>
    ${progressLine(model)}
    <p class="live-capture-note">${captureCopy.recordOtherNote}</p>
  </div>`;
}

function filesSection(model, actions) {
  if (!model.file) return nothing;
  const text = captureCopy.file;
  return html`<details class="live-files" data-live-files>
    <summary>
      ${text.section}<span class="live-files-hint"
        >${model.link.connected ? text.sectionHint : text.sectionHintOffline}</span
      >
    </summary>
    <div class="live-files-body">
      ${recordOnlyPart(model, actions)}
      <div class="live-capture-actions">
        ${openFileControl(model, actions)} ${pickControl(model, actions)}
      </div>
      ${compareControls(model, actions)} ${groupField(model, actions)}
      ${saveButtons(model, actions)}
      <p class="live-capture-note">${text.note} ${text.share}</p>
    </div>
  </details>`;
}

// --- the parts of the block -----------------------------------------------------------------------

function captureNote(model) {
  if (!model.drive) return captureCopy.readOnly;
  return captureCopy.recordOnly;
}

function linkLine(model) {
  const missing = missingNow(model);
  if (missing.length)
    return html`<p class="live-capture-state warn" data-live-state>
      ${fill(captureCopy.missing, { streams: missing.map(streamLabel).join('と') })}
    </p>`;
  if (!recordIsMain(model)) return nothing;
  return html`<p class="live-capture-state" data-live-state>
    ${captureCopy.state[model.link.phase] ?? captureCopy.state.idle}
  </p>`;
}

// The record button as the block's main action (no driving here, or the teacher stopped it).
function recordPart(model, actions) {
  return html`<div class="live-capture" data-live-capture>
    <div class="live-run" data-live-run>
      <div class="live-capture-actions">${recordButton(model, actions)}</div>
      ${progressLine(model)} ${stripFor(model)}
    </div>
    ${resultBox(model)}
    <p class="live-capture-note">${captureNote(model)}</p>
  </div>`;
}

function statePart(model) {
  const state = model.state;
  if (!state || !model.link.connected) return nothing;
  return robotStatePanel(state.place, {
    name: state.name,
    placeholder: state.placeholder,
    status: state.status,
    hideOffline: true,
    folded: true,
  });
}

// Without a robot: one line with the way to connect, the result of what was opened, the files.
function offlineBlock(model, actions) {
  return html`<div class="live-block live-block-off" data-live-block=${model.slot ?? ''}>
    <p class="live-offline-line" data-live-offline>
      <span>${captureCopy.offlineLine}</span>
      ${
        actions.openLink
          ? html`<button class="small" data-live-connect @click=${actions.openLink}>
              ${captureCopy.connect}
            </button>`
          : nothing
      }
    </p>
    ${resultBox(model)} ${filesSection(model, actions)}
  </div>`;
}

/**
 * `model` is live-session's `model()`: `{ link: {connected, phase, missing}, recording, progress,
 * seconds, message, slot, state, compare, file: {canSave, group}, drive, … }`. `actions` needs
 * `startCapture` and `stopCapture` (and, with `file`, `saveRecording` and `openRecording`;
 * `pickRobotRecord`, `addComparisons`, `clearComparisons` and `setGroup` when offered); `openLink`
 * is optional and, when given, adds the shortcut to the connection dialog. With `drive`
 * (live-session's drive part) the block offers driving the robot (drive-view.js), which needs
 * `startDriveCapture` and `confirmDrive` in `actions`.
 */
function liveCaptureControls(model, actions) {
  const busy = model.recording || driveBusy(model);
  if (!model.link.connected && !busy) return offlineBlock(model, actions);
  const driving = drivingAllowed(model) || driveBusy(model);
  let main;
  if (driving)
    main = driveControls(model, model.drive, actions, {
      strip: stripFor(model),
      result: resultBox(model),
    });
  else
    main = html`${model.drive ? notAllowedLine(model.drive) : nothing}${recordPart(model, actions)}`;
  return html`<div class="live-block" data-live-block=${model.slot ?? ''}>
    ${linkLine(model)} ${main} ${statePart(model)} ${filesSection(model, actions)}
  </div>`;
}

/**
 * Press → see, the same in every course: once a run or a recording starts, the block's button and
 * the live strip under it (`[data-live-run]` of the block of `slot`) are brought on screen, clear
 * of the header and of the stop bar at the bottom. Nothing moves when they are already in view.
 */
function revealLiveRun(slot) {
  requestAnimationFrame(() => {
    const block = document.querySelector(`[data-live-block="${CSS.escape(slot)}"]`);
    const run = block?.querySelector('[data-live-run]');
    if (!run) return;
    const box = run.getBoundingClientRect();
    const header = document.querySelector('.site-header');
    const headerBottom = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
    if (box.top >= headerBottom && box.bottom <= window.innerHeight - STOP_BAR_ROOM) return;
    revealElement(run);
  });
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

export { liveCaptureControls, captureNotes, captureCopy, revealLiveRun };
