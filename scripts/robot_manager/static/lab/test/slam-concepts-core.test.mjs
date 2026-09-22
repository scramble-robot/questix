// Pins the public functions of js/slam/concepts-core.js: every result must stay bit-identical to
// the module as it was before the clean-up, and the few properties learners are told about must
// hold. The baseline copy of the site is the reference; it is imported directly because the module
// is DOM-free.

import test from 'node:test';
import assert from 'node:assert/strict';

const BASELINE = '/home/asahi/.cache/questix-lab-cleanup/base/js/slam/concepts-core.js';

const current = await import('../js/slam/concepts-core.js');
const baseline = await import(BASELINE);

const POSES = [
  { x: 0, y: 0, theta: 0 },
  { x: 1.4, y: 0.6, theta: Math.PI / 3 },
  { x: 3.7, y: 1.2, theta: -1.1 },
];

// Both modules are called with the same arguments and must agree exactly.
function same(name, ...args) {
  const expected = baseline[name](...args);
  const actual = current[name](...args);
  assert.deepStrictEqual(actual, expected, `${name} drifted from the baseline`);
  return actual;
}

test('the demonstration room and the four measuring places are unchanged', () => {
  assert.deepStrictEqual(current.MAPPING_ROOM, baseline.MAPPING_ROOM);
  assert.deepStrictEqual(current.MAPPING_POSES, baseline.MAPPING_POSES);
  assert.deepStrictEqual(current.localizationRoom(), baseline.localizationRoom());
  assert.deepStrictEqual(current.localizationRoom(true), baseline.localizationRoom(true));
  // The corridor only grows a distinguishing feature when one is asked for.
  assert.equal(current.localizationRoom().obstacles.length, 0);
  assert.equal(current.localizationRoom(true).obstacles.length, 1);
});

test('a point converts between the robot and the map, and back', () => {
  for (const pose of POSES) {
    const point = { x: 2.2, y: -0.4 };
    const world = same('pointInWorld', point, pose);
    const back = same('pointInRobot', world, pose);
    assert.ok(Math.hypot(back.x - point.x, back.y - point.y) < 1e-12);
  }
  // A pose with no rotation only shifts the point.
  assert.deepStrictEqual(current.pointInWorld({ x: 1, y: 2 }, { x: 10, y: 20, theta: 0 }), {
    x: 11,
    y: 22,
  });
});

test('the room is turned into wall segments', () => {
  const segments = same('roomSegments', current.MAPPING_ROOM);
  // Four walls plus four edges for the single shelf.
  assert.equal(segments.length, 8);
  assert.deepStrictEqual(same('roomSegments', { width: 2, height: 1 }), [
    [0, 0, 2, 0],
    [2, 0, 2, 1],
    [2, 1, 0, 1],
    [0, 1, 0, 0],
  ]);
});

test('measured ranges match the baseline, and stop at the range limit', () => {
  for (const pose of POSES) same('measureRoom', current.MAPPING_ROOM, pose);
  same('measureRoom', current.localizationRoom(true), POSES[2], 72, 2);
  const short = current.measureRoom(current.MAPPING_ROOM, { x: 2.4, y: 1.6, theta: 0 }, 24, 0.2);
  assert.equal(short.length, 24);
  // Nothing is within 0.2 m of that spot, so every beam reports its limit and no hit.
  assert.ok(short.every((ray) => ray.range === 0.2 && ray.hit === false));
});

test('an occupancy map is built from scans, at either cell size', () => {
  const frames = current.MAPPING_POSES.map((pose, view) => ({
    view,
    pose,
    scan: current.measureRoom(current.MAPPING_ROOM, pose),
  }));
  const empty = same('occupancyFromScans', []);
  assert.equal(empty.known, 0);
  assert.ok(empty.cells.every((cell) => cell === 'unknown'));

  const fine = same('occupancyFromScans', frames, { resolution: 0.1 });
  const coarse = same('occupancyFromScans', frames, { resolution: 0.2 });
  assert.equal(fine.w * fine.h, fine.total);
  assert.ok(coarse.total < fine.total);
  // Measuring from one place alone cannot explain the whole room.
  const oneFrame = current.occupancyFromScans(frames.slice(0, 1));
  assert.ok(oneFrame.known < fine.known);
});

test('a candidate position is scored against the measured ranges', () => {
  const scene = current.localizationRoom(true);
  const observed = current.measureRoom(scene, { x: 3.7, y: 1.2, theta: 0 }, 72, 2);
  assert.equal(same('rangeMismatch', observed, observed), 0);

  const fit = same('localizeOnKnownMap', observed, scene);
  assert.equal(fit.candidates.length, 67);
  assert.ok(fit.plausible.length >= 1);
  assert.ok(fit.plausible.every((candidate) => candidate.error <= fit.best + 0.018));
  // The place the scan was really taken from is among the plausible ones.
  assert.ok(fit.plausible.some((candidate) => Math.abs(candidate.x - 3.7) < 0.11));
});

test('a featureless corridor leaves more plausible positions than one with a feature', () => {
  const measure = (scene) => current.measureRoom(scene, { x: 3.7, y: 1.2, theta: 0 }, 72, 2);
  const plain = current.localizationRoom(false);
  const featured = current.localizationRoom(true);
  const plainFit = current.localizeOnKnownMap(measure(plain), plain);
  const featuredFit = current.localizeOnKnownMap(measure(featured), featured);
  assert.ok(plainFit.plausible.length > featuredFit.plausible.length);
});

test('the pose graph keeps the first pose fixed and spreads the correction', () => {
  const edges = [
    { from: 0, to: 1, dx: 1, dy: 0, weight: 1 },
    { from: 1, to: 2, dx: 1, dy: 0, weight: 1 },
  ];
  const poses = same('poseGraphOptimize', 3, edges);
  assert.deepStrictEqual(poses[0], { x: 0, y: 0 });
  assert.equal(poses.length, 3);
  assert.ok(Math.abs(poses[2].x - 2) < 1e-9);
  // Without an edge reaching a pose there is nothing to solve it from.
  assert.throws(() => current.poseGraphOptimize(3, [edges[0]]));
});

test('closing the loop at the start beats closing it at the wrong corner', () => {
  const fixture = same('loopFixture');
  assert.equal(fixture.before.length, 11);
  assert.equal(fixture.scans.length, 11);

  const closed = same('closeLoop', fixture, 0);
  const wrong = same('closeLoop', fixture, 4);
  const drift = Math.hypot(fixture.before.at(-1).x, fixture.before.at(-1).y);
  // The adjustment pulls the two poses that were declared the same place together …
  assert.ok(closed.gap < drift);
  assert.ok(wrong.gap < drift);
  // … but a wrong correspondence pays for it by rewriting the measured motion.
  assert.ok(wrong.moveResidual > closed.moveResidual);
});
