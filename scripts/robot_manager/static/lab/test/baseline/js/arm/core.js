// Millimetres and degrees in the teaching model; URDF transforms use metres/radians.
const ARM_TOPICS = [
  { id: 'joints', label: '関節と手先' },
  { id: 'forward', label: '角度から位置へ' },
  { id: 'inverse', label: '位置から角度へ' },
  { id: 'reach', label: '届く範囲' },
  { id: 'challenge', label: '障害物を避けて届く' },
  { id: 'hardware', label: 'SO-ARM101で確かめる' },
];
const ARM_MODEL = {
  l1: 160,
  l2: 130,
  limits: [
    [0, 150],
    [-150, 150],
  ],
  radius: 7,
};
const ARM_GOALS = [
  { x: 200, z: 160 },
  { x: 160, z: 170 },
  { x: 230, z: 140 },
];
const ARM_OBSTACLE = { x: 145, z: 55, r: 25 };
const rad = (d) => (d * Math.PI) / 180,
  deg = (r) => (r * 180) / Math.PI;
const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
function armFK(q, model = ARM_MODEL) {
  const [a, b] = q.map(rad),
    elbow = { x: model.l1 * Math.cos(a), z: model.l1 * Math.sin(a) };
  return {
    base: { x: 0, z: 0 },
    elbow,
    tip: { x: elbow.x + model.l2 * Math.cos(a + b), z: elbow.z + model.l2 * Math.sin(a + b) },
    angle: q[0] + q[1],
  };
}
function armIK(target, limited = false, model = ARM_MODEL) {
  if (!Number.isFinite(target.x) || !Number.isFinite(target.z))
    return { reason: 'invalid', solutions: [] };
  const r = Math.hypot(target.x, target.z),
    inner = Math.abs(model.l1 - model.l2),
    outer = model.l1 + model.l2;
  if (r > outer + 1e-7 || r < inner - 1e-7)
    return { reason: r > outer ? 'far' : 'near', solutions: [], r };
  const c = Math.max(
    -1,
    Math.min(1, (r * r - model.l1 ** 2 - model.l2 ** 2) / (2 * model.l1 * model.l2)),
  );
  const bend = Math.acos(c),
    angles = bend < 1e-9 || Math.abs(bend - Math.PI) < 1e-9 ? [bend] : [bend, -bend];
  const solutions = angles.map((b) => {
    const a =
      Math.atan2(target.z, target.x) -
      Math.atan2(model.l2 * Math.sin(b), model.l1 + model.l2 * Math.cos(b));
    const q = [wrap(deg(a)), wrap(deg(b))],
      allowed =
        !limited ||
        q.every((v, i) => v >= model.limits[i][0] - 1e-7 && v <= model.limits[i][1] + 1e-7);
    return { q, allowed, tip: armFK(q, model).tip };
  });
  return {
    reason: solutions.some((s) => s.allowed) ? 'ok' : 'limits',
    solutions,
    r,
    singular: Math.abs(Math.sin(bend)) < 0.05,
  };
}
function armSegmentDistance(p, a, b) {
  const dx = b.x - a.x,
    dz = b.z - a.z,
    n = dx * dx + dz * dz,
    t = n ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / n)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
}
function armClearance(q, obstacle = ARM_OBSTACLE) {
  const f = armFK(q);
  return (
    Math.min(
      armSegmentDistance(obstacle, f.base, f.elbow),
      armSegmentDistance(obstacle, f.elbow, f.tip),
    ) -
    obstacle.r -
    ARM_MODEL.radius
  );
}
function armTrajectory(from, to, obstacle = null) {
  const duration = Math.max(1.6, Math.max(...to.map((v, i) => Math.abs(v - from[i]))) / 45),
    steps = Math.ceil(duration * 60),
    samples = [];
  let collision = false,
    minClearance = Infinity;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps,
      s = u * u * (3 - 2 * u),
      q = from.map((v, j) => v + (to[j] - v) * s),
      clearance = obstacle ? armClearance(q, obstacle) : Infinity;
    minClearance = Math.min(minClearance, clearance);
    samples.push({ q, t: duration * u, ...armFK(q), clearance });
    if (clearance <= 0) {
      collision = true;
      break;
    }
  }
  return { samples, collision, minClearance, duration: samples.at(-1).t };
}
// Geometry transcribed from TheRobotStudio/SO-ARM100, Simulation/SO101/so101_new_calib.urdf.
// See docs/arm-curriculum.md for source, assumptions and verification. No mesh assets are used.
const SO101_JOINTS = [
  {
    name: 'shoulder_pan',
    label: '台座の旋回',
    xyz: [0.0388353, -8.97657e-9, 0.0624],
    rpy: [Math.PI, 0, -Math.PI],
    limit: [-1.91986, 1.91986],
  },
  {
    name: 'shoulder_lift',
    label: '肩',
    xyz: [-0.0303992, -0.0182778, -0.0542],
    rpy: [-Math.PI / 2, -Math.PI / 2, 0],
    limit: [-1.74533, 1.74533],
  },
  {
    name: 'elbow_flex',
    label: '肘',
    xyz: [-0.11257, -0.028, 0],
    rpy: [0, 0, Math.PI / 2],
    limit: [-1.69, 1.69],
  },
  {
    name: 'wrist_flex',
    label: '手首の曲げ',
    xyz: [-0.1349, 0.0052, 0],
    rpy: [0, 0, -Math.PI / 2],
    limit: [-1.65806, 1.65806],
  },
  {
    name: 'wrist_roll',
    label: '手首の回転',
    xyz: [0, -0.0611, 0.0181],
    rpy: [Math.PI / 2, 0.0486795, Math.PI],
    limit: [-2.74385, 2.84121],
  },
];
function mul(a, b) {
  return Array.from({ length: 16 }, (_, i) => {
    const r = Math.floor(i / 4),
      c = i % 4;
    return [0, 1, 2, 3].reduce((s, k) => s + a[r * 4 + k] * b[k * 4 + c], 0);
  });
}
function transform(xyz, rpy) {
  const [r, p, y] = rpy,
    cr = Math.cos(r),
    sr = Math.sin(r),
    cp = Math.cos(p),
    sp = Math.sin(p),
    cy = Math.cos(y),
    sy = Math.sin(y);
  return [
    cy * cp,
    cy * sp * sr - sy * cr,
    cy * sp * cr + sy * sr,
    xyz[0],
    sy * cp,
    sy * sp * sr + cy * cr,
    sy * sp * cr - cy * sr,
    xyz[1],
    -sp,
    cp * sr,
    cp * cr,
    xyz[2],
    0,
    0,
    0,
    1,
  ];
}
function so101FK(q) {
  if (q.length !== 5 || q.some((v) => !Number.isFinite(v)))
    throw new Error('5つの関節角度が必要です');
  let matrix = transform([0, 0, 0], [0, 0, 0]);
  const points = [{ x: 0, y: 0, z: 0 }];
  const point = (m) => ({ x: m[3] * 1000, y: m[7] * 1000, z: m[11] * 1000 });
  for (let i = 0; i < 5; i++) {
    const j = SO101_JOINTS[i];
    matrix = mul(mul(matrix, transform(j.xyz, j.rpy)), transform([0, 0, 0], [0, 0, rad(q[i])]));
    points.push(point(matrix));
  }
  matrix = mul(matrix, transform([-0.0079, -0.000218121, -0.0981274], [0, Math.PI, 0]));
  points.push(point(matrix));
  return { points, tip: point(matrix), matrix };
}
function armParseJointState(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    throw new Error('JSONとして読み取れません。nameとpositionを持つ1件のデータを使ってください。');
  }
  if (
    !Array.isArray(msg.name) ||
    !Array.isArray(msg.position) ||
    msg.name.length !== msg.position.length
  )
    throw new Error('nameとpositionを、同じ個数の配列にしてください。');
  const q = SO101_JOINTS.map((j) => {
    const ids = msg.name.map((n, i) => (n === j.name ? i : -1)).filter((i) => i >= 0);
    if (ids.length !== 1) throw new Error(j.name + 'が1つ必要です。');
    const v = msg.position[ids[0]];
    if (typeof v !== 'number' || !Number.isFinite(v))
      throw new Error('positionにはラジアン単位の数値が必要です。');
    return deg(v);
  });
  if (
    q.some(
      (v, i) =>
        rad(v) < SO101_JOINTS[i].limit[0] - 1e-6 || rad(v) > SO101_JOINTS[i].limit[1] + 1e-6,
    )
  )
    throw new Error(
      '教材で参照するURDFの関節範囲を超えています。角度の単位・原点と実機のURDFを確認してください。',
    );
  return q;
}

export {
  ARM_TOPICS,
  ARM_MODEL,
  ARM_GOALS,
  ARM_OBSTACLE,
  armFK,
  armIK,
  armSegmentDistance,
  armClearance,
  armTrajectory,
  SO101_JOINTS,
  so101FK,
  armParseJointState,
};
