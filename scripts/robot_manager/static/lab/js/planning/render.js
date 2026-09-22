import { drawRobot } from '../core/renderer.js';
import { PLAN_ROBOT, planningMap } from './core.js';

const PLAN_PLOT = { x: 60, y: 46, k: 100, width: 720, height: 500 };
// `room` is the measured room (room-core.js `measuredRoom`) when the topic uses one: its map and
// the path the robot was driven along.
function drawPlanning(
  canvas,
  { topic, config, run, index = 0, showSearch = false, cursor = null, room = null },
) {
  const p = PLAN_PLOT;
  const box = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = box.width || 720;
  const bw = Math.round(w * dpr);
  const bh = Math.round(((w * 500) / 720) * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const c = canvas.getContext('2d');
  c.setTransform(canvas.width / 720, 0, 0, canvas.height / 500, 0, 0);
  c.fillStyle = '#152e39';
  c.fillRect(0, 0, 720, 500);
  const map = run?.map || room?.map || planningMap(topic);
  const sample = run?.samples[index] || { ...map.start, theta: 0, left: 0, right: 0 };
  const obstacles = [...map.obstacles, ...(sample.changed && run?.obstacle ? [run.obstacle] : [])];
  const P = (q) => ({ x: p.x + q.x * p.k, y: p.y + q.y * p.k });
  c.fillStyle = '#1b3540';
  c.fillRect(p.x, p.y, map.width * p.k, map.height * p.k);
  c.strokeStyle = '#45606b';
  c.lineWidth = 1.5;
  c.strokeRect(p.x, p.y, map.width * p.k, map.height * p.k);
  c.strokeStyle = '#b4d0d00c';
  c.lineWidth = 1;
  for (let x = 1; x < 6; x++) {
    c.beginPath();
    c.moveTo(p.x + x * p.k, p.y);
    c.lineTo(p.x + x * p.k, p.y + 400);
    c.stroke();
  }
  for (let y = 1; y < 4; y++) {
    c.beginPath();
    c.moveTo(p.x, p.y + y * p.k);
    c.lineTo(p.x + 600, p.y + y * p.k);
    c.stroke();
  }
  const activePlan = sample.changed && run?.newPlan ? run.newPlan : run?.plan;
  if (showSearch && activePlan?.expanded) {
    c.fillStyle = '#83bdd52d';
    for (const q of activePlan.expanded) c.fillRect(p.x + q.x * p.k - 4, p.y + q.y * p.k - 4, 8, 8);
  }
  const required = run
    ? activePlan?.required
    : topic !== 'draw' && config.body
      ? PLAN_ROBOT.radius + config.margin
      : 0;
  if (required > 0) {
    c.strokeStyle = '#eab97024';
    c.lineWidth = required * p.k * 2;
    c.lineJoin = 'round';
    for (const r of obstacles) c.strokeRect(p.x + r.x * p.k, p.y + r.y * p.k, r.w * p.k, r.h * p.k);
    c.lineJoin = 'miter';
    c.fillStyle = '#eab97014';
    const d = required * p.k;
    c.fillRect(p.x, p.y, 600, d);
    c.fillRect(p.x, p.y + 400 - d, 600, d);
    c.fillRect(p.x, p.y, d, 400);
    c.fillRect(p.x + 600 - d, p.y, d, 400);
  }
  for (const [i, r] of obstacles.entries()) {
    const extra = i >= map.obstacles.length;
    if (r.measured) {
      // A measured cell: where LiDAR beams ended, drawn without a label.
      c.fillStyle = '#78919b';
      c.fillRect(p.x + r.x * p.k, p.y + r.y * p.k, r.w * p.k, r.h * p.k);
      continue;
    }
    c.fillStyle = extra ? '#a55b3e' : '#3c5662';
    c.strokeStyle = extra ? '#e8ab7b' : '#78919b';
    c.lineWidth = 1.5;
    c.fillRect(p.x + r.x * p.k, p.y + r.y * p.k, r.w * p.k, r.h * p.k);
    c.strokeRect(p.x + r.x * p.k, p.y + r.y * p.k, r.w * p.k, r.h * p.k);
    c.fillStyle = '#dfebed';
    c.font = '14px system-ui';
    c.textAlign = 'center';
    c.fillText(extra ? '箱' : '棚', p.x + (r.x + r.w / 2) * p.k, p.y + (r.y + r.h / 2) * p.k + 5);
  }
  function route(points, color, dash = []) {
    if (!points?.length) return;
    c.strokeStyle = color;
    c.lineWidth = 2.4;
    c.setLineDash(dash);
    c.beginPath();
    points.forEach((q, i) => {
      const v = P(q);
      i ? c.lineTo(v.x, v.y) : c.moveTo(v.x, v.y);
    });
    c.stroke();
    c.setLineDash([]);
  }
  const routePoints = run
    ? activePlan?.path
    : topic === 'draw'
      ? [map.start, ...config.points, map.goal]
      : [];
  if (room?.trajectory) {
    // The path the robot was driven along while the room was measured.
    c.lineWidth = 1.6;
    c.strokeStyle = '#c99ad6aa';
    c.setLineDash([2, 5]);
    c.beginPath();
    room.trajectory.forEach((q, i) => {
      const v = P(q);
      i ? c.lineTo(v.x, v.y) : c.moveTo(v.x, v.y);
    });
    c.stroke();
    c.setLineDash([]);
  }
  if (sample.changed && run?.newPlan) route(run.plan.path, '#9bb0b066', [6, 7]);
  route(routePoints, '#edcc88', [7, 5]);
  if (run) route(run.samples.slice(0, index + 1), '#8ee0c6');
  if (!run && topic === 'draw') {
    config.points.forEach((q, i) => {
      const v = P(q);
      c.fillStyle = '#f1cf8b';
      c.beginPath();
      c.arc(v.x, v.y, 5, 0, Math.PI * 2);
      c.fill();
      c.font = '13px system-ui';
      c.fillText(String(i + 1), v.x, v.y - 11);
    });
  }
  for (const [q, label, color] of [
    [map.start, 'スタート', '#b1c6ce'],
    [map.goal, '目的地', '#edcc88'],
  ]) {
    const v = P(q);
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.setLineDash([4, 4]);
    c.beginPath();
    c.arc(v.x, v.y, 18, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = color;
    c.font = '15px system-ui';
    c.textAlign = 'center';
    c.fillText(label, v.x, v.y - 30);
  }
  const r = P(sample);
  c.save();
  c.translate(r.x, r.y);
  c.scale((PLAN_ROBOT.radius * p.k) / 42, (PLAN_ROBOT.radius * p.k) / 42);
  drawRobot(c, { x: 0, y: 0 }, sample);
  c.restore();
  c.strokeStyle = sample.phase === 'contact' ? '#f0a07f' : '#b9ded390';
  c.lineWidth = 1.2;
  c.beginPath();
  c.arc(r.x, r.y, PLAN_ROBOT.radius * p.k, 0, Math.PI * 2);
  c.stroke();
  if (cursor && !run && topic === 'draw') {
    const v = P(cursor);
    c.strokeStyle = '#ffffff';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(v.x - 8, v.y);
    c.lineTo(v.x + 8, v.y);
    c.moveTo(v.x, v.y - 8);
    c.lineTo(v.x, v.y + 8);
    c.stroke();
  }
  c.fillStyle = '#a6bfc8';
  c.font = '13px system-ui';
  c.textAlign = 'center';
  for (let x = 0; x <= 6; x++) c.fillText(x + ' m', p.x + x * p.k, p.y + 425);
  c.textAlign = 'right';
  for (let y = 0; y <= 4; y++) c.fillText(y + ' m', p.x - 12, p.y + y * p.k + 5);
}

export { PLAN_PLOT, drawPlanning };
