// Small, deterministic image experiments for the vision foundation chapters: exposure and blur,
// colour selection, connected regions, the pinhole relation between size and distance, and the
// line-following run. Detection always operates on pixels, never on the numbers a scene was built
// from. No DOM, so this module is importable from Node and covered by
// test/vision-basics-core.test.mjs. basics-core.js adds the one scene that needs a browser.

const IMAGE_SIZE = { width: 320, height: 220 }; // pixels of a teaching image
const BACKGROUND_RGB = [222, 226, 228];
const BLACK_RGB = [0, 0, 0];
const MAX_CHANNEL = 255;
const OPAQUE = 255;
const DEGREES_PER_TURN = 360;

function blankImage(width = IMAGE_SIZE.width, height = IMAGE_SIZE.height, rgb = BACKGROUND_RGB) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) data.set([...rgb, OPAQUE], pixel * 4);
  return { width, height, data };
}

// ---- 撮り方を変える: exposure, motion blur, pixel count ----------------------------------------

const MIN_CAPTURE_WIDTH = 16; // pixels; a narrower image would carry no recognisable shape

// Area averaging: reducing the pixel count must not invent detail the camera never measured.
// Exposure is applied per source pixel and clipped there, which is what loses the colour
// differences in a bright area for good.
function resampleWithExposure(image, out, exposure) {
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const left = Math.floor((x * image.width) / out.width);
      const right = Math.max(left + 1, Math.floor(((x + 1) * image.width) / out.width));
      const top = Math.floor((y * image.height) / out.height);
      const bottom = Math.max(top + 1, Math.floor(((y + 1) * image.height) / out.height));
      const sums = [0, 0, 0];
      let counted = 0;
      for (let sourceY = top; sourceY < bottom; sourceY++)
        for (let sourceX = left; sourceX < right; sourceX++) {
          const source = (sourceY * image.width + sourceX) * 4;
          for (let channel = 0; channel < 3; channel++)
            sums[channel] += Math.min(MAX_CHANNEL, image.data[source + channel] * exposure);
          counted++;
        }
      const target = (y * out.width + x) * 4;
      for (let channel = 0; channel < 3; channel++)
        out.data[target + channel] = sums[channel] / counted;
    }
}

// Box average over `radius` pixels either side; the border pixel repeats beyond the edge.
function blurHorizontally(image, radius) {
  const original = new Uint8ClampedArray(image.data);
  const span = radius * 2 + 1;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++)
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        for (let offset = -radius; offset <= radius; offset++) {
          const sourceX = Math.max(0, Math.min(image.width - 1, x + offset));
          sum += original[(y * image.width + sourceX) * 4 + channel];
        }
        image.data[(y * image.width + x) * 4 + channel] = sum / span;
      }
}

// `blur` is the smear in pixels of the original image; it scales with the output width.
function cameraEffects(image, { exposure = 1, blur = 0, width = image.width } = {}) {
  const outWidth = Math.max(MIN_CAPTURE_WIDTH, Math.min(image.width, Math.round(width)));
  const outHeight = Math.max(1, Math.round((image.height * outWidth) / image.width));
  const out = blankImage(outWidth, outHeight);
  resampleWithExposure(image, out, exposure);
  const radius = Math.round((blur * outWidth) / image.width);
  if (radius) blurHorizontally(out, radius);
  return out;
}

const HISTOGRAM_BINS = 32;
const LUMA = { red: 0.299, green: 0.587, blue: 0.114 }; // ITU-R BT.601 brightness weights

function brightnessHistogram(image) {
  const bins = Array(HISTOGRAM_BINS).fill(0);
  const binWidth = (MAX_CHANNEL + 1) / HISTOGRAM_BINS;
  for (let at = 0; at < image.data.length; at += 4) {
    const brightness =
      LUMA.red * image.data[at] + LUMA.green * image.data[at + 1] + LUMA.blue * image.data[at + 2];
    bins[Math.min(HISTOGRAM_BINS - 1, Math.floor(brightness / binWidth))]++;
  }
  return bins;
}

const NEAR_WHITE = 250; // channel value from which a pixel counts as clipped to white

// Share of pixels that are near-white in all three channels, i.e. where exposure has thrown the
// colour differences away.
function nearWhiteFraction(image, level = NEAR_WHITE) {
  let clipped = 0;
  for (let at = 0; at < image.data.length; at += 4)
    if (image.data[at] >= level && image.data[at + 1] >= level && image.data[at + 2] >= level)
      clipped++;
  return clipped / (image.width * image.height);
}

// ---- まとまりを見つける: colour selection, cleanup, connected regions ---------------------------

function hueDegrees(red, green, blue, max, span) {
  if (!span) return 0;
  if (max === red) return 60 * (((green - blue) / span) % 6);
  if (max === green) return 60 * ((blue - red) / span + 2);
  return 60 * ((red - green) / span + 4);
}

// Channels are 0…255; the result is hue in degrees, saturation and value in 0…1.
function rgbToHsv(r, g, b) {
  const red = r / MAX_CHANNEL;
  const green = g / MAX_CHANNEL;
  const blue = b / MAX_CHANNEL;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const span = max - min;
  const hue = hueDegrees(red, green, blue, max, span);
  return {
    h: (hue + DEGREES_PER_TURN) % DEGREES_PER_TURN,
    s: max ? span / max : 0,
    v: max,
  };
}

const RED_OVER_OTHERS = 60; // how much stronger red must be than both green and blue
const RED_MINIMUM = 60; // and how strong red itself must be
const HSV_MIN_SATURATION = 0.35;
const HSV_MIN_VALUE = 0.12;

const redByChannels = (red, green, blue) =>
  red - Math.max(green, blue) > RED_OVER_OTHERS && red > RED_MINIMUM;

function redByHue(red, green, blue, hue, tolerance) {
  const hsv = rgbToHsv(red, green, blue);
  const gap = Math.abs(hsv.h - hue);
  const distance = Math.min(gap, DEGREES_PER_TURN - gap); // hue wraps around at 360°
  return distance <= tolerance && hsv.s > HSV_MIN_SATURATION && hsv.v > HSV_MIN_VALUE;
}

// `roi` skips that share of the image height from the top, so a floor marker can be searched for
// without the wall above it.
function colorMask(image, { method = 'hsv', hue = 8, tolerance = 22, roi = 0 } = {}) {
  const mask = new Uint8Array(image.width * image.height);
  for (let y = Math.floor(image.height * roi); y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const index = y * image.width + x;
      const at = index * 4;
      const red = image.data[at];
      const green = image.data[at + 1];
      const blue = image.data[at + 2];
      const selected =
        method === 'rgb'
          ? redByChannels(red, green, blue)
          : redByHue(red, green, blue, hue, tolerance);
      mask[index] = selected ? 1 : 0;
    }
  return mask;
}

// One erosion or dilation over a square neighbourhood. Outside the image counts as background,
// so a white area touching the border is eroded from that side too.
function morphologyPass(mask, width, height, radius, grow) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let value = grow ? 0 : 1;
      scan: for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          const inside = nx >= 0 && nx < width && ny >= 0 && ny < height;
          const neighbour = inside ? mask[ny * width + nx] : 0;
          if (grow && neighbour) {
            value = 1;
            break scan;
          }
          if (!grow && !neighbour) {
            value = 0;
            break scan;
          }
        }
      out[y * width + x] = value;
    }
  return out;
}

const erode = (mask, width, height, radius) => morphologyPass(mask, width, height, radius, false);
const dilate = (mask, width, height, radius) => morphologyPass(mask, width, height, radius, true);

// Opening removes speckles, closing fills small holes; both is opening followed by closing.
function morphology(mask, w, h, operation = 'none', radius = 1) {
  if (operation === 'open') return dilate(erode(mask, w, h, radius), w, h, radius);
  if (operation === 'close') return erode(dilate(mask, w, h, radius), w, h, radius);
  if (operation === 'both')
    return morphology(morphology(mask, w, h, 'open', radius), w, h, 'close', radius);
  return new Uint8Array(mask);
}

// Selected pixels as a black-and-white image, so learners see exactly what was selected.
function maskImage(mask, width, height) {
  const out = blankImage(width, height, BLACK_RGB);
  for (let index = 0; index < mask.length; index++) {
    const at = index * 4;
    const value = mask[index] * MAX_CHANNEL;
    out.data[at] = value;
    out.data[at + 1] = value;
    out.data[at + 2] = value;
  }
  return out;
}

// Breadth-first walk over the 4-connected pixels reachable from `start`, marking them as seen.
function floodFill(mask, width, height, start, seen, queue) {
  let head = 0;
  let tail = 1;
  let area = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = width;
  let maxX = 0;
  let minY = height;
  let maxY = 0;
  queue[0] = start;
  seen[start] = 1;
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    area++;
    sumX += x;
    sumY += y;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    const neighbours = [
      x > 0 ? index - 1 : -1,
      x + 1 < width ? index + 1 : -1,
      y > 0 ? index - width : -1,
      y + 1 < height ? index + width : -1,
    ];
    for (const neighbour of neighbours)
      if (neighbour >= 0 && !seen[neighbour] && mask[neighbour]) {
        seen[neighbour] = 1;
        queue[tail++] = neighbour;
      }
  }
  // Area is the pixel count, the centre is the mean pixel position, x/y/w/h the bounding box.
  return {
    area,
    cx: sumX / area,
    cy: sumY / area,
    x: minX,
    y: minY,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
  };
}

// Regions of connected selected pixels, largest first; smaller ones than `minArea` are dropped.
function connectedRegions(mask, w, h, minArea = 1) {
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const regions = [];
  for (let start = 0; start < mask.length; start++) {
    if (seen[start] || !mask[start]) continue;
    const region = floodFill(mask, w, h, start, seen, queue);
    if (region.area >= minArea) regions.push(region);
  }
  return regions.sort((a, b) => b.area - a.area);
}

const OVERLAP_THRESHOLD = 0.65; // intersection over union at which a box counts as the marker

function intersectionOverUnion(a, b) {
  const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const overlap = width * height;
  return overlap / (a.w * a.h + b.w * b.h - overlap);
}

// Which found region matched which answer box: `verdicts[i]` is 'correct' or 'extra' for
// regions[i], `missed` the answer boxes no region matched. Each target is matched once.
function matchRegions(regions, targets) {
  const matched = new Set();
  const verdicts = regions.map((region) => {
    const index = targets.findIndex(
      (target, at) => !matched.has(at) && intersectionOverUnion(region, target) > OVERLAP_THRESHOLD,
    );
    if (index < 0) return 'extra';
    matched.add(index);
    return 'correct';
  });
  return { verdicts, missed: targets.filter((_, index) => !matched.has(index)) };
}

// Scores found regions against the human-authored answer boxes. Each target is matched once.
function evaluateRegions(regions, targets) {
  const { verdicts } = matchRegions(regions, targets);
  const found = verdicts.filter((verdict) => verdict === 'correct').length;
  return { found, missed: targets.length - found, falsePositive: regions.length - found };
}

// ---- RGBだけで距離は分かる？: the pinhole relation --------------------------------------------

const DEFAULT_FOCAL = 250; // pixels
const TARGET_RGB = [212, 66, 45];

// A square marker facing the camera, drawn where a pinhole camera would project it.
function projectedTarget({ distance = 1, width = 0.2, lateral = 0, focal = DEFAULT_FOCAL } = {}) {
  const image = blankImage();
  const cx = IMAGE_SIZE.width / 2 + (focal * lateral) / distance;
  const cy = IMAGE_SIZE.height / 2;
  const size = (focal * width) / distance;
  for (let y = 0; y < IMAGE_SIZE.height; y++)
    for (let x = 0; x < IMAGE_SIZE.width; x++) {
      if (Math.abs(x + 0.5 - cx) >= size / 2) continue;
      if (Math.abs(y + 0.5 - cy) >= size / 2) continue;
      image.data.set([...TARGET_RGB, OPAQUE], (y * IMAGE_SIZE.width + x) * 4);
    }
  return { image, cx, cy, size };
}

// Direction in degrees (negative is left) and depth along the optical axis in metres. The depth is
// only as right as `knownWidth`: the image cannot tell a small near marker from a large far one.
function cameraGeometry(
  region,
  { focal = DEFAULT_FOCAL, knownWidth = 0.2, imageWidth = IMAGE_SIZE.width } = {},
) {
  const centreX = (imageWidth - 1) / 2;
  return {
    angle: (Math.atan((region.cx - centreX) / focal) * 180) / Math.PI,
    depth: (focal * knownWidth) / region.w,
  };
}

// ---- ラインをたどる: camera, detector and the two-wheel run -------------------------------------

const LINE_AMPLITUDE = 0.36; // metres the line swings either side of the x axis
const LINE_WAVENUMBER = 1.6; // radians per metre

function linePath(x) {
  return LINE_AMPLITUDE * Math.sin(x * LINE_WAVENUMBER);
}

const LINE_CAMERA = {
  width: 120, // pixels
  height: 90,
  focal: 95, // pixels
  pitch: Math.PI / 4, // radians below the horizon
  mountHeight: 0.25, // metres above the floor
};
const LINE_HALF_WIDTH = 0.035; // metres
const COURSE = {
  length: 5, // metres of line drawn on the floor
  goalX: 4.5,
  gapFrom: 1.9,
  gapTo: 2.4,
  shadowFrom: 1,
  shadowTo: 1.6,
};
const FLOOR_GREY = { line: 30, shadow: 112, floor: 225 };

function floorGrey(wx, wy, { gap, shadow }) {
  const inGap = gap && wx > COURSE.gapFrom && wx < COURSE.gapTo;
  const onLine =
    wx >= 0 && wx < COURSE.length && Math.abs(wy - linePath(wx)) < LINE_HALF_WIDTH && !inGap;
  if (onLine) return FLOOR_GREY.line;
  if (shadow && wx > COURSE.shadowFrom && wx < COURSE.shadowTo) return FLOOR_GREY.shadow;
  return FLOOR_GREY.floor;
}

// Downward-looking camera on a robot at `pose`: every pixel is a ray cast onto the floor plane.
// Pixels whose ray points at or above the horizon keep the background colour.
function lineCamera(pose, { gap = false, shadow = false } = {}) {
  const { width, height, focal, pitch, mountHeight } = LINE_CAMERA;
  const image = blankImage(width, height);
  const cosTheta = Math.cos(pose.theta);
  const sinTheta = Math.sin(pose.theta);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const rayY = (y + 0.5 - height / 2) / focal;
      const down = sinPitch + rayY * cosPitch;
      const forward = cosPitch - rayY * sinPitch;
      if (down <= 0 || forward <= 0) continue;
      const range = mountHeight / down; // metres along the ray to the floor
      const ahead = range * forward;
      const left = (-range * (x + 0.5 - width / 2)) / focal;
      const wx = pose.x + cosTheta * ahead - sinTheta * left;
      const wy = pose.y + sinTheta * ahead + cosTheta * left;
      const grey = floorGrey(wx, wy, { gap, shadow });
      image.data.set([grey, grey, grey, OPAQUE], (y * width + x) * 4);
    }
  return image;
}

const OBSERVE_WINDOW = { top: 0.62, bottom: 0.84 }; // fractions of the image height
const MIN_LINE_PIXELS = 8;
const MAX_LINE_FRACTION = 0.55; // above this the whole strip is dark, so no line can be located

// Mean horizontal position of the dark pixels in a band near the bottom of the image. `error` is
// the offset from the image centre, scaled so that the image edge is ±1.
function lineObservation(image, { threshold = 90 } = {}) {
  const width = image.width;
  const firstRow = Math.floor(image.height * OBSERVE_WINDOW.top);
  const lastRow = Math.floor(image.height * OBSERVE_WINDOW.bottom);
  const mask = new Uint8Array(width * image.height);
  let count = 0;
  let sumX = 0;
  for (let y = firstRow; y < lastRow; y++)
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (image.data[index * 4] >= threshold) continue;
      mask[index] = 1;
      sumX += x;
      count++;
    }
  const fraction = count / (width * (lastRow - firstRow));
  const valid = count >= MIN_LINE_PIXELS && fraction < MAX_LINE_FRACTION;
  return {
    mask,
    count,
    valid,
    cx: valid ? sumX / count : null,
    error: valid ? (sumX / count - (width - 1) / 2) / (width / 2) : null,
  };
}

const TRACK_WIDTH = 0.32; // metres between the two wheels
const MAX_WHEEL_SPEED = 0.8; // m/s

// Proportional control: the sideways offset becomes a turn rate, the turn rate a wheel difference.
// Both wheels are scaled down together when one would exceed the motor limit.
function followCommand(observation, { speed = 0.35, gain = 2 } = {}) {
  if (!observation.valid) return { left: 0, right: 0, omega: 0 };
  const omega = -gain * observation.error; // rad/s
  const left = speed - (omega * TRACK_WIDTH) / 2;
  const right = speed + (omega * TRACK_WIDTH) / 2;
  const scale = Math.max(1, Math.abs(left) / MAX_WHEEL_SPEED, Math.abs(right) / MAX_WHEEL_SPEED);
  return { left: left / scale, right: right / scale, omega: omega / scale };
}

const TRIAL = { maxSteps: 400, step: 0.1 }; // step in seconds

// One run of the whole loop: camera image, detection, wheel command, motion. `outcome` is
// 'goal', 'lost' (the line could not be located) or 'timeout'; the chapter turns it into a
// sentence. meanError is the mean sideways distance from the line in metres.
function runLineTrial({
  speed = 0.35,
  gain = 2,
  threshold = 90,
  gap = false,
  shadow = false,
} = {}) {
  const pose = { x: 0, y: 0, theta: 0 };
  const frames = [];
  let outcome = 'timeout';
  let errorSum = 0;
  for (let step = 0; step < TRIAL.maxSteps; step++) {
    const image = lineCamera(pose, { gap, shadow });
    const observation = lineObservation(image, { threshold });
    const arrived = pose.x >= COURSE.goalX;
    const command = arrived
      ? { left: 0, right: 0, omega: 0 }
      : followCommand(observation, { speed, gain });
    frames.push({
      pose: { ...pose },
      observation: {
        valid: observation.valid,
        cx: observation.cx,
        error: observation.error,
        count: observation.count,
      },
      command,
      time: step * TRIAL.step,
    });
    errorSum += Math.abs(pose.y - linePath(pose.x));
    if (arrived) {
      outcome = 'goal';
      break;
    }
    if (!observation.valid) {
      outcome = 'lost';
      break;
    }
    // Midpoint integration of the two-wheel model.
    const forward = (command.left + command.right) / 2;
    const midTheta = pose.theta + (command.omega * TRIAL.step) / 2;
    pose.x += Math.cos(midTheta) * forward * TRIAL.step;
    pose.y += Math.sin(midTheta) * forward * TRIAL.step;
    pose.theta += command.omega * TRIAL.step;
  }
  return {
    frames,
    outcome,
    success: outcome === 'goal',
    meanError: errorSum / frames.length,
    seconds: frames.at(-1).time,
    options: { speed, gain, threshold, gap, shadow },
  };
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
