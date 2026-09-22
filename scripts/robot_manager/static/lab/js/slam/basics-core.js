// Maths of the sensor chapters (wheels, IMU, LiDAR) of the SLAM course. Small, deterministic
// examples that produce demonstration measurements only; the experiment's sensor logs are
// untouched. No DOM: importable from Node for the tests.

const TAU = 2 * Math.PI;
const WHEEL_DIAMETER = 0.13; // metres
const WHEEL_TRACK = 0.32; // metres between the left and right wheels
const SECONDS_PER_MINUTE = 60;
const PATH_SEGMENTS = 60; // points along a drawn arc, minus one
const NEAR_ZERO = 0.00001; // values closer to zero than this print as 0, never "-0.0"
const PARALLEL_RAY = 1e-9; // |cos| or |sin| below this: the ray never meets that wall
const SHIFTS_PER_METRE = 100; // matchBasicScan tries shifts 1 cm apart …
const SCAN_MATCH_STEPS = 120; // … up to 1.20 m

// Walls of the demonstration room, as distances from the robot's start (metres).
const DEMO_ROOM = { front: 2, back: -0.5, left: 1.5, right: -1 };

const snapToZero = (value) => (Math.abs(value) < NEAR_ZERO ? 0 : value);

// Fills `{name}` placeholders of a content sentence: fillText('約{shift} m', { shift: '0.60' }).
const fillText = (template, values) =>
  template.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));

// Straight-line or constant-curvature motion from two wheel speeds (rpm) over `seconds`.
// `grip` below 1 models wheels that spin partly in place. Distances in metres, angle in radians.
function wheelExample(leftRpm, rightRpm, seconds = 2, grip = 1) {
  const metresPerTurn = WHEEL_DIAMETER * Math.PI;
  const left = ((metresPerTurn * leftRpm * seconds) / SECONDS_PER_MINUTE) * grip;
  const right = ((metresPerTurn * rightRpm * seconds) / SECONDS_PER_MINUTE) * grip;
  const distance = (left + right) / 2;
  const angle = (right - left) / WHEEL_TRACK;
  const pointAt = (fraction) => arcPoint(distance, angle, fraction);
  return {
    left,
    right,
    distance,
    angle,
    ...pointAt(1),
    path: Array.from({ length: PATH_SEGMENTS + 1 }, (_, i) => pointAt(i / PATH_SEGMENTS)),
  };
}

// Position after travelling `fraction` of an arc of length `distance` that turns by `angle`.
function arcPoint(distance, angle, fraction) {
  if (Math.abs(angle) < 1e-9) return { x: distance * fraction, y: 0 };
  const radius = distance / angle;
  return {
    x: radius * Math.sin(angle * fraction),
    y: radius * (1 - Math.cos(angle * fraction)),
  };
}

// Turn in place at `rateDegreesPerSecond` for `seconds`, then drive `distance` metres straight.
function imuExample(rateDegreesPerSecond, seconds, distance) {
  const angle = (rateDegreesPerSecond * seconds * Math.PI) / 180;
  return { angle, x: distance * Math.cos(angle), y: distance * Math.sin(angle) };
}

// Where a LiDAR beam from `origin` at `angle` (radians, 0 = forward) meets the room walls.
// Returns the hit point relative to the origin, its range `r` and the angle `a`.
function beamHit(angle, origin = { x: 0, y: 0 }) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const wallAhead = c > 0 ? DEMO_ROOM.front : DEMO_ROOM.back;
  const wallBeside = s > 0 ? DEMO_ROOM.left : DEMO_ROOM.right;
  const toAheadWall = Math.abs(c) < PARALLEL_RAY ? Infinity : (wallAhead - origin.x) / c;
  const toBesideWall = Math.abs(s) < PARALLEL_RAY ? Infinity : (wallBeside - origin.y) / s;
  const r = Math.min(toAheadWall, toBesideWall);
  return { x: r * c, y: r * s, r, a: angle };
}

// A full scan of `count` evenly spaced beams from (x, y).
function basicsScan(x = 0, y = 0, count = 180) {
  return Array.from({ length: count }, (_, i) => beamHit((i * TAU) / count, { x, y }));
}

// Mean squared distance from each shifted scan point to its nearest reference point.
// Deliberately limited to one translation axis with a known heading, so learners can inspect
// the operation. The search uses measured points only, never the room bounds.
function scanMismatch(reference, scan, shift) {
  const nearestSquared = (point) =>
    Math.min(...reference.map((q) => (point.x + shift - q.x) ** 2 + (point.y - q.y) ** 2));
  const total = scan.reduce((sum, point) => sum + nearestSquared(point), 0);
  return total / scan.length;
}

function matchBasicScan(reference, scan) {
  let best = { shift: 0, error: Infinity };
  for (let step = 0; step <= SCAN_MATCH_STEPS; step++) {
    const shift = step / SHIFTS_PER_METRE;
    const error = scanMismatch(reference, scan, shift);
    if (error < best.error) best = { shift, error };
  }
  return best;
}

export {
  WHEEL_DIAMETER,
  WHEEL_TRACK,
  snapToZero,
  fillText,
  wheelExample,
  imuExample,
  beamHit,
  basicsScan,
  scanMismatch,
  matchBasicScan,
};
