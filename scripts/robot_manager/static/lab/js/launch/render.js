import { LAUNCH_SPEC, launchGroups } from './core.js';
import { drawRobot } from '../core/renderer.js';
import { formatNumber } from '../core/dom.js';

// Disc-launcher course: canvas and SVG drawing. Everything is drawn from the data ui.js hands in;
// this module keeps no state of its own.

// --- Shared canvas helpers ---------------------------------------------------------------------

// Sizes the backing store for the display's pixel ratio and returns a context in CSS pixels, so
// that every drawing below can work in the fixed width x height coordinate system.
function scaledContext(canvas, width, height) {
  const box = canvas.getBoundingClientRect();
  const scale = ((window.devicePixelRatio || 1) * (box.width || width)) / width;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  return context;
}

const ARROW_HEAD = 8; // px
const ARROW_HEAD_SPREAD = 0.45; // radians between the shaft and each barb
const MIN_ARROW_LENGTH = 3; // px: below this the head would be longer than the shaft

function drawArrow(context, x, y, dx, dy, color, label) {
  const length = Math.hypot(dx, dy);
  if (length < MIN_ARROW_LENGTH) return;
  const angle = Math.atan2(dy, dx);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 2.4;
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x + dx, y + dy);
  context.stroke();
  context.beginPath();
  context.moveTo(x + dx, y + dy);
  context.lineTo(
    x + dx - ARROW_HEAD * Math.cos(angle - ARROW_HEAD_SPREAD),
    y + dy - ARROW_HEAD * Math.sin(angle - ARROW_HEAD_SPREAD),
  );
  context.lineTo(
    x + dx - ARROW_HEAD * Math.cos(angle + ARROW_HEAD_SPREAD),
    y + dy - ARROW_HEAD * Math.sin(angle + ARROW_HEAD_SPREAD),
  );
  context.fill();
  if (label) {
    context.font = TITLE_FONT;
    context.textAlign = dx < 0 ? 'right' : 'left';
    context.fillText(label, x + dx + (dx < 0 ? -7 : 7), y + dy - 6);
  }
}

// --- Side view of the flight -------------------------------------------------------------------

const FLIGHT_WIDTH = 760; // px
const FLIGHT_HEIGHT = 350; // px
const PIXELS_PER_METRE = 145; // the same scale along and above the floor, as the note says
const MUZZLE_X = 130; // px: where the disc leaves the launcher, i.e. 0 m
const FLOOR_Y = 278; // px
const FLOOR_RIGHT_X = 733; // px: right end of the floor line
const AXIS_TOP_Y = 80; // px
const GRID_TOP_Y = 86; // px
const LAST_METRE_MARK = 4; // metres: the furthest labelled mark on the floor
const TICK_LABEL_Y = 302; // px
const TICK_LABEL_Y_WITH_ARROWS = 338; // px: the force arrows need the room above

const TITLE_FONT = '14px system-ui';
const TICK_FONT = '13px system-ui';
const NOTE_FONT = '12px system-ui';

const FLIGHT_COLORS = {
  sky: '#17313c',
  title: '#cee0e4',
  note: '#99b2bc',
  axis: '#54717a',
  grid: '#91adbb1f',
  tick: '#adc2ca',
  floorLabel: '#a6bec5',
  gravity: '#eea49a',
  drag: '#b6b6ec',
  lift: '#9adcca',
  targetBand: '#e8bf7938',
  targetLine: '#edca81',
  targetLabel: '#f1d49b',
  flight: '#91decc',
  previousFlight: '#b6c6ce66',
  vacuumFlight: '#e6c58a',
  disc: '#f4cf90',
  discEdge: '#ffebc7',
  landingMark: '#f2d49b',
  landingLabel: '#ecdcba',
  scaleNote: '#aac2ca',
  robotBody: '#a0b9be',
  robotLauncher: '#597b83',
  robotWheel: '#223f48',
  robotWheelEdge: '#a5b6b9',
  robotSensor: '#93ccd8',
  muzzle: '#efc887',
};

// Same order and colours as the arrows drawn on the disc.
const FORCE_LEGEND = [
  { color: FLIGHT_COLORS.gravity, title: '重力' },
  { color: FLIGHT_COLORS.drag, title: '空気抵抗' },
  { color: FLIGHT_COLORS.lift, title: '揚力' },
];

const TARGET_TOLERANCE = 0.15; // metres either side of the centre; ui.js decides hits with it
const FORCE_ARROW_SCALE = 220; // pixels per newton
const LANDING_MARK_RADIUS = 6; // px
const LANDING_LABEL_MAX_X = 677; // px: keeps the distance label inside the canvas

const metresToX = (metres) => MUZZLE_X + metres * PIXELS_PER_METRE;
const metresToY = (metres) => FLOOR_Y - metres * PIXELS_PER_METRE;

function drawBackdrop(context, showForces) {
  context.fillStyle = FLIGHT_COLORS.sky;
  context.fillRect(0, 0, FLIGHT_WIDTH, FLIGHT_HEIGHT);
  context.font = TITLE_FONT;
  context.fillStyle = FLIGHT_COLORS.title;
  context.fillText('横から見た飛行', 22, 28);
  context.fillStyle = FLIGHT_COLORS.note;
  context.font = NOTE_FONT;
  context.fillText('射出口を0 mとして、最初に床に触れた位置を測る', 22, 49);
  if (!showForces) return;
  context.font = TITLE_FONT;
  context.textAlign = 'left';
  FORCE_LEGEND.forEach(({ color, title }, index) => {
    const x = 265 + index * 145;
    context.fillStyle = color;
    context.fillRect(x, 65, 20, 3);
    context.fillText(title, x + 29, 72);
  });
}

function drawFloorAndScale(context, showForces) {
  context.strokeStyle = FLIGHT_COLORS.axis;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(metresToX(0), AXIS_TOP_Y);
  context.lineTo(metresToX(0), FLOOR_Y);
  context.lineTo(FLOOR_RIGHT_X, FLOOR_Y);
  context.stroke();
  const labelY = showForces ? TICK_LABEL_Y_WITH_ARROWS : TICK_LABEL_Y;
  for (let metre = 0; metre <= LAST_METRE_MARK; metre++) {
    context.fillStyle = FLIGHT_COLORS.tick;
    context.font = TICK_FONT;
    context.textAlign = 'center';
    context.fillText(metre + ' m', metresToX(metre), labelY);
    if (!metre) continue; // the 0 m mark already has the vertical axis
    context.strokeStyle = FLIGHT_COLORS.grid;
    context.beginPath();
    context.moveTo(metresToX(metre), GRID_TOP_Y);
    context.lineTo(metresToX(metre), FLOOR_Y);
    context.stroke();
  }
  context.textAlign = 'left';
  context.fillStyle = FLIGHT_COLORS.floorLabel;
  context.font = TICK_FONT;
  context.fillText('床', 27, 291);
  context.font = NOTE_FONT;
  context.fillText('高さ45 cm（仮定）', 14, 185);
}

// Side-view schematic, paired with the existing QUESTiX top view in the mechanism panel. The
// coordinates are a drawing, not a measurement of the machine.
function drawRobotSideView(context) {
  context.fillStyle = FLIGHT_COLORS.robotBody;
  context.fillRect(45, 223, 66, 32);
  context.fillStyle = FLIGHT_COLORS.robotLauncher;
  context.fillRect(67, 207, 57, 16);
  context.fillStyle = FLIGHT_COLORS.robotWheel;
  context.strokeStyle = FLIGHT_COLORS.robotWheelEdge;
  context.lineWidth = 2;
  context.beginPath();
  context.arc(67, 261, 15, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.fillStyle = FLIGHT_COLORS.robotSensor;
  context.fillRect(103, 230, 8, 8);
  context.fillStyle = FLIGHT_COLORS.muzzle;
  context.fillRect(108, metresToY(LAUNCH_SPEC.height) - 2, 22, 4);
}

function drawTarget(context, target) {
  context.fillStyle = FLIGHT_COLORS.targetBand;
  context.fillRect(
    metresToX(target - TARGET_TOLERANCE),
    260,
    2 * TARGET_TOLERANCE * PIXELS_PER_METRE,
    18,
  );
  context.strokeStyle = FLIGHT_COLORS.targetLine;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(metresToX(target), 245);
  context.lineTo(metresToX(target), FLOOR_Y);
  context.stroke();
  context.fillStyle = FLIGHT_COLORS.targetLabel;
  context.textAlign = 'center';
  context.font = NOTE_FONT;
  context.fillText('的 ' + formatNumber(target) + ' m', metresToX(target), 326);
}

function drawTrace(context, samples, color, dash = []) {
  if (!samples?.length) return;
  context.strokeStyle = color;
  context.setLineDash(dash);
  context.lineWidth = 2;
  context.beginPath();
  samples.forEach((sample, index) => {
    const x = metresToX(sample.x);
    const y = metresToY(sample.z);
    if (index) context.lineTo(x, y);
    else context.moveTo(x, y);
  });
  context.stroke();
  context.setLineDash([]);
}

// The disc is held flat, so from the side it is its own thin edge, at its true 180:20 proportions.
function drawDisc(context, x, y) {
  const halfWidth = (LAUNCH_SPEC.diameter / 2) * PIXELS_PER_METRE;
  const halfHeight = (LAUNCH_SPEC.thickness / 2) * PIXELS_PER_METRE;
  const width = LAUNCH_SPEC.diameter * PIXELS_PER_METRE;
  const height = LAUNCH_SPEC.thickness * PIXELS_PER_METRE;
  context.fillStyle = FLIGHT_COLORS.disc;
  context.fillRect(x - halfWidth, y - halfHeight, width, height);
  context.strokeStyle = FLIGHT_COLORS.discEdge;
  context.lineWidth = 1;
  context.strokeRect(x - halfWidth, y - halfHeight, width, height);
}

// Canvas y grows downwards, so weight (which pulls down) gets a positive dy and the z components
// of drag and lift are negated.
function drawForceArrows(context, x, y, sample, air) {
  drawArrow(context, x, y, 0, sample.weight * FORCE_ARROW_SCALE, FLIGHT_COLORS.gravity);
  if (!air) return;
  const scale = FORCE_ARROW_SCALE;
  drawArrow(context, x, y, sample.dragX * scale, -sample.dragZ * scale, FLIGHT_COLORS.drag);
  drawArrow(context, x, y, sample.liftX * scale, -sample.liftZ * scale, FLIGHT_COLORS.lift);
}

function drawLandingMark(context, range, x) {
  context.strokeStyle = FLIGHT_COLORS.landingMark;
  context.lineWidth = 1;
  context.beginPath();
  context.arc(x, FLOOR_Y, LANDING_MARK_RADIUS, 0, Math.PI * 2);
  context.stroke();
  context.fillStyle = FLIGHT_COLORS.landingLabel;
  context.textAlign = 'left';
  context.font = TITLE_FONT;
  context.fillText(formatNumber(range, 2) + ' m', Math.min(LANDING_LABEL_MAX_X, x + 10), 263);
}

function drawScaleNote(context) {
  context.textAlign = 'right';
  context.fillStyle = FLIGHT_COLORS.scaleNote;
  context.font = NOTE_FONT;
  context.fillText('横の位置と高さは同じ縮尺', 736, 28);
}

function drawLaunch(
  canvas,
  { run, index = 0, reference = null, target = null, forces = false, previous = null },
) {
  const context = scaledContext(canvas, FLIGHT_WIDTH, FLIGHT_HEIGHT);
  drawBackdrop(context, forces);
  drawFloorAndScale(context, forces);
  drawRobotSideView(context);
  if (target !== null) drawTarget(context, target);
  if (previous) drawTrace(context, previous.samples, FLIGHT_COLORS.previousFlight, [3, 5]);
  const sample = run?.samples[index] || { x: 0, z: LAUNCH_SPEC.height, t: 0 };
  // The comparison run is only drawn as far as the flight being watched has got.
  if (reference && run)
    drawTrace(
      context,
      reference.samples.filter((point) => point.t <= sample.t),
      FLIGHT_COLORS.vacuumFlight,
      [5, 5],
    );
  if (run) drawTrace(context, run.samples.slice(0, index + 1), FLIGHT_COLORS.flight);
  const discX = metresToX(sample.x);
  const discY = metresToY(sample.z);
  drawDisc(context, discX, discY);
  const landed = Boolean(run) && index === run.samples.length - 1;
  if (forces && run && !landed) drawForceArrows(context, discX, discY, sample, run.config.air);
  if (landed && run.status === 'landed') drawLandingMark(context, run.range, discX);
  drawScaleNote(context);
}

// --- Top view of the launcher ------------------------------------------------------------------

const ROBOT_VIEW_WIDTH = 180; // px
const ROBOT_VIEW_HEIGHT = 130; // px

// The parts below are joined without any whitespace between them: they are inserted as markup, and
// stray text nodes would change the layout of the schematic.
const ROBOT_TOP_VIEW =
  '<div><canvas id="launchRobot" width="180" height="130" role="img" aria-label="QUESTiXを上から見た図"></canvas><span>機体は止めて射出</span></div>';
const LAUNCHER_TOP_VIEW =
  '<svg viewBox="0 0 420 160" role="img" aria-label="水平なディスクを、1つの駆動ローラが押し出す仮の機構。上から見た模式図。"><defs><marker id="launchArrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0 0L7 3L0 6" fill="none" stroke="#427d77"/></marker></defs><text x="18" y="22" fill="#49616b" font-size="14">上から見た射出部（機構は仮定）</text><path d="M40 126H260" stroke="#9aaeb2" stroke-width="6"/><circle cx="144" cy="85" r="39" fill="#f5ce8e" stroke="#aa7d3d"/><circle cx="142" cy="36" r="12" fill="#52797c"/><path d="M193 84H278" stroke="#427d77" stroke-width="3" marker-end="url(#launchArrow)"/><path d="M103 31H75" stroke="#52797c"/><text x="18" y="51" fill="#49616b" font-size="12">駆動ローラ1つ</text><text x="279" y="89" fill="#427d77" font-size="14">押し出す</text><text x="112" y="149" fill="#49616b" font-size="12">案内部</text><path d="M176 43Q205 85 177 122" fill="none" stroke="#9f753c" stroke-dasharray="3 3"/><text x="279" y="120" fill="#7d622f" font-size="12">回転も生じ得る</text></svg>';
const DISC_DIMENSIONS =
  '<div class="launch-disc-dim"><svg viewBox="0 0 150 110" role="img" aria-label="ディスクの直径180 mm、厚み20 mm"><ellipse cx="75" cy="44" rx="50" ry="18" fill="#f5ce8e" stroke="#af8448"/><path d="M25 44V55C25 79 125 79 125 55V44" fill="#dfb775" stroke="#af8448"/><path d="M25 23H125M25 19V27M125 19V27" stroke="#64797a"/><text x="75" y="15" text-anchor="middle" fill="#49616b" font-size="12">直径180 mm</text><text x="75" y="101" text-anchor="middle" fill="#49616b" font-size="12">厚み20 mm</text></svg><span>高発泡ポリエチレン</span></div>';

// Returns markup (view.js inserts it with unsafeHTML); the canvas inside is filled by
// drawLaunchRobot once it is in the document.
function launchMechanism() {
  return (
    '<div class="launch-mechanism">' +
    ROBOT_TOP_VIEW +
    LAUNCHER_TOP_VIEW +
    DISC_DIMENSIONS +
    '</div>'
  );
}

function drawLaunchRobot(canvas) {
  const context = scaledContext(canvas, ROBOT_VIEW_WIDTH, ROBOT_VIEW_HEIGHT);
  context.clearRect(0, 0, ROBOT_VIEW_WIDTH, ROBOT_VIEW_HEIGHT);
  context.save();
  context.translate(88, 65);
  context.scale(0.85, 0.85);
  drawRobot(context, { x: 0, y: 0 }, { theta: 0, left: 0, right: 0 });
  context.restore();
}

// --- Output against distance chart -------------------------------------------------------------

const CHART_LEFT = 62; // px: the vertical axis
const CHART_RIGHT = 642; // px
const CHART_TOP = 50; // px
const CHART_BASE = 234; // px: 0 m
const CHART_PLOT_HEIGHT = 184; // px between 0 m and the top of the scale
const CHART_GRID_STEPS = 3; // gridlines above 0 m
const PIXELS_PER_PERCENT = 5.8;
const CHART_MIN_RANGE = 3.5; // metres: keeps the first few records from filling the whole chart
const CHART_HEADROOM = 1.1; // leaves room above the furthest record
const CHART_COLORS = {
  axis: '#81969c',
  axisTitle: '#536c75',
  grid: '#e2e9e8',
  tick: '#657b81',
  data: '#44877c',
  target: '#bc8b3f',
  targetLabel: '#8c6d3d',
  empty: '#667e85',
};
const CHART_LABEL =
  '横軸はモーターへの出力指示0から100%、縦軸は飛距離。点が1枚ごとの結果、線は同じ出力の平均を結んだものです。';

const percentToX = (percent) => CHART_LEFT + percent * PIXELS_PER_PERCENT;
const chartRangeToY = (range, max) => CHART_BASE - (range / max) * CHART_PLOT_HEIGHT;

function chartGrid(max) {
  let markup = '';
  for (let step = 0; step <= CHART_GRID_STEPS; step++) {
    const y = CHART_BASE - (step * CHART_PLOT_HEIGHT) / CHART_GRID_STEPS;
    const metres = (step * max) / CHART_GRID_STEPS;
    markup +=
      `<path d="M${CHART_LEFT} ${y}H${CHART_RIGHT}" stroke="${CHART_COLORS.grid}"/>` +
      `<text x="51" y="${y + 4}" text-anchor="end" fill="${CHART_COLORS.tick}" font-size="12">${formatNumber(metres)}</text>`;
  }
  return markup;
}

function chartAxes() {
  const ticks = [0, 20, 40, 60, 80, 100]
    .map(
      (percent) =>
        `<text x="${percentToX(percent)}" y="254" text-anchor="middle" fill="${CHART_COLORS.tick}" font-size="12">${percent}</text>`,
    )
    .join('');
  return (
    `<path d="M${CHART_LEFT} ${CHART_TOP}V${CHART_BASE}H${CHART_RIGHT}" fill="none" stroke="${CHART_COLORS.axis}"/>` +
    ticks +
    `<text x="352" y="279" text-anchor="middle" fill="${CHART_COLORS.axisTitle}" font-size="14">モーターへの出力指示（%）</text>`
  );
}

function chartTargetLine(target, max) {
  if (target === null) return '';
  const y = chartRangeToY(target, max);
  return (
    `<path d="M${CHART_LEFT} ${y}H${CHART_RIGHT}" stroke="${CHART_COLORS.target}" stroke-dasharray="5 5"/>` +
    `<text x="651" y="${y + 4}" fill="${CHART_COLORS.targetLabel}" font-size="12">的</text>`
  );
}

// One point per launch, and per output setting a line through the means with a whisker over the
// spread, so that repeats at the same output read as a range rather than as one number.
function chartMeanLine(groups, max) {
  if (groups.length <= 1) return '';
  const points = groups
    .map((group) => percentToX(group.power) + ',' + chartRangeToY(group.mean, max))
    .join(' ');
  return `<polyline points="${points}" fill="none" stroke="${CHART_COLORS.data}" stroke-width="2"/>`;
}

function chartPoints(rows, max) {
  return rows
    .map(
      (row) =>
        `<circle cx="${percentToX(row.power)}" cy="${chartRangeToY(row.range, max)}" r="4" fill="${CHART_COLORS.data}" opacity=".65"/>`,
    )
    .join('');
}

function chartSpread(groups, max) {
  return groups
    .map(
      (group) =>
        `<path d="M${percentToX(group.power)} ${chartRangeToY(group.min, max)}V${chartRangeToY(group.max, max)}" stroke="${CHART_COLORS.data}" stroke-width="2"/>`,
    )
    .join('');
}

// Drops from the estimated output up to the target line: the reading the learner is asked to make.
function chartEstimate(estimate, target, max) {
  if (!estimate?.ok) return '';
  const x = percentToX(estimate.power);
  const y = chartRangeToY(target, max);
  return (
    `<path d="M${x} ${CHART_BASE}V${y}" stroke="${CHART_COLORS.target}" stroke-dasharray="3 4"/>` +
    `<circle cx="${x}" cy="${y}" r="6" fill="#fff" stroke="${CHART_COLORS.target}" stroke-width="2"/>`
  );
}

function chartEmptyNote(rows) {
  if (rows.length) return '';
  return `<text x="350" y="142" text-anchor="middle" fill="${CHART_COLORS.empty}" font-size="15">実験すると、ここに測定点が増えます</text>`;
}

// Returns SVG markup (view.js inserts it with unsafeHTML).
function launchChart(rows, target = null, estimate = null) {
  const groups = launchGroups(rows);
  const max =
    Math.max(CHART_MIN_RANGE, target || 0, ...rows.map((row) => row.range)) * CHART_HEADROOM;
  return (
    `<svg class="launch-chart" viewBox="0 0 720 288" role="img" aria-label="${CHART_LABEL}">` +
    `<text x="20" y="25" fill="${CHART_COLORS.axisTitle}" font-size="14">飛距離（m）</text>` +
    chartGrid(max) +
    chartAxes() +
    chartTargetLine(target, max) +
    chartMeanLine(groups, max) +
    chartPoints(rows, max) +
    chartSpread(groups, max) +
    chartEstimate(estimate, target, max) +
    chartEmptyNote(rows) +
    '</svg>'
  );
}

export { drawLaunch, launchMechanism, drawLaunchRobot, launchChart };
