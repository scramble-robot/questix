import { scanMount } from '../live/capture-core.js';
import { PLAN_ROBOT } from './core.js';

// A planning map built from what the real robot measured: LiDAR scans placed with the wheel
// odometry (/odom) of the same moment. No DOM; covered by test/planning-room.test.mjs.
//
// The map is a grid of occupied cells, merged row by row into the rectangles the planner already
// understands, inside the same 6 m × 4 m frame the other topics use. Where the robot was is the
// start, where it stopped is the goal, and the path it was driven along is kept to compare with the
// planned one. Placing scans by odometry alone drifts over a long drive (the SLAM course is about
// exactly that), so a short, slow drive gives the best map.

const ROOM_CELL = 0.1; // m, the planner's own grid step
const ROOM_SIZE = { width: 6, height: 4 }; // m, the drawing frame of the course
const MIN_HITS = 2; // a cell counts as occupied once this many beams ended in it
const MIN_SCANS = 3; // fewer scans than this are not a map
const MAX_RANGE = 6; // m: beyond this a LiDAR hit is too uncertain to place

const COLUMNS = Math.round(ROOM_SIZE.width / ROOM_CELL);
const ROWS = Math.round(ROOM_SIZE.height / ROOM_CELL);

// Beam end points of one scan in the odometry frame (x forward, y left at the start).
function scanPoints(scan, pose) {
  const mount = scanMount(scan);
  const cos = Math.cos(pose.theta);
  const sin = Math.sin(pose.theta);
  const points = [];
  scan.ranges.forEach((range, index) => {
    if (range === null || !Number.isFinite(range) || range > MAX_RANGE) return;
    const angle = mount.yaw + scan.angle_min + index * scan.angle_increment;
    const x = mount.x + range * Math.cos(angle);
    const y = mount.y + range * Math.sin(angle);
    points.push({ x: pose.x + x * cos - y * sin, y: pose.y + x * sin + y * cos });
  });
  return points;
}

// The 6 m × 4 m window, centred on the part of the room the robot drove through. The course draws
// y downwards, so the odometry's y (left) is flipped: up on screen is left of the start heading.
function roomWindow(poses) {
  const xs = poses.map((pose) => pose.x);
  const ys = poses.map((pose) => pose.y);
  const centreX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centreY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const left = centreX - ROOM_SIZE.width / 2;
  const top = centreY + ROOM_SIZE.height / 2;
  return {
    toMap: (point) => ({ x: point.x - left, y: top - point.y }),
    tooLarge:
      Math.max(...xs) - Math.min(...xs) > ROOM_SIZE.width ||
      Math.max(...ys) - Math.min(...ys) > ROOM_SIZE.height,
  };
}

const inside = (point) =>
  point.x >= 0 && point.y >= 0 && point.x < ROOM_SIZE.width && point.y < ROOM_SIZE.height;
const cellOf = (point) =>
  Math.floor(point.y / ROOM_CELL) * COLUMNS + Math.floor(point.x / ROOM_CELL);

// Cells the robot's body passed over were free at that moment, whatever a later beam (a person
// walking by) says about them.
function clearDrivenCells(occupied, trajectory) {
  const reach = Math.ceil(PLAN_ROBOT.radius / ROOM_CELL);
  for (const pose of trajectory) {
    const column = Math.floor(pose.x / ROOM_CELL);
    const row = Math.floor(pose.y / ROOM_CELL);
    for (let dy = -reach; dy <= reach; dy += 1)
      for (let dx = -reach; dx <= reach; dx += 1) {
        const x = column + dx;
        const y = row + dy;
        const centre = { x: (x + 0.5) * ROOM_CELL, y: (y + 0.5) * ROOM_CELL };
        if (x < 0 || y < 0 || x >= COLUMNS || y >= ROWS) continue;
        if (Math.hypot(centre.x - pose.x, centre.y - pose.y) <= PLAN_ROBOT.radius)
          occupied[y * COLUMNS + x] = 0;
      }
  }
}

// Consecutive occupied cells of a row become one rectangle, so a wall is one obstacle, not sixty.
// `occupied` is a row-major grid of `columns` × `rows` cells of `cell` metres, row 0 at the top.
function gridRectangles(occupied, columns = COLUMNS, rows = ROWS, cell = ROOM_CELL) {
  const rectangles = [];
  for (let row = 0; row < rows; row += 1) {
    let start = -1;
    for (let column = 0; column <= columns; column += 1) {
      const filled = column < columns && occupied[row * columns + column];
      if (filled && start < 0) start = column;
      if (filled || start < 0) continue;
      rectangles.push({
        x: start * cell,
        y: row * cell,
        w: (column - start) * cell,
        h: cell,
        measured: true,
      });
      start = -1;
    }
  }
  return rectangles;
}

const roundPose = (pose) => ({
  x: Number(pose.x.toFixed(2)),
  y: Number(pose.y.toFixed(2)),
});

/**
 * A planning map from `samples` = `[{scan, odom}]` (each scan with the odometry of that moment).
 * Returns `{map, trajectory, scans, outside, tooLarge}` — `outside` counts beam ends that fell
 * outside the 6 m × 4 m window — or null when there are too few scans to call it a map.
 */
function measuredRoom(samples) {
  const usable = samples.filter(
    (sample) =>
      sample.scan &&
      sample.odom &&
      [sample.odom.x, sample.odom.y, sample.odom.theta].every(Number.isFinite),
  );
  if (usable.length < MIN_SCANS) return null;
  const window = roomWindow(usable.map((sample) => sample.odom));
  const hits = new Uint16Array(COLUMNS * ROWS);
  let outside = 0;
  for (const { scan, odom } of usable)
    for (const point of scanPoints(scan, odom)) {
      const onMap = window.toMap(point);
      if (inside(onMap)) hits[cellOf(onMap)] += 1;
      else outside += 1;
    }
  const occupied = hits.map((count) => (count >= MIN_HITS ? 1 : 0));
  const trajectory = usable.map((sample) => window.toMap(sample.odom)).filter(inside);
  clearDrivenCells(occupied, trajectory);
  const start = trajectory[0] ?? { x: ROOM_SIZE.width / 2, y: ROOM_SIZE.height / 2 };
  const goal = trajectory[trajectory.length - 1] ?? start;
  return {
    map: {
      ...ROOM_SIZE,
      start: roundPose(start),
      goal: roundPose(goal),
      obstacles: gridRectangles(occupied),
      measured: true,
    },
    trajectory: trajectory.map(roundPose),
    scans: usable.length,
    outside,
    tooLarge: window.tooLarge,
  };
}

export { ROOM_CELL, ROOM_SIZE, MIN_HITS, gridRectangles, scanPoints, measuredRoom };
