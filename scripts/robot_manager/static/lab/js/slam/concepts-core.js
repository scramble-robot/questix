// Maths of the concept chapters of the SLAM course: coordinate frames, simulated LiDAR
// measurements, occupancy mapping, localization on a known map, and a translation-only pose graph.
// Every estimator works from measurements, never from a reference pose. No DOM: importable from
// Node for the tests.

const PARALLEL = 1e-9; // a beam whose denominator is this small runs along the wall
const ON_SEGMENT = 1e-9; // tolerance for a hit sitting just off the end of a wall segment
const AHEAD = 1e-6; // metres: closer than this is the wall the beam starts on, not a new one
const SINGULAR = 1e-12; // a pivot this small means the pose graph has nothing to anchor it

// The point, measured from the robot, placed on the map.
function pointInWorld(point, pose) {
  const c = Math.cos(pose.theta);
  const s = Math.sin(pose.theta);
  return { x: pose.x + c * point.x - s * point.y, y: pose.y + s * point.x + c * point.y };
}

// The map point as the robot at `pose` sees it: x ahead of the robot, y to its left.
function pointInRobot(point, pose) {
  const dx = point.x - pose.x;
  const dy = point.y - pose.y;
  const c = Math.cos(pose.theta);
  const s = Math.sin(pose.theta);
  return { x: c * dx + s * dy, y: -s * dx + c * dy };
}

// Every wall of the scene as a segment [x1, y1, x2, y2]: the four outer walls, then each obstacle.
function roomSegments(scene) {
  const segments = [
    [0, 0, scene.width, 0],
    [scene.width, 0, scene.width, scene.height],
    [scene.width, scene.height, 0, scene.height],
    [0, scene.height, 0, 0],
  ];
  for (const box of scene.obstacles || []) {
    const left = box.x;
    const bottom = box.y;
    const right = box.x + box.w;
    const top = box.y + box.h;
    segments.push(
      [left, bottom, right, bottom],
      [right, bottom, right, top],
      [right, top, left, top],
      [left, top, left, bottom],
    );
  }
  return segments;
}

// One turn of a simulated LiDAR: `count` beams spread evenly around `pose`. Each reading carries
// the beam's angle in the robot's frame (`a`, radians), its `range` in metres, and whether it met
// a wall at all — a beam that reached `rangeMax` first reports that distance with `hit` false.
function measureRoom(scene, pose, count = 120, rangeMax = 6) {
  const segments = roomSegments(scene);
  return Array.from({ length: count }, (_, beam) => {
    const a = (beam * Math.PI * 2) / count;
    const dx = Math.cos(pose.theta + a);
    const dy = Math.sin(pose.theta + a);
    let range = rangeMax;
    let hit = false;
    for (const [x1, y1, x2, y2] of segments) {
      const wallX = x2 - x1;
      const wallY = y2 - y1;
      const denominator = dx * wallY - dy * wallX;
      if (Math.abs(denominator) < PARALLEL) continue;
      const toWallX = x1 - pose.x;
      const toWallY = y1 - pose.y;
      const along = (toWallX * wallY - toWallY * wallX) / denominator; // metres along the beam
      const across = (toWallX * dy - toWallY * dx) / denominator; // 0…1 along the wall segment
      if (along > AHEAD && along < range && across >= -ON_SEGMENT && across <= 1 + ON_SEGMENT) {
        range = along;
        hit = true;
      }
    }
    return { a, range, hit };
  });
}

const MAPPING_ROOM = { width: 4.8, height: 3.2, obstacles: [{ x: 2, y: 1, w: 0.6, h: 1.2 }] };
const MAPPING_POSES = [
  { x: 0.7, y: 0.7, theta: 0 },
  { x: 4.1, y: 0.7, theta: Math.PI / 2 },
  { x: 4.1, y: 2.6, theta: Math.PI },
  { x: 0.7, y: 2.6, theta: -Math.PI / 2 },
];

// Evidence for and against a cell being occupied, in log-odds.
const FREE_VOTE = -0.7;
const OCCUPIED_VOTE = 1.2;
const VOTE_FLOOR = -4;
const VOTE_CEILING = 4;
const OCCUPIED_ABOVE = 0.4;
const FREE_BELOW = -0.3;
const SAMPLES_PER_CELL = 4; // how finely a beam is walked while marking the cells it crosses

function cellType(measured, score) {
  if (!measured) return 'unknown';
  if (score > OCCUPIED_ABOVE) return 'occupied';
  if (score < FREE_BELOW) return 'free';
  return 'uncertain';
}

// Turns scans taken from known poses into a grid of 'free' / 'occupied' / 'uncertain' / 'unknown'.
function occupancyFromScans(frames, { width = 4.8, height = 3.2, resolution = 0.1 } = {}) {
  const columns = Math.ceil(width / resolution);
  const rows = Math.ceil(height / resolution);
  const score = new Float64Array(columns * rows);
  const measured = new Uint8Array(columns * rows);
  const clamp = (metres, cells) =>
    Math.max(0, Math.min(cells - 1, Math.floor(metres / resolution)));
  const cellAt = (x, y) => clamp(y, rows) * columns + clamp(x, columns);
  for (const frame of frames) {
    const free = new Set();
    const occupied = new Set();
    for (const ray of frame.scan) {
      const angle = frame.pose.theta + ray.a;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const end = cellAt(frame.pose.x + ray.range * dx, frame.pose.y + ray.range * dy);
      for (let travelled = 0; travelled < ray.range; travelled += resolution / SAMPLES_PER_CELL) {
        const cell = cellAt(frame.pose.x + travelled * dx, frame.pose.y + travelled * dy);
        if (!ray.hit || cell !== end) free.add(cell);
      }
      if (ray.hit) occupied.add(end);
    }
    // One vote per cell per scan; a measured surface overrides traversing rays.
    for (const cell of free)
      if (!occupied.has(cell)) {
        measured[cell] = 1;
        score[cell] = Math.max(VOTE_FLOOR, score[cell] + FREE_VOTE);
      }
    for (const cell of occupied) {
      measured[cell] = 1;
      score[cell] = Math.min(VOTE_CEILING, score[cell] + OCCUPIED_VOTE);
    }
  }
  const cells = Array.from(measured, (flag, cell) => cellType(flag, score[cell]));
  return {
    w: columns,
    h: rows,
    resolution,
    cells,
    known: cells.filter((cell) => cell === 'occupied' || cell === 'free').length,
    total: cells.length,
  };
}

// A long corridor that looks the same everywhere, unless a piece of equipment is put in it.
function localizationRoom(feature = false) {
  return {
    width: 8, // metres
    height: 2.4,
    obstacles: feature ? [{ x: 4.6, y: 0.15, w: 0.35, h: 0.7 }] : [],
  };
}

// Root-mean-square difference, in metres, between two scans of the same beam directions.
function rangeMismatch(observed, predicted) {
  const squares = observed.reduce((sum, ray, i) => sum + (ray.range - predicted[i].range) ** 2, 0);
  return Math.sqrt(squares / observed.length);
}

const FIRST_CANDIDATE = 0.7; // metres along the corridor
const CANDIDATE_STEP = 0.1; // metres
const CANDIDATE_COUNT = 67; // 0.7 m up to 7.3 m
const PLAUSIBLE_BAND = 0.018; // metres of extra mismatch still counted as fitting the measurement

// Scores every place along the corridor against one scan. `plausible` is the set that fits nearly
// as well as the best one — when it is wide, the measurement cannot decide where the robot is.
function localizeOnKnownMap(observed, scene, { y = 1.2, theta = 0, rangeMax = 2 } = {}) {
  const candidates = Array.from({ length: CANDIDATE_COUNT }, (_, step) => {
    const x = FIRST_CANDIDATE + step * CANDIDATE_STEP;
    const predicted = measureRoom(scene, { x, y, theta }, observed.length, rangeMax);
    return { x, error: rangeMismatch(observed, predicted) };
  });
  const best = Math.min(...candidates.map((candidate) => candidate.error));
  const plausible = candidates.filter((candidate) => candidate.error < best + PLAUSIBLE_BAND);
  return { candidates, best, plausible };
}

// Gauss-Jordan elimination with partial pivoting; throws when the system has no single answer.
function solveLinear(matrix, right) {
  const size = right.length;
  const rows = matrix.map((row, i) => [...row, right[i]]);
  for (let k = 0; k < size; k++) {
    let pivot = k;
    for (let j = k + 1; j < size; j++)
      if (Math.abs(rows[j][k]) > Math.abs(rows[pivot][k])) pivot = j;
    [rows[k], rows[pivot]] = [rows[pivot], rows[k]];
    if (Math.abs(rows[k][k]) < SINGULAR) throw Error('位置を固定する基準が必要です');
    const scale = rows[k][k];
    for (let j = k; j <= size; j++) rows[k][j] /= scale;
    for (let i = 0; i < size; i++)
      if (i !== k) {
        const factor = rows[i][k];
        for (let j = k; j <= size; j++) rows[i][j] -= factor * rows[k][j];
      }
  }
  return rows.map((row) => row[size]);
}

// Translation-only weighted least squares over the pose graph. Heading is assumed known, and the
// first pose is held at the origin so that one answer fits.
function poseGraphOptimize(count, edges) {
  const unknowns = count - 1;
  const matrix = Array.from({ length: unknowns }, () => Array(unknowns).fill(0));
  const rightX = Array(unknowns).fill(0);
  const rightY = Array(unknowns).fill(0);
  for (const edge of edges) {
    // The fixed first pose is not an unknown, so it drops out of the equations.
    const terms = [
      [edge.from, -1],
      [edge.to, 1],
    ].filter(([node]) => node > 0);
    const weight = edge.weight || 1;
    for (const [node, sign] of terms) {
      for (const [other, otherSign] of terms)
        matrix[node - 1][other - 1] += weight * sign * otherSign;
      rightX[node - 1] += weight * sign * edge.dx;
      rightY[node - 1] += weight * sign * edge.dy;
    }
  }
  const x = solveLinear(matrix, rightX);
  const y = solveLinear(matrix, rightY);
  return [{ x: 0, y: 0 }, ...x.map((value, i) => ({ x: value, y: y[i] }))];
}

const LAP_CORNERS = [
  [0, 0],
  [1, 0],
  [2, 0],
  [3, 0],
  [3, 1],
  [3, 2],
  [2, 2],
  [1, 2],
  [0, 2],
  [0, 1],
  [0, 0],
];
const LAP_STEP = 0.8; // metres between two recorded poses of the demonstration lap
const LAP_DRIFT = { dx: 0.04, dy: 0.025 }; // metres of error in every measured step
const LAP_OFFSET = 0.8; // metres: the lap sits this far inside the demonstration room
const LAP_SCAN_RAYS = 60;
const LAP_SCAN_RANGE = 5; // metres

// A recorded lap back to its starting point, with a small error in every measured step, plus the
// scan taken at each pose. `before` is the track the measurements alone produce.
function loopFixture() {
  const reference = LAP_CORNERS.map(([x, y]) => ({ x: x * LAP_STEP, y: y * LAP_STEP }));
  const edges = reference.slice(1).map((point, i) => ({
    from: i,
    to: i + 1,
    dx: point.x - reference[i].x + LAP_DRIFT.dx,
    dy: point.y - reference[i].y + LAP_DRIFT.dy,
    weight: 1,
  }));
  const before = [{ x: 0, y: 0 }];
  for (const edge of edges)
    before.push({ x: before.at(-1).x + edge.dx, y: before.at(-1).y + edge.dy });
  const scans = reference.map((point) =>
    measureRoom(
      MAPPING_ROOM,
      { x: point.x + LAP_OFFSET, y: point.y + LAP_OFFSET, theta: 0 },
      LAP_SCAN_RAYS,
      LAP_SCAN_RANGE,
    ),
  );
  return { edges, before, scans };
}

const CLOSURE_WEIGHT = 30; // "these two poses are the same place" counts far more than one step

// Adds the closure "the last pose is `matchNode` again" and solves the whole track once more.
// `gap` is what is left between those two poses, `moveResidual` how much the measured steps had to
// be rewritten to get there — a wrong `matchNode` closes the gap but wrecks the steps.
function closeLoop(fixture, matchNode = 0, weight = CLOSURE_WEIGHT) {
  const last = fixture.before.length - 1;
  const closure = { from: matchNode, to: last, dx: 0, dy: 0, weight };
  const after = poseGraphOptimize(last + 1, [...fixture.edges, closure]);
  const squares = fixture.edges.reduce(
    (sum, edge) =>
      sum +
      (after[edge.to].x - after[edge.from].x - edge.dx) ** 2 +
      (after[edge.to].y - after[edge.from].y - edge.dy) ** 2,
    0,
  );
  return {
    after,
    moveResidual: Math.sqrt(squares / fixture.edges.length),
    gap: Math.hypot(after[last].x - after[matchNode].x, after[last].y - after[matchNode].y),
  };
}

export {
  pointInWorld,
  pointInRobot,
  roomSegments,
  measureRoom,
  MAPPING_ROOM,
  MAPPING_POSES,
  occupancyFromScans,
  localizationRoom,
  rangeMismatch,
  localizeOnKnownMap,
  poseGraphOptimize,
  loopFixture,
  closeLoop,
};
