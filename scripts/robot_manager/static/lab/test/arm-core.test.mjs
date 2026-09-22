// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// The expected numbers pin what the arm course computed before its rewrite, so a later change to
// the kinematics cannot quietly move what learners read on the screen. Set
// QUESTIX_LAB_BASELINE=<a copy of the site> to diff every case against that copy's module too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as arm from '../js/arm/core.js';

const {
  ARM_MODEL,
  ARM_OBSTACLE,
  armFK,
  armIK,
  armSegmentDistance,
  armClearance,
  armTrajectory,
  SO101_JOINTS,
  so101FK,
  armParseJointState,
} = arm;

const round = (value) => Math.round(value * 1e6) / 1e6;
const flat = (pose) => [
  round(pose.elbow.x),
  round(pose.elbow.z),
  round(pose.tip.x),
  round(pose.tip.z),
  pose.angle,
];
const jointNames = SO101_JOINTS.map((joint) => joint.name);
const jointState = (position) => JSON.stringify({ name: jointNames, position });
const EXAMPLE_POSITION = [0.2, -0.3, 0.4, -0.2, 0.1]; // radians, as the lesson's example data
const message = (run) => {
  try {
    run();
    return 'no error';
  } catch (error) {
    return error.message;
  }
};

test('armFK adds what each bar reaches sideways and upwards', () => {
  const poses = [
    [0, 0],
    [20, 65],
    [90, 0],
    [0, 90],
    [80, -20],
    [-30, 140],
  ];
  assert.deepEqual(
    poses.map((q) => flat(armFK(q))),
    [
      [160, 0, 290, 0, 0],
      [150.350819, 54.723223, 161.681066, 184.228534, 85],
      [0, 160, 0, 290, 90],
      [160, 0, 160, 130, 90],
      [27.783708, 157.56924, 92.783708, 270.152543, 60],
      [138.564065, -80, 94.101446, 42.160041, 110],
    ],
  );
});

test('armFK measures from the shoulder centre, not the floor', () => {
  const straight = armFK([0, 0]);
  assert.deepEqual(straight.base, { x: 0, z: 0 });
  assert.equal(round(straight.tip.x), ARM_MODEL.l1 + ARM_MODEL.l2);
  const rightAngle = armFK([0, 90]);
  assert.equal(round(rightAngle.tip.x), ARM_MODEL.l1);
  assert.equal(round(rightAngle.tip.z), ARM_MODEL.l2);
});

test('armIK finds the two poses that reach a target, and both tips land on it', () => {
  const solution = armIK({ x: 215, z: 105 });
  assert.equal(solution.reason, 'ok');
  assert.equal(solution.singular, false);
  assert.equal(round(solution.r), 239.269722);
  assert.deepEqual(
    solution.solutions.map((candidate) => candidate.q.map(round)),
    [
      [-4.502485, 69.233072],
      [56.561669, -69.233072],
    ],
  );
  for (const candidate of solution.solutions) {
    assert.equal(candidate.allowed, true);
    assert.deepEqual([round(candidate.tip.x), round(candidate.tip.z)], [215, 105]);
    assert.deepEqual(
      [round(armFK(candidate.q).tip.x), round(armFK(candidate.q).tip.z)],
      [215, 105],
      'the angles feed back through armFK to the same point',
    );
  }
});

test('armIK says why an unreachable target cannot be reached', () => {
  assert.deepEqual(armIK({ x: 330, z: 0 }), { reason: 'far', solutions: [], r: 330 });
  assert.deepEqual(armIK({ x: 10, z: 0 }), { reason: 'near', solutions: [], r: 10 });
  assert.deepEqual(armIK({ x: NaN, z: 0 }), { reason: 'invalid', solutions: [] });
});

test('armIK keeps the poses outside the teaching limits, marked as not allowed', () => {
  const free = armIK({ x: 180, z: -50 });
  const limited = armIK({ x: 180, z: -50 }, true);
  assert.deepEqual(
    free.solutions.map((candidate) => candidate.allowed),
    [true, true],
  );
  assert.equal(limited.reason, 'ok');
  assert.deepEqual(
    limited.solutions.map((candidate) => [round(candidate.q[0]), candidate.allowed]),
    [
      [-58.693895, false], // shoulder below its 0° limit
      [27.645673, true],
    ],
  );
  const blocked = armIK({ x: -180, z: -50 }, true);
  assert.equal(blocked.reason, 'limits');
  assert.ok(blocked.solutions.every((candidate) => !candidate.allowed));
});

test('armIK returns one singular pose where the arm is straight or folded', () => {
  const stretched = armIK({ x: ARM_MODEL.l1 + ARM_MODEL.l2, z: 0 });
  assert.equal(stretched.singular, true);
  assert.deepEqual(
    stretched.solutions.map((candidate) => candidate.q.map(round)),
    [[0, 0]],
  );
  const folded = armIK({ x: ARM_MODEL.l1 - ARM_MODEL.l2, z: 0 });
  assert.equal(folded.singular, true);
  assert.deepEqual(
    folded.solutions.map((candidate) => candidate.q.map(round)),
    [[0, -180]],
  );
});

test('armSegmentDistance measures to the bar, not to its ends', () => {
  assert.equal(armSegmentDistance({ x: 145, z: 55 }, { x: 0, z: 0 }, { x: 160, z: 0 }), 55);
  assert.equal(
    round(armSegmentDistance({ x: 0, z: 10 }, { x: 5, z: 5 }, { x: 5, z: 5 })),
    7.071068,
    'a bar of zero length is just its start point',
  );
});

test('armClearance turns negative once a bar overlaps the post', () => {
  const poses = [
    [80, -20],
    [20, 65],
    [0, 0],
    [30, 10],
  ];
  assert.deepEqual(
    poses.map((q) => round(armClearance(q))),
    [101.246474, -29.909827, 23, -7.131397],
  );
  const bare = armClearance([20, 65], { ...ARM_OBSTACLE, r: 0 });
  assert.equal(round(bare), round(-29.909827 + ARM_OBSTACLE.r), 'a thinner post leaves more room');
});

test('armTrajectory eases between two poses and ends on the second', () => {
  const run = armTrajectory([20, 65], [60, 65]);
  assert.equal(run.collision, false);
  assert.equal(run.minClearance, Infinity, 'without a post nothing is measured');
  assert.equal(run.samples.length, 97);
  assert.equal(round(run.duration), 1.6);
  assert.deepEqual(run.samples[0].q, [20, 65]);
  assert.deepEqual(run.samples.at(-1).q.map(round), [60, 65]);
  assert.equal(round(run.samples.at(-1).t), 1.6);
  assert.equal(round(run.samples[3].q[0]), 20.114746, 'the motion starts slowly');
  const still = armTrajectory([20, 65], [20, 65]);
  assert.equal(round(still.duration), 1.6, 'even a pose that does not move is shown for a moment');
});

test('armTrajectory stops at the sample that touches the post', () => {
  const run = armTrajectory([80, -20], [20, 65], ARM_OBSTACLE);
  assert.equal(run.collision, true);
  assert.equal(run.samples.length, 82);
  assert.ok(run.samples.at(-1).clearance <= 0);
  assert.ok(run.samples.at(-2).clearance > 0);
  assert.equal(round(run.minClearance), -1.346981);
  assert.equal(round(run.duration), 1.342105, 'the motion ends early, before the planned 1.6 s');
});

test('so101FK walks the URDF chain from base_link to the tip', () => {
  const zero = so101FK([0, 0, 0, 0, 0]);
  assert.equal(zero.points.length, SO101_JOINTS.length + 2, 'base, five joints and the tip');
  assert.deepEqual(zero.points[0], { x: 0, y: 0, z: 0 });
  assert.deepEqual(
    [round(zero.tip.x), round(zero.tip.y), round(zero.tip.z)],
    [391.3619, -0.011255, 226.468745],
  );
  assert.deepEqual(
    zero.points.map((point) => [round(point.x), round(point.y), round(point.z)]),
    [
      [0, 0, 0],
      [38.8353, -0.000009, 62.4],
      [69.2345, -18.277809, 116.6],
      [97.2345, -18.277809, 229.17],
      [232.1345, -18.277809, 234.37],
      [293.2345, -0.177809, 234.37],
      [391.3619, -0.011255, 226.468745],
    ],
  );
});

test('so101FK swings the whole arm when only the base turns', () => {
  const turned = so101FK([20, 0, 0, 0, 0]);
  assert.deepEqual(
    [round(turned.tip.x), round(turned.tip.y), round(turned.tip.z)],
    [370.098098, -120.581775, 226.468745],
  );
  assert.equal(round(turned.tip.z), round(so101FK([0, 0, 0, 0, 0]).tip.z), 'the height is kept');
  assert.throws(() => so101FK([0, 0, 0]), /5つの関節角度が必要です/);
  assert.throws(() => so101FK([0, 0, 0, 0, NaN]), /5つの関節角度が必要です/);
});

test('armParseJointState reads the angles by joint name, in radians', () => {
  const shuffled = JSON.stringify({
    source: 'simulated',
    name: [...jointNames].reverse(),
    position: [...EXAMPLE_POSITION].reverse(),
  });
  const expected = [11.459156, -17.188734, 22.918312, -11.459156, 5.729578];
  assert.deepEqual(armParseJointState(jointState(EXAMPLE_POSITION)).map(round), expected);
  assert.deepEqual(
    armParseJointState(shuffled).map(round),
    expected,
    'the order in the message does not matter',
  );
});

test('armParseJointState rejects anything it could only misread', () => {
  assert.deepEqual(
    [
      message(() => armParseJointState('')),
      message(() => armParseJointState('{"name":[1],"position":[]}')),
      message(() =>
        armParseJointState(JSON.stringify({ name: ['shoulder_pan'], position: [0.1] })),
      ),
      message(() => armParseJointState(jointState([0.2, -0.3, 0.4, -0.2, 'x']))),
      message(() => armParseJointState(jointState([9, 0, 0, 0, 0]))),
    ],
    [
      'JSONとして読み取れません。nameとpositionを持つ1件のデータを使ってください。',
      'nameとpositionを、同じ個数の配列にしてください。',
      'shoulder_liftが1つ必要です。',
      'positionにはラジアン単位の数値が必要です。',
      '教材で参照するURDFの関節範囲を超えています。角度の単位・原点と実機のURDFを確認してください。',
    ],
  );
});

test('the module exports everything the other courses import', () => {
  assert.deepEqual(Object.keys(arm).sort(), [
    'ARM_GOALS',
    'ARM_MODEL',
    'ARM_OBSTACLE',
    'ARM_TOPICS',
    'SO101_JOINTS',
    'armClearance',
    'armFK',
    'armIK',
    'armParseJointState',
    'armSegmentDistance',
    'armTrajectory',
    'so101FK',
  ]);
});

// Optional: the same cases through another copy of the site, for instance the edition before a
// refactor. Skipped unless QUESTIX_LAB_BASELINE points at one.
test('every case gives the same answer as the baseline copy', async (t) => {
  const root = process.env.QUESTIX_LAB_BASELINE;
  if (!root) return t.skip('set QUESTIX_LAB_BASELINE to compare with another copy');
  const baseline = await import(pathToFileURL(`${root}/js/arm/core.js`).href);
  const answers = (module) => [
    module.ARM_TOPICS,
    module.ARM_MODEL,
    module.ARM_GOALS,
    module.ARM_OBSTACLE,
    module.SO101_JOINTS,
    [
      [0, 0],
      [20, 65],
      [80, -20],
      [-30, 140],
    ].map((q) => flat(module.armFK(q))),
    [
      [{ x: 215, z: 105 }, false],
      [{ x: 330, z: 0 }, false],
      [{ x: 10, z: 0 }, false],
      [{ x: 180, z: -50 }, true],
      [{ x: 290, z: 0 }, false],
      [{ x: NaN, z: 0 }, false],
    ].map(([target, limited]) => JSON.stringify(module.armIK(target, limited))),
    [
      [80, -20],
      [20, 65],
      [30, 10],
    ].map((q) => round(module.armClearance(q))),
    JSON.stringify(module.armTrajectory([80, -20], [20, 65], module.ARM_OBSTACLE)),
    JSON.stringify(module.armTrajectory([20, 65], [60, 65])),
    JSON.stringify(
      module.so101FK([
        11.459155902616464, -17.188733853924695, 22.918311805232932, -11.459155902616464,
        5.729577951308232,
      ]),
    ),
    module.armParseJointState(jointState(EXAMPLE_POSITION)),
    message(() => module.armParseJointState(jointState([9, 0, 0, 0, 0]))),
  ];
  assert.deepEqual(answers(arm), answers(baseline));
});
