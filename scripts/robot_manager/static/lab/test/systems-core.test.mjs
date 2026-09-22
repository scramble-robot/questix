// Pins the DOM-free maths of the "systems" courses (js/systems/core.js, measurement-core.js) to
// the baseline copy of the site: every simulation, transform and parser must give the same result
// for the same input. Run with `node --test test/*.test.mjs`.

import assert from 'node:assert/strict';
import { test } from 'node:test';

// The pre-refactor modules are kept in test/baseline/ (see its README), so this runs in CI too.
const BASELINE = new URL('./baseline/js/systems/', import.meta.url).href;

const current = await import('../js/systems/core.js');
const baseline = await import(BASELINE + 'core.js');
const currentMeasurement = await import('../js/systems/measurement-core.js');
const baselineMeasurement = await import(BASELINE + 'measurement-core.js');
const { SYSTEM_TOPICS } = await import('../js/systems/data.js');

// Every topic is simulated with its defaults plus a few variations that reach the other branches
// (contact, latch, detour, turn, ...). Values outside the allowed range test the clamping too.
const VARIATIONS = {
  'mechanics/force': [
    { mass: 12, power: 100 },
    { mass: 4, power: 20 },
    { mass: '99', power: 0 },
  ],
  'mechanics/traction': [
    { grip: 0.2, power: 100, mass: 4 },
    { grip: 1, power: 50 },
  ],
  'mechanics/braking': [
    { initialSpeed: 1.2, brakeAt: 0.2, mass: 12, grip: 0.3 },
    { initialSpeed: 0.3, brakeAt: 2.5 },
    { brakeAt: 0 },
  ],
  'behavior/sequence': [{ obstacle: 'none' }, { obstacle: 'temporary' }, { obstacle: 'permanent' }],
  'behavior/blocked': [
    { obstacle: 'permanent', blockedRule: 'detour', timeout: 1 },
    { obstacle: 'permanent', blockedRule: 'wait', timeout: 3 },
    { obstacle: 'temporary', blockedRule: 'detour', timeout: 5 },
  ],
  'behavior/missing': [{ searchRule: 'search' }, { searchRule: 'ignore' }],
  'tracking/velocity': [
    { interval: 0.5, noise: 0.05, smoothing: 0.3 },
    { interval: 0.1, noise: 0, smoothing: 1 },
  ],
  'tracking/prediction': [
    { motion: 'turn', horizon: 2, noise: 0.02 },
    { motion: 'straight', horizon: 0.5, noise: 0 },
  ],
  'tracking/crossing': [
    { rule: 'predict', interval: 0.2, horizon: 1.5 },
    { rule: 'current', interval: 0.4, horizon: 1 },
    { rule: 'current', interval: 0.1, horizon: 3 },
  ],
  'coordination/frames': [
    { transform: false },
    { transform: true, cameraX: 10, cameraZ: 60, cameraAngle: -20 },
  ],
  'coordination/calibrate': [{ cameraX: 40, cameraZ: 30, cameraAngle: 10 }, { cameraAngle: 45 }],
  'coordination/feedback': [
    { lookAgain: 'repeat', interval: 0.5 },
    { lookAgain: 'once', interval: 1 },
  ],
  'timing/delay': [
    { latency: 0.6, compensate: false },
    { latency: 0.6, compensate: true },
    { latency: 0, compensate: false },
  ],
  'timing/alignment': [
    { align: 'stamp', latency: 0.5 },
    { align: 'now', latency: 0.5 },
  ],
  'timing/queue': [
    { queue: 'latest', processing: 5 },
    { queue: 'all', processing: 5 },
    { queue: 'all', processing: 20 },
  ],
  'diagnostics/distance': [
    { sensorRule: 'both', stopDistance: 0.6 },
    { sensorRule: 'lidar', stopDistance: 1.2 },
    { sensorRule: 'both', stopDistance: 0.1 },
  ],
  'diagnostics/missing': [
    { watchdog: true, staleLimit: 0.5 },
    { watchdog: false, staleLimit: 1 },
  ],
  'diagnostics/impact': [
    { eventType: 'bump', impactLimit: 4 },
    { eventType: 'bump', impactLimit: 8 },
    { eventType: 'impact', impactLimit: 8 },
    { eventType: 'impact', impactLimit: 20 },
  ],
};

const topics = Object.entries(SYSTEM_TOPICS).flatMap(([course, list]) =>
  list.map((topic) => [course, topic.id]),
);

for (const [course, topic] of topics) {
  const inputs = [{}, ...(VARIATIONS[`${course}/${topic}`] || [])];
  test(`simulateSystem ${course}/${topic} matches the baseline`, () => {
    for (const input of inputs) {
      const expected = baseline.simulateSystem(course, topic, input);
      const actual = current.simulateSystem(course, topic, input);
      assert.deepEqual(actual, expected, JSON.stringify(input));
      assert.equal(current.systemCSV(actual), baseline.systemCSV(expected));
    }
  });
  test(`validateSystemConfig ${course}/${topic} matches the baseline`, () => {
    const odd = [{}, { unknown: 1 }, ...inputs.map((input) => ({ ...input, noise: 'x' }))];
    for (const input of odd)
      assert.deepEqual(
        current.validateSystemConfig(course, topic, input),
        baseline.validateSystemConfig(course, topic, input),
      );
  });
}

test('validateSystemConfig rejects an unknown experiment', () => {
  assert.throws(() => current.validateSystemConfig('mechanics', 'nope'), /Unknown experiment/);
  assert.throws(() => current.validateSystemConfig('nope', 'force'), /Unknown experiment/);
});

test('camera transforms match the baseline and invert each other', () => {
  const cameras = [
    undefined,
    { cameraX: 40, cameraZ: 30, cameraAngle: 10 },
    { cameraX: -12.5, cameraZ: 80, cameraAngle: -37 },
  ];
  const points = [
    { x: 0, z: 0 },
    { x: 140, z: 80 },
    { x: -30, z: 210.5 },
  ];
  for (const camera of cameras)
    for (const point of points) {
      assert.deepEqual(current.bodyToCamera(point, camera), baseline.bodyToCamera(point, camera));
      const reading = current.bodyToCamera(point, camera);
      const fallback = camera ?? { cameraX: 40, cameraZ: 30, cameraAngle: 10 };
      assert.deepEqual(
        current.cameraToBody(reading, fallback),
        baseline.cameraToBody(reading, fallback),
      );
      const back = current.cameraToBody(reading, fallback);
      assert.ok(Math.abs(back.x - point.x) < 1e-9 && Math.abs(back.z - point.z) < 1e-9);
    }
});

test('calibrationPairs and fitCameraTransform match the baseline', () => {
  const pairs = current.calibrationPairs();
  assert.deepEqual(pairs, baseline.calibrationPairs());
  assert.deepEqual(current.fitCameraTransform(pairs), baseline.fitCameraTransform(pairs));
  const skewed = pairs.map((pair) => ({
    ...pair,
    camera: { x: pair.camera.x + 3, z: pair.camera.z },
  }));
  assert.deepEqual(current.fitCameraTransform(skewed), baseline.fitCameraTransform(skewed));
  assert.throws(() => current.fitCameraTransform([pairs[0]]), /離れた2点以上の対応が必要です。/);
  assert.throws(
    () => current.fitCameraTransform([pairs[0], { ...pairs[0] }]),
    /目印を離して測ってください。/,
  );
  assert.throws(
    () =>
      current.fitCameraTransform([pairs[0], { body: { x: 1, z: NaN }, camera: { x: 1, z: 1 } }]),
    /離れた2点以上の対応が必要です。/,
  );
});

test('canRestart needs a latched stop, a cleared cause and an operator request', () => {
  for (const latched of [true, false])
    for (const cleared of [true, false])
      for (const request of [true, false])
        assert.equal(
          current.canRestart(latched, cleared, request),
          baseline.canRestart(latched, cleared, request),
        );
  assert.equal(current.canRestart(true, true, true), true);
  assert.equal(current.canRestart(undefined, true, true), false);
});

test('measurementStats matches the baseline', () => {
  const samples = [[], [3], [1, 2, 3, 4], [2.5, 2.5, 2.5], [1, NaN], [-4, 10, 0.5]];
  for (const values of samples)
    assert.deepEqual(
      currentMeasurement.measurementStats(values),
      baselineMeasurement.measurementStats(values),
    );
});

test('fitMeasurement matches the baseline', () => {
  const rows = [
    [],
    [{ x: 1, y: 2, test: false }],
    [
      { x: 1, y: 2, test: false },
      { x: 1, y: 3, test: false },
    ],
    [
      { x: 20, y: 28, test: false },
      { x: 40, y: 52, test: false },
      { x: 60, y: 76.6, test: false },
      { x: 50, y: 65, test: true },
      { x: 90, y: 110, test: true },
    ],
    [
      { x: 20, y: 28, test: false },
      { x: 40, y: NaN, test: false },
    ],
    [
      { x: 20, y: 28, test: true },
      { x: 40, y: 52, test: true },
    ],
  ];
  for (const table of rows)
    assert.deepEqual(
      currentMeasurement.fitMeasurement(table),
      baselineMeasurement.fitMeasurement(table),
    );
});

test('parseMeasurementCSV matches the baseline, including its errors', () => {
  const texts = [
    'x,y,test\n20,28,0\n40,52,1',
    '﻿X, Y, Test\r\n20,28\r\n# comment\r\n40,52,1\r\n',
    '20,28,0',
    '',
    'x,y,test\n20,abc,0',
    'x,y,test\n20,28,2',
    'x,y,test\n20',
    'x,y,test\n1,2,3,4',
    Array.from({ length: 201 }, (_, i) => `${i},${i}`).join('\n'),
    Array.from({ length: 200 }, (_, i) => `${i},${i},${i % 2}`).join('\n'),
  ];
  for (const text of texts) {
    let expected;
    try {
      expected = { value: baselineMeasurement.parseMeasurementCSV(text) };
    } catch (error) {
      expected = { error: error.message };
    }
    let actual;
    try {
      actual = { value: currentMeasurement.parseMeasurementCSV(text) };
    } catch (error) {
      actual = { error: error.message };
    }
    assert.deepEqual(actual, expected, JSON.stringify(text).slice(0, 60));
  }
});
