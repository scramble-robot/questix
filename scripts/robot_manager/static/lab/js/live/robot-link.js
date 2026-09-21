// Live, observation-only link to a real QUESTiX robot (questix_lab_bridge, protocol 1).
// The page only listens: nothing is ever sent to the robot, so lessons cannot move it.
// Units follow REP-103: metres, radians, seconds; x forward, y left, theta counter-clockwise.

// Keep in sync with `port` in questix_lab_bridge/config/lab_bridge.yaml and
// LAB_BRIDGE_PORT in scripts/robot_manager/app.py (its CSP only allows this port).
const DEFAULT_PORT = 8897;
const PROTOCOL = 1;
const STORAGE_KEY = 'questix-lab-robot-url';
const RETRY_MS = 3000;
const STREAMS = ['scan', 'odom', 'drive', 'twist', 'camera'];

const listeners = new Map();
const latest = new Map();
let socket = null,
  wanted = false,
  retryTimer = 0;
let state = { phase: 'idle', url: '', hello: null, rates: {}, message: '' };

function emit(type, value) {
  for (const fn of listeners.get(type) || []) fn(value);
}
function setState(patch) {
  state = { ...state, ...patch };
  emit('state', state);
}

// Subscribe to 'state', 'status', or a stream name; returns the unsubscribe function.
function onRobot(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type).delete(fn);
}
function robotState() {
  return state;
}
function latestRobot(type) {
  return latest.get(type) ?? null;
}

function defaultRobotUrl() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return saved;
  } catch {
    /* storage may be blocked */
  }
  // Served by robot_manager on the robot: the bridge runs on the same host.
  return location.protocol === 'http:' && location.hostname
    ? `ws://${location.hostname}:${DEFAULT_PORT}`
    : '';
}
function normalizeRobotUrl(text) {
  const value = text.trim();
  if (!value)
    throw Error('ロボットのアドレスを入力してください。例：ws://192.168.1.20:' + DEFAULT_PORT);
  const url = new URL(/^wss?:\/\//.test(value) ? value : 'ws://' + value);
  if (!/^wss?:$/.test(url.protocol)) throw Error('ws:// から始まるアドレスを入力してください。');
  if (!url.port) url.port = String(DEFAULT_PORT);
  return url.href;
}

function handleText(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'hello') {
    if (message.protocol !== PROTOCOL) {
      setState({ message: 'ロボット側のソフトウェアと教材の版が合いません。' });
      disconnectRobot();
      return;
    }
    setState({ phase: 'open', hello: message, message: '' });
    return;
  }
  if (message.type === 'status') {
    setState({ rates: message.rates || {} });
    emit('status', message);
    return;
  }
  if (STREAMS.includes(message.type)) {
    latest.set(message.type, message);
    emit(message.type, message);
  }
}

function open(url) {
  clearTimeout(retryTimer);
  latest.clear();
  setState({ phase: 'connecting', url, hello: null, rates: {} });
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    setState({ phase: 'error', message: 'このアドレスには接続できません。' });
    return;
  }
  socket = ws;
  ws.binaryType = 'blob';
  ws.onmessage = (event) => {
    if (ws !== socket) return;
    if (typeof event.data === 'string') handleText(event.data);
    else {
      latest.set('camera', event.data);
      emit('camera', event.data);
    }
  };
  ws.onclose = () => {
    if (ws !== socket) return;
    socket = null;
    if (!wanted) {
      setState({ phase: 'idle', rates: {} });
      return;
    }
    setState({
      phase: 'error',
      rates: {},
      message: state.message || 'ロボットとつながっていません。数秒ごとに再接続を試みます。',
    });
    retryTimer = setTimeout(() => {
      if (wanted) open(url);
    }, RETRY_MS);
  };
}
function connectRobot(text) {
  const url = normalizeRobotUrl(text);
  try {
    localStorage.setItem(STORAGE_KEY, url);
  } catch {
    /* optional */
  }
  wanted = true;
  if (socket) {
    const old = socket;
    socket = null;
    old.close();
  }
  state = { ...state, message: '' };
  open(url);
}
function disconnectRobot() {
  wanted = false;
  clearTimeout(retryTimer);
  if (socket) socket.close();
  else setState({ phase: 'idle', rates: {} });
}

export {
  DEFAULT_PORT,
  onRobot,
  robotState,
  latestRobot,
  defaultRobotUrl,
  normalizeRobotUrl,
  connectRobot,
  disconnectRobot,
};
