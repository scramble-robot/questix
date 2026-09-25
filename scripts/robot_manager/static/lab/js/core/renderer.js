// Canvas drawing for the simulated robot: the arena map with its sensor overlays, the on-board
// camera view, and the small start-position and trajectory thumbnails of the RL lab.
//
// This is the drawing layer. It keeps no simulation state: every function draws from the world
// and pose objects the course modules hand in. Distances are metres, converted to pixels with
// ARENA_SCALE. Headings are clockwise-positive, which matches the canvas y axis growing
// downwards, so Math.cos/Math.sin map straight onto screen directions without a sign flip.
//
// The arena and camera canvases are fixed elements of index.html (inside the hidden
// #simulation block) that every lesson moves into its own layout, so they are looked up once
// here; the two sensor overlay checkboxes sit beside them for the same reason.
import { drawQuestixTop } from './questix-art.js';
import { loadJson } from './content.js';

const copy = await loadJson('content/core/renderer.json');

const $ = (id) => document.getElementById(id);
const ctx = $('arena').getContext('2d');

const ARENA_CANVAS_WIDTH = 1000; // pixels
const ARENA_CANVAS_HEIGHT = 660;
const ARENA_ORIGIN_X = 72; // pixels; leaves room for the vertical ruler
const ARENA_ORIGIN_Y = 40;
const ARENA_SCALE = 165; // pixels per metre
const TEXT_BASELINE_NUDGE = 5; // pixels, to centre 15 px text on the point it labels

const ARENA_BACKGROUND = '#102832';
const ARENA_FLOOR = '#142f39';
const ARENA_BORDER = '#45616a';
const LABEL_SIZE = 15; // canvas pixels on a full-size arena
const MIN_TEXT = 12; // CSS pixels: the smallest text a figure may show (--figure-text-min)
const RULER_TEXT = '#92afb9';
const RULER_BELOW_ARENA = 30; // pixels below the arena for the horizontal ruler
const RULER_LEFT_OF_ARENA = 12; // pixels left of the arena for the vertical ruler
const ARENA_SIZE_ABOVE = 10; // pixels between the room's top edge and its size label

const WALL_SHADOW = '#0a2029';
const WALL_SHADOW_OFFSET = 5; // pixels
const WALL_FILL = '#2e4854';
const WALL_EDGE = '#526d77';
const WALL_CORNER_RADIUS = 5; // pixels
const WALL_TEXT = '#bed0d6';
const WALL_LABEL = { delivery: '棚', dock: '設備' };

const GOAL_COLOR = { delivery: '#f0cc81', dock: '#c4b8ff' };
const GOAL_FILL = { delivery: '#ac975426', dock: '#48446744' };
const GOAL_LABEL = { delivery: '届け先', dock: '充電ポート →' };
const GOAL_LABEL_SIZE = 16; // canvas pixels, bold
const GOAL_DASH = [6, 5]; // pixels
const GOAL_LABEL_GAP = 18; // pixels above the goal circle
// Arrow through the goal showing the heading a docking run has to arrive with.
const DOCK_ARROW_LENGTH = 12; // pixels either side of the goal centre
const DOCK_ARROW_BARB_X = 5;
const DOCK_ARROW_BARB_Y = 7;

// The fiducial marker the on-board camera looks for, drawn behind the goal.
const MARKER_HALF_WIDTH = 5; // pixels
const MARKER_HALF_HEIGHT = 12;
const MARKER_CORNER_RADIUS = 2;
const MARKER_SQUARE = 4; // pixels, the two dark squares of the marker pattern
const MARKER_SQUARE_X = -2; // pixels from the marker centre
const MARKER_SQUARE_TOP_Y = -7;
const MARKER_SQUARE_BOTTOM_Y = 3;

const TRAIL_COLOR = '#6ddbbb80';
const TRAIL_WIDTH = 3; // pixels
const SCAN_RAY_COLOR = '#78c7b435';
const SCAN_POINT_COLOR = '#78c7b4';
const SCAN_POINT_SIZE = 4; // pixels

// Arrow showing which way the robot is driving, drawn clear of the chassis.
const MOTION_THRESHOLD = 0.01; // m/s; below this the robot counts as stopped
const ARROW_FROM = 39; // pixels from the robot centre
const ARROW_TO = 79;
const ARROW_BARB = 13; // pixels
const ARROW_BARB_ANGLE = 0.5; // radians
const ARROW_WIDTH = 3; // pixels
const FORWARD_ARROW_COLOR = '#abf4d8';
const REVERSE_ARROW_COLOR = '#ffb467';

// On-board camera view: one ray-cast wall column per few pixels, plus the marker when in frame.
const CAMERA_FOV = (Math.PI * 110) / 180; // radians
const CAMERA_RAY_RANGE = 6; // metres
const CAMERA_MIN_DEPTH = 0.05; // metres, so a wall at touching distance does not fill the frame
const CAMERA_COLUMN_WIDTH = 3; // pixels per ray-cast column
const WALL_HEIGHT_SCALE = 38; // pixels of wall height at 1 m
const WALL_HEIGHT_LIMIT = 1.6; // multiples of the canvas height
const CAMERA_SKY = '#223941';
const CAMERA_FLOOR = '#152c35';
const WALL_SHADE_BASE = [40, 61, 71]; // RGB of a distant wall
const WALL_SHADE_NEAR_GAIN = [22, 28, 30]; // added as gain / (depth + 0.5 m)
const WALL_SHADE_SOFTENING = 0.5; // metres, keeps the nearest column from blowing out
const SEEN_MARKER_MAX_SIZE = 70; // pixels
const SEEN_MARKER_SIZE_SCALE = 28; // pixels at 1 m
const SEEN_MARKER_MIN_DISTANCE = 0.3; // metres
const SEEN_MARKER_PATTERN_COLOR = '#162e38';
const SEEN_MARKER_PATTERN_SIZE = 0.22; // fraction of the marker square
const SEEN_MARKER_PATTERN_TOP = 0.3; // fraction of the marker square, up and left of centre
const SEEN_MARKER_PATTERN_BOTTOM = 0.08; // fraction, down and right of centre
const SEEN_MARKER_OUTLINE_COLOR = '#8be3c0';
const SEEN_MARKER_OUTLINE_GAP = 4; // pixels around the marker square
const SEEN_MARKER_ID_COLOR = '#c6f6e5';
const SEEN_MARKER_ID_FONT = '12px system-ui';
const SEEN_MARKER_ID_MARGIN = 22; // pixels; keeps the id caption inside the frame
const SEEN_MARKER_ID_GAP = 8; // pixels above the marker square
const SEEN_MARKER_ID_TOP = 13; // pixels; highest the caption may sit
const CROSSHAIR_COLOR = '#c2d8df66';
const CROSSHAIR_ARM = 5; // pixels

// Start-position map thumbnail.
const START_MAP_PADDING = 22; // pixels
const START_MAP_BACKGROUND = '#142f39';
const START_MAP_FLOOR = '#1e3943';
const START_MAP_WALL = '#52707a';
const START_MAP_GOAL = '#eed493';
const START_AREA_COLOR = '#7bdbc373';
const START_AREA_OUTLINE = '#9aebd6';
const START_SAMPLE_STEP = 2; // pixels between sampled points of the start area
// Mirrors World.randomStart() in engine/world.js: it rejects draws this close to a wall or to
// the goal, so the shaded area has to reject them too or it would promise the wrong positions.
const START_CLEARANCE = 0.12; // metres
const START_GOAL_DISTANCE = 0.8; // metres
const THUMBNAIL_GOAL_DASH = [4, 3]; // pixels
const RESULT_SUCCESS_COLOR = '#9aebd6';
const RESULT_FAILURE_COLOR = '#ffc28c';
const RESULT_SELECTED_COLOR = '#f6fafb';
const RESULT_SELECTED_RADIUS = 12; // pixels
const RESULT_DOT_RADIUS = 5; // pixels
const RESULT_CROSS_ARM = 4; // pixels

// Trajectory thumbnail.
const TRAJECTORY_PADDING = 24; // pixels
const TRAJECTORY_BACKGROUND = '#122c36';
const TRAJECTORY_FLOOR = '#193640';
const TRAJECTORY_BORDER = '#3d5962';
const TRAJECTORY_WALL = '#39525e';
const TRAJECTORY_GOAL = '#ecc985';
const TRAJECTORY_GOAL_FILL = '#ecc98524';
const TRAJECTORY_SUCCESS = '#8adfc2';
const TRAJECTORY_FAILURE = '#f2b57b';
const TRAJECTORY_HEAD_SUCCESS = '#c0f7df';
const TRAJECTORY_HEAD_FAILURE = '#ffd5a8';
const TRAJECTORY_WIDTH = 2.7; // pixels
const HEADING_ARROW_TIP = 8; // pixels ahead of the final pose
const HEADING_ARROW_BACK = 5;
const START_DOT_COLOR = '#a5d9ef';
const START_DOT_RADIUS = 4; // pixels
const DOCK_MARK_LEFT = 7; // pixels; the short arrow drawn at a docking goal
const DOCK_MARK_RIGHT = 8;
const DOCK_MARK_BARB = 3;
const DOCK_MARK_SPREAD = 4;

/** Maps a point in arena metres to pixels on the full-size arena canvas. */
const screen = (x, y) => ({
  x: ARENA_ORIGIN_X + x * ARENA_SCALE,
  y: ARENA_ORIGIN_Y + y * ARENA_SCALE,
});

/** roundRect on any context; `fill` and `stroke` are optional CSS colours. */
function paintRoundedRect(target, x, y, width, height, radius, fill, stroke) {
  target.beginPath();
  target.roundRect(x, y, width, height, radius);
  if (fill) {
    target.fillStyle = fill;
    target.fill();
  }
  if (stroke) {
    target.strokeStyle = stroke;
    target.stroke();
  }
}

/** Pixel rectangle the arena occupies on the full-size canvas. */
function arenaBox(env) {
  return {
    x: ARENA_ORIGIN_X,
    y: ARENA_ORIGIN_Y,
    width: env.width * ARENA_SCALE,
    height: env.height * ARENA_SCALE,
  };
}

// The arena canvas is drawn at a fixed resolution and shrunk by CSS on a phone (720 → ~350 px), so
// labels are enlarged by the same factor there: never smaller than MIN_TEXT on screen.
let unitsPerPixel = 1;
// The canvas may be letterboxed (object-fit: contain), so the tighter of the two ratios counts.
function measureScale(canvas) {
  const shown = canvas.getBoundingClientRect?.();
  const ratio = shown ? Math.min(shown.width / canvas.width, shown.height / canvas.height) : 0;
  unitsPerPixel = ratio > 0 ? 1 / ratio : 1;
}
const fontOf = (size, weight = '') =>
  `${weight}${Math.round(Math.max(size, MIN_TEXT * unitsPerPixel))}px system-ui`;
const labelFont = () => fontOf(LABEL_SIZE);

/** Pixel rectangle of the arena fitted into a thumbnail canvas with equal margins. */
function thumbnailBox(canvas, env, padding) {
  const scale = Math.min(
    (canvas.width - padding * 2) / env.width,
    (canvas.height - padding * 2) / env.height,
  );
  return {
    scale,
    x: (canvas.width - env.width * scale) / 2,
    y: (canvas.height - env.height * scale) / 2,
  };
}

// The two overlay checkboxes belong to the shared #simulation markup rather than to the
// drawing call, so they are read here instead of being threaded through every caller.
const trailVisible = () => $('trailToggle').checked;
const scanVisible = () => $('sensorToggle').checked;

function paintArenaFloor(box) {
  ctx.clearRect(0, 0, ARENA_CANVAS_WIDTH, ARENA_CANVAS_HEIGHT);
  ctx.fillStyle = ARENA_BACKGROUND;
  ctx.fillRect(0, 0, ARENA_CANVAS_WIDTH, ARENA_CANVAS_HEIGHT);
  ctx.fillStyle = ARENA_FLOOR;
  ctx.fillRect(box.x, box.y, box.width, box.height);
}

/** Metre marks along the bottom and left edges of the arena. */
function paintRuler(box) {
  ctx.font = labelFont();
  ctx.textAlign = 'center';
  ctx.fillStyle = RULER_TEXT;
  for (let metre = 0; metre <= 4; metre++)
    ctx.fillText(metre + ' m', box.x + metre * ARENA_SCALE, box.y + box.height + RULER_BELOW_ARENA);
  ctx.textAlign = 'right';
  for (let metre = 0; metre <= 3; metre++)
    ctx.fillText(
      metre + ' m',
      box.x - RULER_LEFT_OF_ARENA,
      box.y + metre * ARENA_SCALE + TEXT_BASELINE_NUDGE,
    );
}

function paintArenaBorder(box) {
  ctx.strokeStyle = ARENA_BORDER;
  ctx.lineWidth = 2;
  ctx.strokeRect(box.x, box.y, box.width, box.height);
}

/** Shelves (delivery) or equipment (docking): a drop shadow, the box, and its caption. */
function paintWalls(env, box) {
  for (const wall of env.walls) {
    const x = box.x + wall.x * ARENA_SCALE;
    const y = box.y + wall.y * ARENA_SCALE;
    const width = wall.w * ARENA_SCALE;
    const height = wall.h * ARENA_SCALE;
    paintRoundedRect(
      ctx,
      x,
      y + WALL_SHADOW_OFFSET,
      width,
      height,
      WALL_CORNER_RADIUS,
      WALL_SHADOW,
    );
    paintRoundedRect(ctx, x, y, width, height, WALL_CORNER_RADIUS, WALL_FILL, WALL_EDGE);
    ctx.fillStyle = WALL_TEXT;
    ctx.font = labelFont();
    ctx.textAlign = 'center';
    ctx.fillText(
      env.task === 'delivery' ? WALL_LABEL.delivery : WALL_LABEL.dock,
      box.x + (wall.x + wall.w / 2) * ARENA_SCALE,
      box.y + (wall.y + wall.h / 2) * ARENA_SCALE + TEXT_BASELINE_NUDGE,
    );
  }
}

/** The goal disc, its caption, and (when docking) the heading the robot must arrive with. */
function paintGoal(env, box) {
  const goal = env.goal;
  const docking = env.task === 'dock';
  const x = box.x + goal.x * ARENA_SCALE;
  const y = box.y + goal.y * ARENA_SCALE;
  const radius = goal.radius * ARENA_SCALE;
  const color = docking ? GOAL_COLOR.dock : GOAL_COLOR.delivery;
  ctx.fillStyle = docking ? GOAL_FILL.dock : GOAL_FILL.delivery;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash(GOAL_DASH);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = fontOf(GOAL_LABEL_SIZE, 'bold ');
  ctx.textAlign = 'center';
  ctx.fillText(docking ? GOAL_LABEL.dock : GOAL_LABEL.delivery, x, y - radius - GOAL_LABEL_GAP);
  if (!docking) return;
  ctx.beginPath();
  ctx.moveTo(x - DOCK_ARROW_LENGTH, y);
  ctx.lineTo(x + DOCK_ARROW_LENGTH, y);
  ctx.moveTo(x + DOCK_ARROW_BARB_X, y - DOCK_ARROW_BARB_Y);
  ctx.lineTo(x + DOCK_ARROW_LENGTH, y);
  ctx.lineTo(x + DOCK_ARROW_BARB_X, y + DOCK_ARROW_BARB_Y);
  ctx.stroke();
}

/** The fiducial marker behind the goal, in the goal's colour. */
function paintMarker(env) {
  const marker = screen(env.marker.x, env.marker.y);
  const color = env.task === 'dock' ? GOAL_COLOR.dock : GOAL_COLOR.delivery;
  paintRoundedRect(
    ctx,
    marker.x - MARKER_HALF_WIDTH,
    marker.y - MARKER_HALF_HEIGHT,
    MARKER_HALF_WIDTH * 2,
    MARKER_HALF_HEIGHT * 2,
    MARKER_CORNER_RADIUS,
    color,
  );
  ctx.fillStyle = ARENA_BACKGROUND;
  ctx.fillRect(
    marker.x + MARKER_SQUARE_X,
    marker.y + MARKER_SQUARE_TOP_Y,
    MARKER_SQUARE,
    MARKER_SQUARE,
  );
  ctx.fillRect(
    marker.x + MARKER_SQUARE_X,
    marker.y + MARKER_SQUARE_BOTTOM_Y,
    MARKER_SQUARE,
    MARKER_SQUARE,
  );
}

function paintTrail(trail) {
  ctx.beginPath();
  trail.forEach((step, i) => {
    const point = screen(step.x, step.y);
    if (i) ctx.lineTo(point.x, point.y);
    else ctx.moveTo(point.x, point.y);
  });
  ctx.strokeStyle = TRAIL_COLOR;
  ctx.lineWidth = TRAIL_WIDTH;
  ctx.stroke();
}

/** Lidar rays and their end points, clipped to the arena so they stop at its edge. */
function paintScan(box, pose, robot, observation) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.width, box.height);
  ctx.clip();
  observation.scan.forEach((distance, i) => {
    const angle = pose.theta + (i * 2 * Math.PI) / observation.scan.length;
    ctx.strokeStyle = SCAN_RAY_COLOR;
    ctx.beginPath();
    ctx.moveTo(robot.x, robot.y);
    ctx.lineTo(
      robot.x + Math.cos(angle) * distance * ARENA_SCALE,
      robot.y + Math.sin(angle) * distance * ARENA_SCALE,
    );
    ctx.stroke();
    ctx.fillStyle = SCAN_POINT_COLOR;
    ctx.fillRect(
      robot.x + Math.cos(angle) * distance * ARENA_SCALE - 2,
      robot.y + Math.sin(angle) * distance * ARENA_SCALE - 2,
      SCAN_POINT_SIZE,
      SCAN_POINT_SIZE,
    );
  });
  ctx.restore();
}

/** Direction of travel; it points backwards and turns orange when the robot reverses. */
function paintMotionArrow(robot, pose) {
  const speed = (pose.left + pose.right) / 2;
  if (Math.abs(speed) <= MOTION_THRESHOLD) return;
  const reverse = speed < -MOTION_THRESHOLD;
  const angle = pose.theta + (reverse ? Math.PI : 0);
  const tipX = robot.x + Math.cos(angle) * ARROW_TO;
  const tipY = robot.y + Math.sin(angle) * ARROW_TO;
  ctx.strokeStyle = reverse ? REVERSE_ARROW_COLOR : FORWARD_ARROW_COLOR;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = ARROW_WIDTH;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(robot.x + Math.cos(angle) * ARROW_FROM, robot.y + Math.sin(angle) * ARROW_FROM);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(
    tipX - Math.cos(angle - ARROW_BARB_ANGLE) * ARROW_BARB,
    tipY - Math.sin(angle - ARROW_BARB_ANGLE) * ARROW_BARB,
  );
  ctx.lineTo(
    tipX - Math.cos(angle + ARROW_BARB_ANGLE) * ARROW_BARB,
    tipY - Math.sin(angle + ARROW_BARB_ANGLE) * ARROW_BARB,
  );
  ctx.closePath();
  ctx.fill();
  ctx.lineCap = 'butt';
}

// Above the room's right corner: below it, the enlarged phone labels would run into the 4 m mark.
function paintArenaSize(box) {
  ctx.textAlign = 'right';
  ctx.font = labelFont();
  ctx.fillStyle = RULER_TEXT;
  ctx.fillText('4.8 × 3.2 m', box.x + box.width, box.y - ARENA_SIZE_ABOVE);
}

/** The main lesson view: the room, the robot, and whichever sensor overlays are switched on. */
function drawArena(env, pose, trail, observation) {
  measureScale(ctx.canvas);
  const box = arenaBox(env);
  paintArenaFloor(box);
  paintRuler(box);
  paintArenaBorder(box);
  paintWalls(env, box);
  paintGoal(env, box);
  paintMarker(env);
  if (trailVisible() && trail.length > 1) paintTrail(trail);
  const robot = screen(pose.x, pose.y);
  if (scanVisible() && observation) paintScan(box, pose, robot, observation);
  drawRobot(ctx, robot, pose);
  paintMotionArrow(robot, pose);
  paintArenaSize(box);
}

/** Wall colour of one camera column: nearer walls are lighter, which reads as distance. */
function wallColumnColor(depth) {
  const channels = WALL_SHADE_BASE.map((base, i) =>
    Math.round(base + WALL_SHADE_NEAR_GAIN[i] / (depth + WALL_SHADE_SOFTENING)),
  );
  return `rgb(${channels.join(',')})`;
}

/** One ray-cast column every few pixels; a teaching view of the walls, not a 3D render. */
function paintCameraWalls(camera, env, pose, width, height) {
  for (let x = 0; x < width; x += CAMERA_COLUMN_WIDTH) {
    const angle = pose.theta + (x / width - 0.5) * CAMERA_FOV;
    // Project onto the optical axis, or a flat wall would bulge towards the edges of the frame.
    const depth = Math.max(
      CAMERA_MIN_DEPTH,
      env.ray(pose.x, pose.y, angle, CAMERA_RAY_RANGE) * Math.cos(angle - pose.theta),
    );
    const columnHeight = Math.min(height * WALL_HEIGHT_LIMIT, WALL_HEIGHT_SCALE / depth);
    camera.fillStyle = wallColumnColor(depth);
    camera.fillRect(x, height / 2 - columnHeight / 2, CAMERA_COLUMN_WIDTH, columnHeight);
  }
}

/** The fiducial marker as the camera sees it: the square, its pattern, a frame and its id. */
function paintSeenMarker(camera, env, reading, width, height) {
  const x = width / 2 + (reading.bearing / CAMERA_FOV) * width;
  const size = Math.min(
    SEEN_MARKER_MAX_SIZE,
    SEEN_MARKER_SIZE_SCALE / Math.max(SEEN_MARKER_MIN_DISTANCE, reading.distance),
  );
  camera.fillStyle = env.task === 'dock' ? GOAL_COLOR.dock : GOAL_COLOR.delivery;
  camera.fillRect(x - size / 2, height / 2 - size / 2, size, size);
  camera.fillStyle = SEEN_MARKER_PATTERN_COLOR;
  camera.fillRect(
    x - size * SEEN_MARKER_PATTERN_TOP,
    height / 2 - size * SEEN_MARKER_PATTERN_TOP,
    size * SEEN_MARKER_PATTERN_SIZE,
    size * SEEN_MARKER_PATTERN_SIZE,
  );
  camera.fillRect(
    x + size * SEEN_MARKER_PATTERN_BOTTOM,
    height / 2 + size * SEEN_MARKER_PATTERN_BOTTOM,
    size * SEEN_MARKER_PATTERN_SIZE,
    size * SEEN_MARKER_PATTERN_SIZE,
  );
  camera.strokeStyle = SEEN_MARKER_OUTLINE_COLOR;
  camera.strokeRect(
    x - size / 2 - SEEN_MARKER_OUTLINE_GAP,
    height / 2 - size / 2 - SEEN_MARKER_OUTLINE_GAP,
    size + SEEN_MARKER_OUTLINE_GAP * 2,
    size + SEEN_MARKER_OUTLINE_GAP * 2,
  );
  camera.fillStyle = SEEN_MARKER_ID_COLOR;
  camera.font = SEEN_MARKER_ID_FONT;
  camera.textAlign = 'center';
  camera.fillText(
    reading.id,
    Math.max(SEEN_MARKER_ID_MARGIN, Math.min(width - SEEN_MARKER_ID_MARGIN, x)),
    Math.max(SEEN_MARKER_ID_TOP, height / 2 - size / 2 - SEEN_MARKER_ID_GAP),
  );
}

function paintCrosshair(camera, width, height) {
  camera.strokeStyle = CROSSHAIR_COLOR;
  camera.beginPath();
  camera.moveTo(width / 2 - CROSSHAIR_ARM, height / 2);
  camera.lineTo(width / 2 + CROSSHAIR_ARM, height / 2);
  camera.moveTo(width / 2, height / 2 - CROSSHAIR_ARM);
  camera.lineTo(width / 2, height / 2 + CROSSHAIR_ARM);
  camera.stroke();
}

/** What the robot's own camera would show from this pose. */
function drawCamera(env, pose, observation) {
  const canvas = $('cameraView');
  const camera = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  camera.fillStyle = CAMERA_SKY;
  camera.fillRect(0, 0, width, height / 2);
  camera.fillStyle = CAMERA_FLOOR;
  camera.fillRect(0, height / 2, width, height / 2);
  paintCameraWalls(camera, env, pose, width, height);
  if (observation.camera.visible) paintSeenMarker(camera, env, observation.camera, width, height);
  paintCrosshair(camera, width, height);
}

/** Shades every position an episode may start from, sampled on a coarse pixel grid. */
function paintStartArea(map, env, box, range) {
  const bounds = env.startBounds(range);
  const pixelWidth = env.width * box.scale;
  const pixelHeight = env.height * box.scale;
  map.fillStyle = START_AREA_COLOR;
  for (let px = 0; px < pixelWidth; px += START_SAMPLE_STEP)
    for (let py = 0; py < pixelHeight; py += START_SAMPLE_STEP) {
      const x = (px + 1) / box.scale;
      const y = (py + 1) / box.scale;
      const insideBounds = x >= bounds.x0 && x <= bounds.x1 && y >= bounds.y0 && y <= bounds.y1;
      const clear = insideBounds && !env.blocked(x, y, START_CLEARANCE);
      const awayFromGoal =
        clear && Math.hypot(x - env.goal.x, y - env.goal.y) > START_GOAL_DISTANCE;
      if (awayFromGoal) map.fillRect(box.x + px, box.y + py, START_SAMPLE_STEP, START_SAMPLE_STEP);
    }
  // Only the narrow "near" band is outlined; a widened range has no meaningful rectangle.
  if (range !== 0) return;
  map.strokeStyle = START_AREA_OUTLINE;
  map.lineWidth = 1.5;
  map.strokeRect(
    box.x + bounds.x0 * box.scale,
    box.y + bounds.y0 * box.scale,
    (bounds.x1 - bounds.x0) * box.scale,
    (bounds.y1 - bounds.y0) * box.scale,
  );
}

function paintThumbnailWalls(target, env, box, color) {
  for (const wall of env.walls) {
    target.fillStyle = color;
    target.fillRect(
      box.x + wall.x * box.scale,
      box.y + wall.y * box.scale,
      wall.w * box.scale,
      wall.h * box.scale,
    );
  }
}

/** One test run: a filled dot where it arrived, a cross where it did not. */
function paintStartResult(map, box, result, selected) {
  const start = result.trace[0].state;
  const x = box.x + start.x * box.scale;
  const y = box.y + start.y * box.scale;
  if (selected) {
    map.strokeStyle = RESULT_SELECTED_COLOR;
    map.lineWidth = 2;
    map.beginPath();
    map.arc(x, y, RESULT_SELECTED_RADIUS, 0, Math.PI * 2);
    map.stroke();
  }
  map.strokeStyle = result.success ? RESULT_SUCCESS_COLOR : RESULT_FAILURE_COLOR;
  map.fillStyle = map.strokeStyle;
  map.lineWidth = 2.5;
  map.beginPath();
  if (result.success) {
    map.arc(x, y, RESULT_DOT_RADIUS, 0, Math.PI * 2);
    map.fill();
    return;
  }
  map.moveTo(x - RESULT_CROSS_ARM, y - RESULT_CROSS_ARM);
  map.lineTo(x + RESULT_CROSS_ARM, y + RESULT_CROSS_ARM);
  map.moveTo(x - RESULT_CROSS_ARM, y + RESULT_CROSS_ARM);
  map.lineTo(x + RESULT_CROSS_ARM, y - RESULT_CROSS_ARM);
  map.stroke();
}

/** Screen-reader description of whichever of the two start maps is on screen. */
function startMapDescription(results, range) {
  if (results) return copy.startMapDescription.results;
  if (range === 0) return copy.startMapDescription.nearRange;
  return copy.startMapDescription.widerRange;
}

// Static, comparable records: the complete path stays visible while learning continues.
function drawStartMap(canvas, env, { range = 0, results = null, selected = null } = {}) {
  const map = canvas.getContext('2d');
  const box = thumbnailBox(canvas, env, START_MAP_PADDING);
  map.clearRect(0, 0, canvas.width, canvas.height);
  map.fillStyle = START_MAP_BACKGROUND;
  map.fillRect(0, 0, canvas.width, canvas.height);
  map.fillStyle = START_MAP_FLOOR;
  map.fillRect(box.x, box.y, env.width * box.scale, env.height * box.scale);
  if (!results) paintStartArea(map, env, box, range);
  paintThumbnailWalls(map, env, box, START_MAP_WALL);
  map.strokeStyle = START_MAP_GOAL;
  map.lineWidth = 2;
  map.setLineDash(THUMBNAIL_GOAL_DASH);
  map.beginPath();
  map.arc(
    box.x + env.goal.x * box.scale,
    box.y + env.goal.y * box.scale,
    env.goal.radius * box.scale,
    0,
    Math.PI * 2,
  );
  map.stroke();
  map.setLineDash([]);
  if (results) results.forEach((result, i) => paintStartResult(map, box, result, i === selected));
  canvas.setAttribute('aria-label', startMapDescription(results, range));
}

/** Goal disc of the trajectory thumbnail, with the docking heading marked when needed. */
function paintTrajectoryGoal(plot, env, box, goalX, goalY) {
  plot.strokeStyle = TRAJECTORY_GOAL;
  plot.fillStyle = TRAJECTORY_GOAL_FILL;
  plot.lineWidth = 2;
  plot.setLineDash(THUMBNAIL_GOAL_DASH);
  plot.beginPath();
  plot.arc(goalX, goalY, env.goal.radius * box.scale, 0, Math.PI * 2);
  plot.fill();
  plot.stroke();
  plot.setLineDash([]);
  if (env.task !== 'dock') return;
  plot.beginPath();
  plot.moveTo(goalX - DOCK_MARK_LEFT, goalY);
  plot.lineTo(goalX + DOCK_MARK_RIGHT, goalY);
  plot.lineTo(goalX + DOCK_MARK_BARB, goalY - DOCK_MARK_SPREAD);
  plot.moveTo(goalX + DOCK_MARK_RIGHT, goalY);
  plot.lineTo(goalX + DOCK_MARK_BARB, goalY + DOCK_MARK_SPREAD);
  plot.stroke();
}

/** The driven path plus a triangle at the final pose, coloured by whether the run arrived. */
function paintTrajectoryPath(plot, trace, result, point) {
  plot.strokeStyle = result.success ? TRAJECTORY_SUCCESS : TRAJECTORY_FAILURE;
  plot.lineWidth = TRAJECTORY_WIDTH;
  plot.lineJoin = 'round';
  plot.beginPath();
  trace.forEach((frame, i) => {
    const [x, y] = point(frame.state);
    if (i) plot.lineTo(x, y);
    else plot.moveTo(x, y);
  });
  plot.stroke();
  const end = trace.at(-1).state;
  const [x, y] = point(end);
  plot.save();
  plot.translate(x, y);
  plot.rotate(end.theta);
  plot.fillStyle = result.success ? TRAJECTORY_HEAD_SUCCESS : TRAJECTORY_HEAD_FAILURE;
  plot.beginPath();
  plot.moveTo(HEADING_ARROW_TIP, 0);
  plot.lineTo(-HEADING_ARROW_BACK, -HEADING_ARROW_BACK);
  plot.lineTo(-HEADING_ARROW_BACK, HEADING_ARROW_BACK);
  plot.closePath();
  plot.fill();
  plot.restore();
}

/** Thumbnail of one recorded run, used to compare learning checkpoints side by side. */
function drawTrajectory(canvas, env, result) {
  const plot = canvas.getContext('2d');
  const box = thumbnailBox(canvas, env, TRAJECTORY_PADDING);
  const point = (state) => [box.x + state.x * box.scale, box.y + state.y * box.scale];
  plot.clearRect(0, 0, canvas.width, canvas.height);
  plot.fillStyle = TRAJECTORY_BACKGROUND;
  plot.fillRect(0, 0, canvas.width, canvas.height);
  plot.fillStyle = TRAJECTORY_FLOOR;
  plot.fillRect(box.x, box.y, env.width * box.scale, env.height * box.scale);
  plot.strokeStyle = TRAJECTORY_BORDER;
  plot.lineWidth = 1;
  plot.strokeRect(box.x, box.y, env.width * box.scale, env.height * box.scale);
  paintThumbnailWalls(plot, env, box, TRAJECTORY_WALL);
  const [goalX, goalY] = point(env.goal);
  paintTrajectoryGoal(plot, env, box, goalX, goalY);
  const trace = result?.trace || [];
  // Before a run is recorded there is no trace, so the world's current pose marks the start.
  const start = trace[0]?.state || env.state;
  const [startX, startY] = point(start);
  if (trace.length) paintTrajectoryPath(plot, trace, result, point);
  plot.fillStyle = START_DOT_COLOR;
  plot.beginPath();
  plot.arc(startX, startY, START_DOT_RADIUS, 0, Math.PI * 2);
  plot.fill();
  plot.strokeStyle = TRAJECTORY_BACKGROUND;
  plot.lineWidth = 1;
  plot.stroke();
}

// The robot as every scene shows it: the CAD top view from core/questix-art.js, about 0.36 m
// across at the arena's scale (the simulated body's collision diameter).
const ROBOT_DRAW_SIZE = 60; // pixels; callers scale their context for other sizes

/** Draws the robot on `target` at pixel point `p`, turned to `pose.theta`. */
function drawRobot(target, p, pose) {
  drawQuestixTop(target, p.x, p.y, pose.theta, ROBOT_DRAW_SIZE);
}

export {
  drawArena,
  drawCamera,
  drawStartMap,
  drawTrajectory,
  drawRobot,
  thumbnailBox,
  START_MAP_PADDING,
};
