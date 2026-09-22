// Pins the DOM-free image maths of the vision course: js/vision/core.js and js/vision/images.js.
//
// Two layers. The first states what the functions must produce (hashes of the teaching images and
// of every pixel operation, the ArUco codewords, decoding with and without damage, tag placement),
// so the file is still a test on its own. The second replays the same calls against the copy of
// the site kept in the refactor baseline and compares byte for byte; it is skipped when that copy
// is not on this machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as core from '../js/vision/core.js';
import * as images from '../js/vision/images.js';

const BASELINE = '/home/asahi/.cache/questix-lab-cleanup/base';

// FNV-1a over the bytes of an image, so a whole picture fits in one assertion.
function hashImage(image) {
  let hash = 2166136261;
  for (const byte of image.data) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `${image.width}x${image.height}:${(hash >>> 0).toString(16)}`;
}

const round = (value, digits = 6) => Number(value.toFixed(digits));

const SAMPLE_IMAGE = images.makeVisionImage();
const BALL_IMAGE = images.makeVisionImage({ kind: 1, color: 'blue', variant: 3 });
const DARK_CLUTTER_IMAGE = images.makeVisionImage({ light: 0.55, variant: 2, clutter: true });

// A marker pasted into a plain scene, axis aligned, so the reader can be tested without a canvas.
function markerScene(id, { cover = false } = {}) {
  const width = 320;
  const height = 220;
  const data = new Uint8ClampedArray(width * height * 4);
  const fill = (x, y, level) => {
    const pixel = (y * width + x) * 4;
    data[pixel] = level;
    data[pixel + 1] = level;
    data[pixel + 2] = level;
    data[pixel + 3] = 255;
  };
  const left = 70;
  const top = 20;
  const cell = 30; // px per cell of the 6×6 grid, border included
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) fill(x, y, 232);
  for (let y = top; y < top + cell * 6; y++)
    for (let x = left; x < left + cell * 6; x++) fill(x, y, 16);
  const bits = core.markerBits(id);
  for (let row = 0; row < 4; row++)
    for (let column = 0; column < 4; column++) {
      if (!bits[row * 4 + column]) continue;
      const originX = left + (column + 1) * cell;
      const originY = top + (row + 1) * cell;
      for (let y = originY; y < originY + cell; y++)
        for (let x = originX; x < originX + cell; x++) fill(x, y, 250);
    }
  if (cover) for (let y = 60; y < 140; y++) for (let x = 110; x < 170; x++) fill(x, y, 120);
  return { width, height, data };
}

function labelledSamples() {
  return [
    { id: 1, label: 0, image: images.makeVisionImage({ kind: 0, color: 'red', variant: 0 }) },
    { id: 2, label: 0, image: images.makeVisionImage({ kind: 0, color: 'red', variant: 1 }) },
    { id: 3, label: 1, image: images.makeVisionImage({ kind: 1, color: 'blue', variant: 0 }) },
    { id: 4, label: 1, image: images.makeVisionImage({ kind: 1, color: 'blue', variant: 1 }) },
  ];
}

const FACE_BOXES = [
  { x: 10, y: 40, right: 60, bottom: 90, score: 31.5 },
  { x: 12, y: 44, right: 58, bottom: 88, score: 12.25 },
  { x: 280, y: 0, right: 316, bottom: 36, score: 4 },
];

// ---- the teaching images -------------------------------------------------------------------------

test('teaching images are the same picture every time', () => {
  assert.equal(hashImage(SAMPLE_IMAGE), '320x220:50da8d36');
  assert.equal(hashImage(BALL_IMAGE), '320x220:ce75c31c');
  assert.equal(hashImage(DARK_CLUTTER_IMAGE), '320x220:2cf5e3db');
  assert.deepEqual(hashImage(images.makeVisionImage()), hashImage(images.makeVisionImage()));
});

test('the test set holds ten images the learner never labelled', () => {
  const set = images.visionTestSet();
  assert.equal(set.length, 10);
  assert.deepEqual(
    set.map((entry) => entry.id),
    Array.from({ length: 10 }, (_, i) => 'test-' + i),
  );
  assert.deepEqual(
    set.map((entry) => entry.label),
    [0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
  );
  assert.deepEqual(
    set.map((entry) => entry.condition),
    [
      'いつもの色',
      'いつもの色',
      'いつもの色',
      'いつもの色',
      '色を入れ替え',
      '色を入れ替え',
      '色を入れ替え',
      '色を入れ替え',
      '暗い場所',
      '暗い場所',
    ],
  );
  assert.equal(hashImage(set[0].image), '320x220:50cf88ca');
  assert.equal(hashImage(set[9].image), '320x220:3c56b16a');
});

// ---- pixel operations ------------------------------------------------------------------------------

test('every pixel operation returns the picture it did before', () => {
  assert.equal(hashImage(core.imageOperation(SAMPLE_IMAGE, 'red', 60)), '320x220:f4cd0d44');
  assert.equal(hashImage(core.imageOperation(SAMPLE_IMAGE, 'gray', 60)), '320x220:9fae234d');
  assert.equal(hashImage(core.imageOperation(SAMPLE_IMAGE, 'binary', 90)), '320x220:2393d5c5');
  assert.equal(hashImage(core.imageOperation(SAMPLE_IMAGE, 'edge', 40)), '320x220:7cefa3bd');
  assert.equal(hashImage(core.imageOperation(SAMPLE_IMAGE, 'none')), '320x220:50da8d36');
});

test('the red rule keeps fewer pixels as the threshold rises', () => {
  const low = core.imageOperation(SAMPLE_IMAGE, 'red', 20).selected;
  const high = core.imageOperation(SAMPLE_IMAGE, 'red', 160).selected;
  assert.equal(low, 9025);
  assert.equal(high, 0);
  assert.ok(low > high);
  // Only the red rule counts pixels.
  assert.equal(core.imageOperation(SAMPLE_IMAGE, 'gray', 20).selected, 0);
});

test('grayPixels mixes the channels the way the course describes', () => {
  const gray = core.grayPixels(SAMPLE_IMAGE);
  assert.equal(gray.length, SAMPLE_IMAGE.width * SAMPLE_IMAGE.height);
  assert.equal(gray[0], 205);
  assert.equal(gray[gray.length - 1], 181);
});

// ---- features and the classifier ---------------------------------------------------------------------

test('imageFeatures measures the coloured object, and refuses when there is none', () => {
  const features = core.imageFeatures(SAMPLE_IMAGE);
  assert.equal(features.valid, true);
  assert.deepEqual(features.bbox, { x: 94, y: 79, w: 95, h: 95 });
  assert.equal(features.count, 9025);
  assert.deepEqual(
    features.values.map((value) => round(value)),
    [0.620977, 0.22463, 0.154392, 1, 1],
  );

  const blank = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) };
  const none = core.imageFeatures(blank);
  assert.deepEqual(none, { valid: false, values: [0, 0, 0, 0, 0], bbox: null });
});

test('the classifier answers with the label of the closest labelled example', () => {
  const samples = labelledSamples();
  const model = core.trainImageClassifier(samples, 'color');
  assert.equal(model.mode, 'color');
  assert.equal(model.examples.length, 4);

  const box = core.classifyImage(model, images.makeVisionImage({ kind: 0, color: 'red' }));
  assert.equal(box.label, 0);
  assert.equal(box.neighbors.length, 3);
  assert.equal(box.neighbors[0].id, 1);

  const ball = core.classifyImage(model, images.makeVisionImage({ kind: 1, color: 'blue' }));
  assert.equal(ball.label, 1);
  assert.equal(ball.neighbors[0].id, 3);
});

test('a colour-blind classifier has to go by shape', () => {
  const samples = labelledSamples();
  const byShape = core.trainImageClassifier(samples, 'shape');
  // Same object, wrong colour for its label: colour alone gets it wrong, shape does not.
  const blueBox = images.makeVisionImage({ kind: 0, color: 'blue', variant: 2 });
  assert.equal(core.classifyImage(byShape, blueBox).label, 0);
  assert.equal(core.classifyImage(core.trainImageClassifier(samples, 'color'), blueBox).label, 1);
});

test('training needs both labels, and images it can measure', () => {
  const samples = labelledSamples();
  assert.throws(() => core.trainImageClassifier(samples.slice(0, 2)), /荷箱とボールの両方/);
  const blank = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) };
  assert.throws(
    () =>
      core.trainImageClassifier([
        { id: 1, label: 0, image: blank },
        { id: 2, label: 1, image: blank },
      ]),
    /色のある物体を大きく写した画像/,
  );
});

test('an image without a coloured object gets no label at all', () => {
  const model = core.trainImageClassifier(labelledSamples());
  const blank = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) };
  const answer = core.classifyImage(model, blank);
  assert.equal(answer.label, null);
  assert.deepEqual(answer.neighbors, []);
  assert.match(answer.reason, /色のある物体/);
});

// ---- ArUco markers ------------------------------------------------------------------------------------

test('the four codewords are the ones OpenCV uses', () => {
  assert.deepEqual(core.ARUCO_CODES, [0xb532, 0x0f9a, 0x332d, 0x9946]);
  assert.deepEqual(core.markerBits(0), [1, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  assert.deepEqual(core.markerBits(3), [1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 1, 0]);
});

test('four quarter turns bring a pattern back to where it started', () => {
  for (let id = 0; id < 4; id++) {
    let bits = core.markerBits(id);
    for (let turn = 0; turn < 4; turn++) bits = core.rotateBits(bits);
    assert.deepEqual(bits, core.markerBits(id));
  }
  assert.deepEqual(
    core.rotateBits(core.markerBits(0)),
    [0, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 1],
  );
});

test('a turned marker still decodes to the same ID', () => {
  for (let id = 0; id < 4; id++) {
    let bits = core.markerBits(id);
    for (let turn = 0; turn < 4; turn++) {
      const decoded = core.decodeMarker(bits);
      assert.equal(decoded.id, id);
      assert.equal(decoded.errors, 0);
      bits = core.rotateBits(bits);
    }
  }
});

test('one damaged cell is tolerated, two are not', () => {
  const oneWrong = core.markerBits(2).map((bit, i) => (i === 5 ? 1 - bit : bit));
  assert.equal(core.decodeMarker(oneWrong).id, 2);
  assert.equal(core.decodeMarker(oneWrong).errors, 1);
  const twoWrong = oneWrong.map((bit, i) => (i === 9 ? 1 - bit : bit));
  assert.equal(core.decodeMarker(twoWrong).id, null);
});

test('quadTransform maps the unit square onto the four corners', () => {
  const quad = [
    { x: 20, y: 10 },
    { x: 120, y: 30 },
    { x: 110, y: 90 },
    { x: 10, y: 70 },
  ];
  const toImage = core.quadTransform(quad);
  const corners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  corners.forEach(([u, v], index) => {
    const point = toImage(u, v);
    assert.ok(Math.abs(point.x - quad[index].x) < 1e-6);
    assert.ok(Math.abs(point.y - quad[index].y) < 1e-6);
  });
  const flat = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  assert.equal(core.quadTransform(flat), null);
});

test('detectMarkers reads the ID out of a picture of a marker', () => {
  for (let id = 0; id < 4; id++) {
    const found = core.detectMarkers(markerScene(id), 110);
    assert.ok(found.length >= 1, `no marker found for ID ${id}`);
    assert.equal(found[0].id, id);
    assert.equal(found[0].errors, 0);
    assert.deepEqual(found[0].bits, core.markerBits(id));
    assert.equal(found[0].quad.length, 4);
  }
});

test('a covered marker is reported as unreadable rather than guessed', () => {
  const found = core.detectMarkers(markerScene(1, { cover: true }), 110);
  assert.equal(found[0]?.id ?? null, null);
});

test('a picture with no dark square yields no markers', () => {
  assert.deepEqual(core.detectMarkers(SAMPLE_IMAGE, 110), []);
});

// ---- numbered tags ----------------------------------------------------------------------------------------

test('tags are numbered in order, stay inside the image and never overlap', () => {
  const tags = core.detectionTags(FACE_BOXES, 320, 220);
  assert.deepEqual(
    tags.map((tag) => tag.number),
    [1, 2, 3],
  );
  assert.deepEqual(
    tags.map((tag) => [Math.round(tag.x), Math.round(tag.y)]),
    [
      [10, 23], // just above its box
      [0, 0], // its own box is taken, so the nearest free slot of the grid
      [280, 0],
    ],
  );
  for (const tag of tags) {
    assert.ok(tag.x >= 0 && tag.x + tag.w <= 320);
    assert.ok(tag.y >= 0 && tag.y + tag.h <= 220);
  }
  const gap = 2 * tags[0].scale;
  for (let i = 0; i < tags.length; i++)
    for (let j = i + 1; j < tags.length; j++) {
      const a = tags[i];
      const b = tags[j];
      const apart =
        a.x + a.w + gap <= b.x ||
        b.x + b.w + gap <= a.x ||
        a.y + a.h + gap <= b.y ||
        b.y + b.h + gap <= a.y;
      assert.ok(apart, `tags ${a.number} and ${b.number} overlap`);
    }
  assert.deepEqual(core.detectionTags([], 320, 220), []);
});

test('a box with nowhere left to put a tag gets none', () => {
  const crowded = Array.from({ length: 40 }, (_, i) => ({
    x: 0,
    y: 0,
    right: 8,
    bottom: 8,
    score: 40 - i,
  }));
  const tags = core.detectionTags(crowded, 40, 30);
  assert.ok(tags.some((tag) => tag === null));
});

// ---- byte-for-byte against the copy of the site before the refactor --------------------------------------

const hasBaseline = fs.existsSync(path.join(BASELINE, 'js/vision/core.js'));
const baselineUrl = (file) => pathToFileURL(path.join(BASELINE, file)).href;

test('same results as the site before the refactor', { skip: !hasBaseline }, async () => {
  const oldCore = await import(baselineUrl('js/vision/core.js'));
  const oldImages = await import(baselineUrl('js/vision/images.js'));

  const variants = [
    {},
    { kind: 1, color: 'blue', variant: 3 },
    { kind: 0, color: 'green', variant: 5, light: 0.7 },
    { light: 0.55, variant: 2, clutter: true },
    { kind: 1, color: 'purple', variant: 11 },
  ];
  for (const options of variants)
    assert.deepEqual(
      images.makeVisionImage(options),
      oldImages.makeVisionImage(options),
      `makeVisionImage(${JSON.stringify(options)})`,
    );
  assert.deepEqual(images.visionTestSet(), oldImages.visionTestSet());

  for (const image of [SAMPLE_IMAGE, BALL_IMAGE, DARK_CLUTTER_IMAGE]) {
    assert.deepEqual(core.grayPixels(image), oldCore.grayPixels(image));
    for (const mode of ['red', 'gray', 'binary', 'edge', 'none'])
      for (const threshold of [0, 40, 60, 110, 200])
        assert.deepEqual(
          core.imageOperation(image, mode, threshold),
          oldCore.imageOperation(image, mode, threshold),
          `imageOperation(${mode}, ${threshold})`,
        );
    assert.deepEqual(core.imageFeatures(image), oldCore.imageFeatures(image));
  }

  const samples = labelledSamples();
  for (const mode of ['color', 'both', 'shape', 'unknown']) {
    const model = core.trainImageClassifier(samples, mode);
    const old = oldCore.trainImageClassifier(samples, mode);
    assert.deepEqual(model, old);
    for (const image of [SAMPLE_IMAGE, BALL_IMAGE, DARK_CLUTTER_IMAGE])
      assert.deepEqual(core.classifyImage(model, image), oldCore.classifyImage(old, image));
  }

  assert.deepEqual(core.ARUCO_CODES, oldCore.ARUCO_CODES);
  for (let id = 0; id < 4; id++) {
    assert.deepEqual(core.markerBits(id), oldCore.markerBits(id));
    assert.deepEqual(
      core.rotateBits(core.markerBits(id)),
      oldCore.rotateBits(oldCore.markerBits(id)),
    );
    assert.deepEqual(
      core.decodeMarker(core.markerBits(id)),
      oldCore.decodeMarker(oldCore.markerBits(id)),
    );
    for (const threshold of [60, 110, 180])
      assert.deepEqual(
        core.detectMarkers(markerScene(id), threshold),
        oldCore.detectMarkers(markerScene(id), threshold),
        `detectMarkers(ID ${id}, ${threshold})`,
      );
  }
  assert.deepEqual(
    core.detectMarkers(markerScene(1, { cover: true })),
    oldCore.detectMarkers(markerScene(1, { cover: true })),
  );

  const quad = [
    { x: 20, y: 10 },
    { x: 120, y: 30 },
    { x: 110, y: 90 },
    { x: 10, y: 70 },
  ];
  for (const [u, v] of [
    [0, 0],
    [0.25, 0.75],
    [1, 1],
  ])
    assert.deepEqual(core.quadTransform(quad)(u, v), oldCore.quadTransform(quad)(u, v));

  for (const [width, height] of [
    [320, 220],
    [960, 720],
    [40, 30],
  ])
    assert.deepEqual(
      core.detectionTags(FACE_BOXES, width, height),
      oldCore.detectionTags(FACE_BOXES, width, height),
      `detectionTags(${width}×${height})`,
    );
});
