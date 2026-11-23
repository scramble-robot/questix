import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  toRadians,
  toDegrees,
  toRpm,
  fromRpm,
  formatHeading,
  formatChange,
  formatTurnRate,
  formatWheelRate,
  formatWheelChange,
  formatMotorRate,
  angleParts,
  unitWords,
  withAngleUnits,
  loadAngleJson,
  loadAngleText,
} from '../js/core/angle-units.js';
import { WHEEL_DIAMETER, wheelExample } from '../js/slam/basics-core.js';
import { graphReadings, graphSpec } from '../js/rl/sensors.js';

const near = (a, b, tolerance = 1e-12) => assert.ok(Math.abs(a - b) < tolerance, `${a} ≠ ${b}`);
test('angular velocity and acceleration convert both ways without intermediate rounding', () => {
  near(toRpm(1), 9.549296585513721);
  near(toDegrees(1), 57.29577951308232);
  for (const rate of [-17.234, -1, 0, 1, 24.123]) {
    near(fromRpm(toRpm(rate)), rate);
    near(toRadians(toDegrees(rate)), rate);
    near(fromRpm(toRpm(toRadians(toDegrees(rate)))), rate);
  }
  assert.equal(formatTurnRate(1), '1.00 rad/s（約57°/s）');
  assert.equal(formatMotorRate(toRpm(1), 1), '9.5 rpm（1.0 rad/s）');
  assert.equal(formatWheelRate(1), '1.0 rad/s（約10 rpm）');
  assert.equal(formatWheelChange(toRpm(1)), '1.0 rad/s²（約9.5 rpm/s）');
});

test('heading boundary, precision and short forms agree in all three units', () => {
  const cases = [
    [0, '0°（0.00π rad ≒ 0.00 rad）'],
    [45, '45°（0.25π rad ≒ 0.79 rad）'],
    [90, '90°（0.50π rad ≒ 1.57 rad）'],
    [180, '180°（1.00π rad ≒ 3.14 rad）'],
    [-180, '-180°（-1.00π rad ≒ -3.14 rad）'],
    [-90, '-90°（-0.50π rad ≒ -1.57 rad）'],
  ];
  for (const [degrees, expected] of cases)
    assert.equal(formatHeading(toRadians(degrees)), expected);
  assert.equal(formatHeading(toRadians(179.9), { digits: 1 }), '179.9°（1.00π rad ≒ 3.14 rad）');
  assert.equal(formatHeading(Math.PI), cases[3][1]);
  assert.equal(formatHeading(-Math.PI), cases[4][1]);
  assert.match(formatHeading(Math.PI + 0.001), /^-180°/);
  assert.match(formatHeading(-Math.PI - 0.001), /^180°/);
  assert.equal(formatHeading(toRadians(45), { short: true }), '45°（0.25π rad）');
  for (const radians of [-0, -1e-12, 0, 1e-12]) {
    assert(!formatHeading(radians).includes('-0'));
    assert(!formatChange(radians).includes('-0'));
    assert(!formatTurnRate(radians).includes('-0'));
  }
  for (const degrees of [0, 45, 90, 179.9, 180, -180, -90, 400, -400]) {
    const parts = angleParts(toRadians(degrees), 1);
    near(Number(parts.degrees), degrees, 0.051);
    near(Number(parts.pi) * 180, degrees, 0.901);
    near(toDegrees(Number(parts.rad)), degrees, 0.287);
  }
});

test('heading change stays unwrapped and signed beyond a full turn', () => {
  assert.equal(formatChange(toRadians(400)), '400°（2.22π rad ≒ 6.98 rad）');
  assert.equal(formatChange(toRadians(-400)), '-400°（-2.22π rad ≒ -6.98 rad）');
  assert.equal(formatHeading(toRadians(400)), '40°（0.22π rad ≒ 0.70 rad）');
});

test('optional signs follow each rounded heading and turn-rate value', () => {
  const signed = { signed: true };
  const short = { signed: true, short: true };
  for (const [degrees, longText, shortText] of [
    [45, '+45°（+0.25π rad ≒ +0.79 rad）', '+45°（+0.25π rad）'],
    [0, '0°（0.00π rad ≒ 0.00 rad）', '0°（0.00π rad）'],
    [-45, '-45°（-0.25π rad ≒ -0.79 rad）', '-45°（-0.25π rad）'],
    [-0.3, '0°（0.00π rad ≒ 0.00 rad）', '0°（0.00π rad）'],
    [0.3, '0°（0.00π rad ≒ 0.00 rad）', '0°（0.00π rad）'],
  ]) {
    assert.equal(formatHeading(toRadians(degrees), signed), longText);
    assert.equal(formatHeading(toRadians(degrees), short), shortText);
  }
  for (const [rate, expected] of [
    [0.5, '+0.50 rad/s（約+29°/s）'],
    [0, '0.00 rad/s（約0°/s）'],
    [-0.5, '-0.50 rad/s（約-29°/s）'],
    [0.004, '0.00 rad/s（約0°/s）'],
    [-0.004, '0.00 rad/s（約0°/s）'],
  ])
    assert.equal(formatTurnRate(rate, signed), expected);
  assert.equal(formatHeading(toRadians(45)), '45°（0.25π rad ≒ 0.79 rad）');
  assert.equal(formatTurnRate(0.5), '0.50 rad/s（約29°/s）');
});

test('auxiliary angles derive from displayed rounded degrees', () => {
  for (const [degrees, expected] of [
    [44.6, '45°（0.25π rad ≒ 0.79 rad）'],
    [-44.6, '-45°（-0.25π rad ≒ -0.79 rad）'],
    [0.5, '1°（0.01π rad ≒ 0.02 rad）'],
    [0.49, '0°（0.00π rad ≒ 0.00 rad）'],
    [-0.5, '-1°（-0.01π rad ≒ -0.02 rad）'],
    [179.6, '180°（1.00π rad ≒ 3.14 rad）'],
    [-179.6, '-180°（-1.00π rad ≒ -3.14 rad）'],
  ])
    assert.equal(formatHeading(toRadians(degrees)), expected);
  assert.equal(formatHeading(toRadians(44.6), { signed: true }), '+45°（+0.25π rad ≒ +0.79 rad）');
  assert.equal(formatHeading(toRadians(12.34), { digits: 1 }), '12.3°（0.07π rad ≒ 0.21 rad）');
  assert.equal(formatChange(toRadians(400.6)), '401°（2.23π rad ≒ 7.00 rad）');
});

test('shared first-use words and rad explanation resolve in each content consumer', async () => {
  const basics = await loadAngleJson('content/slam/basics.json');
  const help = await loadAngleText('content/slam/basics-wheels-help.html');
  const experiment = await loadAngleJson('content/rl/lab-experiment.json');
  assert(help.includes(unitWords.radianExplanation));
  assert(
    experiment.rewards
      .find((r) => r.key === 'heading')
      .description.includes(unitWords.radianExplanation),
  );
  for (const path of [
    'content/live/robot-state.json',
    'content/live/link.json',
    'content/rl/lab-sensors.json',
    'content/rl/lab.json',
    'content/slam/ui.json',
    'content/slam/basics.json',
    'content/planning.json',
    'content/rl/foundations.json',
    'content/motor.json',
    'content/keymap.json',
    'content/vision/basics.json',
  ]) {
    const resolved = JSON.stringify(await loadAngleJson(path));
    assert(!resolved.includes('{@'), path);
  }
  assert(basics.wheels.controlsIntro.includes(unitWords.radRate));
  assert(
    (await loadAngleJson('content/live/drive-report.json')).unitNote.includes(unitWords.radRate),
  );
  assert(graphSpec('impact').note.includes(unitWords.linearAcceleration));
  assert(graphSpec('wheels').note.includes(unitWords.rpm));
  const lab = await loadAngleJson('content/rl/lab.json');
  assert(lab.training.metrics.commandRate.note.includes(unitWords.angularAcceleration));
  assert.throws(() => withAngleUnits('{@missing}'));
  const raw = fs.readFileSync(new URL('../content/angle-units.json', import.meta.url), 'utf8');
  assert.equal(raw.split(unitWords.radianExplanation).length - 1, 1);
});

test('SLAM rad/s presets retain straight, left curve and left spin with the same geometry', async () => {
  const { wheels } = await loadAngleJson('content/slam/basics.json');
  assert.deepEqual(wheels.slider, { min: -3, max: 6, step: 1.5 });
  const result = (key) => wheelExample(...wheels.presets[key].map(toRpm));
  near(result('straight').x, (WHEEL_DIAMETER / 2) * 3 * 2);
  near(result('straight').angle, 0);
  assert(result('curve').angle > 0);
  assert(result('curve').distance > 0);
  near(result('spin').distance, 0);
  assert(result('spin').angle > 0);
  for (const rates of Object.values(wheels.presets))
    for (const rate of rates)
      assert(Number.isInteger((rate - wheels.slider.min) / wheels.slider.step));
});

test('RL sensor projection converts raw units without mutating recorded samples', () => {
  const history = [{ t: 1, left: 60, right: -30, gyro: 90, yaw: 400 }];
  const before = structuredClone(history);
  assert.equal(graphReadings(history, graphSpec('wheels'))[0].value, '6.3 rad/s（約60 rpm）');
  assert.equal(
    graphReadings(history, graphSpec('imu', 'rotation'))[0].value,
    '1.57 rad/s（約90°/s）',
  );
  assert.equal(
    graphReadings(history, graphSpec('imu', 'heading'))[0].value,
    '40°（0.22π rad ≒ 0.70 rad）',
  );
  assert.deepEqual(history, before);
});

test('clockwise-positive simulation state reaches displays as counter-clockwise-positive IMU values', async () => {
  const { World } = await import('../js/core/engine/world.js');
  const world = new World('delivery', {}, { course: 'standard', noise: 0 });
  world.reset(123);
  world.gyroBias = 0;
  for (const sign of [-1, 1]) {
    world.state.estTheta = (sign * Math.PI) / 4;
    world.state.omega = sign;
    const imu = world.measureImu();
    near(imu.yaw, (-sign * Math.PI) / 4);
    near(toRadians(imu.gyro[2]), -sign);
    const history = [{ t: 1, yaw: toDegrees(imu.yaw), gyro: imu.gyro[2] }];
    assert.equal(
      graphReadings(history, graphSpec('imu', 'rotation'))[0].value,
      formatTurnRate(-sign),
    );
    assert.equal(
      graphReadings(history, graphSpec('imu', 'heading'))[0].value,
      formatHeading((-sign * Math.PI) / 4),
    );
  }
});
