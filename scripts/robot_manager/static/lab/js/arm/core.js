// Kinematics of the arm course. The teaching model is a two-joint arm seen from the side, in
// millimetres and degrees; SO-ARM101 is the real robot, whose URDF transforms are in metres and
// radians. No DOM, so this module can be imported from Node for tests.

const ARM_TOPICS = [
  { id: 'joints', label: '関節と手先' },
  { id: 'forward', label: '角度から位置へ' },
  { id: 'inverse', label: '位置から角度へ' },
  { id: 'reach', label: '届く範囲' },
  { id: 'challenge', label: '障害物を避けて届く' },
  { id: 'hardware', label: 'SO-ARM101で確かめる' },
];
const ARM_MODEL = {
  l1: 160, // mm, shoulder to elbow
  l2: 130, // mm, elbow to tip
  limits: [
    [0, 150], // degrees the shoulder may take when the limits are switched on
    [-150, 150], // degrees the elbow may take
  ],
  radius: 7, // mm, half the thickness of a bar
};
const ARM_GOALS = [
  { x: 200, z: 160 },
  { x: 160, z: 170 },
  { x: 230, z: 140 },
];
const ARM_OBSTACLE = { x: 145, z: 55, r: 25 }; // mm: the post of the obstacle experiment

const REACH_TOLERANCE = 1e-7; // mm of rounding allowed when deciding "too far" / "too near"
const LIMIT_TOLERANCE = 1e-7; // degrees of rounding allowed at a joint limit
const STRAIGHT_TOLERANCE = 1e-9; // radians: below this the two bars count as one straight line
const SINGULAR_SINE = 0.05; // |sin(elbow)| under which the two poses are nearly the same
const MIN_DURATION = 1.6; // seconds: even a small move is shown slowly enough to follow
const MAX_JOINT_SPEED = 45; // degrees per second of the simulated motion
const SAMPLE_RATE = 60; // samples per second

const toRadians = (degrees) => (degrees * Math.PI) / 180;
const toDegrees = (radians) => (radians * 180) / Math.PI;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
// The same angle written between -180° and 180°.
const wrap = (degrees) => ((((degrees + 180) % 360) + 360) % 360) - 180;

// Forward kinematics: from the two joint angles (degrees) to where the bars and the tip are (mm).
function armFK(q, model = ARM_MODEL) {
  const shoulder = toRadians(q[0]);
  const elbowBend = toRadians(q[1]);
  const elbow = { x: model.l1 * Math.cos(shoulder), z: model.l1 * Math.sin(shoulder) };
  return {
    base: { x: 0, z: 0 },
    elbow,
    tip: {
      x: elbow.x + model.l2 * Math.cos(shoulder + elbowBend),
      z: elbow.z + model.l2 * Math.sin(shoulder + elbowBend),
    },
    angle: q[0] + q[1], // degrees of the second bar against the x axis
  };
}

const withinLimits = (q, model) =>
  q.every(
    (angle, joint) =>
      angle >= model.limits[joint][0] - LIMIT_TOLERANCE &&
      angle <= model.limits[joint][1] + LIMIT_TOLERANCE,
  );

// One of the two poses that reach the target: the elbow bends by `bend`, the shoulder turns to
// the target and back by the angle the second bar contributes.
function poseForBend(target, bend, model, limited) {
  const shoulder =
    Math.atan2(target.z, target.x) -
    Math.atan2(model.l2 * Math.sin(bend), model.l1 + model.l2 * Math.cos(bend));
  const q = [wrap(toDegrees(shoulder)), wrap(toDegrees(bend))];
  return { q, allowed: !limited || withinLimits(q, model), tip: armFK(q, model).tip };
}

// Inverse kinematics: from a target (mm) to the joint angles that reach it. `reason` says why
// there is no answer ('far', 'near', 'limits', 'invalid'), `singular` marks the nearly straight
// poses where both answers meet.
function armIK(target, limited = false, model = ARM_MODEL) {
  if (!Number.isFinite(target.x) || !Number.isFinite(target.z))
    return { reason: 'invalid', solutions: [] };
  const distance = Math.hypot(target.x, target.z);
  const folded = Math.abs(model.l1 - model.l2);
  const stretched = model.l1 + model.l2;
  if (distance > stretched + REACH_TOLERANCE || distance < folded - REACH_TOLERANCE)
    return { reason: distance > stretched ? 'far' : 'near', solutions: [], r: distance };
  const cosine = clamp(
    (distance * distance - model.l1 ** 2 - model.l2 ** 2) / (2 * model.l1 * model.l2),
    -1,
    1,
  );
  const bend = Math.acos(cosine);
  const straight = bend < STRAIGHT_TOLERANCE || Math.abs(bend - Math.PI) < STRAIGHT_TOLERANCE;
  const bends = straight ? [bend] : [bend, -bend]; // elbow up and elbow down
  const solutions = bends.map((angle) => poseForBend(target, angle, model, limited));
  return {
    reason: solutions.some((solution) => solution.allowed) ? 'ok' : 'limits',
    solutions,
    r: distance,
    singular: Math.abs(Math.sin(bend)) < SINGULAR_SINE,
  };
}

// Shortest distance (mm) from a point to the bar between `from` and `to`.
function armSegmentDistance(point, from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const lengthSquared = dx * dx + dz * dz;
  const along = lengthSquared
    ? clamp(((point.x - from.x) * dx + (point.z - from.z) * dz) / lengthSquared, 0, 1)
    : 0;
  return Math.hypot(point.x - from.x - along * dx, point.z - from.z - along * dz);
}

// Gap (mm) between the whole arm and the post: negative once they overlap.
function armClearance(q, obstacle = ARM_OBSTACLE) {
  const pose = armFK(q);
  const nearest = Math.min(
    armSegmentDistance(obstacle, pose.base, pose.elbow),
    armSegmentDistance(obstacle, pose.elbow, pose.tip),
  );
  return nearest - obstacle.r - ARM_MODEL.radius;
}

// Both joints move at once and are eased in and out, so the tip does not travel in a straight
// line. With an obstacle the motion stops at the sample that touches it.
function armTrajectory(from, to, obstacle = null) {
  const turn = Math.max(...to.map((angle, joint) => Math.abs(angle - from[joint]))); // degrees
  const duration = Math.max(MIN_DURATION, turn / MAX_JOINT_SPEED); // seconds
  const steps = Math.ceil(duration * SAMPLE_RATE);
  const samples = [];
  let collision = false;
  let minClearance = Infinity;
  for (let step = 0; step <= steps; step++) {
    const progress = step / steps;
    const eased = progress * progress * (3 - 2 * progress); // smoothstep: starts and ends at rest
    const q = from.map((angle, joint) => angle + (to[joint] - angle) * eased);
    const clearance = obstacle ? armClearance(q, obstacle) : Infinity;
    minClearance = Math.min(minClearance, clearance);
    samples.push({ q, t: duration * progress, ...armFK(q), clearance });
    if (clearance <= 0) {
      collision = true;
      break;
    }
  }
  return { samples, collision, minClearance, duration: samples.at(-1).t };
}

// Geometry transcribed from TheRobotStudio/SO-ARM100, Simulation/SO101/so101_new_calib.urdf.
// See docs/arm-curriculum.md for source, assumptions and verification. No mesh assets are used.
// xyz is in metres, rpy and limit in radians, each relative to the previous joint.
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
// Last joint → gripper_frame_link, the fixed point whose position the lesson compares with a ruler.
const TIP_IN_WRIST = { xyz: [-0.0079, -0.000218121, -0.0981274], rpy: [0, Math.PI, 0] };
const JOINT_LIMIT_TOLERANCE = 1e-6; // radians of rounding allowed in a recorded JointState

// Row-major 4×4 homogeneous transforms, as in URDF.
function multiply(a, b) {
  return Array.from({ length: 16 }, (_, cell) => {
    const row = Math.floor(cell / 4);
    const column = cell % 4;
    return [0, 1, 2, 3].reduce((sum, k) => sum + a[row * 4 + k] * b[k * 4 + column], 0);
  });
}

// A URDF <origin>: translate by xyz, then rotate by fixed-axis roll, pitch, yaw.
function transform(xyz, rpy) {
  const [r, p, y] = rpy;
  const cr = Math.cos(r);
  const sr = Math.sin(r);
  const cp = Math.cos(p);
  const sp = Math.sin(p);
  const cy = Math.cos(y);
  const sy = Math.sin(y);
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

const IDENTITY = transform([0, 0, 0], [0, 0, 0]);
const spin = (radians) => transform([0, 0, 0], [0, 0, radians]); // a joint turning about its z axis
// The URDF works in metres; the lesson shows millimetres.
const originOf = (matrix) => ({ x: matrix[3] * 1000, y: matrix[7] * 1000, z: matrix[11] * 1000 });

// Forward kinematics of SO-ARM101: from the five joint angles (degrees) to the joint centres and
// the tip reference point (mm), measured from base_link.
function so101FK(q) {
  if (q.length !== SO101_JOINTS.length || q.some((angle) => !Number.isFinite(angle)))
    throw new Error('5つの関節角度が必要です');
  const points = [{ x: 0, y: 0, z: 0 }];
  let matrix = IDENTITY;
  SO101_JOINTS.forEach((joint, index) => {
    matrix = multiply(multiply(matrix, transform(joint.xyz, joint.rpy)), spin(toRadians(q[index])));
    points.push(originOf(matrix));
  });
  matrix = multiply(matrix, transform(TIP_IN_WRIST.xyz, TIP_IN_WRIST.rpy));
  points.push(originOf(matrix));
  return { points, tip: originOf(matrix), matrix };
}

function parseJointStateMessage(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('JSONとして読み取れません。nameとpositionを持つ1件のデータを使ってください。');
  }
}

// One angle (radians) per joint of SO101_JOINTS, taken by name so the order of the message does
// not matter.
function positionOf(message, joint) {
  const found = message.name
    .map((name, index) => (name === joint.name ? index : -1))
    .filter((index) => index >= 0);
  if (found.length !== 1) throw new Error(joint.name + 'が1つ必要です。');
  const position = message.position[found[0]];
  if (typeof position !== 'number' || !Number.isFinite(position))
    throw new Error('positionにはラジアン単位の数値が必要です。');
  return position;
}

// A JointState the learner pasted or opened, as five angles in degrees. Anything that would be a
// silent misreading — a missing joint, another unit, another zero position — is rejected.
function armParseJointState(text) {
  const message = parseJointStateMessage(text);
  if (
    !Array.isArray(message.name) ||
    !Array.isArray(message.position) ||
    message.name.length !== message.position.length
  )
    throw new Error('nameとpositionを、同じ個数の配列にしてください。');
  const q = SO101_JOINTS.map((joint) => toDegrees(positionOf(message, joint)));
  const outsideUrdf = q.some(
    (angle, index) =>
      toRadians(angle) < SO101_JOINTS[index].limit[0] - JOINT_LIMIT_TOLERANCE ||
      toRadians(angle) > SO101_JOINTS[index].limit[1] + JOINT_LIMIT_TOLERANCE,
  );
  if (outsideUrdf)
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
