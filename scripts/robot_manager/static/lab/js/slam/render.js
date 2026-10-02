import { drawRobot } from '../core/renderer.js';
import { drawQuestixSide } from '../core/questix-views.js';
import { drawSlamCamera } from './camera.js';

// Canvas drawing of the SLAM experiment: the two maps (reference and estimate), the sensor chart
// and the IMU tilt demo. Every function draws from plain data handed in by ui.js and keeps no
// state of its own. Drawing coordinates are the logical canvas sizes below; the bitmap follows the
// CSS box and screen density (see sharpContext).

const MAP_WIDTH = 600;
const MAP_HEIGHT = 440;
const MAP_MARGIN = 24; // canvas units kept clear around the grid
const MAP_PADDING = 0.3; // metres added around everything that is drawn
const SENSOR_WIDTH = 800;
const SENSOR_HEIGHT = 320;
const TILT_WIDTH = 440;
const TILT_HEIGHT = 190;
const GRAVITY = 9.81; // m/s²
const START_RING_RADIUS = 0.15; // metres, drawn around the start position
const ROBOT_SCALE = 0.48; // the shared robot drawing is made for a larger canvas
// Method colours on the dark map, with the dash patterns of the error chart (view.js METHOD_LINES).
const METHOD_COLORS = { wheel: '#eab075', imu: '#93baff', slam: '#7bdec3' };
const METHOD_DASHES = { wheel: [], imu: [9, 4], slam: [2, 4] };
const TRUTH_COLOR = '#eef5f8';
const GAP_COLOR = '#ff6b6b'; // the gap between where the robot is and where it thinks it is
const MIN_TEXT_PX = 12; // smallest text on screen (CONTRIBUTING.md, "Figures and charts")

// Keep drawing coordinates independent of the canvas bitmap. CSS size and screen density
// determine the backing resolution, including browser zoom changes.
function sharpContext(canvas, width, height) {
  canvas.style.aspectRatio = width + ' / ' + height;
  const box = canvas.getBoundingClientRect();
  const density = window.devicePixelRatio || 1;
  const fit = box.width && box.height ? Math.min(box.width / width, box.height / height) : 1;
  const scale = fit * density;
  const pixelsWide = Math.max(1, Math.round(width * scale));
  const pixelsHigh = Math.max(1, Math.round(height * scale));
  if (canvas.width !== pixelsWide) canvas.width = pixelsWide;
  if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh;
  const context = canvas.getContext('2d');
  context.setTransform(pixelsWide / width, 0, 0, pixelsHigh / height, 0, 0);
  context.clearRect(0, 0, width, height);
  context.lineWidth = 1;
  return context;
}

// --- Maps ---------------------------------------------------------------------------------------

// Both maps share one extent so the reference and the estimate can be compared by eye.
function mapBounds(log, run) {
  const points = [{ x: -1, y: -1 }, { x: 4.6, y: 3.3 }, ...(log.reference || [])];
  if (log.scene) {
    const { start, width, height } = log.scene;
    points.push(
      { x: -start.x - 0.25, y: -start.y - 0.25 },
      { x: width - start.x + 0.25, y: height - start.y + 0.25 },
    );
  }
  if (run) {
    points.push(...run.states);
    // Every sixth scan is enough to size the map; the drawing itself uses every second one.
    for (let i = 0; i < run.states.length; i += 6) points.push(...run.states[i].points);
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    x0: Math.min(...xs) - MAP_PADDING,
    x1: Math.max(...xs) + MAP_PADDING,
    y0: Math.min(...ys) - MAP_PADDING,
    y1: Math.max(...ys) + MAP_PADDING,
  };
}

// Metres to canvas units, y up on the map but down on the canvas.
function mapProjection(bounds) {
  const spanX = bounds.x1 - bounds.x0;
  const spanY = bounds.y1 - bounds.y0;
  const k = Math.min((MAP_WIDTH - 2 * MAP_MARGIN) / spanX, (MAP_HEIGHT - 2 * MAP_MARGIN) / spanY);
  const offsetX = (MAP_WIDTH - spanX * k) / 2;
  const offsetY = (MAP_HEIGHT - spanY * k) / 2;
  return {
    k,
    toX: (x) => offsetX + (x - bounds.x0) * k,
    toY: (y) => MAP_HEIGHT - offsetY - (y - bounds.y0) * k,
  };
}

function drawGrid(context, bounds, { toX, toY }) {
  context.fillStyle = '#102832';
  context.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
  context.strokeStyle = '#24424d';
  context.lineWidth = 1;
  for (let x = Math.ceil(bounds.x0); x < bounds.x1; x++) {
    context.beginPath();
    context.moveTo(toX(x), MAP_MARGIN);
    context.lineTo(toX(x), MAP_HEIGHT - MAP_MARGIN);
    context.stroke();
  }
  for (let y = Math.ceil(bounds.y0); y < bounds.y1; y++) {
    context.beginPath();
    context.moveTo(MAP_MARGIN, toY(y));
    context.lineTo(MAP_WIDTH - MAP_MARGIN, toY(y));
    context.stroke();
  }
}

// The simulated room, in the reference frame whose origin is the start pose.
function drawRoom(context, scene, { toX, toY, k }) {
  const { start } = scene;
  context.strokeStyle = '#809ba6';
  context.strokeRect(toX(-start.x), toY(scene.height - start.y), scene.width * k, scene.height * k);
  context.fillStyle = '#49616e';
  for (const wall of scene.walls)
    context.fillRect(toX(wall.x - start.x), toY(wall.y + wall.h - start.y), wall.w * k, wall.h * k);
}

// Canvas units of text that shows at `px` CSS pixels however far the map is shrunk.
function textSize(canvas, px) {
  const width = canvas.getBoundingClientRect().width || MAP_WIDTH;
  return Math.ceil(Math.max(px, (MIN_TEXT_PX * MAP_WIDTH) / width, (px * MAP_WIDTH) / 600));
}

// A label on a dark tag, kept inside the map.
function tag(context, text, x, y, color, size) {
  context.font = `600 ${size}px system-ui`;
  const width = context.measureText(text).width + 10;
  const left = Math.min(Math.max(4, x - width / 2), MAP_WIDTH - width - 4);
  const top = Math.min(Math.max(4, y - size / 2 - 4), MAP_HEIGHT - size - 12);
  context.fillStyle = 'rgba(12,28,34,.88)';
  context.fillRect(left, top, width, size + 8);
  context.fillStyle = color;
  context.textAlign = 'left';
  context.fillText(text, left + 5, top + size + 1);
}

function drawUnknownTruth(context, labels) {
  context.fillStyle = '#b8d1dc';
  context.font = '22px system-ui';
  context.textAlign = 'center';
  context.fillText(labels.unknownTruth, MAP_WIDTH / 2, MAP_HEIGHT / 2 - 15);
  context.font = '16px system-ui';
  context.fillText(labels.unknownTruthNote, MAP_WIDTH / 2, MAP_HEIGHT / 2 + 20);
}

// Scan points accumulated up to the cursor, with the newest scan highlighted.
function drawScanPoints(context, run, cursor, { toX, toY }) {
  context.fillStyle = '#b3d9e044';
  for (let i = 0; i <= cursor; i += 2)
    for (const point of run.states[i].points)
      context.fillRect(toX(point.x) - 1, toY(point.y) - 1, 2.2, 2.2);
  context.fillStyle = '#c3eff1';
  for (const point of run.states[cursor].points)
    context.fillRect(toX(point.x) - 1.5, toY(point.y) - 1.5, 3, 3);
}

function drawPath(context, path, color, { toX, toY }, { width = 3, dash = [] } = {}) {
  context.strokeStyle = color;
  context.lineWidth = width;
  context.setLineDash(dash);
  context.beginPath();
  path.forEach((pose, i) => {
    if (i) context.lineTo(toX(pose.x), toY(pose.y));
    else context.moveTo(toX(pose.x), toY(pose.y));
  });
  context.stroke();
  context.setLineDash([]);
}

// On the estimate: the real path as a thin white dashed line and a red line from where the robot
// really is to where it thinks it is, labelled in cm (S2).
function drawTruthOverlay(context, reference, estimate, projection, labels, size) {
  const { toX, toY } = projection;
  drawPath(context, reference, TRUTH_COLOR + 'cc', projection, { width: 1.5, dash: [6, 5] });
  const truth = reference.at(-1);
  const guess = estimate.at(-1);
  if (!truth || !guess) return;
  context.strokeStyle = GAP_COLOR;
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(toX(truth.x), toY(truth.y));
  context.lineTo(toX(guess.x), toY(guess.y));
  context.stroke();
  context.fillStyle = TRUTH_COLOR;
  context.beginPath();
  context.arc(toX(truth.x), toY(truth.y), 4, 0, Math.PI * 2);
  context.fill();
  const gap = Math.hypot(truth.x - guess.x, truth.y - guess.y) * 100; // cm
  const middle = { x: (toX(truth.x) + toX(guess.x)) / 2, y: (toY(truth.y) + toY(guess.y)) / 2 };
  tag(
    context,
    labels.gap.replace('{cm}', gap.toFixed(0)),
    middle.x,
    middle.y - 22,
    '#ffc2c2',
    size,
  );
}

function drawStartRing(context, { toX, toY, k }) {
  context.setLineDash([4, 4]);
  context.strokeStyle = '#f4d38c';
  context.beginPath();
  context.arc(toX(0), toY(0), Math.max(7, START_RING_RADIUS * k), 0, Math.PI * 2);
  context.stroke();
  context.setLineDash([]);
}

function drawRobotAt(context, pose, { toX, toY }) {
  context.save();
  context.translate(toX(pose.x), toY(pose.y));
  context.scale(ROBOT_SCALE, ROBOT_SCALE);
  // The shared renderer's heading is clockwise-positive on screen; the map's theta is not.
  drawRobot(context, { x: 0, y: 0 }, { theta: -pose.theta, left: 1, right: 1 });
  context.restore();
}

function drawMapLabels(context, labels, { toX, toY, k }, size) {
  context.fillStyle = '#c7dae0';
  context.font = `${size}px system-ui`;
  context.textAlign = 'left';
  context.fillText(labels.start, toX(0) + 12, toY(0) + size + 8);
  context.strokeStyle = '#c7dae0';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(30, MAP_HEIGHT - 20);
  context.lineTo(30 + k, MAP_HEIGHT - 20);
  context.stroke();
  context.fillText('1 m', 35, MAP_HEIGHT - 26);
}

// `truth` draws the reference trajectory (simulation only); otherwise the estimate of `run`.
function drawMap(canvas, { log, run, cursor, labels }, bounds, truth) {
  const context = sharpContext(canvas, MAP_WIDTH, MAP_HEIGHT);
  const projection = mapProjection(bounds);
  const size = textSize(canvas, 16);
  drawGrid(context, bounds, projection);
  if (truth && log.scene) drawRoom(context, log.scene, projection);
  if (truth && !log.reference) {
    drawUnknownTruth(context, labels);
    return;
  }
  if (!truth && run) drawScanPoints(context, run, cursor, projection);
  const path = truth ? log.reference : run?.states || [];
  const limit = run ? cursor : 0;
  const method = run?.method || 'wheel';
  const color = truth ? '#d6e4ed' : METHOD_COLORS[method];
  const shown = path?.slice(0, limit + 1) || [];
  drawPath(context, shown, color, projection, { dash: truth ? [] : METHOD_DASHES[method] });
  drawStartRing(context, projection);
  drawRobotAt(context, path?.[limit] || { x: 0, y: 0, theta: 0 }, projection);
  if (!truth && run && log.reference)
    drawTruthOverlay(context, log.reference.slice(0, limit + 1), shown, projection, labels, size);
  drawMapLabels(context, labels, projection, size);
}

function drawMaps(truthCanvas, estimateCanvas, scene) {
  const bounds = mapBounds(scene.log, scene.run);
  drawMap(truthCanvas, scene, bounds, true);
  drawMap(estimateCanvas, scene, bounds, false);
}

// --- Sensor chart -------------------------------------------------------------------------------

const POLAR_CENTER_X = 400;
const POLAR_CENTER_Y = 168;
const POLAR_SCALE = 40; // canvas units per metre
const POLAR_RINGS = 3; // one ring per metre
const NEAR_RANGE = 0.5; // metres; closer readings are highlighted
const POLAR_ROBOT_SCALE = 0.3; // the shared robot drawing, shrunk to the 1 m rings

// Rings every metre, labelled, and the robot seen from above with its front marked (S8).
function drawLidarPolar(context, frame, labelSize) {
  context.strokeStyle = '#d2e0e5';
  context.fillStyle = '#587079';
  context.font = `${labelSize}px system-ui`;
  context.textAlign = 'left';
  for (let ring = 1; ring <= POLAR_RINGS; ring++) {
    context.beginPath();
    context.arc(POLAR_CENTER_X, POLAR_CENTER_Y, ring * POLAR_SCALE, 0, 2 * Math.PI);
    context.stroke();
    context.fillText(
      `${ring} m`,
      POLAR_CENTER_X + ring * POLAR_SCALE * 0.72 + 3,
      POLAR_CENTER_Y + ring * POLAR_SCALE * 0.72 + labelSize * 0.4,
    );
  }
  context.save();
  context.translate(POLAR_CENTER_X, POLAR_CENTER_Y);
  context.scale(POLAR_ROBOT_SCALE, POLAR_ROBOT_SCALE);
  drawRobot(context, { x: 0, y: 0 }, { theta: -Math.PI / 2, left: 0, right: 0 });
  context.restore();
  context.fillStyle = '#284c60';
  context.textAlign = 'center';
  context.fillText('▲ 前', POLAR_CENTER_X, POLAR_CENTER_Y - 3 * POLAR_SCALE - 8);
  context.textAlign = 'left';
  frame.ranges.forEach((range, i) => {
    if (range === null) return;
    const angle = frame.angleMin + i * frame.angleIncrement;
    context.fillStyle = range < NEAR_RANGE ? '#bc782d' : '#3d8c83';
    context.beginPath();
    context.arc(
      POLAR_CENTER_X - range * Math.sin(angle) * POLAR_SCALE,
      POLAR_CENTER_Y - range * Math.cos(angle) * POLAR_SCALE,
      2.6,
      0,
      Math.PI * 2,
    );
    context.fill();
  });
}

const CHART_LEFT = 76;
const CHART_RIGHT = 760;
const CHART_TOP = 54;
const CHART_BOTTOM = 254;
const CHART_ZERO_Y = 154;
const CHART_HALF_HEIGHT = 100; // canvas units from zero to the axis maximum
const CHART_TITLE_Y = 28;
const CHART_TIME_LABEL_Y = 287;
const DEGREES_PER_RADIAN = 180 / Math.PI;
const SERIES = {
  wheels: { keys: ['leftRpm', 'rightRpm'], scale: 1, floor: 50, axisLabel: '縦軸：rpm' },
  imu: { keys: ['gyroZ'], scale: DEGREES_PER_RADIAN, floor: 5, axisLabel: '縦軸：°/秒' },
};

// The axis maximum stays fixed while replaying so the curve does not rescale under the learner.
function seriesAxisMaximum(frames, { keys, scale, floor }) {
  const peak = Math.max(
    floor,
    ...frames.flatMap((frame) => keys.map((key) => Math.abs(frame[key] * scale))),
  );
  const step = peak > 20 ? 10 : 1;
  return Math.ceil(peak / step) * step;
}

// Axis labels stay readable when the responsive canvas shrinks below its logical size.
function chartLabelSize(canvas) {
  const displayedWidth = canvas.getBoundingClientRect().width || SENSOR_WIDTH;
  return Math.max(18, Math.min(32, (12 * SENSOR_WIDTH) / displayedWidth));
}

function currentReading(frame, kind) {
  if (kind === 'wheels')
    return '左 ' + frame.leftRpm.toFixed(1) + ' rpm / 右 ' + frame.rightRpm.toFixed(1) + ' rpm';
  return '回転の速さ ' + (frame.gyroZ * DEGREES_PER_RADIAN).toFixed(2) + ' °/秒';
}

function drawTimeSeries(context, canvas, log, cursor, kind) {
  const series = SERIES[kind];
  const frames = log.frames.slice(0, cursor + 1);
  const max = seriesAxisMaximum(log.frames, series);
  const endTime = log.frames.at(-1).t;
  const toX = (t) => CHART_LEFT + (t / Math.max(0.01, endTime)) * (CHART_RIGHT - CHART_LEFT);
  const toY = (value) => CHART_ZERO_Y - (value / max) * CHART_HALF_HEIGHT;
  context.font = chartLabelSize(canvas) + 'px system-ui';
  context.lineWidth = 1;
  for (const value of [-max, 0, max]) {
    context.strokeStyle = value === 0 ? '#9bafb7' : '#dae4e8';
    context.beginPath();
    context.moveTo(CHART_LEFT, toY(value));
    context.lineTo(CHART_RIGHT, toY(value));
    context.stroke();
    context.fillStyle = '#2e505c';
    context.textAlign = 'right';
    context.fillText(String(value), CHART_LEFT - 12, toY(value) + 6);
  }
  context.strokeStyle = '#9bafb7';
  context.beginPath();
  context.moveTo(CHART_LEFT, CHART_TOP);
  context.lineTo(CHART_LEFT, CHART_BOTTOM);
  context.stroke();
  series.keys.forEach((key, index) => {
    context.strokeStyle = index ? '#4a9c8c' : '#518bc7';
    context.lineWidth = 2;
    context.beginPath();
    frames.forEach((frame, i) => {
      const y = toY(frame[key] * series.scale);
      if (i) context.lineTo(toX(frame.t), y);
      else context.moveTo(toX(frame.t), y);
    });
    context.stroke();
  });
  context.fillStyle = '#2e505c';
  context.textAlign = 'left';
  context.fillText(currentReading(log.frames[cursor], kind), CHART_LEFT, CHART_TITLE_Y);
  context.textAlign = 'right';
  context.fillText(series.axisLabel, CHART_RIGHT, CHART_TITLE_Y);
  context.textAlign = 'left';
  context.fillText('0秒', CHART_LEFT, CHART_TIME_LABEL_Y);
  context.textAlign = 'center';
  context.fillText((endTime / 2).toFixed(1) + '秒', toX(endTime / 2), CHART_TIME_LABEL_Y);
  context.textAlign = 'right';
  context.fillText(endTime.toFixed(1) + '秒', CHART_RIGHT, CHART_TIME_LABEL_Y);
  context.textAlign = 'left';
}

// `sensor` is one of lidar, camera, imu, wheels; `cameraMode` is rgb or depth.
function drawSensorChart(canvas, { log, cursor, sensor, cameraMode }) {
  const context = sharpContext(canvas, SENSOR_WIDTH, SENSOR_HEIGHT);
  context.fillStyle = '#f4f8fa';
  context.fillRect(0, 0, SENSOR_WIDTH, SENSOR_HEIGHT);
  context.fillStyle = '#2e505c';
  context.font = '18px system-ui';
  context.textAlign = 'left';
  if (sensor === 'lidar') drawLidarPolar(context, log.frames[cursor], chartLabelSize(canvas));
  else if (sensor === 'camera')
    drawSlamCamera(context, log, cursor, SENSOR_WIDTH, SENSOR_HEIGHT, cameraMode);
  else drawTimeSeries(context, canvas, log, cursor, sensor);
}

// --- Tilt demo ----------------------------------------------------------------------------------

const TILT_BAR_X = 260;
const TILT_BAR_SPACING = 51; // canvas units between the x, y and z bars
const TILT_BAR_SCALE = 12; // canvas units per m/s²
const TILT_AXIS_LABELS = ['前後 x', '左右 y', '上下 z'];
const TILT_AXIS_COLORS = ['#be884c', '#5686c3', '#358879'];
// The chassis around its pivot, in canvas units: its length, and its wheels 10 below the pivot,
// which puts them on the floor line when the robot is level.
const TILT_CHASSIS = { width: 150, bottom: 10 };

// Gravity as a stationary IMU measures it, in the body frame (x forward, y left, z up).
function tiltAcceleration(pitchDegrees, rollDegrees) {
  const pitch = (pitchDegrees * Math.PI) / 180;
  const roll = (rollDegrees * Math.PI) / 180;
  return [
    -GRAVITY * Math.sin(pitch),
    GRAVITY * Math.sin(roll) * Math.cos(pitch),
    GRAVITY * Math.cos(roll) * Math.cos(pitch),
  ];
}

function drawTilt(canvas, { pitchDegrees, rollDegrees }) {
  const pitch = (pitchDegrees * Math.PI) / 180;
  const roll = (rollDegrees * Math.PI) / 180;
  const values = tiltAcceleration(pitchDegrees, rollDegrees);
  const context = sharpContext(canvas, TILT_WIDTH, TILT_HEIGHT);
  context.fillStyle = '#edf4f6';
  context.fillRect(0, 0, TILT_WIDTH, TILT_HEIGHT);
  context.strokeStyle = '#768d99';
  context.beginPath();
  context.moveTo(25, 110);
  context.lineTo(220, 110);
  context.stroke();
  // Side view of the robot body (the CAD chassis, front to the right): pitch lifts it, roll
  // rotates it.
  context.save();
  context.translate(120, 100 + pitch * 45);
  context.rotate(roll);
  drawQuestixSide(context, 0, TILT_CHASSIS.bottom, TILT_CHASSIS.width, 'base');
  context.restore();
  context.fillStyle = '#315462';
  context.font = '16px system-ui';
  TILT_AXIS_LABELS.forEach((text, i) => {
    context.fillText(text, TILT_BAR_X, 35 + i * TILT_BAR_SPACING);
    context.fillStyle = TILT_AXIS_COLORS[i];
    context.fillRect(TILT_BAR_X, 42 + i * TILT_BAR_SPACING, values[i] * TILT_BAR_SCALE, 12);
    context.fillStyle = '#315462';
  });
}

export { sharpContext, drawMaps, drawSensorChart, drawTilt, tiltAcceleration };
