import { drawRobot } from '../core/renderer.js';

// Canvas drawing for the foundation chapters: the arena seen from above with the goal, one traced
// run and, in the evaluation chapters, the start positions of all twenty test runs. Everything is
// drawn in a fixed 680 × 400 coordinate system that is scaled to the width the figure happens to
// have. This module holds no state; ui.js hands it the data to draw.

const PLOT = { width: 680, height: 400 }; // drawing coordinates
const ASPECT_RATIO = 1.7; // canvas width ÷ height
const FALLBACK_WIDTH = 680; // pixels, used before the figure has been laid out
const PIXELS_PER_METRE = 121;
const ARENA_ORIGIN = { x: 49, y: 30 }; // pixels of the arena's top-left corner
const ARENA_SIZE = { width: 4.8, height: 3 }; // metres
const GOAL = { x: 3.9, y: 1.5 }; // metres, the same goal as intro.js
const ARRIVAL_RADIUS = 0.22; // metres
const GOAL_LABEL = '届け先';
const GOAL_LABEL_OFFSET = { x: -25, y: -37 }; // pixels from the goal centre
const START_DOT_RADIUS = 4; // pixels
const SELECTED_START_DOT_RADIUS = 8; // pixels
const START_RING_RADIUS = 5; // pixels around the first pose of the traced run
const WALL_WIDTH = 2; // pixels
const TRACE_WIDTH = 3; // pixels
const COLOURS = {
  floor: '#192f3a',
  wall: '#567380',
  goal: '#e6c47a',
  trace: '#8bd7c0',
  startRing: '#bdced2',
  arrivedRun: '#88d6bd',
  missedRun: '#edb47a',
};

const toPixels = (point) => ({
  x: ARENA_ORIGIN.x + point.x * PIXELS_PER_METRE,
  y: ARENA_ORIGIN.y + point.y * PIXELS_PER_METRE,
});

// The canvas is re-sized on every draw because the figure column reflows with the window; writing
// canvas.width also clears it, so the whole picture is repainted afterwards.
function prepareCanvas(canvas) {
  const width = canvas.getBoundingClientRect().width || FALLBACK_WIDTH;
  const devicePixels = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * devicePixels);
  canvas.height = Math.round((width / ASPECT_RATIO) * devicePixels);
  const context = canvas.getContext('2d');
  context.setTransform(canvas.width / PLOT.width, 0, 0, canvas.height / PLOT.height, 0, 0);
  return context;
}

function drawArena(context) {
  context.fillStyle = COLOURS.floor;
  context.fillRect(0, 0, PLOT.width, PLOT.height);
  context.strokeStyle = COLOURS.wall;
  context.lineWidth = WALL_WIDTH;
  context.strokeRect(
    ARENA_ORIGIN.x,
    ARENA_ORIGIN.y,
    ARENA_SIZE.width * PIXELS_PER_METRE,
    ARENA_SIZE.height * PIXELS_PER_METRE,
  );
}

function drawGoal(context) {
  const goal = toPixels(GOAL);
  context.strokeStyle = COLOURS.goal;
  context.setLineDash([5, 5]);
  context.beginPath();
  context.arc(goal.x, goal.y, ARRIVAL_RADIUS * PIXELS_PER_METRE, 0, Math.PI * 2);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = COLOURS.goal;
  context.font = '16px system-ui';
  context.fillText(GOAL_LABEL, goal.x + GOAL_LABEL_OFFSET.x, goal.y + GOAL_LABEL_OFFSET.y);
}

// One dot per evaluation run, coloured by whether that run reached the goal.
function drawRunStarts(context, runs, selected) {
  runs.forEach((run, index) => {
    const start = toPixels(run.trace[0]);
    const radius = index === selected ? SELECTED_START_DOT_RADIUS : START_DOT_RADIUS;
    context.fillStyle = run.success ? COLOURS.arrivedRun : COLOURS.missedRun;
    context.beginPath();
    context.arc(start.x, start.y, radius, 0, Math.PI * 2);
    context.fill();
  });
}

function drawTrace(context, trace) {
  context.strokeStyle = COLOURS.trace;
  context.lineWidth = TRACE_WIDTH;
  context.beginPath();
  trace.forEach((pose, index) => {
    const point = toPixels(pose);
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.stroke();
}

// The robot is drawn at the last pose; the wheel speeds only matter for the drawing's wheel marks.
function drawRobotAtEnd(context, trace) {
  const pose = trace.at(-1);
  drawRobot(context, toPixels(pose), { left: 0, right: 0, ...pose });
  const start = toPixels(trace[0]);
  context.strokeStyle = COLOURS.startRing;
  context.beginPath();
  context.arc(start.x, start.y, START_RING_RADIUS, 0, Math.PI * 2);
  context.stroke();
}

function drawFoundationMap(canvas, { trace, runs = null, selected = -1 }) {
  const context = prepareCanvas(canvas);
  drawArena(context);
  drawGoal(context);
  if (runs) drawRunStarts(context, runs, selected);
  drawTrace(context, trace);
  if (trace.length) drawRobotAtEnd(context, trace);
}

export { drawFoundationMap };
