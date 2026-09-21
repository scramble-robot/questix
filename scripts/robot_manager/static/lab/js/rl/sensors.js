const colors = ['#087f75', '#6760bd', '#c07626'];
function graphSpec(mode, view = 'tilt') {
  if (mode === 'impact')
    return {
      title: '衝撃 · 水平加速度',
      unit: 'm/秒²',
      keys: ['impact'],
      labels: ['加速度の大きさ'],
      min: 0,
      max: 16,
      note: '加速度は速さの変わり方です。横軸は時間、縦軸は水平な方向の加速度の大きさで、急な加減速で山ができます。この教材では点線を超えると停止します。衝突以外でも大きくなる場合があります。',
    };
  if (mode === 'wheels')
    return {
      title: '左右の車輪の回転数',
      unit: 'rpm',
      keys: ['left', 'right'],
      labels: ['左車輪', '右車輪'],
      min: -80,
      max: 80,
      note: 'rpmは1分間の回転数です。横軸は時間、縦軸は回る速さで、正は前進方向、負は後退方向です。左右の線に差があると、機体は向きを変えます。',
    };
  if (view === 'heading')
    return {
      title: 'ロボットが向いている方向',
      unit: '°',
      keys: ['yaw'],
      labels: ['向き'],
      min: -180,
      max: 180,
      note: '地図の右向きを0°として、機体がどちらを向いているかを表します。上向きは90°、左向きは180°と−180°で同じ方向です。ここで数値が切り替わっても、機体が急に一回転したわけではありません。',
    };
  if (view === 'rotation')
    return {
      title: '向きを変える速さ',
      unit: '°/秒',
      keys: ['gyro'],
      labels: ['回転速度'],
      min: -180,
      max: 180,
      note: '1秒間に向きが何度変わるかを表します。90°/秒なら、同じ速さで1秒回ると直角ぶん向きが変わります。0は回転なし、正は左回り、負は右回りです。',
    };
  return {
    title: '機体の傾き',
    unit: '°',
    keys: ['pitch', 'roll'],
    labels: ['前後の傾き', '左右の傾き'],
    min: -5,
    max: 5,
    note: '水平な状態が0°です。前後・左右にどれくらい傾いたかを別の線で示します。地図上で向く方向とは別の量です。ここでは、加減速や旋回による小さな揺れを計算で再現しています。',
  };
}
function drawLidar(canvas, scan) {
  const c = canvas.getContext('2d'),
    w = canvas.width,
    h = canvas.height,
    cx = w / 2,
    cy = h / 2 + 7,
    k = 55;
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#f5f9fa';
  c.fillRect(0, 0, w, h);
  c.textAlign = 'left';
  c.font = '24px system-ui';
  for (let r = 1; r <= 3; r++) {
    c.strokeStyle = '#d3e2e5';
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(cx, cy, r * k, 0, 2 * Math.PI);
    c.stroke();
    c.fillStyle = '#607d89';
    c.fillText(r + ' m', cx + r * k + 5, cy + 6);
  }
  c.setLineDash([3, 6]);
  c.beginPath();
  c.moveTo(cx, cy - 3.2 * k);
  c.lineTo(cx, cy + 3.2 * k);
  c.moveTo(cx - 3.2 * k, cy);
  c.lineTo(cx + 3.2 * k, cy);
  c.stroke();
  c.setLineDash([]);
  scan.forEach((d, i) => {
    const a = (i * 2 * Math.PI) / scan.length - Math.PI / 2,
      x = cx + Math.cos(a) * d * k,
      y = cy + Math.sin(a) * d * k;
    c.strokeStyle = '#4baba82b';
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(x, y);
    c.stroke();
    c.fillStyle = d < 0.5 ? '#c57324' : '#158a85';
    c.beginPath();
    c.arc(x, y, d >= 3.18 ? 3 : 5, 0, 2 * Math.PI);
    d >= 3.18 ? c.stroke() : c.fill();
  });
  c.fillStyle = '#153e4a';
  c.beginPath();
  c.moveTo(cx, cy - 15);
  c.lineTo(cx + 10, cy - 4);
  c.lineTo(cx + 10, cy + 12);
  c.lineTo(cx - 10, cy + 12);
  c.lineTo(cx - 10, cy - 4);
  c.closePath();
  c.fill();
  c.fillStyle = '#67cffa';
  c.fillRect(cx - 5, cy - 9, 10, 3);
  c.textAlign = 'center';
  c.fillStyle = '#4e6a77';
  c.fillText('機体の正面', cx, 26);
  c.font = '22px system-ui';
  c.fillText('現在の測距点 · 地図は蓄積していません', cx, h - 10);
}
function drawGraph(canvas, history, spec, threshold, markers) {
  const c = canvas.getContext('2d'),
    w = canvas.width,
    h = canvas.height,
    L = 66,
    R = w - 22,
    T = 32,
    B = h - 66;
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#f5f9fa';
  c.fillRect(0, 0, w, h);
  const end = Math.max(10, history.at(-1)?.t || 0),
    start = end - 10,
    values = history.filter((p) => p.t >= start),
    observed = values.flatMap((p) => spec.keys.map((k) => p[k] || 0));
  let min = spec.min,
    max = spec.max;
  if (spec.keys[0] === 'impact')
    max = Math.max(max, threshold * 1.15, ...observed.map((x) => x * 1.08));
  if (spec.keys[0] === 'gyro') {
    const top = Math.ceil(Math.max(180, ...observed.map(Math.abs)) / 90) * 90;
    min = -top;
    max = top;
  }
  if (spec.keys[0] === 'left') {
    const top = Math.max(80, ...observed.map(Math.abs));
    min = -top;
    max = top;
  }
  const X = (t) => L + ((t - start) / 10) * (R - L),
    Y = (v) => B - ((v - min) / (max - min)) * (B - T);
  c.font = '24px system-ui';
  c.textAlign = 'right';
  c.fillStyle = '#5c7580';
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4,
      y = Y(v);
    c.strokeStyle = '#dce6e8';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(L, y);
    c.lineTo(R, y);
    c.stroke();
    c.fillText(Math.abs(v) < 10 ? v.toFixed(1) : v.toFixed(0), L - 12, y + 6);
  }
  c.textAlign = 'center';
  for (let i = 0; i <= 2; i++) {
    const t = start + i * 5;
    c.fillText(t.toFixed(0) + '秒', X(t), B + 34);
  }
  c.font = '22px system-ui';
  c.fillText('シミュレーション時刻 · 直近10秒', w / 2, h - 8);
  if (spec.keys[0] === 'impact') {
    c.strokeStyle = '#c34a38';
    c.setLineDash([8, 6]);
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(L, Y(threshold));
    c.lineTo(R, Y(threshold));
    c.stroke();
    c.setLineDash([]);
    c.textAlign = 'right';
    c.fillStyle = '#af4d3e';
    c.fillText('停止 ' + threshold.toFixed(0), R, Y(threshold) - 7);
  }
  spec.keys.forEach((key, n) => {
    c.strokeStyle = colors[n];
    c.lineWidth = 2.5;
    c.beginPath();
    let prev = null;
    values.forEach((p) => {
      if (prev === null || (key === 'yaw' && Math.abs(p[key] - prev) > 180))
        c.moveTo(X(p.t), Y(p[key]));
      else c.lineTo(X(p.t), Y(p[key]));
      prev = p[key];
    });
    c.stroke();
  });
  for (const m of markers.filter((m) => m.t >= start && m.t <= end)) {
    c.strokeStyle = '#c05e37';
    c.lineWidth = 2;
    c.setLineDash([3, 5]);
    c.beginPath();
    c.moveTo(X(m.t), T);
    c.lineTo(X(m.t), B);
    c.stroke();
    c.setLineDash([]);
    c.textAlign = 'right';
    c.font = '22px system-ui';
    c.fillStyle = '#a04a2c';
    c.fillText(m.label, Math.min(R, Math.max(L + 95, X(m.t) - 5)), 21);
  }
  return spec.keys.map((key, i) => ({
    label: spec.labels[i],
    color: colors[i],
    value: (history.at(-1)?.[key] || 0).toFixed(1),
  }));
}

export { graphSpec, drawLidar, drawGraph };
