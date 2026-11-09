import { html, render } from '../vendor/lit-html.js';
import { loadJson } from '../core/content.js';
import { robotState, onRobot } from './robot-link.js';
import { stopDrive } from './drive-link.js';
import { stopLauncher } from './shoot-link.js';

const copy = await loadJson('content/live/stop-control.json');
let reserved = false;

// Deliberately independent of ownership, activity, permissions and received status.
// Each existing sender keeps its own bridge contract; no tilt command is sent here.
function stopLabMotion() {
  try {
    stopDrive();
  } finally {
    stopLauncher();
  }
}

function labStopButton() {
  const open = robotState().phase === 'open';
  reserved ||= open;
  return html`<button
    type="button"
    class="lab-stop"
    data-lab-stop
    ?hidden=${!reserved}
    ?disabled=${!open}
    aria-label=${copy.description}
    title=${copy.description}
    @click=${stopLabMotion}
  >
    ${copy.label}
  </button>`;
}

function drawHeaderStop() {
  const host = document.getElementById('labHeaderStop');
  if (host) render(labStopButton(), host);
}
onRobot('state', drawHeaderStop);
drawHeaderStop();

export { labStopButton, stopLabMotion };
