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
  unitWords,
} from '../js/core/angle-units.js';
import { fillSentence } from '../js/core/content.js';
import { formatNumber } from '../js/core/dom.js';

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
