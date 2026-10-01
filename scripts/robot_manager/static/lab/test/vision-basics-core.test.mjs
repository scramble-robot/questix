// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// basics-core.js decodes the teaching photograph through the canvas, so it cannot be imported
// here; its maths lives in basics-math.js, which is DOM-free and is what these tests cover. The
// values pin the behaviour the vision chapters were built on — the rendered result is checked
// separately by test/ui-regression.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blankImage,
  cameraEffects,
  brightnessHistogram,
  nearWhiteFraction,
  rgbToHsv,
  colorMask,
  morphology,
  maskImage,
  connectedRegions,
  evaluateRegions,
  matchRegions,
  projectedTarget,
  cameraGeometry,
  linePath,
  lineCamera,
  lineObservation,
  followCommand,
  runLineTrial,
} from '../js/vision/basics-math.js';

const pixelAt = (image, x, y) => {
  const at = (y * image.width + x) * 4;
  return Array.from(image.data.slice(at, at + 4));
};

function imageOf(width, height, colorAt) {
  const image = blankImage(width, height, [0, 0, 0]);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) image.data.set([...colorAt(x, y), 255], (y * width + x) * 4);
  return image;
}

test('a blank image is opaque and uniform', () => {
  const image = blankImage(4, 3, [10, 20, 30]);
  assert.equal(image.data.length, 4 * 3 * 4);
  assert.deepEqual(pixelAt(image, 3, 2), [10, 20, 30, 255]);
});

test('exposure clips before the pixels are averaged, so the loss cannot be undone', () => {
  const image = imageOf(2, 1, (x) => (x === 0 ? [100, 100, 100] : [200, 200, 200]));
  const bright = cameraEffects(image, { exposure: 3, width: 16 });
  // 100×3 and 200×3 both clip to 255: the two different greys became one.
  assert.deepEqual(pixelAt(bright, 0, 0).slice(0, 3), [255, 255, 255]);
  assert.deepEqual(pixelAt(bright, 15, 0).slice(0, 3), [255, 255, 255]);
});

test('a narrower image averages areas instead of dropping pixels', () => {
  const stripes = imageOf(32, 1, (x) => (x % 2 ? [200, 200, 200] : [0, 0, 0]));
  const half = cameraEffects(stripes, { width: 16 });
  assert.equal(half.width, 16);
  // Dropping every other column would give 0 or 200; averaging gives the mid grey, and the
  // thin pattern is gone either way.
  assert.equal(pixelAt(half, 0, 0)[0], 100);
  assert.equal(pixelAt(half, 15, 0)[0], 100);
  assert.equal(cameraEffects(stripes, { width: 2 }).width, 16, 'never below the readable minimum');
});

test('horizontal blur spreads an edge and repeats the border pixel', () => {
  const image = imageOf(32, 1, (x) => (x < 16 ? [0, 0, 0] : [240, 240, 240]));
  const blurred = cameraEffects(image, { blur: 2 });
  assert.equal(pixelAt(blurred, 0, 0)[0], 0, 'the border pixel repeats, so the dark side stays 0');
  assert.equal(pixelAt(blurred, 31, 0)[0], 240, 'and the light side stays 240');
  const edge = [14, 15, 16, 17].map((x) => pixelAt(blurred, x, 0)[0]);
  assert.deepEqual(edge, [48, 96, 144, 192], 'the step became a five-pixel ramp');
});

test('the brightness histogram has 32 bins covering 0…255', () => {
  const bins = brightnessHistogram(imageOf(4, 4, () => [0, 0, 0]));
  assert.equal(bins.length, 32);
  assert.equal(bins[0], 16);
  assert.equal(brightnessHistogram(imageOf(2, 2, () => [255, 255, 255]))[31], 4);
});

test('nearWhiteFraction counts only pixels clipped in all three channels', () => {
  const image = imageOf(2, 1, (x) => (x === 0 ? [255, 255, 255] : [255, 255, 100]));
  assert.equal(nearWhiteFraction(image), 0.5);
});

test('rgbToHsv keeps the hue of a colour that is only dimmed', () => {
  const bright = rgbToHsv(212, 66, 45);
  const dim = rgbToHsv(212 * 0.3, 66 * 0.3, 45 * 0.3);
  assert.ok(Math.abs(bright.h - dim.h) < 1e-9, 'hue survives the lower light');
  assert.ok(dim.v < bright.v, 'value does not');
  assert.deepEqual(rgbToHsv(0, 0, 0), { h: 0, s: 0, v: 0 });
  assert.ok(Math.abs(rgbToHsv(0, 255, 0).h - 120) < 1e-9);
});

test('HSV selection survives the dark scene where the RGB rule does not', () => {
  const dimRed = imageOf(1, 1, () => [64, 20, 14]);
  assert.equal(colorMask(dimRed, { method: 'rgb' })[0], 0, 'the channel gap is now too small');
  assert.equal(colorMask(dimRed, { method: 'hsv' })[0], 1);
});

test('a region of interest ignores the top of the image', () => {
  const image = imageOf(4, 4, (x, y) => (y === 0 ? [212, 66, 45] : [200, 200, 200]));
  assert.equal(
    colorMask(image, { method: 'rgb' }).reduce((a, b) => a + b),
    4,
  );
  assert.equal(
    colorMask(image, { method: 'rgb', roi: 0.25 }).reduce((a, b) => a + b),
    0,
  );
});

test('opening removes a lone speckle, closing fills a lone hole', () => {
  const size = 7;
  const speckle = new Uint8Array(size * size);
  speckle[3 * size + 3] = 1;
  assert.equal(
    morphology(speckle, size, size, 'open', 1).reduce((a, b) => a + b),
    0,
  );
  assert.equal(
    morphology(speckle, size, size, 'none', 1).reduce((a, b) => a + b),
    1,
  );

  const holed = new Uint8Array(size * size).fill(1);
  holed[3 * size + 3] = 0;
  assert.equal(morphology(holed, size, size, 'close', 1)[3 * size + 3], 1);
  // Erosion treats the outside as background, so the border ring is lost either way.
  assert.equal(morphology(holed, size, size, 'close', 1)[0], 0);
});

test('a mask is shown as black and white pixels', () => {
  const mask = Uint8Array.from([1, 0]);
  const image = maskImage(mask, 2, 1);
  assert.deepEqual(pixelAt(image, 0, 0), [255, 255, 255, 255]);
  assert.deepEqual(pixelAt(image, 1, 0), [0, 0, 0, 255]);
});

test('connected regions report area, centre and bounding box, largest first', () => {
  const width = 10;
  const height = 6;
  const mask = new Uint8Array(width * height);
  for (let y = 1; y <= 3; y++) for (let x = 1; x <= 4; x++) mask[y * width + x] = 1; // 12 pixels
  mask[5 * width + 8] = 1; // a single speckle
  const regions = connectedRegions(mask, width, height);
  assert.equal(regions.length, 2);
  assert.deepEqual(
    { ...regions[0] },
    { area: 12, cx: 2.5, cy: 2, x: 1, y: 1, w: 4, h: 3 },
    'diagonal neighbours do not join regions',
  );
  assert.equal(regions[1].area, 1);
  assert.equal(connectedRegions(mask, width, height, 2).length, 1, 'minArea drops the speckle');
});

test('scoring counts a marker once and calls everything else a false positive', () => {
  const targets = [
    { x: 0, y: 0, w: 10, h: 10 },
    { x: 50, y: 50, w: 10, h: 10 },
  ];
  const hit = { x: 0, y: 0, w: 10, h: 10 };
  const nearMiss = { x: 0, y: 0, w: 30, h: 30 };
  assert.deepEqual(evaluateRegions([hit], targets), { found: 1, missed: 1, falsePositive: 0 });
  assert.deepEqual(evaluateRegions([hit, hit], targets), {
    found: 1,
    missed: 1,
    falsePositive: 1,
  });
  assert.deepEqual(evaluateRegions([nearMiss], targets), {
    found: 0,
    missed: 2,
    falsePositive: 1,
  });
});

test('each found box is called correct or extra, and unmatched answers are missed (V6)', () => {
  const targets = [
    { x: 0, y: 0, w: 10, h: 10 },
    { x: 50, y: 50, w: 10, h: 10 },
  ];
  const hit = { x: 0, y: 0, w: 10, h: 10 };
  const wall = { x: 100, y: 0, w: 20, h: 10 };
  const match = matchRegions([wall, hit, hit], targets);
  assert.deepEqual(match.verdicts, ['extra', 'correct', 'extra']);
  assert.deepEqual(match.missed, [targets[1]]);
  const score = evaluateRegions([wall, hit, hit], targets);
  assert.equal(score.found, match.verdicts.filter((verdict) => verdict === 'correct').length);
  assert.equal(score.missed, match.missed.length);
});

test('a marker twice as wide at twice the distance projects to the same square', () => {
  const near = projectedTarget({ distance: 1, width: 0.2 });
  const far = projectedTarget({ distance: 2, width: 0.4 });
  assert.equal(near.size, far.size);
  assert.deepEqual(Array.from(near.image.data), Array.from(far.image.data));
});

test('the depth read from an image is only as right as the width it was told', () => {
  const target = projectedTarget({ distance: 1.5, width: 0.2, focal: 250 });
  const region = connectedRegions(colorMask(target.image), 320, 220, 10)[0];
  const measured = cameraGeometry(region, { focal: 250, knownWidth: 0.2 });
  assert.ok(Math.abs(measured.depth - 1.5) < 0.05);
  assert.ok(Math.abs(measured.angle) < 0.5, 'a centred marker is straight ahead');
  const wrongWidth = cameraGeometry(region, { focal: 250, knownWidth: 0.4 });
  assert.ok(Math.abs(wrongWidth.depth - 2 * measured.depth) < 1e-9);
  const offCentre = projectedTarget({ distance: 1.5, width: 0.2, lateral: 0.3 });
  const right = connectedRegions(colorMask(offCentre.image), 320, 220, 10)[0];
  assert.ok(cameraGeometry(right).angle > 0, 'a marker to the right gives a positive angle');
});

test('the line camera looks ahead, so a bend is seen before it is reached', () => {
  const observation = lineObservation(lineCamera({ x: 0, y: 0, theta: 0 }));
  assert.equal(observation.valid, true);
  assert.ok(observation.count > 0);
  // The robot starts exactly on the line, but the band it reads is a stretch of floor ahead,
  // where the line has already curved to the left (negative error).
  assert.ok(observation.error < 0);

  const furtherRight = lineObservation(lineCamera({ x: 0, y: -0.1, theta: 0 }));
  assert.ok(
    furtherRight.error < observation.error,
    'moving right of the line pushes the line further left in the image',
  );
});

test('a gap in the line and an all-dark view are both reported as not located', () => {
  const overGap = lineObservation(lineCamera({ x: 2, y: linePath(2), theta: 0 }, { gap: true }));
  assert.equal(overGap.valid, false);
  assert.equal(overGap.cx, null);
  const darkFloor = lineObservation(lineCamera({ x: 0, y: 0, theta: 0 }), { threshold: 255 });
  assert.equal(darkFloor.valid, false, 'a threshold that selects the whole floor locates nothing');
});

test('the wheel command turns towards the line and stays within the motor limit', () => {
  const stopped = followCommand({ valid: false });
  assert.deepEqual(stopped, { left: 0, right: 0, omega: 0 });

  const lineToTheRight = followCommand({ valid: true, error: 0.5 }, { speed: 0.35, gain: 2 });
  assert.ok(
    lineToTheRight.left > lineToTheRight.right,
    'the left wheel is faster, so it turns right',
  );
  assert.ok(lineToTheRight.omega < 0);

  const extreme = followCommand({ valid: true, error: 1 }, { speed: 0.65, gain: 6 });
  assert.ok(Math.max(Math.abs(extreme.left), Math.abs(extreme.right)) <= 0.8 + 1e-9);
});

test('a trial reaches the goal with a usable gain and is lost at the gap', () => {
  const run = runLineTrial({ speed: 0.35, gain: 3, threshold: 90 });
  assert.equal(run.outcome, 'goal');
  assert.equal(run.success, true);
  assert.ok(run.frames.at(-1).pose.x >= 4.5);
  assert.equal(run.seconds, run.frames.at(-1).time);
  assert.ok(run.meanError < 0.1, 'it stays within 10 cm of the line on average');
  assert.deepEqual(run.options, { speed: 0.35, gain: 3, threshold: 90, gap: false, shadow: false });

  const lost = runLineTrial({ speed: 0.35, gain: 3, threshold: 90, gap: true });
  assert.equal(lost.outcome, 'lost');
  assert.equal(lost.success, false);
  assert.ok(lost.frames.at(-1).pose.x < 2.5, 'it stops at the gap');
});

test('without steering the robot leaves the line, and a dark floor confuses the threshold', () => {
  const straightOn = runLineTrial({ speed: 0.35, gain: 0, threshold: 90 });
  assert.equal(straightOn.outcome, 'lost', 'it drives straight off the first bend');
  assert.ok(straightOn.frames.at(-1).pose.x < 0.5);

  const overShadow = runLineTrial({ speed: 0.35, gain: 3, threshold: 150, shadow: true });
  assert.equal(overShadow.outcome, 'lost', 'the dark floor is read as one wide line');
});
