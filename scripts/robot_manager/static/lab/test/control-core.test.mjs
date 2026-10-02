// Run with: node --test test/*.test.mjs
//
// These tests pin the public behaviour of js/control/core.js: the numbers below were taken from
// the module as it was before the course was rewritten, so a refactor that changes a simulated
// run, a metric or the exported CSV fails here. Set LAB_BASELINE=<path to a copy of the site>
// to additionally deep-compare every run against that copy's core.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CONTROL_GROUPS,
  CONTROL_TOPICS,
  LAST_SAMPLE,
  controlDefaults,
  normalizeControlConfig,
  pidStep,
  controlConceptStep,
  controlMethod,
  controlLoad,
  simulateControl,
  controlCSV,
  controlCalibration,
} from '../js/control/core.js';

const round = (value) => (typeof value === 'number' ? Number(value.toFixed(6)) : value);
const rounded = (object) =>
  Object.fromEntries(Object.entries(object).map(([key, value]) => [key, round(value)]));

// topic id → what a run with that topic's own default settings produces.
const EXPECTED = {
  output: {
    method: 'fixed',
    loadCase: 'nominal',
    metrics: { finalError: 30, overshoot: 0, settling: null, after: 0, tolerance: 3 },
    last: { actual: 30, command: 30 },
  },
  feedforward: {
    method: 'feedforward',
    loadCase: 'nominal',
    metrics: { finalError: 0, overshoot: 0, settling: 1.2, after: 0, tolerance: 3 },
    last: { actual: 60, command: 60 },
  },
  feedback: {
    method: 'fixed',
    loadCase: 'drag',
    metrics: { finalError: 15, overshoot: 0, settling: null, after: 5, tolerance: 3 },
    last: { actual: 45, command: 60 },
  },
  combined: {
    method: 'feedforward',
    loadCase: 'drag',
    metrics: { finalError: 15, overshoot: 0, settling: null, after: 5, tolerance: 3 },
    last: { actual: 45, command: 60 },
  },
  p: {
    method: 'feedback',
    loadCase: 'drag',
    metrics: { finalError: 34.090909, overshoot: 0, settling: null, after: 5, tolerance: 3 },
    last: { actual: 25.909091, command: 40.909091 },
  },
  i: {
    method: 'feedback',
    loadCase: 'drag',
    metrics: { finalError: 34.090909, overshoot: 0, settling: null, after: 5, tolerance: 3 },
    last: { actual: 25.909091, command: 40.909091 },
  },
  d: {
    method: 'feedback',
    loadCase: 'drag',
    metrics: {
      finalError: 0.00013,
      overshoot: 0.132871,
      settling: 6.15,
      after: 0,
      tolerance: 0.05,
    },
    last: { actual: 0.499956, command: -0.012363 },
  },
  reference: {
    method: 'both',
    loadCase: 'nominal',
    metrics: {
      finalError: 0.000057,
      overshoot: 8.061815,
      settling: 0.95,
      after: 0,
      tolerance: 3,
    },
    last: { actual: 60.000028, command: 60.00002 },
  },
  limits: {
    method: 'feedback',
    loadCase: 'drag',
    metrics: {
      finalError: 1.932024,
      overshoot: 39.999998,
      settling: 7.45,
      after: 7,
      tolerance: 3,
    },
    last: { actual: 60.149126, command: 60.045706 },
  },
  noise: {
    method: 'feedback',
    loadCase: 'drag',
    metrics: {
      finalError: 0.000212,
      overshoot: 0.010429,
      settling: 4.2,
      after: 0,
      tolerance: 0.05,
    },
    last: { actual: 0.499649, command: -36.065364 },
  },
  challenge: {
    method: 'feedback',
    loadCase: 'drag',
    metrics: {
      finalError: 0.00013,
      overshoot: 0.132871,
      settling: 6.15,
      after: 0,
      tolerance: 0.05,
    },
    last: { actual: 0.499956, command: -0.012363 },
  },
};

test('every topic has the content a lesson page needs', () => {
  assert.equal(CONTROL_GROUPS.length, 4);
  assert.equal(CONTROL_TOPICS.length, 11);
  for (const topic of CONTROL_TOPICS) {
    for (const key of ['id', 'name', 'title', 'scene', 'purpose', 'first', 'question', 'sensor'])
      assert.ok(topic[key], `${topic.id}.${key}`);
    assert.ok(['speed', 'distance'].includes(topic.mode), topic.id);
    assert.ok(topic.group >= 0 && topic.group < CONTROL_GROUPS.length, topic.id);
  }
  assert.deepEqual(
    CONTROL_TOPICS.map((topic) => topic.id),
    Object.keys(EXPECTED),
  );
});

test('a default run of each topic is unchanged', () => {
  for (const [id, expected] of Object.entries(EXPECTED)) {
    const run = simulateControl(id);
    assert.equal(run.samples.length, LAST_SAMPLE + 1, id);
    assert.equal(run.duration, 16, id);
    assert.equal(run.method, expected.method, id);
    assert.equal(run.loadCase, expected.loadCase, id);
    assert.equal(run.collision, false, id);
    assert.equal(run.target, run.mode === 'distance' ? 0.5 : 60, id);
    for (const [key, value] of Object.entries(expected.metrics))
      assert.equal(round(run.metrics[key]), value, `${id}.metrics.${key}`);
    assert.equal(round(run.samples.at(-1).actual), expected.last.actual, `${id}.last.actual`);
    assert.equal(round(run.samples.at(-1).command), expected.last.command, `${id}.last.command`);
  }
});

test('samples are evenly spaced and carry every series the graphs draw', () => {
  const run = simulateControl('combined', { strategy: 'both' });
  for (const [index, sample] of run.samples.entries()) {
    assert.equal(round(sample.time), round(index * 0.05), 'sample ' + index);
    for (const key of ['target', 'ff', 'correction', 'measured', 'actual', 'command', 'rpm'])
      assert.ok(Number.isFinite(sample[key]), `${key} at ${index}`);
  }
  assert.equal(run.samples[0].time, 0);
  assert.equal(round(run.samples.at(-1).time), 16);
});

test('commands stay inside the motor limits, and the blocked wheel stops', () => {
  const run = simulateControl('limits', { antiWindup: false });
  assert.ok(run.samples.every((sample) => Math.abs(sample.command) <= 100 + 1e-9));
  const blocked = run.samples.filter((sample) => sample.blocked);
  assert.equal(blocked.length, 80, '3 s … 7 s at one sample per 0.05 s');
  // The sample is recorded before the step that stops the wheel, so the first one still shows
  // the speed the wheel had when the load arrived.
  assert.ok(blocked.slice(1).every((sample) => sample.actual === 0));
  assert.ok(blocked[0].actual > 59);
  // Without anti-windup the integral keeps growing while the output is saturated.
  const withWindup = run.samples.find((sample) => sample.time === 7).i;
  const withoutWindup = simulateControl('limits', { antiWindup: true }).samples.find(
    (sample) => sample.time === 7,
  ).i;
  assert.ok(withWindup > withoutWindup * 2, `${withWindup} vs ${withoutWindup}`);
});

test('the challenge is passed by a sensible tuning and not by a violent one', () => {
  const tuned = simulateControl('challenge', { kp: 2.2, ki: 0, kd: 1 });
  assert.equal(tuned.metrics.passed, true);
  assert.equal(round(tuned.metrics.settling), 4.2);
  assert.ok(tuned.metrics.overshoot <= 0.1);
  const heavy = simulateControl('challenge', { scenario: 'heavy', kp: 2.6, kd: 1.1 });
  assert.equal(heavy.metrics.passed, true);
  assert.equal(round(heavy.metrics.settling), 6.25);
  const violent = simulateControl('challenge', { kp: 8, ki: 6, kd: 0 });
  assert.equal(violent.metrics.passed, false);
  assert.equal(violent.metrics.settling, null);
});

test('defaults are per topic and settings are clamped to their slider range', () => {
  assert.deepEqual(controlDefaults('output').power, 30);
  assert.deepEqual(controlDefaults('feedback').feedback, false);
  assert.deepEqual(controlDefaults('noise').filter, 0);
  assert.throws(() => controlDefaults('nope'), /Unknown control lesson/);
  const clamped = normalizeControlConfig('p', { kp: 99, ki: -4, kd: 12, targetRPM: 5 });
  assert.equal(clamped.kp, 8);
  assert.equal(clamped.ki, 0);
  assert.equal(clamped.kd, 3);
  assert.equal(clamped.targetRPM, 20);
  assert.throws(() => normalizeControlConfig('p', { kp: 'fast' }), /数値/);
  assert.throws(() => normalizeControlConfig('challenge', { scenario: 'wet' }), /Unknown scenario/);
  assert.throws(
    () => normalizeControlConfig('combined', { strategy: 'guess' }),
    /Unknown control condition/,
  );
});

test('method and load follow the topic, not only the settings', () => {
  assert.equal(controlMethod('output', controlDefaults('output')), 'fixed');
  assert.equal(controlMethod('feedback', { feedback: false }), 'fixed');
  assert.equal(controlMethod('feedback', { feedback: true }), 'feedback');
  assert.equal(controlMethod('combined', { strategy: 'feedback' }), 'feedback');
  assert.equal(controlMethod('reference', {}), 'both');
  assert.equal(controlLoad('output', { loadCase: 'drag' }), 'nominal');
  assert.equal(controlLoad('feedforward', { loadCase: 'mismatch' }), 'mismatch');
  assert.equal(controlLoad('p', { loadCase: 'nominal' }), 'drag');
});

test('pidStep saturates, and anti-windup stops the integral growing further', () => {
  const free = {};
  const step = pidStep(free, { error: 0.1, measurement: 0, kp: 2, ki: 1, kd: 0, dt: 0.05 });
  assert.equal(round(step.p), 0.2);
  assert.equal(round(step.i), 0.005);
  assert.equal(round(step.command), 0.205);
  const saturated = { integral: 2 };
  pidStep(saturated, { error: 1, measurement: 0, kp: 1, ki: 1, kd: 0, dt: 0.05 });
  assert.equal(saturated.integral, 2, 'held while the output is already above the limit');
  const winding = { integral: 2 };
  const out = pidStep(winding, {
    error: 1,
    measurement: 0,
    kp: 1,
    ki: 1,
    kd: 0,
    dt: 0.05,
    antiWindup: false,
  });
  assert.equal(round(winding.integral), 2.05);
  assert.equal(out.command, 1, 'the command itself is always clamped');
});

test('the worked P / I / D example matches the numbers in the lesson text', () => {
  assert.deepEqual(rounded(controlConceptStep('p', 50)), {
    error: 10,
    correction: 12,
    command: 12,
  });
  assert.deepEqual(rounded(controlConceptStep('p', 70)), {
    error: -10,
    correction: -12,
    command: -12,
  });
  assert.deepEqual(rounded(controlConceptStep('p', 60)), { error: 0, correction: 0, command: 0 });
  assert.deepEqual(rounded(controlConceptStep('i', 50)), {
    error: 10,
    correction: 10,
    command: 10,
  });
  assert.deepEqual(rounded(controlConceptStep('i', 50, 10)), {
    error: 10,
    correction: 20,
    command: 20,
  });
  assert.deepEqual(rounded(controlConceptStep('d', 0.8)), {
    error: -0.2,
    correction: -20,
    command: -20,
  });
  assert.deepEqual(rounded(controlConceptStep('d', 1.2)), {
    error: 0.2,
    correction: 20,
    command: 20,
  });
  assert.deepEqual(rounded(controlConceptStep('d', 1)), { error: 0, correction: 0, command: 0 });
});

test('the calibration table is the steady speed of three fixed commands', () => {
  assert.deepEqual(
    controlCalibration().map((point) => ({ power: point.power, rpm: round(point.rpm) })),
    [
      { power: 20, rpm: 20 },
      { power: 40, rpm: 40 },
      { power: 60, rpm: 60 },
    ],
  );
});

test('the CSV keeps its header, one row per sample and the settings on every row', () => {
  const csv = controlCSV(simulateControl('p'));
  assert.ok(csv.startsWith('﻿'), 'byte order mark for spreadsheets');
  const lines = csv.split('\r\n');
  assert.equal(lines.length, LAST_SAMPLE + 2, 'header plus one row per sample');
  assert.equal(
    lines[0],
    '﻿time_s,target_rpm,measured_rpm,actual_rpm,command_percent,wheel_rpm,p_percent,' +
      'i_percent,d_percent,feedforward_percent,feedback_percent,lesson,scenario,kp,ki,kd,' +
      'filter_s,anti_windup,feedback,fixed_power_percent,target_rpm,ff_gain,load_case,strategy,' +
      'reference_profile',
  );
  assert.equal(
    lines[1],
    '0.0000,60.0000,0.0000,0.0000,72.0000,0.0000,72.0000,0.0000,0.0000,0.0000,72.0000,' +
      'p,standard,1.2,0,0,0.12,true,true,60,60,1,drag,feedback,step',
  );
  const columns = lines[0].split(',').length;
  for (const line of lines.slice(1)) assert.equal(line.split(',').length, columns);
  assert.ok(controlCSV(simulateControl('d')).startsWith('﻿time_s,target_m,measured_m,actual_m,'));
});

// Optional: a full deep comparison against another copy of the site, e.g. the one the rewrite
// started from. Skipped when LAB_BASELINE is not set.
const baseline = process.env.LAB_BASELINE;
test(
  'every run is identical to the baseline copy of core.js',
  { skip: !baseline || !fs.existsSync(`${baseline}/js/control/core.js`) },
  async () => {
    const before = await import(`${baseline}/js/control/core.js`);
    assert.deepEqual(CONTROL_GROUPS, before.CONTROL_GROUPS);
    assert.deepEqual(CONTROL_TOPICS, before.CONTROL_TOPICS);
    for (const topic of CONTROL_TOPICS) {
      assert.deepEqual(controlDefaults(topic.id), before.controlDefaults(topic.id));
      const run = simulateControl(topic.id);
      assert.deepEqual(run, before.simulateControl(topic.id), topic.id);
      assert.equal(controlCSV(run), before.controlCSV(before.simulateControl(topic.id)), topic.id);
    }
    assert.deepEqual(controlCalibration(), before.controlCalibration());
  },
);
