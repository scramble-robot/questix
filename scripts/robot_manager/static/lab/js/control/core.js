// Educational, deterministic one-dimensional model. This is not a hardware controller.
const CONTROL_GROUPS = [
  '指示の決め方を知る',
  'ずれの直し方を調べる',
  '実際の制約に備える',
  '条件を変えて確かめる',
];
const CONTROL_TOPICS = [
  {
    id: 'output',
    group: 0,
    name: '出力と回転数',
    title: '出力を変えると、車輪の速さはどう変わる？',
    scene:
      '機体を台で支えて車輪を床から浮かせ、モーターへの出力を変えます。回転数センサーで、車輪がどれくらいの速さで回るかを測ります。',
    purpose:
      '狙った速さで回すために、出力と回転数の関係を調べます。出力を変えたときの速さと、その速さに落ち着くまでの動きを比べます。機械の動きを目的に合わせて調整することを、制御といいます。',
    first:
      '目標は60 rpm、1秒に1回転する速さです。まず出力30%で実験し、緑の回転数の線がどこで落ち着くか見ます。次に出力だけを60%に変え、黄色の目標線へ近づくか比べてください。',
    question:
      '出力を2倍にしたとき、回転数はどう変わりましたか。指示を出した直後から、その速さになっていますか。',
    sensor: '車輪の回転数センサー',
    mode: 'speed',
    defaults: { power: 30, loadCase: 'nominal' },
  },
  {
    id: 'feedforward',
    group: 0,
    name: '見積もって指示する',
    title: '狙った速さに必要な出力を、事前の測定から決める',
    scene:
      '車輪を浮かせ、事前に測った「出力と回転数の関係」から必要な出力を見積もります。この見積もりによる指示をフィードフォワード（FF）といいます。',
    purpose:
      '見積もった出力で、目標の速さに合うかを確かめます。まず目標の速さを変え、次に回転を妨げる条件（負荷）を加えて比べます。負荷が変わると、事前の測定と同じ関係になるとは限りません。',
    first:
      '表で60 rpmに対応する出力を見て、そのまま実験します。次に目標だけを40 rpmに変え、計算された出力と緑の測定線を確認してください。その後「5秒後に負荷が増える」に変え、5秒より後で出力の線と回転数の線のどちらが変わるか比べます。',
    question:
      '目標から計算した出力が同じでも、実際の速さが変わったのはなぜでしょう。見積もりだけで気づけるでしょうか。',
    sensor: '車輪の回転数センサー',
    mode: 'speed',
    defaults: { loadCase: 'nominal' },
  },
  {
    id: 'feedback',
    group: 0,
    name: '測って速さを戻す',
    title: '車輪が回りにくくなっても、同じ速さを保ちたい',
    scene:
      '車輪を60 rpm（1秒に1回転）で回し続けたいのに、摩擦などで回転を妨げる力が増えると、同じ出力では遅くなります。このような回転を妨げる条件を負荷と呼びます。',
    purpose:
      '出力を一定にする場合と、速さを測って出力を調整する場合を比べます。動いた結果を次の指示に反映する方法がフィードバック（FB）制御です。',
    first:
      'まず「出力を一定にする」で実験してください。5秒後に負荷が増えたとき、車輪の速さがどう変わるか見ます。次に「測って調整する」に切り替え、もう一度試します。',
    question: '負荷が増えた後、モーターへの出力を変える必要があるのはなぜでしょう。',
    sensor: '車輪の回転数センサー',
    mode: 'speed',
    defaults: { feedback: false, kp: 1.2, ki: 3, kd: 0, power: 60 },
  },
  {
    id: 'combined',
    group: 0,
    name: '二つを組み合わせる',
    title: '狙った速さへ早く近づき、途中のずれにも対応する',
    scene: '車輪を目標の速さへ早く近づけ、途中で回りにくくなっても速さを保ちたい場面です。',
    purpose:
      '事前の測定から必要な出力を見積もり、動かしてみて遅ければ修正を足します。事前の見積もりがフィードフォワード（FF）、測ったずれによる修正がフィードバック（FB）です。同じ機体・目標・負荷で、見積もりだけ、修正だけ、両方の3方式を比べます。',
    first:
      'まず「見積もりだけ」で試します。次に「ずれの修正だけ」、最後に「見積もり＋ずれの修正」を試してください。目標へ近づく速さ、負荷が増えた後のずれ、出力の内訳を見比べます。',
    question:
      '組み合わせると、最初から必要な出力を用意できましたか。修正を加え過ぎたときの行き過ぎにも注目しましょう。',
    sensor: '車輪の回転数センサー',
    mode: 'speed',
    defaults: { strategy: 'feedforward', kp: 1.2, ki: 1.2 },
  },
  {
    id: 'p',
    group: 1,
    name: 'P：ずれに応じて動かす',
    title: '速さのずれに応じて、出力を決める',
    scene: '車輪を60 rpm（1秒に1回転）で回すため、測った速さに応じて出力を自動で決めます。',
    purpose:
      '目標が60 rpmで測定が50 rpmなら、ずれは60−50＝+10 rpm。この差に一定の倍率を掛けて出力を決める方法をP制御といいます。倍率を上げれば目標へ近づきやすくなる一方、速くなりすぎることもあります。Pの倍率だけを変え、残るずれと回り過ぎを比べます。',
    first:
      'まずPを1.2のまま実験し、緑の測定線と黄色の60 rpmの線の間にずれが残るか見ます。次にPだけを3に上げて再実験してください。最後のずれが減ったかに加え、緑の線が目標を越えたり上下したりしていないか比べます。',
    question:
      'ずれが小さくなるとPの出力も小さくなります。負荷に負けずに回し続ける出力は足りていますか。',
    sensor: '車輪の回転数センサー',
    mode: 'speed',
    defaults: { kp: 1.2, ki: 0, kd: 0 },
  },
  {
    id: 'i',
    group: 1,
    name: 'I：残るずれを補う',
    title: '目標より少し遅いままの車輪を、狙った速さへ戻す',
    scene:
      '車輪を60 rpmで回し続けたいのに、今のずれに応じて出力を決めるPだけでは、少し遅い状態で落ち着くことがあります。',
    purpose:
      'そこで「ずれ×続いた時間」を足し、遅い状態が続くほど出力を追加するIの働きを使います。目標に届いても追加した分は残り、回転を支えます。Iだけを変え、残るずれを減らせるか、追加しすぎて回り過ぎないか比べます。',
    first:
      '最初はIが0のまま実験します。次にIだけを1にして再実験し、必要なら2、3と一つずつ試してください。5秒後に負荷が増えた後、緑の線が60 rpmへ戻るか、戻る途中で目標を越えるかを前回の線と比べます。',
    question: 'Iを加えてずれは減りましたか。その代わりに、目標を越える動きは増えませんでしたか。',
    sensor: '車輪の回転数センサー',
    mode: 'speed',
    defaults: { kp: 1.2, ki: 0, kd: 0 },
  },
  {
    id: 'd',
    group: 1,
    name: 'D：行き過ぎを抑える',
    title: '目標に近づく勢いを見て、行き過ぎを抑える',
    scene:
      'ここからは機体を走らせ、光で距離を測るLiDAR（ライダー）で壁の50 cm手前に止めます。Pだけでは、目標に近づいて指示を弱めても機体がすぐには止まらず、行き過ぎる場合があります。',
    purpose:
      'Dは測定した距離が減る速さから、前進の指示を弱める補正を作ります。目標までの距離に加えて近づく勢いも使うことで、止まり方がどう変わるか比べます。',
    first:
      'まずDを0のまま走らせ、距離グラフの緑の線が0.50 mより下へ行くか見ます。下へ行くほど、停止位置より壁に近づいたことになります。次にDだけを1にして再実験し、最も下がった位置と、0.50 m付近で落ち着くまでの時間を比べてください。',
    question: '行き過ぎを減らせても、止まるまでが遅くなる設定はありますか。',
    sensor: 'LiDAR（壁までの距離）',
    mode: 'distance',
    defaults: { kp: 2.2, ki: 0, kd: 0 },
  },
  {
    id: 'reference',
    group: 2,
    name: '目標の変え方',
    title: '急に速くする指示と、少しずつ速くする指示を比べる',
    scene:
      '荷物を運ぶロボットでは、発進時に車輪の速さが急に変わると荷物がずれる原因になります。ここでは車輪を浮かせ、停止から60 rpmまで穏やかに加速させる指示を調べます。',
    purpose:
      '出力の調整方法を同じにして、最初から60 rpmを目標にする場合と、1秒で20 rpm、2秒で40 rpm、3秒で60 rpmと目標を上げる場合を比べます。速さの変化が穏やかになるか、到達まで長くかかるかを確かめます。',
    first:
      'まず目標を「一度に変える」で試します。次に「3秒かけて変える」に切り替えて再実験してください。黄色の目標の線と車輪の動き、最大の加速の大きさを比べます。',
    question:
      '穏やかに加速する代わりに、何が遅くなりましたか。荷物を運ぶ場面ではどちらの動きが適しているでしょう。',
    sensor: '車輪の回転数センサー',
    mode: 'speed',
    defaults: { profile: 'step', loadCase: 'nominal', kp: 1.2, ki: 1.2 },
  },
  {
    id: 'limits',
    group: 2,
    name: '出力には上限がある',
    title: '動けなくなった後も、回り過ぎずに目標の速さへ戻す',
    scene:
      '一時的に回れなくなった車輪を、妨げがなくなったら60 rpmへ戻したい場面です。3〜7秒は強い負荷で車輪が止まります。',
    purpose:
      '遅い状態が続くほど出力を追加するIの計算は、実際の出力が上限の100%でも増え続けることがあります。追加分が残ると、7秒後に回り過ぎます。Iをため過ぎない機能のオン・オフで、動き始めた後の速さを比べます。',
    first:
      'まず「Iのたまり過ぎを抑える」をオフで実験します。出力グラフの「Iの補正も表示する」にチェックを入れ、3〜7秒に紫の線が増える様子と、7秒後の回転数を見ます。次に抑制をオンにして、同じ二つの線を比べてください。実機の車輪を手で押さえる実験はしません。',
    question: '出力がすでに100%なのに、Iをさらに増やすと、負荷がなくなった後に何が起きますか。',
    sensor: '車輪の回転数センサー',
    mode: 'speed',
    defaults: { kp: 1.2, ki: 3, kd: 0, antiWindup: false },
  },
  {
    id: 'noise',
    group: 2,
    name: '測定値の揺らぎ',
    title: '距離の測定が揺れても、落ち着いて壁の手前で止める',
    scene:
      'ロボットを壁の50 cm手前で止めたいのに、距離の測定値だけが細かく上下する場合を調べます。この測定の揺らぎをノイズと呼びます。',
    purpose:
      '近づく速さから指示を弱めるDは、この揺れにも反応し、前進・後退の指示を細かく変えることがあります。測った変化を前の値と混ぜてなめらかにするフィルターを加え、指示の揺れと停止までの時間を比べます。',
    first:
      'まずフィルターが0秒のまま走らせ、下の出力グラフを見ます。次に0.2秒程度にして再実験してください。指示の揺れと、止まるまでの時間を比べます。',
    question:
      'なめらかにし過ぎると、実際の変化に気づくのが遅れます。揺れを抑えることと、素早く反応することは両立しましたか。',
    sensor: 'LiDAR（揺らぎを含む距離）',
    mode: 'distance',
    defaults: { kp: 2.2, ki: 0, kd: 1, filter: 0 },
  },
  {
    id: 'challenge',
    group: 3,
    name: '停止のチャレンジ',
    title: '荷物の重さが変わっても、指定の位置で止まれるか',
    scene: '配達ロボットを壁の50 cm手前で、行き過ぎを小さく、できるだけ早く止めます。',
    purpose:
      '調整するのは、今のずれに応じるP、残るずれを補うI、近づく勢いを抑えるDです。一つずつ変えて止まり方を比べます。うまくいった設定でも、荷物を積むと動きの反応が遅くなります。同じ設定を「荷物あり」や「測定の揺らぎあり」でも試し、条件が変わっても止まれるか確かめます。',
    first:
      'まず標準で実験し、距離グラフが0.50 mを越えて下がるならDを少し増やす、近づくのが遅ければPを少し増やす、と一つずつ試します。結果の「行き過ぎ」と「停止するまで」を両方確認してください。標準で達成したら設定を保ったまま「荷物あり」「測定の揺らぎあり」を試し、同じ設定で3条件の達成を目指します。',
    question:
      'ある条件で良かった設定が、別の条件でも良いとは限りません。どのデータを見て、次に何を変えますか。',
    sensor: 'LiDAR・車輪の回転数センサー',
    mode: 'distance',
    defaults: { kp: 2.2, ki: 0, kd: 0 },
  },
];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
function controlDefaults(id) {
  const topic = CONTROL_TOPICS.find((t) => t.id === id);
  if (!topic) throw new Error('Unknown control lesson');
  return {
    kp: 1.2,
    ki: 0,
    kd: 0,
    feedback: true,
    power: 60,
    targetRPM: 60,
    ffGain: 1,
    loadCase: 'drag',
    strategy: 'both',
    profile: 'step',
    filter: 0.12,
    antiWindup: true,
    scenario: 'standard',
    ...topic.defaults,
  };
}
function normalizeControlConfig(id, input = {}) {
  const c = { ...controlDefaults(id), ...input };
  for (const [key, min, max] of [
    ['kp', 0, 8],
    ['ki', 0, 6],
    ['kd', 0, 3],
    ['filter', 0, 0.6],
    ['power', 0, 100],
    ['targetRPM', 20, 80],
    ['ffGain', 0, 2],
  ]) {
    c[key] = Number(c[key]);
    if (!Number.isFinite(c[key])) throw new Error('設定値は数値にしてください');
    c[key] = clamp(c[key], min, max);
  }
  c.feedback = !!c.feedback;
  c.antiWindup = !!c.antiWindup;
  if (!['standard', 'heavy', 'noisy'].includes(c.scenario)) throw new Error('Unknown scenario');
  if (
    !['nominal', 'drag', 'mismatch'].includes(c.loadCase) ||
    !['feedforward', 'feedback', 'both'].includes(c.strategy) ||
    !['step', 'ramp'].includes(c.profile)
  )
    throw new Error('Unknown control condition');
  return c;
}
// Derivative on measurement avoids a kick when the target changes. Conditional
// integration suspends accumulation that would drive an already saturated output further.
function pidStep(
  state,
  { error, measurement, kp, ki, kd, dt, filter = 0, antiWindup = true, limit = 1, feedforward = 0 },
) {
  const slope = state.previous === undefined ? 0 : (measurement - state.previous) / dt;
  state.previous = measurement;
  const alpha = filter > 0 ? dt / (filter + dt) : 1;
  state.derivative = (state.derivative || 0) + alpha * (slope - (state.derivative || 0));
  const p = kp * error,
    d = -kd * state.derivative;
  let integral = (state.integral || 0) + ki * error * dt;
  const raw = feedforward + p + integral + d;
  if (antiWindup && ((raw > limit && error > 0) || (raw < -limit && error < 0)))
    integral = state.integral || 0;
  state.integral = integral;
  return { p, i: integral, d, command: clamp(feedforward + p + integral + d, -limit, limit) };
}
function controlMethod(id, c) {
  if (id === 'output' || (id === 'feedback' && !c.feedback)) return 'fixed';
  if (id === 'feedforward') return 'feedforward';
  if (id === 'combined') return c.strategy;
  if (id === 'reference') return 'both';
  return 'feedback';
}
function controlLoad(id, c) {
  if (id === 'output' || id === 'reference') return 'nominal';
  if (id === 'feedforward' || id === 'combined') return c.loadCase;
  return 'drag';
}
function simulateControl(id, input = {}) {
  const topic = CONTROL_TOPICS.find((t) => t.id === id),
    config = normalizeControlConfig(id, input),
    distance = topic.mode === 'distance';
  const target = distance ? 0.5 : config.targetRPM,
    method = controlMethod(id, config),
    loadCase = controlLoad(id, config),
    duration = 16,
    dt = 0.01,
    period = 0.05,
    maxSpeed = (2 * Math.PI * 0.065 * 80) / 60;
  let value = distance ? 1.6 : 0,
    velocity = 0,
    drive = 0,
    command = 0,
    measurement = value,
    parts = { p: 0, i: 0, d: 0 },
    collision = false;
  const pid = {},
    samples = [];
  let delayed = value,
    prior = value;
  const noise = (t) => Math.sin(t * 71) * 0.6 + Math.sin(t * 113 + 0.7) * 0.4;
  for (let n = 0; n <= Math.round(duration / dt); n++) {
    const time = n * dt,
      reference =
        id === 'reference' && config.profile === 'ramp' ? target * Math.min(1, time / 3) : target,
      blocked = id === 'limits' && time >= 3 && time < 7;
    const noisy = id === 'noise' || (id === 'challenge' && config.scenario === 'noisy');
    if (n % 5 === 0) {
      measurement = delayed + (noisy ? noise(time) * (distance ? 0.012 : 1.2) : 0);
      delayed = prior;
      prior = value;
      const ff =
        method === 'feedforward' || method === 'both' ? (config.ffGain * reference) / 100 : 0;
      if (method === 'fixed') {
        command = config.power / 100;
        parts = { p: 0, i: 0, d: 0 };
      } else if (method === 'feedforward') {
        command = clamp(ff, -1, 1);
        parts = { p: 0, i: 0, d: 0 };
      } else {
        parts = pidStep(pid, {
          error: distance ? measurement - reference : (reference - measurement) / 100,
          measurement: distance ? -measurement : measurement / 100,
          kp: config.kp,
          ki: config.ki,
          kd: config.kd,
          dt: period,
          filter: config.filter,
          antiWindup: config.antiWindup,
          feedforward: ff,
        });
        command = parts.command;
      }
      if (collision) command = 0;
      samples.push({
        time,
        target: reference,
        ff: ff * 100,
        correction: (parts.p + parts.i + parts.d) * 100,
        measured: measurement,
        actual: value,
        command: command * 100,
        rpm: distance ? (velocity / maxSpeed) * 80 : value,
        p: parts.p * 100,
        i: parts.i * 100,
        d: parts.d * 100,
        blocked,
        collision,
      });
    }
    if (n === Math.round(duration / dt)) break;
    if (distance) {
      const lag = config.scenario === 'heavy' && id === 'challenge' ? 1.05 : 0.7;
      velocity += ((maxSpeed * command - velocity) * dt) / lag;
      value -= velocity * dt;
      if (value <= 0.12) {
        value = 0.12;
        velocity = 0;
        collision = true;
      }
    } else {
      drive += ((command - drive) * dt) / 0.12;
      const load = id === 'limits' || loadCase !== 'drag' ? 0 : time >= 5 ? 15 : 0;
      const gain = loadCase === 'mismatch' ? 80 : 100;
      value += ((gain * drive - value - load * Math.tanh(value / 2)) * dt) / 0.35;
      if (blocked) value = 0;
      velocity = value;
    }
  }
  const result = {
    id,
    mode: topic.mode,
    config,
    target,
    method,
    loadCase,
    samples,
    duration,
    collision,
  };
  result.metrics = controlMetrics(result);
  return result;
}
function controlMetrics(result) {
  const { samples, target, mode, id, duration } = result,
    distance = mode === 'distance';
  const after = distance || result.loadCase !== 'drag' ? 0 : id === 'limits' ? 7 : 5,
    tolerance = distance ? 0.05 : 3;
  const tail = samples.filter((s) => s.time >= duration - 2);
  const finalError = mean(tail.map((s) => Math.abs(s.actual - target)));
  const overshoot = Math.max(
    0,
    ...samples.map((s) => (distance ? target - s.actual : s.actual - target)),
  );
  let settling = null;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (
      s.time < after ||
      Math.abs(s.actual - target) > tolerance ||
      (distance && Math.abs(s.rpm) > 3)
    )
      break;
    settling = s.time - after;
  }
  if (settling !== null && duration - after - settling < 1) settling = null;
  const eligible = samples.filter((s) => s.time >= after);
  const chatter = mean(eligible.slice(1).map((s, i) => Math.abs(s.command - eligible[i].command)));
  const passed =
    distance &&
    !result.collision &&
    settling !== null &&
    settling <= 10 &&
    overshoot <= 0.1 &&
    finalError <= 0.05;
  const peakAcceleration = Math.max(
    ...samples
      .slice(1)
      .map((s, i) => Math.abs(s.rpm - samples[i].rpm) / (s.time - samples[i].time)),
  );
  return { finalError, overshoot, settling, chatter, passed, after, tolerance, peakAcceleration };
}
function controlCSV(result) {
  const header =
    'time_s,target_' +
    (result.mode === 'distance' ? 'm' : 'rpm') +
    ',measured_' +
    (result.mode === 'distance' ? 'm' : 'rpm') +
    ',actual_' +
    (result.mode === 'distance' ? 'm' : 'rpm') +
    ',command_percent,wheel_rpm,p_percent,i_percent,d_percent,feedforward_percent,feedback_percent,lesson,scenario,kp,ki,kd,filter_s,anti_windup,feedback,fixed_power_percent,target_rpm,ff_gain,load_case,strategy,reference_profile';
  const c = result.config,
    metadata = [
      result.id,
      c.scenario,
      c.kp,
      c.ki,
      c.kd,
      c.filter,
      c.antiWindup,
      c.feedback,
      c.power,
      c.targetRPM,
      c.ffGain,
      result.loadCase,
      result.method,
      c.profile,
    ].join(',');
  return (
    '\uFEFF' +
    header +
    '\r\n' +
    result.samples
      .map(
        (s) =>
          [
            s.time,
            s.target,
            s.measured,
            s.actual,
            s.command,
            s.rpm,
            s.p,
            s.i,
            s.d,
            s.ff,
            s.correction,
          ]
            .map((v) => v.toFixed(4))
            .join(',') +
          ',' +
          metadata,
      )
      .join('\r\n')
  );
}
function controlCalibration() {
  return [20, 40, 60].map((power) => {
    const r = simulateControl('output', { power });
    return { power, rpm: mean(r.samples.filter((s) => s.time >= 14).map((s) => s.measured)) };
  });
}

export {
  CONTROL_GROUPS,
  CONTROL_TOPICS,
  controlDefaults,
  normalizeControlConfig,
  pidStep,
  controlMethod,
  controlLoad,
  simulateControl,
  controlMetrics,
  controlCSV,
  controlCalibration,
};
