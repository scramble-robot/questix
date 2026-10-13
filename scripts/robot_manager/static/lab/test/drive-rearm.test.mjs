import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DrivePressLatch,
  DriveCommandWatch,
  driveReadiness,
  limitCommand,
} from '../js/live/drive-core.js';

test('automatic run finish cannot release a physical press', () => {
  const latch = new DrivePressLatch();
  assert.equal(latch.press(), true);
  // A run finishing or a blocker clearing never calls release().
  assert.equal(latch.press(), false);
  latch.release();
  assert.equal(latch.press(), true);
});

test('target response is display confirmation, with bounded missing-response handling', () => {
  const watch = new DriveCommandWatch();
  watch.observe({ left: { target_rpm: 20 } }, 0);
  watch.request(0, 0, 1);
  assert.equal(watch.expired(10), false);
  watch.request(.1, 0, 10);
  watch.observe({ left: { target_rpm: 0 }, right: { target_rpm: 0 } }, 11);
  assert.equal(watch.expired(12), false);
  assert.equal(watch.expired(12.01), true);
  watch.observe({ left: { target_rpm: 10 } }, 12.1);
  assert.equal(watch.expired(20), false);
});

let loadCount = 0;
async function harness() {
  const saved = Object.fromEntries(
    ['performance', 'document', 'window', 'setInterval', 'clearInterval'].map((key) => [key, globalThis[key]]),
  );
  let now = 0;
  const timers = new Set();
  const listeners = new Map();
  const streams = new Map();
  const sent = [];
  const link = { phase: 'open', session: 1 };
  streams.set('drive_state', { active: false, owner: null, blockers: [], limits: { linear: .15, angular: .5 } });
  globalThis.performance = { now: () => now * 1000 };
  globalThis.document = { addEventListener() {} };
  globalThis.window = { addEventListener() {} };
  globalThis.setInterval = (fn) => { timers.add(fn); return fn; };
  globalThis.clearInterval = (fn) => timers.delete(fn);
  globalThis.__driveRearmTest = {
    DriveCommandWatch, driveReadiness, limitCommand,
    robotState: () => link,
    latestRobot: (type) => streams.get(type),
    sendRobot: (frame) => { sent.push(frame); return true; },
    onRobot(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
  };
  const source = (await readFile(new URL('../js/live/drive-link.js', import.meta.url), 'utf8'))
    .replace(/^import .*from .*;\n/gm, '');
  const injected = 'const {onRobot, robotState, latestRobot, sendRobot, driveReadiness, limitCommand, DriveCommandWatch} = globalThis.__driveRearmTest;\n';
  const module = await import(`data:text/javascript;base64,${Buffer.from(injected + source + `\n// ${loadCount++}`).toString('base64')}`);
  module.confirmDriveSafety(true);
  return {
    module, sent,
    emit(type, value) { streams.set(type, value); for (const fn of listeners.get(type) ?? []) fn(value); },
    advance(seconds) { for (let step = 0; step < Math.ceil(seconds / .1); step++) { now += .1; for (const fn of [...timers]) fn(); } },
    close() { Object.assign(globalThis, saved); delete globalThis.__driveRearmTest; },
  };
}

test('real drive-link repeats startup zero, then starts the program', async () => {
  const h = await harness();
  try {
    const abort = new AbortController();
    const result = h.module.runDrive({ controller: () => ({ linear: .1, angular: 0 }), seconds: 5, signal: abort.signal });
    h.advance(.5); // bridge has not accepted the owner yet
    assert.ok(h.sent.every((frame) => frame.linear === 0));
    h.emit('drive_state', { active: true, owner: 1, blockers: [], limits: { linear: .15, angular: .5 } });
    h.advance(.2);
    assert.ok(h.sent.every((frame) => frame.linear === 0));
    h.advance(.2);
    assert.ok(h.sent.some((frame) => frame.linear === .1));
    h.advance(.1);
    h.emit('drive', { left: { target_rpm: 10 } });
    h.advance(2.1);
    abort.abort();
    assert.equal((await result).reason, 'stopped');
  } finally { h.close(); }
});

test('a missing actuator response ends visibly instead of an inert held run', async () => {
  const h = await harness();
  try {
    const result = h.module.runDrive({ controller: () => ({ linear: .1, angular: 0 }), seconds: 10 });
    h.emit('drive_state', { active: true, owner: 1, blockers: [], limits: { linear: .15, angular: .5 } });
    h.advance(2.6);
    assert.equal((await result).refused, 'drive_not_responding');
    assert.ok(h.sent.some((frame) => frame.type === 'stop' && frame.scope === 'mine'));
  } finally { h.close(); }
});

test('blocker release never restarts a finished drive-link heartbeat', async () => {
  const h = await harness();
  try {
    const result = h.module.runDrive({ controller: () => ({ linear: .1, angular: 0 }), seconds: 10 });
    h.emit('drive_state', { active: true, owner: 1, blockers: [], limits: { linear: .15, angular: .5 } });
    h.advance(.4);
    h.emit('drive_state', { active: false, owner: null, last_stop: { reason: 'no_motion_permission' } });
    assert.equal((await result).reason, 'no_motion_permission');
    const count = h.sent.length;
    h.emit('drive_state', { active: false, owner: null, blockers: [] });
    h.advance(5);
    assert.equal(h.sent.length, count);
  } finally { h.close(); }
});
