// Live link to a real QUESTiX robot (questix_lab_bridge, protocol 1).
// The page listens to the robot's streams. The only frames it ever sends are the drive/stop
// requests of js/live/drive-link.js (sendRobot below is for that module alone), which the bridge
// accepts only when it was started with allow_drive and its own checks pass, and `record_save`
// (saveRecordOnRobot below): a finished recording handed to the bridge to keep on the robot,
// which moves nothing.
// Units follow REP-103: metres, radians, seconds; x forward, y left, theta counter-clockwise.
//
// No DOM here (only WebSocket, localStorage and location, each read when used), so the connection
// rules run as Node tests (test/robot-link.test.mjs) against a fake WebSocket and mocked timers.
import { loadJson, fillSentence } from '../core/content.js';

const copy = await loadJson('content/live/link.json');

// Keep in sync with `port` in questix_lab_bridge/config/lab_bridge.yaml and
// LAB_BRIDGE_PORT in scripts/robot_manager/app.py (its CSP only allows this port).
const DEFAULT_PORT = 8897;
// Robot Manager's own port: the address learners most often paste by mistake.
const MANAGER_PORT = 8888;
const EXAMPLE_ADDRESS = 'http://10.42.0.1:8897/'; // what Robot Manager shows on the robot's own Wi-Fi
const PROTOCOL = 1;
const STORAGE_KEY = 'questix-lab-robot-url';
const RETRY_MS = 3000; // milliseconds between attempts
// Without a hello by then the host is out of reach (another network) or the port is blocked;
// the browser itself would wait for the operating system's TCP timeout, which takes minutes.
const CONNECT_TIMEOUT_MS = 6000;
// The bridge closes a connection over its max_clients with 1013 (RFC 6455 "Try Again Later").
const CLOSE_TOO_MANY_CLIENTS = 1013;
// Keep in sync with max_clients in questix_lab_bridge/config/lab_bridge.yaml (the close frame
// does not carry the number).
const BRIDGE_CLIENT_LIMIT = 24;
// A full bridge frees a place only when someone leaves, so knocking every 3 s only adds load.
const FULL_RETRY_MS = 15000;
// Failed attempts in a row after which a page served by the bridge concludes the bridge is gone.
const STOPPED_AFTER_FAILURES = 3;
// Connected, but no stream has delivered anything for this long (milliseconds).
const SILENT_MS = 4000;
const STREAMS = ['scan', 'odom', 'drive', 'twist', 'camera'];
// Keep in sync with the bridge's incoming size limit for record_save (8 MiB).
const MAX_SAVE_BYTES = 8 * 1024 * 1024;
// A save the bridge has not answered by then is reported as failed (the bridge writes the file
// itself, which takes well under a second; a slow Wi-Fi may take a few for 8 MiB).
const SAVE_TIMEOUT_MS = 30000;
// Address schemes a learner may paste, and the WebSocket scheme each one means.
const SCHEMES = { 'http:': 'ws:', 'https:': 'wss:', 'ws:': 'ws:', 'wss:': 'wss:' };

const listeners = new Map();
const latest = new Map();
// record_save requests waiting for their record_saved / record_error, oldest first: the bridge
// answers one connection's messages in the order they came, so the first answer is the oldest's.
// An entry that timed out stays until its late answer arrives, so it cannot take the next one's.
let saves = [];
let socket = null;
let wanted = false;
let retryTimer = 0;
let connectTimer = 0;
let silenceTimer = 0;
// `session` is this connection's id on the bridge (drive_state.owner refers to it).
// `everOpened`: a hello arrived since connectRobot, so a failure now means the link was lost.
// `failures`: attempts in a row that ended without a hello. `problem`: why the last one failed
// ('timeout', 'refused', 'full', 'lost', 'stopped', 'blocked', 'version' or '').
// `silent`: open, but every stream has been quiet for SILENT_MS.
let state = {
  phase: 'idle',
  url: '',
  hello: null,
  session: null,
  rates: {},
  message: '',
  problem: '',
  everOpened: false,
  failures: 0,
  closeCode: null,
  silent: false,
};

function emit(type, value) {
  for (const fn of listeners.get(type) || []) fn(value);
}
function setState(patch) {
  state = { ...state, ...patch };
  emit('state', state);
}

// Subscribe to 'state', 'status', 'drive_state', or a stream name; returns the unsubscribe function.
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

// What the learner is told about the link: 'idle', 'connecting' (first attempt), 'open',
// 'failed' (never got through, or refused for good) or 'reconnecting' (a working link was lost).
function linkStage(link) {
  if (link.phase === 'open') return 'open';
  if (link.phase === 'idle') return link.problem ? 'failed' : 'idle';
  if (link.everOpened) return 'reconnecting';
  return link.failures > 0 ? 'failed' : 'connecting';
}

function addressError(key) {
  const values = { example: EXAMPLE_ADDRESS, port: DEFAULT_PORT, managerPort: MANAGER_PORT };
  return Error(fillSentence(copy.address[key], values));
}
function parseAddress(value) {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'ws://' + value;
  try {
    return new URL(withScheme);
  } catch {
    throw addressError('invalid');
  }
}
// Accepts what Robot Manager shows (http://10.42.0.1:8897/), a ws:// address, a bare host or
// host:port, and returns the bridge's WebSocket URL without path or query. Errors are sentences.
function normalizeRobotUrl(text) {
  // Full-width digits, dots and colons typed with a Japanese IME become ASCII.
  const value = String(text ?? '')
    .normalize('NFKC')
    .replace(/。/g, '.')
    .trim();
  if (!value) throw addressError('empty');
  const url = parseAddress(value);
  const protocol = SCHEMES[url.protocol];
  if (!protocol) throw addressError('scheme');
  // `ws://http://…` parses with the host "http": what a pasted address used to turn into.
  if (!url.hostname || SCHEMES[url.hostname + ':']) throw addressError('invalid');
  if (url.port === String(MANAGER_PORT)) throw addressError('managerPort');
  return `${protocol}//${url.hostname}:${url.port || DEFAULT_PORT}`;
}

function savedRobotUrl() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? normalizeRobotUrl(saved) : '';
  } catch {
    return ''; // storage blocked, or a broken address saved by an older version
  }
}
function defaultRobotUrl() {
  const saved = savedRobotUrl();
  if (saved) return saved;
  // Served by robot_manager on the robot: the bridge runs on the same host.
  const page = globalThis.location;
  return page?.protocol === 'http:' && page.hostname ? `ws://${page.hostname}:${DEFAULT_PORT}` : '';
}

function hostName(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
// A page opened from the bridge (http://<robot>:8897/) that talks to that same bridge.
function servedByThisBridge(url) {
  const page = globalThis.location;
  if (page?.port !== String(DEFAULT_PORT)) return false;
  try {
    return new URL(url).host === page.host;
  } catch {
    return false;
  }
}
function problemMessage(problem, url, delayMs) {
  const host = hostName(url);
  const values = {
    host,
    address: `http://${host}:${DEFAULT_PORT}/`,
    limit: BRIDGE_CLIENT_LIMIT,
    seconds: Math.round(delayMs / 1000),
  };
  const sentence = fillSentence(copy.problems[problem], values);
  return delayMs && problem !== 'lost' ? sentence + fillSentence(copy.retry, values) : sentence;
}

function stopTimers() {
  clearTimeout(retryTimer);
  clearTimeout(connectTimer);
  clearTimeout(silenceTimer);
  retryTimer = 0;
  connectTimer = 0;
  silenceTimer = 0;
}
// Closes the socket without letting its close event count as a failure.
function dropSocket() {
  const old = socket;
  socket = null;
  dropSaves();
  if (!old) return;
  old.onmessage = null;
  old.onclose = null;
  old.close();
}

function armSilence() {
  if (silenceTimer || state.silent) return;
  silenceTimer = setTimeout(() => {
    silenceTimer = 0;
    if (state.phase === 'open') setState({ silent: true });
  }, SILENT_MS);
}
function receiveStatus(message) {
  const rates = message.rates || {};
  if (Object.values(rates).some((hz) => hz > 0)) {
    clearTimeout(silenceTimer);
    silenceTimer = 0;
    setState({ rates, silent: false });
  } else {
    armSilence();
    setState({ rates });
  }
  emit('status', message);
}
function refuseVersion() {
  wanted = false;
  stopTimers();
  dropSocket();
  setState({ phase: 'idle', rates: {}, problem: 'version', message: copy.problems.version });
}
function welcome(message) {
  if (message.protocol !== PROTOCOL) {
    refuseVersion();
    return;
  }
  clearTimeout(connectTimer);
  connectTimer = 0;
  setState({
    phase: 'open',
    hello: message,
    message: '',
    problem: '',
    everOpened: true,
    failures: 0,
    closeCode: null,
    silent: false,
  });
  armSilence(); // until the first status says otherwise, nothing has arrived
}

// --- keeping recordings on the robot -----------------------------------------------------------

const saveError = (key, values = {}) => new Error(fillSentence(copy.save[key], values));

function answerSave(error, id) {
  const pending = saves.shift();
  if (!pending || pending.timedOut) return;
  clearTimeout(pending.timer);
  if (error) pending.reject(error);
  else pending.resolve(id);
}
// The connection the saves were sent on is gone, and their answers with it.
function dropSaves() {
  const pending = saves;
  saves = [];
  for (const save of pending) {
    clearTimeout(save.timer);
    if (!save.timedOut) save.reject(saveError('lost'));
  }
}

/** What the bridge offers for records (hello.records), or null (not connected, older bridge). */
function robotRecordsSupport() {
  if (state.phase !== 'open') return null;
  const records = state.hello?.records;
  return records && typeof records === 'object' ? records : null;
}

/**
 * Hand a finished recording (its JSON text, recording-core serializeRecording) to the bridge,
 * which keeps it on the robot. Resolves with the id the bridge gave it; rejects with an Error whose
 * message is the reason in the learner's words (not connected, not accepted, too big, no answer,
 * or the bridge's own record_error sentence).
 */
function saveRecordOnRobot(text) {
  if (!socket || socket.readyState !== WebSocket.OPEN || state.phase !== 'open')
    return Promise.reject(saveError('notConnected'));
  if (!robotRecordsSupport()?.save) return Promise.reject(saveError('off'));
  const frame = `{"type":"record_save","recording":${text}}`;
  if (new TextEncoder().encode(frame).length > MAX_SAVE_BYTES)
    return Promise.reject(saveError('tooBig', { limit: MAX_SAVE_BYTES / 1024 / 1024 }));
  return new Promise((resolve, reject) => {
    const pending = { resolve, reject, timedOut: false, timer: 0 };
    pending.timer = setTimeout(() => {
      pending.timedOut = true;
      reject(saveError('timeout'));
    }, SAVE_TIMEOUT_MS);
    saves.push(pending);
    socket.send(frame);
  });
}

function handleText(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'hello') welcome(message);
  else if (message.type === 'status') receiveStatus(message);
  else if (message.type === 'session') setState({ session: message.id });
  else if (message.type === 'record_saved') answerSave(null, String(message.id ?? ''));
  else if (message.type === 'record_error')
    answerSave(new Error(String(message.message || copy.save.off)));
  else if (message.type === 'drive_state' || STREAMS.includes(message.type)) {
    latest.set(message.type, message);
    emit(message.type, message);
  }
}
function receive(event) {
  if (typeof event.data === 'string') {
    handleText(event.data);
    return;
  }
  latest.set('camera', event.data);
  emit('camera', event.data);
}

// An attempt ended without a working link (or a working link ended): say why and try again.
function failed(url, problem, closeCode) {
  stopTimers();
  const failures = state.failures + 1;
  const gone = failures >= STOPPED_AFTER_FAILURES && problem !== 'full' && servedByThisBridge(url);
  const shown = gone ? 'stopped' : problem;
  const delay = problem === 'full' ? FULL_RETRY_MS : RETRY_MS;
  setState({
    phase: 'error',
    rates: {},
    silent: false,
    failures,
    closeCode,
    problem: shown,
    message: problemMessage(shown, url, delay),
  });
  retryTimer = setTimeout(() => {
    if (wanted) open(url);
  }, delay);
}
function closeProblem(code) {
  if (code === CLOSE_TOO_MANY_CLIENTS) return 'full';
  return state.everOpened ? 'lost' : 'refused';
}
// The browser refused to even start (mixed content, a blocked address): retrying cannot help.
function blocked(url) {
  wanted = false;
  setState({
    phase: 'idle',
    failures: state.failures + 1,
    problem: 'blocked',
    message: problemMessage('blocked', url, 0),
  });
}

function open(url) {
  stopTimers();
  latest.clear();
  setState({ phase: 'connecting', url, hello: null, session: null, rates: {}, silent: false });
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    blocked(url);
    return;
  }
  socket = ws;
  ws.binaryType = 'blob';
  ws.onmessage = (event) => {
    if (ws === socket) receive(event);
  };
  ws.onclose = (event) => {
    if (ws !== socket) return;
    socket = null;
    dropSaves();
    failed(url, closeProblem(event.code), event.code);
  };
  connectTimer = setTimeout(() => {
    if (ws !== socket) return;
    dropSocket();
    failed(url, state.everOpened ? 'lost' : 'timeout', null);
  }, CONNECT_TIMEOUT_MS);
}
function connectRobot(text) {
  const url = normalizeRobotUrl(text);
  try {
    localStorage.setItem(STORAGE_KEY, url);
  } catch {
    /* optional */
  }
  wanted = true;
  dropSocket();
  state = { ...state, message: '', problem: '', everOpened: false, failures: 0, closeCode: null };
  open(url);
}
// For js/live/drive-link.js only: lessons go through its checks, never through this function.
// Returns false when the frame could not be sent (no open connection).
function sendRobot(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN || state.phase !== 'open') return false;
  socket.send(JSON.stringify(message));
  return true;
}

function disconnectRobot() {
  wanted = false;
  stopTimers();
  dropSocket();
  setState({
    phase: 'idle',
    session: null,
    rates: {},
    message: '',
    problem: '',
    everOpened: false,
    failures: 0,
    closeCode: null,
    silent: false,
  });
}

export {
  DEFAULT_PORT,
  MANAGER_PORT,
  CONNECT_TIMEOUT_MS,
  RETRY_MS,
  FULL_RETRY_MS,
  SILENT_MS,
  SAVE_TIMEOUT_MS,
  MAX_SAVE_BYTES,
  STOPPED_AFTER_FAILURES,
  BRIDGE_CLIENT_LIMIT,
  onRobot,
  robotState,
  latestRobot,
  linkStage,
  defaultRobotUrl,
  normalizeRobotUrl,
  connectRobot,
  disconnectRobot,
  sendRobot,
  robotRecordsSupport,
  saveRecordOnRobot,
};
