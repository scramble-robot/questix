const colors = ['#3d8b77', '#5d83bf', '#c18837', '#a4abb2'];
function systemEscape(v) {
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
const num = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : '—');
const line = (x, y, X, Y, color = '#77939e', width = 2, dash = '') =>
  `<path d="M${x},${y}L${X},${Y}" fill="none" stroke="${color}" stroke-width="${width}" ${dash ? 'stroke-dasharray="' + dash + '"' : ''}/>`;
const label = (x, y, text, color = '#bdcfd6', size = 16) =>
  `<text x="${x}" y="${y}" fill="${color}" font-size="${size}">${systemEscape(text)}</text>`;
const circle = (x, y, r, color, fill = 'none') =>
  `<circle cx="${x}" cy="${y}" r="${r}" stroke="${color}" fill="${fill}" stroke-width="2"/>`;
function robot(x, y, angle = 0, side = false) {
  return `<g transform="translate(${x} ${y}) rotate(${angle})">${side ? '<rect x="-23" y="-31" width="48" height="23" rx="6" fill="#cedbdc"/><rect x="15" y="-39" width="13" height="11" rx="4" fill="#93bde0"/><circle cx="-8" cy="-11" r="14" fill="#1d2930" stroke="#92adb5" stroke-width="3"/><circle cx="21" cy="-4" r="6" fill="#1d2930" stroke="#92adb5" stroke-width="2"/>' : '<rect x="-21" y="-29" width="42" height="58" rx="10" fill="#d1e0e2"/><rect x="-29" y="-20" width="10" height="40" rx="3" fill="#182a33" stroke="#86a3b0"/><rect x="19" y="-20" width="10" height="40" rx="3" fill="#182a33" stroke="#86a3b0"/><rect x="-13" y="-27" width="26" height="10" rx="5" fill="#21485d"/><circle cx="-6" cy="-22" r="3" fill="#92d1fd"/><circle cx="6" cy="-22" r="3" fill="#92d1fd"/><rect x="-14" y="-11" width="28" height="31" rx="8" fill="#29414a"/><circle r="9" cy="3" fill="#1a3038" stroke="#8bd6be" stroke-width="3"/>'}</g>`;
}
const svg = (body, aria) =>
  `<svg viewBox="0 0 800 350" role="img" aria-label="${systemEscape(aria)}" xmlns="http://www.w3.org/2000/svg"><rect width="800" height="350" fill="#1b303b"/>${body}</svg>`;
function systemDriveState(run, index, started = true) {
  if (run.course !== 'mechanics') return null;
  const s = run.samples[index],
    event = run.events.find((e) => e.kind === 'power-off' || e.kind === 'brake');
  if (run.topic === 'braking')
    return {
      event,
      label: 'ブレーキ',
      value: !started ? '—' : s.v === 0 ? '停止' : s.braking ? '作動中' : 'かける前',
      mode: !started ? 'ready' : s.braking ? 'brake' : 'drive',
      text:
        !started || !s.braking
          ? '3 mの線まで残り' + num(run.config.brakeAt) + ' mになると、ブレーキをかけます。'
          : num(event.t, 1) +
            '秒にブレーキ開始。' +
            (s.v > 0
              ? '減速する間も、機体は前へ進みます。'
              : 'ブレーキをかけた位置から、ここまで進んで停止しました。'),
      replay: 'ブレーキ直前から1倍で見る',
    };
  return {
    event,
    label: 'モーターへの出力',
    value: started ? s.motorPower + ' %' : '—',
    mode: !started ? 'ready' : s.motorPower > 0 ? 'drive' : 'coast',
    text: !started
      ? '開始すると' + run.config.power + ' %で駆動し、3.0秒で自動的に0 %へ切り替えます。'
      : s.motorPower > 0
        ? '3.0秒になると、出力を自動的に0 %にします。'
        : num(event.t, 1) +
          '秒に ' +
          run.config.power +
          ' % → 0 %。' +
          (s.v > 0
            ? '機体はすぐには止まらず、抵抗で減速しながら進みます。'
            : '抵抗で減速し、停止しました。'),
    replay: '出力が0になる直前から1倍で見る',
  };
}
function systemDiagnosticState(run, index, started = true) {
  if (run.course !== 'diagnostics') return null;
  const s = run.samples[index],
    c = run.config;
  const result = s.contact ? '接触' : s.latched ? '停止指示あり' : '停止指示なし';
  if (run.topic === 'distance')
    return {
      label: '停止の判断',
      value: started ? result : '距離で判断',
      mode: s.contact || s.latched ? 'brake' : 'ready',
      text:
        (c.sensorRule === 'both' ? 'LiDARとカメラの近い方' : 'LiDARが測る壁までの距離') +
        'が ' +
        num(c.stopDistance) +
        ' m以下なら停止。' +
        (started
          ? s.contact
            ? '棚までの距離と、判断に使った距離を比べてください。'
            : s.latched
              ? '指示後も減速する間は進みます。'
              : '今、判断に使う距離は ' +
                num(c.sensorRule === 'both' ? Math.min(s.lidar, s.depth) : s.lidar) +
                ' mです。'
          : '棚と壁のどちらを測っているか、線の先を見てください。'),
    };
  if (run.topic === 'missing')
    return {
      label: '距離データの受信',
      value: !started ? '待機中' : s.t < 1.5 ? '更新中' : '更新なし',
      mode: s.t >= 1.5 ? 'coast' : 'ready',
      text: !started
        ? '1.5秒で新しい値が届かなくなります。初めの停止条件は「届いた距離が0.6 m以下」です。'
        : s.t < 1.5
          ? '新しい距離が0.05秒ごとに届いています。'
          : s.latched
            ? '最後の更新から ' +
              num(c.staleLimit) +
              '秒を超えたため停止を指示しました。値が残っていても、今の距離は分かりません。'
            : '最後に届いた距離 ' +
              num(s.range) +
              ' mのまま、' +
              num(s.age) +
              '秒が経過。' +
              (c.watchdog
                ? '更新を待つ時間の上限は ' + num(c.staleLimit) + '秒です。'
                : '0.6 mより大きいので、距離だけの判断では停止しません。'),
    };
  return {
    label: 'IMUによる停止の判断',
    value: !started
      ? '加速度で判断'
      : s.latched
        ? '停止を保持'
        : s.t < 2
          ? '出来事の前'
          : '停止指示なし',
    mode: s.latched ? 'brake' : 'ready',
    text: !started
      ? '2秒で「' +
        (c.eventType === 'bump' ? '小さな段差' : '強い衝撃') +
        '」の模擬データが入ります。加速度の大きさ ' +
        num(c.impactLimit, 1) +
        ' m/秒²以上で停止します。'
      : s.t < 2
        ? '走行開始の加速でもIMUの値は変わります。2秒の出来事と比べてください。'
        : s.latched
          ? '加速度が境目以上になったため停止。値が小さく戻っても、原因を確認して解除するまで停止を保ちます。'
          : 'この出来事の加速度は、設定した境目より小さい値でした。別の出来事も同じ条件で確かめます。',
  };
}
function systemTrackingState(run, index, started = true) {
  if (run.course !== 'tracking') return null;
  const s = run.samples[index],
    c = run.config;
  if (run.topic === 'velocity')
    return {
      label: '位置から求めた相手の速度',
      value: !started || s.velocity === null ? '—' : num(s.velocity) + ' m/秒',
      mode: 'ready',
      text: !started
        ? 'QUESTiXは止めたまま、横切る相手の位置を2回以上測り、動く向きと速さを計算します。'
        : !s.previousObs
          ? 'まだ1回しか測っていないので、動く向きや速さは計算できません。'
          : num(s.previousObs.t, 1) +
            '秒と' +
            num(s.obs.t, 1) +
            '秒に測った位置を比較しています。速度が負なら左へ、正なら右へ動く見積もりです。',
    };
  if (run.topic === 'prediction')
    return {
      label: '相手の予測位置',
      value: num(c.horizon, 1) + '秒先',
      mode: 'ready',
      text:
        !started || !s.predicted
          ? '2回以上の測定で動く向きと速さを求め、「同じ動きが続く」と仮定して先の位置を計算します。'
          : num(s.obs.t, 1) +
            '秒の測定から、' +
            num(s.predicted.targetTime, 1) +
            '秒の位置を予測しています。新しい位置を測るたびに、予測もし直します。',
    };
  return {
    label: 'QUESTiXの判断',
    value: !started ? '開始前' : s.status,
    mode: s.status === '相手を待つ' ? 'brake' : 'ready',
    text:
      (c.rule === 'predict'
        ? '前進し続けると、今から' +
          num(c.horizon, 1) +
          '秒の間に相手のロボットと近づきすぎるかを計算して待ちます。'
        : '今見えている相手のロボットとの距離だけを使い、近くなってから待ちます。') +
      '止める指示を出しても、減速する間は進みます。',
  };
}
function systemTrackingEvidence(run, index, started = true) {
  if (run.course !== 'tracking' || run.topic !== 'prediction') return '';
  const e = started ? run.samples[index].evaluation : null;
  return (
    '<div class="sys-forecast-check"><h3>予測の答え合わせ</h3>' +
    (e
      ? '<p>' +
        num(e.madeAt, 1) +
        '秒に立てた「' +
        num(e.targetTime, 1) +
        '秒の位置の予測」を、' +
        num(e.targetTime, 1) +
        '秒の実際の位置と比べます。</p><dl><div><dt>予測した位置</dt><dd>' +
        num(e.predictedY) +
        ' m</dd></div><div><dt>その時刻の実際の位置</dt><dd>' +
        num(e.actualY) +
        ' m</dd></div><div><dt>二つの位置のずれ</dt><dd>' +
        num(e.error) +
        ' m</dd></div></dl>'
      : '<p>予測した時刻になるまで、正しかったかは分かりません。例えば、2秒に立てた「3秒の位置」の予測は、3秒になってから答え合わせします。</p>') +
    '<p class="muted">位置は図の横方向の目盛りです。答え合わせのグラフは、その時刻になった予測だけを表示します。一時停止すると、数字をゆっくり確認できます。</p></div>'
  );
}
function systemTimingState(run, index, started = true) {
  if (run.course !== 'timing') return null;
  const s = run.samples[index],
    c = run.config;
  if (run.topic === 'alignment')
    return {
      label: '距離と組み合わせる機体位置',
      value: c.align === 'stamp' ? '測定時の位置' : '現在の位置',
      mode: 'ready',
      text:
        s.stamp === null
          ? '距離が届いたら、「機体の位置 ＋ 測った距離」で地図の壁の位置を計算します。'
          : '距離は' +
            num(s.stamp, 2) +
            '秒、機体位置は' +
            num(c.align === 'stamp' ? s.stamp : s.t, 2) +
            '秒の情報を使っています。青い壁が、実際の壁と重なるか見てください。',
    };
  if (run.topic === 'queue')
    return {
      label: 'まだ処理していないデータ',
      value: started ? s.queue + ' 件' : '—',
      mode: s.queue > 10 ? 'coast' : 'ready',
      text:
        '毎秒20件届き、毎秒' +
        c.processing +
        '件を処理します。' +
        (!started
          ? '使い切れない情報は順番待ちになります。'
          : s.stamp === null
            ? '最初に使うデータを待っています。'
            : '今の判断に使うのは、' + num(s.age, 2) + '秒前に測った距離です。'),
    };
  return {
    label: '停止判断に使う距離',
    value: started && s.usedRange !== null ? num(s.usedRange) + ' m' : '—',
    mode: s.contact ? 'brake' : 'ready',
    text:
      !started || s.stamp === null
        ? '届いた距離が0.6 m以下になると、停止を指示します。最初のデータが届くまでは動きません。'
        : c.compensate
          ? num(s.age, 2) + '秒前の距離から、その後に進んだ距離を引いて判断しています。'
          : '使っているのは' +
            num(s.age, 2) +
            '秒前に測った距離です。測った後にも機体が進むため、現在の距離と比べてください。',
  };
}
function systemTimingEvidence(run, index, started = true) {
  if (
    run.course !== 'timing' ||
    run.topic === 'queue' ||
    (run.topic === 'delay' && !run.config.compensate)
  )
    return '';
  const s = run.samples[index],
    map = run.topic === 'alignment',
    same = run.config.align === 'stamp',
    amount = (v) => String(Number(v.toFixed(4)));
  let b =
    '<div class="sys-forecast-check"><h3>' +
    (map ? 'どの時刻の位置と距離を足したか' : '古い距離から、今の距離を見積もる') +
    '</h3>';
  if (!started || s.stamp === null)
    return b + '<p>実験を始めて距離が届くと、この時刻に使った数値を表示します。</p></div>';
  if (map)
    b +=
      '<p>機体の位置（' +
      num(same ? s.stamp : s.t, 2) +
      '秒）＋ 測った距離（' +
      num(s.stamp, 2) +
      '秒）＝ 地図の壁の位置</p><p class="sys-timing-equation">' +
      amount(s.mapBaseX) +
      ' m ＋ ' +
      amount(s.rawRange) +
      ' m ＝ ' +
      amount(s.wallEstimate) +
      ' m</p><p>実際の壁は4.00 m。' +
      (Math.abs(s.wallError) < 1e-8
        ? 'この時刻の計算では一致しています。'
        : 'この時刻のずれは ' + num(Math.abs(s.wallError)) + ' mです。') +
      '</p>';
  else
    b +=
      '<p>測った距離 − 測ってから進んだ距離 ＝ 現在の距離の見積もり</p><p class="sys-timing-equation">' +
      amount(s.rawRange) +
      ' m − ' +
      amount(s.x - s.measuredX) +
      ' m ＝ ' +
      amount(s.usedRange) +
      ' m</p><p>この実験では車輪の回転から移動量を正しく求められる設定です。実機では車輪の滑りなどが補正の誤差になります。</p>';
  return (
    b + '<p class="muted">再生を一時停止すると、その時刻の計算をゆっくり確認できます。</p></div>'
  );
}
const SYSTEM_CHARTS = {
  mechanics: [
    {
      title: '速さ',
      unit: 'm/秒',
      lines: [
        ['v', '機体の速さ'],
        ['wheelSpeed', '車輪の回転から求めた速さ'],
      ],
    },
    { title: '前後の力の差', unit: 'N', lines: [['force', '前進させる力 − 抵抗する力']] },
    { title: '加速度', unit: 'm/秒²', lines: [['accel', '速さの変わり方']] },
    {
      title: '移動した位置',
      unit: 'm',
      lines: [
        ['x', '実際の位置'],
        ['odom', '車輪の回転で推定した位置'],
      ],
    },
  ],
  behavior: [
    {
      title: '車輪の回転数',
      unit: 'rpm',
      lines: [
        ['left', '左車輪'],
        ['right', '右車輪'],
      ],
    },
    { title: '走行の速さ', unit: 'm/秒', lines: [['v', '機体の速さ']] },
  ],
  tracking: [
    {
      title: '相手のロボットの速度',
      unit: 'm/秒',
      lines: [
        ['actualVelocity', '相手のロボットの実際の速度'],
        ['velocity', '測った位置から求めた速度'],
      ],
    },
    {
      title: '予測の答え合わせ',
      unit: 'm',
      lines: [['predictionError', '予測した位置と、その時刻の実際の位置のずれ']],
    },
    { title: '互いの間隔', unit: 'm', lines: [['separation', '相手とQUESTiXの表面の間隔']] },
    {
      title: '相手のロボットの位置',
      unit: 'm',
      lines: [
        ['actualPosition', '相手のロボットの実際の位置'],
        ['observedPosition', 'カメラで測った位置'],
      ],
    },
  ],
  coordination: [{ title: '手先と目標の距離', unit: 'mm', lines: [['error', '位置のずれ']] }],
  timing: [
    {
      title: '壁までの距離',
      unit: 'm',
      lines: [
        ['range', '現在の実際の距離（観察用）'],
        ['usedRange', '停止判断に使った距離'],
      ],
    },
    {
      title: '使った情報の古さ',
      unit: '秒',
      lines: [['age', '測った時刻から判断に使うまでの時間']],
    },
    {
      title: '地図へ置いた壁のずれ',
      unit: 'm',
      lines: [['wallError', '計算した壁の位置と、実際の4 mとの差']],
    },
    { title: '処理待ちの件数', unit: '件', lines: [['queue', '届いたが、まだ処理していない件数']] },
  ],
  diagnostics: [
    {
      title: 'センサーの距離',
      unit: 'm',
      lines: [
        ['lidar', 'LiDAR'],
        ['depth', '奥行き'],
        ['range', '最後に届いた距離'],
      ],
    },
    { title: '情報の古さ', unit: '秒', lines: [['age', '最後の測定からの時間']] },
    { title: 'IMUの加速度', unit: 'm/秒²', lines: [['accel', '重力を除く前後の加速度']] },
  ],
};
function systemChart(run, index, chartIndex = 0, previous = null) {
  let chart = SYSTEM_CHARTS[run.course][chartIndex] || SYSTEM_CHARTS[run.course][0];
  if (run.course === 'diagnostics' && chartIndex === 0)
    chart = {
      ...chart,
      lines:
        run.topic === 'missing'
          ? [
              ['depth', '現在の距離（観察用）'],
              ['range', '最後に届いた距離（判断に使用）'],
            ]
          : [
              ['lidar', 'LiDAR：奥の壁まで'],
              ['depth', 'RGB-Dカメラ：棚まで'],
            ],
    };
  const seen = run.samples.slice(0, index + 1),
    values = seen.flatMap((s) => chart.lines.map((l) => s[l[0]]).filter(Number.isFinite));
  const threshold =
    run.course === 'timing' && chartIndex === 0
      ? 0.6
      : run.course !== 'diagnostics'
        ? null
        : run.topic === 'distance' && chartIndex === 0
          ? run.config.stopDistance
          : run.topic === 'missing' && chartIndex === 1 && run.config.watchdog
            ? run.config.staleLimit
            : run.topic === 'impact' && chartIndex === 2
              ? run.config.impactLimit
              : null;
  if (threshold !== null) values.push(threshold);
  if (previous)
    values.push(
      ...previous.samples.flatMap((s) => chart.lines.map((l) => s[l[0]]).filter(Number.isFinite)),
    );
  const lo = Math.min(0, ...values),
    hi = Math.max(1, ...values),
    pad = (hi - lo) * 0.08,
    Y = (v) => 195 - ((v - lo + pad) / (hi - lo + 2 * pad)) * 150,
    T = Math.max(run.duration, previous?.duration ?? 0),
    X = (t) => 62 + (t / T) * 675;
  const path = (samples, key) => {
    let connected = false;
    return samples
      .map((s) => {
        if (!Number.isFinite(s[key])) {
          connected = false;
          return '';
        }
        const part = (connected ? 'L' : 'M') + X(s.t).toFixed(1) + ',' + Y(s[key]).toFixed(1);
        connected = true;
        return part;
      })
      .join('');
  };
  const transition = run.events.find((e) =>
      ['power-off', 'brake', 'data-loss', 'shock', 'turn', 'stop-command'].includes(e.kind),
    ),
    reached = transition && transition.t <= seen.at(-1).t,
    marker =
      (transition && (transition.kind === 'power-off' || reached)
        ? '<g class="sys-chart-transition">' +
          line(X(transition.t), 40, X(transition.t), 195, '#b27628', 2, '5 4') +
          label(
            Math.min(595, Math.max(95, X(transition.t) + 8)),
            24,
            num(transition.t, 1) + '秒 ' + transition.label,
            '#885817',
            14,
          ) +
          '</g>'
        : '') +
      (threshold !== null
        ? line(62, Y(threshold), 738, Y(threshold), '#a9633b', 1.5, '6 4') +
          label(
            550,
            Math.max(50, Y(threshold) - 8),
            '停止の境目 ' + num(threshold, 1),
            '#885817',
            13,
          )
        : '');
  return `<div class="sys-chart-legend">${chart.lines.map((l, i) => '<span><i style="background:' + colors[i] + '"></i>' + l[1] + '</span>').join('')}${previous ? '<span class="sys-chart-style-key">実線：今回 ／ 破線：前回（同じ色の値を比較）</span>' : ''}</div><svg viewBox="0 0 800 235" role="img" aria-label="横軸は開始からの秒数。縦軸は${systemEscape(chart.unit)}"><rect width="800" height="235" fill="#f6f8f9"/>${[lo, (lo + hi) / 2, hi].map((v) => line(62, Y(v), 738, Y(v), '#dfe6e8', 1) + label(8, Y(v) + 5, num(v, 1), '#586e79', 14)).join('')}${label(14, 22, chart.unit, '#586e79', 14)}${[0, T / 2, T].map((t) => label(X(t) - 9, 222, num(t, 1) + '秒', '#586e79', 14)).join('')}${previous ? chart.lines.map((l, i) => '<path d="' + path(previous.samples, l[0]) + '" fill="none" stroke="' + colors[i] + '" stroke-opacity=".65" stroke-width="2" stroke-dasharray="6 5"/>').join('') : ''}${chart.lines.map((l, i) => '<path d="' + path(seen, l[0]) + '" fill="none" stroke="' + colors[i] + '" stroke-width="2.5"/>').join('')}${marker}${line(X(seen.at(-1).t), 40, X(seen.at(-1).t), 195, '#627581', 1, '3 4')}</svg>`;
}
function trackingScene(run, index) {
  const s = run.samples[index],
    crossing = run.topic === 'crossing',
    predicting = run.topic === 'prediction';
  // Rotate the room, not the simulation: QUESTiX faces up and its target crosses
  // right to left. Keep one fixed metric scale, including both collision circles.
  const k = 115,
    X = (y) => 250 + y * k,
    Y = (x) => 590 - x * k,
    r = 0.18 * k;
  const qx = X(s.y),
    qy = Y(s.x),
    tx = X(s.cart.y),
    ty = Y(s.cart.x),
    mx = X(s.obs.y);
  const direction = s.actualVelocity < 0 ? -1 : 1,
    forecast = s.predicted ? X(s.predicted.y) : null;
  const visibleForecast = forecast === null ? null : Math.max(48, Math.min(752, forecast));
  const offscreen = forecast !== null && forecast !== visibleForecast;
  const arrow = (x, y, xx, yy, color) => {
    const a = Math.atan2(yy - y, xx - x),
      n = 9;
    return (
      line(x, y, xx, yy, color, 3) +
      line(xx, yy, xx - n * Math.cos(a - 0.55), yy - n * Math.sin(a - 0.55), color, 3) +
      line(xx, yy, xx - n * Math.cos(a + 0.55), yy - n * Math.sin(a + 0.55), color, 3)
    );
  };
  const centered = (x, y, text, color, size = 17) =>
    '<g text-anchor="middle">' + label(x, y, text, color, size) + '</g>';
  const glyph = (x, y, angle, other = false) =>
    '<g data-tracking-robot="' +
    (other ? 'target' : 'questix') +
    '" transform="translate(' +
    x +
    ' ' +
    y +
    ')">' +
    circle(0, 0, r, other ? '#aebec5' : '#82cfb5', other ? '#6e859042' : '#67b59920') +
    '<g transform="scale(' +
    r / 37 +
    ')">' +
    robot(0, 0, angle).replaceAll('#8bd6be', other ? '#d2dce1' : '#8bd6be') +
    '</g></g>';
  let b = '<rect x="28" y="28" width="744" height="552" rx="14" fill="#233e4a"/>';
  // The pale strip is the scenario's route; only blue dots are measurements.
  b += '<rect x="40" y="' + (ty - 43) + '" width="720" height="86" rx="8" fill="#bacad00e"/>';
  b +=
    line(40, ty - 43, 760, ty - 43, '#76919b', 1) + line(40, ty + 43, 760, ty + 43, '#76919b', 1);
  b += label(54, ty + 72, '相手のロボットが通る道', '#c3d3db', 18);
  if (crossing) {
    b += '<rect x="' + (qx - 43) + '" y="60" width="86" height="510" rx="8" fill="#78c8a915"/>';
    b += line(qx, 545, qx, 108, '#86bda8', 2, '8 9') + circle(qx, Y(4.4), r, '#92d8bd');
    b +=
      centered(qx, Y(4.4) + 6, '◎', '#a6e6cb', 22) +
      label(qx + 39, Y(4.4) + 6, 'ゴール', '#b5e8d4', 18);
    b += centered(qx, ty - 69, '二つの進路が交わる場所', '#e0dbb8', 16);
  } else {
    b +=
      arrow(qx, qy - 40, qx, qy - 110, '#8bd6be') +
      label(qx + 24, qy - 83, 'カメラの正面', '#a6e0cc', 17);
  }
  b += label(54, 64, '部屋を上から見る', '#bfd1d8', 17);
  if (!crossing) {
    b +=
      label(54, 110, '相手の横方向の位置（m）', '#afc6d0', 15) +
      line(92, 145, 710, 145, '#718d99', 1);
    for (let n = -1; n <= 3; n++)
      b += line(X(n), 139, X(n), 151, '#a5bbc5', 1) + centered(X(n), 133, String(n), '#c2d2d9', 16);
    b += line(qx, qy - 22, mx, ty, '#83b7ec66', 1.5, '4 7');
  }
  if (!crossing && s.previousObs)
    b +=
      circle(X(s.previousObs.y), ty, 6, '#9ac3ff') +
      line(X(s.previousObs.y), ty, mx, ty, '#9ac3ff', 2);
  if (predicting && s.predicted) {
    b += line(mx, ty, visibleForecast, ty, '#efcf80', 2, '5 5');
    b +=
      '<circle data-tracking-forecast cx="' +
      visibleForecast +
      '" cy="' +
      ty +
      '" r="' +
      (r + 6) +
      '" fill="none" stroke="#efcf80" stroke-width="3" stroke-dasharray="5 4"/>';
    b += line(visibleForecast, ty - 31, visibleForecast, ty - 57, '#efcf80', 1.5);
    b += centered(
      Math.max(122, Math.min(674, visibleForecast)),
      ty - 68,
      offscreen ? '予測は図の外' : num(s.predicted.targetTime, 1) + '秒の予測位置',
      '#efcf80',
      17,
    );
  }
  b += arrow(
    tx + direction * 32,
    ty,
    Math.max(48, Math.min(752, tx + direction * 95)),
    ty,
    '#d9e2e7',
  );
  b += glyph(tx, ty, direction < 0 ? -90 : 90, true) + glyph(qx, qy, 0);
  b += circle(mx, ty, 6, '#c6dfff', '#568bd9');
  b += centered(Math.max(108, Math.min(690, tx)), ty + 105, '相手のロボット', '#e0e9ee', 18);
  const qLabelY = Math.max(110, Math.min(553, qy + 6));
  b += label(qx + 38, qLabelY, 'QUESTiX', '#a6e0cc', 18);
  if (crossing && s.status === '接触して終了')
    b +=
      circle((tx + qx) / 2, (ty + qy) / 2, r + 12, '#ee9b83') +
      label(qx + 38, qLabelY + 25, '接触', '#ffb7a4', 18);
  else
    b += label(
      qx + 38,
      qLabelY + 25,
      crossing ? (s.status === '相手を待つ' ? '減速・待機' : s.status) : '止まって観察',
      '#c4d6dd',
      16,
    );
  const aria =
    'QUESTiXは画面の上を向く。相手のロボットは、その正面を' +
    (direction < 0 ? '右から左' : '左から右') +
    'へ移動中。' +
    (crossing ? 'QUESTiXも上のゴールへ進む。' : 'QUESTiXは下で止まり、相手の位置をカメラで測る。') +
    '青い点は直近の測定位置。' +
    (predicting ? '黄色の輪は測定から' + num(run.config.horizon, 1) + '秒先の予測位置。' : '') +
    '開始から' +
    num(s.t, 1) +
    '秒。';
  return (
    '<div class="sys-tracking-scene"><div class="sys-tracking-context"><strong>' +
    (crossing
      ? 'QUESTiXも進み、相手が横切るときは待ちます。'
      : 'QUESTiXは止まり、正面を横切る相手をカメラで観察します。') +
    '</strong></div><svg viewBox="0 0 800 610" role="img" aria-label="' +
    systemEscape(aria) +
    '"><rect width="800" height="610" fill="#1b303b"/>' +
    b +
    '</svg><div class="sys-tracking-key"><span><i class="tracking-measured"></i>青い点：カメラで測った相手の中心<span class="sys-tracking-stamp">' +
    num(s.obs.t, 1) +
    '秒の測定</span></span>' +
    (predicting
      ? '<span><i class="tracking-predicted"></i>黄色の輪：測定から' +
        num(run.config.horizon, 1) +
        '秒先の予測<span class="sys-tracking-stamp">' +
        (s.predicted
          ? num(s.predicted.targetTime, 1) +
            '秒にいると見積もった場所' +
            (offscreen ? '（図の外）' : '')
          : '2回以上測ると表示') +
        '</span>'
      : '') +
    '</div></div>'
  );
}
function timingScene(run, index) {
  const s = run.samples[index],
    map = run.topic === 'alignment',
    X = (x) => 55 + (x / 4.8) * 690,
    floor = 260;
  let b = label(28, 28, '1件の距離データが判断に使われるまで');
  const times = [
    ['① 距離を測った時刻', s.stamp],
    ['② 情報が届いた時刻', s.receive],
    ['③ 今、判断に使う時刻', s.stamp === null ? null : s.t],
  ];
  times.forEach(([title, value], i) => {
    const px = 48 + i * 245;
    b += label(px, 59, title, '#b8ccd5', 13) + label(px, 86, num(value, 2) + ' 秒', '#e0ebef', 19);
    if (i < 2) b += label(px + 195, 80, '→', '#90aab6', 20);
  });
  b += line(45, floor, 750, floor, '#8c9fa5', 2);
  for (let n = 0; n <= 4; n++)
    b += line(X(n), floor, X(n), floor + 8) + label(X(n) - 8, floor + 30, n + ' m', undefined, 14);
  b +=
    '<rect x="' +
    X(4) +
    '" y="132" width="17" height="128" fill="#8e9da5"/>' +
    label(X(4) - 24, 119, '実際の壁', '#cedbe0', 14);
  if (!map) b += line(X(3.5), 220, X(3.5), floor, '#e7ca81', 2, '5 4');
  if (s.measuredX !== null) {
    if (s.x - s.measuredX > 0.04)
      b += '<g opacity=".35">' + robot(X(s.measuredX), floor, 0, true) + '</g>';
    if (map) {
      b +=
        label(48, 125, '青：計算して地図に置いた壁', '#98bfff', 16) +
        line(X(s.wallEstimate), 140, X(s.wallEstimate), floor, '#91bfff', 4);
      b +=
        line(X(s.mapBaseX), 184, X(s.wallEstimate), 184, '#91bfff', 2, '5 4') +
        label(48, 157, '計算した壁の位置 ' + num(s.wallEstimate) + ' m', '#91bfff', 17);
    } else {
      b +=
        label(48, 125, '測ったときの距離 ' + num(s.rawRange) + ' m', '#e6c189', 16) +
        label(48, 156, '現在の実際の距離 ' + num(s.range) + ' m', '#8bd6be', 16);
      b +=
        line(X(s.measuredX), 179, X(4), 179, '#e6c189', 2, '4 5') +
        line(X(s.x), 200, X(4), 200, '#8bd6be', 2);
    }
  } else b += label(48, 134, '最初の距離データが届くのを待っています', '#c6d9e3', 16);
  b +=
    robot(X(s.x), floor, 0, true) +
    label(
      48,
      324,
      map
        ? '薄い機体：距離を測ったときの位置　実線の機体：現在の位置'
        : '薄い機体：測定時の位置　点線：止まりたい位置（壁の0.5 m手前）',
      '#c3d5dc',
      14,
    );
  return svg(
    b,
    '測った時刻 ' +
      num(s.stamp, 2) +
      '秒、届いた時刻 ' +
      num(s.receive, 2) +
      '秒、判断に使う時刻 ' +
      num(s.t, 2) +
      '秒。' +
      (map ? '灰色は実際の壁、青は地図へ置いた壁。' : '薄い機体は測定時、実線の機体は現在。') +
      s.status,
  );
}
function systemScene(run, index) {
  if (run.course === 'timing') return timingScene(run, index);
  if (run.course === 'tracking') return trackingScene(run, index);
  const s = run.samples[index],
    course = run.course;
  let b = label(
    28,
    32,
    course === 'coordination'
      ? 'アームを横から見る'
      : course === 'behavior' || course === 'tracking'
        ? '部屋を上から見る'
        : 'ロボットを横から見る',
  );
  if (course === 'coordination') {
    const X = (v) => 120 + v * 1.65,
      Y = (v) => 302 - v * 1.05;
    b +=
      line(120, 302, 750, 302) +
      line(120, 302, 120, 76) +
      label(558, 330, '根元からの横位置（mm）', undefined, 14) +
      label(22, 70, '高さ（mm）', undefined, 14) +
      label(72, 330, '根元（肩）', undefined, 14);
    b += line(X(40), Y(30), X(s.target.x), Y(s.target.z), '#708995', 1.5, '5 5');
    if (run.topic === 'calibrate')
      for (const p of [
        { x: 140, z: 80 },
        { x: 210, z: 130 },
        { x: 130, z: 180 },
      ])
        b += circle(X(p.x), Y(p.z), 5, '#aebbd6');
    b +=
      line(X(0), Y(0), X(s.elbow.x), Y(s.elbow.z), '#8bd6be', 13) +
      line(X(s.elbow.x), Y(s.elbow.z), X(s.tip.x), Y(s.tip.z), '#95b9ee', 11);
    for (const p of [s.base, s.elbow, s.tip]) b += circle(X(p.x), Y(p.z), 8, '#d7e6e7', '#203c48');
    b +=
      '<rect x="' +
      (X(s.target.x) - 12) +
      '" y="' +
      (Y(s.target.z) - 12) +
      '" width="24" height="24" rx="3" fill="#e9ca8533" stroke="#e9ca85" stroke-width="2"/>' +
      circle(X(s.estimate.x), Y(s.estimate.z), 8, '#91bfff') +
      label(458, 58, '黄：手先を近づけたい物体', '#e9ca85') +
      label(458, 82, '青：計算した手先の行き先', '#91bfff');
    b +=
      '<rect x="' +
      (X(40) - 12) +
      '" y="' +
      (Y(30) - 7) +
      '" width="24" height="14" rx="4" fill="#91bfff"/>' +
      label(X(40) + 24, Y(30), 'RGB-Dカメラ', '#91bfff', 14) +
      label(458, 110, '物体と手先の距離 ' + num(s.error, 1) + ' mm', '#dfeaed');
  } else if (course === 'behavior' || course === 'tracking') {
    const X = (x) => 55 + x * 145,
      Y = (y) => (course === 'tracking' ? 57 + (y + 1) * 52 : 57 + y * 75);
    b += '<rect x="55" y="50" width="690" height="270" rx="8" fill="#233e4a"/>';
    b +=
      '<path d="' +
      run.samples
        .slice(0, index + 1)
        .filter((_, i) => i % 3 === 0)
        .map((p, i) => (i ? 'L' : 'M') + X(p.x) + ',' + Y(p.y))
        .join('') +
      '" fill="none" stroke="#74b7a0" stroke-width="2"/>';
    if (course === 'behavior') {
      const py = run.topic === 'missing' ? 0.7 : 2;
      b +=
        '<rect x="' +
        (X(1.3) - 8) +
        '" y="' +
        (Y(py) - 8) +
        '" width="16" height="16" rx="3" fill="#dab57e"/>' +
        label(X(1.3) - 30, Y(py) - 23, '荷物', undefined, 14) +
        circle(X(4.3), Y(2), 26, '#e7ca81') +
        label(X(4.3) - 30, Y(2) - 39, '届け先', undefined, 14);
      if (s.blocked)
        b +=
          '<rect x="' +
          X(2.45) +
          '" y="' +
          Y(1.4) +
          '" width="58" height="90" rx="5" fill="#ab7459"/>' +
          label(X(2.4), Y(1.25), '障害物', '#e7b692', 14);
      b += robot(X(s.x), Y(s.y), (s.theta * 180) / Math.PI + 90);
      if (s.hasParcel)
        b +=
          '<rect x="' +
          (X(s.x) - 6) +
          '" y="' +
          (Y(s.y) - 6) +
          '" width="12" height="12" fill="#e2bd80"/>';
    }
  } else {
    const extent =
        course === 'mechanics'
          ? Math.max(4.4, ...run.samples.map((p) => Math.max(p.x, p.odom ?? 0))) * 1.06
          : 4.8,
      X = (x) => 55 + (x / extent) * 690,
      floor = 260;
    b += line(45, floor, 750, floor, '#8c9fa5', 2);
    for (let n = 0; n <= Math.floor(extent); n += extent > 10 ? 2 : 1)
      b +=
        line(X(n), floor, X(n), floor + 8) + label(X(n) - 8, floor + 30, n + ' m', undefined, 14);
    if (course === 'mechanics') {
      if (run.topic === 'braking')
        b +=
          line(X(3), 100, X(3), floor, '#e7ca81', 3) +
          label(X(3) - 25, 80, '3 mの線', '#e7ca81', 15);
      const transition = run.events.find((e) => e.kind === 'power-off' || e.kind === 'brake');
      if (transition && transition.t <= s.t)
        b +=
          line(X(transition.x), 145, X(transition.x), floor, '#dfac64', 2, '5 5') +
          circle(X(transition.x), floor, 5, '#dfac64', '#dfac64') +
          label(
            Math.max(40, Math.min(565, X(transition.x) - 65)),
            132,
            transition.kind === 'power-off' ? '出力を0 %にした位置' : 'ブレーキを始めた位置',
            '#e7bf80',
            14,
          );
      if (run.topic === 'traction')
        b +=
          '<g opacity=".55">' +
          robot(X(s.odom), floor, 0, true) +
          '</g>' +
          label(
            Math.max(32, Math.min(565, X(s.odom) - 100)),
            180,
            '車輪の回転で推定した位置',
            '#91bfff',
            14,
          );
      b +=
        robot(X(s.x), floor, 0, true) +
        label(X(s.x) - 22, 197, run.config.mass + ' kg', '#c7dadd', 14) +
        label(
          45,
          104,
          '前後の力の差 ' + num(s.force, 1) + ' N　加速度 ' + num(s.accel, 2) + ' m/秒²',
          '#c6d6dd',
          16,
        ) +
        label(
          45,
          70,
          '機体 ' + num(s.v) + ' m/秒　車輪から ' + num(s.wheelSpeed) + ' m/秒',
          '#a8dcca',
          17,
        );
    } else {
      if (course !== 'diagnostics' || run.topic === 'distance')
        b +=
          '<rect x="' +
          X(4) +
          '" y="75" width="17" height="185" fill="#8e9da5"/>' +
          label(X(4) - 13, 60, '壁', undefined, 15);
      if (run.topic === 'distance') {
        b +=
          '<rect x="' +
          X(3.2) +
          '" y="174" width="' +
          (X(4) - X(3.2)) +
          '" height="62" fill="#b57959"/>' +
          label(X(3.05) - 10, 152, '棚の張り出し', '#e3b794', 15) +
          line(X(s.x), 245, X(4), 245, '#7dd4cb', 2, '5 4') +
          line(X(s.x) + 25, 222, X(3.2), 222, '#98bfff', 2, '5 4');
        b +=
          label(48, 77, 'LiDAR → 奥の壁まで ' + num(s.lidar) + ' m', '#7dd4cb', 17) +
          label(48, 109, 'RGB-Dカメラ → 棚まで ' + num(s.depth) + ' m', '#98bfff', 17);
      } else if (run.topic === 'missing') {
        b +=
          '<rect x="' +
          X(3.2) +
          '" y="145" width="20" height="115" fill="#a8846b"/>' +
          label(X(3.2) - 22, 125, '障害物', '#e3b794', 15);
        b +=
          line(X(s.x), 235, X(3.2), 235, '#7dd4cb', 2, s.t >= 1.5 ? '2 8' : '5 4') +
          label(48, 79, '最後に届いた距離 ' + num(s.range) + ' m', '#98bfff', 18) +
          label(
            48,
            111,
            s.t < 1.5 ? '新しい値を受信中' : '1.5秒以降、距離の数字は更新されない',
            s.t < 1.5 ? '#bdcfd6' : '#e7bf80',
            15,
          ) +
          label(48, 325, '現在の距離（観察用） ' + num(s.depth) + ' m', '#bdcfd6', 15);
      } else {
        const event = run.events.find((e) => e.kind === 'shock');
        b +=
          label(48, 80, 'IMUの加速度 ' + num(s.accel, 1) + ' m/秒²', '#dce5ea', 18) +
          label(
            48,
            112,
            '停止の境目 ' + num(run.config.impactLimit, 1) + ' m/秒²以上',
            '#e7bf80',
            15,
          );
        if (event && s.t >= event.t) {
          b +=
            line(X(event.x), 165, X(event.x), floor, '#e7bf80', 2, '4 5') +
            label(Math.max(48, X(event.x) - 65), 146, '2秒：' + event.label, '#e7bf80', 16);
          if (s.t < 2.2) b += circle(X(s.x), floor - 24, 36, '#e7bf80');
        }
        b += label(48, 325, '出来事に相当するIMUの波形を入力する実験', '#bdcfd6', 15);
      }
      b += robot(X(s.x), floor, 0, true);
    }
  }
  return svg(b, s.status + '、開始から' + num(s.t, 1) + '秒');
}

export {
  systemEscape,
  systemDriveState,
  systemDiagnosticState,
  systemTrackingState,
  systemTrackingEvidence,
  systemTimingState,
  systemTimingEvidence,
  SYSTEM_CHARTS,
  systemChart,
  systemScene,
};
