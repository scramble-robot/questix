import { html, nothing, render } from '../vendor/lit-html.js';
import { driveModel, onDrive, confirmDriveSafety, stopDrive, runDrive } from './drive-link.js';
import { driveCopy, driveChecklist, confirmBox, driveEndedText } from './drive-view.js';

// Two pieces of the driving experiments that belong to no lesson:
// - the stop bar, fixed at the bottom of every page while the robot drives on a lesson's command —
//   this page's or another one's — so a stop is always one tap (or Esc) away;
// - the bench test in the 実機 dialog: hold a button and the robot moves slowly, release and it stops,
//   for checking wheel directions and left/right after assembly.

const BENCH_DEFAULTS = { linear: 0.1, angular: 0.5 }; // m/s, rad/s
const BENCH_MIN = { linear: 0.06, angular: 0.3 }; // below drive_component's dead band (drive-core)
const BENCH_STEP = { linear: 0.02, angular: 0.1 };
const BENCH_MAX_SECONDS = 20; // one press; the bridge's own limit is longer
const BENCH_MOVES = [
  { id: 'forward', linear: 1, angular: 0 },
  { id: 'left', linear: 0, angular: 1 },
  { id: 'right', linear: 0, angular: -1 },
  { id: 'backward', linear: -1, angular: 0 },
];

const bench = { ...BENCH_DEFAULTS, held: null, abort: null, note: '' };

// --- stop bar --------------------------------------------------------------------------------

function stopBar(model) {
  if (!model.active && !model.running) return nothing;
  const mine = model.running || model.owner === 'me';
  return html`<div class="drive-bar" role="alert" data-drive-bar>
    <span class="drive-bar-dot" aria-hidden="true"></span>
    <strong>${mine ? driveCopy.bar.mine : driveCopy.bar.other}</strong>
    <button class="drive-bar-stop" data-drive-bar-stop @click=${stopDrive}>
      ${driveCopy.bar.stop}
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
  const result = await runDrive({
    controller: () => ({
      linear: move.linear * bench.linear,
      angular: move.angular * bench.angular,
    }),
    seconds: BENCH_MAX_SECONDS,
    signal: abort.signal,
  });
  Object.assign(bench, { held: null, abort: null });
  // Releasing the button is the normal end of a bench move; anything else is worth a sentence.
  bench.note =
    result.reason === 'stopped' || result.reason === 'done' ? '' : driveEndedText(result);
  update();
}

function release() {
  bench.abort?.abort();
}

function benchButton(model, move) {
  const disabled = !model.ready || (bench.held !== null && bench.held !== move.id);
  return html`<button
    class="drive-bench-move ${bench.held === move.id ? 'held' : ''}"
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
  return html`<h3>${driveCopy.bench.title}</h3>
    <p>${driveCopy.bench.lead}</p>
    ${driveChecklist(model)} ${confirmBox(model, { confirmDrive: confirmDriveSafety })}
    <div class="drive-bench-speeds">
      ${speedSlider(model, 'linear', driveCopy.bench.speed)}
      ${speedSlider(model, 'angular', driveCopy.bench.turnSpeed)}
    </div>
    <div class="drive-bench-pad">${BENCH_MOVES.map((move) => benchButton(model, move))}</div>
    ${bench.note ? html`<p class="drive-note" role="status">${bench.note}</p>` : nothing}
    <p class="drive-note">${driveCopy.afterNote}</p>`;
}

// A modal dialog sits in the browser's top layer, above any z-index, so the bar moves into the open
// dialog (where position: fixed still means the viewport) and back to the page when it closes.
function placeStopBar() {
  const host = document.getElementById('driveBar');
  const dialogs = [...document.querySelectorAll('dialog[open]')];
  const parent = dialogs.at(-1) ?? document.body;
  if (host.parentElement !== parent) parent.append(host);
}

function update() {
  const model = driveModel();
  placeStopBar();
  render(stopBar(model), document.getElementById('driveBar'));
  const panel = document.getElementById('robotDrive');
  // Driving needs a connection; before that the dialog is about connecting.
  panel.hidden = model.blockers.some((blocker) => blocker.code === 'no_link');
  render(panel.hidden ? nothing : benchPanel(model), panel);
}

function initDriveUi() {
  onDrive(update);
  new MutationObserver(placeStopBar).observe(document.body, {
    subtree: true,
    attributeFilter: ['open'],
  });
  update();
}

initDriveUi();

export { initDriveUi };
