import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wheelMonitorSample } from '../js/live/wheel-monitor-core.js';
import { wheelRpm } from '../js/live/slam-recorder.js';
const wheel = (raw, filtered, target) => ({
  rpm_raw: raw,
  rpm: filtered,
  target_rpm: target,
  feedback_stamp: 1,
  feedback_valid: true,
});
const drive = () => ({ left: wheel(10, 50, 20), right: wheel(-8, -40, -18) });

test('monitor stores raw, filtered and commanded RPM with forward-positive signs', () => {
  assert.deepEqual(wheelMonitorSample(drive()), {
    left: 10,
    right: 8,
    filteredLeft: 50,
    filteredRight: 40,
    targetLeft: 20,
    targetRight: 18,
  });
  const stopped = drive();
  stopped.left.rpm_raw = stopped.right.rpm_raw = 0;
  const sample = wheelMonitorSample(stopped);
  assert.equal(sample.left, 0);
  assert.equal(sample.right, 0);
  assert.equal(sample.filteredLeft, 50);
});

test('invalid feedback is missing, while generated targets remain available', () => {
  for (const side of ['left', 'right']) {
    const d = drive();
    d[side].feedback_valid = false;
    const sample = wheelMonitorSample(d);
    for (const key of ['left', 'right', 'filteredLeft', 'filteredRight'])
      assert(Number.isNaN(sample[key]), key);
    assert.equal(sample.targetLeft, 20);
  }
});

test('missing raw feedback never borrows the filtered value or invents zero', () => {
  const d = drive();
  delete d.left.rpm_raw;
  const sample = wheelMonitorSample(d);
  assert(Number.isNaN(sample.left));
  assert(Number.isNaN(sample.right));
  assert.equal(sample.filteredLeft, 50);
  assert.equal(sample.filteredRight, 40);
});

test('older bridges retain kinematic measurements and command freshness without a helper', () => {
  const config = { wheel_radius: 0.05, wheel_separation: 0.5 };
  const d = { v: 0.2, w: 0.3, stamp: 2 };
  const twist = { linear: 0.4, angular: 0.1, stamp: 1.5 };
  const measured = wheelRpm(d, config);
  const target = wheelRpm({ v: twist.linear, w: twist.angular }, config);
  const sample = wheelMonitorSample(d, config, twist);
  assert.equal(sample.left, measured.left);
  assert.equal(sample.right, measured.right);
  assert.equal(sample.targetLeft, target.left);
  assert.equal(sample.targetRight, target.right);
  assert(Number.isNaN(sample.filteredLeft));
  assert(Number.isNaN(sample.filteredRight));
  assert(Number.isNaN(wheelMonitorSample(d, config, { ...twist, stamp: 1 }).targetLeft));
  assert.equal(wheelMonitorSample(d), null);
});

test('caption retains its time placeholder and explains measurement, helper and stop cadence', () => {
  const copy = JSON.parse(readFileSync(new URL('../content/live/link.json', import.meta.url)));
  for (const word of [
    '{seconds}',
    '太い実線',
    '生の値',
    '細く薄い線',
    'なめらか',
    '破線',
    '約0.3秒',
  ])
    assert(copy.monitor.wheels.includes(word), word);
});

test('all monitor imports share one module URL, avoiding duplicate subscriptions', () => {
  for (const path of [
    'main.js',
    'motor/ui.js',
    'systems/measurement-lab.js',
    'control/ui.js',
    'slam/ui.js',
    'planning/ui.js',
    'live/records-ui.js',
    'live/robot-state.js',
    'live/record-picker.js',
  ]) {
    const source = readFileSync(new URL('../js/' + path, import.meta.url), 'utf8');
    const imports = [...source.matchAll(/['"]([^'"\n]*live-ui\.js[^'"\n]*)['"]/g)];
    assert.equal(imports.length, 1, path);
    assert(!imports[0][1].includes('?'), path);
  }
});
