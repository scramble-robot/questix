// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// The refactored js/core/depth-core.js must stay numerically identical to the pre-refactor
// module (its pixels are hashed by the UI regression harness). Each scenario is run through
// both modules and compared with deep equality; NaN in Float32Array depth maps compares equal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as candidate from '../js/core/depth-core.js';

// The pre-refactor modules are kept in test/baseline/ (see its README), so this runs in CI too.
const BASELINE_PATH = fileURLToPath(new URL('./baseline/js/core/depth-core.js', import.meta.url));
const baseline = fs.existsSync(BASELINE_PATH) ? await import(BASELINE_PATH) : null;
const CONDITIONS = ['normal', 'holes', 'plain', 'glass'];

function compareWithBaseline(name, scenario) {
  test(name, { skip: baseline ? false : 'baseline module not available' }, () => {
    assert.deepEqual(scenario(candidate), scenario(baseline));
  });
}

function outcome(fn) {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: error.message, type: error.constructor.name };
  }
}

function smallFrame(depthModule, options) {
  const scene = depthModule.rgbdScene(options);
  // 8x6 crop from the scene centre keeps frames small enough for many comparisons.
  const width = 8;
  const height = 6;
  const left = 156;
  const top = 92;
  const rgb = new Uint8ClampedArray(width * height * 4);
  const depth = new Float32Array(width * height);
  const labels = new Uint8Array(width * height);
  for (let v = 0; v < height; v++)
    for (let u = 0; u < width; u++) {
      const from = (top + v) * scene.width + left + u;
      const to = v * width + u;
      rgb.set(scene.rgb.subarray(from * 4, from * 4 + 4), to * 4);
      depth[to] = scene.depth[from];
      labels[to] = scene.labels[from];
    }
  const intrinsics = {
    ...scene.intrinsics,
    cx: scene.intrinsics.cx - left,
    cy: scene.intrinsics.cy - top,
  };
  return { ...scene, width, height, rgb, depth, labels, intrinsics };
}

function goodLog(depthModule) {
  const log = depthModule.rgbdLog(smallFrame(depthModule, { targetZ: 1.0 }));
  return structuredClone(log);
}

test('exports the same names as the baseline', { skip: !baseline }, () => {
  assert.deepEqual(Object.keys(candidate).sort(), Object.keys(baseline).sort());
  assert.deepEqual(candidate.DEPTH_CAMERA, baseline.DEPTH_CAMERA);
});

compareWithBaseline('stereoProjection and depthFromDisparity', (e) => [
  e.stereoProjection(1.2),
  e.stereoProjection(0.5, { focal: 300, baseline: 0.1, lateral: 0.2, center: 100 }),
  e.stereoProjection(3, { lateral: -0.4 }),
  outcome(() => e.stereoProjection(0)),
  outcome(() => e.stereoProjection(-1)),
  outcome(() => e.stereoProjection(1, { focal: 0 })),
  outcome(() => e.stereoProjection(1, { baseline: -0.1 })),
  outcome(() => e.stereoProjection(NaN)),
  [e.depthFromDisparity(18), e.depthFromDisparity(18, 300, 0.1)],
  [
    e.depthFromDisparity(0),
    e.depthFromDisparity(-3),
    e.depthFromDisparity(Infinity),
    e.depthFromDisparity(NaN),
  ],
]);

compareWithBaseline('depthColor over the range and for invalid values', (e) => {
  const zs = [-1, 0, NaN, Infinity, 0.1, 0.25, 0.5, 1, 1.7, 2.5, 4, 5, 7];
  return [zs.map((z) => e.depthColor(z)), zs.map((z) => e.depthColor(z, 0.5, 2))];
});

compareWithBaseline('depthImage and depthPoint on a small frame', (e) => {
  const frame = smallFrame(e, { targetZ: 1.0, condition: 'holes' });
  const points = [];
  for (let v = 0; v < frame.height; v++)
    for (let u = 0; u < frame.width; u++) points.push(e.depthPoint(frame, u, v));
  const image = e.depthImage(frame);
  return [frame, image, points, e.depthPoint({ ...frame, depth: [NaN, 0, -1, 2] }, 1, 0)];
});

for (const condition of CONDITIONS)
  compareWithBaseline(`rgbdScene(${condition}) full frame`, (e) => {
    const scene = e.rgbdScene({ condition, targetZ: 1.2, cameraX: 0 });
    return [scene, e.rgbdScene({ condition, targetZ: 0.8, cameraX: 0.15 })];
  });

compareWithBaseline('rgbdScene default arguments', (e) => e.rgbdScene());

compareWithBaseline('selectDepthPixels with and without the depth gate', (e) => {
  const out = [];
  for (const condition of CONDITIONS) {
    const frame = e.rgbdScene({ condition, targetZ: 1.4 });
    out.push(e.selectDepthPixels(frame));
    out.push(e.selectDepthPixels(frame, { useDepth: true }));
    out.push(e.selectDepthPixels(frame, { useDepth: true, maxDepth: 1.0 }));
  }
  const unlabelled = e.rgbdScene({ targetZ: 1.0 });
  delete unlabelled.labels;
  out.push(e.selectDepthPixels(unlabelled, { useDepth: true }));
  return out;
});

compareWithBaseline('depthInBox on various boxes', (e) => {
  const frame = e.rgbdScene({ condition: 'holes', targetZ: 1.2 });
  const boxes = [
    { x: 60, y: 60, right: 150, bottom: 200 },
    { x: -10, y: -5, right: 40.5, bottom: 30.2 },
    { x: 300, y: 200, right: 400, bottom: 300 },
    { x: 100.7, y: 90.2, right: 101.1, bottom: 90.9 },
    { x: 0, y: 0, right: 320, bottom: 220 },
    { x: 200, y: 0, right: 320, bottom: 50 },
  ];
  return boxes.map((box) => e.depthInBox(frame, box));
});

compareWithBaseline('rgbdLog round trip through validateRGBD', (e) => {
  const log = goodLog(e);
  const parsed = e.validateRGBD(log);
  return [
    log,
    parsed,
    outcome(() => e.validateRGBD(e.rgbdLog(e.rgbdScene({ condition: 'holes' })))),
  ];
});

compareWithBaseline('validateRGBD rejects bad input with the same messages', (e) => {
  const base = goodLog(e);
  const variants = [
    undefined,
    null,
    {},
    { ...base, format: 'other' },
    { ...base, aligned: false },
    { ...base, depth_unit: 'mm' },
    { ...base, width: 1 },
    { ...base, height: 481 },
    { ...base, width: 8.5 },
    { ...base, rgb: base.rgb.slice(1) },
    { ...base, rgb: [...base.rgb.slice(0, -1), 256] },
    { ...base, rgb: [...base.rgb.slice(0, -1), 1.5] },
    { ...base, rgb: 'nope' },
    { ...base, depth: base.depth.slice(1) },
    { ...base, depth: [...base.depth.slice(0, -1), 0] },
    { ...base, depth: [...base.depth.slice(0, -1), 101] },
    { ...base, depth: [...base.depth.slice(0, -1), 'x'] },
    { ...base, depth: [...base.depth.slice(0, -1), null] },
    { ...base, intrinsics: null },
    { ...base, intrinsics: { fx: 0, fy: 1, cx: 1, cy: 1 } },
    { ...base, intrinsics: { fx: 1, fy: -1, cx: 1, cy: 1 } },
    { ...base, intrinsics: { fx: 1, fy: 1, cx: 8, cy: 1 } },
    { ...base, intrinsics: { fx: 1, fy: 1, cx: 1, cy: -1 } },
    { ...base, intrinsics: { fx: 1, fy: 1, cx: 1, cy: 6 } },
    { ...base, intrinsics: { fx: 'a', fy: 1, cx: 1, cy: 1 } },
    { ...base, intrinsics: { fx: 240, fy: 240, cx: 3.5, cy: 2.5, extra: 1 } },
    { ...base, rgb_time: 0, depth_time: 0.051 },
    { ...base, rgb_time: 0.05, depth_time: 0 },
    { ...base, rgb_time: NaN },
    { ...base, depth_time: '0' },
  ];
  return variants.map((input) => outcome(() => e.validateRGBD(input)));
});
