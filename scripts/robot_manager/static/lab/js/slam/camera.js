import { depthColor, invalidDepthColor } from '../core/depth-core.js';
import { loadJson } from '../core/content.js';

// Display-only RGB-D model. The SLAM estimator never receives this geometry.
// World: x/y on the floor, z up; positive yaw/bearing is left, image x is right.

const copy = await loadJson('content/slam/camera.json');

const SLAM_CAMERA = {
  fov: Math.PI / 2,
  height: 0.24, // m above the floor
  forward: 0.12, // m ahead of the centre of the robot
  wallHeight: 1.1, // m; walls are drawn this tall
  markerSize: 0.32, // m; the printed square on the floor at the start position
};
const NEAR_PLANE = 0.015; // m; nothing closer is projected
const ROOM_WALL_COUNT = 4; // the first rects of a scene are the room; the rest are shelves

// A scene as axis-aligned [x0, y0, x1, y1] boxes: four walls around the room, then the shelves.
function slamSceneRects(scene) {
  const { width, height, walls = [] } = scene;
  return [
    [-1, -1, 0, height + 1],
    [width, -1, width + 1, height + 1],
    [-1, -1, width + 1, 0],
    [-1, height, width + 1, height + 1],
    ...walls.map((wall) => [wall.x, wall.y, wall.x + wall.w, wall.y + wall.h]),
  ];
}

// Slab intersection; `side` is the axis (0 = x, 1 = y) whose face the ray enters through, which
// is what shades the two visible sides of a box differently.
function hitRect(origin, angle, rect) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let near = -Infinity;
  let far = Infinity;
  let side = 0;
  for (const [axis, start, direction, low, high] of [
    [0, origin.x, dx, rect[0], rect[2]],
    [1, origin.y, dy, rect[1], rect[3]],
  ]) {
    if (Math.abs(direction) < 1e-10) {
      if (start < low || start > high) return null;
    } else {
      const t0 = (low - start) / direction;
      const t1 = (high - start) / direction;
      const entry = Math.min(t0, t1);
      if (entry > near) {
        near = entry;
        side = axis;
      }
      far = Math.min(far, Math.max(t0, t1));
    }
  }
  if (far < Math.max(near, 0) || near < 0) return null;
  return { distance: near, side };
}

// The first surface a ray meets, and whether it belongs to a shelf rather than a room wall.
function cameraRay(rects, origin, angle) {
  let best = null;
  rects.forEach((rect, index) => {
    const hit = hitRect(origin, angle, rect);
    if (hit && (!best || hit.distance < best.distance))
      best = { ...hit, shelf: index >= ROOM_WALL_COUNT };
  });
  return best;
}

// Pinhole camera at the robot's pose, in image pixels.
function cameraView(pose, width = 800, height = 320) {
  const { forward, fov } = SLAM_CAMERA;
  return {
    x: pose.x + forward * Math.cos(pose.theta),
    y: pose.y + forward * Math.sin(pose.theta),
    theta: pose.theta,
    width,
    height,
    focal: width / (2 * Math.tan(fov / 2)),
    horizon: height * 0.42,
  };
}

// World point to image pixel, or null when it is behind the camera.
function cameraProject(view, point) {
  const dx = point.x - view.x;
  const dy = point.y - view.y;
  const depth = dx * Math.cos(view.theta) + dy * Math.sin(view.theta);
  const left = -dx * Math.sin(view.theta) + dy * Math.cos(view.theta);
  if (depth <= NEAR_PLANE) return null;
  return {
    x: view.width / 2 - (view.focal * left) / depth,
    y: view.horizon - (view.focal * ((point.z || 0) - SLAM_CAMERA.height)) / depth,
    depth,
  };
}

// The floor point seen at an image pixel; pixels at or above the horizon see no floor.
function cameraGroundPoint(view, x, y) {
  if (y <= view.horizon) return null;
  const depth = (SLAM_CAMERA.height * view.focal) / (y - view.horizon);
  const right = (x - view.width / 2) / view.focal;
  return {
    x: view.x + depth * (Math.cos(view.theta) + right * Math.sin(view.theta)),
    y: view.y + depth * (Math.sin(view.theta) - right * Math.cos(view.theta)),
    depth,
  };
}

// Where the start marker is, as the camera would see it: used by the sensor log, not by SLAM.
function slamCameraObservation(scene, pose) {
  const view = cameraView(pose);
  const marker = scene.start;
  const dx = marker.x - view.x;
  const dy = marker.y - view.y;
  const angle = Math.atan2(dy, dx);
  const distance = Math.hypot(dx, dy);
  const bearing = Math.atan2(Math.sin(angle - pose.theta), Math.cos(angle - pose.theta));
  const projected = cameraProject(view, { ...marker, z: 0 });
  const hit = cameraRay(slamSceneRects(scene), view, angle);
  const inFrame =
    Boolean(projected) &&
    projected.x >= 0 &&
    projected.x <= view.width &&
    projected.y >= 0 &&
    projected.y <= view.height;
  // A shelf between the camera and the marker hides it.
  const visible = inFrame && (!hit || hit.distance >= distance - 0.01);
  return { visible, marker: 'START', bearing, distance };
}

const DEPTH_MIN = 0.25; // m, the teaching range of the depth image
const DEPTH_MAX = 5; // m

const inDepthRange = (depth) => depth >= DEPTH_MIN && depth <= DEPTH_MAX;

// Depth (distance along the camera axis) at an image pixel, or null outside the usable range.
function slamDepthAt(scene, pose, x, y, width = 800, height = 320) {
  const view = cameraView(pose, width, height);
  const offset = Math.atan((x - width / 2) / view.focal);
  const hit = cameraRay(slamSceneRects(scene), view, view.theta - offset);
  if (hit) {
    const z = hit.distance * Math.cos(offset);
    const top = view.horizon - ((SLAM_CAMERA.wallHeight - SLAM_CAMERA.height) * view.focal) / z;
    const bottom = view.horizon + (SLAM_CAMERA.height * view.focal) / z;
    if (y >= top && y <= bottom) return inDepthRange(z) ? z : null;
  }
  const ground = cameraGroundPoint(view, x, y);
  return ground && inDepthRange(ground.depth) ? ground.depth : null;
}

// --- Drawing --------------------------------------------------------------------------------------

const DEPTH_CELL = 5; // image pixels sampled per depth square
const FLOOR_CELL = 3; // image pixels per floor square
const WALL_STRIP = 2; // image pixels between wall rays
const TILE_SIZE = 0.5; // m; the floor is drawn as tiles of this size
const GRID_LINE = 0.014; // m; the painted line between tiles
const MARKER_CELLS = 7; // the start marker is a 7×7 pattern
const FLOOR_SHADE = { grid: 76, light: 66, dark: 62 };
const MARKER_LIGHT = '#f0d38e';
const MARKER_INK = '#1c3139';

function drawUnavailable(context, width, height) {
  context.fillStyle = '#46636e';
  context.textAlign = 'center';
  context.font = '21px system-ui';
  context.fillText(copy.unavailableTitle, width / 2, height / 2 - 8);
  context.font = '15px system-ui';
  context.fillText(copy.unavailableNote, width / 2, height / 2 + 24);
}

function drawBadge(context, text, box) {
  context.fillStyle = box.background;
  context.fillRect(box.x, box.y, box.width, box.height);
  context.fillStyle = box.color;
  context.font = '15px system-ui';
  context.textAlign = 'left';
  context.fillText(text, box.textX, box.textY);
}

function drawDepthImage(context, scene, pose, width, height) {
  for (let y = 0; y < height; y += DEPTH_CELL)
    for (let x = 0; x < width; x += DEPTH_CELL) {
      const depth = slamDepthAt(scene, pose, x + DEPTH_CELL / 2, y + DEPTH_CELL / 2, width, height);
      // No depth: the same diagonal hatch as the vision course, one cell per hatch step.
      const color =
        depth === null ? invalidDepthColor(x / DEPTH_CELL, y / DEPTH_CELL) : depthColor(depth);
      context.fillStyle = 'rgb(' + color.join(',') + ')';
      context.fillRect(x, y, DEPTH_CELL + 1, DEPTH_CELL + 1);
    }
  drawBadge(context, copy.depthBadge, {
    x: 12,
    y: 12,
    width: 180,
    height: 32,
    background: '#102b35e8',
    color: '#e6eff3',
    textX: 24,
    textY: 34,
  });
}

// Which of the two tile shades a floor point falls on, or the line between tiles.
function floorShade(point) {
  const acrossTile = ((point.x % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
  const alongTile = ((point.y % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
  if (acrossTile < GRID_LINE || alongTile < GRID_LINE) return FLOOR_SHADE.grid;
  const even = (Math.floor(point.x / TILE_SIZE) + Math.floor(point.y / TILE_SIZE)) % 2 === 0;
  return even ? FLOOR_SHADE.light : FLOOR_SHADE.dark;
}

// The printed marker at the start position, as a fixed 7×7 pattern with a light border.
function markerColor(point, start) {
  const half = SLAM_CAMERA.markerSize / 2;
  const across = (point.x - start.x + half) / SLAM_CAMERA.markerSize;
  const along = (point.y - start.y + half) / SLAM_CAMERA.markerSize;
  if (across < 0 || across >= 1 || along < 0 || along >= 1) return null;
  const column = Math.floor(across * MARKER_CELLS);
  const row = Math.floor(along * MARKER_CELLS);
  const border = column === 0 || row === 0 || column === 6 || row === 6;
  const ink = (column < 3 && row < 3) || (column > 3 && row > 3) || (column === 4 && row === 2);
  return border || !ink ? MARKER_LIGHT : MARKER_INK;
}

// Project the floor in world coordinates, including the physical start marker.
// This gives translation/rotation cues without inventing a recorded image.
function drawFloor(context, view, start, width, height) {
  for (let y = Math.ceil(view.horizon) + 1; y < height; y += FLOOR_CELL)
    for (let x = 0; x < width; x += FLOOR_CELL) {
      const point = cameraGroundPoint(view, x + FLOOR_CELL / 2, y + FLOOR_CELL / 2);
      const shade = floorShade(point);
      context.fillStyle = `rgb(${shade},${shade + 17},${shade + 20})`;
      const marker = markerColor(point, start);
      if (marker) context.fillStyle = marker;
      context.fillRect(x, y, FLOOR_CELL + 1, FLOOR_CELL + 1);
    }
}

// A pinhole ray for each strip: positive image x looks to the robot's right.
// Walls are painted over the floor, so shelves occlude the marker naturally.
function drawWalls(context, view, rects, width) {
  for (let x = 0; x < width; x += WALL_STRIP) {
    const offset = Math.atan((x + 1 - width / 2) / view.focal);
    const hit = cameraRay(rects, view, view.theta - offset);
    if (!hit) continue;
    const depth = Math.max(0.02, hit.distance * Math.cos(offset));
    const top = view.horizon - ((SLAM_CAMERA.wallHeight - SLAM_CAMERA.height) * view.focal) / depth;
    const bottom = view.horizon + (SLAM_CAMERA.height * view.focal) / depth;
    const shade = Math.round(94 / (1 + depth * 0.13) + (hit.side ? 14 : 0));
    const tint = hit.shelf ? [0, 11, 18] : [18, 23, 24];
    // Slight overlap prevents antialiasing seams when the responsive canvas scales.
    context.fillStyle = `rgb(${shade + tint[0]},${shade + tint[1]},${shade + tint[2]})`;
    context.fillRect(x, top, 3, bottom - top);
    context.fillStyle = hit.shelf ? '#607b89' : '#91a3a8';
    context.fillRect(x, bottom - 2, 3, 2);
  }
}

function drawCrosshair(context, view, width) {
  context.strokeStyle = '#dcecf17a';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(width / 2 - 6, view.horizon);
  context.lineTo(width / 2 + 6, view.horizon);
  context.moveTo(width / 2, view.horizon - 6);
  context.lineTo(width / 2, view.horizon + 6);
  context.stroke();
}

function drawRgbImage(context, view, scene, rects, width, height) {
  context.fillStyle = '#59717c';
  context.fillRect(0, 0, width, view.horizon);
  context.fillStyle = '#3e545c';
  context.fillRect(0, view.horizon, width, height - view.horizon);
  drawFloor(context, view, scene.start, width, height);
  drawWalls(context, view, rects, width);
  drawBadge(context, copy.rgbBadge, {
    x: 14,
    y: 12,
    width: 310,
    height: 33,
    background: '#102b35d9',
    color: '#e1eef1',
    textX: 25,
    textY: 34,
  });
  drawCrosshair(context, view, width);
}

// `mode` is rgb or depth. A log recorded on a real robot carries no image, so it says so.
function drawSlamCamera(context, log, index, width = 800, height = 320, mode = 'rgb') {
  context.save();
  context.fillStyle = '#edf3f5';
  context.fillRect(0, 0, width, height);
  const reference = log.reference?.[index];
  if (log.source !== 'simulation' || !log.scene || !reference) {
    drawUnavailable(context, width, height);
    context.restore();
    return;
  }
  const scene = log.scene;
  const pose = {
    x: scene.start.x + reference.x,
    y: scene.start.y + reference.y,
    theta: reference.theta,
  };
  const view = cameraView(pose, width, height);
  if (mode === 'depth') drawDepthImage(context, scene, pose, width, height);
  else drawRgbImage(context, view, scene, slamSceneRects(scene), width, height);
  context.restore();
}

export {
  SLAM_CAMERA,
  slamSceneRects,
  cameraRay,
  cameraView,
  cameraProject,
  cameraGroundPoint,
  slamCameraObservation,
  slamDepthAt,
  drawSlamCamera,
};
