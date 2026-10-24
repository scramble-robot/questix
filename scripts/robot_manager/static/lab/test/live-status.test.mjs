import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { liveStatusModel, DISPLAY_STALE_MS } from '../js/live/live-status-core.js';

const open = { phase: 'open' };
const frame = (message, at = 100) => ({ message, at });
test('an unheard E-stop never becomes released from another stream', () => {
  const model = liveStatusModel(
    open,
    { drive_state: frame({ allowed: true, emergency_stop: false }) },
    100,
  );
  assert.equal(model.estop, 'unknown');
  assert.equal(model.drive, 'on');
});
test('fresh pressed/released and silent E-stops stay distinct', () => {
  for (const [active, expected] of [
    [true, 'pressed'],
    [false, 'released'],
  ]) {
    const received = { estop: frame({ active }) };
    assert.equal(liveStatusModel(open, received, 100).estop, expected);
    assert.equal(liveStatusModel(open, received, 100 + DISPLAY_STALE_MS + 1).estop, 'stale');
    assert.equal(liveStatusModel({ phase: 'idle' }, received, 100).estop, 'unknown');
  }
});
test('drive and launcher permissions are independent, unknown and fail-closed as displays', () => {
  const received = {
    drive_state: frame({ allowed: true }),
    shoot_state: frame({ allowed: false }),
  };
  assert.deepEqual(liveStatusModel(open, received, 100), {
    estop: 'unknown',
    drive: 'on',
    shoot: 'off',
  });
  assert.equal(liveStatusModel(open, received, 100 + DISPLAY_STALE_MS + 1).drive, 'unknown');
  assert.equal(liveStatusModel(open, { drive_state: frame({}) }, 100).drive, 'unknown');
});
test('header has three E-stop words and separate accessible explanations for silence', () => {
  const { header } = JSON.parse(
    fs.readFileSync(new URL('../content/live/link.json', import.meta.url)),
  );
  assert.equal(header.estop.unknown, header.estop.stale);
  assert.equal(new Set(Object.values(header.estop)).size, 3);
  assert(!Object.values(header.estop).some((value) => value.includes('途絶')));
  assert.notEqual(header.estopDescription.unknown, header.estopDescription.stale);
});
test('teacher permission and lesson permission have separate reasons and imperative next steps', () => {
  const copy = JSON.parse(
    fs.readFileSync(new URL('../content/live/control-status.json', import.meta.url)),
  );
  assert.equal(copy.no_motion_permission[0], '先生の許可を待っています');
  assert.notEqual(copy.no_motion_permission[0], copy.not_allowed.drive[0]);
  for (const value of Object.values(copy)) {
    for (const pair of Array.isArray(value) ? [value] : Object.values(value))
      assert(pair[1].endsWith('ください'), pair[1]);
  }
});

test('display freshness allows jitter beyond the bridge period but expires after 1.5 seconds', () => {
  const bridge = fs.readFileSync(
    new URL('../../../../../questix_lab_bridge/questix_lab_bridge/bridge_node.py', import.meta.url),
    'utf8',
  );
  const period = Number(bridge.match(/_DRIVE_STATE_PERIOD_SEC\s*=\s*([\d.]+)/)[1]);
  assert.equal(DISPLAY_STALE_MS, 1500);
  assert(DISPLAY_STALE_MS > period * 1000);
  let at = 100;
  const received = {
    drive_state: frame({ allowed: false }, at),
    shoot_state: frame({ allowed: false }, at),
    estop: frame({ active: false }, at),
  };
  for (const interval of [1050, 1200, 1400, 1050]) {
    assert.equal(liveStatusModel(open, received, at + interval - 1).drive, 'off');
    assert.equal(liveStatusModel(open, received, at + interval - 1).estop, 'released');
    at += interval;
    for (const name of Object.keys(received)) received[name].at = at;
    assert.equal(liveStatusModel(open, received, at).drive, 'off');
  }
  assert.equal(liveStatusModel(open, received, at + 1500).drive, 'off');
  assert.equal(liveStatusModel(open, received, at + 1501).drive, 'unknown');
  assert.equal(liveStatusModel(open, received, at + 1501).estop, 'stale');
  received.drive_state = frame({ allowed: true }, at);
  assert.equal(liveStatusModel(open, received, at).drive, 'on');
});
