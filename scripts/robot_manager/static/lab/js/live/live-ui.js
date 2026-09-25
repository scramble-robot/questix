import {
  DEFAULT_PORT,
  onRobot,
  robotState,
  latestRobot,
  linkStage,
  defaultRobotUrl,
  connectRobot,
  disconnectRobot,
} from './robot-link.js';
import { wheelRpm } from './slam-recorder.js';
import { scanMount } from './capture-core.js';
import { loadJson, fillSentence } from '../core/content.js';
import { html, render, nothing } from '../vendor/lit-html.js';

const copy = await loadJson('content/live/link.json');

// Header button and "実機" dialog. Drawing only happens while the dialog is open.
const $ = (id) => document.getElementById(id);
const STREAM_LABEL = {
  scan: 'LiDAR',
  odom: '位置の見積もり',
  drive: '車輪',
  twist: '速度の指令',
  camera: 'カメラ',
};
// The dialog's own table of contents: nav key → section id (drive-ui.js renders the last two).
const DIALOG_SECTIONS = [
  ['monitor', 'robotMonitor'],
  ['drive', 'robotDrive'],
  ['log', 'robotDriveLog'],
];
const HISTORY_SECONDS = 10;
const TWIST_FRESH_SECONDS = 1; // an older command no longer describes what the robot was asked to do
const COLORS = {
  left: '#1c756b',
  right: '#a65a32',
  grid: '#dde5e1',
  muted: '#667975',
  point: '#7bdec3',
  dark: '#102832',
};

let history = [];
let estopPressed = false; // from the latest /drive_status, shown next to the header's dot
let cameraUrl = '';
let frameRequested = false;
let addressProblem = ''; // the sentence normalizeRobotUrl threw for the typed address

function prepare(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const c = canvas.getContext('2d');
  c.setTransform(ratio, 0, 0, ratio, 0, 0);
  c.clearRect(0, 0, width, height);
  return { c, width, height };
}

function scanNote(scan) {
  if (!scan) return copy.monitor.scanNone;
  const measured = scan.ranges.filter((r) => r !== null).length;
  return fillSentence(copy.monitor.scanCount, { measured, total: scan.ranges.length });
}

// Robot-centred top view: forward is up, left is left (REP-103 seen from above).
function drawScan() {
  const { c, width, height } = prepare($('robotScan'));
  const scan = latestRobot('scan');
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - 14;
  c.fillStyle = COLORS.dark;
  c.fillRect(0, 0, width, height);
  const limit = scan
    ? Math.min(
        scan.range_max,
        Math.max(2, Math.ceil(Math.max(0, ...scan.ranges.filter((r) => r !== null)))),
      )
    : 4;
  const scale = radius / limit;
  c.strokeStyle = '#365059';
  c.fillStyle = '#a9c0c5';
  c.font = '11px system-ui';
  c.lineWidth = 1;
  for (let ring = 1; ring <= limit; ring += Math.max(1, Math.ceil(limit / 4))) {
    c.beginPath();
    c.arc(cx, cy, ring * scale, 0, 2 * Math.PI);
    c.stroke();
    c.fillText(ring + ' m', cx + 4, cy - ring * scale - 3);
  }
  if (scan) {
    // Points are placed from where the LiDAR sits on the robot, so the centre is the robot's.
    const mount = scanMount(scan);
    c.fillStyle = COLORS.point;
    scan.ranges.forEach((r, i) => {
      if (r === null) return;
      const a = mount.yaw + scan.angle_min + i * scan.angle_increment;
      const x = mount.x + Math.cos(a) * r; // forward
      const y = mount.y + Math.sin(a) * r; // left
      c.fillRect(cx - y * scale - 1.5, cy - x * scale - 1.5, 3, 3);
    });
  }
  c.fillStyle = '#f0c86a';
  c.beginPath();
  c.moveTo(cx, cy - 9);
  c.lineTo(cx + 6, cy + 6);
  c.lineTo(cx - 6, cy + 6);
  c.closePath();
  c.fill();
  $('robotScanNote').textContent = scanNote(scan);
}

// 「左」「右」 at the right end of the measured lines, moved apart when the two wheels agree.
const WHEEL_LABEL_GAP = 14; // px
function wheelEndLabels(c, y, width, pad) {
  const last = history[history.length - 1];
  if (!last) return;
  const ends = [
    ['left', last.left, copy.monitor.wheelLeft],
    ['right', last.right, copy.monitor.wheelRight],
  ].filter(([, value]) => Number.isFinite(value));
  const tops = ends.map(([, value]) => y(value));
  if (tops.length === 2 && Math.abs(tops[0] - tops[1]) < WHEEL_LABEL_GAP) {
    const middle = (tops[0] + tops[1]) / 2;
    const upper = ends[0][1] >= ends[1][1] ? 0 : 1;
    tops[upper] = middle - WHEEL_LABEL_GAP / 2;
    tops[1 - upper] = middle + WHEEL_LABEL_GAP / 2;
  }
  c.font = '600 12px system-ui';
  c.textBaseline = 'middle';
  ends.forEach(([side, , label], index) => {
    c.fillStyle = COLORS[side];
    c.fillText(label, width - pad.right + 4, tops[index]);
  });
  c.textBaseline = 'alphabetic';
}

function drawWheels() {
  const { c, width, height } = prepare($('robotWheels'));
  // The caption is HTML under the canvas (wheelCaption); the right margin holds 「左」「右」.
  const pad = { left: 38, right: 22, top: 10, bottom: 8 };
  const now = history.length ? history[history.length - 1].at : 0;
  const peak = Math.max(
    10,
    ...history
      .flatMap((h) => [h.left, h.right, h.targetLeft, h.targetRight])
      .filter(Number.isFinite)
      .map(Math.abs),
  );
  const top = Math.ceil(peak / 10) * 10;
  const x = (at) =>
    pad.left + (1 - (now - at) / (HISTORY_SECONDS * 1000)) * (width - pad.left - pad.right);
  const y = (v) => pad.top + (1 - (v + top) / (2 * top)) * (height - pad.top - pad.bottom);
  c.font = '12px system-ui';
  c.fillStyle = COLORS.muted;
  c.strokeStyle = COLORS.grid;
  c.lineWidth = 1;
  for (const v of [-top, 0, top]) {
    c.beginPath();
    c.moveTo(pad.left, y(v));
    c.lineTo(width - pad.right, y(v));
    c.stroke();
    c.fillText(String(v), 4, Math.min(height - 2, y(v) + 4));
  }
  for (const [key, side, dashed] of [
    ['targetLeft', 'left', true],
    ['targetRight', 'right', true],
    ['left', 'left', false],
    ['right', 'right', false],
  ]) {
    c.strokeStyle = COLORS[side];
    c.lineWidth = dashed ? 1.5 : 2;
    c.setLineDash(dashed ? [5, 4] : []);
    c.beginPath();
    let pen = false;
    for (const h of history) {
      if (!Number.isFinite(h[key])) {
        pen = false;
        continue;
      }
      if (pen) c.lineTo(x(h.at), y(h[key]));
      else c.moveTo(x(h.at), y(h[key]));
      pen = true;
    }
    c.stroke();
  }
  c.setLineDash([]);
  wheelEndLabels(c, y, width, pad);
}

// The wheel chart's caption as HTML under the canvas: canvas text would shrink with it on a phone.
function wheelCaption() {
  const figure = $('robotWheels').closest('figure');
  let caption = figure.querySelector('.robot-wheels-note');
  if (!caption) {
    caption = document.createElement('p');
    caption.className = 'robot-wheels-note';
    figure.append(caption);
  }
  caption.textContent = fillSentence(copy.monitor.wheels, { seconds: HISTORY_SECONDS });
}

function estopText(drive) {
  if (!drive) return '—';
  return drive.emergency_stop ? copy.monitor.estopPressed : copy.monitor.estopReleased;
}
function readings() {
  const odom = latestRobot('odom');
  const drive = latestRobot('drive');
  const twist = latestRobot('twist');
  const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  $('robotPose').textContent = odom
    ? `x ${f(odom.x)} m · y ${f(odom.y)} m · 向き ${f((odom.theta * 180) / Math.PI, 0)}°`
    : '—';
  $('robotSpeed').textContent = drive ? `前後 ${f(drive.v)} m/s · 回転 ${f(drive.w)} rad/s` : '—';
  $('robotCommand').textContent = twist
    ? `前後 ${f(twist.linear)} m/s · 回転 ${f(twist.angular)} rad/s`
    : '—';
  $('robotEstop').textContent = estopText(drive);
}

// The canvases have no size while the monitor section is hidden, so there is nothing to draw on yet.
function redraw() {
  frameRequested = false;
  if (!$('robotDialog').open || $('robotMonitor').hidden) return;
  drawScan();
  drawWheels();
  readings();
}
function requestRedraw() {
  if (frameRequested || !$('robotDialog').open) return;
  frameRequested = true;
  requestAnimationFrame(redraw);
}

// The robot's name as the bridge announces it; bridges older than the `robot` field send none.
const robotName = (hello) =>
  typeof hello?.robot?.name === 'string' ? hello.robot.name.trim() : '';
const domainText = (domain) =>
  Number.isInteger(domain) ? String(domain) : copy.identity.domainUnset;

function identityView(hello) {
  const rows = [];
  if (robotName(hello)) rows.push([copy.identity.robot, robotName(hello)]);
  if (hello.robot) rows.push([copy.identity.domain, domainText(hello.robot.domain)]);
  const driving =
    hello.read_only === false ? copy.identity.driveAllowed : copy.identity.driveReadOnly;
  rows.push([copy.identity.drive, driving]);
  return html`<dl class="robot-identity">
    ${rows.map(
      ([term, value]) =>
        html`<div>
          <dt>${term}</dt>
          <dd>${value}</dd>
        </div>`,
    )}
  </dl>`;
}
function silentView(hello) {
  const sentence = hello.robot
    ? fillSentence(copy.silent, { domain: domainText(hello.robot.domain) })
    : copy.silentNoDomain;
  return html`<p class="robot-status-warn">${sentence}</p>`;
}
function statusSentence(state, stage) {
  if (state.message) return state.message;
  let host = state.url;
  try {
    host = new URL(state.url).hostname;
  } catch {
    /* no address yet */
  }
  return fillSentence(copy.status[stage] ?? '', { host });
}
function statusView(state, stage) {
  const open = state.phase === 'open';
  return html`${addressProblem ? html`<p class="robot-status-warn">${addressProblem}</p>` : nothing}
    <p class="robot-status-line" data-stage=${stage}>
      <strong>${copy.stage[stage]}</strong><span>${statusSentence(state, stage)}</span>
    </p>
    ${open ? identityView(state.hello) : nothing}
    ${open && state.silent ? silentView(state.hello) : nothing}`;
}

function rateText(topic, hz) {
  if (!topic) return '—';
  if (!(hz > 0)) return copy.monitor.streamMissing;
  return fillSentence(copy.monitor.streamRate, { hz: hz.toFixed(1) });
}
function streamRows(state) {
  return Object.entries(state.hello.streams).map(
    ([name, topic]) =>
      html`<tr>
        <th>${STREAM_LABEL[name] || name}</th>
        <td>${topic ? html`<code>${topic}</code>` : copy.monitor.streamUnused}</td>
        <td>${rateText(topic, state.rates[name])}</td>
      </tr>`,
  );
}

function showHeader(state, stage) {
  const button = $('robotLinkOpen');
  button.dataset.phase = state.phase;
  button.dataset.stage = stage;
  const open = state.phase === 'open';
  const name = open ? robotName(state.hello) : '';
  $('robotLinkName').textContent = name;
  $('robotLinkName').hidden = !name;
  const estop = open && estopPressed;
  button.dataset.estop = String(estop);
  $('robotLinkState').textContent = copy.stage[stage] + (estop ? copy.estop.long : '');
  // A phone shows only this short word next to the dot (css/hs-shell.css).
  $('robotLinkState').dataset.short = estop ? copy.estop.short : copy.stageShort[stage];
}
// Until a link has worked, the address stays editable so a typo can be fixed while it retries.
function showForm(state, stage) {
  const linked = stage === 'open' || stage === 'reconnecting';
  $('robotUrl').disabled = linked;
  $('robotUrl').setAttribute('aria-invalid', addressProblem ? 'true' : 'false');
  $('robotConnect').hidden = linked;
  const stop = $('robotDisconnect');
  stop.hidden = state.phase === 'idle';
  stop.textContent = linked ? copy.buttons.disconnect : copy.buttons.cancel;
}
function resetMonitor() {
  history = [];
  if (cameraUrl) {
    URL.revokeObjectURL(cameraUrl);
    cameraUrl = '';
  }
  $('robotCamera').hidden = true;
  $('robotCameraNote').textContent = copy.monitor.cameraNone;
}

function showState(state) {
  const stage = linkStage(state);
  const open = state.phase === 'open';
  showHeader(state, stage);
  showForm(state, stage);
  $('robotStatus').dataset.stage = stage;
  render(statusView(state, stage), $('robotStatus'));
  $('robotMonitor').hidden = !open;
  render(open ? streamRows(state) : nothing, $('robotStreams'));
  if (!open) {
    resetMonitor();
    estopPressed = false;
  }
  requestRedraw();
}

// Buttons, not links: the location hash belongs to the lesson router.
function jumpTo(id) {
  const section = $(id);
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  section.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
  section.focus({ preventScroll: true });
}
function showDialogNav() {
  const visible = DIALOG_SECTIONS.filter(([, id]) => !$(id).hidden);
  const nav = $('robotDialogNav');
  nav.hidden = !visible.length;
  render(
    visible.map(
      ([key, id]) =>
        html`<button type="button" class="quiet" @click=${() => jumpTo(id)}>
          ${copy.nav[key]}
        </button>`,
    ),
    nav,
  );
}

// Lessons that offer a live measurement link here, so a learner who has not connected yet can
// reach the connection dialog without hunting for the header button.
function openRobotDialog() {
  $('robotDialog').showModal();
  showState(robotState());
  showDialogNav();
}

function submitAddress(event) {
  event.preventDefault();
  try {
    connectRobot($('robotUrl').value);
    addressProblem = '';
  } catch (error) {
    addressProblem = error.message;
  }
  showState(robotState());
}
function clearAddressProblem() {
  if (!addressProblem) return;
  addressProblem = '';
  showState(robotState());
}

function recordWheels(drive) {
  if (Boolean(drive.emergency_stop) !== estopPressed) {
    estopPressed = Boolean(drive.emergency_stop);
    const state = robotState();
    showHeader(state, linkStage(state));
  }
  const config = robotState().hello?.config;
  if (!config || !Number.isFinite(drive.v) || !Number.isFinite(drive.w)) return;
  // Both curves go through the same kinematics, so command and measurement share one sign convention
  // (the raw per-wheel RPM cannot be compared directly: the right motor is mirrored on the wire).
  const rpm = wheelRpm(drive, config);
  const twist = latestRobot('twist');
  const target =
    twist &&
    drive.stamp - twist.stamp < TWIST_FRESH_SECONDS &&
    Number.isFinite(twist.linear) &&
    Number.isFinite(twist.angular)
      ? wheelRpm({ v: twist.linear, w: twist.angular }, config)
      : { left: NaN, right: NaN };
  const at = performance.now();
  history.push({
    at,
    left: rpm.left,
    right: rpm.right,
    targetLeft: target.left,
    targetRight: target.right,
  });
  while (history.length && at - history[0].at > HISTORY_SECONDS * 1000) history.shift();
  requestRedraw();
}
function showCamera(blob) {
  if (!$('robotDialog').open) return;
  const next = URL.createObjectURL(blob);
  const image = $('robotCamera');
  image.onload = () => {
    if (cameraUrl) URL.revokeObjectURL(cameraUrl);
    cameraUrl = next;
  };
  image.src = next;
  image.hidden = false;
  $('robotCameraNote').textContent = copy.monitor.cameraLive;
}

function wireDialog() {
  $('robotUrl').value = defaultRobotUrl();
  $('robotUrl').oninput = clearAddressProblem;
  $('robotLinkOpen').onclick = openRobotDialog;
  $('robotClose').onclick = () => $('robotDialog').close();
  $('robotForm').onsubmit = submitAddress;
  $('robotDisconnect').onclick = disconnectRobot;
  $('robotDialogNav').setAttribute('aria-label', copy.nav.label);
  // drive-ui.js shows and hides its sections on its own schedule; follow them.
  const observer = new MutationObserver(showDialogNav);
  for (const [, id] of DIALOG_SECTIONS) observer.observe($(id), { attributeFilter: ['hidden'] });
}

function initLive() {
  wireDialog();
  wheelCaption();
  onRobot('state', showState);
  onRobot('scan', requestRedraw);
  onRobot('odom', requestRedraw);
  onRobot('twist', requestRedraw);
  onRobot('drive', recordWheels);
  onRobot('camera', showCamera);
  showState(robotState());
  showDialogNav();
  // Served by the bridge itself (http://<robot>:8897/): the robot is this very host, so connect right away.
  // Listening is harmless; only drive-link.js ever sends, and only after its own checks.
  if (location.protocol === 'http:' && location.port === String(DEFAULT_PORT)) {
    try {
      connectRobot(`ws://${location.host}`);
    } catch {
      /* the dialog still allows a manual connection */
    }
  }
}

initLive();

export { initLive, openRobotDialog };
