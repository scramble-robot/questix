// Integrate actual wheel speed. Multiplying the current speed by elapsed time
// would make the wheel jump backwards when a load slows it down.
function controlWheelAngle(samples, index) {
  let turns = 0;
  for (let i = 1; i <= index; i++)
    turns +=
      (((samples[i - 1].rpm + samples[i].rpm) / 2) * (samples[i].time - samples[i - 1].time)) / 60;
  return turns * Math.PI * 2;
}

function drawControlBench(ctx, { compact, angle, measured, started, blocked, description }) {
  const box = (x, y, w, h, r, fill, stroke) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  };
  ctx.save();
  if (!compact) ctx.translate(50, 0);
  ctx.font = '18px system-ui';
  ctx.fillStyle = '#d4e4e8';
  ctx.fillText('横から見た図', 24, 32);
  // Floor and support touch; the tire does not. In a side view the other
  // driven wheel is behind the visible one, not a second front/rear wheel.
  ctx.strokeStyle = '#617983';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(24, 266);
  ctx.lineTo(456, 266);
  ctx.stroke();
  ctx.fillStyle = '#a8bec6';
  ctx.font = '16px system-ui';
  ctx.fillText('床', 431, 289);
  box(138, 158, 186, 12, 3, '#708894');
  for (const x of [145, 308]) {
    box(x, 170, 10, 87, 2, '#526f7d');
    box(x - 14, 257, 38, 8, 2, '#8ca1ab');
  }
  box(131, 87, 208, 71, 15, '#bdcfd6', '#ecf4f6');
  box(143, 101, 174, 30, 7, '#304d59');
  ctx.fillStyle = '#8ad2c2';
  ctx.fillRect(151, 109, 37, 4);
  box(317, 101, 32, 23, 6, '#213d50', '#7b9cac');
  ctx.beginPath();
  ctx.arc(338, 112, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#9ecfff';
  ctx.fill();
  box(248, 72, 42, 15, 5, '#89a5af');
  box(254, 65, 30, 9, 3, '#284650', '#84bfb7');
  // Tire, hub and one contrasting spoke make rotation directly visible.
  ctx.save();
  ctx.translate(231, 164);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.arc(0, 0, 44, 0, Math.PI * 2);
  ctx.fillStyle = '#10232c';
  ctx.fill();
  ctx.strokeStyle = '#7e969f';
  ctx.lineWidth = 3;
  ctx.stroke();
  for (let i = 0; i < 16; i++) {
    const a = (i * Math.PI) / 8;
    ctx.strokeStyle = '#3a535f';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(38 * Math.cos(a), 38 * Math.sin(a));
    ctx.lineTo(42 * Math.cos(a), 42 * Math.sin(a));
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(0, 0, 31, 0, Math.PI * 2);
  ctx.fillStyle = '#385864';
  ctx.fill();
  for (let i = 0; i < 4; i++) {
    ctx.rotate(Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(29, 0);
    ctx.strokeStyle = i === 0 ? '#b7f0de' : '#738e99';
    ctx.lineWidth = i === 0 ? 6 : 4;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(0, 0, 10, 0, Math.PI * 2);
  ctx.fillStyle = '#a9c8ce';
  ctx.fill();
  ctx.restore();
  // Label the actual gap, rather than relying on a caption to explain it.
  ctx.strokeStyle = '#e5c482';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(231, 216);
  ctx.lineTo(231, 259);
  ctx.moveTo(226, 216);
  ctx.lineTo(236, 216);
  ctx.moveTo(226, 259);
  ctx.lineTo(236, 259);
  ctx.moveTo(239, 238);
  ctx.lineTo(272, 238);
  ctx.stroke();
  ctx.fillStyle = '#e5c482';
  ctx.font = '16px system-ui';
  ctx.fillText('タイヤは床に触れない', 279, 242);
  ctx.strokeStyle = '#a4bac4';
  ctx.beginPath();
  ctx.moveTo(100, 193);
  ctx.lineTo(121, 193);
  ctx.lineTo(145, 216);
  ctx.stroke();
  ctx.fillStyle = '#c9dce3';
  ctx.fillText('支持台', 44, 199);
  ctx.restore();
  ctx.fillStyle = blocked ? '#f4c085' : '#b8ccd3';
  ctx.font = '16px system-ui';
  ctx.fillText(description, compact ? 24 : 74, 320);
  if (!compact) {
    ctx.fillStyle = '#c9dce3';
    ctx.font = '18px system-ui';
    ctx.fillText('左右の車輪の回転数', 612, 115);
    ctx.font = '38px system-ui';
    ctx.fillText((started ? measured.toFixed(1) : '—') + ' rpm', 612, 164);
    ctx.font = '16px system-ui';
    ctx.fillStyle = '#a8bec6';
    ctx.fillText('奥の車輪も同じ速さで回ります', 612, 202);
  }
}

export { controlWheelAngle, drawControlBench };
