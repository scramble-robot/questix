import { render } from '../vendor/lit-html.js';
import { loadJson } from '../core/content.js';
import { downloadFile } from '../core/dom.js';
import { UsbLidar } from './usb-serial.js';
import { drawUsbGrid, drawUsbMap, drawUsbScan } from './usb-render.js';
import { usbView } from './usb-view.js';

const copy = await loadJson('content/slam/usb.json');
const STALE_MS = 2500;
let host;
let lidar;
let worker;
let busy = false;
let timer;
let lastScan = 0;
let connecting;
const model = {
  secure: window.isSecureContext,
  supported: window.isSecureContext && !!navigator.serial,
  connection: 'idle',
  status: 'idle',
  mapping: false,
  points: [],
  snapshot: null,
  spanMetres: 8,
};

function update() {
  if (!host) return;
  render(usbView(model, copy, actions), host);
  drawUsbMap(host.querySelector('#usbMapCanvas'), model.snapshot, model.spanMetres);
  drawUsbScan(host.querySelector('#usbScanCanvas'), model.points);
}
function pause() {
  model.mapping = false;
  worker?.terminate();
  worker = null;
  busy = false;
}
function gotScan(points) {
  if (model.connection !== 'ready') return;
  model.points = points;
  lastScan = performance.now();
  if (model.mapping && !busy) {
    busy = true;
    worker.postMessage(points);
  }
  update();
}
async function disconnect(status = 'stopped') {
  pause();
  clearInterval(timer);
  model.connection = 'closing';
  model.status = status;
  update();
  await lidar?.close();
  // Do not allow another chooser until a cancelled chooser/open has settled.
  try {
    await connecting;
  } catch {
    /* connect reports cancellation or errors. */
  }
  lidar = null;
  model.connection = 'idle';
  model.points = [];
  update();
}
async function connect() {
  if (model.connection !== 'idle') return;
  model.connection = 'connecting';
  model.status = 'connecting';
  lidar = new UsbLidar(navigator.serial, gotScan, () => {
    void disconnect('failed');
  });
  connecting = lidar.connect();
  update();
  try {
    await connecting;
    model.connection = 'ready';
    model.status = 'receiving';
    lastScan = performance.now();
    timer = setInterval(() => {
      if (performance.now() - lastScan > STALE_MS) void disconnect('stale');
    }, 500);
  } catch (error) {
    if (error.name !== 'AbortError') {
      model.status = error.name === 'NotFoundError' ? 'cancelled' : 'failed';
      if (error.message === 'wrongModel') model.status = 'wrongModel';
    }
    model.connection = 'idle';
  } finally {
    connecting = null;
    update();
  }
}
function start() {
  if (model.connection !== 'ready' || !model.points.length) return;
  pause();
  model.snapshot = null;
  model.mapping = true;
  model.status = 'mapping';
  const current = new Worker(new URL('./usb-worker.js', import.meta.url), { type: 'module' });
  worker = current;
  current.onmessage = ({ data }) => {
    if (worker !== current || !model.mapping) return;
    busy = false;
    model.snapshot = data;
    model.status = data.result.reason ?? 'mapping';
    update();
  };
  current.onerror = () => {
    pause();
    model.status = 'workerError';
    update();
  };
  gotScan(model.points);
}
const actions = {
  setSpan(event) {
    model.spanMetres = Number(event.target.value);
    update();
  },
  connect,
  start,
  disconnect: () => {
    void disconnect();
  },
  pause: () => {
    pause();
    model.status = 'stopped';
    update();
  },
  savePng() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = model.snapshot.size;
    drawUsbGrid(canvas, model.snapshot);
    canvas.toBlob((blob) => {
      if (blob) downloadFile('T-mini-Plus-map.png', blob, 'image/png');
    });
  },
  saveJson() {
    const snapshot = model.snapshot;
    downloadFile(
      'T-mini-Plus-map.json',
      JSON.stringify({
        format: 'questix-browser-lidar-map-v1',
        createdAt: new Date().toISOString(),
        sensor: 'YDLIDAR T-mini Plus',
        algorithm: 'local point-to-line ICP; no loop closure',
        resolution: snapshot.resolution,
        width: snapshot.size,
        height: snapshot.size,
        origin: [-16, -16],
        gridRowOrder: 'top-to-bottom (+y to -y)',
        gridEncoding: 'signed evidence: negative free, positive occupied, zero unknown',
        grid: Array.from(snapshot.grid),
        pose: snapshot.pose,
        path: snapshot.path,
        accepted: snapshot.accepted,
        rejected: snapshot.rejected,
      }),
      'application/json',
    );
  },
};
export function mountUsb(element) {
  host = element;
  update();
}
export function stopUsb() {
  if (model.connection !== 'idle' && model.connection !== 'closing') void disconnect();
  else {
    pause();
    update();
  }
}
window.addEventListener('pagehide', stopUsb);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopUsb();
});
