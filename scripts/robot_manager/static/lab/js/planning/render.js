import { drawRobot } from '../core/renderer.js';
import { SCENE_ROLE_COLORS, ROLE_DASH } from '../core/palette.js';
import { PLAN_ROBOT, planningMap } from './core.js';

// Path-planning course: the map, drawn from the plain data ui.js hands in. Colours come from the
// roles of js/core/palette.js: the planned route is a plan (magenta dash-dot), the driven track is
// what actually happened (green solid), an earlier route is "previous" (grey dotted), the goal is
// the target (amber). The cells the search looked at are shaded in the order it looked at them,
// and the area the robot's centre cannot enter is hatched.

// Canvas units: the map area starts at (x, y) and `k` units are one metre.
const PLAN_PLOT = { x: 60, y: 46, k: 100, width: 720, height: 500 };
const FIGURE_TEXT_MIN = 13; // px on screen, whatever the canvas is shrunk to (a 352 px phone card)
const SEARCH_CELL = 9; // canvas units of one searched 10 cm cell (1 unit gap between cells)
const SEARCH_ALPHA = { first: 0.85, last: 0.18 }; // opacity of the first and last searched cell
const HATCH_SPACING = 9; // canvas units between the hatch lines of the no-go area
const COLOURS = {
  background: '#152e39',
  floor: '#1b3540',
  frame: '#45606b',
  grid: '#b4d0d00c',
  shelf: '#3c5662',
  shelfEdge: '#78919b',
  box: '#a55b3e',
  boxEdge: '#e8ab7b',
  label: '#dfebed',
  hatch: '#d9c9a3',
  start: '#b1c6ce',
  goalLabel: '#e3c078',
  tick: '#a6bfc8',
  cursor: '#ffffff',
  contact: '#f0a07f',
  body: '#b9ded390',
};

// Font sizes are given in on-screen pixels: on a narrow canvas they are enlarged by the inverse
// of the canvas's scale, so that no label drops below FIGURE_TEXT_MIN px.
function fontScaler(cssWidth) {
  const scale = cssWidth / PLAN_PLOT.width;
  return (size) => `${Math.max(size, FIGURE_TEXT_MIN) / Math.min(1, scale)}px system-ui`;
}

function prepareCanvas(canvas) {
  const box = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = box.width || PLAN_PLOT.width;
  const backingWidth = Math.round(cssWidth * dpr);
  const backingHeight = Math.round(((cssWidth * PLAN_PLOT.height) / PLAN_PLOT.width) * dpr);
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
  const context = canvas.getContext('2d');
  context.setTransform(
    canvas.width / PLAN_PLOT.width,
    0,
    0,
    canvas.height / PLAN_PLOT.height,
    0,
    0,
  );
  return { context, font: fontScaler(cssWidth) };
}

const toCanvas = (point) => ({
  x: PLAN_PLOT.x + point.x * PLAN_PLOT.k,
  y: PLAN_PLOT.y + point.y * PLAN_PLOT.k,
});

function drawFloor(context, map) {
  const { x, y, k } = PLAN_PLOT;
  context.fillStyle = COLOURS.background;
  context.fillRect(0, 0, PLAN_PLOT.width, PLAN_PLOT.height);
  context.fillStyle = COLOURS.floor;
  context.fillRect(x, y, map.width * k, map.height * k);
  context.strokeStyle = COLOURS.frame;
  context.lineWidth = 1.5;
  context.strokeRect(x, y, map.width * k, map.height * k);
  context.strokeStyle = COLOURS.grid;
  context.lineWidth = 1;
  for (let metre = 1; metre < map.width; metre++) {
    context.beginPath();
    context.moveTo(x + metre * k, y);
    context.lineTo(x + metre * k, y + map.height * k);
    context.stroke();
  }
  for (let metre = 1; metre < map.height; metre++) {
    context.beginPath();
    context.moveTo(x, y + metre * k);
    context.lineTo(x + map.width * k, y + metre * k);
    context.stroke();
  }
}

// The searched cells, strongest first and fading towards the last one looked at, so Dijkstra's
// rings around the start and A*'s narrow band towards the goal can be told apart at a glance.
function drawSearch(context, expanded) {
  const count = expanded.length;
  context.fillStyle = SCENE_ROLE_COLORS.measured;
  expanded.forEach((cell, order) => {
    const share = count > 1 ? order / (count - 1) : 0;
    context.globalAlpha = SEARCH_ALPHA.first + (SEARCH_ALPHA.last - SEARCH_ALPHA.first) * share;
    const centre = toCanvas(cell);
    context.fillRect(
      centre.x - SEARCH_CELL / 2,
      centre.y - SEARCH_CELL / 2,
      SEARCH_CELL,
      SEARCH_CELL,
    );
  });
  context.globalAlpha = 1;
}

// Where the robot's centre cannot go: each obstacle grown by `required` metres (rounded corners)
// and a band of that width along the walls, hatched so it reads as "no entry" and not as a thing.
function drawNoGoArea(context, map, obstacles, required) {
  const { x, y, k } = PLAN_PLOT;
  const grow = required * k;
  const width = map.width * k;
  const height = map.height * k;
  context.save();
  context.beginPath();
  for (const rect of obstacles)
    context.roundRect(
      x + rect.x * k - grow,
      y + rect.y * k - grow,
      rect.w * k + 2 * grow,
      rect.h * k + 2 * grow,
      grow,
    );
  context.rect(x, y, width, grow);
  context.rect(x, y + height - grow, width, grow);
  context.rect(x, y, grow, height);
  context.rect(x + width - grow, y, grow, height);
  context.clip();
  context.fillStyle = COLOURS.hatch + '14';
  context.fillRect(x, y, width, height);
  context.strokeStyle = COLOURS.hatch + '66';
  context.lineWidth = 1.5;
  context.beginPath();
  for (let offset = -height; offset < width; offset += HATCH_SPACING) {
    context.moveTo(x + offset, y + height);
    context.lineTo(x + offset + height, y);
  }
  context.stroke();
  context.restore();
}

function drawObstacles(context, obstacles, fixedCount, font) {
  const { x, y, k } = PLAN_PLOT;
  for (const [index, rect] of obstacles.entries()) {
    const left = x + rect.x * k;
    const top = y + rect.y * k;
    if (rect.measured) {
      // A measured cell: where LiDAR beams ended, drawn without a label.
      context.fillStyle = COLOURS.shelfEdge;
      context.fillRect(left, top, rect.w * k, rect.h * k);
      continue;
    }
    const extra = index >= fixedCount;
    context.fillStyle = extra ? COLOURS.box : COLOURS.shelf;
    context.strokeStyle = extra ? COLOURS.boxEdge : COLOURS.shelfEdge;
    context.lineWidth = 1.5;
    context.fillRect(left, top, rect.w * k, rect.h * k);
    context.strokeRect(left, top, rect.w * k, rect.h * k);
    context.fillStyle = COLOURS.label;
    context.font = font(14);
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(extra ? '箱' : '棚', left + (rect.w * k) / 2, top + (rect.h * k) / 2);
    context.textBaseline = 'alphabetic';
  }
}

function drawLine(context, points, { colour, width = 2.4, dash = [] }) {
  if (!points?.length) return;
  context.strokeStyle = colour;
  context.lineWidth = width;
  context.setLineDash(dash);
  context.beginPath();
  points.forEach((point, index) => {
    const at = toCanvas(point);
    if (index) context.lineTo(at.x, at.y);
    else context.moveTo(at.x, at.y);
  });
  context.stroke();
  context.setLineDash([]);
}

const dashOf = (role) => ROLE_DASH[role].split(' ').map(Number);

function drawWaypoints(context, points, font) {
  context.textAlign = 'center';
  points.forEach((point, index) => {
    const at = toCanvas(point);
    context.fillStyle = SCENE_ROLE_COLORS.plan;
    context.beginPath();
    context.arc(at.x, at.y, 6, 0, Math.PI * 2);
    context.fill();
    context.font = font(13);
    context.fillText(String(index + 1), at.x, at.y - 12);
  });
}

function drawEnds(context, map, font) {
  for (const [point, label, circle, text] of [
    [map.start, 'スタート', COLOURS.start, COLOURS.start],
    [map.goal, '目的地', SCENE_ROLE_COLORS.target, COLOURS.goalLabel],
  ]) {
    const at = toCanvas(point);
    context.strokeStyle = circle;
    context.lineWidth = 2;
    context.setLineDash([4, 4]);
    context.beginPath();
    context.arc(at.x, at.y, 18, 0, Math.PI * 2);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = text;
    context.font = font(15);
    context.textAlign = 'center';
    context.fillText(label, at.x, at.y - 28);
  }
}

function drawBody(context, sample) {
  const at = toCanvas(sample);
  const size = (PLAN_ROBOT.radius * PLAN_PLOT.k) / 42;
  context.save();
  context.translate(at.x, at.y);
  context.scale(size, size);
  drawRobot(context, { x: 0, y: 0 }, sample);
  context.restore();
  context.strokeStyle = sample.phase === 'contact' ? COLOURS.contact : COLOURS.body;
  context.lineWidth = 1.2;
  context.beginPath();
  context.arc(at.x, at.y, PLAN_ROBOT.radius * PLAN_PLOT.k, 0, Math.PI * 2);
  context.stroke();
}

function drawCursor(context, cursor) {
  const at = toCanvas(cursor);
  context.strokeStyle = COLOURS.cursor;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(at.x - 8, at.y);
  context.lineTo(at.x + 8, at.y);
  context.moveTo(at.x, at.y - 8);
  context.lineTo(at.x, at.y + 8);
  context.stroke();
}

function drawScale(context, map, font) {
  const { x, y, k } = PLAN_PLOT;
  context.fillStyle = COLOURS.tick;
  context.font = font(13);
  context.textAlign = 'center';
  for (let metre = 0; metre <= map.width; metre++)
    context.fillText(metre + ' m', x + metre * k, y + map.height * k + 25);
  context.textAlign = 'right';
  for (let metre = 0; metre <= map.height; metre++)
    context.fillText(metre + ' m', x - 8, y + metre * k + 5);
  context.textAlign = 'left';
}

// How far the no-go area reaches (m): the planner's own value once a run exists, otherwise what
// the current settings would ask for.
function noGoReach(topic, config, activePlan, run) {
  if (run) return activePlan?.required ?? 0;
  if (topic === 'draw' || !config.body) return 0;
  return PLAN_ROBOT.radius + config.margin;
}

// The route drawn before a run: the learner's waypoints in the draw topic, nothing otherwise.
function plannedPoints(topic, config, map, activePlan, run) {
  if (run) return activePlan?.path;
  if (topic === 'draw') return [map.start, ...config.points, map.goal];
  return [];
}

/**
 * The map of one planning experiment. `room` is the measured room (room-core.js `measuredRoom`)
 * when the topic uses one: its map and the path the robot was driven along.
 */
function drawPlanning(
  canvas,
  { topic, config, run, index = 0, showSearch = false, cursor = null, room = null },
) {
  const { context, font } = prepareCanvas(canvas);
  const map = run?.map || room?.map || planningMap(topic);
  const sample = run?.samples[index] || { ...map.start, theta: 0, left: 0, right: 0 };
  const replanned = Boolean(sample.changed && run?.newPlan);
  const obstacles = [...map.obstacles, ...(sample.changed && run?.obstacle ? [run.obstacle] : [])];
  const activePlan = replanned ? run.newPlan : run?.plan;
  drawFloor(context, map);
  if (showSearch && activePlan?.expanded) drawSearch(context, activePlan.expanded);
  const reach = noGoReach(topic, config, activePlan, run);
  if (reach > 0) drawNoGoArea(context, map, obstacles, reach);
  drawObstacles(context, obstacles, map.obstacles.length, font);
  const previous = { colour: SCENE_ROLE_COLORS.previous, dash: dashOf('previous'), width: 2 };
  if (room?.trajectory) drawLine(context, room.trajectory, previous);
  if (replanned) drawLine(context, run.plan.path, previous);
  drawLine(context, plannedPoints(topic, config, map, activePlan, run), {
    colour: SCENE_ROLE_COLORS.plan,
    dash: dashOf('plan'),
    width: 2.6,
  });
  if (run)
    drawLine(context, run.samples.slice(0, index + 1), {
      colour: SCENE_ROLE_COLORS.actual,
      width: 3,
    });
  if (!run && topic === 'draw') drawWaypoints(context, config.points, font);
  drawEnds(context, map, font);
  drawBody(context, sample);
  if (cursor && !run && topic === 'draw') drawCursor(context, cursor);
  drawScale(context, map, font);
}

export { PLAN_PLOT, drawPlanning, noGoReach };
