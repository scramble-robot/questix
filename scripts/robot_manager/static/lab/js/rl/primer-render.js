import { drawRobot } from '../core/renderer.js';

// Canvas drawing for the reward primer: one run of the robot across the room, optionally stopped
// part-way through so the two runs can be replayed side by side. Holds no state.

const PLOT = { width: 600, height: 400 }; // the canvas size fixed in index.html
const PIXELS_PER_METRE = 108;
const ORIGIN = { x: 40, y: 32 }; // pixels of the arena's top-left corner
const ARENA = { width: 4.8, height: 3 }; // metres
const GOAL = { x: 3.9, y: 1.5 }; // metres
const GOAL_RADIUS = 24; // pixels
const GOAL_LABEL = '届け先';
const GOAL_LABEL_RISE = 40; // pixels above the goal centre
const TIME_LABEL_AT = { x: 40, y: 385 }; // pixels
const TRACE_WIDTH = 3; // pixels
// Shown before a run exists, so both canvases start from the same pose.
const START_POSE = { x: 0.8, y: 1.5, theta: -Math.PI / 2, left: 0, right: 0, time: 0 };
const COLOURS = { floor: '#102832', wall: '#38505a', goal: '#efd18e', goalFill: '#efd18e19' };

const toPixels = (point) => ({
  x: ORIGIN.x + point.x * PIXELS_PER_METRE,
  y: ORIGIN.y + point.y * PIXELS_PER_METRE,
});

function drawArena(context) {
  context.fillStyle = COLOURS.floor;
  context.fillRect(0, 0, PLOT.width, PLOT.height);
  // No line width is set here on purpose: the border is as thick as whatever was drawn last, which
  // is how the original behaved and what the learner has seen since.
  context.strokeStyle = COLOURS.wall;
  context.strokeRect(
    ORIGIN.x,
    ORIGIN.y,
    ARENA.width * PIXELS_PER_METRE,
    ARENA.height * PIXELS_PER_METRE,
  );
}

function drawGoal(context) {
  const goal = toPixels(GOAL);
  context.setLineDash([6, 5]);
  context.strokeStyle = COLOURS.goal;
  context.fillStyle = COLOURS.goalFill;
  context.lineWidth = 2;
  context.beginPath();
  context.arc(goal.x, goal.y, GOAL_RADIUS, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = COLOURS.goal;
  context.font = '22px system-ui';
  context.textAlign = 'center';
  context.fillText(GOAL_LABEL, goal.x, goal.y - GOAL_LABEL_RISE);
}

// Draws the run up to `time` seconds, or all of it when no limit is given.
function drawPrimerRun(canvas, { run, time = Infinity, trail, startLabel }) {
  const context = canvas.getContext('2d');
  drawArena(context);
  drawGoal(context);
  const trace = run?.trace || [START_POSE];
  const index = Math.max(
    0,
    trace.findLastIndex((pose) => pose.time <= time),
  );
  context.strokeStyle = trail;
  context.lineWidth = TRACE_WIDTH;
  context.beginPath();
  trace.slice(0, index + 1).forEach((pose, step) => {
    const point = toPixels(pose);
    if (step === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.stroke();
  const pose = trace[index];
  drawRobot(context, toPixels(pose), pose);
  context.fillStyle = '#8fa8b0';
  context.font = '19px system-ui';
  context.textAlign = 'left';
  const label = run ? Math.min(time, run.time).toFixed(1) + ' 秒' : startLabel;
  context.fillText(label, TIME_LABEL_AT.x, TIME_LABEL_AT.y);
}

export { drawPrimerRun };
