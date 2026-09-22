// Image maths for the vision course: pixel operations, the colour/shape features the classifier
// compares, the 4×4 ArUco marker reader and the placement of the numbered tags drawn next to
// detections. No DOM: images are plain { width, height, data } with RGBA bytes in `data`.
// Every decision here is made from pixels or features, never from a scene object label.

const DEFAULT_THRESHOLD = 110;
const BLACK = 0;
const WHITE = 255;
const OPAQUE = 255;
// Rec. 601 luma weights, the same mix the course calls "明るさ".
const LUMA_RED = 0.299;
const LUMA_GREEN = 0.587;
const LUMA_BLUE = 0.114;
// "赤い部分を取り出す" needs a pixel to be this bright before its redness counts at all.
const RED_MIN_LEVEL = 60;
// The edge threshold is coarser than the others: the slider value is multiplied by this.
const EDGE_GAIN = 3;

// A pixel counts as coloured when its channels are this far apart and it is not too dark.
const COLOUR_SPREAD = 28;
const COLOUR_MIN_LEVEL = 45;
const MIN_OBJECT_PIXELS = 12;
// Feature order: red share, green share, blue share, how full the box is, box aspect ratio.
const FEATURE_WEIGHTS = {
  color: [1, 1, 1, 0, 0],
  both: [1, 1, 1, 12, 1],
  shape: [0, 0, 0, 30, 1],
};
const NEIGHBORS_KEPT = 3;

// First four codewords in OpenCV DICT_4X4_50 (row-major, 1 = white).
// Source: OpenCV predefined_dictionaries.hpp, Apache-2.0; see notices in README.
const ARUCO_CODES = [0xb532, 0x0f9a, 0x332d, 0x9946];
const MARKER_BITS = 16; // the 4×4 pattern inside the black border
const MARKER_SIDE = 4;
const MARKER_GRID = 6; // pattern plus the one-cell black border on each side
const MARKER_ROTATIONS = 4;
const MAX_BIT_ERRORS = 1; // mismatching cells an ID is still accepted with
const MIN_MARKER_PIXELS = 70; // a smaller dark blob cannot be a readable marker
const MAX_MARKER_AREA = 0.7; // of the image; a larger dark blob is the background
const MIN_MARKER_EDGE = 20; // px
const MAX_EDGE_RATIO = 3; // longest / shortest edge of the quad
// Each cell is read as the mean of nine samples, offset by this fraction of a cell.
const CELL_SAMPLES = [-0.12, 0, 0.12];

const TAG_WIDTH = 30; // px at scale 1
const TAG_HEIGHT = 22;
const TAG_GAP = 2;
const TAG_SCALE_WIDTH = 420; // image width (px) at which tags are drawn at scale 1
const TAG_MIN_SCALE = 0.25;
const TAG_HEIGHT_DIVISOR = 24; // tags never take more than image height / this

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function grayPixels(image) {
  const gray = new Uint8ClampedArray(image.width * image.height);
  for (let i = 0; i < gray.length; i++) {
    const pixel = i * 4;
    gray[i] =
      LUMA_RED * image.data[pixel] +
      LUMA_GREEN * image.data[pixel + 1] +
      LUMA_BLUE * image.data[pixel + 2];
  }
  return gray;
}

// ---- pixel operations ---------------------------------------------------------------------------

// How much redder than the strongest of green/blue this pixel is.
function redness(data, pixel) {
  return data[pixel] - Math.max(data[pixel + 1], data[pixel + 2]);
}

// Sobel: the strength of the brightness change around (x, y), edges clamped to the image.
function edgeStrength(gray, width, height, x, y) {
  const at = (column, row) => gray[clamp(row, 0, height - 1) * width + clamp(column, 0, width - 1)];
  const dx =
    -at(x - 1, y - 1) +
    at(x + 1, y - 1) -
    2 * at(x - 1, y) +
    2 * at(x + 1, y) -
    at(x - 1, y + 1) +
    at(x + 1, y + 1);
  const dy =
    -at(x - 1, y - 1) -
    2 * at(x, y - 1) -
    at(x + 1, y - 1) +
    at(x - 1, y + 1) +
    2 * at(x, y + 1) +
    at(x + 1, y + 1);
  return Math.hypot(dx, dy);
}

function writeGray(data, pixel, level) {
  data[pixel] = level;
  data[pixel + 1] = level;
  data[pixel + 2] = level;
  data[pixel + 3] = OPAQUE;
}

function copyPixel(data, source, pixel) {
  data[pixel] = source[pixel];
  data[pixel + 1] = source[pixel + 1];
  data[pixel + 2] = source[pixel + 2];
  data[pixel + 3] = OPAQUE;
}

// One of the four operations the learner can choose; `selected` counts the pixels kept by the
// "赤い部分を取り出す" rule and is ignored by the other modes.
function imageOperation(image, mode, threshold = DEFAULT_THRESHOLD) {
  const { width, height } = image;
  const data = new Uint8ClampedArray(image.data.length);
  const gray = grayPixels(image);
  let selected = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const pixel = index * 4;
      if (mode === 'gray') writeGray(data, pixel, gray[index]);
      else if (mode === 'binary') writeGray(data, pixel, gray[index] >= threshold ? WHITE : BLACK);
      else if (mode === 'red') {
        const kept = redness(image.data, pixel) > threshold && image.data[pixel] > RED_MIN_LEVEL;
        if (kept) selected++;
        writeGray(data, pixel, kept ? WHITE : BLACK);
      } else if (mode === 'edge') {
        const strong = edgeStrength(gray, width, height, x, y) > threshold * EDGE_GAIN;
        writeGray(data, pixel, strong ? WHITE : BLACK);
      } else copyPixel(data, image.data, pixel);
    }
  return { width, height, data, selected };
}

// ---- features and the one-nearest-neighbour classifier --------------------------------------------

// Describes the coloured object in the image by the share of each colour channel, how densely it
// fills its bounding box, and how wide that box is compared with its height.
function imageFeatures(image) {
  const { width, height, data } = image;
  const box = { left: width, top: height, right: 0, bottom: 0 };
  const total = { red: 0, green: 0, blue: 0 };
  let count = 0;
  for (let index = 0; index < width * height; index++) {
    const pixel = index * 4;
    const red = data[pixel];
    const green = data[pixel + 1];
    const blue = data[pixel + 2];
    const brightest = Math.max(red, green, blue);
    const darkest = Math.min(red, green, blue);
    if (brightest - darkest <= COLOUR_SPREAD || brightest <= COLOUR_MIN_LEVEL) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    count++;
    total.red += red;
    total.green += green;
    total.blue += blue;
    box.left = Math.min(box.left, x);
    box.right = Math.max(box.right, x);
    box.top = Math.min(box.top, y);
    box.bottom = Math.max(box.bottom, y);
  }
  if (count < MIN_OBJECT_PIXELS) return { valid: false, values: [0, 0, 0, 0, 0], bbox: null };
  const sum = total.red + total.green + total.blue;
  const boxWidth = box.right - box.left + 1;
  const boxHeight = box.bottom - box.top + 1;
  return {
    valid: true,
    values: [
      total.red / sum,
      total.green / sum,
      total.blue / sum,
      count / (boxWidth * boxHeight),
      boxWidth / boxHeight,
    ],
    bbox: { x: box.left, y: box.top, w: boxWidth, h: boxHeight },
    count,
  };
}

// The labelled examples are the model: there is no hard-coded shape-to-label mapping.
function trainImageClassifier(samples, mode = 'color') {
  if (!samples.some((s) => s.label === 0) || !samples.some((s) => s.label === 1))
    throw Error('荷箱とボールの両方の画像を登録してください。');
  const examples = samples
    .map((sample) => ({
      label: sample.label,
      features: imageFeatures(sample.image),
      id: sample.id,
    }))
    .filter((example) => example.features.valid);
  if (!examples.some((e) => e.label === 0) || !examples.some((e) => e.label === 1))
    throw Error('色のある物体を大きく写した画像を、両方の種類に登録してください。');
  return { mode, examples };
}

function featureDistance(values, example, weights) {
  const squares = values.map((value, i) => weights[i] * (value - example.features.values[i]) ** 2);
  return Math.sqrt(squares.reduce((sum, square) => sum + square, 0));
}

// Answers with the label of the closest labelled example, plus the examples it was closest to so
// the page can show the learner what the answer was based on.
function classifyImage(model, image) {
  const features = imageFeatures(image);
  if (!features.valid)
    return { label: null, neighbors: [], reason: '色のある物体の特徴を取り出せませんでした。' };
  const weights = FEATURE_WEIGHTS[model.mode] || FEATURE_WEIGHTS.color;
  const neighbors = model.examples
    .map((example) => ({
      id: example.id,
      label: example.label,
      distance: featureDistance(features.values, example, weights),
    }))
    .sort((a, b) => a.distance - b.distance);
  return { label: neighbors[0].label, neighbors: neighbors.slice(0, NEIGHBORS_KEPT), features };
}

// ---- ArUco markers --------------------------------------------------------------------------------

function markerBits(id) {
  return Array.from(
    { length: MARKER_BITS },
    (_, i) => (ARUCO_CODES[id] >> (MARKER_BITS - 1 - i)) & 1,
  );
}

// Turns the pattern a quarter turn clockwise.
function rotateBits(bits) {
  return Array.from(
    { length: MARKER_BITS },
    (_, i) =>
      bits[(MARKER_SIDE - 1 - (i % MARKER_SIDE)) * MARKER_SIDE + Math.floor(i / MARKER_SIDE)],
  );
}

// Compares the pattern with every known code at every quarter turn; an ID is only accepted when
// at most MAX_BIT_ERRORS cells disagree.
function decodeMarker(bits) {
  let best = { id: null, errors: MARKER_BITS + 1, rotation: 0 };
  let turned = [...bits];
  for (let rotation = 0; rotation < MARKER_ROTATIONS; rotation++) {
    ARUCO_CODES.forEach((_, id) => {
      const errors = markerBits(id).reduce((wrong, bit, i) => wrong + (bit !== turned[i]), 0);
      if (errors < best.errors) best = { id, errors, rotation };
    });
    turned = rotateBits(turned);
  }
  return { ...best, id: best.errors <= MAX_BIT_ERRORS ? best.id : null };
}

// Gauss-Jordan elimination with partial pivoting on an 8×9 augmented matrix.
// Returns null when the system is singular (the four corners are not a real quadrilateral).
function solve(matrix) {
  const size = matrix.length;
  for (let i = 0; i < size; i++) {
    let pivot = i;
    for (let j = i + 1; j < size; j++)
      if (Math.abs(matrix[j][i]) > Math.abs(matrix[pivot][i])) pivot = j;
    [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
    const scale = matrix[i][i];
    if (Math.abs(scale) < 1e-10) return null;
    for (let k = i; k <= size; k++) matrix[i][k] /= scale;
    for (let j = 0; j < size; j++) {
      if (j === i) continue;
      const factor = matrix[j][i];
      for (let k = i; k <= size; k++) matrix[j][k] -= factor * matrix[i][k];
    }
  }
  return matrix.map((row) => row[size]);
}

// Maps the unit square onto the quadrilateral: (u, v) in 0…1 becomes a point in the image.
// The corners are given clockwise from the top left.
function quadTransform(quad) {
  const rows = [];
  const unitCorners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  unitCorners.forEach(([u, v], corner) => {
    const { x, y } = quad[corner];
    rows.push([u, v, 1, 0, 0, 0, -x * u, -x * v, x]);
    rows.push([0, 0, 0, u, v, 1, -y * u, -y * v, y]);
  });
  const h = solve(rows);
  if (!h) return null;
  return (u, v) => ({
    x: (h[0] * u + h[1] * v + h[2]) / (h[6] * u + h[7] * v + 1),
    y: (h[3] * u + h[4] * v + h[5]) / (h[6] * u + h[7] * v + 1),
  });
}

// Flood-fills the dark blob that contains `start`, keeping the extreme corner pixels as it goes.
// Neighbours are visited left, right, up, down so that ties keep the pixel found first.
function darkBlob(gray, width, height, threshold, seen, start) {
  const queue = [start];
  let head = 0;
  seen[start] = 1;
  const corners = { topLeft: null, topRight: null, bottomRight: null, bottomLeft: null };
  while (head < queue.length) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    const point = { x, y };
    if (!corners.topLeft || x + y < corners.topLeft.x + corners.topLeft.y) corners.topLeft = point;
    if (!corners.bottomRight || x + y > corners.bottomRight.x + corners.bottomRight.y)
      corners.bottomRight = point;
    if (!corners.topRight || x - y > corners.topRight.x - corners.topRight.y)
      corners.topRight = point;
    if (!corners.bottomLeft || x - y < corners.bottomLeft.x - corners.bottomLeft.y)
      corners.bottomLeft = point;
    const neighbours = [
      x ? index - 1 : -1,
      x < width - 1 ? index + 1 : -1,
      y ? index - width : -1,
      y < height - 1 ? index + width : -1,
    ];
    for (const neighbour of neighbours)
      if (neighbour >= 0 && !seen[neighbour] && gray[neighbour] < threshold) {
        seen[neighbour] = 1;
        queue.push(neighbour);
      }
  }
  return { size: queue.length, corners };
}

function quadIsMarkerShaped(quad) {
  const edge = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const lengths = quad.map((point, i) => edge(point, quad[(i + 1) % 4]));
  const shortest = Math.min(...lengths);
  if (shortest < MIN_MARKER_EDGE) return false;
  return Math.max(...lengths) / shortest <= MAX_EDGE_RATIO;
}

// Reads the 6×6 cells inside the quad, each as the mean of nine samples.
function sampleGrid(toImage, gray, width, height, threshold) {
  const cells = [];
  for (let row = 0; row < MARKER_GRID; row++)
    for (let column = 0; column < MARKER_GRID; column++) {
      let sum = 0;
      for (const dy of CELL_SAMPLES)
        for (const dx of CELL_SAMPLES) {
          const point = toImage((column + 0.5 + dx) / MARKER_GRID, (row + 0.5 + dy) / MARKER_GRID);
          const x = clamp(Math.round(point.x), 0, width - 1);
          const y = clamp(Math.round(point.y), 0, height - 1);
          sum += gray[y * width + x];
        }
      cells.push(sum / (CELL_SAMPLES.length * CELL_SAMPLES.length) >= threshold ? 1 : 0);
    }
  return cells;
}

const isBorderCell = (index) =>
  index < MARKER_GRID ||
  index >= MARKER_GRID * (MARKER_GRID - 1) ||
  index % MARKER_GRID === 0 ||
  index % MARKER_GRID === MARKER_GRID - 1;

function innerBits(cells) {
  const bits = [];
  for (let row = 1; row <= MARKER_SIDE; row++)
    for (let column = 1; column <= MARKER_SIDE; column++)
      bits.push(cells[row * MARKER_GRID + column]);
  return bits;
}

// Finds dark four-sided blobs with a black border and reads the pattern inside each of them.
// Best match (fewest mismatching cells) first.
function detectMarkers(image, threshold = DEFAULT_THRESHOLD) {
  const { width, height } = image;
  const gray = grayPixels(image);
  const seen = new Uint8Array(width * height);
  const results = [];
  for (let start = 0; start < width * height; start++) {
    if (seen[start] || gray[start] >= threshold) continue;
    const blob = darkBlob(gray, width, height, threshold, seen, start);
    if (blob.size < MIN_MARKER_PIXELS || blob.size > width * height * MAX_MARKER_AREA) continue;
    const { topLeft, topRight, bottomRight, bottomLeft } = blob.corners;
    const quad = [topLeft, topRight, bottomRight, bottomLeft];
    if (!quadIsMarkerShaped(quad)) continue;
    const toImage = quadTransform(quad);
    if (!toImage) continue;
    const cells = sampleGrid(toImage, gray, width, height, threshold);
    // The border must be black all round, or this is not a marker.
    if (cells.some((cell, index) => isBorderCell(index) && cell)) continue;
    const bits = innerBits(cells);
    results.push({ ...decodeMarker(bits), bits, quad });
  }
  return results.sort((a, b) => a.errors - b.errors);
}

// ---- numbered tags next to detections --------------------------------------------------------------

const overlaps = (a, b, width, height, gap) =>
  !(
    a.x + width + gap <= b.x ||
    a.x >= b.x + b.w + gap ||
    a.y + height + gap <= b.y ||
    a.y >= b.y + b.h + gap
  );

// Places a compact numbered tag near each detection: just above its box when that fits, otherwise
// at the nearest free slot of a grid. A box gets no tag (null) when nothing is free.
function detectionTags(boxes, width, height) {
  const scale = Math.min(
    Math.max(TAG_MIN_SCALE, width / TAG_SCALE_WIDTH),
    height / TAG_HEIGHT_DIVISOR,
  );
  const tagWidth = Math.min(width, TAG_WIDTH * scale);
  const tagHeight = Math.min(height, TAG_HEIGHT * scale);
  const gap = TAG_GAP * scale;
  const placed = [];
  return boxes.map((box, index) => {
    const wanted = {
      x: clamp(box.x, 0, width - tagWidth),
      y: clamp(box.y - tagHeight, 0, height - tagHeight),
    };
    const candidates = [wanted];
    for (let y = 0; y <= height - tagHeight; y += tagHeight + gap)
      for (let x = 0; x <= width - tagWidth; x += tagWidth + gap) candidates.push({ x, y });
    const distance = (spot) => (spot.x - wanted.x) ** 2 + (spot.y - wanted.y) ** 2;
    candidates.sort((a, b) => distance(a) - distance(b));
    const spot = candidates.find((candidate) =>
      placed.every((tag) => !overlaps(candidate, tag, tagWidth, tagHeight, gap)),
    );
    if (!spot) return null;
    const tag = { ...spot, w: tagWidth, h: tagHeight, scale, number: index + 1 };
    placed.push(tag);
    return tag;
  });
}

export {
  grayPixels,
  imageOperation,
  imageFeatures,
  trainImageClassifier,
  classifyImage,
  ARUCO_CODES,
  markerBits,
  rotateBits,
  decodeMarker,
  quadTransform,
  detectMarkers,
  detectionTags,
};
