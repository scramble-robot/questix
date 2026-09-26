import { randomGenerator, gaussian, wrap, clamp } from '../core/engine.js';
import { slamSceneRects, slamCameraObservation } from './camera.js';

// Maths of the SLAM course: it makes a sensor log for a drive nobody has to run, and estimates
// where the robot went from wheels, gyro and LiDAR alone. No DOM, so it can be tested from Node.
//
// SLAM uses x forward, y left, z up (metres, seconds, radians).
// Estimation never receives simulator geometry or reference poses.

const SLAM_METHODS = { wheel: '車輪だけ', imu: '車輪 ＋ IMU', slam: '車輪 ＋ IMU ＋ LiDAR' };
const SLAM_CASES = {
  slip: { name: '車輪が少し滑る床', description: '左右の車輪が、少し違う割合で滑ります。' },
  bias: { name: 'IMUのずれ', description: '止まっていても、ジャイロの値に小さな偏りがあります。' },
  corridor: {
    name: '長いまっすぐな通路',
    description: 'LiDARから見ると、進んでも左右の壁の形があまり変わりません。',
  },
};

const copyPose = (pose) => ({ x: pose.x, y: pose.y, theta: pose.theta });

// A step of the differential drive: the heading turns by `turn` while the robot travels
// `distance` along the average of the old and the new heading.
function integratePose(pose, distance, turn) {
  const heading = pose.theta + turn / 2;
  return {
    x: pose.x + distance * Math.cos(heading),
    y: pose.y + distance * Math.sin(heading),
    theta: wrap(pose.theta + turn),
  };
}

// Distance from `pose` to the nearest of the axis-aligned `rects` along `angle`, or `max`.
// Slab method: a ray meets a box between entering both slabs and leaving the first of them.
function raycast(pose, angle, rects, max) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let best = max;
  for (const [x0, y0, x1, y1] of rects) {
    let near = -Infinity;
    let far = Infinity;
    for (const [origin, direction, low, high] of [
      [pose.x, dx, x0, x1],
      [pose.y, dy, y0, y1],
    ]) {
      if (Math.abs(direction) < 1e-9) {
        // Parallel to this slab: either always inside it or never.
        if (origin < low || origin > high) {
          far = -Infinity;
          break;
        }
      } else {
        const t0 = (low - origin) / direction;
        const t1 = (high - origin) / direction;
        near = Math.max(near, Math.min(t0, t1));
        far = Math.min(far, Math.max(t0, t1));
      }
    }
    if (far >= Math.max(near, 0) && near >= 0) best = Math.min(best, near);
  }
  return best;
}

// --- The simulated drive -------------------------------------------------------------------------

const SAMPLE_PERIOD = 0.2; // seconds of driving between recorded samples
const LIDAR_BEAMS = 72; // one full turn per scan
const CRUISE_SPEED = 0.25; // m/s
const TURN_RATE = 0.65; // rad/s
const STATIONARY_SECONDS = 2; // standing still at the start, so a gyro bias can be measured
const SETTLE_SECONDS = 1; // standing still again at the end
const MIN_RANGE = 0.03; // m; the LiDAR reports nothing closer
const RANGE_NOISE = 0.008; // m, standard deviation
const RPM_NOISE = 0.015; // rpm
const GYRO_NOISE = 0.0015; // rad/s
const ACCEL_NOISE = 0.02; // m/s²
const GRAVITY = 9.81; // m/s²
const MAGNETIC_FIELD = { horizontal: 25, vertical: -40 }; // µT, an illustrative field
const BIASED_GYRO_OFFSET = 0.026; // rad/s, the "IMUのずれ" condition
const GYRO_OFFSET = 0.001; // rad/s, the small offset every gyro has here
// Fraction of the commanded wheel travel that reaches the floor: [left, right].
const WHEEL_GRIP = { slip: [0.96, 0.995], corridor: [0.93, 0.93] };
const FULL_GRIP = [1, 1];
const ROOM_LEGS = [3.7, 2.1, 3.7, 2.1]; // metres, with a quarter turn after each
const HALLWAY_LEG_SECONDS = 20; // one length of the long corridor

function slamScene(scenario) {
  if (scenario === 'corridor')
    return { width: 14, height: 2.2, walls: [], start: { x: 4, y: 1.1, theta: 0 } };
  return {
    width: 4.8,
    height: 3.2,
    walls: [
      { x: 1.4, y: 1.35, w: 0.35, h: 1.15 },
      { x: 2.85, y: 0.7, w: 0.35, h: 1.05 },
    ],
    start: { x: 0.55, y: 0.55, theta: 0 },
  };
}

// A turn is spread over a whole number of samples, so it ends exactly on the target angle.
const turnSeconds = (angle) => angle / TURN_RATE;
const turnRate = (angle) =>
  angle / (Math.round(turnSeconds(angle) / SAMPLE_PERIOD) * SAMPLE_PERIOD);

function generateSlamLog(scenario = 'slip', seed = 42) {
  const scene = slamScene(scenario);
  const rects = slamSceneRects(scene);
  const config = { radius: 0.065, track: 0.32, rangeMax: 3.2, lidar: { x: 0, y: 0, yaw: 0 } };
  const random = randomGenerator(seed);
  const frames = [];
  const reference = [];
  const gyroOffset = scenario === 'bias' ? BIASED_GYRO_OFFSET : GYRO_OFFSET;
  let pose = { ...scene.start };
  let time = 0;
  let previousSpeed = 0;

  // One sample: drive for SAMPLE_PERIOD, then record what the sensors would have measured.
  const sample = (speed, yawRate) => {
    const grip = Math.abs(speed) > 0 ? (WHEEL_GRIP[scenario] ?? FULL_GRIP) : FULL_GRIP;
    const half = (yawRate * config.track) / 2;
    const rpm = (wheelSpeed, wheelGrip) =>
      ((wheelSpeed / wheelGrip / config.radius) * 60) / (2 * Math.PI);
    const left = rpm(speed - half, grip[0]);
    const right = rpm(speed + half, grip[1]);
    pose = integratePose(pose, speed * SAMPLE_PERIOD, yawRate * SAMPLE_PERIOD);
    time += SAMPLE_PERIOD;
    const ranges = Array.from({ length: LIDAR_BEAMS }, (_, beam) => {
      const angle = pose.theta + (beam * 2 * Math.PI) / LIDAR_BEAMS;
      const distance = raycast(pose, angle, rects, config.rangeMax);
      if (distance >= config.rangeMax) return null;
      return clamp(distance + gaussian(random) * RANGE_NOISE, MIN_RANGE, config.rangeMax);
    });
    const forwardAccel = (speed - previousSpeed) / SAMPLE_PERIOD;
    previousSpeed = speed;
    frames.push({
      t: +time.toFixed(6),
      leftRpm: left + gaussian(random) * RPM_NOISE,
      rightRpm: right + gaussian(random) * RPM_NOISE,
      gyroZ: yawRate + gyroOffset + gaussian(random) * GYRO_NOISE,
      accel: [forwardAccel + gaussian(random) * ACCEL_NOISE, speed * yawRate, GRAVITY],
      gyro: [0, 0, yawRate + gyroOffset],
      mag: [
        MAGNETIC_FIELD.horizontal * Math.cos(pose.theta),
        -MAGNETIC_FIELD.horizontal * Math.sin(pose.theta),
        MAGNETIC_FIELD.vertical,
      ],
      ranges,
      angleMin: 0,
      angleIncrement: (2 * Math.PI) / LIDAR_BEAMS,
      camera: slamCameraObservation(scene, pose),
    });
    reference.push({ x: pose.x - scene.start.x, y: pose.y - scene.start.y, theta: pose.theta });
  };
  const drive = (seconds, speed, yawRate) => {
    const steps = Math.round(seconds / SAMPLE_PERIOD);
    for (let step = 0; step < steps; step++) sample(speed, yawRate);
  };
  const turnBy = (angle) => drive(turnSeconds(angle), 0, turnRate(angle));

  drive(STATIONARY_SECONDS, 0, 0);
  if (scenario === 'corridor')
    // There and back: from the LiDAR's point of view the two walls barely change.
    for (let leg = 0; leg < 2; leg++) {
      drive(HALLWAY_LEG_SECONDS, CRUISE_SPEED, 0);
      turnBy(Math.PI);
    }
  else
    for (const length of ROOM_LEGS) {
      drive(length / CRUISE_SPEED, CRUISE_SPEED, 0);
      turnBy(Math.PI / 2);
    }
  drive(SETTLE_SECONDS, 0, 0);

  return {
    format: 'robo-lab-sensors-v1',
    source: 'simulation',
    scenario,
    config,
    frames,
    reference,
    scene,
    stationarySeconds: STATIONARY_SECONDS,
  };
}

// --- Scan matching -------------------------------------------------------------------------------

// One scan as points in the robot's own frame, dropping readings outside the LiDAR's range.
function scanPoints(frame, config) {
  const mount = config.lidar;
  return frame.ranges.flatMap((range, beam) => {
    if (range === null || range < MIN_RANGE || range >= config.rangeMax) return [];
    const angle = mount.yaw + frame.angleMin + beam * frame.angleIncrement;
    return [{ x: mount.x + range * Math.cos(angle), y: mount.y + range * Math.sin(angle) }];
  });
}

function transformPoints(points, pose) {
  const cos = Math.cos(pose.theta);
  const sin = Math.sin(pose.theta);
  return points.map((point) => ({
    x: pose.x + cos * point.x - sin * point.y,
    y: pose.y + sin * point.x + cos * point.y,
  }));
}

// Gauss-Jordan elimination with partial pivoting; null when the system is singular.
function solve3(matrix, rhs) {
  const rows = matrix.map((row, i) => [...row, rhs[i]]);
  for (let k = 0; k < 3; k++) {
    let pivot = k;
    for (let i = k + 1; i < 3; i++) if (Math.abs(rows[i][k]) > Math.abs(rows[pivot][k])) pivot = i;
    [rows[k], rows[pivot]] = [rows[pivot], rows[k]];
    if (Math.abs(rows[k][k]) < 1e-10) return null;
    const scale = rows[k][k];
    for (let j = k; j < 4; j++) rows[k][j] /= scale;
    for (let i = 0; i < 3; i++) {
      if (i === k) continue;
      const factor = rows[i][k];
      for (let j = k; j < 4; j++) rows[i][j] -= factor * rows[k][j];
    }
  }
  return rows.map((row) => row[3]);
}

const ICP_ITERATIONS = 7;
const ICP_MATCH_RADIUS = 0.25; // m; a scan point looks for map points this close
const ICP_MIN_MAP_POINTS = 20;
const ICP_MIN_SCAN_POINTS = 12;
const ICP_MIN_PAIRS = 10; // fewer correspondences than this means there is nothing to match
const ICP_PRIOR_XY = 0.03; // weight pulling the solution back to the wheel/IMU prediction
const ICP_PRIOR_THETA = 0.05;
const ICP_ROBUST_ERROR = 0.04; // m; larger residuals count less, so outliers cannot dominate
const ICP_QUALITY_SCALE = 0.12; // m; a mean residual this large scores zero
const ICP_MAX_SHIFT = 0.12; // m per iteration
const ICP_MAX_TURN = 0.07; // rad per iteration
const ICP_CONVERGED = 0.00015;
const ICP_WEAK_SHAPE = 0.025; // below this the scan constrains only one direction
const ICP_MIN_QUALITY = 0.35;
const ICP_MAX_CORRECTION = 0.35; // m; a bigger jump than this is not believed
const ICP_MAX_TURN_CORRECTION = 0.2; // rad

const unmatched = (pose) => ({ pose, used: false, quality: 0, weak: true });

// Point-to-line ICP against previous, estimated scans. Normals derive from scans.
function matchScan(local, prediction, map) {
  if (map.length < ICP_MIN_MAP_POINTS || local.length < ICP_MIN_SCAN_POINTS)
    return unmatched(prediction);
  let pose = copyPose(prediction);
  let quality = 0;
  let weak = false;
  for (let iteration = 0; iteration < ICP_ITERATIONS; iteration++) {
    // Normal equations of the least-squares step, seeded with the prior on the prediction.
    const normalMatrix = [
      [ICP_PRIOR_XY, 0, 0],
      [0, ICP_PRIOR_XY, 0],
      [0, 0, ICP_PRIOR_THETA],
    ];
    const rhs = [
      ICP_PRIOR_XY * (prediction.x - pose.x),
      ICP_PRIOR_XY * (prediction.y - pose.y),
      ICP_PRIOR_THETA * wrap(prediction.theta - pose.theta),
    ];
    let residual = 0;
    let pairs = 0;
    // Shape of the matched normals: two independent directions mean a well-constrained fit.
    let nxx = 0;
    let nyy = 0;
    let nxy = 0;
    const cos = Math.cos(pose.theta);
    const sin = Math.sin(pose.theta);
    for (const point of local) {
      const rx = cos * point.x - sin * point.y;
      const ry = sin * point.x + cos * point.y;
      const x = pose.x + rx;
      const y = pose.y + ry;
      let nearest = null;
      let nearestDistance2 = ICP_MATCH_RADIUS ** 2;
      for (const candidate of map) {
        const distance2 = (candidate.x - x) ** 2 + (candidate.y - y) ** 2;
        if (distance2 < nearestDistance2) {
          nearest = candidate;
          nearestDistance2 = distance2;
        }
      }
      if (!nearest) continue;
      const error = nearest.nx * (x - nearest.x) + nearest.ny * (y - nearest.y);
      const jacobian = [nearest.nx, nearest.ny, -nearest.nx * ry + nearest.ny * rx];
      const weight = Math.min(1, ICP_ROBUST_ERROR / Math.max(0.0001, Math.abs(error)));
      for (let row = 0; row < 3; row++) {
        rhs[row] -= weight * jacobian[row] * error;
        for (let column = 0; column < 3; column++)
          normalMatrix[row][column] += weight * jacobian[row] * jacobian[column];
      }
      pairs++;
      residual += Math.abs(error);
      nxx += jacobian[0] * jacobian[0];
      nyy += jacobian[1] * jacobian[1];
      nxy += jacobian[0] * jacobian[1];
    }
    if (pairs < ICP_MIN_PAIRS) return unmatched(prediction);
    weak = (nxx * nyy - nxy * nxy) / Math.max(1, (nxx + nyy) ** 2) < ICP_WEAK_SHAPE;
    const step = solve3(normalMatrix, rhs);
    if (!step) return unmatched(prediction);
    // Parallel walls constrain the normal direction, not travel along the wall.
    if (weak) {
      const axis = 0.5 * Math.atan2(2 * nxy, nxx - nyy);
      const ux = Math.cos(axis);
      const uy = Math.sin(axis);
      const alongNormal = step[0] * ux + step[1] * uy;
      step[0] = alongNormal * ux;
      step[1] = alongNormal * uy;
    }
    pose = {
      x: pose.x + clamp(step[0], -ICP_MAX_SHIFT, ICP_MAX_SHIFT),
      y: pose.y + clamp(step[1], -ICP_MAX_SHIFT, ICP_MAX_SHIFT),
      theta: wrap(pose.theta + clamp(step[2], -ICP_MAX_TURN, ICP_MAX_TURN)),
    };
    quality = clamp((pairs / local.length) * (1 - residual / pairs / ICP_QUALITY_SCALE), 0, 1);
    if (Math.hypot(...step) < ICP_CONVERGED) break;
  }
  const accepted =
    quality > ICP_MIN_QUALITY &&
    Math.hypot(pose.x - prediction.x, pose.y - prediction.y) < ICP_MAX_CORRECTION &&
    Math.abs(wrap(pose.theta - prediction.theta)) < ICP_MAX_TURN_CORRECTION;
  return { pose: accepted ? pose : prediction, used: accepted, quality, weak };
}

const NORMAL_MIN_SPAN = 0.008; // m between the neighbours of a point
const NORMAL_MAX_SPAN = 0.6; // m; a wider gap is a jump between surfaces, not a surface

// Surface direction at each scan point, taken from its two neighbours in the scan.
function normals(points, pose) {
  const mapped = transformPoints(points, pose);
  const result = [];
  for (let i = 1; i < mapped.length - 1; i++) {
    const before = mapped[i - 1];
    const after = mapped[i + 1];
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const span = Math.hypot(dx, dy);
    if (span < NORMAL_MIN_SPAN || span > NORMAL_MAX_SPAN) continue;
    result.push({ ...mapped[i], nx: -dy / span, ny: dx / span });
  }
  return result;
}

// --- Estimating the drive from the log ------------------------------------------------------------

const SUBMAP_EVERY = 3; // scans; inserting every scan would make the map dense and slow
const SUBMAP_LIMIT = 16; // scans kept as the local map
const STATIONARY_RPM = 0.3; // below this the wheels count as standing still
const MIN_CALIBRATION_SAMPLES = 3;

// Metres travelled by one wheel over `seconds` at `rpm`.
const wheelTravel = (rpm, radius, seconds) => ((rpm * 2 * Math.PI * radius) / 60) * seconds;

function stationaryFrames(frames, stationarySeconds) {
  return frames.filter(
    (frame) =>
      frame.t <= stationarySeconds &&
      Math.abs(frame.leftRpm) < STATIONARY_RPM &&
      Math.abs(frame.rightRpm) < STATIONARY_RPM,
  );
}

function estimateSlam(
  frames,
  config,
  { method = 'wheel', calibrate = false, stationarySeconds = 0 } = {},
) {
  const stationary = stationaryFrames(frames, stationarySeconds);
  if (calibrate && stationary.length < MIN_CALIBRATION_SAMPLES)
    throw Error(
      '開始時に静止した計測が3回以上必要です。最初の2秒静止したログを用意するか、補正を外してください。',
    );
  const bias = calibrate
    ? stationary.reduce((total, frame) => total + frame.gyroZ, 0) / stationary.length
    : 0;
  const states = [];
  const submaps = [];
  let pose = { x: 0, y: 0, theta: 0 };
  let lastTime = 0;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const seconds = frame.t - lastTime;
    lastTime = frame.t;
    const left = wheelTravel(frame.leftRpm, config.radius, seconds);
    const right = wheelTravel(frame.rightRpm, config.radius, seconds);
    const distance = (left + right) / 2;
    const wheelTurn = (right - left) / config.track;
    const turn = method === 'wheel' ? wheelTurn : (frame.gyroZ - bias) * seconds;
    const prediction = integratePose(pose, distance, turn);
    const local = scanPoints(frame, config);
    let match = { pose: prediction, used: false, quality: null, weak: false };
    if (method === 'slam') match = matchScan(local, prediction, submaps.flat());
    pose = match.pose;
    // Map insertion uses the corrected pose. Never insert simulator walls.
    if (method === 'slam' && i % SUBMAP_EVERY === 0) {
      submaps.push(normals(local, pose));
      if (submaps.length > SUBMAP_LIMIT) submaps.shift();
    }
    states.push({
      t: frame.t,
      ...copyPose(pose),
      quality: match.quality,
      matched: match.used,
      weak: match.weak,
      points: transformPoints(local, pose),
    });
  }
  return {
    method,
    calibrate,
    bias,
    calibrationCount: calibrate ? stationary.length : 0,
    states,
  };
}

// How far the estimate ended up from the truth; a log from a real robot has no truth, so those
// numbers stay null and only the distance back to the start is reported.
function slamMetrics(result, log) {
  const end = result.states.at(-1);
  const reference = log.reference;
  const endReference = reference?.at(-1);
  let squareSum = 0;
  let count = 0;
  if (reference)
    result.states.forEach((pose, i) => {
      const truth = reference[i];
      if (!truth) return;
      squareSum += (pose.x - truth.x) ** 2 + (pose.y - truth.y) ** 2;
      count++;
    });
  return {
    endError: endReference ? Math.hypot(end.x - endReference.x, end.y - endReference.y) : null,
    rmse: count ? Math.sqrt(squareSum / count) : null,
    closure: Math.hypot(end.x, end.y),
    headingError: endReference ? Math.abs(wrap(end.theta - endReference.theta)) : null,
    weakCount: result.states.filter((state) => state.weak).length,
  };
}

// --- Reading a log recorded on a real robot ---------------------------------------------------------

const LOG_LIMITS = {
  radius: [0.005, 1], // m
  track: [0.03, 3], // m
  rangeMax: [0.2, 50], // m
  lidarOffset: 3, // m from the centre of the robot
  frames: [3, 3000],
  beams: [12, 720],
  samplePeriod: 2, // s; a longer gap between samples cannot be integrated sensibly
  rpm: 1000,
  gyro: 20, // rad/s
  points: 250000,
  stationarySeconds: [0, 5],
};

const finite = Number.isFinite;
const within = (value, [low, high]) => finite(value) && value >= low && value <= high;

function validateConfig(config) {
  if (
    !config ||
    !within(config.radius, LOG_LIMITS.radius) ||
    !within(config.track, LOG_LIMITS.track) ||
    !within(config.rangeMax, LOG_LIMITS.rangeMax)
  )
    throw Error('車輪の半径・左右間隔・LiDARの最大距離を、m単位で指定してください。');
  const lidar = config.lidar || { x: 0, y: 0, yaw: 0 };
  if (
    ![lidar.x, lidar.y, lidar.yaw].every(finite) ||
    Math.hypot(lidar.x, lidar.y) > LOG_LIMITS.lidarOffset
  )
    throw Error('LiDARの取付位置・角度を確認してください。');
  return { radius: config.radius, track: config.track, rangeMax: config.rangeMax, lidar };
}

// Every reading the maths uses has to be a number, in order, and within reach of the hardware.
function validateFrame(frame, index, previousTime, rangeMax) {
  const position = index + 1;
  if (
    ![
      frame.t,
      frame.leftRpm,
      frame.rightRpm,
      frame.gyroZ,
      frame.angleMin,
      frame.angleIncrement,
    ].every(finite) ||
    frame.t <= previousTime ||
    frame.t - previousTime > LOG_LIMITS.samplePeriod ||
    Math.abs(frame.leftRpm) > LOG_LIMITS.rpm ||
    Math.abs(frame.rightRpm) > LOG_LIMITS.rpm ||
    Math.abs(frame.gyroZ) > LOG_LIMITS.gyro
  )
    throw Error(
      position +
        '番目の時刻・回転数・角速度を確認してください。時刻は0秒からの経過秒、間隔は2秒以下です。',
    );
  if (
    !Array.isArray(frame.ranges) ||
    !within(frame.ranges.length, LOG_LIMITS.beams) ||
    frame.angleIncrement <= 0 ||
    frame.angleIncrement * (frame.ranges.length - 1) > 2 * Math.PI + 0.1 ||
    frame.ranges.some(
      (range) => range !== null && (!finite(range) || range < 0 || range > rangeMax),
    )
  )
    throw Error(position + '番目の距離配列を確認してください。測定できなかった値はnullです。');
}

const vector3 = (value) =>
  Array.isArray(value) && value.length === 3 && value.every(finite) ? [...value] : null;

function validateSlamLog(input) {
  if (!input || input.format !== 'robo-lab-sensors-v1')
    throw Error('形式が違います。サンプルと同じ robo-lab-sensors-v1 のJSONを選んでください。');
  const config = validateConfig(input.config);
  if (!Array.isArray(input.frames) || !within(input.frames.length, LOG_LIMITS.frames))
    throw Error('計測は3〜3,000フレームにしてください。');
  let previousTime = 0;
  let points = 0;
  const frames = input.frames.map((frame, index) => {
    validateFrame(frame, index, previousTime, config.rangeMax);
    previousTime = frame.t;
    points += frame.ranges.length;
    if (points > LOG_LIMITS.points)
      throw Error('距離データが多すぎます。間引いて25万点以下にしてください。');
    return {
      t: frame.t,
      leftRpm: frame.leftRpm,
      rightRpm: frame.rightRpm,
      gyroZ: frame.gyroZ,
      ranges: [...frame.ranges],
      angleMin: frame.angleMin,
      angleIncrement: frame.angleIncrement,
      accel: vector3(frame.accel),
      gyro: vector3(frame.gyro),
      mag: vector3(frame.mag),
      camera: null,
    };
  });
  const stationarySeconds = finite(input.stationarySeconds)
    ? clamp(input.stationarySeconds, ...LOG_LIMITS.stationarySeconds)
    : 0;
  // Uploaded truth is intentionally not trusted as a measurement of accuracy.
  return {
    format: input.format,
    source: 'hardware',
    config: { ...config, lidar: { ...config.lidar } },
    frames,
    stationarySeconds,
    reference: null,
    scene: null,
  };
}

export {
  SLAM_METHODS,
  SLAM_CASES,
  integratePose,
  generateSlamLog,
  transformPoints,
  estimateSlam,
  slamMetrics,
  validateSlamLog,
};
