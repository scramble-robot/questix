const $ = (id) => document.getElementById(id),
  canvas = $('arena'),
  ctx = canvas.getContext('2d');
const plot = { x: 72, y: 40, size: 165 },
  screen = (x, y) => ({ x: plot.x + x * plot.size, y: plot.y + y * plot.size });
function roundRect(x, y, w, h, r, fill, stroke) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}
function drawArena(env, pose, trail, observation) {
  const task = env.task;
  ctx.clearRect(0, 0, 1000, 660);
  ctx.fillStyle = '#102832';
  ctx.fillRect(0, 0, 1000, 660);
  const { x: ox, y: oy, size: k } = plot,
    W = env.width * k,
    H = env.height * k;
  ctx.fillStyle = '#142f39';
  ctx.fillRect(ox, oy, W, H);
  ctx.font = '15px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#92afb9';
  for (let i = 0; i <= 4; i++) ctx.fillText(i + ' m', ox + i * k, oy + H + 30);
  ctx.textAlign = 'right';
  for (let i = 0; i <= 3; i++) ctx.fillText(i + ' m', ox - 12, oy + i * k + 5);
  ctx.strokeStyle = '#45616a';
  ctx.lineWidth = 2;
  ctx.strokeRect(ox, oy, W, H);
  for (const w of env.walls) {
    roundRect(ox + w.x * k, oy + w.y * k + 5, w.w * k, w.h * k, 5, '#0a2029');
    roundRect(ox + w.x * k, oy + w.y * k, w.w * k, w.h * k, 5, '#2e4854', '#526d77');
    ctx.fillStyle = '#bed0d6';
    ctx.font = '15px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(
      task === 'delivery' ? '棚' : '設備',
      ox + (w.x + w.w / 2) * k,
      oy + (w.y + w.h / 2) * k + 5,
    );
  }
  const g = env.goal,
    gx = ox + g.x * k,
    gy = oy + g.y * k,
    gold = task === 'dock' ? '#c4b8ff' : '#f0cc81';
  ctx.fillStyle = task === 'dock' ? '#48446744' : '#ac975426';
  ctx.strokeStyle = gold;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.arc(gx, gy, g.radius * k, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = gold;
  ctx.font = 'bold 16px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(task === 'dock' ? '充電ポート →' : '届け先', gx, gy - g.radius * k - 18);
  if (task === 'dock') {
    ctx.beginPath();
    ctx.moveTo(gx - 12, gy);
    ctx.lineTo(gx + 12, gy);
    ctx.moveTo(gx + 5, gy - 7);
    ctx.lineTo(gx + 12, gy);
    ctx.lineTo(gx + 5, gy + 7);
    ctx.stroke();
  }
  const marker = screen(env.marker.x, env.marker.y);
  roundRect(marker.x - 5, marker.y - 12, 10, 24, 2, gold);
  ctx.fillStyle = '#102832';
  ctx.fillRect(marker.x - 2, marker.y - 7, 4, 4);
  ctx.fillRect(marker.x - 2, marker.y + 3, 4, 4);
  if ($('trailToggle').checked && trail.length > 1) {
    ctx.beginPath();
    trail.forEach((pt, i) => {
      const p = screen(pt.x, pt.y);
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    });
    ctx.strokeStyle = '#6ddbbb80';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  const p = screen(pose.x, pose.y);
  if ($('sensorToggle').checked && observation) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, W, H);
    ctx.clip();
    observation.scan.forEach((d, i) => {
      const a = pose.theta + (i * 2 * Math.PI) / observation.scan.length;
      ctx.strokeStyle = '#78c7b435';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + Math.cos(a) * d * k, p.y + Math.sin(a) * d * k);
      ctx.stroke();
      ctx.fillStyle = '#78c7b4';
      ctx.fillRect(p.x + Math.cos(a) * d * k - 2, p.y + Math.sin(a) * d * k - 2, 4, 4);
    });
    ctx.restore();
  }
  drawRobot(ctx, p, pose);
  const motionSpeed = (pose.left + pose.right) / 2,
    reverse = motionSpeed < -0.01,
    turning = Math.abs(pose.left - pose.right) > 0.01;
  if (Math.abs(motionSpeed) > 0.01) {
    const angle = pose.theta + (reverse ? Math.PI : 0),
      from = 39,
      to = 79;
    ctx.strokeStyle = reverse ? '#ffb467' : '#abf4d8';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(p.x + Math.cos(angle) * from, p.y + Math.sin(angle) * from);
    ctx.lineTo(p.x + Math.cos(angle) * to, p.y + Math.sin(angle) * to);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x + Math.cos(angle) * to, p.y + Math.sin(angle) * to);
    ctx.lineTo(
      p.x + Math.cos(angle) * to - Math.cos(angle - 0.5) * 13,
      p.y + Math.sin(angle) * to - Math.sin(angle - 0.5) * 13,
    );
    ctx.lineTo(
      p.x + Math.cos(angle) * to - Math.cos(angle + 0.5) * 13,
      p.y + Math.sin(angle) * to - Math.sin(angle + 0.5) * 13,
    );
    ctx.closePath();
    ctx.fill();
    ctx.lineCap = 'butt';
  }
  ctx.textAlign = 'right';
  ctx.font = '15px system-ui';
  ctx.fillStyle = '#92afb9';
  ctx.fillText('4.8 × 3.2 m', ox + W, oy + H + 30);
}
function drawCamera(env, pose, observation) {
  const camera = $('cameraView'),
    c = camera.getContext('2d'),
    w = camera.width,
    h = camera.height;
  c.fillStyle = '#223941';
  c.fillRect(0, 0, w, h / 2);
  c.fillStyle = '#152c35';
  c.fillRect(0, h / 2, w, h / 2);
  const fov = (Math.PI * 110) / 180;
  for (let x = 0; x < w; x += 3) {
    const a = pose.theta + (x / w - 0.5) * fov,
      d = Math.max(0.05, env.ray(pose.x, pose.y, a, 6) * Math.cos(a - pose.theta)),
      height = Math.min(h * 1.6, 38 / d);
    c.fillStyle = `rgb(${Math.round(40 + 22 / (d + 0.5))},${Math.round(61 + 28 / (d + 0.5))},${Math.round(71 + 30 / (d + 0.5))})`;
    c.fillRect(x, h / 2 - height / 2, 3, height);
  }
  if (observation.camera.visible) {
    const m = observation.camera,
      px = w / 2 + (m.bearing / fov) * w,
      size = Math.min(70, 28 / Math.max(0.3, m.distance));
    c.fillStyle = env.task === 'dock' ? '#c4b8ff' : '#f0cc81';
    c.fillRect(px - size / 2, h / 2 - size / 2, size, size);
    c.fillStyle = '#162e38';
    c.fillRect(px - size * 0.3, h / 2 - size * 0.3, size * 0.22, size * 0.22);
    c.fillRect(px + size * 0.08, h / 2 + size * 0.08, size * 0.22, size * 0.22);
    c.strokeStyle = '#8be3c0';
    c.strokeRect(px - size / 2 - 4, h / 2 - size / 2 - 4, size + 8, size + 8);
    c.fillStyle = '#c6f6e5';
    c.font = '12px system-ui';
    c.textAlign = 'center';
    c.fillText(m.id, Math.max(22, Math.min(w - 22, px)), Math.max(13, h / 2 - size / 2 - 8));
  }
  c.strokeStyle = '#c2d8df66';
  c.beginPath();
  c.moveTo(w / 2 - 5, h / 2);
  c.lineTo(w / 2 + 5, h / 2);
  c.moveTo(w / 2, h / 2 - 5);
  c.lineTo(w / 2, h / 2 + 5);
  c.stroke();
}
// Static, comparable records: the complete path stays visible while learning continues.
function drawStartMap(canvas, env, { range = 0, results = null, selected = null } = {}) {
  const c = canvas.getContext('2d'),
    w = canvas.width,
    h = canvas.height,
    pad = 22,
    k = Math.min((w - pad * 2) / env.width, (h - pad * 2) / env.height),
    ox = (w - env.width * k) / 2,
    oy = (h - env.height * k) / 2;
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#142f39';
  c.fillRect(0, 0, w, h);
  c.fillStyle = '#1e3943';
  c.fillRect(ox, oy, env.width * k, env.height * k);
  if (!results) {
    const b = env.startBounds(range);
    c.fillStyle = '#7bdbc373';
    for (let px = 0; px < env.width * k; px += 2)
      for (let py = 0; py < env.height * k; py += 2) {
        const x = (px + 1) / k,
          y = (py + 1) / k;
        if (
          x >= b.x0 &&
          x <= b.x1 &&
          y >= b.y0 &&
          y <= b.y1 &&
          !env.blocked(x, y, 0.12) &&
          Math.hypot(x - env.goal.x, y - env.goal.y) > 0.8
        )
          c.fillRect(ox + px, oy + py, 2, 2);
      }
    if (range === 0) {
      c.strokeStyle = '#9aebd6';
      c.lineWidth = 1.5;
      c.strokeRect(ox + b.x0 * k, oy + b.y0 * k, (b.x1 - b.x0) * k, (b.y1 - b.y0) * k);
    }
  }
  for (const wall of env.walls) {
    c.fillStyle = '#52707a';
    c.fillRect(ox + wall.x * k, oy + wall.y * k, wall.w * k, wall.h * k);
  }
  c.strokeStyle = '#eed493';
  c.lineWidth = 2;
  c.setLineDash([4, 3]);
  c.beginPath();
  c.arc(ox + env.goal.x * k, oy + env.goal.y * k, env.goal.radius * k, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([]);
  if (results)
    results.forEach((r, i) => {
      const p = r.trace[0].state,
        x = ox + p.x * k,
        y = oy + p.y * k;
      if (i === selected) {
        c.strokeStyle = '#f6fafb';
        c.lineWidth = 2;
        c.beginPath();
        c.arc(x, y, 12, 0, Math.PI * 2);
        c.stroke();
      }
      c.strokeStyle = r.success ? '#9aebd6' : '#ffc28c';
      c.fillStyle = c.strokeStyle;
      c.lineWidth = 2.5;
      c.beginPath();
      if (r.success) {
        c.arc(x, y, 5, 0, Math.PI * 2);
        c.fill();
      } else {
        c.moveTo(x - 4, y - 4);
        c.lineTo(x + 4, y + 4);
        c.moveTo(x - 4, y + 4);
        c.lineTo(x + 4, y - 4);
        c.stroke();
      }
    });
  canvas.setAttribute(
    'aria-label',
    results
      ? '20回の開始位置と結果。丸は成功、×は未達。白い枠は選択中の試行。'
      : range === 0
        ? '開始位置は部屋の左側の狭い範囲。色の付いた部分から学習します。'
        : '色の付いた範囲から開始位置を抽選します。障害物・壁・目標の周囲は除きます。',
  );
}
function drawTrajectory(canvas, env, result) {
  const c = canvas.getContext('2d'),
    w = canvas.width,
    h = canvas.height,
    pad = 24,
    k = Math.min((w - pad * 2) / env.width, (h - pad * 2) / env.height),
    ox = (w - env.width * k) / 2,
    oy = (h - env.height * k) / 2;
  const point = (s) => [ox + s.x * k, oy + s.y * k];
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#122c36';
  c.fillRect(0, 0, w, h);
  c.fillStyle = '#193640';
  c.fillRect(ox, oy, env.width * k, env.height * k);
  c.strokeStyle = '#3d5962';
  c.lineWidth = 1;
  c.strokeRect(ox, oy, env.width * k, env.height * k);
  for (const wall of env.walls) {
    c.fillStyle = '#39525e';
    c.fillRect(ox + wall.x * k, oy + wall.y * k, wall.w * k, wall.h * k);
  }
  const [gx, gy] = point(env.goal);
  c.strokeStyle = '#ecc985';
  c.fillStyle = '#ecc98524';
  c.lineWidth = 2;
  c.setLineDash([4, 3]);
  c.beginPath();
  c.arc(gx, gy, env.goal.radius * k, 0, Math.PI * 2);
  c.fill();
  c.stroke();
  c.setLineDash([]);
  if (env.task === 'dock') {
    c.beginPath();
    c.moveTo(gx - 7, gy);
    c.lineTo(gx + 8, gy);
    c.lineTo(gx + 3, gy - 4);
    c.moveTo(gx + 8, gy);
    c.lineTo(gx + 3, gy + 4);
    c.stroke();
  }
  const trace = result?.trace || [],
    start = trace[0]?.state || env.state,
    [sx, sy] = point(start);
  if (trace.length) {
    c.strokeStyle = result.success ? '#8adfc2' : '#f2b57b';
    c.lineWidth = 2.7;
    c.lineJoin = 'round';
    c.beginPath();
    trace.forEach((frame, i) => {
      const [x, y] = point(frame.state);
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    });
    c.stroke();
    const end = trace.at(-1).state,
      [x, y] = point(end);
    c.save();
    c.translate(x, y);
    c.rotate(end.theta);
    c.fillStyle = result.success ? '#c0f7df' : '#ffd5a8';
    c.beginPath();
    c.moveTo(8, 0);
    c.lineTo(-5, -5);
    c.lineTo(-5, 5);
    c.closePath();
    c.fill();
    c.restore();
  }
  c.fillStyle = '#a5d9ef';
  c.beginPath();
  c.arc(sx, sy, 4, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = '#122c36';
  c.lineWidth = 1;
  c.stroke();
}

function drawRobot(ctx, p, pose) {
  function roundRect(x, y, w, h, r, fill, stroke) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(pose.theta);
  ctx.shadowColor = '#0008';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 3;
  ctx.beginPath();
  ctx.moveTo(-23, -23);
  ctx.lineTo(13, -23);
  ctx.quadraticCurveTo(17, -23, 20, -19);
  ctx.lineTo(28, -10);
  ctx.quadraticCurveTo(31, -7, 31, -3);
  ctx.lineTo(31, 3);
  ctx.quadraticCurveTo(31, 7, 28, 10);
  ctx.lineTo(20, 19);
  ctx.quadraticCurveTo(17, 23, 13, 23);
  ctx.lineTo(-23, 23);
  ctx.quadraticCurveTo(-27, 23, -27, 19);
  ctx.lineTo(-27, -19);
  ctx.quadraticCurveTo(-27, -23, -23, -23);
  ctx.closePath();
  ctx.fillStyle = '#c4d9db';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = '#effbfa';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  roundRect(-18, -32, 36, 12, 4, '#071b24', '#617c85');
  roundRect(-18, 20, 36, 12, 4, '#071b24', '#617c85');
  ctx.strokeStyle = '#547580';
  ctx.lineWidth = 1.4;
  for (let i = -12; i <= 12; i += 6) {
    ctx.beginPath();
    ctx.moveTo(i, -30);
    ctx.lineTo(i, -23);
    ctx.moveTo(i, 23);
    ctx.lineTo(i, 30);
    ctx.stroke();
  }
  roundRect(-21, -17, 37, 34, 6, '#1a414c', '#4b7079');
  ctx.fillStyle = '#092733';
  ctx.beginPath();
  ctx.arc(-1, 0, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#64d2bb';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(-1, 0, 9, -2.3, 2.3);
  ctx.stroke();
  ctx.fillStyle = '#86e8cb';
  ctx.beginPath();
  ctx.arc(-1, 0, 3, 0, Math.PI * 2);
  ctx.fill();
  roundRect(20, -10, 7, 20, 3, '#081e2b');
  ctx.shadowColor = '#70c9ff';
  ctx.shadowBlur = 8;
  ctx.fillStyle = '#8edaff';
  ctx.beginPath();
  ctx.arc(24, -5, 2.5, 0, Math.PI * 2);
  ctx.arc(24, 5, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = pose.left + pose.right < -0.01 ? '#ffb467' : '#447783';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-24, -10);
  ctx.lineTo(-24, 10);
  ctx.stroke();
  ctx.fillStyle = '#7693a1';
  ctx.fillRect(-16, -11, 7, 3);
  ctx.fillRect(-16, 8, 7, 3);
  ctx.restore();
}

export { drawArena, drawCamera, drawStartMap, drawTrajectory, drawRobot };
