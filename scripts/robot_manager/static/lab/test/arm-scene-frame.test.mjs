// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// The side view of the arm fits its millimetre grid to the width of its box, so a 390 px phone
// shows the arm without horizontal scrolling (audit A1) and a wide screen keeps the figure short
// enough for a 768 px high Chromebook.
import test from 'node:test';
import assert from 'node:assert/strict';
import { armSceneFrame } from '../js/arm/render.js';
import { ARM_GOALS, ARM_OBSTACLE, armFK } from '../js/arm/core.js';

const PHONE_CANVAS = 352; // px: the canvas inside a card on a 390 px phone
const CHROMEBOOK_CANVAS = 884; // px: the canvas on a 1366 px wide screen

test('a phone shows the shoulder, the reachable targets and the post inside the canvas', () => {
  const frame = armSceneFrame(PHONE_CANVAS);
  assert.equal(frame.narrow, true);
  const inside = (point) => {
    const at = frame.toPixels(point);
    return at.x >= 0 && at.x <= frame.width && at.y >= 0 && at.y <= frame.height;
  };
  const points = [
    { x: 0, z: 0 },
    { x: 290, z: 0 },
    { x: 0, z: 290 },
    { x: -150, z: 0 },
    ARM_OBSTACLE,
    ...ARM_GOALS,
    armFK([20, 65]).tip,
    armFK([150, 0]).elbow,
  ];
  for (const point of points) assert.ok(inside(point), JSON.stringify(point));
  // Bars are long enough to read: 160 mm is more than 80 px.
  assert.ok(160 * frame.scale > 80);
  assert.ok(frame.height < 400, 'the phone figure fits above the controls');
});

test('a wide screen caps the height and shows more of x instead', () => {
  const frame = armSceneFrame(CHROMEBOOK_CANVAS);
  assert.equal(frame.narrow, false);
  assert.ok(frame.height <= 500, `height ${frame.height}`);
  assert.ok(frame.range.x[0] <= -300 && frame.range.x[1] >= 420);
});

test('a click maps back to the millimetre it was drawn at', () => {
  for (const width of [PHONE_CANVAS, 600, CHROMEBOOK_CANVAS]) {
    const frame = armSceneFrame(width);
    for (const point of [
      { x: 215, z: 105 },
      { x: -120, z: 40 },
      { x: 0, z: 0 },
    ]) {
      const at = frame.toPixels(point);
      assert.deepEqual(frame.toModel(at.x, at.y), point);
    }
  }
});
