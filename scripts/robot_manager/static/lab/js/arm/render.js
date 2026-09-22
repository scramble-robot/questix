import { ARM_MODEL, ARM_OBSTACLE, armFK, so101FK } from './core.js';

// Canvas drawings of the arm course: the side view of the teaching model and the 3-D sketch of
// SO-ARM101. Both draw from data handed in by ui.js and keep no state of their own.

const SCENE = { width: 760, height: 490 }; // drawing units; the canvas is scaled to fit its box
const SCALE = 0.62; // pixels per millimetre in the side view
const SHOULDER = { x: 340, y: 272 }; // pixel position of the shoulder centre (x = 0, z = 0)
const LINK_RADIUS_PX = 11; // joint circle
const TIP_RADIUS_PX = 7;
// Shoulder, elbow, wrist bend, wrist roll, gripper — also the colours of the side-view links.
const PART_COLORS = ['#83d7c2', '#96b8ed', '#ebc882', '#b6a4e8', '#e3a488'];
const TIP_COLOR = '#f4ede0';
const GRID_STEP = 100; // mm between grid lines
const REACH_RADII = [30, 290]; // mm: folded back and stretched out

const toPixels = (point) => ({
  x: SHOULDER.x + point.x * SCALE,
  y: SHOULDER.y - point.z * SCALE,
});

// Where in the teaching model (mm) the learner clicked.
function armScenePoint(canvas, event) {
  const box = canvas.getBoundingClientRect();
  const x = ((event.clientX - box.left) * SCENE.width) / box.width;
  const y = ((event.clientY - box.top) * SCENE.height) / box.height;
  return { x: Math.round((x - SHOULDER.x) / SCALE), z: Math.round((SHOULDER.y - y) / SCALE) };
}

// Resizes the canvas to its box (the page is responsive) and returns a cleared context whose
// coordinates are the drawing units above.
function context(canvas) {
  const box = canvas.getBoundingClientRect();
  const width = box.width || SCENE.width; // zero while the course page is still hidden
  const pixelRatio = globalThis.devicePixelRatio || 1;
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(((width * SCENE.height) / SCENE.width) * pixelRatio);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(canvas.width / SCENE.width, 0, 0, canvas.height / SCENE.height, 0, 0);
  ctx.fillStyle = '#192f3b';
  ctx.fillRect(0, 0, SCENE.width, SCENE.height);
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

function text(ctx, label, x, y, color = '#bdcdd5', size = 14) {
  ctx.font = size + 'px system-ui';
  ctx.fillStyle = color;
  ctx.fillText(label, x, y);
}

function joint(ctx, at, color, radius = LINK_RADIUS_PX) {
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

// A bar between two joints. The ghost is the pose the arm is about to reach: thin and translucent.
function link(ctx, from, to, color, ghost = false) {
  line(ctx, from, to, ghost ? color + '66' : '#0d202a', ghost ? 6 : 21);
  line(ctx, from, to, ghost ? color + '77' : color, ghost ? 3 : 12);
}

// The robot the arm is mounted on, drawn from the pixel position of its top plate.
function robot(ctx, x, y) {
  ctx.fillStyle = '#4d6772';
  ctx.fillRect(x - 66, y + 13, 132, 37);
  ctx.fillStyle = '#a5b8bf';
  ctx.fillRect(x - 55, y + 5, 110, 12);
  ctx.fillStyle = '#101f29';
  ctx.fillRect(x - 61, y + 38, 37, 22);
  ctx.fillRect(x + 25, y + 38, 37, 22);
  ctx.fillStyle = '#85cde7';
  ctx.fillRect(x + 47, y + 18, 10, 9);
  line(ctx, { x, y: y + 5 }, { x, y: y - 4 }, '#9bb4bb', 13);
}

// Green ring: everywhere the two bars can reach on length alone.
function reachRing(ctx, origin) {
  ctx.fillStyle = '#497f7040';
  ctx.beginPath();
  ctx.arc(origin.x, origin.y, REACH_RADII[1] * SCALE, 0, Math.PI * 2);
  ctx.arc(origin.x, origin.y, REACH_RADII[0] * SCALE, 0, Math.PI * 2, true);
  ctx.fill('evenodd');
  ctx.strokeStyle = '#83d7c288';
  ctx.lineWidth = 1;
  for (const radius of REACH_RADII) {
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, radius * SCALE, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function sideGrid(ctx) {
  for (let x = -400; x <= 500; x += GRID_STEP) {
    line(ctx, toPixels({ x, z: -290 }), toPixels({ x, z: 300 }), '#91a8b41c');
    text(ctx, String(x), toPixels({ x, z: 0 }).x - 12, 472, '#91a9b5', 12);
  }
  for (let z = -200; z <= 300; z += GRID_STEP) {
    line(ctx, toPixels({ x: -400, z }), toPixels({ x: 500, z }), '#91a8b41c');
    text(ctx, String(z), 49, toPixels({ x: 0, z }).y + 4, '#91a9b5', 12);
  }
  line(ctx, toPixels({ x: -400, z: 0 }), toPixels({ x: 500, z: 0 }), '#94acb966');
  line(ctx, toPixels({ x: 0, z: -290 }), toPixels({ x: 0, z: 300 }), '#94acb966');
  text(ctx, 'x：横の位置（mm）', 548, 487);
  text(ctx, 'z：肩からの高さ（mm）', 24, 76);
}

function post(ctx) {
  const at = toPixels(ARM_OBSTACLE);
  ctx.fillStyle = '#b97257';
  ctx.beginPath();
  ctx.arc(at.x, at.y, ARM_OBSTACLE.r * SCALE, 0, Math.PI * 2);
  ctx.fill();
  text(ctx, '支柱', at.x + 25, at.y + 5, '#edb59f');
}

// The path the tip has travelled so far.
function trail(ctx, trace) {
  ctx.strokeStyle = '#a0d8cd77';
  ctx.lineWidth = 2;
  ctx.beginPath();
  trace.forEach((point, index) => {
    const at = toPixels(point);
    if (index) ctx.lineTo(at.x, at.y);
    else ctx.moveTo(at.x, at.y);
  });
  ctx.stroke();
}

// Dashed steps that split each bar into how far it reaches sideways and how far up.
function projections(ctx, pose, origin) {
  const { elbow, tip } = pose;
  line(ctx, origin, toPixels({ x: elbow.x, z: 0 }), PART_COLORS[0], 2, [5, 5]);
  line(ctx, toPixels({ x: elbow.x, z: 0 }), toPixels(elbow), PART_COLORS[0], 2, [5, 5]);
  line(ctx, toPixels(elbow), toPixels({ x: tip.x, z: elbow.z }), PART_COLORS[1], 2, [5, 5]);
  line(ctx, toPixels({ x: tip.x, z: elbow.z }), toPixels(tip), PART_COLORS[1], 2, [5, 5]);
}

// The elbow angle: an arc between the bar coming in and the bar going out.
function elbowAngle(ctx, pose, q) {
  const start = (-q[0] * Math.PI) / 180;
  const end = (-(q[0] + q[1]) * Math.PI) / 180;
  const elbow = toPixels(pose.elbow);
  ctx.strokeStyle = '#96b8ed88';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(elbow.x, elbow.y, 30, Math.min(start, end), Math.max(start, end));
  ctx.stroke();
  const extension = {
    x: pose.elbow.x + 50 * Math.cos((q[0] * Math.PI) / 180),
    z: pose.elbow.z + 50 * Math.sin((q[0] * Math.PI) / 180),
  };
  line(ctx, elbow, toPixels(extension), '#96b8ed88', 1, [4, 4]);
}

function goalMark(ctx, target) {
  const at = toPixels(target);
  ctx.strokeStyle = '#edc978';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(at.x, at.y, 6.2, 0, Math.PI * 2);
  ctx.stroke();
  line(ctx, { x: at.x - 12, y: at.y }, { x: at.x + 12, y: at.y }, '#edc978');
  line(ctx, { x: at.x, y: at.y - 12 }, { x: at.x, y: at.y + 12 }, '#edc978');
  text(ctx, '⊕ 目標', 675, 215, '#edc978', 15);
}

// Side view of the two-joint teaching model. `q` is the current pose in degrees, `ghost` the pose
// it is heading for; the flags switch on the extras a single topic needs.
function drawArm(
  canvas,
  {
    q,
    target,
    ghost = null,
    trace = [],
    reach = false,
    obstacle = false,
    projections: showProjections = false,
    angles = true,
  },
) {
  const ctx = context(canvas);
  const origin = toPixels({ x: 0, z: 0 });
  const pose = armFK(q);
  text(ctx, '横から見た教材モデル · 機体は停止', 24, 30, '#dce8ed', 15);
  text(
    ctx,
    `長さ：肩〜肘 ${ARM_MODEL.l1} mm ／ 肘〜手先 ${ARM_MODEL.l2} mm`,
    24,
    54,
    '#9bb2bc',
    13,
  );
  if (reach) reachRing(ctx, origin);
  sideGrid(ctx);
  if (obstacle) post(ctx);
  if (trace.length > 1) trail(ctx, trace);
  if (ghost) {
    const ghostPose = armFK(ghost);
    link(ctx, origin, toPixels(ghostPose.elbow), '#d4e4e9', true);
    link(ctx, toPixels(ghostPose.elbow), toPixels(ghostPose.tip), '#d4e4e9', true);
  }
  if (showProjections) projections(ctx, pose, origin);
  robot(ctx, origin.x, origin.y + 12);
  link(ctx, origin, toPixels(pose.elbow), PART_COLORS[0]);
  link(ctx, toPixels(pose.elbow), toPixels(pose.tip), PART_COLORS[1]);
  joint(ctx, origin, PART_COLORS[0]);
  joint(ctx, toPixels(pose.elbow), PART_COLORS[1]);
  joint(ctx, toPixels(pose.tip), TIP_COLOR, TIP_RADIUS_PX);
  text(ctx, '● 肩', 675, 125, PART_COLORS[0], 15);
  text(ctx, '● 肘', 675, 155, PART_COLORS[1], 15);
  text(ctx, '● 手先', 675, 185, '#fff0d3', 15);
  if (angles) elbowAngle(ctx, pose, q);
  if (target) goalMark(ctx, target);
}

// The 3-D sketch is drawn in an oblique projection: y runs to the lower left, x to the lower
// right, z up. The drawing is then scaled to keep the whole arm inside the canvas.
const project = (point) => ({ x: point.x - point.y, y: -point.z + (point.x + point.y) * 0.3 });

function so101Placement(points) {
  const projected = points.map(project);
  const xs = projected.map((point) => point.x);
  const ys = projected.map((point) => point.y);
  const loX = Math.min(-100, ...xs);
  const hiX = Math.max(100, ...xs);
  const loY = Math.min(-100, ...ys);
  const hiY = Math.max(0, ...ys);
  const scale = Math.min(1, 540 / (hiX - loX), 285 / (hiY - loY));
  return (point) => {
    const flat = project(point);
    return {
      x: 360 + (flat.x - (loX + hiX) / 2) * scale,
      y: 240 + (flat.y - (loY + hiY) / 2) * scale,
    };
  };
}

function groundGrid(ctx, place) {
  for (let step = -300; step <= 300; step += GRID_STEP) {
    line(ctx, place({ x: step, y: -300, z: 0 }), place({ x: step, y: 300, z: 0 }), '#91a8b422');
    line(ctx, place({ x: -300, y: step, z: 0 }), place({ x: 300, y: step, z: 0 }), '#91a8b422');
  }
}

// The x/y/z arrows of the base frame, in the colours the lesson text refers to.
function baseAxes(ctx, place, origin) {
  const axes = [
    ['x', { x: 110, y: 0, z: 0 }, '#eaa995'],
    ['y', { x: 0, y: 110, z: 0 }, '#8cd5b5'],
    ['z', { x: 0, y: 0, z: 110 }, '#91baf1'],
  ];
  for (const [label, end, color] of axes) {
    const at = place(end);
    line(ctx, origin, at, color, 2);
    text(ctx, label, at.x + 5, at.y, color);
  }
}

// SO-ARM101 as the line between its joint centres, from the five joint angles in degrees.
function drawSO101(canvas, q) {
  const ctx = context(canvas);
  const chain = so101FK(q);
  const place = so101Placement(chain.points);
  const origin = place({ x: 0, y: 0, z: 0 });
  text(ctx, 'SO-ARM101 · 関節の位置を結んだ立体図', 24, 30, '#dfebef', 15);
  text(ctx, '外装・配線・物の重さは省略しています', 24, 54, '#9bb2bc', 13);
  groundGrid(ctx, place);
  robot(ctx, origin.x, origin.y + 20);
  baseAxes(ctx, place, origin);
  chain.points.slice(1).forEach((point, index) => {
    const color = PART_COLORS[Math.min(index, 4)];
    link(ctx, place(chain.points[index]), place(point), color);
    joint(ctx, place(point), color, index === 5 ? TIP_RADIUS_PX : 9);
    if (index < 5) text(ctx, String(index + 1), place(point).x + 12, place(point).y - 12);
  });
  const tip = place(chain.tip);
  text(ctx, '手先の基準点', tip.x + 12, tip.y + 19, '#f1dca7');
  text(ctx, '基準：アームの土台（base_link）', 24, 470, '#aec0c9', 13);
}

export { armScenePoint, drawArm, drawSO101 };
