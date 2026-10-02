// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// Connecting to the robot (js/live/robot-link.js): which addresses are accepted, and what the
// learner is told when a connection cannot be made, is refused, or is lost. The WebSocket is a
// fake and the timers are mocked, so no bridge is needed.
import test, { beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRobotUrl,
  connectRobot,
  disconnectRobot,
  robotState,
  linkStage,
  CONNECT_TIMEOUT_MS,
  RETRY_MS,
  FULL_RETRY_MS,
  SILENT_MS,
  STOPPED_AFTER_FAILURES,
  BRIDGE_CLIENT_LIMIT,
} from '../js/live/robot-link.js';

class FakeSocket {
  static OPEN = 1;
  static made = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.closed = false;
    this.sent = [];
    FakeSocket.made.push(this);
  }
  close() {
    this.closed = true;
  }
  send(text) {
    this.sent.push(text);
  }
  receive(message) {
    this.readyState = FakeSocket.OPEN;
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  serverClose(code) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}
const last = () => FakeSocket.made[FakeSocket.made.length - 1];
const HELLO = {
  type: 'hello',
  protocol: 1,
  read_only: true,
  streams: { scan: '/scan', drive: '/drive_status' },
  robot: { name: 'questix-07', domain: 42 },
};
const ROBOT_PAGE = {
  protocol: 'http:',
  host: '10.42.0.1:8897',
  hostname: '10.42.0.1',
  port: '8897',
};

beforeEach(() => {
  globalThis.WebSocket = FakeSocket;
  FakeSocket.made = [];
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
});
afterEach(() => {
  disconnectRobot();
  mock.timers.reset();
  delete globalThis.location;
});

test('accepts the address Robot Manager shows, ws:// addresses, bare hosts and host:port', () => {
  assert.equal(normalizeRobotUrl('http://10.42.0.1:8897/'), 'ws://10.42.0.1:8897');
  assert.equal(normalizeRobotUrl('  http://10.42.0.1:8897/lab/?x=1#top '), 'ws://10.42.0.1:8897');
  assert.equal(normalizeRobotUrl('https://robot.example'), 'wss://robot.example:8897');
  assert.equal(normalizeRobotUrl('ws://192.168.1.20:8897/'), 'ws://192.168.1.20:8897');
  assert.equal(normalizeRobotUrl('wss://robot.local'), 'wss://robot.local:8897');
  assert.equal(normalizeRobotUrl('10.42.0.1'), 'ws://10.42.0.1:8897');
  assert.equal(normalizeRobotUrl('10.42.0.1:9000'), 'ws://10.42.0.1:9000');
  assert.equal(normalizeRobotUrl('localhost:8897'), 'ws://localhost:8897');
  assert.equal(normalizeRobotUrl('[::1]:8897'), 'ws://[::1]:8897');
  // Typed with a Japanese IME: full-width digits, dots and colon.
  assert.equal(normalizeRobotUrl('１０．４２．０．１：８８９７'), 'ws://10.42.0.1:8897');
  assert.equal(normalizeRobotUrl('10。42。0。1'), 'ws://10.42.0.1:8897');
});

test('rejects what is not a robot address, always with a Japanese sentence', () => {
  const rejects = (text, pattern) =>
    assert.throws(
      () => normalizeRobotUrl(text),
      (error) => pattern.test(error.message) && !/Invalid|URL/.test(error.message),
      text,
    );
  rejects('', /アドレスを入力してください/);
  rejects('   ', /アドレスを入力してください/);
  rejects(
    'http://10.42.0.1:8888/',
    /^8888はロボットの管理画面（Robot Manager）の番号です。教材は8897/,
  );
  rejects('10.42.0.1:8888', /8888/);
  rejects('ftp://10.42.0.1', /http:\/\/ か ws:\/\//);
  rejects('ws://http:8897//10.42.0.1:8897/', /形が正しくありません/);
  rejects('http://', /形が正しくありません/);
  rejects('10.42.0.1:99999', /形が正しくありません/);
});

test('an address that never answers times out instead of trying forever', () => {
  connectRobot('http://10.42.0.1:8897/');
  assert.equal(last().url, 'ws://10.42.0.1:8897');
  assert.equal(linkStage(robotState()), 'connecting');
  mock.timers.tick(CONNECT_TIMEOUT_MS - 1);
  assert.equal(robotState().phase, 'connecting');
  mock.timers.tick(1);
  const state = robotState();
  assert.equal(last().closed, true);
  assert.equal(state.problem, 'timeout');
  assert.equal(linkStage(state), 'failed');
  assert.match(state.message, /^10\.42\.0\.1 に届きません。この端末がロボットのWi-Fi/);
  // It keeps trying in the background, but the learner is still told it cannot connect.
  mock.timers.tick(RETRY_MS);
  assert.equal(FakeSocket.made.length, 2);
  assert.equal(linkStage(robotState()), 'failed');
});

test('a refused first attempt says it cannot connect, not that it is reconnecting', () => {
  connectRobot('10.42.0.1');
  last().serverClose(1006);
  assert.equal(robotState().problem, 'refused');
  assert.equal(robotState().everOpened, false);
  assert.equal(linkStage(robotState()), 'failed');
  assert.match(robotState().message, /配信開始/);
});

test('a link that worked and is lost is reconnecting', () => {
  connectRobot('10.42.0.1');
  last().receive(HELLO);
  assert.equal(linkStage(robotState()), 'open');
  assert.equal(robotState().hello.robot.name, 'questix-07');
  last().serverClose(1006);
  assert.equal(linkStage(robotState()), 'reconnecting');
  assert.equal(robotState().problem, 'lost');
  // A reconnect attempt that times out still counts as the lost link.
  mock.timers.tick(RETRY_MS + CONNECT_TIMEOUT_MS);
  assert.equal(linkStage(robotState()), 'reconnecting');
  assert.equal(robotState().problem, 'lost');
});

test('a bridge without the robot field (older version) still opens', () => {
  connectRobot('10.42.0.1');
  const { robot, ...older } = HELLO;
  assert.ok(robot);
  last().receive(older);
  assert.equal(robotState().phase, 'open');
  assert.equal(robotState().hello.robot, undefined);
});

test('a full bridge (close code 1013) is asked again slowly, with the limit in the message', () => {
  connectRobot('10.42.0.1');
  last().serverClose(1013);
  const state = robotState();
  assert.equal(state.problem, 'full');
  assert.equal(state.closeCode, 1013);
  assert.ok(state.message.includes(`（${BRIDGE_CLIENT_LIMIT}台）`));
  mock.timers.tick(RETRY_MS);
  assert.equal(FakeSocket.made.length, 1);
  mock.timers.tick(FULL_RETRY_MS - RETRY_MS);
  assert.equal(FakeSocket.made.length, 2);
});

test('a page served by the bridge says the stream stopped after repeated failures', () => {
  globalThis.location = ROBOT_PAGE;
  connectRobot('ws://10.42.0.1:8897');
  for (let attempt = 1; attempt < STOPPED_AFTER_FAILURES; attempt++) {
    last().serverClose(1006);
    assert.equal(robotState().problem, 'refused');
    mock.timers.tick(RETRY_MS);
  }
  last().serverClose(1006);
  assert.equal(robotState().problem, 'stopped');
  assert.match(robotState().message, /^ロボット側の配信が止まっているようです（大会モード/);
});

test('another robot typed on a bridge page is not reported as this bridge stopping', () => {
  globalThis.location = ROBOT_PAGE;
  connectRobot('10.42.0.2');
  for (let attempt = 0; attempt < STOPPED_AFTER_FAILURES; attempt++) {
    last().serverClose(1006);
    mock.timers.tick(RETRY_MS);
  }
  assert.equal(robotState().problem, 'refused');
});

test('open but nothing arriving for a while is flagged, and cleared when values flow', () => {
  connectRobot('10.42.0.1');
  last().receive(HELLO);
  last().receive({ type: 'status', rates: { scan: 0, drive: 0 } });
  mock.timers.tick(SILENT_MS - 1);
  assert.equal(robotState().silent, false);
  mock.timers.tick(1);
  assert.equal(robotState().silent, true);
  last().receive({ type: 'status', rates: { scan: 7.9, drive: 0 } });
  assert.equal(robotState().silent, false);
  last().receive({ type: 'status', rates: { scan: 0, drive: 0 } });
  mock.timers.tick(SILENT_MS);
  assert.equal(robotState().silent, true);
});

test('a bridge of another protocol version is refused without retrying', () => {
  connectRobot('10.42.0.1');
  last().receive({ ...HELLO, protocol: 99 });
  assert.equal(robotState().phase, 'idle');
  assert.equal(robotState().problem, 'version');
  assert.equal(linkStage(robotState()), 'failed');
  mock.timers.tick(FULL_RETRY_MS);
  assert.equal(FakeSocket.made.length, 1);
});

test('disconnecting stops retrying and forgets the problem', () => {
  connectRobot('10.42.0.1');
  last().serverClose(1006);
  disconnectRobot();
  assert.equal(linkStage(robotState()), 'idle');
  assert.equal(robotState().message, '');
  mock.timers.tick(FULL_RETRY_MS);
  assert.equal(FakeSocket.made.length, 1);
});

test('a new address replaces the attempt in progress', () => {
  connectRobot('10.42.0.9');
  const first = last();
  connectRobot('10.42.0.1');
  assert.equal(first.closed, true);
  first.serverClose(1006); // a late event from the old socket changes nothing
  assert.equal(robotState().phase, 'connecting');
  assert.equal(robotState().url, 'ws://10.42.0.1:8897');
});
