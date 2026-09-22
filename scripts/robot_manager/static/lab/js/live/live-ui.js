import {
  DEFAULT_PORT,
  onRobot,
  robotState,
  latestRobot,
  defaultRobotUrl,
  connectRobot,
  disconnectRobot,
} from './robot-link.js';
import { wheelRpm } from './slam-recorder.js';
import { scanMount } from './capture-core.js';

// Header button and "実機モニター" dialog. Drawing only happens while the dialog is open.
const $ = (id) => document.getElementById(id);
const PHASE_LABEL = { idle: '未接続', connecting: '接続中…', open: '接続中', error: '再接続中…' };
const STREAM_LABEL = {
  scan: 'LiDAR',
  odom: '位置の見積もり',
  drive: '車輪',
  twist: '速度の指令',
  camera: 'カメラ',
};
const HISTORY_SECONDS = 10;
const TWIST_FRESH_SECONDS = 1; // an older command no longer describes what the robot was asked to do
const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (ch) => '&#' + ch.charCodeAt(0) + ';');
const COLORS = {
  left: '#1c756b',
  right: '#a65a32',
  grid: '#dde5e1',
  muted: '#667975',
  point: '#7bdec3',
  dark: '#102832',
};

let history = [];
let cameraUrl = '';
let frameRequested = false;

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
  $('robotScanNote').textContent = scan
    ? `${scan.ranges.filter((r) => r !== null).length} / ${scan.ranges.length} 本の測定 · 測れなかった方向は描きません`
    : 'LiDARの値はまだ届いていません';
}

function drawWheels() {
  const { c, width, height } = prepare($('robotWheels'));
  const pad = { left: 38, right: 8, top: 10, bottom: 20 };
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
  c.font = '11px system-ui';
  c.fillStyle = COLORS.muted;
  c.strokeStyle = COLORS.grid;
  c.lineWidth = 1;
  for (const v of [-top, 0, top]) {
    c.beginPath();
    c.moveTo(pad.left, y(v));
    c.lineTo(width - pad.right, y(v));
    c.stroke();
    c.fillText(String(v), 4, y(v) + 4);
  }
  c.fillText(
    '直近' + HISTORY_SECONDS + '秒 · 車輪の回転数 [RPM]（前進が正）· 実線＝実測　破線＝指令',
    pad.left,
    height - 5,
  );
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
  $('robotEstop').textContent = drive
    ? drive.emergency_stop
      ? '作動中（走行しません）'
      : '解除'
    : '—';
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

function showState(state) {
  const open = state.phase === 'open';
  $('robotLinkOpen').dataset.phase = state.phase;
  $('robotLinkState').textContent = PHASE_LABEL[state.phase];
  $('robotConnect').hidden = state.phase !== 'idle';
  $('robotDisconnect').hidden = state.phase === 'idle';
  $('robotUrl').disabled = state.phase !== 'idle';
  $('robotStatus').textContent =
    state.message ||
    (open
      ? 'つながりました。ロボットのセンサーの値を表示しています。'
      : state.phase === 'connecting'
        ? 'ロボットを探しています…'
        : 'ロボットと同じネットワークにつなぎ、アドレスを確かめて「接続する」を押してください。');
  $('robotMonitor').hidden = !open;
  $('robotStreams').innerHTML = open
    ? Object.entries(state.hello.streams)
        .map(([name, topic]) => {
          const hz = state.rates[name];
          return `<tr><th>${STREAM_LABEL[name] || name}</th><td>${topic ? `<code>${escapeHtml(topic)}</code>` : '使いません'}</td><td>${topic ? (hz > 0 ? hz.toFixed(1) + ' 回/秒' : '届いていません') : '—'}</td></tr>`;
        })
        .join('')
    : '';
  if (!open) {
    history = [];
    if (cameraUrl) {
      URL.revokeObjectURL(cameraUrl);
      cameraUrl = '';
    }
    $('robotCamera').hidden = true;
    $('robotCameraNote').textContent = 'カメラの画像はまだ届いていません';
  }
  requestRedraw();
}

// Lessons that offer a live measurement link here, so a learner who has not connected yet can
// reach the connection dialog without hunting for the header button.
function openRobotDialog() {
  $('robotDialog').showModal();
  showState(robotState());
}

function initLive() {
  $('robotUrl').value = defaultRobotUrl();
  $('robotLinkOpen').onclick = openRobotDialog;
  $('robotClose').onclick = () => $('robotDialog').close();
  $('robotForm').onsubmit = (event) => {
    event.preventDefault();
    try {
      connectRobot($('robotUrl').value);
    } catch (e) {
      $('robotStatus').textContent = e.message;
    }
  };
  $('robotDisconnect').onclick = disconnectRobot;
  onRobot('state', showState);
  onRobot('scan', requestRedraw);
  onRobot('odom', requestRedraw);
  onRobot('twist', requestRedraw);
  onRobot('drive', (drive) => {
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
  });
  onRobot('camera', (blob) => {
    if (!$('robotDialog').open) return;
    const next = URL.createObjectURL(blob);
    const image = $('robotCamera');
    image.onload = () => {
      if (cameraUrl) URL.revokeObjectURL(cameraUrl);
      cameraUrl = next;
    };
    image.src = next;
    image.hidden = false;
    $('robotCameraNote').textContent = 'ロボットのカメラの、いまの画像です';
  });
  showState(robotState());
  // Served by the bridge itself (http://<robot>:8897/): the robot is this very host, so connect right away.
  // Listening is harmless; the link never sends anything to the robot.
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
