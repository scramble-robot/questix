import { html, render } from '../vendor/lit-html.js';
import { loadJson } from '../core/content.js';
import { robotState, onRobot } from './robot-link.js';
import { driveModel, onDrive, stopDrive } from './drive-link.js';
import { shootModel, onShoot, stopLauncher } from './shoot-link.js';
import { activeLiveDialog, onLiveStatus } from './live-status.js';

const copy = await loadJson('content/live/stop-bar.json');
let reserved = false;
function drawStopBar() {
  const open = robotState().phase === 'open';
  reserved ||= open;
  const host = document.getElementById('liveStopBar');
  if (!host) return;
  document.body.classList.toggle('live-stop-reserved', reserved);
  host.hidden = !reserved;
  const parent = activeLiveDialog() ?? document.body;
  if (host.parentElement !== parent) parent.append(host);
  if (!reserved) return;
  const drive = driveModel();
  const shoot = shootModel();
  const moving = drive.active || drive.running;
  const spinning = shoot.spinning || (shoot.active && shoot.power > 0);
  const key = !open
    ? 'unknown'
    : moving && spinning
      ? 'both'
      : moving
        ? 'drive'
        : spinning
          ? 'shoot'
          : 'idle';
  render(
    html`<div class="live-stop-bar">
      <p class="live-stop-state" role="status">${copy[key]}</p>
      <div class="live-stop-actions">
        <button
          class="drive-bar-stop"
          data-live-stop="drive"
          ?disabled=${!open}
          @click=${stopDrive}
        >
          ${copy.stopDrive}
        </button>
        <button
          class="drive-bar-stop"
          data-live-stop="shoot"
          ?disabled=${!open}
          @click=${stopLauncher}
        >
          ${copy.stopShoot}
        </button>
      </div>
    </div>`,
    host,
  );
}
for (const type of ['state', 'drive_state', 'shoot_state']) onRobot(type, drawStopBar);
onDrive(drawStopBar);
onShoot(drawStopBar);
onLiveStatus(drawStopBar);
new MutationObserver(drawStopBar).observe(document.body, {
  subtree: true,
  attributeFilter: ['open'],
});
drawStopBar();
