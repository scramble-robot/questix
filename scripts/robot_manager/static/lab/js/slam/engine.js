import { randomGenerator, gaussian, wrap, clamp } from '../core/engine.js';
import { slamSceneRects, slamCameraObservation } from './camera.js';

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
const copyPose = (p) => ({ x: p.x, y: p.y, theta: p.theta });
function integratePose(p, ds, da) {
  const a = p.theta + da / 2;
  return { x: p.x + ds * Math.cos(a), y: p.y + ds * Math.sin(a), theta: wrap(p.theta + da) };
}
function raycast(p, a, rects, max) {
  const dx = Math.cos(a),
    dy = Math.sin(a);
  let best = max;
  for (const [x0, y0, x1, y1] of rects) {
    let near = -Infinity,
      far = Infinity;
    for (const [v, d, lo, hi] of [
      [p.x, dx, x0, x1],
      [p.y, dy, y0, y1],
    ]) {
      if (Math.abs(d) < 1e-9) {
        if (v < lo || v > hi) {
          far = -Infinity;
          break;
        }
      } else {
        const t0 = (lo - v) / d,
          t1 = (hi - v) / d;
        near = Math.max(near, Math.min(t0, t1));
        far = Math.min(far, Math.max(t0, t1));
      }
    }
    if (far >= Math.max(near, 0) && near >= 0) best = Math.min(best, near);
  }
  return best;
}
function generateSlamLog(scenario = 'slip', seed = 42) {
  const hallway = scenario === 'corridor',
    width = hallway ? 14 : 4.8,
    height = hallway ? 2.2 : 3.2,
    start = hallway ? { x: 4, y: 1.1, theta: 0 } : { x: 0.55, y: 0.55, theta: 0 };
  const walls = hallway
    ? []
    : [
        { x: 1.4, y: 1.35, w: 0.35, h: 1.15 },
        { x: 2.85, y: 0.7, w: 0.35, h: 1.05 },
      ];
  const scene = { width, height, walls, start },
    rects = slamSceneRects(scene);
  const config = { radius: 0.065, track: 0.32, rangeMax: 3.2, lidar: { x: 0, y: 0, yaw: 0 } },
    rng = randomGenerator(seed),
    frames = [],
    reference = [],
    dt = 0.2;
  let pose = { ...start },
    time = 0,
    previousV = 0;
  const add = (v, omega) => {
    const moving = Math.abs(v) > 0,
      gripL = scenario === 'slip' && moving ? 0.96 : scenario === 'corridor' && moving ? 0.93 : 1,
      gripR = scenario === 'slip' && moving ? 0.995 : scenario === 'corridor' && moving ? 0.93 : 1;
    const left = (((v - (omega * config.track) / 2) / gripL / config.radius) * 60) / (2 * Math.PI),
      right = (((v + (omega * config.track) / 2) / gripR / config.radius) * 60) / (2 * Math.PI);
    pose = integratePose(pose, v * dt, omega * dt);
    time += dt;
    const ranges = Array.from({ length: 72 }, (_, i) => {
      const d = raycast(pose, pose.theta + (i * 2 * Math.PI) / 72, rects, config.rangeMax);
      return d >= config.rangeMax ? null : clamp(d + gaussian(rng) * 0.008, 0.03, config.rangeMax);
    });
    const bias = scenario === 'bias' ? 0.026 : 0.001,
      ax = (v - previousV) / dt;
    previousV = v;
    frames.push({
      t: +time.toFixed(6),
      leftRpm: left + gaussian(rng) * 0.015,
      rightRpm: right + gaussian(rng) * 0.015,
      gyroZ: omega + bias + gaussian(rng) * 0.0015,
      accel: [ax + gaussian(rng) * 0.02, v * omega, 9.81],
      gyro: [0, 0, omega + bias],
      mag: [25 * Math.cos(pose.theta), -25 * Math.sin(pose.theta), -40],
      ranges,
      angleMin: 0,
      angleIncrement: (2 * Math.PI) / 72,
      camera: slamCameraObservation(scene, pose),
    });
    reference.push({ x: pose.x - start.x, y: pose.y - start.y, theta: pose.theta });
  };
  const segment = (length, v, w) => {
    const n = Math.round(length / dt);
    for (let i = 0; i < n; i++) add(v, w);
  };
  segment(2, 0, 0);
  if (hallway) {
    segment(20, 0.25, 0);
    segment(Math.PI / 0.65, 0, Math.PI / (Math.round(Math.PI / 0.65 / dt) * dt));
    segment(20, 0.25, 0);
    segment(Math.PI / 0.65, 0, Math.PI / (Math.round(Math.PI / 0.65 / dt) * dt));
  } else
    for (const length of [3.7, 2.1, 3.7, 2.1]) {
      segment(length / 0.25, 0.25, 0);
      segment(Math.PI / 2 / 0.65, 0, Math.PI / 2 / (Math.round(Math.PI / 2 / 0.65 / dt) * dt));
    }
  segment(1, 0, 0);
  return {
    format: 'robo-lab-sensors-v1',
    source: 'simulation',
    scenario,
    config,
    frames,
    reference,
    scene: { width, height, walls, start },
    stationarySeconds: 2,
  };
}
function scanPoints(f, config) {
  const e = config.lidar;
  return f.ranges.flatMap((r, i) =>
    r === null || r < 0.03 || r >= config.rangeMax
      ? []
      : [
          {
            x: e.x + r * Math.cos(e.yaw + f.angleMin + i * f.angleIncrement),
            y: e.y + r * Math.sin(e.yaw + f.angleMin + i * f.angleIncrement),
          },
        ],
  );
}
function transformPoints(points, p) {
  const c = Math.cos(p.theta),
    s = Math.sin(p.theta);
  return points.map((q) => ({ x: p.x + c * q.x - s * q.y, y: p.y + s * q.x + c * q.y }));
}
function solve3(a, b) {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let k = 0; k < 3; k++) {
    let best = k;
    for (let i = k + 1; i < 3; i++) if (Math.abs(m[i][k]) > Math.abs(m[best][k])) best = i;
    [m[k], m[best]] = [m[best], m[k]];
    if (Math.abs(m[k][k]) < 1e-10) return null;
    const v = m[k][k];
    for (let j = k; j < 4; j++) m[k][j] /= v;
    for (let i = 0; i < 3; i++)
      if (i !== k) {
        const f = m[i][k];
        for (let j = k; j < 4; j++) m[i][j] -= f * m[k][j];
      }
  }
  return m.map((row) => row[3]);
}
// Point-to-line ICP against previous, estimated scans. Normals derive from scans.
function matchScan(local, pred, map) {
  if (map.length < 20 || local.length < 12)
    return { pose: pred, used: false, quality: 0, weak: true };
  let p = copyPose(pred),
    quality = 0,
    weak = false;
  for (let iter = 0; iter < 7; iter++) {
    const a = [
        [0.03, 0, 0],
        [0, 0.03, 0],
        [0, 0, 0.05],
      ],
      b = [0.03 * (pred.x - p.x), 0.03 * (pred.y - p.y), 0.05 * wrap(pred.theta - p.theta)];
    let total = 0,
      count = 0,
      nxx = 0,
      nyy = 0,
      nxy = 0;
    const c = Math.cos(p.theta),
      s = Math.sin(p.theta);
    for (const q of local) {
      const rx = c * q.x - s * q.y,
        ry = s * q.x + c * q.y,
        x = p.x + rx,
        y = p.y + ry;
      let best = null,
        d2 = 0.25 ** 2;
      for (const m of map) {
        const d = (m.x - x) ** 2 + (m.y - y) ** 2;
        if (d < d2) {
          best = m;
          d2 = d;
        }
      }
      if (!best) continue;
      const error = best.nx * (x - best.x) + best.ny * (y - best.y),
        j = [best.nx, best.ny, -best.nx * ry + best.ny * rx],
        weight = Math.min(1, 0.04 / Math.max(0.0001, Math.abs(error)));
      for (let r = 0; r < 3; r++) {
        b[r] -= weight * j[r] * error;
        for (let col = 0; col < 3; col++) a[r][col] += weight * j[r] * j[col];
      }
      count++;
      total += Math.abs(error);
      nxx += j[0] * j[0];
      nyy += j[1] * j[1];
      nxy += j[0] * j[1];
    }
    if (count < 10) return { pose: pred, used: false, quality: 0, weak: true };
    weak = (nxx * nyy - nxy * nxy) / Math.max(1, (nxx + nyy) ** 2) < 0.025;
    const step = solve3(a, b);
    if (!step) return { pose: pred, used: false, quality: 0, weak: true };
    // Parallel walls constrain the normal direction, not travel along the wall.
    if (weak) {
      const axis = 0.5 * Math.atan2(2 * nxy, nxx - nyy),
        ux = Math.cos(axis),
        uy = Math.sin(axis),
        normal = step[0] * ux + step[1] * uy;
      step[0] = normal * ux;
      step[1] = normal * uy;
    }
    p = {
      x: p.x + clamp(step[0], -0.12, 0.12),
      y: p.y + clamp(step[1], -0.12, 0.12),
      theta: wrap(p.theta + clamp(step[2], -0.07, 0.07)),
    };
    quality = clamp((count / local.length) * (1 - total / count / 0.12), 0, 1);
    if (Math.hypot(...step) < 0.00015) break;
  }
  const accepted =
    quality > 0.35 &&
    Math.hypot(p.x - pred.x, p.y - pred.y) < 0.35 &&
    Math.abs(wrap(p.theta - pred.theta)) < 0.2;
  return { pose: accepted ? p : pred, used: accepted, quality, weak };
}
function normals(points, p) {
  const mapped = transformPoints(points, p),
    out = [];
  for (let i = 1; i < mapped.length - 1; i++) {
    const a = mapped[i - 1],
      b = mapped[i + 1],
      q = mapped[i],
      dx = b.x - a.x,
      dy = b.y - a.y,
      len = Math.hypot(dx, dy);
    if (len < 0.008 || len > 0.6) continue;
    out.push({ ...q, nx: -dy / len, ny: dx / len });
  }
  return out;
}
function estimateSlam(
  frames,
  config,
  { method = 'wheel', calibrate = false, stationarySeconds = 0 } = {},
) {
  let p = { x: 0, y: 0, theta: 0 },
    lastTime = 0;
  const states = [],
    submaps = [];
  const stationary = frames.filter(
    (f) => f.t <= stationarySeconds && Math.abs(f.leftRpm) < 0.3 && Math.abs(f.rightRpm) < 0.3,
  );
  if (calibrate && stationary.length < 3)
    throw Error(
      '開始時に静止した計測が3回以上必要です。最初の2秒静止したログを用意するか、補正を外してください。',
    );
  const bias =
    calibrate && stationary.length >= 3
      ? stationary.reduce((s, f) => s + f.gyroZ, 0) / stationary.length
      : 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i],
      dt = f.t - lastTime;
    lastTime = f.t;
    const dl = ((f.leftRpm * 2 * Math.PI * config.radius) / 60) * dt,
      dr = ((f.rightRpm * 2 * Math.PI * config.radius) / 60) * dt,
      ds = (dl + dr) / 2,
      wheelTurn = (dr - dl) / config.track;
    const da = method === 'wheel' ? wheelTurn : (f.gyroZ - bias) * dt;
    const pred = integratePose(p, ds, da),
      local = scanPoints(f, config);
    let match = { pose: pred, used: false, quality: null, weak: false };
    if (method === 'slam') match = matchScan(local, pred, submaps.flat());
    p = match.pose;
    // Map insertion uses the corrected pose. Never insert simulator walls.
    if (method === 'slam' && (i % 3 === 0 || i === 0)) {
      submaps.push(normals(local, p));
      if (submaps.length > 16) submaps.shift();
    }
    states.push({
      t: f.t,
      ...copyPose(p),
      quality: match.quality,
      matched: match.used,
      weak: match.weak,
      points: transformPoints(local, p),
    });
  }
  return { method, calibrate, bias, calibrationCount: calibrate ? stationary.length : 0, states };
}
function slamMetrics(result, log) {
  const end = result.states.at(-1),
    ref = log.reference?.at(-1);
  let sum = 0,
    count = 0;
  if (log.reference)
    result.states.forEach((p, i) => {
      const r = log.reference[i];
      if (r) {
        sum += (p.x - r.x) ** 2 + (p.y - r.y) ** 2;
        count++;
      }
    });
  return {
    endError: ref ? Math.hypot(end.x - ref.x, end.y - ref.y) : null,
    rmse: count ? Math.sqrt(sum / count) : null,
    closure: Math.hypot(end.x, end.y),
    headingError: ref ? Math.abs(wrap(end.theta - ref.theta)) : null,
    weakCount: result.states.filter((s) => s.weak).length,
  };
}
function validateSlamLog(input) {
  if (!input || input.format !== 'robo-lab-sensors-v1')
    throw Error('形式が違います。サンプルと同じ robo-lab-sensors-v1 のJSONを選んでください。');
  const c = input.config,
    finite = Number.isFinite;
  if (
    !c ||
    !finite(c.radius) ||
    c.radius < 0.005 ||
    c.radius > 1 ||
    !finite(c.track) ||
    c.track < 0.03 ||
    c.track > 3 ||
    !finite(c.rangeMax) ||
    c.rangeMax < 0.2 ||
    c.rangeMax > 50
  )
    throw Error('車輪の半径・左右間隔・LiDARの最大距離を、m単位で指定してください。');
  const lidar = c.lidar || { x: 0, y: 0, yaw: 0 };
  if (![lidar.x, lidar.y, lidar.yaw].every(finite) || Math.hypot(lidar.x, lidar.y) > 3)
    throw Error('LiDARの取付位置・角度を確認してください。');
  if (!Array.isArray(input.frames) || input.frames.length < 3 || input.frames.length > 3000)
    throw Error('計測は3〜3,000フレームにしてください。');
  let previous = 0,
    total = 0;
  const frames = input.frames.map((f, i) => {
    if (
      ![f.t, f.leftRpm, f.rightRpm, f.gyroZ, f.angleMin, f.angleIncrement].every(finite) ||
      f.t <= previous ||
      f.t - previous > 2 ||
      Math.abs(f.leftRpm) > 1000 ||
      Math.abs(f.rightRpm) > 1000 ||
      Math.abs(f.gyroZ) > 20
    )
      throw Error(
        i +
          1 +
          '番目の時刻・回転数・角速度を確認してください。時刻は0秒からの経過秒、間隔は2秒以下です。',
      );
    previous = f.t;
    if (
      !Array.isArray(f.ranges) ||
      f.ranges.length < 12 ||
      f.ranges.length > 720 ||
      f.angleIncrement <= 0 ||
      f.angleIncrement * (f.ranges.length - 1) > 2 * Math.PI + 0.1 ||
      f.ranges.some((r) => r !== null && (!finite(r) || r < 0 || r > c.rangeMax))
    )
      throw Error(i + 1 + '番目の距離配列を確認してください。測定できなかった値はnullです。');
    total += f.ranges.length;
    if (total > 250000) throw Error('距離データが多すぎます。間引いて25万点以下にしてください。');
    const vec = (v) => (Array.isArray(v) && v.length === 3 && v.every(finite) ? [...v] : null);
    return {
      t: f.t,
      leftRpm: f.leftRpm,
      rightRpm: f.rightRpm,
      gyroZ: f.gyroZ,
      ranges: [...f.ranges],
      angleMin: f.angleMin,
      angleIncrement: f.angleIncrement,
      accel: vec(f.accel),
      gyro: vec(f.gyro),
      mag: vec(f.mag),
      camera: null,
    };
  });
  const stationarySeconds = finite(input.stationarySeconds)
    ? clamp(input.stationarySeconds, 0, 5)
    : 0;
  // Uploaded truth is intentionally not trusted as a measurement of accuracy.
  return {
    format: input.format,
    source: 'hardware',
    config: { radius: c.radius, track: c.track, rangeMax: c.rangeMax, lidar: { ...lidar } },
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
