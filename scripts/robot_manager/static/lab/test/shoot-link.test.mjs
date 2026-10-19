// Exercise the actual sender/session module with a fake robot link and deterministic timers.
// No WebSocket, ROS, or hardware commands are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as core from '../js/live/shoot-core.js';

function page() {
  let clock = 0;
  let timerId = 0;
  const timers = new Map();
  const handlers = new Map();
  const frames = new Map();
  const sent = [];
  const link = { phase: 'open', session: 7, hello: { shoot: { allowed: true } } };
  const events = {};
  const document = {
    hidden: false,
    addEventListener(type, fn) {
      events[type] = fn;
    },
  };
  const schedule = (fn, gap, interval = false) => {
    const id = ++timerId;
    timers.set(id, { fn, at: clock + gap, gap: interval ? gap : 0 });
    return id;
  };
  const context = {
    ...core,
    document,
    window: { addEventListener() {} },
    performance: { now: () => clock },
    onRobot: (type, fn) => handlers.set(type, fn),
    robotState: () => link,
    latestRobot: (type) => frames.get(type) ?? null,
    sendRobot: (frame) => {
      sent.push(frame);
      return link.phase === 'open';
    },
    setInterval: (fn, gap) => schedule(fn, gap, true),
    clearInterval: (id) => timers.delete(id),
    setTimeout: (fn, gap) => schedule(fn, gap),
    clearTimeout: (id) => timers.delete(id),
  };
  const source = fs.readFileSync(new URL('../js/live/shoot-link.js', import.meta.url), 'utf8');
  const exports = source.match(/export \{([\s\S]*?)\};/)[1];
  vm.runInNewContext(
    source
      .replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '')
      .replace(/export \{[\s\S]*?\};/, `globalThis.api = {${exports}};`),
    context,
  );
  const emit = (type, frame) => {
    frames.set(type, frame);
    handlers.get(type)?.(frame);
  };
  emit('shoot_state', { allowed: true, active: false, owner: null, blockers: [] });
  context.api.confirmShootSafety(true);
  return {
    ...context.api,
    sent,
    events,
    document,
    emit,
    shot: (tilt_deg) => emit('shot', { tilt_deg, fired_count: 0, shooting: false }),
    own: () => emit('shoot_state', { allowed: true, active: true, owner: 7, blockers: [] }),
    advance(ms) {
      const until = clock + ms;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        clock = timer.at;
        if (timer.gap) timer.at += timer.gap;
        else timers.delete(id);
        timer.fn();
      }
      clock = until;
    },
  };
}

test('the slider waits for a finite fresh robot angle, including zero degrees', () => {
  const p = page();
  for (const tilt of [undefined, null, Number.NaN, Infinity]) {
    p.shot(tilt);
    assert.equal(p.shootModel().controls.tilt.enabled, false);
    assert.equal(p.shootModel().controls.tilt.reason.key, 'tilt_unknown');
    p.setTilt(110);
    assert.equal(p.sent.length, 0, 'disabled tilt sends no commands or heartbeat');
  }
  p.shot(0);
  assert.equal(p.shootModel().controls.tilt.enabled, true);
  assert.equal(p.shootModel().tilt, 0);
  p.advance(core.STATUS_STALE_MS + 1);
  assert.equal(p.shootModel().controls.tilt.enabled, false, 'a stale angle is not usable');
});

test('ending a session restores the robot angle and cancels any queued tilt', () => {
  const p = page();
  p.shot(30);
  p.setTilt(110);
  p.advance(0);
  p.own();
  assert.equal(p.shootModel().tilt, 110);
  p.setTilt(100); // coalesced, not sent yet
  p.stopOwn();
  assert.equal(p.shootModel().tilt, 30);
  const before = p.sent.length;
  p.advance(120);
  assert.equal(p.sent.length, before, 'no delayed target after the stop');
  p.shot(45);
  assert.equal(p.shootModel().tilt, 45);
});

test('recent in-flight feedback does not undo the slider, then another path takes over', () => {
  const p = page();
  p.shot(30);
  p.setTilt(110);
  p.advance(0);
  p.own();
  p.advance(200);
  p.shot(30); // old feedback, target still on its way
  assert.equal(p.shootModel().tilt, 110);
  p.shot(110); // acknowledges this page's target
  p.shot(108); // less than 3 degrees of difference
  assert.equal(p.shootModel().tilt, 110);
  const tilts = () => p.sent.filter((frame) => frame.type === 'tilt').length;
  const before = tilts();
  p.shot(80); // controller or another route, session still reported as ours
  assert.equal(p.shootModel().tilt, 80);
  assert.equal(p.shootModel().session, true);
  assert.equal(tilts(), before, 'following feedback never sends a correcting command');
  p.shot(75);
  assert.equal(p.shootModel().tilt, 75);
});

test('an unacknowledged target expires so the slider does not pin a refused angle', () => {
  const p = page();
  p.shot(30);
  p.setTilt(110);
  p.advance(0);
  p.own();
  p.advance(1000);
  p.shot(40);
  assert.equal(p.shootModel().tilt, 40);
});

test('feedback for a previous target cannot replace the next coalesced target', () => {
  const p = page();
  p.shot(30);
  p.setTilt(60);
  p.advance(0);
  p.own();
  p.setTilt(110);
  p.shot(60);
  assert.equal(p.shootModel().tilt, 110);
  p.advance(120);
  assert.equal(p.sent.filter((frame) => frame.type === 'tilt').at(-1).deg, 110);
  p.shot(60);
  assert.equal(p.shootModel().tilt, 110);
  p.shot(110);
  p.shot(70);
  assert.equal(p.shootModel().tilt, 70);
});

test('bridge stop and page hiding both forget the old requested angle', () => {
  for (const reason of ['bridge', 'hidden']) {
    const p = page();
    p.shot(30);
    p.setTilt(110);
    p.advance(0);
    p.own();
    if (reason === 'bridge')
      p.emit('shoot_state', {
        allowed: true,
        active: false,
        owner: null,
        blockers: [],
        last_stop: { reason: 'controller' },
      });
    else {
      p.document.hidden = true;
      p.events.visibilitychange();
    }
    assert.equal(p.shootModel().session, false);
    p.shot(65);
    assert.equal(p.shootModel().tilt, 65);
    assert.equal(p.shootModel().confirmed, false, 'the safety tick is still cleared');
  }
});
