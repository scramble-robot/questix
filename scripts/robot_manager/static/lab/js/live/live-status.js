import { html, render } from '../vendor/lit-html.js';
import { loadJson } from '../core/content.js';
import { onRobot, robotState, linkStage } from './robot-link.js';
import { createDisplayTiming, observeDisplayTiming, displayTimingModel } from './display-timing.js';
import { liveStatusModel } from './live-status-core.js';
import { liveStatusLine } from './live-status-view.js';
import { labStopButton } from './stop-control.js';
const copy = await loadJson('content/live/link.json');
const received = {};
let timing = createDisplayTiming();
const listeners = new Set();
const dialogOrder = [];
const dialogHosts = new Map();
let lastModel = '';
// Display consumers read this exact snapshot; only drawStatuses evaluates receive-time expiry.
let currentModel;
function liveStatus() {
  return currentModel;
}
function activeLiveDialog() {
  for (const dialog of document.querySelectorAll('dialog[open]'))
    if (!dialogOrder.includes(dialog)) dialogOrder.push(dialog);
  for (let i = dialogOrder.length - 1; i >= 0; i--)
    if (!dialogOrder[i].open || !dialogOrder[i].isConnected) dialogOrder.splice(i, 1);
  return dialogOrder.at(-1) ?? null;
}
function drawStatuses() {
  const link = robotState();
  const now = performance.now();
  const transport = displayTimingModel(timing, now);
  const model = (currentModel = {
    ...liveStatusModel(link, received, now, transport),
    stage:
      link.phase === 'open' && ['checking', 'delayed'].includes(transport.mode)
        ? transport.mode
        : linkStage(link),
  });
  const active = activeLiveDialog();
  const header = document.getElementById('liveHeaderStatus');
  if (header) {
    header.setAttribute('aria-live', active ? 'off' : 'polite');
    render(liveStatusLine(model, copy, true), header);
  }
  for (const dialog of document.querySelectorAll('dialog')) {
    let host = dialogHosts.get(dialog);
    if (dialog.open && (!host || host.parentElement !== dialog)) {
      host = document.createElement('div');
      host.className = 'live-dialog-header';
      dialog.prepend(host);
      dialogHosts.set(dialog, host);
    }
    if (host) {
      render(
        html`<div class="live-dialog-stop-row">${labStopButton()}</div>
          <div
            class="live-status-line"
            role="status"
            aria-live=${dialog === active ? 'polite' : 'off'}
          >
            ${liveStatusLine(model, copy)}
          </div>`,
        host,
      );
    }
  }
  const key = JSON.stringify(model);
  if (key !== lastModel) {
    lastModel = key;
    for (const listener of listeners) listener(model);
  }
}
function onLiveStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
for (const type of ['estop', 'drive_state', 'shoot_state'])
  onRobot(type, (message) => {
    const now = performance.now();
    if (type === 'estop') observeDisplayTiming(timing, message, now);
    received[type] = { message, at: now };
    drawStatuses();
  });
onRobot('state', (link) => {
  if (link.phase !== 'open') {
    timing = createDisplayTiming();
    for (const key of Object.keys(received)) delete received[key];
  }
  drawStatuses();
});
new MutationObserver((records) => {
  for (const { target } of records) {
    if (!target.matches('dialog')) continue;
    const index = dialogOrder.indexOf(target);
    if (index >= 0) dialogOrder.splice(index, 1);
    if (target.open) dialogOrder.push(target);
  }
  drawStatuses();
}).observe(document.body, { subtree: true, attributeFilter: ['open'] });
setInterval(drawStatuses, 100);
drawStatuses();
export { liveStatus, onLiveStatus, activeLiveDialog };
