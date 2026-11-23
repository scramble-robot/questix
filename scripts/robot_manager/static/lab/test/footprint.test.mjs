import assert from 'node:assert/strict';
import test from 'node:test';
import {
  footprintIntersectsDuringRotation,
  footprintIntersectsDuringTranslation,
  footprintIntersectsRect,
} from '../js/core/footprint.js';
import { ROBOT_DIMENSIONS } from '../js/core/robot-dimensions.js';

const origin = { x: 0, y: 0, theta: 0 };
const rect = (minX, minY, maxX, maxY) => ({ minX, minY, maxX, maxY });

test('at 0 degrees edge and corner contact count, and a positive gap clears', () => {
  assert.ok(footprintIntersectsRect(origin, rect(0.245, -0.1, 0.3, 0.1)));
  assert.ok(footprintIntersectsRect(origin, rect(0.245, 0.32, 0.3, 0.4)));
  assert.equal(footprintIntersectsRect(origin, rect(0.245001, -0.1, 0.3, 0.1)), false);
});

test('at 90 degrees the axle offset rotates with the footprint', () => {
  const pose = { x: 2, y: 3, theta: Math.PI / 2 };
  assert.ok(footprintIntersectsRect(pose, rect(1.9, 2.58, 2.1, 2.5881)));
  assert.equal(footprintIntersectsRect(pose, rect(1.9, 3.245001, 2.1, 3.3)), false);
});

test('at 45 degrees SAT rejects a rectangle inside the bounding box but outside the body', () => {
  const pose = { ...origin, theta: Math.PI / 4 };
  const tipX = (0.245 + 0.32) / Math.SQRT2;
  const tipY = (0.245 - 0.32) / Math.SQRT2;
  assert.ok(footprintIntersectsRect(pose, rect(tipX, tipY, tipX + 0.01, tipY + 0.01)));
  assert.equal(footprintIntersectsRect(pose, rect(0.36, 0.36, 0.38, 0.38)), false);
});

test('rotation catches an obstacle missed at both endpoints in either direction', () => {
  const wall = rect(-0.5, -0.02, -0.49, 0.02);
  const endTheta = Math.PI / 2;
  const end = { ...origin, theta: endTheta };
  assert.equal(footprintIntersectsRect(origin, wall), false);
  assert.equal(footprintIntersectsRect(end, wall), false);
  assert.ok(footprintIntersectsDuringRotation(origin, endTheta, wall));
  assert.ok(footprintIntersectsDuringRotation(end, 0, wall));
  assert.equal(footprintIntersectsDuringRotation(origin, 0.1, wall), false);
  assert.ok(footprintIntersectsDuringRotation({ ...origin, theta: 2 * Math.PI }, 10, wall));
});

test('a swept robot corner touches a tangent wall and clears a one-micrometre gap', () => {
  const { rear, left } = ROBOT_DIMENSIONS.footprint;
  const radius = Math.hypot(rear, left);
  assert.ok(footprintIntersectsDuringRotation(origin, Math.PI / 2, rect(-1, -0.05, -radius, 0.05)));
  assert.equal(
    footprintIntersectsDuringRotation(origin, 4 * Math.PI, rect(-1, -0.05, -radius - 1e-6, 0.05)),
    false,
  );
});

test('rotation also catches an obstacle corner crossing the middle of a robot edge', () => {
  const wall = rect(0.245, 0.23, 0.246, 0.231);
  const narrow = { footprint: { front: 0.4, rear: 0.12, left: 0.03, right: 0.04 } };
  assert.equal(footprintIntersectsRect(origin, wall, narrow), false);
  assert.equal(footprintIntersectsRect({ ...origin, theta: Math.PI / 2 }, wall, narrow), false);
  assert.ok(footprintIntersectsDuringRotation(origin, Math.PI / 2, wall, narrow));
});

test('translation catches thin walls and distinguishes an edge touch from a parallel gap', () => {
  const start = { ...origin, x: -4 };
  const end = { ...origin, x: 4 };
  const wall = rect(0, 0.32, 0.000001, 0.5);
  assert.equal(footprintIntersectsRect(start, wall), false);
  assert.equal(footprintIntersectsRect(end, wall), false);
  assert.ok(footprintIntersectsDuringTranslation(start, end, wall));
  assert.ok(footprintIntersectsDuringTranslation(end, start, wall));
  assert.equal(
    footprintIntersectsDuringTranslation(start, end, { ...wall, minY: 0.320001 }),
    false,
  );
  assert.equal(footprintIntersectsDuringTranslation(start, start, wall), false);
  assert.ok(footprintIntersectsDuringTranslation(origin, origin, wall));
});

test('diagonal translation uses the fixed heading and rejects disjoint overlap times', () => {
  const start = { ...origin, theta: Math.PI / 4 };
  const end = { x: 3, y: 3 };
  assert.ok(footprintIntersectsDuringTranslation(start, end, rect(1.49, 1.49, 1.5, 1.5)));
  assert.equal(footprintIntersectsDuringTranslation(start, end, rect(2, 0.5, 2.1, 0.6)), false);
});
