import { drawRobot } from '../core/renderer.js';
import { roleStyle } from '../core/palette.js';
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
const MIN_TEXT_PX = 12; // smallest text on screen (CONTRIBUTING.md, "Figures and charts")
const LABEL_FONT = '600 12px system-ui, sans-serif'; // image px; the image is shown at ≥ 1×
const NUMBERED_REGIONS = 6; // the regions listed under the result carry their number on the box
// How a found box is drawn, by what the scoring says it is: colour, dash and a symbol, so the
// three kinds are told apart without colour (V6). Unscored boxes (the learner's own image) are
// "measured" boxes: something the detector decided.
const REGION_STYLES = {
  correct: { color: '#35d49a', dash: [], symbol: '✓' },
  extra: { color: '#f06bc8', dash: [6, 4], symbol: '✕' },
  missed: { color: '#f2c14e', dash: [2, 3], symbol: '？' },
  unscored: { color: roleStyle('measured', 'scene').color, dash: [], symbol: '' },
};

// A small label on a dark tag, at the top-left corner of a box (inside the image).
function tag(context, text, x, y, color) {
  context.font = LABEL_FONT;
  const width = context.measureText(text).width + 6;
  const left = Math.max(0, Math.min(x, context.canvas.width - width));
  const top = Math.max(0, y - 16);
  context.fillStyle = 'rgba(12,28,34,.85)';
  context.fillRect(left, top, width, 16);
  context.fillStyle = color;
  context.fillText(text, left + 3, top + 12);
}

// Shades the ignored upper part of the input image, marks the boundary with a dashed line and
// says what it means.
function drawRoiShade(canvas, image, label) {
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
  tag(context, label, 4, boundary + 18, '#ffffff');
}

function box(context, rect, style, width) {
  context.strokeStyle = style.color;
  context.lineWidth = width;
  context.setLineDash(style.dash);
  context.strokeRect(rect.x, rect.y, rect.w, rect.h);
  context.setLineDash([]);
}

// Found regions with a cross at each centre, styled by the scoring: ✓ correct, ✕ extra, and the
// missed answer boxes dotted. The first regions carry their number from the result list.
function drawRegionBoxes(canvas, regions, imageWidth, match = null) {
  const context = canvas.getContext('2d');
  const width = Math.max(1.5, imageWidth / 130);
  regions.slice(0, REGION_BOX_LIMIT).forEach((region, index) => {
    const style = REGION_STYLES[match ? match.verdicts[index] : 'unscored'];
    box(context, region, style, width);
    context.beginPath();
    context.moveTo(region.cx - 5, region.cy);
    context.lineTo(region.cx + 5, region.cy);
    context.moveTo(region.cx, region.cy - 5);
    context.lineTo(region.cx, region.cy + 5);
    context.stroke();
    if (index < NUMBERED_REGIONS)
      tag(context, `${index + 1} ${style.symbol}`.trim(), region.x, region.y, style.color);
  });
  for (const target of match?.missed ?? []) {
    box(context, target, REGION_STYLES.missed, width);
    tag(context, '？ 見逃し', target.x, target.y + target.h + 16, REGION_STYLES.missed.color);
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
  // The width the calculation uses, as a dimension line under the box (V7).
  const y = Math.min(IMAGE_SIZE.height - 20, target.y + target.h + 10);
  context.strokeStyle = '#10313a';
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(target.x, y);
  context.lineTo(target.x + target.w, y);
  context.moveTo(target.x, y - 5);
  context.lineTo(target.x, y + 5);
  context.moveTo(target.x + target.w, y - 5);
  context.lineTo(target.x + target.w, y + 5);
  context.stroke();
  tag(context, `← ${target.w} px →`, target.x + target.w / 2 - 30, y + 20, '#ffffff');
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

// Where the robot lost the line: a red ✕ with the time, so the learner can find the curve (V10).
function drawLostMark(context, pose, label, fontSize) {
  const point = mapPoint(pose.x, pose.y);
  context.strokeStyle = roleStyle('danger', 'scene').color;
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(point.x - 8, point.y - 8);
  context.lineTo(point.x + 8, point.y + 8);
  context.moveTo(point.x - 8, point.y + 8);
  context.lineTo(point.x + 8, point.y - 8);
  context.stroke();
  context.font = `600 ${fontSize}px system-ui, sans-serif`;
  const width = context.measureText(label).width + 10;
  const height = fontSize + 9;
  const left = Math.min(Math.max(4, point.x - width / 2), MAP_SIZE.width - width - 4);
  const top = point.y > MAP_SIZE.height / 2 ? point.y - height - 16 : point.y + 14;
  context.fillStyle = 'rgba(12,28,34,.9)';
  context.fillRect(left, top, width, height);
  context.fillStyle = '#ffb3b3';
  context.fillText(label, left + 5, top + fontSize + 2);
}

// Course map: the line, the trajectory of the trial so far, the robot at the shown frame, and
// where the line was lost (`lost`: {pose, label}) once the whole trial is shown.
function drawCourseMap(canvas, { gap, frames, pose, lost = null }, labels) {
  canvas.width = MAP_SIZE.width * MAP_SCALE;
  canvas.height = MAP_SIZE.height * MAP_SCALE;
  const context = canvas.getContext('2d');
  context.scale(MAP_SCALE, MAP_SCALE);
  // The map is drawn in 500 units and shrunk to its box: its text grows so it never shows under
  // 12 px (on a 390 px phone the box is about 330 px wide).
  const shrink = MAP_SIZE.width / (canvas.clientWidth || MAP_SIZE.width);
  const fontSize = Math.ceil(Math.max(13, MIN_TEXT_PX * shrink));
  context.fillStyle = '#172f3b';
  context.fillRect(0, 0, MAP_SIZE.width, MAP_SIZE.height);
  drawCourseLine(context, gap);
  if (frames) drawTrajectory(context, frames);
  drawRobotMarker(context, pose);
  context.fillStyle = '#dce8eb';
  context.font = `${fontSize}px system-ui`;
  context.fillText(labels.start, 12, MAP_SIZE.height - 12);
  context.textAlign = 'right';
  context.fillText(labels.goal, MAP_SIZE.width - 12, MAP_SIZE.height - 12);
  context.textAlign = 'left';
  context.fillStyle = '#e3bc6b';
  context.fillRect(458, mapPoint(GOAL_X, linePath(GOAL_X)).y - 14, 3, 28);
  if (lost) drawLostMark(context, lost.pose, lost.label, fontSize);
}

export {
  REGION_STYLES,
  drawRoiShade,
  drawRegionBoxes,
  drawGeometryOverlay,
  drawLineOverlay,
  drawCourseMap,
};
