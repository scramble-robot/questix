import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ROBOT_DIMENSIONS,
  footprintCorners,
  lidarMount,
  lidarMounts,
  linearToWheelAngular,
  linearToWheelRpm,
  rpmToWheelAngular,
  twistToWheelAngular,
  wheelAngularToLinear,
  wheelAngularToRpm,
  wheelAngularToTwist,
  wheelRpmToLinear,
} from '../js/core/robot-dimensions.js';
import { QUESTIX_VIEWS, questixTopFootprintLayout } from '../js/core/questix-views.js';

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

test('QUESTiX dimensions are frozen and use the CAD envelope relative to the axle', () => {
  // CAD -Y is forward, confirmed by the rear LiDAR on the physical robot (2026-11-23).
  assert.ok(Object.isFrozen(ROBOT_DIMENSIONS));
  assert.ok(Object.isFrozen(ROBOT_DIMENSIONS.footprint));
  const { front, rear, left, right } = ROBOT_DIMENSIONS.footprint;
  assert.deepEqual([front, rear, left, right], [0.245, 0.4119, 0.32, 0.32]);
  near(front + rear, 0.6569);
  near(left + right, 0.64);
  assert.ok(Math.min(left, right) > 0.537 / 2); // Measured outer tyre span.
  assert.ok(Math.min(left, right) > 0.277); // CAD outer tyre edge.
});

test('the default LiDAR list is nonempty, frozen and has unique lesson names', () => {
  const mounts = lidarMounts();
  assert.equal(mounts, ROBOT_DIMENSIONS.lidars);
  assert.ok(mounts.length >= 1);
  assert.ok(Object.isFrozen(mounts));
  assert.ok(mounts.every(Object.isFrozen));
  assert.equal(new Set(mounts.map(({ name }) => name)).size, mounts.length);
});

test('the rear CAD LiDAR centre is behind the axle and inside the footprint', () => {
  const { footprint } = ROBOT_DIMENSIONS;
  const { frame, x, y, z, yaw } = lidarMount('rear');
  assert.equal(frame, 'laser_frame');
  assert.deepEqual([x, y, z], [-0.3215, 0, 0.06845]);
  assert.equal(yaw, null);
  assert.ok(x > -footprint.rear && x < 0);
  assert.ok(y > -footprint.right && y < footprint.left);
  assert.ok(z > 0);
});

test('LiDAR helpers accept an alternate model and return undefined for an unknown name', () => {
  const front = { name: 'front' };
  const rear = { name: 'rear' };
  const dimensions = { lidars: [front, rear] };
  assert.equal(lidarMounts(dimensions), dimensions.lidars);
  assert.equal(lidarMount('front', dimensions), front);
  assert.equal(lidarMount('rear', dimensions), rear);
  assert.equal(lidarMount('missing', dimensions), undefined);
});

for (const config of [
  'launcher/config/drive_component.yaml',
  'questix_lab_bridge/config/lab_bridge.yaml',
]) {
  test(`wheel dimensions match ${config}`, () => {
    const yaml = readFileSync(new URL(`../../../../../${config}`, import.meta.url), 'utf8');
    for (const [param, expected] of [
      ['wheel_radius', ROBOT_DIMENSIONS.wheelRadius],
      ['wheel_separation', ROBOT_DIMENSIONS.wheelSeparation],
    ]) {
      // These ROS YAML files store the parameters as plain numeric block-mapping values.
      const values = [...yaml.matchAll(new RegExp(`^ +${param}: *([^#\\r\\n]+)`, 'gm'))];
      assert.equal(values.length, 1, param);
      assert.equal(Number(values[0][1].trim()), expected, param);
    }
  });
}

test('rim speed, rad/s and RPM convert both ways with an alternate wheel radius', () => {
  const dimensions = { ...ROBOT_DIMENSIONS, wheelRadius: 0.1 };
  near(linearToWheelAngular(-0.2, dimensions), -2);
  near(wheelAngularToLinear(-2, dimensions), -0.2);
  near(wheelAngularToRpm(Math.PI), 30);
  near(rpmToWheelAngular(-30), -Math.PI);
  near(linearToWheelRpm(-0.2, dimensions), wheelAngularToRpm(-2));
  near(wheelRpmToLinear(wheelAngularToRpm(-2), dimensions), -0.2);
  near(wheelAngularToLinear(10), 0.5);
});

test('differential drive has forward-positive wheels and left-positive yaw', () => {
  assert.deepEqual(twistToWheelAngular(0.5, 0), { left: 10, right: 10 });
  assert.deepEqual(twistToWheelAngular(0, 2), { left: -10, right: 10 });
  const dimensions = { ...ROBOT_DIMENSIONS, wheelRadius: 0.075, wheelSeparation: 0.7 };
  const { left, right } = twistToWheelAngular(-0.25, -1.2, dimensions);
  assert.ok(left > right);
  const { linear, angular } = wheelAngularToTwist(left, right, dimensions);
  near(linear, -0.25);
  near(angular, -1.2);
});

test('provisional speed extremes fit the configured motor ceiling, including combined commands', () => {
  const { maxLinear, maxAngular, linearAccel, angularAccel, motorMaxRpm } = ROBOT_DIMENSIONS;
  assert.deepEqual(
    [maxLinear, maxAngular, linearAccel, angularAccel, motorMaxRpm],
    [0.5, 1.5, 1.5, 1.5, 475],
  );
  let highestRpm = 0;
  for (const linear of [-maxLinear, 0, maxLinear]) {
    for (const angular of [-maxAngular, 0, maxAngular]) {
      const wheels = twistToWheelAngular(linear, angular);
      for (const rate of Object.values(wheels)) {
        const rpm = Math.abs(wheelAngularToRpm(rate));
        assert.ok(rpm <= motorMaxRpm);
        highestRpm = Math.max(highestRpm, rpm);
      }
    }
  }
  near(highestRpm, wheelAngularToRpm(17.5));
});

test('footprint corners rotate around the axle and keep the local front and left signs', () => {
  const [frontLeft, rearLeft] = footprintCorners({ x: 2, y: 3, theta: Math.PI / 2 });
  near(frontLeft.x, 2 - 0.32);
  near(frontLeft.y, 3 + 0.245);
  near(rearLeft.x, 2 - 0.32);
  near(rearLeft.y, 3 - 0.4119);
});

test('top image bounds land on the collision corners at 0, 45 and 90 degrees', () => {
  // The top artwork marks its right edge as forward, matching the confirmed CAD -Y.
  const [left, top, right, bottom] = QUESTIX_VIEWS.top.bounds;
  const alternate = { footprint: { front: 0.6, rear: 0.2, left: 0.5, right: 0.3 } };
  const scale = 177;
  for (const dimensions of [undefined, alternate]) {
    for (const theta of [0, Math.PI / 4, Math.PI / 2]) {
      const pose = { x: 1.3, y: -2.2, theta };
      const place = questixTopFootprintLayout(pose, scale, dimensions);
      const { image } = place;
      const cos = Math.cos(place.theta);
      const sin = Math.sin(place.theta);
      const corners = footprintCorners(pose, dimensions);
      for (const [index, [u, v]] of [
        [right, top],
        [left, top],
        [left, bottom],
        [right, bottom],
      ].entries()) {
        const x = image.x + u * image.width;
        const y = image.y + v * image.height;
        near(place.x + x * cos - y * sin, corners[index].x * scale);
        near(place.y + x * sin + y * cos, -corners[index].y * scale);
      }
    }
  }
});
