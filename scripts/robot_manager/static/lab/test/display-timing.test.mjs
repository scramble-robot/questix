import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DISPLAY_STALE_MS,
  TIMING_WINDOW_MS,
  TIMING_CONFIRM_MS,
  CLOCK_STEP_MARGIN_MS,
  createDisplayTiming,
  observeDisplayTiming,
  displayTimingModel,
} from '../js/live/display-timing.js';
import { liveStatusModel } from '../js/live/live-status-core.js';
const open = { phase: 'open' };
function fixture(offset = 0, rate = 1) {
  let now = 0;
  const timing = createDisplayTiming(),
    received = {};
  const stamp = (at) => offset + (at / 1000) * rate;
  function feed(at, source = at, active = false, bridge) {
    if (arguments.length < 4) bridge = stamp(source);
    now = at;
    const message = { active, bridge_stamp: bridge };
    observeDisplayTiming(timing, message, at);
    received.estop = { at, message };
    return model(at);
  }
  function model(at = now) {
    return liveStatusModel(open, received, at, displayTimingModel(timing, at));
  }
  function permissions(at = now + 1) {
    received.drive_state = { at, message: { allowed: true } };
    received.shoot_state = { at, message: { allowed: true } };
    return model(at);
  }
  function normal(start = 0, stop = 2000, interval = 20) {
    for (let at = start; at <= stop; at += interval) feed(at);
    return permissions(stop + 1);
  }
  return { timing, received, feed, model, permissions, normal, stamp };
}

test('startup confirms at least one second and three progressing samples before showing released', () => {
  const f = fixture(-31536000);
  for (const at of [0, 100, 999]) {
    assert.equal(f.feed(at).estop, 'checking');
    assert.notEqual(f.permissions(at + 0.1).drive, 'on');
  }
  assert.equal(f.feed(1000).estop, 'released');
  assert.equal(f.permissions(1001).drive, 'on');
  const slow = fixture();
  slow.feed(0);
  assert.equal(slow.feed(1000).estop, 'checking', 'two frames are insufficient');
  assert.equal(slow.feed(1020).estop, 'released');
});
test('neither absolute robot time nor page wall time is used', () => {
  for (const offset of [-31536000, -3 * 86400, 0, 3 * 3600, 1720000000]) {
    const f = fixture(offset);
    assert.equal(f.normal().estop, 'released');
    assert.equal(f.feed(5500, 2020).estop, 'delayed');
    assert.notEqual(f.permissions(5501).drive, 'on');
  }
  const source = fs.readFileSync(new URL('../js/live/display-timing.js', import.meta.url), 'utf8');
  assert(!source.includes('Date.now'));
});
test('delay of exactly 2.5 s is allowed; a larger known delay never displays released or permission', () => {
  const f = fixture();
  f.normal();
  // Continuous arrival: the local gap itself stays at or below 2.5 s.
  f.feed(3000, 2000.001); // positive source progress, delay ~1000 ms
  assert.equal(f.feed(3500, 2000.001).estop, 'checking', 'repeated stamp invalidates the clock');
  const g = fixture();
  g.normal();
  for (let at = 2020; at <= 4500; at += 20) g.feed(at, 2000 + (at - 2000) / 250);
  assert.equal(g.feed(4520, 2020).estop, 'released');
  assert.equal(g.feed(4540, 2039).estop, 'delayed');
  assert.equal(g.permissions(4541).drive, 'delayed');
});
test('receive-time expiry remains independent of timing estimate', () => {
  const f = fixture();
  f.normal();
  assert.equal(f.model(4500).estop, 'released');
  assert.equal(f.model(4501).estop, 'stale');
  assert.notEqual(f.model(4501).drive, 'on');
});
test('last good baseline survives a 60 s outage and queued old released values', () => {
  const f = fixture();
  f.normal();
  for (let source = 2020, at = 62000; source < 6000; source += 20, at += 1) {
    assert.notEqual(f.feed(at, source).estop, 'released');
    assert.notEqual(f.permissions(at + 0.1).drive, 'on');
  }
  assert.equal(f.timing.baseline, 0);
});
test('delay recovery needs <=1250 ms for a second and three progressing values', () => {
  const f = fixture();
  f.normal();
  f.feed(5500, 2020);
  let at = 5500,
    source = 2020;
  while (at - source > 2000) {
    at += 20;
    source += 40;
    assert.equal(f.feed(at, source).estop, 'delayed');
  }
  for (let n = 0; n < 60; n++) {
    at += 20;
    source += 20;
    assert.equal(f.feed(at, source).estop, 'delayed');
  }
  while (at - source > 500) {
    at += 20;
    source += 40;
    assert.equal(f.feed(at, source).estop, 'delayed');
  }
  for (let n = 0; n < 50; n++) {
    at += 20;
    source += 20;
    f.feed(at, source);
  }
  assert.equal(f.model(at).estop, 'released');
});
test('alternating good and delayed input cannot repeatedly clear the delayed state', () => {
  const f = fixture();
  f.normal();
  f.feed(5500, 2020);
  let normal = 0;
  for (let n = 0; n < 40; n++) {
    const at = 5520 + n * 100,
      source = at - (n % 2 ? 3000 : 500);
    if (f.feed(at, source).estop === 'released') normal++;
  }
  assert.equal(normal, 0);
});
test('backward, forward and repeated clock values rebuild instead of releasing', () => {
  for (const jump of [-86400, 86400, 0]) {
    const f = fixture(10000);
    f.normal();
    const value = jump === 0 ? f.stamp(2000) : f.stamp(2020) + jump;
    assert.equal(f.feed(2020, 2020, false, value).estop, 'checking');
    assert.notEqual(f.permissions(2021).drive, 'on');
    for (let at = 2040; at < 3020; at += 20)
      assert.equal(f.feed(at, at, false, value + (at - 2020) / 1000).estop, 'checking');
    assert.equal(f.feed(3040, 3040, false, value + 1.02).estop, 'released');
  }
});
test('stopped and missing/non-numeric clocks never turn fresh permissions on', () => {
  for (const value of [undefined, null, '100', NaN, Infinity, -Infinity]) {
    const f = fixture();
    f.normal();
    for (let at = 2020; at < 5000; at += 20) {
      assert.equal(
        f.feed(at, at, false, value === undefined ? undefined : value).estop,
        'checking',
      );
      assert.notEqual(f.permissions(at + 0.1).drive, 'on');
    }
    assert.equal(f.normal(5020, 7040).estop, 'released');
  }
  const f = fixture();
  f.normal();
  for (let at = 2020; at < 5000; at += 20) assert.equal(f.feed(at, at, false, 2).estop, 'checking');
});
test('slow drift is bounded by the 30 s window, not the epoch or connection duration', () => {
  for (const ppm of [-1000, -100, 100, 1000]) {
    const f = fixture(1720000000, 1 + ppm / 1e6);
    f.normal();
    let largest = 0;
    for (let at = 2020; at <= 180000; at += 20) {
      assert.equal(f.feed(at).estop, 'released');
      largest = Math.max(largest, f.timing.delay);
    }
    assert(largest <= (Math.abs(ppm) / 1e6) * TIMING_WINDOW_MS + 0.1, `${ppm}: ${largest}`);
  }
});
test('burst replay at connection startup cannot finish confirmation before its source settles', () => {
  const f = fixture();
  for (let n = 0; n < 200; n++) assert.equal(f.feed(n * 10, n * 100).estop, 'checking');
  const stretched = fixture();
  for (let n = 0; n < 400; n++) assert.notEqual(stretched.feed(n * 20, n * 10).estop, 'released');
  // A constant delay already present at first connection is fundamentally indistinguishable.
  const g = fixture();
  for (let at = 0; at < 1000; at += 20) assert.equal(g.feed(at, at - 10000).estop, 'checking');
  assert.equal(g.feed(1000, -9000).estop, 'released');
});
test('reconnection discards old baseline and confirmation cannot reuse old permission frames', () => {
  const f = fixture();
  f.normal();
  const fresh = fixture(10800);
  assert.equal(fresh.feed(0).estop, 'checking');
  fresh.permissions(10);
  for (let at = 20; at <= 1000; at += 20) fresh.feed(at);
  assert.notEqual(fresh.model(1000).drive, 'on');
  assert.equal(fresh.permissions(1001).drive, 'on');
});
test('all texts cover delay/checking and the estimate remains in display adapters only', () => {
  for (const state of ['checking', 'delayed']) {
    const read = (n) =>
      JSON.parse(fs.readFileSync(new URL('../content/live/' + n + '.json', import.meta.url)));
    assert(read('link').header.estopDescription[state].includes('受信'));
    assert(read('robot-state').estop[state].includes('受信'));
    assert(read('robot-state').strip.estop[state].includes('受信'));
    assert(read('shoot').estop[state].includes('受信'));
  }
  for (const name of ['drive-link', 'shoot-link', 'drive-core', 'shoot-core']) {
    const source = fs.readFileSync(new URL('../js/live/' + name + '.js', import.meta.url), 'utf8');
    assert(!source.includes('display-timing') && !source.includes('liveStatus('), name);
  }
  assert.equal(DISPLAY_STALE_MS, 2500);
  assert.equal(TIMING_CONFIRM_MS, 1000);
  assert.equal(CLOCK_STEP_MARGIN_MS, 250);
});

test('successive +2 s steps cannot be absorbed when the 30 s window expires', () => {
  const f = fixture();
  let at = 0;
  for (let source = 0; source <= 120000; source += 50) {
    const delay = source >= 80000 ? 4000 : source >= 40000 ? 2000 : 0;
    at = source + delay;
    const result = f.feed(at, source);
    if (source >= 80000) assert.equal(result.estop, 'delayed');
  }
  assert(f.timing.baseline < 100, 'rise budget is not accumulated from the old minimum timestamp');
});

test('unheard/silent estop differs from a flowing clock being checked', () => {
  const f = fixture();
  assert.equal(displayTimingModel(f.timing, 0).mode, 'unheard');
  let result = f.permissions(1);
  assert.equal(result.estop, 'unknown');
  assert.equal(result.drive, 'unknown');
  assert.equal(result.permissionReason, 'estop_unknown');
  f.normal();
  result = f.model(4501);
  assert.equal(displayTimingModel(f.timing, 4501).mode, 'silent');
  assert.equal(result.estop, 'stale');
  assert.equal(result.drive, 'unknown');
  assert.equal(result.permissionReason, 'estop_stale');
  assert.equal(f.feed(5000).estop, 'checking');
  for (let at = 5020; at <= 6040; at += 20) f.feed(at);
  assert.equal(f.model(6040).estop, 'released');
  assert.equal(f.permissions(6041).drive, 'on');
});

test('the baseline can immediately move down without using the rise budget', () => {
  const f = fixture();
  f.normal();
  assert.equal(f.feed(2020, 2220).estop, 'released');
  assert(f.timing.baseline < -199.9);
});
