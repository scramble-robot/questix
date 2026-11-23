import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  loadAngleJson,
  toRpm,
  fromRpm,
  formatWheelRate,
  formatTurnRate,
  formatHeading,
  unitWords,
} from '../js/core/angle-units.js';
import { fillSentence } from '../js/core/content.js';
import { formatNumber } from '../js/core/dom.js';
import { createStateTracker, ingest, robotStateModel } from '../js/live/robot-state-core.js';

globalThis.document ??= {
  createComment: () => ({}),
  createTreeWalker: () => ({}),
  createElement: () => ({}),
  importNode: () => ({}),
  addEventListener() {},
  removeEventListener() {},
  getElementById: () => null,
  querySelectorAll: () => [],
  body: {},
};
globalThis.MutationObserver ??= class {
  observe() {}
  takeRecords() {
    return [];
  }
};
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };

const { experienceExtra } = await import('../js/rl/foundations-view.js');
const { robotStateView } = await import('../js/live/robot-state-view.js');
const planningSource = fs.readFileSync(new URL('../js/planning/view.js', import.meta.url), 'utf8');
const readingsBody = planningSource.slice(
  planningSource.indexOf('function readings('),
  planningSource.indexOf('\nfunction mapIntro('),
);
const readings = vm.runInNewContext(`(${readingsBody})`, {
  fillSentence,
  formatNumber,
  formatWheelRate,
  fromRpm,
});
const slamSource = fs.readFileSync(new URL('../js/slam/view.js', import.meta.url), 'utf8');
const sensorBody = slamSource.slice(
  slamSource.indexOf('function sensorReading('),
  slamSource.indexOf('\nfunction sensorSection('),
);
const sensorReading = vm.runInNewContext(`(${sensorBody})`, {
  unitWords,
  fillSentence,
  fromRpm,
  formatWheelRate,
  formatTurnRate,
});

function text(value) {
  if (Array.isArray(value)) return value.map(text).join('');
  if (value?.strings) return value.strings.map((part, i) => part + text(value.values[i])).join('');
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

test('planning and RL foundation wheel readings show each unrounded rate in both units', async () => {
  const planning = await loadAngleJson('content/planning.json');
  const foundations = await loadAngleJson('content/rl/foundations.json');
  const rates = [toRpm(1.04), toRpm(-2.04)];
  const expected = ['1.0 rad/s（約10 rpm）', '-2.0 rad/s（約-19 rpm）'];
  const planningText = readings({ left: rates[0], right: rates[1], travel: 0.3 }, planning);
  const event = {
    rpm: rates,
    values: [0, 0, 0],
    previousValues: [0, 0, 0],
    action: 0,
  };
  const rlText = text(experienceExtra({ event }, foundations));
  for (const result of [planningText, rlText]) {
    for (const value of expected) assert.ok(result.includes(value), result);
    assert.doesNotMatch(result, /rpm）\s*rad\/s/);
  }
  assert.deepEqual(event.rpm, rates);
});

test('SLAM playback shows both wheel units and the turn-rate auxiliary unit', () => {
  const model = {
    frame: { leftRpm: toRpm(1), rightRpm: toRpm(-2), gyroZ: 1 },
    sensors: { sensor: 'wheels' },
  };
  assert.equal(sensorReading(model), '左 1.0 rad/s（約10 rpm） / 右 -2.0 rad/s（約-19 rpm）');
  model.sensors.sensor = 'imu';
  assert.equal(sensorReading(model), 'ロボットの旋回の角速度 1.00 rad/s（約57°/s）');
});

test('robot state shows signed left-turn rate and heading', async () => {
  const tracker = createStateTracker();
  const config = { wheel_radius: 0.1, wheel_separation: 0.5 };
  ingest(tracker, 'drive', { v: 0.2, w: 0.5 }, 0, config);
  ingest(tracker, 'odom', { x: 0, y: 0, theta: 0 }, 0, config);
  ingest(tracker, 'odom', { x: 0, y: 0, theta: Math.PI / 4 }, 50, config);
  const model = robotStateModel(tracker, {
    link: { connected: true, phase: 'open', config, streams: {} },
    now: 100,
    estopState: 'released',
  });
  const copy = await loadAngleJson('content/live/robot-state.json');
  const result = text(robotStateView(model, copy, { resetPose() {} }));
  assert.ok(result.includes('+0.50 rad/s（約+29°/s）・左回りが＋'), result);
  assert.ok(result.includes('+45°（+0.25π rad ≒ +0.79 rad）'), result);
});

test('maintenance readings show signed heading and turn rate for drive and command', () => {
  const source = fs.readFileSync(new URL('../js/live/live-ui.js', import.meta.url), 'utf8');
  const body = source.slice(
    source.indexOf('function readings()'),
    source.indexOf('\n// The canvases'),
  );
  const fields = Object.fromEntries(
    ['robotPose', 'robotSpeed', 'robotCommand'].map((name) => [name, { textContent: '' }]),
  );
  const latest = {
    odom: { x: 0, y: 0, theta: Math.PI / 4 },
    drive: { v: 0.1, w: 0.5 },
    twist: { linear: 0.1, angular: 0.5 },
  };
  const maintenanceReadings = vm.runInNewContext(`(${body})`, {
    latestRobot: (name) => latest[name],
    $: (name) => fields[name],
    fillSentence,
    unitWords,
    formatHeading,
    formatTurnRate,
    drawEstop() {},
  });
  maintenanceReadings();
  assert.match(fields.robotPose.textContent, /\+45°（\+0\.25π rad）/);
  for (const field of [fields.robotSpeed, fields.robotCommand])
    assert.match(field.textContent, /\+0\.50 rad\/s（約\+29°\/s）/);
});
