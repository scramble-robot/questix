import { footprintCorners, ROBOT_DIMENSIONS } from './robot-dimensions.js';

const TAU = 2 * Math.PI;
const CONTACT_EPSILON = 1e-12; // metres, for roundoff at inclusive contact
const AXIS_ALIGNED = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
];

function rectangleCorners({ minX, minY, maxX, maxY }) {
  return [
    { x: minX, y: minY },
    { x: minX, y: maxY },
    { x: maxX, y: maxY },
    { x: maxX, y: minY },
  ];
}

function separatingAxes(theta) {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return [...AXIS_ALIGNED, { x: cos, y: sin }, { x: -sin, y: cos }];
}

function project(points, axis) {
  const values = points.map(({ x, y }) => x * axis.x + y * axis.y);
  return [Math.min(...values), Math.max(...values)];
}

/** SAT against a closed axis-aligned rectangle {minX, minY, maxX, maxY} in metres. */
export function footprintIntersectsRect(pose, rectangle, dimensions = ROBOT_DIMENSIONS) {
  const robot = footprintCorners(pose, dimensions);
  const obstacle = rectangleCorners(rectangle);
  return separatingAxes(pose.theta).every((axis) => {
    const [min, max] = project(robot, axis);
    const [otherMin, otherMax] = project(obstacle, axis);
    return min <= otherMax + CONTACT_EPSILON && otherMin <= max + CONTACT_EPSILON;
  });
}

/** Test the closed swept rectangle from start to end {x, y}, keeping start.theta fixed. */
export function footprintIntersectsDuringTranslation(
  start,
  end,
  rectangle,
  dimensions = ROBOT_DIMENSIONS,
) {
  const robot = footprintCorners(start, dimensions);
  const obstacle = rectangleCorners(rectangle);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let enter = 0;
  let leave = 1;
  // On each SAT axis, find the time interval in which the projections overlap.
  for (const axis of separatingAxes(start.theta)) {
    const [min, max] = project(robot, axis);
    const [otherMin, otherMax] = project(obstacle, axis);
    const lower = otherMin - max - CONTACT_EPSILON;
    const upper = otherMax - min + CONTACT_EPSILON;
    const speed = dx * axis.x + dy * axis.y;
    if (speed === 0) {
      if (lower > 0 || upper < 0) return false;
      continue;
    }
    const first = lower / speed;
    const last = upper / speed;
    enter = Math.max(enter, Math.min(first, last));
    leave = Math.min(leave, Math.max(first, last));
    if (enter > leave) return false;
  }
  return true;
}

function crossesEdge(a, b, offset, from, to, intersects) {
  // Solve a cos(theta) + b sin(theta) = offset for the edge's supporting line.
  const radius = Math.hypot(a, b);
  if (radius === 0 || Math.abs(offset) > radius + CONTACT_EPSILON) return false;
  const phase = Math.atan2(b, a);
  const delta = Math.acos(Math.max(-1, Math.min(1, offset / radius)));
  return [phase - delta, phase + delta].some((base) => {
    const theta = base + TAU * Math.ceil((from - base) / TAU);
    return theta <= to && intersects(theta);
  });
}

/**
 * Test an in-place rotation from pose.theta to endTheta in radians. Use unwrapped
 * angles to choose the arc. First contact lies at a vertex on an edge, so test
 * those angles with SAT, including tangencies, and test both endpoints.
 */
export function footprintIntersectsDuringRotation(
  pose,
  endTheta,
  rectangle,
  dimensions = ROBOT_DIMENSIONS,
) {
  const from = Math.min(pose.theta, endTheta);
  const to = Math.min(Math.max(pose.theta, endTheta), from + TAU);
  const intersects = (theta) => footprintIntersectsRect({ ...pose, theta }, rectangle, dimensions);
  if (intersects(from) || intersects(to)) return true;

  const robot = footprintCorners({ x: 0, y: 0, theta: 0 }, dimensions);
  const { minX, maxX, minY, maxY } = rectangle;
  for (const { x, y } of robot) {
    // Rotating robot vertices against the obstacle's fixed edge lines.
    if ([minX, maxX].some((edge) => crossesEdge(x, -y, edge - pose.x, from, to, intersects)))
      return true;
    if ([minY, maxY].some((edge) => crossesEdge(y, x, edge - pose.y, from, to, intersects)))
      return true;
  }

  const { front, rear, left, right } = dimensions.footprint;
  for (const corner of rectangleCorners(rectangle)) {
    // In the rotating frame, obstacle vertices rotate by the negative heading.
    const x = corner.x - pose.x;
    const y = corner.y - pose.y;
    if ([-rear, front].some((edge) => crossesEdge(x, y, edge, from, to, intersects))) return true;
    if ([-right, left].some((edge) => crossesEdge(y, -x, edge, from, to, intersects))) return true;
  }
  return false;
}
