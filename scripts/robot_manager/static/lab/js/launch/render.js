import { LAUNCH_SPEC, launchGroups } from './core.js';
import { drawRobot } from '../core/renderer.js';

const fmt = (v, d = 1) => Number(v).toFixed(d);
function context(canvas, w, h) {
  const b = canvas.getBoundingClientRect(),
    scale = ((window.devicePixelRatio || 1) * (b.width || w)) / w;
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const c = canvas.getContext('2d');
  c.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
  return c;
}
function arrow(c, x, y, dx, dy, color, label) {
  const len = Math.hypot(dx, dy);
  if (len < 3) return;
  const a = Math.atan2(dy, dx);
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineWidth = 2.4;
  c.beginPath();
  c.moveTo(x, y);
  c.lineTo(x + dx, y + dy);
  c.stroke();
  c.beginPath();
  c.moveTo(x + dx, y + dy);
  c.lineTo(x + dx - 8 * Math.cos(a - 0.45), y + dy - 8 * Math.sin(a - 0.45));
  c.lineTo(x + dx - 8 * Math.cos(a + 0.45), y + dy - 8 * Math.sin(a + 0.45));
  c.fill();
  if (label) {
    c.font = '14px system-ui';
    c.textAlign = dx < 0 ? 'right' : 'left';
    c.fillText(label, x + dx + (dx < 0 ? -7 : 7), y + dy - 6);
  }
}
function drawLaunch(
  canvas,
  { run, index = 0, reference = null, target = null, forces = false, previous = null },
) {
  const c = context(canvas, 760, 350),
    s = LAUNCH_SPEC,
    k = 145,
    X = (x) => 130 + x * k,
    Z = (z) => 278 - z * k;
  c.fillStyle = '#17313c';
  c.fillRect(0, 0, 760, 350);
  c.font = '14px system-ui';
  c.fillStyle = '#cee0e4';
  c.fillText('横から見た飛行', 22, 28);
  c.fillStyle = '#99b2bc';
  c.font = '12px system-ui';
  c.fillText('射出口を0 mとして、最初に床に触れた位置を測る', 22, 49);
  if (forces) {
    c.font = '14px system-ui';
    c.textAlign = 'left';
    [
      ['#eea49a', '重力'],
      ['#b6b6ec', '空気抵抗'],
      ['#9adcca', '揚力'],
    ].forEach(([color, title], i) => {
      const x = 265 + i * 145;
      c.fillStyle = color;
      c.fillRect(x, 65, 20, 3);
      c.fillText(title, x + 29, 72);
    });
  }
  c.strokeStyle = '#54717a';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(X(0), 80);
  c.lineTo(X(0), 278);
  c.lineTo(733, 278);
  c.stroke();
  for (let x = 0; x <= 4; x++) {
    c.fillStyle = '#adc2ca';
    c.font = '13px system-ui';
    c.textAlign = 'center';
    c.fillText(x + ' m', X(x), forces ? 338 : 302);
    if (x) {
      c.strokeStyle = '#91adbb1f';
      c.beginPath();
      c.moveTo(X(x), 86);
      c.lineTo(X(x), 278);
      c.stroke();
    }
  }
  c.textAlign = 'left';
  c.fillStyle = '#a6bec5';
  c.fillText('床', 27, 291);
  c.font = '12px system-ui';
  c.fillText('高さ45 cm（仮定）', 14, 185);
  // Side-view schematic, paired with the existing QUESTiX top view in the mechanism panel.
  c.fillStyle = '#a0b9be';
  c.fillRect(45, 223, 66, 32);
  c.fillStyle = '#597b83';
  c.fillRect(67, 207, 57, 16);
  c.fillStyle = '#223f48';
  c.strokeStyle = '#a5b6b9';
  c.lineWidth = 2;
  c.beginPath();
  c.arc(67, 261, 15, 0, Math.PI * 2);
  c.fill();
  c.stroke();
  c.fillStyle = '#93ccd8';
  c.fillRect(103, 230, 8, 8);
  c.fillStyle = '#efc887';
  c.fillRect(108, Z(s.height) - 2, 22, 4);
  if (target !== null) {
    c.fillStyle = '#e8bf7938';
    c.fillRect(X(target - 0.15), 260, 0.3 * k, 18);
    c.strokeStyle = '#edca81';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(X(target), 245);
    c.lineTo(X(target), 278);
    c.stroke();
    c.fillStyle = '#f1d49b';
    c.textAlign = 'center';
    c.fillText('的 ' + fmt(target) + ' m', X(target), 326);
  }
  function trace(samples, color, dash = []) {
    if (!samples?.length) return;
    c.strokeStyle = color;
    c.setLineDash(dash);
    c.lineWidth = 2;
    c.beginPath();
    samples.forEach((q, i) => (i ? c.lineTo(X(q.x), Z(q.z)) : c.moveTo(X(q.x), Z(q.z))));
    c.stroke();
    c.setLineDash([]);
  }
  if (previous) trace(previous.samples, '#b6c6ce66', [3, 5]);
  const q = run?.samples[index] || { x: 0, z: s.height, t: 0 };
  if (reference && run)
    trace(
      reference.samples.filter((p) => p.t <= q.t),
      '#e6c58a',
      [5, 5],
    );
  if (run) trace(run.samples.slice(0, index + 1), '#91decc');
  // Horizontal disc appears as its thin edge here; dimensions retain the 180:20 ratio.
  const px = X(q.x),
    pz = Z(q.z);
  c.fillStyle = '#f4cf90';
  c.fillRect(px - 0.09 * k, pz - 0.01 * k, 0.18 * k, 0.02 * k);
  c.strokeStyle = '#ffebc7';
  c.lineWidth = 1;
  c.strokeRect(px - 0.09 * k, pz - 0.01 * k, 0.18 * k, 0.02 * k);
  if (forces && run && index < run.samples.length - 1) {
    const factor = 220;
    arrow(c, px, pz, 0, q.weight * factor, '#eea49a');
    if (run.config.air) {
      arrow(c, px, pz, q.dragX * factor, -q.dragZ * factor, '#b6b6ec');
      arrow(c, px, pz, q.liftX * factor, -q.liftZ * factor, '#9adcca');
    }
  }
  if (run && index === run.samples.length - 1 && run.status === 'landed') {
    c.strokeStyle = '#f2d49b';
    c.beginPath();
    c.arc(px, 278, 6, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = '#ecdcba';
    c.textAlign = 'left';
    c.font = '14px system-ui';
    c.fillText(fmt(run.range, 2) + ' m', Math.min(677, px + 10), 263);
  }
  c.textAlign = 'right';
  c.fillStyle = '#aac2ca';
  c.font = '12px system-ui';
  c.fillText('横の位置と高さは同じ縮尺', 736, 28);
}
function launchMechanism() {
  return `<div class="launch-mechanism"><div><canvas id="launchRobot" width="180" height="130" role="img" aria-label="QUESTiXを上から見た図"></canvas><span>機体は止めて射出</span></div><svg viewBox="0 0 420 160" role="img" aria-label="水平なディスクを、1つの駆動ローラが押し出す仮の機構。上から見た模式図。"><defs><marker id="launchArrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0 0L7 3L0 6" fill="none" stroke="#427d77"/></marker></defs><text x="18" y="22" fill="#49616b" font-size="14">上から見た射出部（機構は仮定）</text><path d="M40 126H260" stroke="#9aaeb2" stroke-width="6"/><circle cx="144" cy="85" r="39" fill="#f5ce8e" stroke="#aa7d3d"/><circle cx="142" cy="36" r="12" fill="#52797c"/><path d="M193 84H278" stroke="#427d77" stroke-width="3" marker-end="url(#launchArrow)"/><path d="M103 31H75" stroke="#52797c"/><text x="18" y="51" fill="#49616b" font-size="12">駆動ローラ1つ</text><text x="279" y="89" fill="#427d77" font-size="14">押し出す</text><text x="112" y="149" fill="#49616b" font-size="12">案内部</text><path d="M176 43Q205 85 177 122" fill="none" stroke="#9f753c" stroke-dasharray="3 3"/><text x="279" y="120" fill="#7d622f" font-size="12">回転も生じ得る</text></svg><div class="launch-disc-dim"><svg viewBox="0 0 150 110" role="img" aria-label="ディスクの直径180 mm、厚み20 mm"><ellipse cx="75" cy="44" rx="50" ry="18" fill="#f5ce8e" stroke="#af8448"/><path d="M25 44V55C25 79 125 79 125 55V44" fill="#dfb775" stroke="#af8448"/><path d="M25 23H125M25 19V27M125 19V27" stroke="#64797a"/><text x="75" y="15" text-anchor="middle" fill="#49616b" font-size="12">直径180 mm</text><text x="75" y="101" text-anchor="middle" fill="#49616b" font-size="12">厚み20 mm</text></svg><span>高発泡ポリエチレン</span></div></div>`;
}
function drawLaunchRobot(canvas) {
  const c = context(canvas, 180, 130);
  c.clearRect(0, 0, 180, 130);
  c.save();
  c.translate(88, 65);
  c.scale(0.85, 0.85);
  drawRobot(c, { x: 0, y: 0 }, { theta: 0, left: 0, right: 0 });
  c.restore();
}
function launchChart(rows, target = null, estimate = null) {
  const groups = launchGroups(rows),
    max = Math.max(3.5, target || 0, ...rows.map((r) => r.range)) * 1.1,
    X = (p) => 62 + p * 5.8,
    Y = (r) => 234 - (r / max) * 184;
  return `<svg class="launch-chart" viewBox="0 0 720 288" role="img" aria-label="横軸はモーターへの出力指示0から100%、縦軸は飛距離。点が1枚ごとの結果、線は同じ出力の平均を結んだものです。"><text x="20" y="25" fill="#536c75" font-size="14">飛距離（m）</text>${[
    0, 1, 2, 3,
  ]
    .map((i) => {
      const y = 234 - (i * 184) / 3;
      return `<path d="M62 ${y}H642" stroke="#e2e9e8"/><text x="51" y="${y + 4}" text-anchor="end" fill="#657b81" font-size="12">${fmt((i * max) / 3)}</text>`;
    })
    .join(
      '',
    )}<path d="M62 50V234H642" fill="none" stroke="#81969c"/>${[0, 20, 40, 60, 80, 100].map((p) => `<text x="${X(p)}" y="254" text-anchor="middle" fill="#657b81" font-size="12">${p}</text>`).join('')}<text x="352" y="279" text-anchor="middle" fill="#536c75" font-size="14">モーターへの出力指示（%）</text>${target !== null ? `<path d="M62 ${Y(target)}H642" stroke="#bc8b3f" stroke-dasharray="5 5"/><text x="651" y="${Y(target) + 4}" fill="#8c6d3d" font-size="12">的</text>` : ''}${groups.length > 1 ? `<polyline points="${groups.map((g) => X(g.power) + ',' + Y(g.mean)).join(' ')}" fill="none" stroke="#44877c" stroke-width="2"/>` : ''}${rows.map((r) => `<circle cx="${X(r.power)}" cy="${Y(r.range)}" r="4" fill="#44877c" opacity=".65"/>`).join('')}${groups.map((g) => `<path d="M${X(g.power)} ${Y(g.min)}V${Y(g.max)}" stroke="#44877c" stroke-width="2"/>`).join('')}${estimate?.ok ? `<path d="M${X(estimate.power)} 234V${Y(target)}" stroke="#bc8b3f" stroke-dasharray="3 4"/><circle cx="${X(estimate.power)}" cy="${Y(target)}" r="6" fill="#fff" stroke="#bc8b3f" stroke-width="2"/>` : ''}${!rows.length ? '<text x="350" y="142" text-anchor="middle" fill="#667e85" font-size="15">実験すると、ここに測定点が増えます</text>' : ''}</svg>`;
}

export { drawLaunch, launchMechanism, drawLaunchRobot, launchChart };
