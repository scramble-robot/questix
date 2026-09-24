import { LAUNCH_SPEC, LAUNCH_TOLERANCE, launchGroups, launchHit, launchRangeAxis } from './core.js';
import { drawRobot } from '../core/renderer.js';
import { formatNumber } from '../core/dom.js';
import { CHART_ROLE_COLORS, SCENE_ROLE_COLORS, roleStyle } from '../core/palette.js';
import { formatTick } from '../core/chart-scale.js';
import { fillSentence as fill } from '../core/content.js';

// Disc-launcher course: canvas and SVG drawing. Everything is drawn from the data ui.js hands in;
// this module keeps no state of its own. Colours come from the roles of js/core/palette.js: the
// flight is "actual" (green solid), the target is "target" (amber band with a dashed centre), the
// previous flight "previous" (grey dotted); the calculation without air is a white dotted line.

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

// Where a text of `width` starts when it is aligned at x.
function textLeft(x, width, align) {
  if (align === 'center') return x - width / 2;
  if (align === 'right') return x - width;
  return x;
}

// Text on a plate of the sky colour, so a label stays readable where it crosses a line.
function plateText(context, text, x, y, colour, align = 'left') {
  context.textAlign = align;
  const width = context.measureText(text).width;
  const left = textLeft(x, width, align);
  context.fillStyle = FLIGHT_COLORS.sky;
  context.fillRect(left - 3, y - 14, width + 6, 19);
  context.fillStyle = colour;
  context.fillText(text, x, y);
  context.textAlign = 'left';
}

// --- Side view of the flight -------------------------------------------------------------------

// Two layouts of the same side view. The narrow one is for phones: it shows 0–3.3 m (the longest
// flight is about 3.1 m) at the canvas's own width, so the landing point and its distance are
// always on screen, and its fonts stay ≥ 12 px once the canvas is shrunk to a 352 px card.
// Coordinates are canvas units; `scale` is canvas units per metre, the same along and above the
// floor. With the force box (forces topic) the sky is taller, so the arrows can be drawn at a
// scale where the smallest force of a flight, about 0.07 N of drag, is still ≥ 40 px on screen.
const WIDE = {
  width: 760,
  height: 350,
  scale: 145,
  muzzleX: 130,
  floorY: 278,
  lastMetre: 4,
  font: 14,
  note: 13,
};
const NARROW = {
  width: 440,
  height: 350,
  scale: 105,
  muzzleX: 66,
  floorY: 280,
  lastMetre: 3,
  font: 17,
  note: 16,
};
const FORCE_BOX_ROOM = 60; // canvas units of extra sky for the force box
const FLIGHT_LAYOUTS = {
  wide: WIDE,
  narrow: NARROW,
  wideForces: {
    ...WIDE,
    height: WIDE.height + FORCE_BOX_ROOM,
    floorY: WIDE.floorY + FORCE_BOX_ROOM,
    inset: { x: 400, y: 40, width: 348, height: 250 },
    forceScale: 600, // canvas units per newton
  },
  narrowForces: {
    ...NARROW,
    height: NARROW.height + FORCE_BOX_ROOM,
    floorY: NARROW.floorY + FORCE_BOX_ROOM,
    inset: { x: 150, y: 36, width: 284, height: 250 },
    forceScale: 800,
  },
};
const NARROW_BELOW = 600; // CSS pixels of canvas width
const FLOOR_MARGIN = 25; // canvas units between the last metre mark and the canvas edge
const SIDE_VIEW_SCALE = 145; // canvas units per metre the robot schematic was drawn at
const SIDE_VIEW_MUZZLE = { x: 130, floorY: 278 }; // where the schematic's muzzle and floor are

const FLIGHT_COLORS = {
  sky: '#17313c',
  title: '#cee0e4',
  note: '#a9c0c8',
  axis: '#54717a',
  grid: '#91adbb2e',
  tick: '#c3d4da',
  floorLabel: '#b7cbd1',
  vacuumFlight: '#f4f7f8',
  disc: '#e8eef0',
  discEdge: '#ffffff',
  landingLabel: '#e9f5ef',
  robotBody: '#a0b9be',
  robotLauncher: '#597b83',
  robotWheel: '#223f48',
  robotWheelEdge: '#a5b6b9',
  robotSensor: '#93ccd8',
  muzzle: '#c9d6da',
  insetFill: '#10262f',
  insetEdge: '#4b6873',
  velocity: '#8fa6ae',
};

// The three forces differ in lightness and line, not in hue alone, and each carries its name at
// its tip: 重力 red thin solid, 空気抵抗 white double line, 揚力 purple thick solid.
const FORCE_STYLES = {
  gravity: { colour: '#ff8f8f', width: 3, double: false, label: '重力' },
  drag: { colour: '#ffffff', width: 1.6, double: true, label: '空気抵抗' },
  lift: { colour: '#b48cff', width: 5, double: false, label: '揚力' },
};

const LANDING_MARK_RADIUS = 7; // canvas units
const GRID_ABOVE_MUZZLE = 24; // canvas units the metre lines reach above the release height
// The magnified disc in the force box: canvas units per metre, and where it sits in the box.
const INSET_DISC = { scale: 220, at: { x: 0.5, y: 0.36 } };

function flightLayout(canvas, forces) {
  const cssWidth = canvas.getBoundingClientRect().width || WIDE.width;
  if (cssWidth < NARROW_BELOW) return forces ? FLIGHT_LAYOUTS.narrowForces : NARROW;
  return forces ? FLIGHT_LAYOUTS.wideForces : WIDE;
}

const toX = (layout, metres) => layout.muzzleX + metres * layout.scale;
const toY = (layout, metres) => layout.floorY - metres * layout.scale;

function drawBackdrop(context, layout, copy) {
  context.fillStyle = FLIGHT_COLORS.sky;
  context.fillRect(0, 0, layout.width, layout.height);
  context.textAlign = 'left';
  context.font = `${layout.font}px system-ui`;
  context.fillStyle = FLIGHT_COLORS.title;
  context.fillText(copy.title, 14, 26);
  context.fillStyle = FLIGHT_COLORS.note;
  context.font = `${layout.note}px system-ui`;
  if (layout.width === WIDE.width) {
    context.fillText(copy.note, 14, 47);
    context.textAlign = 'right';
    context.fillText(copy.sameScale, layout.width - 14, 26);
    context.textAlign = 'left';
  }
}

function drawFloorAndScale(context, layout, copy) {
  const floorRight = toX(layout, layout.lastMetre) + FLOOR_MARGIN;
  const gridTop = toY(layout, LAUNCH_SPEC.height) - GRID_ABOVE_MUZZLE;
  context.strokeStyle = FLIGHT_COLORS.axis;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(toX(layout, 0), gridTop);
  context.lineTo(toX(layout, 0), layout.floorY);
  context.lineTo(floorRight, layout.floorY);
  context.stroke();
  context.font = `${layout.note}px system-ui`;
  context.textAlign = 'center';
  for (let metre = 0; metre <= layout.lastMetre; metre++) {
    context.fillStyle = FLIGHT_COLORS.tick;
    context.fillText(metre + ' m', toX(layout, metre), layout.floorY + 22);
    if (!metre) continue; // the 0 m mark already has the vertical axis
    context.strokeStyle = FLIGHT_COLORS.grid;
    context.beginPath();
    context.moveTo(toX(layout, metre), gridTop);
    context.lineTo(toX(layout, metre), layout.floorY);
    context.stroke();
  }
  context.textAlign = 'left';
  context.fillStyle = FLIGHT_COLORS.floorLabel;
  context.fillText(copy.floor, 6, layout.floorY + 22);
  plateText(
    context,
    copy.height,
    6,
    toY(layout, LAUNCH_SPEC.height) - 34,
    FLIGHT_COLORS.floorLabel,
  );
}

// Side-view schematic, paired with the existing QUESTiX top view in the mechanism panel. The
// coordinates are a drawing, not a measurement of the machine; the narrow layout shrinks it with
// the rest of the scene.
function drawRobotSideView(context, layout) {
  context.save();
  context.translate(layout.muzzleX, layout.floorY);
  context.scale(layout.scale / SIDE_VIEW_SCALE, layout.scale / SIDE_VIEW_SCALE);
  context.translate(-SIDE_VIEW_MUZZLE.x, -SIDE_VIEW_MUZZLE.floorY);
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
  context.fillRect(108, SIDE_VIEW_MUZZLE.floorY - LAUNCH_SPEC.height * SIDE_VIEW_SCALE - 2, 22, 4);
  context.restore();
}

// The target: a band on the floor ±15 cm around its centre with a dashed centre line, labelled
// 「的 1.2 m ±15 cm」 under the metre marks — the same band and words as on the record chart.
function drawTarget(context, layout, target, label) {
  const style = roleStyle('target', 'scene');
  const left = toX(layout, target - LAUNCH_TOLERANCE);
  const width = 2 * LAUNCH_TOLERANCE * layout.scale;
  const bandTop = layout.floorY - 16;
  context.fillStyle = style.color + '66';
  context.fillRect(left, bandTop, width, 16);
  context.strokeStyle = style.color;
  context.lineWidth = 1.5;
  context.strokeRect(left, bandTop, width, 16);
  context.setLineDash([8, 5]);
  context.lineWidth = style.width;
  context.beginPath();
  context.moveTo(toX(layout, target), bandTop - 26);
  context.lineTo(toX(layout, target), layout.floorY);
  context.stroke();
  context.setLineDash([]);
  context.font = `${layout.note}px system-ui`;
  plateText(context, label, toX(layout, target), layout.floorY + 46, style.color, 'center');
}

function drawTrace(context, layout, samples, { colour, width = 2, dash = [], round = false }) {
  if (!samples?.length) return;
  context.strokeStyle = colour;
  context.setLineDash(dash);
  context.lineWidth = width;
  context.lineCap = round ? 'round' : 'butt';
  context.beginPath();
  samples.forEach((sample, index) => {
    const x = toX(layout, sample.x);
    const y = toY(layout, sample.z);
    if (index) context.lineTo(x, y);
    else context.moveTo(x, y);
  });
  context.stroke();
  context.setLineDash([]);
  context.lineCap = 'butt';
}

// The disc is held flat, so from the side it is its own thin edge, at its true 180:20 proportions.
function drawDisc(context, layout, x, y, fill = FLIGHT_COLORS.disc) {
  const width = LAUNCH_SPEC.diameter * layout.scale;
  const height = Math.max(3, LAUNCH_SPEC.thickness * layout.scale);
  context.fillStyle = fill;
  context.fillRect(x - width / 2, y - height / 2, width, height);
  context.strokeStyle = FLIGHT_COLORS.discEdge;
  context.lineWidth = 1;
  context.strokeRect(x - width / 2, y - height / 2, width, height);
}

const ARROW_HEAD = 11; // canvas units
const ARROW_HEAD_SPREAD = 0.45; // radians between the shaft and each barb
const MIN_ARROW_LENGTH = 3; // canvas units: below this the head would be longer than the shaft
const DOUBLE_LINE_GAP = 2.6; // canvas units between the two strokes of the drag arrow
const ARROW_LABEL_GAP = 10; // canvas units between an arrow's tip and its name

function arrowShaft(context, x, y, dx, dy, style) {
  const length = Math.hypot(dx, dy);
  const offsets = style.double ? [-DOUBLE_LINE_GAP, DOUBLE_LINE_GAP] : [0];
  // Perpendicular unit vector, for the two strokes of a double line.
  const px = -dy / length;
  const py = dx / length;
  const shorten = ARROW_HEAD * 0.7; // the shaft ends inside the head
  const ex = x + dx - (dx / length) * shorten;
  const ey = y + dy - (dy / length) * shorten;
  context.lineWidth = style.width;
  for (const offset of offsets) {
    context.beginPath();
    context.moveTo(x + px * offset, y + py * offset);
    context.lineTo(ex + px * offset, ey + py * offset);
    context.stroke();
  }
}

function drawForceArrow(context, x, y, dx, dy, style, font) {
  const length = Math.hypot(dx, dy);
  if (length < MIN_ARROW_LENGTH) return;
  const angle = Math.atan2(dy, dx);
  context.strokeStyle = style.colour;
  context.fillStyle = style.colour;
  arrowShaft(context, x, y, dx, dy, style);
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
  context.closePath();
  context.fill();
  // The name sits just beyond the tip, on the side the arrow points to.
  context.font = `bold ${font}px system-ui`;
  context.textBaseline = 'middle';
  // An arrow pointing up or down gets its name beside the tip, so the box need not be taller.
  const vertical = Math.abs(dx) < length * VERTICAL_SHARE;
  const [labelX, labelY] = vertical
    ? [x + dx + ARROW_LABEL_GAP, y + dy - Math.sign(dy) * font * 0.6]
    : [x + dx + Math.cos(angle) * ARROW_LABEL_GAP, y + dy + Math.sin(angle) * ARROW_LABEL_GAP];
  context.textAlign = !vertical && dx < 0 ? 'right' : 'left';
  context.fillText(style.label, labelX, labelY);
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
}

const VERTICAL_SHARE = 0.3; // an arrow whose sideways part is below this share points up or down

// The forces at the moment on screen, drawn large in a box in the empty sky above the flight: a
// copy of the disc with the three arrows (canvas y grows downwards, so the weight gets a positive
// dy and the z components of drag and lift are negated) and a dotted line for the direction the
// disc is moving, which drag opposes and lift is square to.
function drawForceInset(context, layout, sample, air, copy) {
  const box = layout.inset;
  context.fillStyle = FLIGHT_COLORS.insetFill;
  context.strokeStyle = FLIGHT_COLORS.insetEdge;
  context.lineWidth = 1;
  context.fillRect(box.x, box.y, box.width, box.height);
  context.strokeRect(box.x, box.y, box.width, box.height);
  context.font = `${layout.note}px system-ui`;
  context.fillStyle = FLIGHT_COLORS.note;
  context.fillText(copy.inset, box.x + 8, box.y + box.height - 8);
  const x = box.x + box.width * INSET_DISC.at.x;
  const y = box.y + box.height * INSET_DISC.at.y;
  const speed = Math.hypot(sample.vx ?? 0, sample.vz ?? 0);
  if (speed > 0) {
    const reach = box.width * 0.32;
    context.strokeStyle = FLIGHT_COLORS.velocity;
    context.setLineDash([2, 4]);
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(x - (sample.vx / speed) * reach, y + (sample.vz / speed) * reach);
    context.lineTo(x + (sample.vx / speed) * reach, y - (sample.vz / speed) * reach);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = FLIGHT_COLORS.velocity;
    context.font = `${layout.note}px system-ui`;
    context.textAlign = 'right';
    context.fillText(copy.moving, box.x + box.width - 8, box.y + box.height - 8);
    context.textAlign = 'left';
  }
  // Only the outline, so the arrows that start at its centre are not hidden under it.
  drawDisc(context, INSET_DISC, x, y, FLIGHT_COLORS.insetFill);
  const scale = layout.forceScale;
  const font = layout.note;
  drawForceArrow(context, x, y, 0, sample.weight * scale, FORCE_STYLES.gravity, font);
  if (!air) return;
  drawForceArrow(
    context,
    x,
    y,
    sample.dragX * scale,
    -sample.dragZ * scale,
    FORCE_STYLES.drag,
    font,
  );
  drawForceArrow(
    context,
    x,
    y,
    sample.liftX * scale,
    -sample.liftZ * scale,
    FORCE_STYLES.lift,
    font,
  );
}

function drawLandingMark(context, layout, range, x) {
  const style = roleStyle('actual', 'scene');
  context.strokeStyle = style.color;
  context.lineWidth = 2.5;
  context.beginPath();
  context.arc(x, layout.floorY, LANDING_MARK_RADIUS, 0, Math.PI * 2);
  context.stroke();
  context.font = `bold ${layout.font}px system-ui`;
  const text = formatNumber(range, 2) + ' m';
  const right = layout.width - 8;
  const width = context.measureText(text).width;
  const labelX = Math.min(right - width, x + 10);
  plateText(context, text, labelX, layout.floorY - 26, FLIGHT_COLORS.landingLabel);
}

/**
 * The side view of one launch. `index` is the sample on screen; `previous` the last launch (grey
 * dotted), `reference` the same launch without air (white dotted, drawn only as far as the disc
 * on screen has got), `target` the centre of the target (m) and `forces` whether the force box is
 * shown. `copy` holds the words drawn on the canvas (content/launch.json, `scene`).
 */
function drawLaunch(
  canvas,
  { run, index = 0, reference = null, target = null, forces = false, previous = null, copy },
) {
  const layout = flightLayout(canvas, forces);
  canvas.style.aspectRatio = `${layout.width} / ${layout.height}`;
  const context = scaledContext(canvas, layout.width, layout.height);
  drawBackdrop(context, layout, copy);
  drawFloorAndScale(context, layout, copy);
  drawRobotSideView(context, layout);
  if (target !== null)
    drawTarget(context, layout, target, fill(copy.target, { target: formatNumber(target, 1) }));
  if (previous)
    drawTrace(context, layout, previous.samples, {
      colour: SCENE_ROLE_COLORS.previous,
      dash: [2, 5],
    });
  const sample = run?.samples[index] || { x: 0, z: LAUNCH_SPEC.height, t: 0, vx: 0, vz: 0 };
  if (reference && run)
    drawTrace(
      context,
      layout,
      reference.samples.filter((point) => point.t <= sample.t),
      { colour: FLIGHT_COLORS.vacuumFlight, width: 2.5, dash: [0.5, 6], round: true },
    );
  if (run)
    drawTrace(context, layout, run.samples.slice(0, index + 1), {
      colour: SCENE_ROLE_COLORS.actual,
      width: 3,
    });
  const discX = toX(layout, sample.x);
  const discY = toY(layout, sample.z);
  drawDisc(context, layout, discX, discY);
  const landed = Boolean(run) && index === run.samples.length - 1;
  if (forces && run && !landed) drawForceInset(context, layout, sample, run.config.air, copy);
  if (landed && run.status === 'landed') drawLandingMark(context, layout, run.range, discX);
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

// The chart is laid out at the width it is shown at (ui.js measures it), so its text is 13 px on
// a phone as on a Chromebook. Coordinates are CSS pixels.
const CHART = { height: 290, left: 50, right: 18, top: 30, bottom: 58 };
const CHART_FONT = 13; // px
const POWER_TICKS = [0, 20, 40, 60, 80, 100]; // percent
const POINT_RADIUS = 6; // px: hollow, so repeats at one output stay countable
const HIT_RADIUS = 2.5; // px: the inner ring that turns ○ into ◎
// The mean line is the points' colour, darker, so points and line are told apart without a legend.
const MEAN_COLOURS = { actual: '#0f6b4a', measured: '#1c5aa6' };
const CHART_TEXT = { tick: '#4d6469', title: '#3c5359', empty: '#5f757b' };

const svgText = (x, y, text, { anchor = 'start', colour = CHART_TEXT.tick, weight = 400 } = {}) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${colour}" font-size="${CHART_FONT}" font-weight="${weight}" paint-order="stroke" stroke="#fff" stroke-width="4" stroke-linejoin="round">${text}</text>`;

function chartFrame(width) {
  const plotBottom = CHART.height - CHART.bottom;
  const right = width - CHART.right;
  const x = (percent) => CHART.left + (percent / 100) * (right - CHART.left);
  return { plotBottom, right, x };
}

function chartGrid(frame, axis, y, copy) {
  let markup = svgText(8, 18, copy.yTitle, { colour: CHART_TEXT.title, weight: 600 });
  for (const value of axis.ticks) {
    const zero = value === 0;
    markup +=
      `<path d="M${CHART.left} ${y(value)}H${frame.right}" stroke="${zero ? CHART_ROLE_COLORS.axis : CHART_ROLE_COLORS.grid}" stroke-width="${zero ? 1.5 : 1}"/>` +
      svgText(CHART.left - 7, y(value) + 4, formatTick(value, axis.step), { anchor: 'end' });
  }
  for (const percent of POWER_TICKS)
    markup += svgText(frame.x(percent), frame.plotBottom + 18, percent, { anchor: 'middle' });
  markup += svgText((CHART.left + frame.right) / 2, CHART.height - 12, copy.xTitle, {
    anchor: 'middle',
    colour: CHART_TEXT.title,
    weight: 600,
  });
  return markup;
}

// The target band ±15 cm with its dashed centre and the same words as in the scene.
function chartTarget(frame, target, y, label) {
  if (target === null) return '';
  const style = roleStyle('target');
  const top = y(target + LAUNCH_TOLERANCE);
  const bottom = y(target - LAUNCH_TOLERANCE);
  return (
    `<rect x="${CHART.left}" y="${top}" width="${frame.right - CHART.left}" height="${bottom - top}" fill="${style.color}" opacity=".16"/>` +
    `<path d="M${CHART.left} ${y(target)}H${frame.right}" stroke="${style.color}" stroke-width="${style.width}" stroke-dasharray="${style.dash}"/>` +
    // On the left, where the low outputs' points sit well below any target band.
    svgText(CHART.left + 6, top - 5, label, { colour: style.color, weight: 600 })
  );
}

// Per output setting a darker line through the means and a whisker over the spread, so that
// repeats at the same output read as a range rather than as one number.
function chartMeans(frame, groups, y, role) {
  const colour = MEAN_COLOURS[role];
  const whiskers = groups
    .map(
      (group) =>
        `<path d="M${frame.x(group.power)} ${y(group.min)}V${y(group.max)}" stroke="${colour}" stroke-width="2"/>`,
    )
    .join('');
  if (groups.length <= 1) return whiskers;
  const points = groups.map((group) => frame.x(group.power) + ',' + y(group.mean)).join(' ');
  return (
    `<polyline points="${points}" fill="none" stroke="${colour}" stroke-width="3" stroke-linejoin="round"/>` +
    whiskers
  );
}

// One hollow point per launch; a launch that landed in its target's band gets an inner ring (◎).
function chartPoints(frame, rows, y, role) {
  const colour = roleStyle(role).color;
  return rows
    .map((row) => {
      const cx = frame.x(row.power);
      const cy = y(row.range);
      const ring = `<circle cx="${cx}" cy="${cy}" r="${POINT_RADIUS}" fill="#fff" fill-opacity=".85" stroke="${colour}" stroke-width="2"/>`;
      if (!launchHit(row.range, row.target)) return ring;
      return (
        ring +
        `<circle cx="${cx}" cy="${cy}" r="${HIT_RADIUS}" fill="none" stroke="${colour}" stroke-width="2"/>`
      );
    })
    .join('');
}

// Drops from the estimated output up to the target line: the reading the learner is asked to make.
function chartEstimate(frame, estimate, target, y) {
  if (!estimate?.ok) return '';
  const style = roleStyle('target');
  const x = frame.x(estimate.power);
  return (
    `<path d="M${x} ${frame.plotBottom}V${y(target)}" stroke="${style.color}" stroke-width="2" stroke-dasharray="3 4"/>` +
    `<circle cx="${x}" cy="${y(target)}" r="7" fill="#fff" stroke="${style.color}" stroke-width="2.5"/>` +
    svgText(x + 6, frame.plotBottom - 6, '約' + formatNumber(estimate.power, 0) + '%', {
      colour: style.color,
      weight: 700,
    })
  );
}

/**
 * The output → distance chart as SVG markup (view.js inserts it with unsafeHTML). `rows` are
 * `{power, range, target?}`; `target` the centre of the target band (m) or null; `width` the
 * width in CSS pixels it will be shown at; `role` 'actual' for simulated launches, 'measured'
 * for the real robot's; `copy` the chart's words (content/launch.json, `chart`).
 */
function launchChart(rows, { target = null, estimate = null, width = 680, role = 'actual', copy }) {
  const groups = launchGroups(rows);
  const axis = launchRangeAxis(rows, target);
  const frame = chartFrame(width);
  const y = (metres) => frame.plotBottom - (metres / axis.max) * (frame.plotBottom - CHART.top);
  const targetLabel = target === null ? '' : fill(copy.target, { target: formatNumber(target, 1) });
  const empty = rows.length
    ? ''
    : svgText(width / 2, (CHART.top + frame.plotBottom) / 2, copy.empty, {
        anchor: 'middle',
        colour: CHART_TEXT.empty,
      });
  return (
    `<svg class="launch-chart" viewBox="0 0 ${width} ${CHART.height}" width="${width}" height="${CHART.height}" role="img" aria-label="${copy.label}">` +
    chartGrid(frame, axis, y, copy) +
    chartTarget(frame, target, y, targetLabel) +
    chartMeans(frame, groups, y, role) +
    chartPoints(frame, rows, y, role) +
    chartEstimate(frame, estimate, target, y) +
    empty +
    '</svg>'
  );
}

export { drawLaunch, launchMechanism, drawLaunchRobot, launchChart };
