import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  loadAngleJson,
  loadAngleText,
  toRpm,
  fromRpm,
  formatWheelRate,
  formatTurnRate,
  formatHeading,
  toRadians,
  formatChange,
  unitWords,
} from '../js/core/angle-units.js';
import { fillSentence } from '../js/core/content.js';
import { formatNumber } from '../js/core/dom.js';
import { createStateTracker, ingest, robotStateModel } from '../js/live/robot-state-core.js';
import { WHEEL_DIAMETER, WHEEL_TRACK, wheelExample, imuExample } from '../js/slam/basics-core.js';

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
const { basicsPage, wheelsCalculation } = await import('../js/slam/basics-view.js');
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
  if (value?.values) return text(value.values);
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

test('SLAM wheel formulas follow the simulator for presets and every slider step', async () => {
  const { wheels } = await loadAngleJson('content/slam/basics.json');
  const radius = WHEEL_DIAMETER / 2;
  const rates = Array.from(
    { length: 7 },
    (_, index) => wheels.slider.min + index * wheels.slider.step,
  );
  const pairs = [...Object.values(wheels.presets), ...rates.map((rate) => [rate, rate])];
  for (const [left, right] of pairs) {
    const rpms = [left, right].map(toRpm);
    const estimate = wheelExample(...rpms);
    const rendered = text(
      wheelsCalculation({ leftRpm: rpms[0], rightRpm: rpms[1], estimate }, wheels.calculation),
    );
    assert.ok(rendered.includes(`半径 ${radius} m（直径 ${WHEEL_DIAMETER * 100} cm）`), rendered);
    assert.ok(
      rendered.includes(`2π × ${radius} m ≒ ${(Math.PI * WHEEL_DIAMETER).toFixed(2)} m`),
      rendered,
    );
    for (const [side, rate, distance] of [
      ['左', left, estimate.left],
      ['右', right, estimate.right],
    ]) {
      const angle = rate * 2;
      assert.ok(Math.abs(distance - radius * angle) < 1e-12);
      const pi = (angle / Math.PI).toFixed(2);
      const turns = angle === 0 ? '0' : (angle / (2 * Math.PI)).toFixed(2);
      const prefix = angle === 0 ? '' : '≒ ';
      const about = angle === 0 ? '' : '約 ';
      const expected = `${side} ${rate.toFixed(1)} rad/s × 2.0 s = ${angle.toFixed(1)} rad（${prefix}${pi}π rad、${about}${turns} 回転）→ ${radius} m × ${angle.toFixed(1)} ≒ ${distance.toFixed(2)} m（${(distance * 100).toFixed(1)} cm）`;
      assert.ok(rendered.includes(expected), `${expected}\n${rendered}`);
    }
    assert.ok(rendered.includes('円弧の長さ ÷ 半径'));
  }
});

test('SLAM wheel formula uses an alternate radius without changing the model', async () => {
  const { wheels } = await loadAngleJson('content/slam/basics.json');
  const radius = 0.05;
  const rate = 3;
  const estimate = { left: radius * rate * 2, right: radius * rate * 2, x: 0, y: 0, angle: 0 };
  const result = text(
    wheelsCalculation(
      { leftRpm: toRpm(rate), rightRpm: toRpm(rate), estimate },
      wheels.calculation,
      radius,
    ),
  );
  assert.ok(result.includes(`半径 ${radius} m（直径 ${radius * 200} cm）`));
  assert.ok(result.includes(`2π × ${radius} m ≒ ${(2 * Math.PI * radius).toFixed(2)} m`));
  assert.ok(result.includes(`${((rate * 2) / Math.PI).toFixed(2)}π rad`));
  assert.ok(
    result.includes(
      `${radius} m × 6.0 ≒ ${estimate.left.toFixed(2)} m（${(estimate.left * 100).toFixed(1)} cm）`,
    ),
  );
});

test('SLAM wheel help draws its dimensions from the same model', async () => {
  const copy = await loadAngleJson('content/slam/basics.json');
  const help = await loadAngleText('content/slam/basics-wheels-help.html');
  const model = {
    topic: 'wheels',
    concept: false,
    groups: [],
    groupTopics: [],
    brief: '',
    figureGuide: '',
    wheels: { leftRpm: 0, rightRpm: 0, estimate: wheelExample(0, 0), actual: wheelExample(0, 0) },
  };
  const actions = {
    openGroup() {},
    openTopic() {},
    useWheelPreset() {},
    setLeftRpm() {},
    setRightRpm() {},
    setSlipping() {},
  };
  const rendered = text(basicsPage(model, copy, help, actions));
  assert.ok(
    rendered.includes(`直径 ${WHEEL_DIAMETER * 100} cm、左右の間隔は ${WHEEL_TRACK * 100} cm`),
  );
  assert.ok(!rendered.includes('{diameter}'));
});

test('SLAM IMU figure, slider and calculation show degrees first', async () => {
  const copy = await loadAngleJson('content/slam/basics.json');
  const actions = {
    openGroup() {},
    openTopic() {},
    setTurnRate() {},
    setTurnSeconds() {},
    setDriveDistance() {},
  };
  for (const rate of [-15, 0, 15]) {
    const seconds = 3;
    const model = {
      topic: 'imu',
      concept: false,
      groups: [],
      groupTopics: [],
      brief: '',
      figureGuide: '',
      imu: { rate, seconds, distance: 0.6, result: imuExample(rate, seconds, 0.6) },
    };
    const rendered = text(basicsPage(model, copy, '', actions));
    assert.ok(rendered.includes(`${rate}°/s（約 ${toRadians(rate).toFixed(2)} rad/s）`), rendered);
    assert.ok(
      rendered.includes(`${rate}°/s × ${seconds} s = ${formatChange(toRadians(rate * seconds))}`),
      rendered,
    );
    assert.ok(rendered.includes('旋回を続ける時間'));
  }
  const tips = await loadAngleJson('content/school-tips.json');
  assert.ok(
    tips.SCHOOL_TIPS['slam-imu'][4].includes('30°/s × 2.0 s = 60°（0.33π rad ≒ 1.05 rad）'),
  );
  assert.ok(tips.SCHOOL_TIPS['slam-imu'][4].includes('5°（約 0.087 rad）'));
  assert.ok(Math.abs(toRadians(60) - 1.05) < 0.005);
  assert.ok(Math.abs(toRadians(0.5) * 10 - 0.087) < 0.0005);
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
