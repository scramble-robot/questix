// Run with: node --test test/*.test.mjs
//
// The motor course's models (js/motor/core.js): each experiment shows one relation, so these tests
// pin that relation and the numbers the result sentences quote.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  MOTOR_TOPICS,
  PLAYED_TOPICS,
  LOAD_TIME,
  LOAD_TARGET,
  motorDefaults,
  transmissionValues,
  kvSpeed,
  lipoCells,
  evaluateMotorChoices,
  simulateMotor,
  motorRunSummary,
  coilStates,
  coilPoles,
} from '../js/motor/core.js';

const readJson = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
const content = readJson('../content/motor.json');

test('every topic has its texts, in the order of the course', () => {
  assert.deepEqual(
    MOTOR_TOPICS.map((topic) => topic.id),
    Object.keys(content.topics),
  );
  for (const topic of MOTOR_TOPICS) {
    const text = content.topics[topic.id];
    for (const key of ['label', 'title', 'guideTitle', 'explanation', 'footnote'])
      assert.ok(text[key], `${topic.id}.${key}`);
    for (const key of ['scene', 'purpose', 'first']) assert.ok(text.brief[key], topic.id);
    assert.ok(content.groups[topic.group], topic.id);
  }
});

test('a run lasts 6 seconds with a sample every 0.02 s and finite values', () => {
  for (const id of PLAYED_TOPICS) {
    const run = simulateMotor(id, motorDefaults());
    assert.equal(run.samples.length, 301, id);
    assert.equal(run.samples[0].time, 0);
    assert.equal(run.samples.at(-1).time, 6);
    for (const sample of run.samples)
      for (const [key, value] of Object.entries(sample))
        assert.ok(Number.isFinite(value), `${id} ${key} at ${sample.time}`);
  }
  assert.throws(() => simulateMotor('transmission'));
});

test('a fixed field holds the magnet, a switched field turns it both ways', () => {
  const fixed = motorRunSummary(simulateMotor('field', { mode: 'fixed' }));
  assert.ok(Math.abs(fixed.finalDegrees - 90) < 1, String(fixed.finalDegrees));
  const ccw = motorRunSummary(simulateMotor('field', { mode: 'rotate', direction: 1 }));
  const cw = motorRunSummary(simulateMotor('field', { mode: 'rotate', direction: -1 }));
  assert.ok(ccw.turns > 1 && ccw.finalDegrees > 0);
  assert.ok(cw.finalDegrees < 0);
  assert.ok(Math.abs(ccw.turns - cw.turns) < 1e-9);
});

test('a load slows the motor and draws more current, for the same instruction', () => {
  const summary = motorRunSummary(simulateMotor('load', { power: 60, load: 0.08 }));
  assert.ok(summary.afterRpm < summary.beforeRpm * 0.6);
  assert.ok(summary.afterCurrent > summary.beforeCurrent * 3);
  assert.ok(Math.abs(summary.afterHeating - summary.afterCurrent ** 2 * 2) < 1e-9, 'I²R with 2 Ω');
  assert.equal(summary.inTarget, false);
  // The learner can reach the target band by raising the instruction.
  const tuned = motorRunSummary(simulateMotor('load', { power: 90, load: 0.08 }));
  assert.ok(tuned.inTarget, String(tuned.afterRpm));
  assert.ok(Math.abs(tuned.afterRpm - LOAD_TARGET.rpm) <= LOAD_TARGET.tolerance);
  // No current beyond the model's 3 A limit.
  const stalled = simulateMotor('load', { power: 100, load: 0.15 });
  assert.ok(Math.max(...stalled.samples.map((sample) => sample.current)) <= 3);
});

test('gearing trades speed for torque and loses 15 %', () => {
  const direct = transmissionValues(1);
  const three = transmissionValues(3);
  const six = transmissionValues(6);
  assert.equal(direct.rpm, 600);
  assert.ok(Math.abs(direct.torque - 0.1) < 1e-12);
  assert.equal(three.rpm, 200);
  assert.ok(Math.abs(three.torque - 0.255) < 1e-12);
  assert.ok(Math.abs(direct.power - 6.283) < 0.001);
  assert.ok(Math.abs(three.power - 5.341) < 0.001);
  assert.equal(three.teeth, 36);
  // Only the 1/3 reduction meets both goals (5 N and 0.8 m/s).
  assert.deepEqual(
    [direct, three, six].map((values) => [values.forceOk, values.speedOk]),
    [
      [false, true],
      [true, true],
      [true, false],
    ],
  );
  assert.equal(transmissionValues(4).ratio, 1, 'unknown ratios fall back to direct drive');
});

test('KV times volts is the no-load estimate; a load pulls the roller below it', () => {
  assert.equal(kvSpeed(560, 14.8), 8288);
  assert.equal(lipoCells(14.8), 4);
  assert.equal(lipoCells(22.2), 6);
  const free = motorRunSummary(
    simulateMotor('esc', { voltage: 14.8, throttle: 50, loaded: false }),
  );
  assert.equal(free.estimate, 4144);
  assert.ok(Math.abs(free.afterRpm - free.estimate) / free.estimate < 0.01);
  const loaded = motorRunSummary(simulateMotor('esc', { voltage: 14.8, throttle: 50 }));
  assert.ok(loaded.dropPercent > 15 && loaded.dropPercent < 18, String(loaded.dropPercent));
  const run = simulateMotor('esc', {});
  assert.ok(run.samples.every((sample) => sample.reference === 4144));
});

test('the servo returns to its target after the push only while it keeps correcting', () => {
  const held = motorRunSummary(simulateMotor('servo', { target: 90, feedback: true }));
  assert.ok(held.maxDeviation > 1, 'the push moves the arm');
  assert.ok(held.finalError < 0.5, String(held.finalError));
  assert.ok(held.holdingTorque > 0.1, 'holding still needs torque');
  const free = motorRunSummary(simulateMotor('servo', { target: 90, feedback: false }));
  assert.ok(free.finalError > 45, String(free.finalError));
  assert.equal(free.holdingTorque, 0);
  const run = simulateMotor('servo', { target: 200 });
  assert.equal(run.samples.at(-1).reference, 120, 'targets are limited to the feed range');
  const beforePush = run.samples.filter((sample) => sample.time < LOAD_TIME);
  assert.ok(beforePush.every((sample) => sample.load === 0));
});

test('the coils facing the field light up with the pole that pulls the magnet', () => {
  const coils = coilStates(Math.PI / 2, true);
  assert.deepEqual(
    coils.map((coil) => [coil.degrees, coil.on, coil.pole]),
    [
      [0, false, null],
      [90, true, 'S'],
      [180, false, null],
      [270, true, 'N'],
    ],
  );
  assert.ok(coilStates(0, false).every((coil) => !coil.on));
  assert.equal(coilPoles(0), null);
  assert.deepEqual(coilPoles(1), { left: 'S', right: 'N' });
  assert.deepEqual(coilPoles(-1), { left: 'N', right: 'S' });
});

test('each job has exactly one suitable instruction', () => {
  assert.deepEqual(evaluateMotorChoices({ drive: 'speed', roller: 'drive', feeder: 'angle' }), {
    drive: true,
    roller: true,
    feeder: true,
  });
  assert.deepEqual(evaluateMotorChoices({ drive: 'angle' }), {
    drive: false,
    roller: false,
    feeder: false,
  });
});
