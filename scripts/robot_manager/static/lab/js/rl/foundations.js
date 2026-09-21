import { lessonGuide, figureGuide } from '../shell/lesson-guide.js';
import { IntroLearner, introRandom, introRollout } from './intro.js';
import {
  ACTION_LABELS,
  INTRO_START,
  experienceStep,
  robotReading,
  RouteLearner,
  FutureLearner,
  evaluationStarts,
  evaluateLearner,
  newTrainingModel,
} from './foundations-core.js';
import { drawRobot } from '../core/renderer.js';

const $ = (id) => document.getElementById(id),
  all = (s) => [...document.querySelectorAll(s)];
const TOPICS = [
  ['experience', '行動と報酬', 0],
  ['explore', '未経験の配達先も試す', 0],
  ['future', '後でもらう報酬', 1],
  ['reward', '報酬を設計する', 1],
  ['test', '学習とテスト', 2],
  ['transfer', '実機との違い', 2],
  ['delivery', '届け先へ運ぶ', 3],
  ['dock', '向きを合わせて止まる', 3],
];
const GROUPS = ['経験から学ぶ仕組み', '目的に合う報酬', '学んだ動きを確かめる', 'コースで試す'];
let topic = 'experience',
  onLab,
  paint = () => {},
  busy = false;
let oneModel = new IntroLearner('approach', introRandom(5)),
  onePose = { ...INTRO_START },
  oneTrace = [onePose],
  oneEvent = null;
let routes = new RouteLearner(),
  exploration = 0,
  routeBatch = [],
  future = new FutureLearner(0.9),
  futureImmediate = new FutureLearner(0);
let testMode = 'fixed',
  testModel = null,
  testResult = null,
  testOld = null,
  testIndex = 0,
  starts = evaluationStarts();
let transferModel = null,
  transferVary = false,
  transferGain = 0.7,
  transferResult = null,
  transferOld = null;
const format = (v, n = 1) => Number(v).toFixed(n),
  signed = (v, n = 1) => (v >= 0 ? '+' : '−') + format(Math.abs(v), n);
const button = (id, text, primary = false) =>
  `<button id="${id}" class="${primary ? 'primary ' : ''}full">${text}</button>`;
const details = (title, text) => `<details><summary>${title}</summary><p>${text}</p></details>`;
function metrics(items) {
  $('rlMetrics').innerHTML = items
    .map(([title, value]) => `<div><span>${title}</span><strong>${value}</strong></div>`)
    .join('');
}
function question(title, text, hint) {
  $('rlQuestion').innerHTML =
    `<h2>${title}</h2><p>${text}</p>${details('考えるためのヒント', hint)}`;
}
function explanation(title, text) {
  $('rlExplanation').innerHTML = `<h3>${title}</h3><p>${text}</p>`;
}
function status(text) {
  $('rlObservation').textContent = text;
}
function scaffold(title, subtitle, controls) {
  $('rlQuestion').hidden = false;
  $('rlFigureTitle').textContent = title;
  $('rlFigureStep').textContent = subtitle;
  $('rlControls').innerHTML = controls;
  $('rlFigure').innerHTML = '';
  $('rlMetrics').innerHTML = '';
  $('rlExplanation').innerHTML = '';
  $('rlExtra').innerHTML = '';
  paint = () => {};
}
function chart(rows, max = 8) {
  const signedScale = rows.some(([, value]) => value < 0),
    limit = Math.max(max, 1, ...rows.map(([, value]) => Math.abs(value)));
  return `<div class="rl-value-chart">${rows
    .map(([label, value, caption]) => {
      const width = (Math.abs(value) / limit) * (signedScale ? 50 : 100),
        left = signedScale ? (value < 0 ? 50 - width : 50) : 0;
      return `<div><span>${label}</span><div><div class="rl-value-track${signedScale ? ' signed' : ''}"><i style="left:${left}%;width:${width}%;${value < 0 ? 'background:#b27b42' : ''}"></i></div><small>${caption || ''}</small></div><strong>${caption === '未経験' ? '未経験' : format(value, 2)}</strong></div>`;
    })
    .join(
      '',
    )}</div>${signedScale ? '<p class="helper">中央の線が0です。右へ伸びる緑の棒はプラス、左へ伸びる茶色の棒はマイナスの見積もりを表します。</p>' : ''}`;
}
function robotMap(id, trace, options = {}) {
  const canvas = $(id);
  if (!canvas) return;
  const w = canvas.getBoundingClientRect().width || 680,
    dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round((w / 1.7) * dpr);
  const c = canvas.getContext('2d');
  c.setTransform(canvas.width / 680, 0, 0, canvas.height / 400, 0, 0);
  c.fillStyle = '#192f3a';
  c.fillRect(0, 0, 680, 400);
  const k = 121,
    ox = 49,
    oy = 30,
    P = (p) => ({ x: ox + p.x * k, y: oy + p.y * k });
  c.strokeStyle = '#567380';
  c.lineWidth = 2;
  c.strokeRect(ox, oy, 4.8 * k, 3 * k);
  const goal = P({ x: 3.9, y: 1.5 });
  c.strokeStyle = '#e6c47a';
  c.setLineDash([5, 5]);
  c.beginPath();
  c.arc(goal.x, goal.y, 0.22 * k, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([]);
  c.fillStyle = '#e6c47a';
  c.font = '16px system-ui';
  c.fillText('届け先', goal.x - 25, goal.y - 37);
  if (options.runs) {
    options.runs.forEach((run, i) => {
      const q = P(run.trace[0]);
      c.fillStyle = run.success ? '#88d6bd' : '#edb47a';
      c.beginPath();
      c.arc(q.x, q.y, i === options.selected ? 8 : 4, 0, Math.PI * 2);
      c.fill();
    });
  }
  c.strokeStyle = '#8bd7c0';
  c.lineWidth = 3;
  c.beginPath();
  trace.forEach((p, i) => {
    const q = P(p);
    i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y);
  });
  c.stroke();
  if (trace.length) {
    const p = trace.at(-1);
    drawRobot(c, P(p), { left: 0, right: 0, ...p });
    const start = P(trace[0]);
    c.strokeStyle = '#bdced2';
    c.beginPath();
    c.arc(start.x, start.y, 5, 0, Math.PI * 2);
    c.stroke();
  }
}
function mapCanvas(label) {
  $('rlFigure').innerHTML = `<canvas id="rlRobotMap" role="img" aria-label="${label}"></canvas>`;
}
function initRLCurriculum(openLab) {
  onLab = openLab;
  $('rlGroups').innerHTML = GROUPS.map(
    (name, i) =>
      `<button data-rl-group="${i}" aria-pressed="${i === 0}"><span>${i + 1}</span>${name}</button>`,
  ).join('');
  all('[data-rl-group]').forEach(
    (b) => (b.onclick = () => select(TOPICS.find((t) => t[2] === Number(b.dataset.rlGroup))[0])),
  );
  $('rlNext').onclick = () => {
    const i = TOPICS.findIndex((t) => t[0] === topic);
    if (i < TOPICS.length - 1) select(TOPICS[i + 1][0], true);
  };
  new ResizeObserver(() => paint()).observe($('rlFigure'));
  document.addEventListener('rl-foundations', () => select('experience', true));
  select('experience');
}
function select(next, scroll = false) {
  if (busy) return;
  topic = next;
  document.dispatchEvent(new CustomEvent('rl-topic-change', { detail: { topic } }));
  const index = TOPICS.findIndex((t) => t[0] === topic),
    group = TOPICS[index][2];
  all('[data-rl-group]').forEach((b) =>
    b.setAttribute('aria-pressed', Number(b.dataset.rlGroup) === group),
  );
  $('rlTopics').innerHTML = TOPICS.filter((t) => t[2] === group)
    .map((t) => `<button data-rl-topic="${t[0]}" aria-pressed="${t[0] === topic}">${t[1]}</button>`)
    .join('');
  all('[data-rl-topic]').forEach((b) => (b.onclick = () => select(b.dataset.rlTopic)));
  const course = group === 3;
  $('rlBasicsPanel').hidden = course;
  $('labPage').hidden = !course;
  if (course) {
    onLab?.(topic);
    if (scroll) $('rlGroups').scrollIntoView({ block: 'start' });
    return;
  }
  $('rlLessonBrief').innerHTML = lessonGuide('rl-' + topic);
  $('rlFigureGuide').innerHTML = figureGuide('rl-' + topic);
  $('rlRewardFigureGuide').innerHTML = figureGuide('rl-reward');
  $('rlRewardLesson').hidden = topic !== 'reward';
  $('rlFoundationLesson').hidden = topic === 'reward';
  $('rlNext').textContent = '次へ：' + TOPICS[index + 1][1] + ' →';
  $('rlSummary').textContent = [
    '一つの経験は「動く前の情報・選んだ行動・結果・報酬」の組です。',
    '経験を使うことと、新しい経験を集めることの両方が必要です。',
    '先でもらう報酬も考えると、すぐには点数が付かない行動にも意味が生まれます。',
    '欲しい動きと、点数を増やせる動きが一致しているかを確かめます。',
    '学習していない条件でも、動きの選び方を変えずに確かめるのがテストです。',
    '実機での成功を保証する実験ではありません。条件の違いを調べる準備をします。',
  ][index];
  if (topic === 'experience') showExperience();
  if (topic === 'explore') showExplore();
  if (topic === 'future') showFuture();
  if (topic === 'test') showTest();
  if (topic === 'transfer') showTransfer();
  if (scroll) $('rlGroups').scrollIntoView({ block: 'start' });
}
function reviewRL(id) {
  if (busy || !TOPICS.some((t) => t[0] === id)) return false;
  $('introPage').hidden = false;
  select(id);
  return true;
}
function showExperience() {
  scaffold(
    '動いた結果を、次の選び方に使う',
    '最初は、1回の動きをゆっくり確かめる',
    `<p class="eyebrow">実験 · 届け先へ近づける</p><h2>一つ動かして、点数を見る</h2><p>下のボタンから一つの動きを選びます。動く前後の距離と点数は、図の下に残ります。「出発点に戻す」は位置だけを戻し、学習した記録は残します。</p><div class="rl-action-buttons">${ACTION_LABELS.map((a, i) => button('rlAction' + i, a)).join('')}</div>${button('rlAuto', 'ロボットに1回選ばせる', true)}${button('rlRestart', '出発点に戻す')}<p class="helper">ロボットは最初、動きをランダムに選びます。経験が増えると見積もりを使い、ときどき別の動きも試します。1回動くと、表示は止まります。</p>${details('なぜ点数で学べる？', '例えば「届け先が右前にある」とき、前進・左回転・右回転のどれがよいかを数で記録します。動いた後に受け取った報酬と、その先で得られそうな報酬を使い、選んだ行動の数字を少し直します。同じような状況で次に動くとき、その数字を比べます。この実験では、この表を更新するQ学習という方法を使います。')}${details('ロボットが見ている情報', 'この基礎実験で使う情報は、届け先までの距離と、機体の正面から見た方向です。距離は50 cmごと、方向は約11°ごとに区切り、同じ区切りを同じ状況として扱います。この2つの情報は正確に分かるものとしています。画像や、レーザーで測った周囲の距離から届け先を探す処理は省略しています。総合実験では、センサー情報も使って左右の車輪の回転数を決めます。')}${button('rlForget', '学んだ記録も消してやり直す')}`,
  );
  mapCanvas('一回ずつ動かすロボットと届け先。青いレンズ側が機体の正面');
  paint = () => robotMap('rlRobotMap', oneTrace);
  paint();
  const reading = robotReading(onePose);
  metrics([
    ['目印までの距離', format(reading.distance, 2) + ' m'],
    [
      '機体から見た方向',
      Math.abs(reading.bearing) < 0.02
        ? '正面'
        : (reading.bearing > 0 ? '右 ' : '左 ') +
          format((Math.abs(reading.bearing) * 180) / Math.PI, 0) +
          '°',
    ],
  ]);
  if (oneEvent) {
    const e = oneEvent,
      old = robotReading(e.from),
      now = robotReading(e.state);
    $('rlFigureStep').textContent =
      '今回の報酬 ' + signed(e.reward, 2) + '点 · ' + ACTION_LABELS[e.action];
    explanation(
      '今回の経験',
      `距離 ${format(old.distance, 3)} m → <strong>${ACTION_LABELS[e.action]}</strong> → 距離 ${format(now.distance, 3)} m → <strong>${signed(e.reward, 2)}点</strong>。${Math.abs(old.distance - now.distance) < 0.0001 ? '距離は変わりませんでした。' : format(Math.abs(old.distance - now.distance) * 100, 1) + ' cm' + (old.distance > now.distance ? '近づきました。' : '遠ざかりました。')}この状況での行動の見積もりは ${format(e.change.before, 2)} から ${format(e.change.after, 2)} に変わりました。`,
    );
    $('rlExtra').innerHTML =
      `<details><summary>車輪の動きと、更新した見積もりを見る</summary><p>左右の車輪：${format(now.rpm[0], 0)} / ${format(now.rpm[1], 0)} rpm。回る速さを変えて向きを変えます。</p>${chart(
        ACTION_LABELS.map((name, i) => [
          name,
          e.after[i],
          i === e.action ? '今回更新した行動' : '今回は変更なし',
        ]),
        Math.max(1, ...e.after),
      )}<p class="helper">数字は、今回動く前の状況で、それぞれの行動から先に得られそうな点数の見積もりです。最初はすべて0で、経験した行動の値を更新します。受け取った今回の報酬とは別の値です。棒の長さと右の数値で、行動ごとの見積もりを比べてください。</p></details>`;
    status(
      e.done
        ? e.success
          ? '到着しました。出発点に戻し、学んだ選び方も試しましょう。'
          : '壁に接触して、この走行を終了しました。「出発点に戻す」で次の走行を始めます。'
        : '結果を読んでから、次の動きを選べます。回るだけでは近づかなくても、次に進むための準備になります。',
    );
  } else
    status(
      '届け先は、今の機体の右側です。向きを変えてから前進すると、点数はどう変わるでしょうか。',
    );
  for (let i = 0; i < 3; i++) $('rlAction' + i).onclick = () => act(i);
  $('rlAuto').onclick = () => act(oneModel.choose(onePose, 0.2));
  const done = !!oneEvent?.done;
  for (const id of ['rlAuto', 'rlAction0', 'rlAction1', 'rlAction2']) $(id).disabled = done;
  $('rlRestart').onclick = () => {
    onePose = { ...INTRO_START };
    oneTrace = [onePose];
    oneEvent = null;
    showExperience();
    status(
      '位置だけを戻しました。学んだ記録は残り、次の行動の結果も学習に使います。見積もりを固定したテストは、後の章で扱います。',
    );
  };
  $('rlForget').onclick = () => {
    oneModel = new IntroLearner('approach', introRandom(5));
    onePose = { ...INTRO_START };
    oneTrace = [onePose];
    oneEvent = null;
    showExperience();
  };
  question(
    '点数は、モーターへの命令？',
    '点数だけでその場の車輪が回るわけではありません。行動の結果を評価する数値が報酬で、そこから行動の選び方を更新します。',
    '状況に応じて行動を選ぶ決め方を、方策と呼びます。「ロボットに1回選ばせる」では、80%の確率で今の見積もりが最も高い行動を選び、20%の確率で3つからランダムに選びます。ランダムでも同じ行動を選ぶことはあります。最初は見積もりがすべて同点なので、行動もランダムになります。',
  );
}
function act(action) {
  oneEvent = experienceStep(oneModel, onePose, action);
  onePose = oneEvent.state;
  oneTrace.push(onePose);
  if (oneTrace.length > 200) oneTrace.shift();
  showExperience();
}
function lessonIcon(kind) {
  const parcel =
    '<path d="M22 24L36 17L50 24V44L36 51L22 44Z" fill="#f4d8a3" stroke="#ac7a30" stroke-width="2"/><path d="M22 24L36 31L50 24M36 31V51M29 20L43 27" fill="none" stroke="#ac7a30" stroke-width="2"/>';
  const art =
    kind === 'parcel'
      ? parcel
      : kind === 'road'
        ? '<path d="M18 8V58M54 8V58" stroke="#9eb4bd" stroke-width="3"/><path d="M36 8V15M36 51V58" stroke="#9eb4bd" stroke-width="2"/><rect x="25" y="22" width="22" height="23" rx="7" fill="#b6d7d4" stroke="#39776e" stroke-width="2"/><circle cx="36" cy="29" r="4" fill="#477dac"/><path d="M31 17L36 12L41 17" fill="none" stroke="#39776e" stroke-width="2"/>'
        : kind === 'goal'
          ? '<path d="M23 55V10L53 10L46 22L53 34H23" fill="#e6f1ed" stroke="#39776e" stroke-width="2"/><path d="M31 21L36 26L44 17" fill="none" stroke="#39776e" stroke-width="3"/><path d="M15 56H37" stroke="#39776e" stroke-width="2"/>'
          : '<rect x="12" y="22" width="7" height="30" rx="3" fill="#294a57"/><rect x="53" y="22" width="7" height="30" rx="3" fill="#294a57"/><rect x="20" y="17" width="32" height="38" rx="10" fill="#c9dcde" stroke="#7299a4" stroke-width="2"/><rect x="26" y="14" width="20" height="9" rx="4" fill="#244c65"/><circle cx="31" cy="18" r="2.5" fill="#b7e6ff"/><circle cx="41" cy="18" r="2.5" fill="#b7e6ff"/><circle cx="36" cy="36" r="8" fill="#274b50" stroke="#80d5c2" stroke-width="3"/>';
  return `<svg viewBox="0 0 72 66" aria-hidden="true" focusable="false">${art}</svg>`;
}
function showExplore() {
  scaffold(
    '試していない配達先に、もっと高い点があるかも？',
    '経験を使うことと、新しく試すこと',
    `<h2>配達先の選び方を変える</h2><label class="vision-select">どう選ばせる？<select id="rlExploreRate"><option value="0">平均点が高い先だけを選ぶ</option><option value="0.3">ときどきランダムにも試す</option><option value="1">毎回ランダムに選ぶ</option></select></label><div id="rlChoiceMix" class="rl-choice-mix"></div>${button('rlTryTen', '10回配達させる', true)}<p id="rlExploreNext" class="rl-next-instruction"></p><div class="rl-secondary-actions">${button('rlTryOne', '1回だけ試す')}${button('rlRouteReset', '記録を消してやり直す')}</div><details data-help-dialog><summary>選び方と点数のルール</summary><p>ロボットは、選んだ配達先で得た点数の平均を記録します。「平均点が高い先だけ」では、その平均を比べて選びます。未経験の先は計算上0点、同点ならAから選ぶ設定です。</p><p>「ときどきランダム」では30%の確率でA・B・Cからランダムに選び、残りの70%は今の平均点を使います。必ず10回中3回になるわけではなく、ランダムでもいつもと同じ先を選ぶことがあります。「毎回ランダム」では、平均を記録しても選択には使いません。</p><p>10回は見比べるための区切りです。この実験では、配達先を選ぶことを一つの行動として扱い、経路の運転は省略しています。</p></details>`,
  );
  $('rlQuestion').hidden = true;
  const render = () => {
    const best = routes.history.length ? routes.values.indexOf(Math.max(...routes.values)) : -1;
    $('rlFigure').innerHTML =
      `<div class="rl-destination-board"><p class="rl-board-caption">配達すると点数が分かり、カードの平均が更新されます。</p><div class="rl-destination-cards">${routes.values.map((value, i) => `<article class="rl-destination ${best === i ? 'is-best' : ''}"><header><span class="rl-destination-letter">${'ABC'[i]}</span><span>配達先 ${'ABC'[i]}</span></header>${lessonIcon('parcel')}<span class="rl-score-label">${routes.counts[i] ? 'もらった点数の平均' : 'まだ試していません'}</span><strong class="rl-destination-score">${routes.counts[i] ? `${format(value)}<small>点</small>` : '？'}</strong><div class="rl-destination-bar"><i style="width:${(value / 4) * 100}%"></i></div><span class="rl-destination-count">${routes.counts[i]}回の経験</span></article>`).join('')}</div><div class="rl-batch"><h3>${routeBatch.length ? `今回の${routeBatch.length}回で選んだ先と点数` : '配達の記録'}</h3>${routeBatch.length ? `<ol class="rl-batch-record">${routeBatch.map((e) => `<li class="${e.exploring ? 'is-exploring' : ''}" aria-label="配達先${'ABC'[e.action]}、${e.reward}点、${e.exploring ? 'ランダムに選んだ' : '平均点で選んだ'}"><b>${'ABC'[e.action]}</b><span>${e.reward}点</span>${e.exploring ? '<i aria-hidden="true">＊</i>' : ''}</li>`).join('')}</ol><p class="rl-record-key">＊ ランダムに選んだ回</p>` : '<p>試すと、ここに結果が残ります。</p>'}</div></div>`;
    metrics([
      ['配達した回数', routes.history.length + '回'],
      ['今の記録から選ぶなら', best < 0 ? 'まだ分かりません' : `配達先 ${'ABC'[best]}`],
    ]);
    const unknown = routes.counts.map((n, i) => (n ? null : 'ABC'[i])).filter(Boolean);
    status(
      !routes.history.length
        ? 'どこがよい配達先かは、まだ分かりません。まず用意された選び方で試します。'
        : unknown.length
          ? `${unknown.join('・')}はまだ試していないので、点数が分かりません。今の記録だけで選び続けると、ほかの配達先のよさを見落とすかもしれません。`
          : `3か所の平均点を比べられるようになりました。経験の少ない方法も試して調べることを「探索」といいます。`,
    );
    $('rlExploreRate').value = String(exploration);
    $('rlChoiceMix').innerHTML =
      `<div class="rl-mix-bar" aria-hidden="true"><i style="width:${(1 - exploration) * 100}%"></i><i style="width:${exploration * 100}%"></i></div><p>平均点で選ぶ ${Math.round((1 - exploration) * 100)}% <span>ランダム ${Math.round(exploration * 100)}%</span></p>`;
    $('rlExploreNext').textContent = !routes.history.length
      ? 'まずこのまま10回試し、どの配達先が選ばれるかを見てください。'
      : exploration === 0
        ? '次は「ときどきランダムにも試す」に変えて、もう10回。記録はそのまま使います。'
        : exploration === 1
          ? '毎回ランダムに選んでいます。平均点を使う選び方とも比べてみましょう。'
          : unknown.length
            ? 'まだ試していない先があります。もう10回試すと、記録は増えるでしょうか。'
            : '回数が少ない先の平均は、次の配達で変わることがあります。もう10回試して確かめられます。';
    $('rlExtra').innerHTML =
      `<details data-help-dialog><summary>1回の点数だけで判断してよい？</summary><p>同じ配達先でも点数が変わる場合は、何回か試して平均を比べます。探索を増やすと新しい情報を集められますが、今すぐの合計点が必ず増えるとは限りません。</p><p>この実験の設定は、Aが毎回1点、Bが75%の確率で4点・残りは0点、Cが毎回2点です。Bを長く試した平均は3点に近づきますが、少ない回数では偶然に左右されます。このルールはロボットに教えず、経験から平均を更新させています。</p><p>これまでに受け取った合計：${routes.history.reduce((s, e) => s + e.reward, 0)}点。</p></details>`;
  };
  $('rlExploreRate').onchange = () => {
    exploration = Number($('rlExploreRate').value);
    render();
  };
  const tryDeliveries = (count) => {
    routeBatch = [];
    for (let i = 0; i < count; i++) routeBatch.push(routes.step(exploration));
    render();
  };
  $('rlTryTen').onclick = () => tryDeliveries(10);
  $('rlTryOne').onclick = () => tryDeliveries(1);
  $('rlRouteReset').onclick = () => {
    routes = new RouteLearner();
    routeBatch = [];
    render();
  };
  render();
}
function showFuture() {
  scaffold(
    '最後にもらえる8点を考えると、選び方は変わる？',
    '同じ仕事を、2つの学び方で比べる',
    `<h2>2つの学び方で試す</h2><p>仕事と点数のルールは同じです。「すぐ後の点だけ」と「その先の点も含める」で、選び方が変わるか比べます。</p>${button('rlFutureTrain', '学習させて比べる', true)}<p class="rl-next-instruction">1回押すと、それぞれ30回試します。結果は表示したまま残ります。</p><div class="rl-secondary-actions">${button('rlFutureOne', '1回ずつ学習させる')}${button('rlFutureReset', '両方の記録を消してやり直す')}</div><details data-help-dialog><summary>途中の行動にも意味があるのはなぜ？</summary><p>荷物を受け取っても、その直後は0点です。それでも、受け取らなければ最後の8点にはつながりません。先の報酬も使う学習では、配達を完了した経験を重ねて、途中の行動から得られそうな点の見積もりも更新します。</p><p>最初の実験で向きを変えたときも、その場では届け先へ近づかなくても、次の前進に必要な準備になりました。同じように、結果に至るまでの行動を考えるための仕組みです。</p></details>`,
  );
  $('rlQuestion').hidden = true;
  const render = () => {
    const trained = future.episodes > 0;
    const choice = (model) => (model.policy() === 'delivery' ? '配達に出る' : '近くへ運ぶ');
    const choiceCard = (model, title) =>
      `<article class="rl-learning-result ${model.gamma ? 'looks-ahead' : ''}" data-future-gamma="${model.gamma}"><h3>${title}</h3><div class="rl-result-choice">${lessonIcon(trained && model.policy() === 'delivery' ? 'goal' : 'robot')}<div><span>今の学習結果で選ぶなら</span><strong>${trained ? choice(model) : 'まだ学習していません'}</strong></div></div></article>`;
    $('rlFigure').innerHTML =
      `<div class="rl-future-board"><h3 class="rl-board-caption">出発するときに、どちらの仕事を選ぶ？</h3><div class="rl-work-options"><div class="rl-quick-job">${lessonIcon('parcel')}<strong>近くへ運ぶ</strong><span class="rl-reward-pill">1点で終了</span></div><div class="rl-long-job"><strong>配達に出る</strong><ol class="rl-job-stages"><li>${lessonIcon('parcel')}<span>荷物を受け取る</span><b>0点</b></li><li>${lessonIcon('road')}<span>通路を進む</span><b>0点</b></li><li>${lessonIcon('goal')}<span>届ける</span><b class="rl-reward-pill">8点で終了</b></li></ol></div></div><div class="rl-results-heading"><h3>学習した選び方</h3><span>${trained ? `それぞれ${future.episodes}回の経験` : '両方とも、経験0回から開始'}</span></div><div class="rl-learning-results">${choiceCard(futureImmediate, 'すぐ後の点だけで学ぶ')}${choiceCard(future, 'その先の点も含めて学ぶ')}</div></div>`;
    metrics([]);
    status(
      !trained
        ? 'まず「学習させて比べる」を押します。2つの選び方がどう変わるか、結果を見てください。'
        : future.policy() === 'delivery'
          ? 'すぐ後の点だけを見ると、1点の「近くへ運ぶ」を選びます。先の点も含めると、最初は0点でも最後に8点をもらう「配達に出る」を選ぶようになりました。'
          : 'まだ両方とも「近くへ運ぶ」を選んでいます。経験が少なく、最後の8点が出発時の判断に十分反映されていません。もう一度学習させて比べてください。',
    );
    $('rlExtra').innerHTML =
      `<details data-help-dialog><summary>学習で変わった数字を調べる</summary><p>下の数字は「この行動から先に得られそうな点」の見積もりです。今回受け取った点数とは別で、経験から少しずつ更新します。</p><div class="rl-table-wrap"><table><thead><tr><th>行動</th><th>すぐ後だけ</th><th>その先も含める</th></tr></thead><tbody>${[
        ['出発点 → 近くへ運ぶ', 0, 0],
        ['出発点 → 配達に出る', 0, 1],
        ['通路を進む', 1, 0],
        ['届ける', 2, 0],
      ]
        .map(
          ([name, s, a]) =>
            `<tr><th>${name}</th><td>${format(futureImmediate.q[s][a], 2)}</td><td>${format(future.q[s][a], 2)}</td></tr>`,
        )
        .join(
          '',
        )}</tbody></table></div><p>「その先も含める」は、今回の点数に、次の状況の見積もりを0.9倍して加えた値へ、今の見積もりを40%近づけます。学習を重ねると、出発時の配達の見積もりは8×0.9²＝6.48に近づきます。「すぐ後だけ」では先の見積もりを加えないので、配達を始める行動の見積もりは0のままです。</p><p>2つとも同じ回数・同じ仕事で学びますが、学んだ選び方が変わると経験する仕事も変わります。途中の作業順は固定し、出発時の2択を学びます。経路の運転を学ぶ実験ではありません。</p></details>`;
  };
  const learn = (count) => {
    futureImmediate.train(count);
    future.train(count);
    render();
  };
  $('rlFutureTrain').onclick = () => learn(30);
  $('rlFutureOne').onclick = () => learn(1);
  $('rlFutureReset').onclick = () => {
    futureImmediate = new FutureLearner(0);
    future = new FutureLearner(0.9);
    render();
  };
  render();
}
async function trainModel(mode, vary, onComplete) {
  if (busy) return;
  busy = true;
  all('[data-rl-group],[data-rl-topic],#rlControls button,#rlControls select,#rlNext').forEach(
    (b) => (b.disabled = true),
  );
  const model = newTrainingModel(mode, vary);
  try {
    for (let i = 0; i < 10; i++) {
      model.train(80);
      status(`${model.episodes}回の走行で経験を集めています。表示は学習後にまとめて確認できます。`);
      await new Promise((r) => setTimeout(r, 0));
    }
    onComplete(model);
  } finally {
    busy = false;
    all('[data-rl-group],[data-rl-topic],#rlNext').forEach((b) => (b.disabled = false));
    if (topic === 'test') showTest();
    else if (topic === 'transfer') showTransfer();
  }
}
function resultMetrics(result) {
  return [
    ['到着', `${result.successes} / 20回`],
    ['接触', `${result.contacts} / 20回`],
    [
      '到着できた走行の平均時間',
      result.meanTime === null ? '到着なし' : format(result.meanTime) + '秒',
    ],
  ];
}
function recordTable(old, result) {
  if (!old) return '';
  return `<div class="rl-table-wrap"><table><caption>同じ20か所で比較</caption><thead><tr><th>条件</th><th>到着</th><th>接触</th><th>到着した走行の平均時間</th></tr></thead><tbody>${[old, result].map((r) => `<tr><th>${r.label}</th><td>${r.successes}/20</td><td>${r.contacts}/20</td><td>${r.meanTime === null ? '—' : format(r.meanTime) + '秒'}</td></tr>`).join('')}</tbody></table></div>`;
}
function showTest() {
  scaffold(
    '出発場所が変わっても、届け先へ着ける？',
    '学習で選び方を更新し、テストでは固定する',
    `<p class="eyebrow">実験 · 学習とテストを分ける</p><h2>学ぶ範囲を変えて比べる</h2><p>まず、学習を始める位置と向きを選びます。学習後に残る行動の見積もりの表を、ここでは学習済みモデルと呼びます。テストではこの表を固定し、学習用とは別の20か所から走らせます。設定を変えたら、学習するボタンとテストするボタンを順に押してください。</p><label class="vision-select">学習の開始位置<select id="rlTrainMode"><option value="fixed">毎回、同じ位置・向き</option><option value="varied">毎回、異なる位置・向き</option></select></label>${button('rlTrainModel', 'この条件で800回学習する', true)}${button('rlTestModel', '学習済みの動きを20か所でテスト')}<p class="helper">800回は比較用にそろえた学習量で、成功を保証する回数ではありません。前の結果と同じ20か所で比べます。テストは1走行20秒までです。</p>${details('学習とテストで変わること', '学習中は、今の見積もりで選ぶ動きに加えて別の動きも試し、結果から表を更新します。テストでは表を更新せず、最も高い行動を選びます。同点ならランダムに選びます。「学習する」をもう一度押すと、以前の表へ経験を足すのではなく、0から800回学び直します。テスト結果は追加学習に使いません。')}${details('学んでいない位置でも成功する理由', 'この例の入力は、届け先への距離と方向です。出発点が違っても、似た距離・方向を経験していれば進めることがあります。同じ位置で学習すると必ず失敗する、という意味ではありません。')}`,
  );
  $('rlTrainMode').value = testMode;
  $('rlTrainMode').onchange = () => {
    testMode = $('rlTrainMode').value;
    status('次に学ぶ条件を変更しました。現在の学習済みモデルと結果は、学び直すまで変わりません。');
  };
  $('rlTrainModel').onclick = () =>
    trainModel(testMode, false, (m) => {
      if (testResult) testOld = testResult;
      testModel = m;
      testResult = null;
    });
  $('rlTestModel').disabled = !testModel;
  $('rlTestModel').onclick = () => {
    testResult = {
      ...evaluateLearner(testModel, starts),
      label: testModel.options.startMode === 'fixed' ? '同じ場所で学習' : '異なる場所で学習',
    };
    testIndex = 0;
    showTest();
  };
  mapCanvas('テストの開始位置と、選んだ1回の走行軌跡');
  if (testResult) {
    const run = testResult.runs[testIndex];
    paint = () => robotMap('rlRobotMap', run.trace, { runs: testResult.runs, selected: testIndex });
    metrics(resultMetrics(testResult));
    explanation(
      `表示中：テスト ${testIndex + 1} / 20`,
      `${run.success ? '到着' : run.hit ? '接触で終了' : '時間切れ'}・${format(run.time)}秒。線はこの1回の全走行です。背景の点は20回の開始位置で、緑は到着、橙は未到着を表します。`,
    );
    $('rlExtra').innerHTML =
      `<label class="vision-select">確認する走行<select id="rlTrial">${testResult.runs.map((r, i) => `<option value="${i}" ${i === testIndex ? 'selected' : ''}>${i + 1}回目 · ${r.success ? '到着' : r.hit ? '接触' : '時間切れ'}</option>`).join('')}</select></label>${recordTable(testOld, testResult)}`;
    $('rlTrial').onchange = () => {
      testIndex = Number($('rlTrial').value);
      showTest();
    };
    const familiar = introRollout(testModel);
    status(
      testOld && testOld.label !== testResult.label && testOld.successes === testResult.successes
        ? `今回の20か所では、開始位置の条件を変えても到着回数は同じでした。この例では距離と方向が似た経験を別の場所でも使えます。総合実験では障害物のあるコースでも確かめましょう。`
        : `基準の出発点では${familiar.success ? '到着' : '未到着'}。別の20か所では${testResult.successes}回到着しました。開始位置を変え、同じ走行回数で比べましょう。`,
    );
  } else {
    paint = () => robotMap('rlRobotMap', [INTRO_START]);
    metrics([
      [
        '学習済みモデル',
        testModel
          ? `${testModel.episodes}回 · ${testModel.options.startMode === 'fixed' ? '同じ場所' : '異なる場所'}`
          : 'まだありません',
      ],
      ['テスト', '未実行'],
    ]);
    status(
      testModel
        ? '学習を終えました。次に「20か所でテスト」で結果を確かめます。'
        : 'まず条件を決めて学習します。テストの走行はまだ行っていません。',
    );
  }
  paint();
  question(
    '到着率が同じなら、改善していない？',
    '接触の回数や到着までの時間も比べます。ただし、到着できた走行だけの平均時間は、成功回数が違うと単純には比べられません。',
    '報酬の値を変えると合計点の基準も変わります。条件どうしは、到着・接触・時間という共通の指標で比べ、一度に変える条件を一つにします。総合実験では、新しい開始位置でも再確認できます。',
  );
}
function showTransfer() {
  scaffold(
    '車輪が滑っても、届け先へ着ける？',
    '学習した選び方を固定し、動く環境だけを変える',
    `<p class="eyebrow">実験 · 実機へ移す前の確認</p><h2>左右の動きの違いを試す</h2><p>まず左右が同じように動く環境で学習します。その後、学んだ選び方を固定し、左車輪だけが滑って進みにくい状況を試します。同じ20か所で、通常の車輪と変更後の車輪を比べます。</p>${button('rlTransferTrain', '通常の車輪で学習する', !transferModel)}<label class="basics-slider" for="rlWheelGain"><span>左車輪の実際の移動量<output id="rlWheelGainValue">${Math.round(transferGain * 100)}%</output></span><input id="rlWheelGain" type="range" min="40" max="120" step="10" value="${Math.round(transferGain * 100)}"></label>${button('rlTransferTest', '同じモデルで通常・変更後をテスト', true)}${button('rlTransferRetrain', '車輪のばらつきを含めて学び直す')}<p class="helper">100%が通常。70%なら同じ回転指令でも左側は7割だけ進みます。右側は100%です。</p>${details('学び直すと、必ずよくなる？', '「ばらつきを含めて学び直す」は、左右それぞれの移動量を走行ごとに65〜115%の範囲で変え、0から学習をやり直します。違う車輪条件を経験させるためです。完了したらテストのボタンをもう一度押し、左車輪の設定を同じ値にして前後を比べます。経験を広げても、必ず改善するとは限りません。')}${details('この実験で再現している範囲', 'この章では車輪の移動量の倍率だけを変えています。センサーの遅延・欠測、床の段差、通信、衝撃は再現していません。総合実験の物理モデルにも制限があり、実機での検証が必要です。')}`,
  );
  $('rlWheelGain').oninput = () => {
    transferGain = Number($('rlWheelGain').value) / 100;
    $('rlWheelGainValue').textContent = Math.round(transferGain * 100) + '%';
    status('次のテスト条件を変えました。表示中の結果は再テストするまで変わりません。');
  };
  $('rlTransferTrain').onclick = () =>
    trainModel('varied', false, (m) => {
      transferModel = m;
      transferVary = false;
      transferResult = null;
      transferOld = null;
    });
  $('rlTransferRetrain').disabled = !transferModel;
  $('rlTransferRetrain').onclick = () =>
    trainModel('varied', true, (m) => {
      transferOld = transferResult;
      transferModel = m;
      transferVary = true;
      transferResult = null;
    });
  $('rlTransferTest').disabled = !transferModel;
  $('rlTransferTest').onclick = () => {
    const normal = evaluateLearner(transferModel, starts),
      changed = evaluateLearner(transferModel, starts, { leftGain: transferGain, rightGain: 1 });
    transferResult = {
      normal,
      changed,
      gain: transferGain,
      label: transferVary ? 'ばらつきを含めて学習' : '通常の車輪で学習',
    };
    showTransfer();
  };
  if (transferResult) {
    const r = transferResult;
    $('rlFigure').innerHTML =
      `<div class="rl-transfer-plots"><figure><figcaption>通常の車輪 · 左右100%</figcaption><canvas id="rlNormalMap" role="img" aria-label="通常の車輪でのテスト1の軌跡"></canvas></figure><figure><figcaption>変更後 · 左${Math.round(r.gain * 100)}%</figcaption><canvas id="rlChangedMap" role="img" aria-label="左車輪の移動量を変えたテスト1の軌跡"></canvas></figure></div>`;
    paint = () => {
      robotMap('rlNormalMap', r.normal.runs[0].trace);
      robotMap('rlChangedMap', r.changed.runs[0].trace);
    };
    paint();
    metrics(resultMetrics(r.changed));
    explanation(
      '上の図は同じ開始位置の1回目。集計は20回分です。',
      `学習条件：${r.label}。2枚の図は、学んだ選び方を固定して同じ場所から走らせた記録です。下の「到着・接触・平均時間」は変更後の車輪での20回分、表には通常の車輪での20回分も載せています。`,
    );
    $('rlExtra').innerHTML =
      recordTable({ ...r.normal, label: '通常の車輪' }, { ...r.changed, label: '変更後の車輪' }) +
      (transferOld && transferOld.gain === r.gain
        ? recordTable(
            { ...transferOld.changed, label: '学び直す前' },
            { ...r.changed, label: '学び直した後' },
          )
        : '');
    status(
      transferOld &&
        transferOld.gain === r.gain &&
        transferOld.changed.successes === r.changed.successes &&
        r.changed.meanTime > transferOld.changed.meanTime + 0.1
        ? `今回は、ばらつきを含めて学び直しても到着回数は同じで、時間は長くなりました。条件を広げるだけでは改善を保証できません。学習量や条件の幅も検討します。`
        : `通常は${r.normal.successes}/20回、変更後は${r.changed.successes}/20回到着しました。到着までの時間や軌跡も見比べます。`,
    );
  } else {
    mapCanvas('通常の車輪で学習を始める出発点');
    paint = () => robotMap('rlRobotMap', [INTRO_START]);
    paint();
    metrics([
      [
        '学習済みモデル',
        transferModel ? (transferVary ? '車輪のばらつきあり' : '通常の車輪') : 'まだありません',
      ],
      ['通常・変更後の比較', '未実行'],
    ]);
    status(
      transferModel
        ? '学習済みです。移動量を決めて、通常と変更後の両方をテストします。'
        : '先に「通常の車輪で学習する」を押してください。実機へ命令を送る実験ではありません。',
    );
  }
  question(
    '接触を減点すれば、実機でも安全？',
    '報酬は、危険な動きを選ばない保証にはなりません。学んだ方策とは別に、速度制限・衝撃での停止・通信が途切れたときの停止を用意します。',
    '実機では、センサーの単位・向き・周期と左右の回転数を確認し、低速・限られた区画で測定します。一度の成功で判断せず、開始位置や床条件を変えて検証します。',
  );
  $('rlExtra').innerHTML += details(
    'ROS 2で検証する順序',
    '①車輪の符号と回転数、IMU、LiDAR、RGB-Dカメラの目印と奥行きを個別に確認。②学習時と同じ単位・順序で観測を作る。③まずモーターを動かさず指令値を記録。④独立した停止手段を用意し、低速で限定したコースから比較。総合実験で保存できる方策JSONは実機用制御ソフトではなく、センサー処理や停止機能の実装が別途必要です。',
  );
}

export { initRLCurriculum, reviewRL };
