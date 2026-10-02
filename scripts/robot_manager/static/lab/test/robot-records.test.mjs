// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// Keeping finished recordings on the robot (record_save over the WebSocket, js/live/robot-link.js
// saveRecordOnRobot, and js/live/robot-records.js keepOnRobot): only a bridge that says it keeps
// records gets them, every save is answered in order, and a timeout or a lost link is a sentence
// for the learner instead of a promise that never settles. The WebSocket is a fake.
import test, { beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  connectRobot,
  disconnectRobot,
  saveRecordOnRobot,
  robotRecordsSupport,
  SAVE_TIMEOUT_MS,
  MAX_SAVE_BYTES,
} from '../js/live/robot-link.js';
import { keepOnRobot, robotRecordsInfo, robotRecordsClient } from '../js/live/robot-records.js';
import { recordsCopy } from '../js/live/records-core.js';
import { makeRecording } from '../js/live/recording-core.js';

class FakeSocket {
  static OPEN = 1;
  static made = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.made.push(this);
  }
  close() {
    this.readyState = 3;
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
const hello = (records) => ({
  type: 'hello',
  protocol: 1,
  read_only: true,
  config: { wheel_radius: 0.1, wheel_separation: 0.5 },
  streams: { drive: '/drive_status' },
  robot: { name: 'questix-07', domain: 42 },
  ...(records ? { records } : {}),
});
const RECORDING = makeRecording({
  source: 'live',
  name: '',
  recordedAt: '2026-09-25T01:30:00Z',
  config: { wheel_radius: 0.1, wheel_separation: 0.5 },
  streams: { drive: [{ type: 'drive', stamp: 1, v: 0.2, w: 0 }] },
  lesson: 'control-speed',
});
const sentFrames = () => last().sent.map((text) => JSON.parse(text));

function connect(records = { save: true, list: true, rosbags: true }) {
  connectRobot('ws://10.42.0.1:8897');
  last().receive(hello(records));
}

beforeEach(() => {
  globalThis.WebSocket = FakeSocket;
  FakeSocket.made = [];
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
});
afterEach(() => {
  disconnectRobot();
  mock.timers.reset();
});

test('a bridge that keeps records gets the recording as one record_save frame', async () => {
  connect();
  assert.deepEqual(robotRecordsSupport(), { save: true, list: true, rosbags: true });
  const saved = saveRecordOnRobot(JSON.stringify(RECORDING));
  const [frame] = sentFrames();
  assert.equal(frame.type, 'record_save');
  assert.deepEqual(frame.recording, JSON.parse(JSON.stringify(RECORDING)));
  last().receive({ type: 'record_saved', id: '20260925-103000-control-speed' });
  assert.equal(await saved, '20260925-103000-control-speed');
});

test("answers are matched in order; the bridge's refusal is the learner's sentence", async () => {
  connect();
  const first = saveRecordOnRobot('{"a":1}');
  const second = saveRecordOnRobot('{"b":2}');
  const full = 'ロボットの保存領域がいっぱいです。先生に古い記録の整理を頼んでください。';
  last().receive({ type: 'record_error', message: full });
  last().receive({ type: 'record_saved', id: 'b' });
  await assert.rejects(first, { message: full });
  assert.equal(await second, 'b');
});

test('an older bridge, or one that does not accept saves, is never sent anything', async () => {
  connect(null);
  assert.equal(robotRecordsSupport(), null);
  await assert.rejects(saveRecordOnRobot('{}'), { message: /受け付けていません/ });
  assert.equal(await keepOnRobot(RECORDING), null);
  assert.equal(last().sent.length, 0);
  disconnectRobot();
  connect({ save: false, list: true, rosbags: false });
  assert.equal(await keepOnRobot(RECORDING), null);
  assert.equal(last().sent.length, 0);
});

test('too big to send is refused before sending', async () => {
  connect();
  const huge = `{"x":"${'a'.repeat(MAX_SAVE_BYTES)}"}`;
  await assert.rejects(saveRecordOnRobot(huge), { message: /大きすぎます/ });
  assert.equal(last().sent.length, 0);
});

test('no answer in time fails that save only; its late answer does not settle the next one', async () => {
  connect();
  const slow = saveRecordOnRobot('{"a":1}');
  mock.timers.tick(SAVE_TIMEOUT_MS);
  await assert.rejects(slow, { message: /返事がありませんでした/ });
  const next = saveRecordOnRobot('{"b":2}');
  last().receive({ type: 'record_saved', id: 'late-a' });
  last().receive({ type: 'record_saved', id: 'b' });
  assert.equal(await next, 'b');
});

test('a lost link fails the saves waiting on it', async () => {
  connect();
  const waiting = saveRecordOnRobot('{"a":1}');
  last().serverClose(1006);
  await assert.rejects(waiting, { message: /接続が切れました/ });
  await assert.rejects(saveRecordOnRobot('{}'), { message: /接続が切れていました/ });
});

test('keepOnRobot says what the lesson block shows, and reports a cut-off robot as not saved', async () => {
  connect();
  const kept = keepOnRobot(RECORDING);
  await Promise.resolve();
  last().receive({ type: 'record_saved', id: 'r1' });
  assert.deepEqual(await kept, { state: 'saved', id: 'r1', message: recordsCopy.save.saved });
  // The link dropped at the end of a run (keepOnLost): the robot kept records, so this is said.
  last().serverClose(1006);
  const cut = await keepOnRobot(RECORDING);
  assert.equal(cut.state, 'failed');
  assert.match(cut.message, /この端末の記録には残っています/);
});

test('the records client follows the connection', () => {
  assert.equal(robotRecordsClient(), null);
  assert.equal(robotRecordsInfo().connected, false);
  connect();
  assert.equal(robotRecordsClient().base, 'http://10.42.0.1:8897');
  assert.deepEqual(robotRecordsInfo(), {
    connected: true,
    save: true,
    list: true,
    rosbags: true,
  });
});
