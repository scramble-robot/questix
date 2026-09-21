import { loadText } from '../core/content.js';
import { lessonLabel } from '../shell/lesson-ui.js';
import { schoolTips } from '../shell/school-tips.js';
import { lessonBrief } from '../shell/lesson-brief.js';
import {
  ARM_TOPICS,
  ARM_MODEL,
  ARM_GOALS,
  ARM_OBSTACLE,
  SO101_JOINTS,
  armFK,
  armIK,
  armTrajectory,
  armClearance,
  so101FK,
  armParseJointState,
} from './core.js';
import { drawArm, drawSO101, armScenePoint } from './render.js';

const $ = (id) => document.getElementById(id),
  fmt = (v, d = 1) => (Math.abs(Number(v)) < 0.5 * 10 ** -d ? 0 : Number(v)).toFixed(d);
const COPY = {
  joints: {
    title: '物へ手を伸ばすには、どの関節を動かす？',
    scene:
      'ロボットの腕で物を取るには、まず物のある場所へ手先を運びます。ただし、関節を一つ回すだけでも、その先にある腕全体が動きます。根元の関節を「肩」、途中の関節を「肘」と呼びます。',
    purpose:
      'ここではこの2つの関節を横から見て、一つずつ角度を変え、手先がどこへ移るか比べます。緑の棒は肩から肘、青い棒は肘から手先、白い点は物をつかむ部分を代表する「手先」です。',
    first:
      '肩の角度を20°から60°に変え、「この角度まで動かす」を押してください。肘の角度を変えなくても、肘から先が一緒に動くことを確かめます。次は肩をそのままにして肘だけを変え、動く部分を比べてください。',
  },
  forward: {
    title: 'この角度にすると、手先はどこへ届く？',
    scene:
      '物を取る前に、指定した角度で手先がどこへ届くかを知りたい場面です。腕を曲げると、棒の長さを足すだけでは手先の位置になりません。',
    purpose:
      '肩を出発点に、緑と青の棒が横へ進む分と上へ進む分をそれぞれ足します。角度から位置を求めるこの計算を順運動学といいます。伸ばす向きや曲げ方を変え、図と計算した位置が合うか比べます。',
    first:
      '「横へまっすぐ」を選んで動かしてください。次に「上へまっすぐ」で比べます。図の破線と計算欄を見て、長さの合計290 mmがどの方向に現れるか確かめます。最後に「直角に曲げる」で、横160 mm・高さ130 mmになるか見ます。',
  },
  inverse: {
    title: '物のある位置から、届く関節の角度を探す',
    scene:
      '肩より右へ215 mm、上へ105 mmの物を取るため、その位置へ手先を運びたい場面です。位置は分かっていても、肩と肘を何度にすれば届くかはまだ分かりません。',
    purpose:
      '行き先から角度を探す計算を逆運動学といいます。同じ位置へ届く2通りの姿勢が見つかることがあるので、両方を動かして、手先と肘の位置を比べます。',
    first:
      '最初の目標で「届く角度を計算」を押してください。姿勢Aを選んで動かした後、姿勢Bでも試します。手先の位置が同じでも、肘の位置が変わるか見てください。',
  },
  reach: {
    title: 'その場所の物に、腕は届く？',
    scene:
      '物の位置へ手先を運びたくても、腕の長さや関節の動く範囲によっては届きません。160 mmと130 mmの棒は、伸ばし切ると290 mm、反対向きに折り返すと30 mmになります。そのため、長さだけで届くのは肩から30〜290 mmの範囲です。',
    purpose:
      '遠い位置と近い位置を比べ、さらに関節の角度を制限すると、届く答えがどう変わるか調べます。',
    first:
      '「遠すぎる位置」を選んで計算してください。その後「近すぎる位置」と比べます。次に「角度制限の例」で、制限を入れる前後の答えの数を比べます。',
  },
  challenge: {
    title: '支柱をよけて、3つの位置へ手先を運ぶ',
    scene:
      '支柱のある場所で、3つの目標へ順番に手先を運びます。手先が目標へ届く角度でも、途中で腕が支柱に当たると先へ進めません。',
    purpose:
      '同じ目標に届く姿勢を変えたり、一度別の場所（通過点）を経由したりして、腕全体が通れる動きを探します。到着時のずれと、途中で接触したかを比べてください。',
    first:
      '「届く角度を計算」で姿勢Aを選び、「選んだ姿勢へ動かす」を押します。支柱に当たったら「通過点とやり直し」を開いて開始姿勢へ戻し、姿勢Bを試してください。薄緑の手先の軌跡だけでなく、緑と青の棒が通る場所も比べます。接触せず目標の10 mm以内へ届くと、次の目標へ進めます。',
  },
  hardware: {
    title: '実物のアームでも、角度から手先の位置を確かめる',
    scene:
      '実物の小型アームSO-ARM101でも、物のある位置へ手先を運べるようにしたい場面です。実物は横と高さに加えて奥行き方向にも動くため、5つの関節の角度と寸法を使い、土台から見た手先の位置を計算します。',
    purpose:
      'まず関節を一つだけ変え、動く方向を調べます。実機があれば、計算した位置と実際に測った位置を比べ、ずれがないか確かめます。',
    first:
      'まず「全関節0°の計算を見る」を押し、台座の旋回だけを20°に変えます。立体図と下のx・y・zを見て、どの方向へ手先が動いたか比べてください。実機がなくても「模擬データを入れる」→「この角度を読み込む」で記録の読み方を試せます。実機があれば、同じ姿勢で測った手先位置と計算を比較します。',
  },
};
const states = new Map(
  ARM_TOPICS.map((t) => [
    t.id,
    {
      q: t.id === 'challenge' ? [80, -20] : [20, 65],
      desired: [20, 65],
      target: t.id === 'challenge' ? { ...ARM_GOALS[0] } : { x: 215, z: 105 },
      solution: null,
      selected: 0,
      limited: false,
      trace: [],
      records: [],
      goal: 0,
      hits: [],
      waypoint: false,
      notice: '',
    },
  ]),
);
let topic = 'joints',
  playing = false,
  run = null,
  index = 0,
  raf = 0,
  startTime = 0,
  offset = 0;
let realQ = [0, 0, 0, 0, 0],
  realSource = 'スライダーで設定した角度',
  measurements = [],
  jointInput = '',
  realError = '';
const state = () => states.get(topic),
  isInverse = () => ['inverse', 'reach', 'challenge'].includes(topic);
function download(name, body, type = 'text/plain') {
  const a = document.createElement('a'),
    url = URL.createObjectURL(new Blob([body], { type: type + ';charset=utf-8' }));
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function draw() {
  if (!$('armScene')) return;
  if (topic === 'hardware') {
    drawSO101($('armScene'), realQ);
    return;
  }
  const s = state(),
    ghost = isInverse() ? s.solution?.solutions[s.selected]?.q : s.desired;
  drawArm($('armScene'), {
    q: s.q,
    target: ['joints', 'forward'].includes(topic) ? null : s.target,
    ghost,
    trace: s.trace,
    reach: topic === 'reach',
    obstacle: topic === 'challenge',
    projections: topic === 'forward',
  });
  const f = armFK(s.q);
  $('armX').textContent = fmt(f.tip.x) + ' mm';
  $('armZ').textContent = fmt(f.tip.z) + ' mm';
  $('armAngles').textContent = fmt(s.q[0], 0) + '° / ' + fmt(s.q[1], 0) + '°';
  if ($('armCalculation'))
    $('armCalculation').innerHTML =
      `<div><span>横の位置 x</span><strong>${fmt(f.elbow.x)} + ${fmt(f.tip.x - f.elbow.x)} = ${fmt(f.tip.x)} mm</strong></div><div><span>高さ z</span><strong>${fmt(f.elbow.z)} + ${fmt(f.tip.z - f.elbow.z)} = ${fmt(f.tip.z)} mm</strong></div><p>緑の棒の分 ＋ 青の棒の分。高さ0は床ではなく、肩の中心です。</p>`;
}
function playback() {
  if (!$('armPause')) return;
  $('armPause').disabled = !run;
  $('armPause').textContent = playing
    ? 'Ⅱ 一時停止'
    : run && index < run.samples.length - 1
      ? '▶ 続きから見る'
      : '▶ 同じ動きを見る';
  $('armClock').textContent = run
    ? (playing ? '移動中' : '停止中') + ' · ' + fmt(run.samples[index].t) + ' 秒'
    : '実験前';
  if ($('armNextGoal')) $('armNextGoal').disabled = playing || !state().hits.includes(state().goal);
  for (const id of [
    'armRun',
    'armSolve',
    'armAngle0',
    'armAngle1',
    'armTargetX',
    'armTargetZ',
    'armLimit',
    'armMove',
  ])
    if ($(id))
      $(id).disabled =
        playing || (id === 'armMove' && !state().solution?.solutions[state().selected]?.allowed);
  $('armPage')
    .querySelectorAll('[data-arm-pose], [data-arm-preset], [data-arm-target]')
    .forEach((b) => (b.disabled = playing || b.dataset.blocked === 'true'));
}
function pause() {
  const wasPlaying = playing;
  playing = false;
  cancelAnimationFrame(raf);
  playback();
  if (wasPlaying)
    status(
      '移動を一時停止しました。「続きから見る」で再開できます。条件を変えた場合は、いまの姿勢から新しい動きを試します。',
    );
}
function clearMotion() {
  pause();
  run = null;
  index = 0;
  playback();
}
function status(message) {
  state().notice = message;
  if ($('armStatus')) $('armStatus').textContent = message;
}
function start(to) {
  pause();
  $('armScene').scrollIntoView({ block: 'start', behavior: 'instant' });
  const s = state();
  run = armTrajectory(s.q, to, topic === 'challenge' ? ARM_OBSTACLE : null);
  index = 0;
  s.trace = [];
  status('現在の姿勢から動かしています。途中で一時停止して、腕と手先の動きを確かめられます。');
  play();
}
function play() {
  if (!run) return;
  status('現在の姿勢から動かしています。途中で一時停止して、腕と手先の動きを確かめられます。');
  if (index === run.samples.length - 1) {
    index = 0;
    state().trace = [];
  }
  offset = run.samples[index].t;
  startTime = performance.now();
  playing = true;
  tick();
}
function tick() {
  if (!playing) return;
  const t = offset + (performance.now() - startTime) / 1000,
    s = state();
  while (index < run.samples.length - 1 && run.samples[index + 1].t <= t) {
    index++;
    s.trace.push(run.samples[index].tip);
  }
  s.q = [...run.samples[index].q];
  draw();
  playback();
  if (index === run.samples.length - 1) {
    pause();
    finish();
  } else raf = requestAnimationFrame(tick);
}
function finish() {
  const s = state(),
    f = armFK(s.q),
    error = Math.hypot(f.tip.x - s.target.x, f.tip.z - s.target.z);
  if (topic === 'challenge') {
    const hit = !run.collision && !s.waypoint && error <= 10;
    if (hit && !s.hits.includes(s.goal)) s.hits.push(s.goal);
    status(
      run.collision
        ? '腕が支柱に触れたので、そこで停止しました。到着位置だけでなく、途中の腕の位置も確かめましょう。'
        : s.waypoint
          ? '通過点に到着しました。「目標へ戻す」を押し、この姿勢から次の動きを考えます。'
          : hit
            ? '目標の10 mm以内へ到着しました。腕の途中も、支柱を避けて移動できました。'
            : '目標まであと ' + fmt(error) + ' mmです。行き先と角度を確かめてください。',
    );
    if (!run.recorded) {
      s.records.push({
        goal: s.goal + 1,
        error,
        collision: run.collision,
        clearance: run.minClearance,
        waypoint: s.waypoint,
      });
      run.recorded = true;
    }
    updateHistory();
    $('armNextGoal').disabled = !s.hits.includes(s.goal);
    $('armProgress').textContent = s.hits.length + ' / 3 個に到着';
  } else if (isInverse())
    status(
      '移動が終わりました。指定した位置との差は ' +
        fmt(error) +
        ' mmです。' +
        (s.solution?.solutions.length > 1
          ? 'もう一方の姿勢でも、肘の位置を比べてください。'
          : '目標の位置を変え、届く角度がどう変わるか確かめます。'),
    );
  else
    status(
      '移動が終わりました。肩 ' +
        fmt(s.q[0], 0) +
        '°・肘 ' +
        fmt(s.q[1], 0) +
        '°のとき、手先は横 ' +
        fmt(f.tip.x) +
        ' mm、高さ ' +
        fmt(f.tip.z) +
        ' mmです。次は関節を一つだけ変えて比べてください。',
    );
}
function solve() {
  clearMotion();
  const s = state();
  if (
    topic !== 'challenge' &&
    [$('armTargetX'), $('armTargetZ')].some((v) => !v.value.trim() || !v.checkValidity())
  ) {
    s.solution = null;
    solutionView();
    status('目標の横位置と高さを、図の範囲内の数値で入力してください。');
    return;
  }
  s.solution = armIK(s.target, topic === 'challenge' || s.limited);
  s.selected = Math.max(
    0,
    s.solution.solutions.findIndex((v) => v.allowed),
  );
  solutionView();
  draw();
  playback();
  const r = s.solution;
  status(
    r.reason === 'far'
      ? '肩から290 mmより遠いので届きません。目標を腕の長さの合計より内側へ動かしてください。'
      : r.reason === 'near'
        ? '2本の長さの差は30 mm。肩に近すぎるこの場所には、折り畳んでも届きません。'
        : r.reason === 'limits'
          ? '長さだけなら届きますが、この角度制限の範囲では届く姿勢がありません。制限を外した場合と比べてください。'
          : r.reason === 'invalid'
            ? '目標の横位置と高さを数値で入力してください。'
            : r.singular
              ? '届く角度が見つかりました。ほぼ一直線の姿勢です。ここでは2つの姿勢が重なったり、近づいたりします。'
              : '届く角度が見つかりました。白い細線は選んだ到着姿勢です。「選んだ姿勢へ動かす」で途中の動きを確かめます。',
  );
}
function solutionView() {
  if (!$('armSolutions')) return;
  const s = state(),
    r = s.solution;
  $('armSolutions').innerHTML = !r
    ? '<p class="helper">目標を決めてから、角度を計算します。</p>'
    : !r.solutions.length
      ? '<p class="arm-no-solution">届く角度はありません</p>'
      : r.solutions
          .map(
            (v, i) =>
              `<button type="button" class="arm-solution" data-arm-pose="${i}" data-blocked="${!v.allowed}" aria-pressed="${i === s.selected}" ${!v.allowed ? 'disabled' : ''}><strong>姿勢${i === 0 ? 'A' : 'B'}</strong><span>肩 ${fmt(v.q[0])}° ／ 肘 ${fmt(v.q[1])}°</span><small>${!v.allowed ? '設定した角度範囲の外' : topic === 'challenge' && armClearance(v.q) <= 0 ? '到着姿勢で支柱に重なる' : 'この姿勢を選ぶ'}</small></button>`,
          )
          .join('');
  $('armPage')
    .querySelectorAll('[data-arm-pose]')
    .forEach(
      (b) =>
        (b.onclick = () => {
          clearMotion();
          s.selected = +b.dataset.armPose;
          solutionView();
          draw();
          playback();
        }),
    );
  $('armMove').hidden = !r || !r.solutions.some((v) => v.allowed);
  $('armSolve').classList.toggle('primary', !r || r.reason !== 'ok');
}
function setTarget(t, waypoint = false) {
  clearMotion();
  const s = state();
  s.target = { ...t };
  s.waypoint = waypoint;
  s.solution = null;
  const x = $('armTargetX'),
    z = $('armTargetZ');
  if (x) {
    x.value = t.x;
    z.value = t.z;
  }
  solutionView();
  draw();
  playback();
  status('行き先を変更しました。「届く角度を計算」で、届く姿勢を調べます。');
}
function updateHistory() {
  const s = state();
  if (!$('armHistory')) return;
  $('armHistory').innerHTML = s.records.length
    ? `<table><thead><tr><th>行き先</th><th>結果</th><th>到着時のずれ</th></tr></thead><tbody>${s.records
        .slice(-5)
        .map(
          (r) =>
            `<tr><td>${r.waypoint ? '通過点' : '目標 ' + r.goal}</td><td>${r.collision ? '支柱に接触' : '到着'}</td><td>${fmt(r.error)} mm</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p>動かすと、ここに結果が残ります。失敗しても記録を使って比べられます。</p>';
}
function modelHelp() {
  return `<details data-help-dialog><summary>教材モデルとSO-ARM101の違い</summary><p>最初の5つの実験は、側面から見た2関節の、角度と長さから位置を計算するモデルです。160 mmと130 mmは考えやすくするための教材用の長さで、SO-ARM101の実寸ではありません。台座の旋回、手首、指の開閉は省略しています。</p><p>角度0°の肩は右向き。肘の0°は、肩からの棒をまっすぐ延ばした状態です。肘の角度は地面からの角度ではありません。高さの基準は肩の中心です。機体は停止させています。</p><p>動きは、開始と終了の関節角度の間を滑らかに変えています。速度制御、重力、たわみ、負荷、機体の転倒は計算していません。障害物の実験では棒を半径7 mmの太さとして支柱との接触を調べますが、腕の部品同士の接触やロボット本体との接触は含みません。</p><p>「SO-ARM101で確かめる」では別のモデルを使います。公式URDFにある関節の位置・回転軸・可動範囲と手先の基準点から順運動学を計算します。前の実験の角度を、そのまま実機への指示に使うことはできません。</p></details>`;
}
function reflection() {
  const content = {
    joints: [
      '肘の角度を変えないのに、肘より先も動くのはなぜ？',
      '肘は肩からの棒についているため、肩を回すと肘の位置も変わります。肘の角度とは、手前の棒に対してどれだけ曲げるかです。',
      '肘を0°にして肩だけを動かしてみましょう。2本の棒が一直線のまま動くか確かめます。',
    ],
    forward: [
      '長さを足すだけでは、手先の位置にならない？',
      '2本をまっすぐ伸ばしたときだけ、肩から手先までが290 mmになります。曲げたときは、横と縦の成分を別々に足す必要があります。',
      '肩0°・肘90°にすると、横は160 mm、高さは130 mmです。図で直角を作って確かめてください。',
    ],
    inverse: [
      '同じ位置に届くなら、どちらの姿勢でもよい？',
      '位置だけを指定すると、肘の位置が違う複数の答えが見つかります。実機では関節の範囲、周囲の物、つかむ向きも考えて選びます。',
      '少しだけ目標を動かし、角度の変化を比べてみましょう。順運動学に戻して同じ位置になるかも確認できます。',
    ],
    reach: [
      '届く範囲の端では、何が起こる？',
      '2本が一直線になる位置では、2通りの姿勢が同じになります。その付近では、手先の小さな位置の変化に対して関節角度が大きく変わることがあります。特異姿勢と呼ぶ状態の一例です。',
      '制限を外し、横290 mm・高さ0 mmから横289 mmへ変えます。位置は1 mmの違いですが、肘は何度変わるでしょうか。',
    ],
    challenge: [
      '逆運動学で答えが出ても、そのまま動かせるとは限らない',
      '逆運動学は、到着する姿勢を求めます。そこへ至る道のりは別の問題です。この実験では各関節を同時に動かすので、手先は必ずしも直線を通りません。',
      '到着姿勢を変えて比べます。それでも通れないときは「高い通過点を使う」で一度上へ移動し、そこから目標へ向かいます。',
    ],
  }[topic];
  return `<section class="card arm-reflection"><h2>${content[0]}</h2><p>${content[1]}</p><details><summary>次に試すためのヒント</summary><p>${content[2]}</p></details></section>`;
}
function render() {
  pause();
  run = null;
  const s = state(),
    copy = COPY[topic];
  $('armPage').innerHTML =
    `<div class="page-heading"><div><p class="eyebrow course-label">${lessonLabel('arm')}</p><h1>${copy.title}</h1></div></div><nav class="arm-topics" aria-label="アームの学習順序">${ARM_TOPICS.map((t, i) => `<button data-arm-topic="${t.id}" aria-current="${topic === t.id ? 'step' : 'false'}"><span>${i + 1}</span>${t.label}</button>`).join('')}</nav>${lessonBrief('arm-' + topic, copy)}${schoolTips('arm-' + topic)}${topic === 'hardware' ? hardware() : experiment()}<div class="arm-bottom"><button id="armPrevious">← 前の実験</button><span>${ARM_TOPICS.findIndex((t) => t.id === topic) + 1} / ${ARM_TOPICS.length}</span><button id="armNext">次の実験 →</button></div>`;
  $('armPage')
    .querySelectorAll('[data-arm-topic]')
    .forEach((b) => (b.onclick = () => changeTopic(b.dataset.armTopic)));
  const i = ARM_TOPICS.findIndex((t) => t.id === topic);
  $('armPrevious').disabled = i === 0;
  $('armNext').disabled = false;
  if (i === ARM_TOPICS.length - 1) $('armNext').textContent = '小テストで確かめる →';
  $('armPrevious').onclick = () => changeTopic(ARM_TOPICS[i - 1].id);
  $('armNext').onclick = () => {
    if (i === ARM_TOPICS.length - 1)
      document.dispatchEvent(new CustomEvent('quiz-open', { detail: 'arm' }));
    else changeTopic(ARM_TOPICS[i + 1].id);
  };
  if (topic === 'hardware') bindHardware();
  else bindExperiment();
  draw();
}
function changeTopic(id) {
  pause();
  if (run && index < run.samples.length - 1)
    state().notice = '途中の姿勢を残しています。条件を選び直し、この姿勢からもう一度動かせます。';
  topic = id;
  render();
  $('armPage').scrollIntoView({ block: 'start', behavior: 'instant' });
}
function experiment() {
  const s = state(),
    inverse = isInverse();
  return `<div class="arm-layout"><section class="card arm-workspace"><div class="arm-view-head"><h2>${topic === 'challenge' ? '目標 ' + (s.goal + 1) + '：支柱を避けて届ける' : '角度と手先の位置を見比べる'}</h2><span>肩の中心が0：右方向をx、上方向をzで表す</span></div><div class="diagram-scroll" role="region" aria-label="実験の図。狭い画面では横にスクロールできます" tabindex="0"><canvas id="armScene" width="760" height="490" aria-label="肩と肘を持つアームの側面図。現在の角度と手先位置は図の下にも表示します。"></canvas></div><p class="diagram-scroll-hint">図は左右にスクロールできます。</p><div class="arm-playbar"><button id="armPause" disabled>Ⅱ 一時停止</button><span id="armClock">実験前</span><span>実線：現在 ／ 細線：到着姿勢</span></div><dl class="arm-readings"><div><dt>手先の横位置 x</dt><dd id="armX"></dd></div><div><dt>肩からの高さ z</dt><dd id="armZ"></dd></div><div><dt>現在の肩 / 肘</dt><dd id="armAngles"></dd></div></dl><p id="armStatus" class="arm-status" role="status">${s.notice || '関節の角度を決め、ボタンを押すと現在の姿勢から動き始めます。'}</p>${topic === 'forward' ? '<div id="armCalculation" class="arm-calculation"></div>' : ''}</section><aside class="card arm-guide"><p class="eyebrow">${inverse ? '① 行き先 → ② 角度を計算 → ③ 動かす' : '角度を決めて、動きを確かめる'}</p><h2>${inverse ? '手先をどこへ運ぶ？' : '関節を何度にする？'}</h2>${inverse ? targetControls() : angleControls()}${topic === 'challenge' ? `<p id="armProgress" class="arm-progress">${s.hits.length} / 3 個に到着</p><button id="armNextGoal" class="full" ${s.hits.includes(s.goal) ? '' : 'disabled'} ${s.goal === 2 ? 'hidden' : ''}>次の目標へ →</button><details class="arm-extra"><summary>通過点とやり直し</summary><p>まず高い位置へ動かしてから目標に向かうと、途中の道筋も変わります。</p><button id="armWaypoint">高い通過点を使う</button><button id="armGoal">目標へ戻す</button><button id="armReset">開始姿勢に戻す</button></details>` : ''}${modelHelp()}</aside></div>${topic === 'challenge' ? '<section class="card arm-reflection"><h2 data-lesson-cue="result">試した結果を比べる</h2><div id="armHistory" class="arm-table"></div></section>' : ''}${reflection()}`;
}
function angleControls() {
  const s = state();
  return `${[0, 1].map((i) => `<label class="arm-angle-label" for="armAngle${i}">${i === 0 ? '肩：右向きからの角度' : '肘：手前の棒からの曲げ角度'}<output id="armAngleValue${i}">${s.desired[i]}°</output></label><input id="armAngle${i}" type="range" min="-150" max="150" step="1" value="${s.desired[i]}">`).join('')}<p class="helper">スライダーは到着時の角度を決めます。細線がその姿勢で、ボタンを押すと太い棒が動きます。肩0°は右向き、肘0°は2本がまっすぐな状態です。どちらも正の角度では図の反時計回り、負では時計回りに回します。</p><button class="primary full" id="armRun">この角度まで動かす</button>${topic === 'forward' ? '<div class="arm-presets"><button data-arm-preset="0,0">横へまっすぐ</button><button data-arm-preset="90,0">上へまっすぐ</button><button data-arm-preset="0,90">直角に曲げる</button></div><details data-help-dialog><summary>位置を計算する式を見る</summary><p>肩の角度を a、肘の角度を b とします。2本目の棒の向きは、a+bです。</p><p class="arm-equation">x = 160 cos a + 130 cos(a+b)<br>z = 160 sin a + 130 sin(a+b)</p><p>cos（コサイン）は横方向、sin（サイン）は縦方向に長さを分けるときに使います。式の暗記から始めず、横・上・直角の3つの姿勢で、図と計算結果が合うか見てください。</p></details>' : ''}`;
}
function targetControls() {
  const s = state();
  return `<div class="arm-input-pair"><label for="armTargetX">横位置 x (mm)<input id="armTargetX" type="number" min="-350" max="400" value="${s.target.x}" ${topic === 'challenge' ? 'readonly' : ''}></label><label for="armTargetZ">高さ z (mm)<input id="armTargetZ" type="number" min="-100" max="320" value="${s.target.z}" ${topic === 'challenge' ? 'readonly' : ''}></label></div><p class="helper">${topic === 'challenge' ? '黄色の輪が今回の目標です。支柱は腕の途中にも当たります。' : '肩の中心から右ならxを正、左なら負にします。肩より上ならzを正、下なら負にします。例えばx=160、z=130は、右へ160 mm、上へ130 mmです。数値を入力するか図をクリックした後、「届く角度を計算」を押してください。'}</p>${topic === 'reach' ? '<div class="arm-presets"><button data-arm-target="330,0">遠すぎる位置</button><button data-arm-target="10,0">近すぎる位置</button><button data-arm-target="180,-50">角度制限の例</button></div><label class="arm-check"><input id="armLimit" type="checkbox" ' + (s.limited ? 'checked' : '') + '>関節の角度を制限する</label><p class="helper">教材の制限：肩0〜150°、肘−150〜150°。SO-ARM101の実機の範囲とは異なります。緑の範囲は長さだけで届く場所です。</p>' : ''}<button class="primary full" id="armSolve">届く角度を計算</button><div id="armSolutions" class="arm-solutions"></div><button class="primary full" id="armMove" hidden>選んだ姿勢へ動かす</button>`;
}
function bindExperiment() {
  const s = state();
  $('armPause').onclick = () => (playing ? pause() : play());
  if (isInverse()) {
    $('armSolve').onclick = solve;
    $('armMove').onclick = () => {
      const chosen = s.solution?.solutions[s.selected];
      if (chosen?.allowed) start(chosen.q);
    };
    const input = () => {
      const x = $('armTargetX'),
        z = $('armTargetZ');
      if (
        x.value.trim() === '' ||
        z.value.trim() === '' ||
        !x.checkValidity() ||
        !z.checkValidity()
      ) {
        s.solution = null;
        solutionView();
        playback();
        status('図の範囲内の数値を入力してください。');
        return;
      }
      setTarget({ x: +x.value, z: +z.value });
    };
    if (topic !== 'challenge') {
      $('armTargetX').onchange = input;
      $('armTargetZ').onchange = input;
      $('armScene').onclick = (e) => {
        if (playing) return;
        const t = armScenePoint($('armScene'), e);
        if (t.x >= -220 && t.x <= 400 && t.z >= -100 && t.z <= 300) setTarget(t);
      };
    }
    if ($('armLimit'))
      $('armLimit').onchange = (e) => {
        s.limited = e.target.checked;
        s.solution = null;
        solutionView();
        draw();
        playback();
        status('関節の条件を変えました。同じ目標で、もう一度角度を計算してください。');
      };
    $('armPage')
      .querySelectorAll('[data-arm-target]')
      .forEach(
        (b) =>
          (b.onclick = () => {
            const [x, z] = b.dataset.armTarget.split(',').map(Number);
            setTarget({ x, z });
          }),
      );
    solutionView();
  } else {
    for (let i = 0; i < 2; i++)
      $('armAngle' + i).oninput = (e) => {
        clearMotion();
        s.desired[i] = +e.target.value;
        $('armAngleValue' + i).textContent = s.desired[i] + '°';
        draw();
      };
    $('armRun').onclick = () => start(s.desired);
    $('armPage')
      .querySelectorAll('[data-arm-preset]')
      .forEach(
        (b) =>
          (b.onclick = () => {
            clearMotion();
            s.desired = b.dataset.armPreset.split(',').map(Number);
            for (let i = 0; i < 2; i++) {
              $('armAngle' + i).value = s.desired[i];
              $('armAngleValue' + i).textContent = s.desired[i] + '°';
            }
            draw();
          }),
      );
  }
  if (topic === 'challenge') {
    $('armNextGoal').onclick = () => {
      if (s.goal < 2 && s.hits.includes(s.goal)) {
        s.goal++;
        s.target = { ...ARM_GOALS[s.goal] };
        s.solution = null;
        s.waypoint = false;
        render();
      }
    };
    $('armWaypoint').onclick = () => setTarget({ x: 110, z: 240 }, true);
    $('armGoal').onclick = () => setTarget(ARM_GOALS[s.goal]);
    $('armReset').onclick = () => {
      clearMotion();
      s.q = [80, -20];
      s.trace = [];
      draw();
      status(
        '開始姿勢に戻しました。記録は残っています。姿勢や通過点を変えて、もう一度試してください。',
      );
    };
    updateHistory();
  }
  playback();
}
function hardware() {
  return `<div class="arm-layout"><section class="card arm-workspace"><div class="diagram-scroll" role="region" aria-label="実験の図。狭い画面では横にスクロールできます" tabindex="0"><canvas id="armScene" width="760" height="490" aria-label="SO-ARM101の関節を結んだ立体図。各関節の角度から計算した位置です。"></canvas></div><p class="diagram-scroll-hint">図は左右にスクロールできます。</p><dl class="arm-readings"><div><dt>手先 x</dt><dd id="armRealX"></dd></div><div><dt>手先 y</dt><dd id="armRealY"></dd></div><div><dt>手先 z</dt><dd id="armRealZ"></dd></div></dl><p id="armRealSource" class="arm-status"></p><div class="arm-hardware-note"><h2>手先の位置と、つかむ向きは別の条件</h2><p>物をつかむには、同じ場所へ届くだけでなく、指を向ける方向も合わせます。関節の数や動ける範囲によっては、位置と向きをすべて自由に指定できません。指の開閉は物を挟むための動きで、ここで示す固定された手先の基準点を運ぶ動きには数えていません。</p></div></section><aside class="card arm-guide"><p class="eyebrow">実機の寸法で、角度から位置を計算</p><h2>5つの関節角度を変える</h2>${SO101_JOINTS.map((j, i) => `<label class="arm-angle-label" for="armReal${i}">${i + 1}. ${j.label}<output id="armRealValue${i}">${fmt(realQ[i], 0)}°</output></label><input id="armReal${i}" type="range" min="${((j.limit[0] * 180) / Math.PI).toFixed(3)}" max="${((j.limit[1] * 180) / Math.PI).toFixed(3)}" step="1" value="${realQ[i]}">`).join('')}<p class="helper">台座・肩・肘・手首の曲げ・手首の回転の5つを動かします。別に指を開閉する関節もあります。図は関節の中心を線で結んだ立体図です。赤・緑・青の軸は、土台から測るx・y・zの正方向を示します。下の3つの数値は、手先の基準点が各方向へ何mm離れたかです。外装の形や、物とぶつかる範囲は描いていません。</p><button id="armRealZero" class="full">全関節0°の計算を見る</button><details data-help-dialog><summary>実機で使う座標とモデルの出典</summary><p>機体の寸法、関節の位置、回転軸を記したファイルをURDFと呼びます。ここではTheRobotStudioのSO101用 <code>so101_new_calib.urdf</code> を使います。土台の基準には <code>base_link</code>、手先の基準点には <code>gripper_frame_link</code> という名前が付いています。土台から各関節の移動と回転を順につなぎ、手先位置を求めます。画面の角度は度、読み込む角度はラジアン（rad）です。180°＝π radなので、約1.57 radが90°に当たります。</p><p>実機の校正と、このURDFの0の位置・符号が一致している必要があります。モーターの生の値や、ライブラリ独自の正規化値は、そのまま角度として使えません。指先の別の場所を測る場合は、基準点の位置も変更する必要があります。</p><p>ここでの計算は幾何学だけです。外装同士や機体との接触、負荷、重力は判定していません。台座が動く場合は、地図→機体→アームの土台→手先の座標変換をつなぐ必要があります。RGB-Dカメラの物体位置も、カメラ座標から同じ基準へ変換してから使います。</p><p><a href="https://github.com/TheRobotStudio/SO-ARM100" target="_blank" rel="noopener">SO-ARM公式リポジトリ</a> · <a href="https://github.com/TheRobotStudio/SO-ARM100/blob/main/Simulation/SO101/so101_new_calib.urdf" target="_blank" rel="noopener">参照したURDF</a>（2026年9月21日確認）。この教材は実機に動作指示を送信しません。</p></details></aside></div><section class="card arm-real-lab"><div><p class="eyebrow">実機で確かめる</p><h2>計算した位置と、ものさしで測った位置を比べる</h2><p>機体を固定し、別の操縦系でアームを静止させます。そのときの関節角度と、アームの土台を基準に測った手先の位置を組にして記録します。計算と違ったら、角度の原点・棒の寸法・測る点を一つずつ確かめます。</p></div><div class="arm-real-columns"><div><h3>1. 静止中の関節角度を読み込む</h3><p>ROS 2は、ロボットのプログラム同士でデータを受け渡す仕組みです。関節の状態を記録するJointStateには、関節名の一覧 <code>name</code> と、同じ順番の角度の一覧 <code>position</code> があります。この2つをJSONという文字の形式で入力します。角度はrad単位です。まず下の「模擬データを入れる」で書き方を確認できます。</p><label for="armJointData">角度データ（JSON）</label><textarea id="armJointData" rows="5" spellcheck="false"></textarea><div class="arm-actions"><button id="armJointExample">模擬データを入れる</button><button id="armJointRead" class="primary">この角度を読み込む</button></div><label class="arm-json-file">JSONファイルを開く<input id="armJointFile" type="file" accept=".json,application/json"></label><p id="armRealError" role="status"></p></div><div><h3>2. 測った手先位置を記録する</h3><p>土台の基準点を0として、図の赤・緑・青の軸と同じ向きで測ったx・y・zをmmで入力します。計算値を写すのではなく、同じ静止姿勢で実際に測った値を使います。記録の「位置のずれ」は、計算した点と測った点の間の直線距離で、0 mmに近いほど一致しています。</p><form id="armMeasureForm"><div class="arm-input-triple">${['x', 'y', 'z'].map((k) => `<label for="armMeasured${k}">${k} (mm)<input id="armMeasured${k}" type="number" step="any" required></label>`).join('')}</div><button type="submit" class="primary">計算との差を記録する</button></form><p id="armMeasureStatus" role="status"></p></div></div><div id="armMeasurements" class="arm-table"></div><button id="armExport">比較した記録をCSVで保存</button><details data-help-dialog><summary>ROS 2で角度を記録する手順</summary><ol><li>SO-ARM101のドライバで関節を校正し、使用するURDFの関節名・原点・符号・単位とそろえます。</li><li>静止させてから <code>ros2 topic echo /joint_states --once</code> で1件を確認します。トピック名は実機の構成に合わせます。</li><li>表示は通常YAMLです。教材のJSON入力では、nameを引用符付きの名前の配列、positionをラジアン単位の数値配列にします。下の記録スクリプトなら、そのまま読み込めるJSONファイルを保存できます。</li><li>同じ姿勢の手先位置を測り、計算との差を記録します。複数の姿勢で比べると、原点のずれと寸法のずれを切り分けやすくなります。</li></ol><button id="armROSDownload">角度を1件保存するPythonを取得</button><p>ROS 2環境を読み込んだ端末で <code>python3 record_arm_joint_state.py</code> を実行します。受信するだけのスクリプトです。保存先は実行したフォルダの <code>arm-joint-state.json</code>。機種固有の通信設定や校正は、この教材では行いません。</p></details></section>`;
}
function hardwareValues() {
  const f = so101FK(realQ);
  for (const k of ['x', 'y', 'z'])
    $('armReal' + k.toUpperCase()).textContent = fmt(f.tip[k]) + ' mm';
  $('armRealSource').textContent =
    realSource + '。角度と機体寸法から求めた位置で、カメラなどで測った位置ではありません。';
  draw();
}
function measurementView() {
  $('armMeasurements').innerHTML = measurements.length
    ? `<table><thead><tr><th>記録</th><th>角度の出所</th><th>計算位置 x / y / z (mm)</th><th>測定位置 (mm)</th><th>位置のずれ</th></tr></thead><tbody>${measurements
        .slice(-6)
        .map(
          (r, i) =>
            `<tr><td>${Math.max(0, measurements.length - 6) + i + 1}</td><td>${r.source}</td><td>${Object.values(
              r.expected,
            )
              .map((v) => fmt(v))
              .join(' / ')}</td><td>${Object.values(r.measured)
              .map((v) => fmt(v))
              .join(' / ')}</td><td>${fmt(r.error)} mm</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p>まだ比較の記録はありません。実機がない場合は、上のスライダーで位置の変化を調べられます。</p>';
  $('armExport').disabled = !measurements.length;
}
function bindHardware() {
  for (let i = 0; i < 5; i++)
    $('armReal' + i).oninput = (e) => {
      realQ[i] = +e.target.value;
      $('armRealValue' + i).textContent = fmt(realQ[i], 0) + '°';
      realSource = 'スライダーで設定した角度';
      hardwareValues();
    };
  const sync = () => {
    for (let i = 0; i < 5; i++) {
      $('armReal' + i).value = realQ[i];
      $('armRealValue' + i).textContent = fmt(realQ[i], 1) + '°';
    }
    hardwareValues();
  };
  $('armRealZero').onclick = () => {
    realQ = [0, 0, 0, 0, 0];
    realSource = '全関節0°の計算例';
    sync();
  };
  $('armJointData').value = jointInput;
  $('armJointData').oninput = (e) => (jointInput = e.target.value);
  $('armRealError').textContent = realError;
  $('armJointExample').onclick = () => {
    jointInput = JSON.stringify(
      {
        source: 'simulated',
        name: SO101_JOINTS.map((j) => j.name),
        position: [0.2, -0.3, 0.4, -0.2, 0.1],
      },
      null,
      2,
    );
    $('armJointData').value = jointInput;
  };
  $('armJointRead').onclick = () => {
    try {
      const input = $('armJointData').value;
      realQ = armParseJointState(input);
      realSource =
        JSON.parse(input).source === 'simulated' ? '模擬のJointState' : '入力されたJointState';
      realError = '読み込みました。図と計算位置を更新しました。';
      sync();
    } catch (e) {
      realError = e.message;
    }
    $('armRealError').textContent = realError;
  };
  $('armJointFile').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 262144)
        throw new Error('1件の関節角度データを選んでください（256 KBまで）。');
      const value = await file.text();
      realQ = armParseJointState(value);
      jointInput = value;
      $('armJointData').value = value;
      realSource =
        JSON.parse(value).source === 'simulated' ? '模擬のJointState' : '入力されたJointState';
      realError = 'ファイルを読み込みました。';
      sync();
    } catch (error) {
      realError = error.message;
    }
    $('armRealError').textContent = realError;
    e.target.value = '';
  };
  $('armMeasureForm').onsubmit = (e) => {
    e.preventDefault();
    const fields = ['x', 'y', 'z'].map((k) => $('armMeasured' + k));
    if (fields.some((v) => !v.value.trim() || !v.checkValidity() || !Number.isFinite(+v.value)))
      return;
    const measured = { x: +fields[0].value, y: +fields[1].value, z: +fields[2].value },
      expected = so101FK(realQ).tip,
      error = Math.hypot(...['x', 'y', 'z'].map((k) => measured[k] - expected[k]));
    measurements.push({ q: [...realQ], source: realSource, measured, expected, error });
    measurementView();
    $('armMeasureStatus').textContent =
      '記録しました。計算位置との差は ' + fmt(error) + ' mmです。';
  };
  $('armExport').onclick = () => {
    const head = [
      'source',
      ...SO101_JOINTS.map((j) => j.name + '_deg'),
      'expected_x_mm',
      'expected_y_mm',
      'expected_z_mm',
      'measured_x_mm',
      'measured_y_mm',
      'measured_z_mm',
      'error_mm',
    ];
    download(
      'questix-arm-comparison.csv',
      [
        head.join(','),
        ...measurements.map((r) =>
          [
            r.source,
            ...r.q,
            ...Object.values(r.expected),
            ...Object.values(r.measured),
            r.error,
          ].join(','),
        ),
      ].join('\n'),
      'text/csv',
    );
  };
  $('armROSDownload').onclick = () => download('record_arm_joint_state.py', ROS_SCRIPT);
  hardwareValues();
  measurementView();
}
const ROS_SCRIPT = await loadText('content/arm/record_arm_joint_state.py');
function initArm() {
  render();
  document.addEventListener('series-leave', pause);
  document.addEventListener('supplement-open', pause);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });
  window.addEventListener('resize', () => {
    if (!$('armPage').hidden) draw();
  });
}
function activateArm() {
  draw();
}
function reviewArm(id) {
  if (!ARM_TOPICS.some((t) => t.id === id)) return false;
  changeTopic(id);
  return true;
}

export { initArm, activateArm, reviewArm };
