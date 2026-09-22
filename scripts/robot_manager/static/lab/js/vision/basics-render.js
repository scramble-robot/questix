import { drawRobot } from '../core/renderer.js';
import { IMAGE_SIZE, linePath } from './basics-math.js';

// Canvas overlays of the vision foundation chapters. Every function draws from plain data handed
// in by basics.js on top of an image that ui.js has already put on the canvas.

const ROI_TOP_FRACTION = 0.4; // share of the image height that the region search ignores
const REGION_BOX_LIMIT = 80; // boxes drawn per run; more would only clutter the mask
const LINE_IMAGE = { width: 120, height: 90 };
const LINE_WINDOW = { top: 0.62, height: 0.22 }; // fractions of the image height
const LINE_CENTER_X = 59.5; // pixel column between the two middle columns of a 120 px image
const LINE_MARK_Y = 65; // pixel row where the detected line centre is marked
const COURSE_LENGTH = 4.8; // metres of line drawn on the course map
const COURSE_GAP = { from: 1.9, to: 2.4 }; // metres where the "gap" course has no line
const GOAL_X = 4.5; // metres
const MAP_SIZE = { width: 500, height: 230 }; // CSS pixels; the canvas is drawn at 2×
const MAP_SCALE = 2;
const MAP_ORIGIN = { x: 35, y: 115 }; // map pixels of the course origin
const MAP_PIXELS_PER_METRE = { x: 94, y: 115 };
const ROBOT_SCALE = 0.48;

// Shades the ignored upper part of the input image and marks the boundary with a dashed line.
function drawRoiShade(canvas, image) {
  const context = canvas.getContext('2d');
  const boundary = image.height * ROI_TOP_FRACTION;
  context.fillStyle = 'rgba(16,35,42,.40)';
  context.fillRect(0, 0, image.width, boundary);
  context.strokeStyle = '#fff';
  context.lineWidth = 1.5;
  context.setLineDash([5, 4]);
  context.beginPath();
  context.moveTo(0, boundary);
  context.lineTo(image.width, boundary);
  context.stroke();
  context.setLineDash([]);
}

// Orange bounding boxes with a cross at each region's centre.
function drawRegionBoxes(canvas, regions, imageWidth) {
  const context = canvas.getContext('2d');
  context.lineWidth = Math.max(1, imageWidth / 160);
  context.strokeStyle = '#faaf50';
  for (const region of regions.slice(0, REGION_BOX_LIMIT)) {
    context.strokeRect(region.x, region.y, region.w, region.h);
    context.beginPath();
    context.moveTo(region.cx - 5, region.cy);
    context.lineTo(region.cx + 5, region.cy);
    context.moveTo(region.cx, region.cy - 5);
    context.lineTo(region.cx, region.cy + 5);
    context.stroke();
  }
}

// Image centre line, plus the measured bounding box when the target was found.
function drawGeometryOverlay(canvas, target) {
  const context = canvas.getContext('2d');
  const centreX = (IMAGE_SIZE.width - 1) / 2;
  context.strokeStyle = '#648f91';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(centreX, 0);
  context.lineTo(centreX, IMAGE_SIZE.height);
  context.stroke();
  if (!target) return;
  context.strokeStyle = '#185e50';
  context.lineWidth = 2;
  context.strokeRect(target.x, target.y, target.w, target.h);
}

// The band of rows the line detector looks at, the image centre, and the detected line centre.
function drawLineOverlay(canvas, observation) {
  const context = canvas.getContext('2d');
  const { width, height } = LINE_IMAGE;
  context.strokeStyle = '#dfa95a';
  context.lineWidth = 1;
  context.strokeRect(0, height * LINE_WINDOW.top, width, height * LINE_WINDOW.height);
  context.strokeStyle = '#48bb9b';
  context.beginPath();
  context.moveTo(LINE_CENTER_X, 0);
  context.lineTo(LINE_CENTER_X, height);
  context.stroke();
  if (!observation.valid) return;
  context.fillStyle = '#edb357';
  context.beginPath();
  context.arc(observation.cx, LINE_MARK_Y, 3, 0, Math.PI * 2);
  context.fill();
}

const mapPoint = (x, y) => ({
  x: MAP_ORIGIN.x + x * MAP_PIXELS_PER_METRE.x,
  y: MAP_ORIGIN.y - y * MAP_PIXELS_PER_METRE.y,
});

function drawCourseLine(context, gap) {
  context.strokeStyle = '#b3c6ce';
  context.lineWidth = 7;
  context.beginPath();
  for (let x = 0; x <= COURSE_LENGTH; x += 0.025) {
    const point = mapPoint(x, linePath(x));
    const inGap = gap && x > COURSE_GAP.from && x < COURSE_GAP.to;
    if (x === 0 || inGap) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  }
  context.stroke();
}

function drawTrajectory(context, frames) {
  context.strokeStyle = '#79d3b9';
  context.lineWidth = 2;
  context.beginPath();
  frames.forEach((frame, index) => {
    const point = mapPoint(frame.pose.x, frame.pose.y);
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.stroke();
}

function drawRobotMarker(context, pose) {
  const point = mapPoint(pose.x, pose.y);
  context.save();
  context.translate(point.x, point.y);
  context.scale(ROBOT_SCALE, ROBOT_SCALE);
  drawRobot(context, { x: 0, y: 0 }, { theta: -pose.theta });
  context.restore();
}

// Course map: the line, the trajectory of the trial so far, the robot at the shown frame.
function drawCourseMap(canvas, { gap, frames, pose }, labels) {
  canvas.width = MAP_SIZE.width * MAP_SCALE;
  canvas.height = MAP_SIZE.height * MAP_SCALE;
  const context = canvas.getContext('2d');
  context.scale(MAP_SCALE, MAP_SCALE);
  context.fillStyle = '#172f3b';
  context.fillRect(0, 0, MAP_SIZE.width, MAP_SIZE.height);
  drawCourseLine(context, gap);
  if (frames) drawTrajectory(context, frames);
  drawRobotMarker(context, pose);
  context.fillStyle = '#dce8eb';
  context.font = '13px system-ui';
  context.fillText(labels.start, 18, 203);
  context.fillText(labels.goal, 430, 203);
  context.fillStyle = '#e3bc6b';
  context.fillRect(458, mapPoint(GOAL_X, linePath(GOAL_X)).y - 14, 3, 28);
}

export { drawRoiShade, drawRegionBoxes, drawGeometryOverlay, drawLineOverlay, drawCourseMap };
