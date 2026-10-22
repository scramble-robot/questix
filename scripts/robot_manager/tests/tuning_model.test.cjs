const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../static/tuning-model.js');
const geometry = { wheel_radius: 0.05, wheel_separation: 0.5 };
const values = (v = 1, w = 3, a = 1.5, alpha = 1.5, rpm = 475) => ({
  joy_controller: { longitudinal_input_ratio: v, angular_input_ratio: w },
  drive_component: { max_linear_accel: a, max_angular_accel: alpha, max_motor_rpm: rpm },
});
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test('defaults and ID15 keep ROS units and derived stopping quantities', () => {
  const normal = m.motion(values(), geometry, 'angular');
  assert.equal(normal.time, 2);
  close(normal.stop * 180 / Math.PI, 171.88733853924697);
  const id15 = m.motion(values(1, 4.5, 1.5, 2.25), geometry, 'angular');
  assert.equal(id15.time, 2);
  assert.equal(Math.round(id15.stop * 180 / Math.PI), 258);
  assert.equal(m.speedText(-4.5, 'angular'), '4.5 rad/s（258°/s）（方向反転）');
  assert.match(m.summary(id15, 'angular'), /加速時間 2 s。全速から.*約 258°/);
  assert.match(m.summary(m.motion(values(), geometry, 'linear'), 'linear'), /約 0.33 m/);
});

test('ID15 10 m/s uses the 475 rpm wheel ceiling for time and distance', () => {
  const linear = m.motion(values(10, 3, 2.25), geometry, 'linear');
  close(linear.speed, 475 * 2 * Math.PI * 0.05 / 60);
  assert.equal(m.number(linear.speed), 2.49);
  assert.equal(linear.configured, 10);
  assert.equal(linear.limited, true);
  close(linear.time, linear.speed / 2.25);
  close(linear.internalTime, 10 / 2.25);
  close(linear.coastTime, (10 - linear.speed) / 2.25);
  close(linear.stopTime, 10 / 2.25);
  close(linear.stop, linear.speed * (10 - linear.speed) / 2.25 + linear.speed ** 2 / 4.5);
  assert.equal(m.number(linear.coastTime), 3.34);
  assert.equal(m.number(linear.stopTime), 4.44);
  assert.equal(m.number(linear.stop), 9.68);
  assert.match(m.summary(linear, 'linear'), /内部の値が設定の速さに届いた場合.*3.34 s.*4.44 s.*9.68 m.*短く倒した/);
  const turn = m.motion(values(10, 20), geometry, 'angular');
  close(turn.speed, 2 * linear.speed / 0.5);
  close(turn.time, turn.speed / 1.5);
  assert.equal(turn.limited, true);
  close(m.wheelLimit(values(1, 3, 1.5, 1.5, 200), geometry, 'linear'),
    200 * 2 * Math.PI * 0.05 / 60);
});

test('lowered rpm can saturate within policy, while ordinary ramps keep their old results', () => {
  const limited = m.motion(values(2, 3, 1.5, 1.5, 200), geometry, 'linear');
  assert.equal(limited.limited, true);
  assert.ok(limited.coastTime > 0);
  close(limited.stopTime, 2 / 1.5);
  const ordinary = m.motion(values(), geometry, 'linear');
  assert.equal(ordinary.coastTime, 0);
  close(ordinary.stopTime, ordinary.time);
  close(ordinary.stop, ordinary.speed ** 2 / (2 * ordinary.accel));
});

test('displayed minimum times round upward and convert to allowed acceleration', () => {
  for (const speed of [0.00012345, 0.05, 0.3, 1, 2, 2.48709418409192, 4.5, 6]) {
    for (const maximum of [50, 100]) {
      const shown = m.minimumTime(speed, maximum);
      assert.ok(shown >= speed / maximum);
      assert.ok(m.acceleration(speed, Number(String(shown))) <= maximum);
    }
  }
  assert.equal(m.minimumTime(4.5, 100), 0.05);
  assert.equal(m.minimumTime(2.48709418409192, 50), 0.05);
  assert.equal(m.minimumTime(0, 50), null);
  assert.equal(m.minimumTime(1, 0), null);
  assert.match(m.speedWarning('longitudinal_input_ratio', -10, 2), /10.0 m\/s（方向の反転あり）.*2.0 m\/s 以下/);
  assert.doesNotMatch(m.speedWarning('longitudinal_input_ratio', 10, 2), /（方向の反転あり）/);
});

test('plan A preserves effective acceleration time across both sides of the wheel ceiling', () => {
  const before = m.motion(values(), geometry, 'linear');
  for (const speed of [0.5, 1.5, 10, -10]) {
    const nextValues = values(speed);
    const next = m.motion(nextValues, geometry, 'linear');
    nextValues.drive_component.max_linear_accel = m.retime(before, next);
    close(m.motion(nextValues, geometry, 'linear').time, before.time);
  }
  for (const kind of ['linear', 'angular']) {
    const original = m.motion(values(), geometry, kind);
    close(m.acceleration(original.speed, original.time), original.accel);
    for (const factor of [0.5, 1, 1.5]) {
      close(m.presetTime(values(), geometry, kind, factor), original.time / factor);
    }
  }
});

test('zero, missing, negative and nonfinite inputs never manufacture a finite ramp', () => {
  assert.equal(m.motion(values(0), geometry, 'linear').time, null);
  assert.equal(m.motion(values(1, 3, 0), geometry, 'linear').unlimited, true);
  assert.equal(m.retime(m.motion(values(), geometry, 'linear'),
    m.motion(values(0), geometry, 'linear')), 1.5);
  for (const bad of [null, NaN, Infinity, '1', -1]) {
    assert.equal(m.motion(values(1, 3, bad), geometry, 'linear'), null);
    assert.equal(m.acceleration(1, bad), null);
  }
  assert.equal(m.motion(values(), null, 'angular'), null);
  assert.equal(m.motion(values(), { ...geometry, wheel_radius: 0 }, 'linear'), null);
  assert.equal(m.motion(values(), geometry, 'linear').speed, 1);
  assert.equal(m.presetTime(values(0), geometry, 'linear', 1), null);
  const tiny = m.motion(values(1, 3, Number.MIN_VALUE), geometry, 'linear');
  assert.equal(tiny.time, null);
  assert.match(m.summary(tiny, 'linear'), /大きすぎる/);
  assert.equal(m.acceleration(1, Number.MIN_VALUE), null);
});

test('display rounding never alters inputs or erases a nonzero small value', () => {
  const v = values(0.00012345, -0.00012345, 50, 100);
  const copy = structuredClone(v);
  const state = m.motion(v, geometry, 'angular');
  assert.notEqual(m.number(state.time), 0);
  m.speedText(v.joy_controller.angular_input_ratio, 'angular');
  assert.deepEqual(v, copy);
  assert.equal(m.motion(v, geometry, 'linear').accel, 50);
  assert.equal(state.accel, 100);
});
