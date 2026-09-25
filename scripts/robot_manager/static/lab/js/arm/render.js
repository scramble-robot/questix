import { ARM_OBSTACLE, armFK, armSegmentDistance, so101FK } from './core.js';
import { roleStyle } from '../core/palette.js';

import { drawQuestixSide, questixSideLayout } from '../core/questix-views.js';

// Canvas drawings of the arm course: the side view of the teaching model and the 3-D sketch of
// SO-ARM101. Both draw from data handed in by ui.js and keep no state of their own.
//
// One drawing unit is one CSS pixel, so text sizes are what the learner sees (never under 12 px,
// CONTRIBUTING.md "Figures and charts"). The side view fits a millimetre range to the width of
// its box: a phone shows the part the arm can reach, a wide screen a little more around it.
// Legends and titles are HTML next to the canvas (view.js).

const NARROW_WIDTH = 600; // px: below this the side view shows the narrow range
const FALLBACK_WIDTH = 760; // px: box width while the course page is still hidden
const SIDE_RANGES = {
  narrow: { x: [-170, 340], z: [-160, 300] }, // mm
  wide: { x: [-300, 420], z: [-160, 300] }, // mm
};
const SIDE_MARGIN = { left: 42, right: 12, top: 30, bottom: 30 }; // px around the grid
// px: the grid of a wide view stops growing here, so figure and key fit a 768 px high screen;
// the extra width then shows more of the x range (a third on the left, the rest on the right).
const MAX_GRID_HEIGHT = 420;
const BASE_SCALE = 0.62; // px per mm the robot body and bar widths were drawn for
// The chassis under the arm, in px at BASE_SCALE: its length (a sketch, not to scale) and how far
// its top plate sits below `robot`'s y. The side view leaves room under the shoulder for the θ₁
// label; the 3-D sketch keeps a shorter chassis right under the base, clear of the y axis label.
const SIDE_VIEW_BASE = { length: 200, plateBelow: 24 };
const SO101_BASE = { length: 132, plateBelow: 5 };
const BASE_HALO = 'rgba(214, 238, 244, 0.45)';
const SO101_ASPECT = 490 / 760; // height / width of the 3-D sketch
const TEXT = 13; // px: labels in the figure
const SMALL_TEXT = 12; // px: tick labels, the smallest text a figure may show

// Shoulder, elbow, wrist bend, wrist roll, gripper — also the colours of the side-view links.
// The side view calls the first two 「緑の棒」 and 「青い棒」 (content/arm.json).
const PART_COLORS = ['#83d7c2', '#96b8ed', '#ebc882', '#b6a4e8', '#e3a488'];
const TIP_COLOR = '#f4ede0';
const GRID_STEP = 100; // mm between grid lines
const REACH_RADII = [30, 290]; // mm: folded back and stretched out
// Pure, saturated axis colours, well apart from the pastel link colours above (A8).
const AXIS_COLORS = { x: '#e5484d', y: '#2fa84f', z: '#3b82f6' };
const AXIS_NAMES = { x: 'x（前）', y: 'y（左）', z: 'z（上）' };
const TARGET = roleStyle('target', 'scene');
const DANGER = roleStyle('danger', 'scene');
const ANGLE_ARC_PX = 34; // radius of the angle arcs
const WIDE_ARC_DEGREES = 50; // an arc at least this wide carries its value inside

/**
 * Where the side view puts the millimetre grid inside a box `width` px wide:
 * `{width, height, scale, range, toPixels(point), toModel(x, y)}`. No DOM, so it is tested in Node.
 */
function armSceneFrame(width) {
  const base = width < NARROW_WIDTH ? SIDE_RANGES.narrow : SIDE_RANGES.wide;
  const gridWidth = width - SIDE_MARGIN.left - SIDE_MARGIN.right;
  const spanZ = base.z[1] - base.z[0];
  const scale = Math.min(gridWidth / (base.x[1] - base.x[0]), MAX_GRID_HEIGHT / spanZ); // px/mm
  const extra = gridWidth / scale - (base.x[1] - base.x[0]); // mm the capped scale leaves over
  const range = { x: [base.x[0] - extra / 3, base.x[1] + (extra * 2) / 3], z: base.z };
  const height = Math.round(SIDE_MARGIN.top + SIDE_MARGIN.bottom + spanZ * scale);
  const toPixels = (point) => ({
    x: SIDE_MARGIN.left + (point.x - range.x[0]) * scale,
    y: SIDE_MARGIN.top + (range.z[1] - point.z) * scale,
  });
  const toModel = (x, y) => ({
    x: Math.round((x - SIDE_MARGIN.left) / scale + range.x[0]),
    z: Math.round(range.z[1] - (y - SIDE_MARGIN.top) / scale),
  });
  return { width, height, scale, range, narrow: width < NARROW_WIDTH, toPixels, toModel };
}

const boxWidth = (canvas) => canvas.getBoundingClientRect().width || FALLBACK_WIDTH;

// Where in the teaching model (mm) the learner clicked.
function armScenePoint(canvas, event) {
  const box = canvas.getBoundingClientRect();
  return armSceneFrame(boxWidth(canvas)).toModel(event.clientX - box.left, event.clientY - box.top);
}

// Resizes the canvas to `width` × `height` CSS px (its CSS height follows from the aspect ratio)
// and returns a cleared context whose units are CSS px.
function context(canvas, width, height) {
  const pixelRatio = globalThis.devicePixelRatio || 1;
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.fillStyle = '#192f3b';
  ctx.fillRect(0, 0, width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  return ctx;
}

function line(ctx, from, to, color, width = 1, dash = []) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);
}

function text(ctx, label, x, y, color = '#bdcdd5', size = TEXT, align = 'left') {
  ctx.font = `${size}px system-ui, sans-serif`;
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(label, x, y);
  ctx.textAlign = 'left';
}

// A label on a dark pill, readable over the grid, the links and the reach ring; kept inside the
// canvas so a label near the edge is never cut.
function badge(ctx, label, atX, y, color = '#f4f8f9', size = TEXT) {
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  const width = ctx.measureText(label).width + 10;
  const canvasWidth = ctx.canvas.width / ctx.getTransform().a;
  const x = Math.min(Math.max(atX, width / 2 + 2), canvasWidth - width / 2 - 2);
  ctx.fillStyle = '#0d202ae6';
  ctx.beginPath();
  ctx.roundRect(x - width / 2, y - size / 2 - 4, width, size + 8, 6);
  ctx.fill();
  text(ctx, label, x, y + size / 2 - 2, color, size, 'center');
}

function joint(ctx, at, color, radius) {
  ctx.fillStyle = '#18303d';
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(at.x, at.y, 3, 0, Math.PI * 2);
  ctx.fill();
}

// A bar between two joints. The ghost is a pose the arm is about to reach: thin and translucent.
function link(ctx, from, to, color, size, ghost = false) {
  line(ctx, from, to, ghost ? color + '66' : '#0d202a', ghost ? 6 : size * 1.75);
  line(ctx, from, to, ghost ? color + '88' : color, ghost ? 3 : size);
}

// The robot the arm is mounted on: the CAD chassis (the 'base' view of js/core/questix-art.js,
// front to the right) with its top plate `plateBelow` below `y`, and the post from the plate up
// to the shoulder. `size` scales both with the grid; a faint light halo keeps the dark chassis
// visible on the dark grid.
function robot(ctx, x, y, size = 1, { plateBelow, length } = SIDE_VIEW_BASE) {
  const width = length * size;
  const plate = y + plateBelow * size;
  const chassisHeight = -questixSideLayout(x, 0, width, 'base').top; // top above 0
  ctx.save();
  ctx.shadowColor = BASE_HALO;
  ctx.shadowBlur = Math.max(4, 6 * size);
  drawQuestixSide(ctx, x, plate + chassisHeight, width, 'base');
  ctx.restore();
  line(ctx, { x, y: plate }, { x, y: y - 4 * size }, '#9bb4bb', 13 * size);
}

// Green ring: everywhere the two bars can reach on length alone.
function reachRing(ctx, frame, origin) {
  ctx.fillStyle = '#497f7040';
  ctx.beginPath();
  ctx.arc(origin.x, origin.y, REACH_RADII[1] * frame.scale, 0, Math.PI * 2);
  ctx.arc(origin.x, origin.y, REACH_RADII[0] * frame.scale, 0, Math.PI * 2, true);
  ctx.fill('evenodd');
  ctx.strokeStyle = '#83d7c288';
  ctx.lineWidth = 1;
  for (const radius of REACH_RADII) {
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, radius * frame.scale, 0, Math.PI * 2);
    ctx.stroke();
  }
}

const gridValues = ([low, high]) => {
  const values = [];
  for (let value = Math.ceil(low / GRID_STEP) * GRID_STEP; value <= high; value += GRID_STEP)
    values.push(value);
  return values;
};

function sideGrid(ctx, frame) {
  const { range, toPixels } = frame;
  const left = range.x[0];
  const right = range.x[1];
  const bottom = range.z[0];
  const top = range.z[1];
  for (const x of gridValues(range.x)) {
    line(ctx, toPixels({ x, z: bottom }), toPixels({ x, z: top }), '#91a8b424');
    text(
      ctx,
      String(x),
      toPixels({ x, z: 0 }).x,
      frame.height - 10,
      '#a3b8c2',
      SMALL_TEXT,
      'center',
    );
  }
  for (const z of gridValues(range.z)) {
    line(ctx, toPixels({ x: left, z }), toPixels({ x: right, z }), '#91a8b424');
    text(
      ctx,
      String(z),
      SIDE_MARGIN.left - 6,
      toPixels({ x: 0, z }).y + 4,
      '#a3b8c2',
      SMALL_TEXT,
      'right',
    );
  }
  line(ctx, toPixels({ x: left, z: 0 }), toPixels({ x: right, z: 0 }), '#94acb977');
  line(ctx, toPixels({ x: 0, z: bottom }), toPixels({ x: 0, z: top }), '#94acb977');
  text(ctx, 'x 横（mm）→', frame.width - 6, frame.height - 10 - 16, '#c5d5dc', TEXT, 'right');
  text(ctx, '↑ z 高さ（mm）', SIDE_MARGIN.left + 4, 18, '#c5d5dc', TEXT);
}

// The post, named in the figure unless the contact label takes its place.
function post(ctx, frame, named) {
  const at = frame.toPixels(ARM_OBSTACLE);
  ctx.fillStyle = '#8a6f64';
  ctx.beginPath();
  ctx.arc(at.x, at.y, ARM_OBSTACLE.r * frame.scale, 0, Math.PI * 2);
  ctx.fill();
  if (named) badge(ctx, '支柱', at.x, at.y + ARM_OBSTACLE.r * frame.scale + 14, '#f0d2c6');
}

// The path the tip has travelled so far: dotted, in the colour of the tip.
function trail(ctx, frame, trace) {
  ctx.strokeStyle = TIP_COLOR + 'b0';
  ctx.lineWidth = 2;
  ctx.setLineDash([2, 5]);
  ctx.beginPath();
  trace.forEach((point, index) => {
    const at = frame.toPixels(point);
    if (index) ctx.lineTo(at.x, at.y);
    else ctx.moveTo(at.x, at.y);
  });
  ctx.stroke();
  ctx.setLineDash([]);
}

// Dashed steps that split each bar into how far it reaches sideways and how far up.
function projections(ctx, frame, pose, origin) {
  const { toPixels } = frame;
  const { elbow, tip } = pose;
  line(ctx, origin, toPixels({ x: elbow.x, z: 0 }), PART_COLORS[0], 2, [5, 5]);
  line(ctx, toPixels({ x: elbow.x, z: 0 }), toPixels(elbow), PART_COLORS[0], 2, [5, 5]);
  line(ctx, toPixels(elbow), toPixels({ x: tip.x, z: elbow.z }), PART_COLORS[1], 2, [5, 5]);
  line(ctx, toPixels({ x: tip.x, z: elbow.z }), toPixels(tip), PART_COLORS[1], 2, [5, 5]);
}

// An arc from `from` to `to` (degrees, counter-clockwise positive as in the lesson) with an arrow
// head at `to` and the value written at the middle of the arc.
function angleArc(ctx, centre, from, to, color, label) {
  if (Math.abs(to - from) < 1) return;
  const start = (-from * Math.PI) / 180; // the canvas y axis points down
  const end = (-to * Math.PI) / 180;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, ANGLE_ARC_PX, start, end, to > from);
  ctx.stroke();
  const tip = {
    x: centre.x + ANGLE_ARC_PX * Math.cos(end),
    y: centre.y + ANGLE_ARC_PX * Math.sin(end),
  };
  const tangent = end + (to > from ? -Math.PI / 2 : Math.PI / 2);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tip.x + 7 * Math.cos(tangent), tip.y + 7 * Math.sin(tangent));
  ctx.lineTo(tip.x + 4 * Math.cos(tangent + 2.3), tip.y + 4 * Math.sin(tangent + 2.3));
  ctx.lineTo(tip.x + 4 * Math.cos(tangent - 2.3), tip.y + 4 * Math.sin(tangent - 2.3));
  ctx.fill();
  // A wide arc has room for its value inside; a narrow one would put the value on the bar, so
  // the value goes just outside the arc, on the side of the reference line.
  const wide = Math.abs(to - from) >= WIDE_ARC_DEGREES;
  const labelAngle = wide ? (from + to) / 2 : from - Math.sign(to - from) * 20;
  const radians = (-labelAngle * Math.PI) / 180;
  const radius = ANGLE_ARC_PX + (wide ? 22 : 30);
  badge(
    ctx,
    label,
    centre.x + radius * Math.cos(radians),
    centre.y + radius * Math.sin(radians),
    color,
  );
}

const roundDegrees = (value) => String(Math.round(value) || 0);

// θ₁ from the +x direction to the first bar, θ₂ from the first bar's extension to the second (A4).
function jointAngles(ctx, frame, pose, q) {
  const origin = frame.toPixels({ x: 0, z: 0 });
  const elbow = frame.toPixels(pose.elbow);
  line(
    ctx,
    origin,
    { x: origin.x + ANGLE_ARC_PX + 12, y: origin.y },
    PART_COLORS[0] + 'aa',
    1.5,
    [4, 4],
  );
  angleArc(ctx, origin, 0, q[0], PART_COLORS[0], `θ₁ ${roundDegrees(q[0])}°`);
  const direction = (q[0] * Math.PI) / 180;
  const extension = frame.toPixels({
    x: pose.elbow.x + 70 * Math.cos(direction),
    z: pose.elbow.z + 70 * Math.sin(direction),
  });
  line(ctx, elbow, extension, PART_COLORS[1] + 'aa', 1.5, [4, 4]);
  angleArc(ctx, elbow, q[0], q[0] + q[1], PART_COLORS[1], `θ₂ ${roundDegrees(q[1])}°`);
}

function goalMark(ctx, frame, target) {
  const at = frame.toPixels(target);
  ctx.strokeStyle = TARGET.color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(at.x, at.y, 8, 0, Math.PI * 2);
  ctx.stroke();
  line(ctx, { x: at.x - 14, y: at.y }, { x: at.x + 14, y: at.y }, TARGET.color, 2);
  line(ctx, { x: at.x, y: at.y - 14 }, { x: at.x, y: at.y + 14 }, TARGET.color, 2);
  badge(ctx, '目標', at.x + 30, at.y - 14, '#f3d68b');
}

// A pose the arm may go to: thin outline, with its name (姿勢A/B) at the elbow.
function ghostPose(ctx, frame, origin, ghost) {
  const pose = armFK(ghost.q);
  const elbow = frame.toPixels(pose.elbow);
  const color = ghost.selected === false ? '#8fa3ab' : '#e3eef2';
  link(ctx, origin, elbow, color, 0, true);
  link(ctx, elbow, frame.toPixels(pose.tip), color, 0, true);
  if (ghost.label) badge(ctx, ghost.label, elbow.x, elbow.y - 18, color);
}

// Where the arm touches the post: the nearest point of the nearer bar, outlined red (A7).
function contactMark(ctx, frame, pose, size) {
  const bars = [
    [pose.base, pose.elbow],
    [pose.elbow, pose.tip],
  ];
  const distances = bars.map(([from, to]) => armSegmentDistance(ARM_OBSTACLE, from, to));
  const [from, to] = bars[distances[0] <= distances[1] ? 0 : 1];
  ctx.globalAlpha = 0.55;
  line(ctx, frame.toPixels(from), frame.toPixels(to), DANGER.color, size + 8);
  ctx.globalAlpha = 1;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const along = Math.max(
    0,
    Math.min(
      1,
      ((ARM_OBSTACLE.x - from.x) * dx + (ARM_OBSTACLE.z - from.z) * dz) / (dx * dx + dz * dz || 1),
    ),
  );
  const contact = { x: from.x + along * dx, z: from.z + along * dz };
  const at = frame.toPixels(contact);
  line(ctx, { x: at.x - 8, y: at.y - 8 }, { x: at.x + 8, y: at.y + 8 }, DANGER.color, 3.5);
  line(ctx, { x: at.x - 8, y: at.y + 8 }, { x: at.x + 8, y: at.y - 8 }, DANGER.color, 3.5);
  return at;
}

// The contact label goes on the far side of the post from the arm, where nothing covers it.
function contactLabel(ctx, frame, at) {
  const post = frame.toPixels(ARM_OBSTACLE);
  const length = Math.hypot(post.x - at.x, post.y - at.y) || 1;
  const away = ARM_OBSTACLE.r * frame.scale + 30;
  badge(
    ctx,
    '✕ ここで接触',
    post.x + ((post.x - at.x) / length) * away,
    post.y + ((post.y - at.y) / length) * away,
    '#ffb3b3',
  );
}

// Side view of the two-joint teaching model. `q` is the current pose in degrees; `ghosts` the
// poses it may head for ([{q, label?, selected?}]); the flags switch on the extras a topic needs.
function drawArm(
  canvas,
  {
    q,
    target,
    ghosts = [],
    trace = [],
    reach = false,
    obstacle = false,
    contact = false,
    projections: showProjections = false,
    angles = true,
  },
) {
  const frame = armSceneFrame(boxWidth(canvas));
  const ctx = context(canvas, frame.width, frame.height);
  const size = frame.scale / BASE_SCALE; // bodies and bars grow with the grid
  const barWidth = Math.max(8, 12 * size);
  const origin = frame.toPixels({ x: 0, z: 0 });
  const pose = armFK(q);
  if (reach) reachRing(ctx, frame, origin);
  sideGrid(ctx, frame);
  if (obstacle) post(ctx, frame, !contact);
  if (trace.length > 1) trail(ctx, frame, trace);
  for (const ghost of ghosts) ghostPose(ctx, frame, origin, ghost);
  if (showProjections) projections(ctx, frame, pose, origin);
  robot(ctx, origin.x, origin.y + 12 * size, size);
  link(ctx, origin, frame.toPixels(pose.elbow), PART_COLORS[0], barWidth);
  link(ctx, frame.toPixels(pose.elbow), frame.toPixels(pose.tip), PART_COLORS[1], barWidth);
  const contactAt = contact ? contactMark(ctx, frame, pose, barWidth) : null;
  joint(ctx, origin, PART_COLORS[0], Math.max(8, 11 * size));
  joint(ctx, frame.toPixels(pose.elbow), PART_COLORS[1], Math.max(8, 11 * size));
  joint(ctx, frame.toPixels(pose.tip), TIP_COLOR, Math.max(6, 7 * size));
  if (angles) jointAngles(ctx, frame, pose, q);
  if (target) goalMark(ctx, frame, target);
  if (contactAt) contactLabel(ctx, frame, contactAt);
}

// The 3-D sketch is drawn in an oblique projection: y runs to the lower left, x to the lower
// right, z up. The drawing is then scaled to keep the whole arm inside the canvas.
const project = (point) => ({ x: point.x - point.y, y: -point.z + (point.x + point.y) * 0.3 });

function so101Placement(points, width, height) {
  const projected = points.map(project);
  const xs = projected.map((point) => point.x);
  const ys = projected.map((point) => point.y);
  const loX = Math.min(-130, ...xs);
  const hiX = Math.max(130, ...xs);
  const loY = Math.min(-130, ...ys);
  const hiY = Math.max(40, ...ys);
  const scale = Math.min((width - 40) / (hiX - loX), (height - 50) / (hiY - loY));
  return {
    scale,
    place(point) {
      const flat = project(point);
      return {
        x: width / 2 + (flat.x - (loX + hiX) / 2) * scale,
        y: height / 2 + 6 + (flat.y - (loY + hiY) / 2) * scale,
      };
    },
  };
}

function groundGrid(ctx, place) {
  for (let step = -300; step <= 300; step += GRID_STEP) {
    line(ctx, place({ x: step, y: -300, z: 0 }), place({ x: step, y: 300, z: 0 }), '#91a8b422');
    line(ctx, place({ x: -300, y: step, z: 0 }), place({ x: 300, y: step, z: 0 }), '#91a8b422');
  }
}

// The x/y/z arrows of the base frame, in pure colours the lesson text names (赤・緑・青).
function baseAxes(ctx, place, origin) {
  const ends = { x: { x: 130, y: 0, z: 0 }, y: { x: 0, y: 130, z: 0 }, z: { x: 0, y: 0, z: 130 } };
  for (const axis of ['x', 'y', 'z']) {
    const at = place(ends[axis]);
    line(ctx, origin, at, AXIS_COLORS[axis], 2.5);
    ctx.fillStyle = AXIS_COLORS[axis];
    ctx.beginPath();
    ctx.arc(at.x, at.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    badge(
      ctx,
      AXIS_NAMES[axis],
      at.x + (axis === 'y' ? -26 : 26),
      at.y + (axis === 'z' ? -6 : 10),
      AXIS_COLORS[axis],
    );
  }
}

// A white numbered badge beside a joint, offset away from the links (A8).
function jointNumber(ctx, at, number, color) {
  const x = at.x + 20;
  const y = at.y - 16;
  ctx.fillStyle = '#f4f8f9';
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.stroke();
  text(ctx, String(number), x, y + 4.5, '#10252f', SMALL_TEXT + 1, 'center');
}

// SO-ARM101 as the line between its joint centres, from the five joint angles in degrees.
function drawSO101(canvas, q) {
  const width = boxWidth(canvas);
  const height = Math.round(Math.max(300, width * SO101_ASPECT));
  const ctx = context(canvas, width, height);
  const chain = so101FK(q);
  const { place, scale } = so101Placement(chain.points, width, height);
  const origin = place({ x: 0, y: 0, z: 0 });
  groundGrid(ctx, place);
  robot(ctx, origin.x, origin.y + 20 * scale, scale, SO101_BASE);
  baseAxes(ctx, place, origin);
  const tip3d = chain.tip;
  // Vertical drop from the tip to the floor, so its height can be read against the grid.
  line(ctx, place(tip3d), place({ ...tip3d, z: 0 }), '#f1dca788', 1.5, [4, 4]);
  chain.points.slice(1).forEach((point, index) => {
    const color = PART_COLORS[Math.min(index, 4)];
    link(ctx, place(chain.points[index]), place(point), color, Math.max(7, 12 * scale));
    joint(ctx, place(point), color, index === 5 ? 6 : 8);
  });
  chain.points
    .slice(1, 6)
    .forEach((point, index) => jointNumber(ctx, place(point), index + 1, PART_COLORS[index]));
  const tip = place(tip3d);
  badge(ctx, '手先の基準点', tip.x + 10, tip.y + 24, '#f1dca7');
}

export { armScenePoint, armSceneFrame, drawArm, drawSO101, PART_COLORS, AXIS_COLORS };
