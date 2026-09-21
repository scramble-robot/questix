import { SYSTEM_TOPICS, systemDefaults } from './data.js';
import { armFK, armIK } from '../arm/core.js';

const dt = 0.05,
  clamp = (x, a, b) => Math.max(a, Math.min(b, x)),
  rad = (x) => (x * Math.PI) / 180;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const metric = (label, value, unit = '', digits = 2) => ({ label, value, unit, digits });
function seedNoise() {
  let n = 917;
  return () => {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    return (n / 4294967296) * 2 - 1;
  };
}
function validateSystemConfig(course, id, input = {}) {
  const topic = SYSTEM_TOPICS[course]?.find((t) => t.id === id);
  if (!topic) throw new Error('Unknown experiment');
  const config = systemDefaults(course, id);
  for (const c of topic.controls) {
    const v = input[c.key];
    if (c.type === 'number' && Number.isFinite(Number(v)))
      config[c.key] = clamp(Number(v), c.min, c.max);
    else if (c.type === 'check' && typeof v === 'boolean') config[c.key] = v;
    else if (c.type === 'select' && c.options.some((o) => o[0] === v)) config[c.key] = v;
  }
  return config;
}
function cameraToBody(point, camera) {
  const a = rad(camera.cameraAngle);
  return {
    x: camera.cameraX + point.x * Math.cos(a) - point.z * Math.sin(a),
    z: camera.cameraZ + point.x * Math.sin(a) + point.z * Math.cos(a),
  };
}
function bodyToCamera(point, camera = { cameraX: 40, cameraZ: 30, cameraAngle: 10 }) {
  const a = rad(camera.cameraAngle),
    x = point.x - camera.cameraX,
    z = point.z - camera.cameraZ;
  return { x: x * Math.cos(a) + z * Math.sin(a), z: -x * Math.sin(a) + z * Math.cos(a) };
}
function calibrationPairs() {
  return [
    { x: 140, z: 80 },
    { x: 210, z: 130 },
    { x: 130, z: 180 },
  ].map((body) => ({ body, camera: bodyToCamera(body) }));
}
function fitCameraTransform(pairs) {
  if (
    pairs.length < 2 ||
    pairs.some(
      (p) => !['x', 'z'].every((k) => Number.isFinite(p.camera[k]) && Number.isFinite(p.body[k])),
    )
  )
    throw new Error('離れた2点以上の対応が必要です。');
  const p = { x: mean(pairs.map((v) => v.camera.x)), z: mean(pairs.map((v) => v.camera.z)) },
    q = { x: mean(pairs.map((v) => v.body.x)), z: mean(pairs.map((v) => v.body.z)) };
  let dot = 0,
    cross = 0,
    spread = 0;
  for (const v of pairs) {
    const x = v.camera.x - p.x,
      z = v.camera.z - p.z,
      X = v.body.x - q.x,
      Z = v.body.z - q.z;
    dot += x * X + z * Z;
    cross += x * Z - z * X;
    spread += x * x + z * z;
  }
  if (spread < 1e-9 || Math.hypot(dot, cross) < 1e-9)
    throw new Error('目印を離して測ってください。');
  const a = Math.atan2(cross, dot),
    fit = {
      cameraX: q.x - p.x * Math.cos(a) + p.z * Math.sin(a),
      cameraZ: q.z - p.x * Math.sin(a) - p.z * Math.cos(a),
      cameraAngle: (a * 180) / Math.PI,
    };
  fit.error = Math.sqrt(
    mean(
      pairs.map((v) => {
        const e = cameraToBody(v.camera, fit);
        return (e.x - v.body.x) ** 2 + (e.z - v.body.z) ** 2;
      }),
    ),
  );
  return fit;
}
function mechanics(id, c) {
  const samples = [],
    events = [];
  let x = 0.3,
    v = id === 'braking' ? c.initialSpeed : 0,
    odom = x,
    brakeStart = null;
  for (let i = 0; i <= 160; i++) {
    const t = i * dt;
    let force = 0,
      accel = 0,
      wheelSpeed = v,
      braking = false;
    const motorPower = id === 'braking' ? null : t < 3 ? c.power : 0;
    if (id === 'braking') {
      if (brakeStart === null && 3 - x <= c.brakeAt) {
        brakeStart = x;
        events.push({ t, x, kind: 'brake', label: 'ブレーキ開始', text: 'ブレーキを開始' });
      }
      braking = brakeStart !== null;
      force = braking && v > 0 ? -Math.min(7, c.grip * c.mass * 9.81) : 0;
      accel = force / c.mass;
    } else {
      const requested = Math.max(0, (16 * motorPower) / 100 - 3 * v),
        cap = (c.grip ?? 0.7) * c.mass * 9.81,
        drive = Math.min(requested, cap);
      force = drive - (v > 0 ? 0.6 : 0);
      accel = force / c.mass;
      wheelSpeed = v + Math.max(0, requested - cap) / 7;
      if (i === 60)
        events.push({
          t,
          x,
          kind: 'power-off',
          label: '出力0 %',
          text: 'モーターへの出力を' + c.power + ' %から0 %に変更（ブレーキなし）',
        });
    }
    samples.push({
      t,
      x,
      v,
      wheelSpeed,
      odom,
      force,
      accel,
      motorPower,
      braking,
      status: braking
        ? 'ブレーキで減速'
        : motorPower === 0
          ? v > 0
            ? '出力0・惰性で移動'
            : '停止'
          : '走行中',
    });
    const nextV = Math.max(0, v + accel * dt);
    x += (v + nextV) * 0.5 * dt;
    odom += (v + nextV) * 0.5 * dt + Math.max(0, wheelSpeed - v) * dt;
    v = nextV;
    if (id === 'braking' && brakeStart !== null && v === 0) {
      samples.push({
        ...samples.at(-1),
        t: t + dt,
        x,
        v: 0,
        wheelSpeed: 0,
        force: 0,
        accel: 0,
        status: '停止',
      });
      break;
    }
  }
  const end = samples.at(-1),
    success =
      id === 'braking'
        ? 3 - end.x >= -1e-6 && 3 - end.x <= 0.2
        : !samples.some((s) => s.wheelSpeed - s.v > 0.15);
  return {
    samples,
    events,
    success,
    metrics:
      id === 'braking'
        ? [
            metric('線までの残り（負なら通過）', 3 - end.x, 'm'),
            metric('ブレーキ後の移動', end.x - (brakeStart ?? end.x), 'm'),
            metric('停止まで', end.t, '秒'),
          ]
        : [
            metric('3秒時点の速さ', samples[60].v, 'm/秒'),
            metric('車輪から求めた移動距離の誤差', end.odom - end.x, 'm'),
            metric('動き始めの加速度', samples[0].accel, 'm/秒²'),
          ],
    outcome:
      id === 'braking'
        ? success
          ? '線の手前20 cm以内に停止しました。'
          : '停止位置を確認し、ブレーキを始める距離を調整しましょう。'
        : id === 'force'
          ? '質量か出力のどちらか一つを変え、前回の線と比べましょう。'
          : '質量・出力・床のうち一つを変え、前回の線と比べましょう。',
  };
}
function behavior(id, c) {
  const samples = [],
    events = [],
    route = [],
    box = { x: 2.45, y: 1.4, w: 0.4, h: 1.2 };
  let x = 0.5,
    y = 2,
    theta = 0,
    v = 0,
    state = '荷物へ進む',
    hasParcel = false,
    waitStart = null,
    waitTotal = 0,
    target = { x: 1.3, y: 2 },
    waypoints = [],
    done = false,
    detoured = false;
  const change = (t, text, why) => {
    if (state !== text) {
      state = text;
      events.push({ t, text: text + '：' + why });
    }
  };
  for (let i = 0; i <= 320; i++) {
    const t = i * dt,
      blocked = c.obstacle && c.obstacle !== 'none' && (c.obstacle !== 'temporary' || t < 9);
    let w = 0;
    if (!done && Math.hypot(target.x - x, target.y - y) < 0.09) {
      if (state === '荷物へ進む' && id === 'missing' && c.searchRule !== 'search') {
        change(t, '届け先へ進む', '荷物はないが、そのまま進むルール');
        target = { x: 4.3, y: 2 };
      } else if (state === '荷物へ進む' && id === 'missing') {
        change(t, '別の場所を探す', '最初の場所に荷物がない');
        target = { x: 1.3, y: 0.7 };
      } else if (state === '荷物へ進む' || state === '別の場所を探す') {
        hasParcel = true;
        change(t, '届け先へ進む', '荷物を受け取った');
        target = { x: 4.3, y: 2 };
      } else if (waypoints.length) {
        target = waypoints.shift();
      } else {
        done = true;
        change(
          t,
          hasParcel ? '配達完了' : '空のまま到着',
          hasParcel ? '荷物を渡した' : '受け取りを確かめていなかった',
        );
      }
    }
    const danger = blocked && !detoured && x > 1.65 && x < 2.5 && y > 1.2;
    if (danger && !done) {
      if (waitStart === null) {
        waitStart = t;
        change(t, '通路が空くまで待つ', '前の障害物を検知');
      }
      waitTotal += dt;
      if (id === 'blocked' && c.blockedRule === 'detour' && t - waitStart >= c.timeout) {
        detoured = true;
        waypoints = [
          { x: 3.3, y: 0.85 },
          { x: 4.3, y: 2 },
        ];
        target = { x: 1.65, y: 0.85 };
        change(t, '別の道へ進む', '設定した待ち時間を越えた');
      }
    } else if (waitStart !== null && state === '通路が空くまで待つ') {
      change(t, '届け先へ進む', '通路が空いた');
      waitStart = null;
    }
    if (!done && (!danger || detoured)) {
      const angle = Math.atan2(target.y - y, target.x - x),
        err = Math.atan2(Math.sin(angle - theta), Math.cos(angle - theta));
      w = clamp(err * 3, -2.3, 2.3);
      v = 0.65 * Math.max(0, Math.cos(err));
    } else v = 0;
    // Screen y points down; positive theta is clockwise.
    const left = ((v + w * 0.16) / (0.065 * 2 * Math.PI)) * 60,
      right = ((v - w * 0.16) / (0.065 * 2 * Math.PI)) * 60;
    samples.push({
      t,
      x,
      y,
      theta,
      v,
      w,
      left,
      right,
      status: state,
      hasParcel,
      blocked,
      box,
      waitTotal,
      target: { ...target },
    });
    route.push({ x, y });
    if (done) break;
    theta += w * dt;
    x += v * Math.cos(theta) * dt;
    y += v * Math.sin(theta) * dt;
  }
  const end = samples.at(-1),
    success = end.status === '配達完了';
  return {
    samples,
    events,
    success,
    metrics: [
      metric('経過時間', end.t, '秒'),
      metric('待った時間', waitTotal, '秒'),
      metric('荷物を届けた', success ? 'はい' : 'いいえ'),
    ],
    outcome: success
      ? '荷物を受け取り、届け先へ渡せました。別の通路条件でも同じルールを確かめましょう。'
      : end.status === '空のまま到着'
        ? '移動は終わりましたが、荷物は届けられていません。受け取りの結果を確認する条件が必要です。'
        : '制限時間内に配達できませんでした。止まっている状態と、次へ移る条件を見直しましょう。',
  };
}
const cartAt = (t, motion) => ({
  x: 2.65,
  y: motion === 'turn' && t >= 4 ? 1.55 + 0.4 * (t - 4) : 3.15 - 0.4 * t,
});
function tracking(id, c) {
  const samples = [],
    events = [],
    noise = seedNoise(),
    predictions = [],
    errors = [];
  let obs = null,
    previous = null,
    velocity = 0,
    hasVelocity = false,
    lastMeasure = -Infinity,
    lastError = null,
    evaluation = null,
    x = 0.4,
    v = 0,
    minDistance = Infinity,
    contact = false;
  const interval = c.interval ?? 0.2,
    horizon = c.horizon ?? 1,
    smoothing = c.smoothing ?? 1;
  for (let i = 0; i <= (id === 'crossing' ? 220 : 140); i++) {
    const t = i * dt,
      cart = cartAt(t, c.motion),
      y = 1.6;
    if (t - lastMeasure >= interval - 1e-8) {
      previous = obs;
      obs = { x: cart.x, y: cart.y + noise() * (c.noise ?? 0), t };
      if (previous) {
        const measured = (obs.y - previous.y) / (t - previous.t);
        velocity = hasVelocity ? velocity * (1 - smoothing) + measured * smoothing : measured;
        hasVelocity = true;
      }
      lastMeasure = t;
      if (hasVelocity && id === 'prediction')
        predictions.push({ madeAt: t, t: t + horizon, y: obs.y + velocity * horizon });
    }
    for (const p of predictions) {
      if (!p.checked && t + 1e-8 >= p.t) {
        p.checked = true;
        const actualY = cartAt(p.t, c.motion).y;
        lastError = Math.abs(p.y - actualY);
        evaluation = {
          madeAt: p.madeAt,
          targetTime: p.t,
          predictedY: p.y,
          actualY,
          error: lastError,
        };
        errors.push(lastError);
      }
    }
    if (c.motion === 'turn' && i === 80)
      events.push({
        t,
        kind: 'turn',
        label: '相手が方向転換',
        text: '相手のロボットが進む向きを反対に変えた。新しく測る位置から速度と予測を更新する。',
      });
    const predicted =
        hasVelocity && id !== 'velocity'
          ? { x: obs.x, y: obs.y + velocity * horizon, targetTime: obs.t + horizon }
          : null,
      rx = obs.x - x,
      ry = obs.y + velocity * (t - obs.t) - y;
    let stop = false;
    if (id === 'crossing') {
      if (c.rule === 'predict') {
        const relVx = -0.6,
          relVy = velocity,
          tNear = clamp(
            -(rx * relVx + ry * relVy) / (relVx * relVx + relVy * relVy || 1),
            0,
            horizon,
          );
        stop = Math.hypot(rx + relVx * tNear, ry + relVy * tNear) < 0.7;
      } else stop = Math.hypot(rx, obs.y - y) < 0.47;
      const distance = Math.hypot(cart.x - x, cart.y - y) - 0.36;
      minDistance = Math.min(minDistance, distance);
      if (distance <= 0) {
        contact = true;
        stop = true;
      }
      if (x >= 4.4) stop = true;
      const nextV = clamp(v + (stop ? -1.2 : 1.2) * dt, 0, 0.6);
      x += ((v + nextV) * dt) / 2;
      v = contact ? 0 : nextV;
    }
    const status = contact
      ? '接触して終了'
      : id === 'crossing'
        ? x >= 4.4
          ? '到着'
          : stop
            ? '相手を待つ'
            : '進む'
        : hasVelocity
          ? '停止して観察中'
          : '次の測定を待つ';
    if (samples.at(-1)?.status !== status) events.push({ t, text: status });
    samples.push({
      t,
      x,
      y,
      theta: 0,
      v,
      cart,
      obs: { ...obs },
      previousObs: previous ? { ...previous } : null,
      velocity: hasVelocity ? velocity : null,
      actualPosition: cart.y,
      observedPosition: obs.y,
      actualVelocity: c.motion === 'turn' && t >= 4 ? 0.4 : -0.4,
      predicted,
      evaluation: evaluation ? { ...evaluation } : null,
      predictionError: lastError,
      separation: Math.max(0, Math.hypot(cart.x - x, cart.y - y) - 0.36),
      status,
    });
    if (contact || (id === 'crossing' && x >= 4.4 && v === 0)) break;
  }
  const end = samples.at(-1),
    success = id === 'crossing' ? !contact && end.x >= 4.4 : true;
  const metrics =
    id === 'crossing'
      ? [
          metric('最も近づいた間隔', Math.max(0, minDistance), 'm'),
          metric('経過時間', end.t, '秒'),
          metric('接触', contact ? 'あり' : 'なし'),
        ]
      : id === 'velocity'
        ? [
            metric(
              '測定位置の平均のずれ',
              mean(
                samples
                  .filter((s) => s.t === s.obs.t)
                  .map((s) => Math.abs(s.observedPosition - s.actualPosition)),
              ),
              'm',
            ),
            metric(
              '求めた速度の平均のずれ',
              mean(
                samples
                  .filter((s) => s.velocity !== null)
                  .map((s) => Math.abs(s.velocity - s.actualVelocity)),
              ),
              'm/秒',
            ),
          ]
        : [
            metric('予測と実際の平均のずれ', mean(errors), 'm'),
            metric('予測と実際の最大のずれ', Math.max(0, ...errors), 'm'),
          ];
  const outcome =
    id === 'crossing'
      ? success
        ? '接触せずにゴールへ到着しました。今の距離だけで判断した走行と、待ち始めた位置・最も近づいた間隔を比べてください。'
        : contact
          ? '相手のロボットに接触しました。近づいたことに気づいても、減速する間に進みます。この先どこまで近づくかを予測した場合と比べてください。'
          : '接触はしませんでしたが、時間内に到着しませんでした。待ち続けている場面と、進む条件を確かめてください。'
      : id === 'velocity'
        ? c.noise > 0
          ? '相手のロボット自体は一定速度でも、測定位置のずれが、計算した速度の変動になりました。測定のずれを0にした記録と比べてください。'
          : '2回の位置の差を時間で割ると、相手のロボットの速度を求められました。次は測定位置だけにずれを加え、実際の速度が同じでも計算値が変わるか調べましょう。'
        : c.motion === 'turn'
          ? '方向転換の前に立てた予測は、その後も同じ向きに進む想定なので外れます。答え合わせの時刻と4秒の方向転換を照らし合わせ、短い時間先の予測とも比べてください。'
          : '同じ向き・速さで進み続ける場面で予測しました。次は4秒で向きを変え、同じ予測方法がどこで外れるか確かめてください。';
  return { samples, events, success, metrics, outcome };
}
function coordination(id, c) {
  const samples = [],
    events = [];
  let q = [100, -100],
    estimate = null,
    lastLook = -Infinity;
  for (let i = 0; i <= 120; i++) {
    const t = i * dt,
      target = id === 'feedback' && t >= 2 ? { x: 220, z: 105 } : { x: 185, z: 145 },
      reading = bodyToCamera(target);
    if (
      !estimate ||
      (id === 'feedback' && c.lookAgain === 'repeat' && t - lastLook >= c.interval - 1e-8)
    ) {
      estimate =
        id === 'frames' && !c.transform
          ? { ...reading }
          : cameraToBody(
              reading,
              id === 'feedback' ? { cameraX: 40, cameraZ: 30, cameraAngle: 10 } : c,
            );
      lastLook = t;
      events.push({ t, text: 'カメラから行き先を更新' });
    }
    const solutions = armIK(estimate, true)
      .solutions.filter((s) => s.allowed)
      .sort(
        (a, b) =>
          a.q.reduce((s, v, j) => s + (v - q[j]) ** 2, 0) -
          b.q.reduce((s, v, j) => s + (v - q[j]) ** 2, 0),
      );
    if (solutions.length) q = q.map((v, j) => v + clamp(solutions[0].q[j] - v, -45 * dt, 45 * dt));
    const fk = armFK(q),
      error = Math.hypot(fk.tip.x - target.x, fk.tip.z - target.z);
    samples.push({
      t,
      q: [...q],
      ...fk,
      target,
      estimate: { ...estimate },
      reading,
      error,
      lastLook,
      status: solutions.length ? '手先を目標へ近づける' : 'この行き先には届かない',
    });
  }
  const end = samples.at(-1);
  return {
    samples,
    events,
    success: end.error < 8,
    metrics: [
      metric('最後の手先と目標の距離', end.error, 'mm', 1),
      metric(
        '計算した行き先のずれ',
        Math.hypot(end.estimate.x - end.target.x, end.estimate.z - end.target.z),
        'mm',
        1,
      ),
    ],
    outcome:
      end.error < 8
        ? '手先が目標から8 mm以内に入りました。同じ設定を別の観測条件でも使えるか考えましょう。'
        : '青い行き先と黄色い目標を比べ、座標の変換や観測の更新を見直しましょう。',
  };
}
function timing(id, c) {
  const samples = [],
    events = [],
    transit = [],
    queue = [];
  let x = 0.35,
    v = 0,
    last = null,
    nextProcess = 0,
    stop = false,
    contact = false;
  const wall = 4,
    latency = c.latency ?? 0,
    processing = c.processing ?? 20;
  for (let i = 0; i <= 220; i++) {
    const t = i * dt;
    // Advance from the previous decision to this timestamp before measuring.
    // This keeps the measured position, range and displayed clock on the same instant.
    if (i > 0) {
      const nextV = clamp(v + (stop || !last ? -3.2 : 1.2) * dt, 0, 0.8),
        nextX = x + ((v + nextV) * dt) / 2;
      if (nextX >= wall - 0.18) {
        contact = true;
        stop = true;
        x = wall - 0.18;
        v = 0;
        events.push({ t, kind: 'contact', text: '停止が間に合わず、機体が壁に接触した。' });
      } else {
        x = nextX;
        v = nextV;
      }
    }
    transit.push({ stamp: t, receive: t + latency, x, range: wall - x });
    while (transit.length && transit[0].receive <= t + 1e-8) queue.push(transit.shift());
    if (t >= nextProcess - 1e-8) {
      if (queue.length) {
        last = id === 'queue' && c.queue === 'latest' ? queue.at(-1) : queue[0];
        if (id === 'queue' && c.queue === 'latest') queue.length = 0;
        else queue.shift();
      }
      nextProcess += 1 / processing;
    }
    const usedRange = last
        ? last.range - (c.compensate || id === 'alignment' ? x - last.x : 0)
        : null,
      mapBaseX = last ? (id === 'alignment' && c.align === 'stamp' ? last.x : x) : null,
      wallEstimate = last ? mapBaseX + last.range : null;
    if (last && usedRange <= 0.6 && !stop) {
      stop = true;
      events.push({
        t,
        kind: 'stop-command',
        label: '停止指示',
        text: '判断に使った距離が0.6 m以下になったので、停止を指示。ここから減速する。',
      });
    }
    samples.push({
      t,
      x,
      v,
      range: wall - x,
      usedRange,
      rawRange: last?.range ?? null,
      measuredX: last?.x ?? null,
      mapBaseX,
      wallEstimate,
      wallError: wallEstimate === null ? null : wallEstimate - wall,
      age: last ? t - last.stamp : 0,
      stamp: last?.stamp ?? null,
      receive: last?.receive ?? null,
      queue: queue.length,
      stop,
      contact,
      status: contact
        ? '接触して終了'
        : stop
          ? v
            ? '減速中'
            : '停止'
          : last
            ? '走行中'
            : '最初のデータを待つ',
    });
    if (contact || (stop && v === 0 && t > 1)) break;
  }
  const end = samples.at(-1),
    maxWallError = Math.max(...samples.map((s) => Math.abs(s.wallError ?? 0))),
    metrics = [
      metric('中心から壁までの距離', end.range, 'm'),
      metric('使った情報の最大の古さ', Math.max(...samples.map((s) => s.age)), '秒'),
      id === 'alignment'
        ? metric('地図の壁の最大のずれ', maxWallError, 'm')
        : id === 'queue'
          ? metric('処理待ちの最大件数', Math.max(...samples.map((s) => s.queue)), '件', 0)
          : metric('壁の0.5 m手前からのずれ', Math.abs(end.range - 0.5), 'm'),
    ];
  const outcome =
    id === 'alignment'
      ? maxWallError < 1e-8
        ? '距離と機体位置を同じ時刻で組み合わせると、地図の壁が実際の4 mの位置に重なりました。遅れて届いても、測ったときの位置に戻って計算できます。'
        : '古い距離に現在の機体位置を足したため、実際より奥へ壁を描いてしまいました。走行ではなく、地図へ置く位置の誤りです。測った時刻の位置を使って比べましょう。'
      : contact
        ? id === 'queue'
          ? c.queue === 'latest'
            ? '最新の1件を選んでいても、次に処理するまでの間に機体が進み、停止が間に合いませんでした。処理回数を増やした場合と比べましょう。'
            : 'データはすぐ届いていましたが、順番待ちで古い距離を使い続け、壁に接触しました。最新の1件を使う方法や、処理回数を増やす方法と比べましょう。'
          : '届いた距離はまだ大きくても、実際の機体は壁に近づいていて、停止が間に合わず接触しました。届く遅れを0秒にするか、測定後の移動量を使って補正して比べます。'
        : id === 'queue'
          ? '壁に接触する前に止まりました。処理待ちの件数と情報の古さを、前の設定と比べてください。今の判断に使うデータを選ぶことと、記録として全件を残すことは別に考えます。'
          : c.compensate
            ? '遅れ自体は残っていますが、測定後に進んだ距離を引いて停止を判断できました。この実験では車輪からの移動量に誤差がないとしています。'
            : '接触前に停止しました。壁の0.5 m手前という目標からどれくらいずれたかを、遅れのある場合と比べてください。';
  return {
    samples,
    events,
    success:
      id === 'alignment' ? maxWallError < 0.05 : !contact && Math.abs(end.range - 0.5) < 0.16,
    metrics,
    outcome,
  };
}
function canRestart(latched, causeCleared, operatorRequest) {
  return Boolean(latched && causeCleared && operatorRequest);
}
function diagnostics(id, c) {
  const samples = [],
    events = [];
  let x = 0.4,
    v = 0,
    lastRange = 2.8,
    lastStamp = 0,
    latched = false,
    reason = '',
    contact = false;
  const obstacle = id === 'impact' ? 8 : 3.2;
  for (let i = 0; i <= 200; i++) {
    const t = i * dt,
      lidar = (id === 'distance' ? 4 : obstacle) - x,
      depth = obstacle - x;
    if (id === 'missing' && i === 30)
      events.push({
        t,
        kind: 'data-loss',
        label: '距離の更新が途切れる',
        text: '新しい距離が届かなくなった。最後の測定値は残っている。',
      });
    if (id === 'impact' && i === 40)
      events.push({
        t,
        x,
        kind: 'shock',
        label: c.eventType === 'bump' ? '小さな段差' : '強い衝撃',
        text:
          (c.eventType === 'bump' ? '小さな段差' : '強い衝撃') + 'を表す加速度の模擬データを入力。',
      });
    if (id !== 'missing' || t < 1.5) {
      lastRange = lidar;
      lastStamp = t;
    }
    const pulse = id === 'impact' && t >= 2 && t < 2.15 ? (c.eventType === 'impact' ? 16 : 5.2) : 0,
      accel = pulse || (v < 0.6 && !latched ? 1.2 : latched && v > 0 ? -1.2 : 0),
      age = t - lastStamp;
    if (!latched) {
      if (
        id === 'distance' &&
        Math.min(lidar, c.sensorRule === 'both' ? depth : Infinity) <= c.stopDistance
      )
        reason = '障害物までの距離が設定値以下';
      if (id === 'missing' && c.watchdog && age > c.staleLimit)
        reason = '距離データの更新が途切れた';
      if (id === 'missing' && lastRange <= 0.6) reason = '記録された距離が0.6 m以下';
      if (id === 'impact' && Math.abs(accel) >= c.impactLimit) reason = 'IMUでしきい値以上の加速度';
      if (reason) {
        latched = true;
        events.push({ t, text: '停止を保持：' + reason });
      }
    }
    const nextV = clamp(v + (latched ? -1.2 : 1.2) * dt, 0, 0.6);
    x += ((v + nextV) * dt) / 2;
    v = nextV;
    if (x + 0.18 >= obstacle) {
      contact = true;
      x = obstacle - 0.18;
      v = 0;
      events.push({ t, kind: 'contact', text: '機体が障害物に接触したため、実験を終了。' });
    }
    samples.push({
      t,
      x,
      v,
      lidar,
      depth,
      range: lastRange,
      age,
      accel,
      latched,
      reason,
      contact,
      status: contact
        ? '接触して終了'
        : latched
          ? v
            ? '停止指示・減速中'
            : '停止を保持'
          : '走行中',
    });
    if (contact || (id !== 'impact' && latched && v === 0) || (id === 'impact' && t >= 4)) break;
  }
  const end = samples.at(-1),
    success =
      id === 'impact' ? (c.eventType === 'impact' ? latched : !latched) : latched && !contact;
  const metrics =
    id === 'impact'
      ? [
          metric('想定した出来事', c.eventType === 'bump' ? '小さな段差' : '強い衝撃'),
          metric('停止判定', latched ? 'あり' : 'なし'),
          metric(
            '加速度の最大の大きさ',
            Math.max(...samples.map((s) => Math.abs(s.accel))),
            'm/秒²',
          ),
        ]
      : [
          metric('停止判定', latched ? 'あり' : 'なし'),
          metric('接触', contact ? 'あり' : 'なし'),
          id === 'distance'
            ? metric('停止指示を出した時刻', samples.find((s) => s.latched)?.t ?? '指示なし', '秒')
            : metric('最後のデータの古さ', end.age, '秒'),
        ];
  const outcome =
    id === 'impact'
      ? c.eventType === 'bump'
        ? latched
          ? '通過してよい段差の模擬データでも停止しました。同じしきい値で強い衝撃も試してから、境目の値を見直しましょう。'
          : 'この段差の模擬データでは走行を続けました。同じしきい値で、強い衝撃を見逃さず止められるかも確認しましょう。'
        : latched
          ? '強い衝撃を検知して停止を保持しました。衝撃が起きた後の判断で、接触を防いだという意味ではありません。'
          : '強い衝撃の模擬データでも停止しませんでした。加速度の波形と停止の境目を比べ、値を見直してください。'
      : contact
        ? id === 'missing'
          ? '距離データが途切れた後も、最後の値を使って走り続け、接触しました。新しい値が来ないことも停止条件にできるか確かめましょう。'
          : c.sensorRule === 'lidar'
            ? latched
              ? 'LiDARは奥の壁までの距離で停止を指示しましたが、手前の棚に接触しました。棚を測るカメラの距離も使って比べましょう。'
              : 'LiDARは棚の下を通して奥の壁を測っていたため、棚に接触するまで停止条件に達しませんでした。棚を測るカメラの距離も使って比べましょう。'
            : '棚までの距離も使いましたが、停止を指示する距離が短すぎて接触しました。減速して止まるまでの距離も必要です。'
        : id === 'missing'
          ? '距離が短くなるのを待たず、データが更新されない時間を使って停止できました。前回の動きと、停止指示を出した時刻を比べてください。'
          : 'カメラが測った棚までの距離で停止を判断し、接触する前に止まりました。壁までの距離だけで走った結果と比べてください。';
  return { samples, events, success, metrics, outcome };
}
function simulateSystem(course, topic, input = {}) {
  const config = validateSystemConfig(course, topic, input),
    run = { mechanics, behavior, tracking, coordination, timing, diagnostics }[course](
      topic,
      config,
    );
  return { course, topic, config, ...run, duration: run.samples.at(-1).t };
}
function systemCSV(run) {
  const flatten = (value, prefix = '', out = {}) => {
    for (const [key, v] of Object.entries(value)) {
      const name = prefix ? prefix + '.' + key : key;
      if (v !== null && typeof v === 'object') flatten(v, name, out);
      else out[name] = v;
    }
    return out;
  };
  const rows = run.samples.map((s) => flatten(s)),
    keys = [...new Set(rows.flatMap((s) => Object.keys(s)))];
  return [
    '# QUESTiX LAB simulation ' + run.course + '/' + run.topic,
    '# config ' + JSON.stringify(run.config),
    '# units: time=s; position=' +
      (run.course === 'coordination' ? 'mm' : 'm') +
      '; velocity=m/s; wheel_rate=rpm; force=N; acceleration=m/s^2; arm_angles=deg; heading=rad',
    keys.join(','),
    ...rows.map((s) =>
      keys
        .map((k) =>
          typeof s[k] === 'string' ? '"' + s[k].replaceAll('"', '""') + '"' : (s[k] ?? ''),
        )
        .join(','),
    ),
  ].join('\n');
}

export {
  validateSystemConfig,
  cameraToBody,
  bodyToCamera,
  calibrationPairs,
  fitCameraTransform,
  canRestart,
  simulateSystem,
  systemCSV,
};
