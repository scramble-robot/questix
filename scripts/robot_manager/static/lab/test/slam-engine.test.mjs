// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// Pins the public behaviour of the SLAM simulation/estimation maths. The expected numbers were
// taken from the module before it was rewritten, so a refactor that changes what the lesson
// computes fails here. The generator is seeded, so every value is reproducible.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SLAM_METHODS,
  SLAM_CASES,
  integratePose,
  transformPoints,
  generateSlamLog,
  estimateSlam,
  slamMetrics,
  validateSlamLog,
} from '../js/slam/engine.js';

const TOLERANCE = 1e-6;
const close = (actual, expected, what) =>
  assert.ok(
    Math.abs(actual - expected) < TOLERANCE,
    `${what}: expected ${expected}, got ${actual}`,
  );

// scenario → frames, LiDAR readings out of range in the first scan, and the room.
const LOGS = {
  slip: { frames: 295, endTime: 59, missingFirstScan: 3, width: 4.8, height: 3.2, walls: 2 },
  bias: { frames: 295, endTime: 59, missingFirstScan: 3, width: 4.8, height: 3.2, walls: 2 },
  corridor: { frames: 263, endTime: 52.6, missingFirstScan: 18, width: 14, height: 2.2, walls: 0 },
};

// scenario → condition → end pose of the estimate and the metrics the lesson reports.
// "+cal" subtracts the gyro bias measured while the robot stood still.
const ESTIMATES = {
  slip: {
    wheel: { x: 0.376846, y: 3.17427, theta: -1.328874, endError: 3.196561, rmse: 1.844305 },
    imu: { x: 0.065086, y: -0.101896, theta: 0.055733, endError: 0.120909, rmse: 0.07168 },
    'imu+cal': { x: -0.008252, y: 0.021548, theta: -0.014139, endError: 0.023074, rmse: 0.07138 },
    slam: { x: 0.003853, y: 0.017777, theta: -0.003899, endError: 0.01819, rmse: 0.014583 },
    'slam+cal': { x: -0.00032, y: 0.016429, theta: -0.004677, endError: 0.016432, rmse: 0.012945 },
  },
  bias: {
    wheel: { x: -0.001202, y: 0.004249, theta: -0.000618, endError: 0.004416, rmse: 0.002496 },
    imu: { x: 2.337496, y: -0.91742, theta: 1.530733, endError: 2.511085, rmse: 1.511987 },
    'imu+cal': { x: -0.008068, y: 0.021058, theta: -0.014139, endError: 0.02255, rmse: 0.016991 },
    slam: { x: 0.005289, y: 0.005462, theta: 0.005503, endError: 0.007603, rmse: 0.021811 },
    'slam+cal': { x: 0.001578, y: 0.017612, theta: -0.005839, endError: 0.017682, rmse: 0.014687 },
  },
  corridor: {
    wheel: { x: -0.000198, y: 0.004664, theta: -0.001194, endError: 0.004669, rmse: 0.220942 },
    imu: { x: 0.003384, y: -0.142456, theta: 0.055623, endError: 0.142496, rmse: 0.231301 },
    'imu+cal': { x: -0.000186, y: -0.011738, theta: 0.004037, endError: 0.011739, rmse: 0.220999 },
    slam: { x: -0.000178, y: 0.005021, theta: -0.001008, endError: 0.005024, rmse: 0.221033 },
    'slam+cal': { x: -0.000191, y: 0.004909, theta: -0.001128, endError: 0.004913, rmse: 0.221022 },
  },
};

const condition = (name) => ({
  method: name.replace('+cal', ''),
  calibrate: name.endsWith('+cal'),
});

test('the three conditions and method names the lesson offers', () => {
  assert.deepEqual(Object.keys(SLAM_METHODS), ['wheel', 'imu', 'slam']);
  assert.deepEqual(Object.keys(SLAM_CASES), ['slip', 'bias', 'corridor']);
  for (const item of Object.values(SLAM_CASES)) assert.ok(item.name && item.description);
});

test('integratePose advances along the average heading of the step', () => {
  const pose = integratePose({ x: 1, y: 2, theta: 0.3 }, 0.5, 0.4);
  close(pose.x, 1 + 0.5 * Math.cos(0.5), 'x');
  close(pose.y, 2 + 0.5 * Math.sin(0.5), 'y');
  close(pose.theta, 0.7, 'theta');
  // A half turn past PI wraps instead of growing without bound.
  close(integratePose({ x: 0, y: 0, theta: 3 }, 0, 0.3).theta, 3.3 - 2 * Math.PI, 'wrapped theta');
});

test('transformPoints puts sensor readings into the map frame', () => {
  const points = transformPoints(
    [
      { x: 1, y: 0 },
      { x: 0, y: 2 },
    ],
    { x: 1, y: -1, theta: Math.PI / 2 },
  );
  close(points[0].x, 1, 'first x');
  close(points[0].y, 0, 'first y');
  close(points[1].x, -1, 'second x');
  close(points[1].y, -1, 'second y');
});

for (const [scenario, expected] of Object.entries(LOGS))
  test(`generateSlamLog("${scenario}") is reproducible`, () => {
    const log = generateSlamLog(scenario);
    assert.equal(log.format, 'robo-lab-sensors-v1');
    assert.equal(log.source, 'simulation');
    assert.equal(log.scenario, scenario);
    assert.equal(log.stationarySeconds, 2);
    assert.equal(log.frames.length, expected.frames);
    assert.equal(log.reference.length, expected.frames);
    close(log.frames[0].t, 0.2, 'first sample time');
    close(log.frames.at(-1).t, expected.endTime, 'last sample time');
    assert.equal(log.scene.width, expected.width);
    assert.equal(log.scene.height, expected.height);
    assert.equal(log.scene.walls.length, expected.walls);
    // The drive returns to where it started, which is what the lesson measures against.
    close(log.reference.at(-1).x, 0, 'reference end x');
    close(log.reference.at(-1).y, 0, 'reference end y');
    const scan = log.frames[0].ranges;
    assert.equal(scan.length, 72);
    assert.equal(scan.filter((range) => range === null).length, expected.missingFirstScan);
    assert.deepEqual(generateSlamLog(scenario).frames[7], log.frames[7]);
  });

for (const [scenario, conditions] of Object.entries(ESTIMATES))
  for (const [name, expected] of Object.entries(conditions))
    test(`estimateSlam("${scenario}", ${name}) reaches the recorded result`, () => {
      const log = generateSlamLog(scenario);
      const result = estimateSlam(log.frames, log.config, {
        ...condition(name),
        stationarySeconds: log.stationarySeconds,
      });
      assert.equal(result.states.length, log.frames.length);
      const end = result.states.at(-1);
      close(end.x, expected.x, 'end x');
      close(end.y, expected.y, 'end y');
      close(end.theta, expected.theta, 'end theta');
      const metrics = slamMetrics(result, log);
      close(metrics.endError, expected.endError, 'endError');
      close(metrics.rmse, expected.rmse, 'rmse');
      close(metrics.closure, Math.hypot(end.x, end.y), 'closure');
      close(metrics.headingError, Math.abs(end.theta), 'headingError');
      // Only the LiDAR condition matches scans against the map it has built so far.
      assert.equal(
        result.states.some((state) => state.matched),
        condition(name).method === 'slam',
      );
    });

test('the gyro bias comes from the samples taken while standing still', () => {
  const log = generateSlamLog('bias');
  const plain = estimateSlam(log.frames, log.config, { method: 'imu' });
  assert.equal(plain.bias, 0);
  assert.equal(plain.calibrationCount, 0);
  const calibrated = estimateSlam(log.frames, log.config, {
    method: 'imu',
    calibrate: true,
    stationarySeconds: log.stationarySeconds,
  });
  assert.equal(calibrated.calibrationCount, 10);
  close(calibrated.bias, 0.026184, 'measured bias');
});

test('calibration without enough stationary samples is refused', () => {
  const log = generateSlamLog('slip');
  assert.throws(
    () => estimateSlam(log.frames, log.config, { method: 'imu', calibrate: true }),
    /静止した計測が3回以上必要です/,
  );
});

test('slamMetrics leaves the reference-based numbers empty for a real log', () => {
  const log = generateSlamLog('slip');
  const result = estimateSlam(log.frames, log.config, { method: 'wheel' });
  const metrics = slamMetrics(result, { frames: log.frames });
  assert.equal(metrics.endError, null);
  assert.equal(metrics.rmse, null);
  assert.equal(metrics.headingError, null);
  close(metrics.closure, Math.hypot(result.states.at(-1).x, result.states.at(-1).y), 'closure');
});

// --- Reading a log recorded on a real robot ------------------------------------------------------

const generated = generateSlamLog('slip');
const asFile = () =>
  JSON.parse(
    JSON.stringify({
      format: generated.format,
      config: generated.config,
      stationarySeconds: 2,
      frames: generated.frames.slice(0, 5),
    }),
  );

test('validateSlamLog keeps the measurements and drops any claimed truth', () => {
  const log = validateSlamLog({ ...asFile(), reference: [{ x: 9, y: 9 }], scene: { width: 1 } });
  assert.equal(log.source, 'hardware');
  assert.equal(log.frames.length, 5);
  assert.equal(log.reference, null);
  assert.equal(log.scene, null);
  assert.equal(log.stationarySeconds, 2);
  assert.deepEqual(log.config, generated.config);
  assert.notEqual(log.config, generated.config); // copied, not shared
  // Simulated camera frames are display-only and are never carried into an imported log.
  assert.equal(log.frames[0].camera, null);
  assert.deepEqual(log.frames[0].gyro, generated.frames[0].gyro);
});

test('validateSlamLog clamps the stationary window and tolerates missing vectors', () => {
  assert.equal(validateSlamLog({ ...asFile(), stationarySeconds: 9 }).stationarySeconds, 5);
  assert.equal(validateSlamLog({ ...asFile(), stationarySeconds: 'x' }).stationarySeconds, 0);
  const file = asFile();
  for (const frame of file.frames) delete frame.accel;
  assert.equal(validateSlamLog(file).frames[0].accel, null);
});

const frame = (t) => ({
  t,
  leftRpm: 1,
  rightRpm: 1,
  gyroZ: 0,
  angleMin: 0,
  angleIncrement: Math.PI / 6,
  ranges: Array.from({ length: 12 }, () => 1),
});
const withFrames = (frames) => ({
  format: 'robo-lab-sensors-v1',
  config: { radius: 0.06, track: 0.3, rangeMax: 3 },
  frames,
});

test('validateSlamLog explains what is wrong with a file', () => {
  const rejects = [
    [null, /形式が違います/],
    [{ format: 'other' }, /形式が違います/],
    [{ ...withFrames([]), config: { radius: 0, track: 0.3, rangeMax: 3 } }, /車輪の半径/],
    [
      {
        ...withFrames([]),
        config: { radius: 0.06, track: 0.3, rangeMax: 3, lidar: { x: 5, y: 0, yaw: 0 } },
      },
      /LiDARの取付位置/,
    ],
    [withFrames([]), /計測は3〜3,000フレームにしてください/],
    [withFrames([frame(0.1), frame(0.05), frame(0.3)]), /2番目の時刻・回転数・角速度/],
    [withFrames([frame(0.1), frame(0.2), { ...frame(0.3), ranges: [1, 2, 3] }]), /3番目の距離配列/],
  ];
  for (const [input, message] of rejects) assert.throws(() => validateSlamLog(input), message);
});
