import { ARM_MODEL, ARM_OBSTACLE, armFK, so101FK } from './core.js';

const COLORS = ['#83d7c2', '#96b8ed', '#ebc882', '#b6a4e8', '#e3a488'];
function armScenePoint(canvas, event) {
  const r = canvas.getBoundingClientRect(),
    x = ((event.clientX - r.left) * 760) / r.width,
    y = ((event.clientY - r.top) * 490) / r.height;
  return { x: Math.round((x - 340) / 0.62), z: Math.round((272 - y) / 0.62) };
}
function context(canvas) {
  const r = canvas.getBoundingClientRect(),
    w = r.width || 760,
    dpr = globalThis.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(((w * 490) / 760) * dpr);
  const c = canvas.getContext('2d');
  c.setTransform(canvas.width / 760, 0, 0, canvas.height / 490, 0, 0);
  c.fillStyle = '#192f3b';
  c.fillRect(0, 0, 760, 490);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  return c;
}
function line(c, a, b, color, width = 1, dash = []) {
  c.strokeStyle = color;
  c.lineWidth = width;
  c.setLineDash(dash);
  c.beginPath();
  c.moveTo(a.x, a.y);
  c.lineTo(b.x, b.y);
  c.stroke();
  c.setLineDash([]);
}
function text(c, t, x, y, color = '#bdcdd5', size = 14) {
  c.font = size + 'px system-ui';
  c.fillStyle = color;
  c.fillText(t, x, y);
}
function joint(c, p, color, r = 11) {
  c.fillStyle = '#18303d';
  c.strokeStyle = color;
  c.lineWidth = 3;
  c.beginPath();
  c.arc(p.x, p.y, r, 0, Math.PI * 2);
  c.fill();
  c.stroke();
  c.fillStyle = color;
  c.beginPath();
  c.arc(p.x, p.y, 3, 0, Math.PI * 2);
  c.fill();
}
function link(c, a, b, color, ghost = false) {
  line(c, a, b, ghost ? color + '66' : '#0d202a', ghost ? 6 : 21);
  line(c, a, b, ghost ? color + '77' : color, ghost ? 3 : 12);
}
function robot(c, x, y) {
  c.fillStyle = '#4d6772';
  c.fillRect(x - 66, y + 13, 132, 37);
  c.fillStyle = '#a5b8bf';
  c.fillRect(x - 55, y + 5, 110, 12);
  c.fillStyle = '#101f29';
  c.fillRect(x - 61, y + 38, 37, 22);
  c.fillRect(x + 25, y + 38, 37, 22);
  c.fillStyle = '#85cde7';
  c.fillRect(x + 47, y + 18, 10, 9);
  line(c, { x, y: y + 5 }, { x, y: y - 4 }, '#9bb4bb', 13);
}
function drawArm(
  canvas,
  {
    q,
    target,
    ghost = null,
    trace = [],
    reach = false,
    obstacle = false,
    projections = false,
    angles = true,
  },
) {
  const c = context(canvas),
    p = (v) => ({ x: 340 + v.x * 0.62, y: 272 - v.z * 0.62 }),
    o = p({ x: 0, z: 0 }),
    f = armFK(q);
  text(c, '横から見た教材モデル · 機体は停止', 24, 30, '#dce8ed', 15);
  text(c, '長さ：肩〜肘 160 mm ／ 肘〜手先 130 mm', 24, 54, '#9bb2bc', 13);
  if (reach) {
    c.fillStyle = '#497f7040';
    c.beginPath();
    c.arc(o.x, o.y, 290 * 0.62, 0, Math.PI * 2);
    c.arc(o.x, o.y, 30 * 0.62, 0, Math.PI * 2, true);
    c.fill('evenodd');
    c.strokeStyle = '#83d7c288';
    c.lineWidth = 1;
    for (const radius of [30, 290]) {
      c.beginPath();
      c.arc(o.x, o.y, radius * 0.62, 0, Math.PI * 2);
      c.stroke();
    }
  }
  for (let x = -400; x <= 500; x += 100) {
    line(c, p({ x, z: -290 }), p({ x, z: 300 }), '#91a8b41c');
    text(c, String(x), p({ x, z: 0 }).x - 12, 472, '#91a9b5', 12);
  }
  for (let z = -200; z <= 300; z += 100) {
    line(c, p({ x: -400, z }), p({ x: 500, z }), '#91a8b41c');
    text(c, String(z), 49, p({ x: 0, z }).y + 4, '#91a9b5', 12);
  }
  line(c, p({ x: -400, z: 0 }), p({ x: 500, z: 0 }), '#94acb966');
  line(c, p({ x: 0, z: -290 }), p({ x: 0, z: 300 }), '#94acb966');
  text(c, 'x：横の位置（mm）', 548, 487);
  text(c, 'z：肩からの高さ（mm）', 24, 76);
  if (obstacle) {
    const k = p(ARM_OBSTACLE);
    c.fillStyle = '#b97257';
    c.beginPath();
    c.arc(k.x, k.y, ARM_OBSTACLE.r * 0.62, 0, Math.PI * 2);
    c.fill();
    text(c, '支柱', k.x + 25, k.y + 5, '#edb59f');
  }
  if (trace.length > 1) {
    c.strokeStyle = '#a0d8cd77';
    c.lineWidth = 2;
    c.beginPath();
    trace.forEach((v, i) => {
      const k = p(v);
      i ? c.lineTo(k.x, k.y) : c.moveTo(k.x, k.y);
    });
    c.stroke();
  }
  if (ghost) {
    const g = armFK(ghost);
    link(c, o, p(g.elbow), '#d4e4e9', true);
    link(c, p(g.elbow), p(g.tip), '#d4e4e9', true);
  }
  if (projections) {
    line(c, o, p({ x: f.elbow.x, z: 0 }), COLORS[0], 2, [5, 5]);
    line(c, p({ x: f.elbow.x, z: 0 }), p(f.elbow), COLORS[0], 2, [5, 5]);
    line(c, p(f.elbow), p({ x: f.tip.x, z: f.elbow.z }), COLORS[1], 2, [5, 5]);
    line(c, p({ x: f.tip.x, z: f.elbow.z }), p(f.tip), COLORS[1], 2, [5, 5]);
  }
  robot(c, o.x, o.y + 12);
  link(c, o, p(f.elbow), COLORS[0]);
  link(c, p(f.elbow), p(f.tip), COLORS[1]);
  joint(c, o, COLORS[0]);
  joint(c, p(f.elbow), COLORS[1]);
  joint(c, p(f.tip), '#f4ede0', 7);
  text(c, '● 肩', 675, 125, COLORS[0], 15);
  text(c, '● 肘', 675, 155, COLORS[1], 15);
  text(c, '● 手先', 675, 185, '#fff0d3', 15);
  if (angles) {
    const start = (-q[0] * Math.PI) / 180,
      end = (-(q[0] + q[1]) * Math.PI) / 180;
    c.strokeStyle = '#96b8ed88';
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(p(f.elbow).x, p(f.elbow).y, 30, Math.min(start, end), Math.max(start, end));
    c.stroke();
    const ext = {
      x: f.elbow.x + 50 * Math.cos((q[0] * Math.PI) / 180),
      z: f.elbow.z + 50 * Math.sin((q[0] * Math.PI) / 180),
    };
    line(c, p(f.elbow), p(ext), '#96b8ed88', 1, [4, 4]);
  }
  if (target) {
    const t = p(target);
    c.strokeStyle = '#edc978';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(t.x, t.y, 6.2, 0, Math.PI * 2);
    c.stroke();
    line(c, { x: t.x - 12, y: t.y }, { x: t.x + 12, y: t.y }, '#edc978');
    line(c, { x: t.x, y: t.y - 12 }, { x: t.x, y: t.y + 12 }, '#edc978');
    text(c, '⊕ 目標', 675, 215, '#edc978', 15);
  }
}
function drawSO101(canvas, q) {
  const c = context(canvas),
    f = so101FK(q),
    raw = (v) => ({ x: v.x - v.y, y: -v.z + (v.x + v.y) * 0.3 });
  const bounds = f.points.map(raw),
    xs = bounds.map((v) => v.x),
    ys = bounds.map((v) => v.y),
    loX = Math.min(-100, ...xs),
    hiX = Math.max(100, ...xs),
    loY = Math.min(-100, ...ys),
    hiY = Math.max(0, ...ys),
    scale = Math.min(1, 540 / (hiX - loX), 285 / (hiY - loY));
  const p = (v) => {
      const r = raw(v);
      return { x: 360 + (r.x - (loX + hiX) / 2) * scale, y: 240 + (r.y - (loY + hiY) / 2) * scale };
    },
    o = p({ x: 0, y: 0, z: 0 });
  text(c, 'SO-ARM101 · 関節の位置を結んだ立体図', 24, 30, '#dfebef', 15);
  text(c, '外装・配線・物の重さは省略しています', 24, 54, '#9bb2bc', 13);
  for (let k = -300; k <= 300; k += 100) {
    line(c, p({ x: k, y: -300, z: 0 }), p({ x: k, y: 300, z: 0 }), '#91a8b422');
    line(c, p({ x: -300, y: k, z: 0 }), p({ x: 300, y: k, z: 0 }), '#91a8b422');
  }
  robot(c, o.x, o.y + 20);
  for (const [axis, v, color] of [
    ['x', { x: 110, y: 0, z: 0 }, '#eaa995'],
    ['y', { x: 0, y: 110, z: 0 }, '#8cd5b5'],
    ['z', { x: 0, y: 0, z: 110 }, '#91baf1'],
  ]) {
    const a = p(v);
    line(c, o, a, color, 2);
    text(c, axis, a.x + 5, a.y, color);
  }
  f.points.slice(1).forEach((v, i) => {
    link(c, p(f.points[i]), p(v), COLORS[Math.min(i, 4)]);
    joint(c, p(v), COLORS[Math.min(i, 4)], i === 5 ? 7 : 9);
    if (i < 5) text(c, String(i + 1), p(v).x + 12, p(v).y - 12);
  });
  const tip = p(f.tip);
  text(c, '手先の基準点', tip.x + 12, tip.y + 19, '#f1dca7');
  text(c, '基準：アームの土台（base_link）', 24, 470, '#aec0c9', 13);
}

export { armScenePoint, drawArm, drawSO101 };
