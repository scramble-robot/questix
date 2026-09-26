import { floorSceneImage } from './scene.js';
import {
  IMAGE_SIZE,
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
} from './basics-math.js';

// The scenes of the "まとまりを見つける" chapter, and the course's single import address. Only this
// file needs a browser: scene.js decodes the teaching photograph with the canvas. Everything else
// is plain maths in basics-math.js, which Node can import and test, and which is re-exported here
// so importers keep one address.

// Human-authored evaluation boxes for the two floor mats, never an input to the detector.
const FLOOR_MATS = [
  { x: 16, y: 127, w: 122, h: 62 },
  { x: 197, y: 132, w: 101, h: 60 },
];
const SPECKLE_RGB = [212, 45, 35]; // red dots that look like small objects to a colour filter
const CHIP_RGB = [210, 212, 210]; // pale chips that punch holes into the mats
const SPECKLE_COUNT = 36;
// Fixed positions, so every learner sees the same scene and can compare settings.
const CHIP_POSITIONS = [
  [90, 143],
  [99, 154],
  [113, 167],
  [220, 151],
  [233, 161],
  [249, 178],
];
const DARK_FACTOR = 0.3; // how much of the original brightness the dark scene keeps

function fillSquare(image, x, y, rgb, size) {
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++)
      image.data.set([...rgb, 255], ((y + dy) * image.width + x + dx) * 4);
}

function fillBox(image, box, rgb) {
  for (let y = box.y; y < box.y + box.h; y++)
    for (let x = box.x; x < box.x + box.w; x++)
      image.data.set([...rgb, 255], (y * image.width + x) * 4);
}

function addSpecklesAndChips(image) {
  // The multipliers spread the dots over the whole image without a random number generator.
  for (let n = 0; n < SPECKLE_COUNT; n++)
    fillSquare(image, 8 + ((n * 79) % 300), 8 + ((n * 47) % 204), SPECKLE_RGB, 2);
  for (const [x, y] of CHIP_POSITIONS) fillSquare(image, x, y, CHIP_RGB, 3);
}

function darken(image, factor) {
  // Alpha (every fourth byte) stays as it is.
  for (let at = 0; at < image.data.length; at++) if (at % 4 !== 3) image.data[at] *= factor;
}

function floorScene(scene) {
  const image = floorSceneImage();
  if (scene === 'noise' || scene === 'dark') addSpecklesAndChips(image);
  if (scene === 'dark') darken(image, DARK_FACTOR);
  return { image, targets: FLOOR_MATS.map((box) => ({ ...box })) };
}

// Synthetic two-box fixture retained for algorithm regression checks only; no chapter offers it.
function closeObjectFixture() {
  const image = blankImage();
  const targets = [
    { x: 80, y: 105, w: 65, h: 65 },
    { x: 148, y: 105, w: 65, h: 65 },
  ];
  for (const box of targets) fillBox(image, box, [212, 66, 45]);
  fillBox(image, { x: 220, y: 24, w: 56, h: 34 }, [212, 66, 45]); // the sign on the wall
  return { image, targets };
}

// 'clean', 'noise' and 'dark' are the same room; 'close' is the synthetic fixture.
function regionScene(scene = 'noise') {
  if (scene === 'close') return closeObjectFixture();
  return floorScene(scene);
}

export {
  IMAGE_SIZE,
  blankImage,
  cameraEffects,
  brightnessHistogram,
  nearWhiteFraction,
  rgbToHsv,
  colorMask,
  morphology,
  maskImage,
  connectedRegions,
  regionScene,
  evaluateRegions,
  matchRegions,
  projectedTarget,
  cameraGeometry,
  linePath,
  lineCamera,
  lineObservation,
  followCommand,
  runLineTrial,
};
