import { lessonLabel } from '../shell/lesson-ui.js';
import { schoolTips } from '../shell/school-tips.js';
import { lessonBrief } from '../shell/lesson-brief.js';
import {
  LAUNCH_SPEC,
  LAUNCH_TOPICS,
  LAUNCH_TARGETS,
  launchExperiment,
  launchEstimate,
  launchParseCSV,
  launchCSV,
} from './core.js';
import { drawLaunch, launchMechanism, drawLaunchRobot, launchChart } from './render.js';

const $ = (id) => document.getElementById(id),
  fmt = (n, d = 1) => Number(n).toFixed(d);
const states = new Map(
  LAUNCH_TOPICS.map((t) => [
    t.id,
    { power: 40, run: null, index: 0, observed: 0, complete: false, records: [] },
  ]),
);
const COPY = {
  power: {
    title: '出力を変えると、どこまで飛ぶ？',
    scene:
      '狙った場所へディスクを飛ばすには、モーターの出力をどれくらいにすればよいでしょうか。このロボットは、回転する円筒形の部品「ローラ」の摩擦で、ディスクを押し出します。',
    purpose:
      '機体を止めたまま出力を変え、射出口の真下から最初に床へ触れた位置までの距離（飛距離）を比べます。',
    first:
      'まず40%で1枚飛ばしてください。次に出力を60%に変えてもう1枚飛ばし、下のグラフで飛距離がどう変わったか比べます。',
  },
  forces: {
    title: '空気の力で、届く位置はどう変わる？',
    scene:
      'ディスクを狙った場所へ届けるには、飛び出す速さだけでなく、飛行中に落ち方や速さが変わることも考えます。地球が下へ引く重力に加え、空気からは進む向きと反対の空気抵抗と、進む向きに直角の揚力を受けます。この条件では揚力が落下を緩めます。',
    purpose:
      '同じ速さで飛び出す2つの計算で、空気の力がある場合とない場合の接地点と飛行時間を比べます。',
    first:
      'まず40%で1枚飛ばし、途中で一時停止してください。赤い重力、紫の空気抵抗、緑の揚力の矢印を比べます。次に最後まで見て、空気の力を含む緑の軌跡と、重力だけの黄色の破線の接地点を比べてください。飛んでいた時間は結果欄で確認できます。',
  },
  target: {
    title: '記録を使って、3つの的に届けよう',
    scene:
      '正面の的へディスクを届けます。弱すぎる出力では手前に落ち、強すぎると奥へ飛びます。さらに同じ出力でも、ディスクが離れる速さが少し変わります。',
    purpose:
      '機体の位置・向き・射出角度は固定し、出力だけを調整して、最初に床へ触れる位置を的の中心から前後15 cm以内に入れます。出力を変えた記録と、同じ出力を繰り返した記録を使って狙います。',
    first:
      'まず1枚飛ばし、手前なら出力を上げ、奥なら下げてもう1枚試してください。下のグラフで、的の黄色い水平線より下と上に記録を集めます。同じ出力の平均を結ぶ緑の線と、的の線が交わる所から真下へたどると、次に試す出力の候補を読めます。',
  },
  measure: {
    title: '実機で測った値から、次に狙う出力を決める',
    scene:
      '実物のロボットでも、指定した距離へディスクを届けたい場面です。実物では質量やローラとの滑りで飛距離が変わるため、画面の実験と同じ出力で届くとは限りません。',
    purpose:
      '実機で測った「出力と飛距離」を入力し、その間の距離に届ける出力を見積もります。その出力で実際に1枚飛ばし、予想した距離との差を確かめます。',
    first:
      '実機があれば、1枚ごとの出力（%）と飛距離（m）を入力して「測定値を追加」を押します。異なる出力で少なくとも2種類測り、「次に狙う距離」を入力してください。実機がなければ「使用するデータ」を「入力例（模擬）」に変え、1.6 mへ届ける候補とグラフの読み方を確かめます。',
  },
};
let topic = 'power',
  playing = false,
  raf = 0,
  clock = 0,
  offset = 0,
  seed = 104,
  targetIndex = 0,
  hitTargets = new Set(),
  showForces = true,
  showReference = true;
let dataSource = 'measured',
  measured = [],
  sample = [
    { power: 30, range: 0.7 },
    { power: 30, range: 0.8 },
    { power: 50, range: 1.25 },
    { power: 50, range: 1.4 },
    { power: 70, range: 1.85 },
    { power: 70, range: 2.0 },
  ],
  measureTarget = 1.6;
const state = () => states.get(topic),
  currentTarget = () => (topic === 'target' ? LAUNCH_TARGETS[targetIndex] : null);
function download(name, text) {
  const a = document.createElement('a'),
    u = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
function draw() {
  const s = state();
  if (!$('launchFlight') || topic === 'measure') return;
  drawLaunch($('launchFlight'), {
    run: s.run,
    index: s.index,
    reference: topic === 'forces' && showReference && s.run ? s.run.reference : null,
    forces: topic === 'forces' && showForces,
    target: s.run?.target ?? currentTarget(),
    previous: topic === 'power' ? s.records.filter((r) => r !== s.run).at(-1) : null,
  });
}
function updatePlayback() {
  if (!$('launchPlay') || topic === 'measure') return;
  const s = state(),
    r = s.run,
    pending = r && !s.complete;
  $('launchRun').disabled = playing;
  $('launchPower').disabled = pending;
  $('launchRun').textContent = playing
    ? '飛行を表示中…'
    : pending
      ? '続きから見る'
      : 'この出力で1枚飛ばす';
  $('launchPlay').disabled = !r || r.samples.length < 2;
  $('launchPlay').textContent = playing
    ? 'Ⅱ 一時停止'
    : r && s.index < r.samples.length - 1
      ? '▶ 続きから見る'
      : '▶ 動きを最初から見る';
  $('launchSeek').disabled = !r;
  $('launchSeek').max = s.observed;
  $('launchSeek').value = s.index;
  $('launchTime').textContent = r
    ? (playing ? '飛行中' : s.index === r.samples.length - 1 ? '終了' : '一時停止') +
      ' · ' +
      fmt(r.samples[s.index].t, 2) +
      ' 秒'
    : '実験前';
  if (topic === 'target') {
    $('launchTargetNext').disabled = playing || pending || !hitTargets.has(targetIndex);
    $('launchTargetNext').hidden = targetIndex === LAUNCH_TARGETS.length - 1;
  }
}
function pause() {
  playing = false;
  cancelAnimationFrame(raf);
  updatePlayback();
}
function play() {
  const s = state();
  if (!s.run || s.run.samples.length < 2) return;
  if (s.index === s.run.samples.length - 1) s.index = 0;
  offset = s.run.samples[s.index].t;
  clock = performance.now();
  playing = true;
  tick();
}
function tick() {
  if (!playing) return;
  const s = state(),
    r = s.run,
    t = offset + ((performance.now() - clock) / 1000) * 0.2;
  while (s.index < r.samples.length - 1 && r.samples[s.index + 1].t <= t) s.index++;
  s.observed = Math.max(s.observed, s.index);
  draw();
  updatePlayback();
  if (s.index === r.samples.length - 1) {
    pause();
    finish();
  } else raf = requestAnimationFrame(tick);
}
function run() {
  $('launchFlight').scrollIntoView({ block: 'center', behavior: 'instant' });
  const s = state();
  if (s.run && !s.complete) {
    play();
    return;
  }
  pause();
  s.run = launchExperiment({ power: s.power, variation: topic === 'target', seed: ++seed });
  s.run.target = currentTarget();
  if (topic === 'forces') s.run.reference = launchExperiment({ power: s.power, air: false });
  s.index = 0;
  s.observed = 0;
  s.complete = false;
  $('launchResult').hidden = true;
  $('launchStatus').textContent =
    '射出口から離れたところから、5倍の時間をかけて表示しています。途中で止めて、動きを確認できます。';
  draw();
  if (s.run.status === 'not-released') finish();
  else play();
}
function finish(record = true) {
  const s = state(),
    r = s.run;
  if (s.complete && record) return;
  s.complete = true;
  if (record && r.status === 'landed') {
    s.records.push(r);
    if (s.records.length > 60) s.records.shift();
  }
  $('launchResult').hidden = false;
  if (r.status !== 'landed') {
    $('launchStatus').textContent =
      'この仮のモデルでは10%以下の出力では押し出せません。出力を少し上げて試してください。';
    $('launchResult').textContent =
      'ディスクは射出されませんでした。実機で動き始める出力は、機構によって異なります。';
    updatePlayback();
    return;
  }
  const error = r.target === null ? null : r.range - r.target,
    hit = error !== null && Math.abs(error) <= 0.15;
  if (hit) hitTargets.add(targetIndex);
  const label =
    error === null ? '床に到達' : hit ? '的の範囲に到達' : error < 0 ? '的より手前' : '的より奥';
  $('launchStatus').textContent =
    label +
    '。' +
    (topic === 'power'
      ? '次は出力だけを変えて、前の軌跡とグラフで比べます。'
      : topic === 'forces'
        ? '空気抵抗は速さを減らし、揚力は進行方向に直角に働きます。この仮定では落下までの時間が長くなっています。'
        : hit
          ? hitTargets.size === 3
            ? '3つの的に到達しました。同じ出力でもう1枚確かめてみましょう。'
            : '同じ出力でもう1枚確かめるか、「次の的へ」で距離を変えられます。'
          : '下のグラフと記録を見て、次に試す出力を考えてください。');
  $('launchResult').innerHTML =
    `<div class="launch-metrics"><div><span>出力指示</span><strong>${r.config.power}%</strong></div><div><span>最初の接地点まで</span><strong>${fmt(r.range, 2)} m</strong></div><div><span>${error === null ? '飛んでいた時間' : '的の中心との差'}</span><strong>${error === null ? fmt(r.time, 2) + ' 秒' : (error < 0 ? '手前 ' : '奥 ') + fmt(Math.abs(error) * 100, 0) + ' cm'}</strong></div></div><p>${topic === 'forces' ? `空気がない計算では ${fmt(r.reference.range, 2)} m、${fmt(r.reference.time, 2)} 秒でした。実機でもこの差になるとは限りません。` : `離れる速さは ${fmt(r.speed, 2)} m/秒（仮の計算値）。出力の%と速さのm/sは、同じ量ではありません。`}</p>`;
  chartView();
  updatePlayback();
}
function chartView() {
  if (topic === 'measure') return;
  const rows = state()
      .records.filter((r) => r.status === 'landed')
      .map((r) => ({ power: r.config.power, range: r.range })),
    estimate = topic === 'target' ? launchEstimate(rows, currentTarget()) : null;
  $('launchGraph').innerHTML = launchChart(rows, currentTarget());
  $('launchHistory').innerHTML = rows.length
    ? `<table><thead><tr><th>記録</th><th>出力指示</th><th>飛距離</th></tr></thead><tbody>${rows
        .slice(-6)
        .map(
          (r, i) =>
            `<tr><td>${Math.max(0, rows.length - 6) + i + 1}枚目</td><td>${r.power}%</td><td>${fmt(r.range, 2)} m</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p>飛ばした後に記録が残ります。まだ結果はありません。</p>';
  $('launchExport').disabled = !rows.length;
  if (estimate) {
    $('launchEstimate').textContent = estimate.ok
      ? '的をはさむ測定値の間から考えると、約 ' +
        fmt(estimate.power, 0) +
        '% が候補です。設定は自分で変えて試してください。'
      : estimate.message;
    $('launchProgress').textContent = hitTargets.size + ' / 3 個の的に到達';
  }
}
function reflection() {
  if (topic === 'power')
    return `<h2>出力を2倍にすると、飛距離も2倍になる？</h2><p>出力を増やすとローラは速く回りやすくなりますが、負荷や滑りでディスクの速さは変わります。まず点を2つ以上集め、出力の変化と飛距離の変化を比べましょう。</p><details><summary>考えるためのヒント</summary><p>「出力指示 → ローラの回転 → ディスクが離れる速さ → 飛距離」の間には、いくつも段階があります。出力の%だけから、回転数や飛距離を直接決めることはできません。</p></details>`;
  if (topic === 'forces')
    return `<h2>回転すれば、それだけで浮く？</h2><p>ディスクの回転には、姿勢を変わりにくくする働きがあります。回転そのものを上向きの力と考えるのは適切ではありません。揚力や空気抵抗は、空気に対する速さ、形、空気が当たる角度などで変わります。</p><details data-help-dialog><summary>式と、この計算の範囲</summary><p>まず各時刻の力を求め、その力で速さがどう変わるか、次の瞬間にどこへ進むかを短い時間ごとに計算します。重力の大きさは mg、空気抵抗は ½ρv²AC<sub>D</sub>、揚力は ½ρv²AC<sub>L</sub>です。mは質量、gは重力による加速度（約9.8 m/秒²）、ρは空気の密度、vは空気に対する速さ、Aはディスクの円の面積です。C<sub>D</sub>とC<sub>L</sub>は、形や空気が当たる角度の影響をまとめた数です。形と角度が同じなら、vが2倍になると空気の力は4倍になります。</p><p>このモデルはディスクの面を水平に保つと仮定します。落下中は進む方向と面の向きが異なるため、空気が当たる角度が変わります。回転数・首振り・横曲がり・変形は計算していません。係数もこの素材の実測値ではありません。</p><p>参考：<a href="https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/drag-equation/" target="_blank" rel="noopener">NASAの空気抵抗の説明</a>、<a href="https://ntrs.nasa.gov/citations/20070014641" target="_blank" rel="noopener">回転するディスクの飛行に関する研究</a>。</p></details>`;
  return `<h2>1枚届いたら、その出力でいつも届く？</h2><p>同じ出力でもう数枚飛ばし、点がどれくらい散らばるか見てください。平均が的に合うことと、毎回的の中に入ることは別です。ここでは離れる速さだけに小さなばらつきを加えています。</p><details><summary>的が左右にずれていたら？</summary><p>この実験で変えられるのはモーター出力だけです。正面の飛距離は調整できますが、左右にある任意の位置を狙うことはできません。ロボットの位置や向きを変える課題は、別の操作条件として考える必要があります。</p></details>`;
}
function render() {
  const s = state(),
    copy = COPY[topic];
  $('launchPage').innerHTML =
    `<div class="page-heading"><div><p class="eyebrow course-label">${lessonLabel('launch')}</p><h1>${copy.title}</h1></div></div><nav class="basics-topics launch-topics" aria-label="学ぶ順序">${LAUNCH_TOPICS.map((t, i) => `<button data-launch-topic="${t.id}" aria-pressed="${topic === t.id}"><span>${i + 1}</span>${t.title}</button>`).join('')}</nav>${lessonBrief('launch-' + topic, copy)}${schoolTips('launch-' + topic)}${topic === 'measure' ? measurementHTML() : `<details data-help-dialog class="card launch-intro"><summary>横投げのディスクと、射出部の仕組みを見る</summary>${launchMechanism()}<p>ディスクの広い面を床と平行にして飛ばす「横投げ」です。横から見ると薄い板に見えます。操作するのは射出用モーター1つの出力だけで、機体の位置・向き・射出角度は固定します。</p></details><div class="launch-layout"><div class="launch-workspace"><section class="card"><div class="section-top"><h2>出力と飛び方を比べる</h2><span id="launchTime">実験前</span></div><p class="launch-model-note">教材用の仮モデルです。実機の飛距離を予測するものではありません。</p><div class="diagram-scroll" role="region" aria-label="実験の図。狭い画面では横にスクロールできます" tabindex="0"><canvas id="launchFlight" width="760" height="350" role="img" aria-label="水平なディスクを横から見た飛行。横軸は射出口からの距離、床との高さも同じ縮尺です。"></canvas></div><p class="diagram-scroll-hint">図は左右にスクロールできます。</p><div class="launch-legend"><span>━ 今回</span>${topic === 'power' ? '<span class="launch-previous">┄ 前回</span>' : ''}${topic === 'forces' ? '<span class="launch-vacuum">┄ 空気がない計算</span>' : ''}<span>5倍スロー</span></div><div class="launch-playbar"><button id="launchPlay" class="small" disabled>▶ 動きを最初から見る</button><input id="launchSeek" type="range" min="0" max="0" value="0" aria-label="観察済みの飛行時刻" disabled></div><p id="launchStatus" class="launch-status" role="status">「この出力で1枚飛ばす」を押すと、射出直後から動きを表示します。</p><div id="launchResult" class="launch-result" hidden></div></section><section class="card launch-data"><div class="section-top"><h2>出力と飛距離の記録</h2><button id="launchExport" class="small" disabled>CSV保存</button></div><div id="launchGraph"></div><p>横軸はモーターへの出力（%）、縦軸は飛距離（m）です。点は1枚ごとの結果で、同じ出力を繰り返すと縦に点が並びます。緑の線は、同じ出力の平均を出力順につないだものです。線の途中の距離を実際に飛ばしたとは限りません。この段階の直近60枚を残し、すべて教材用のシミュレーション値として表示します。</p><details><summary>数値の記録を見る（直近6枚）</summary><div id="launchHistory" class="launch-table"></div></details></section></div><aside class="guide card launch-guide"><p class="eyebrow">条件を決める</p><h2>${topic === 'target' ? '的まで ' + fmt(currentTarget()) + ' m' : 'モーターの出力を決める'}</h2>${topic === 'target' ? `<p id="launchProgress">${hitTargets.size} / 3 個の的に到達</p><p>中心から前後15 cm以内を狙います。ロボットと的の左右位置は同じです。</p>` : '<p>ローラが十分に回ってから、ディスクを1枚送り込む条件です。</p>'}<label class="launch-power-label" for="launchPower">モーターへの出力指示<output id="launchPowerValue">${s.power}%</output></label><input id="launchPower" type="range" min="0" max="100" step="1" value="${s.power}"><p class="helper">0%は出力なし、100%は最大出力の指示です。この%は、消費電力（W）や1分間の回転数（rpm）を測った値ではありません。</p><button class="primary full" id="launchRun">この出力で1枚飛ばす</button>${topic === 'forces' ? `<label class="launch-check"><input type="checkbox" id="launchForceToggle" checked>働く力を矢印で見る</label><label class="launch-check"><input type="checkbox" id="launchReference" checked>空気がない計算を重ねる</label><p class="helper">2本の軌跡は同じ速さ・同じ高さから始まります。色の矢印は、その瞬間に働く力の向きと大きさです。進む向きや速さの矢印ではなく、長さを飛距離の目盛りで読むことはできません。</p>` : ''}${topic === 'target' ? '<details class="launch-hint"><summary>記録から次の出力を考える</summary><p id="launchEstimate"></p></details><button id="launchTargetNext" class="full" disabled>次の的へ →</button>' : ''}<details data-help-dialog class="launch-model"><summary>固定している条件と仮定</summary><p>実物の仕様：直径180 mm、厚み20 mm、高発泡ポリエチレン製。</p><p>未確認の仮定：質量18 g、中心の射出高さ45 cm、初速の向きは水平。ディスクの面も水平に保ちます。モーター出力と初速の関係・空力係数は教材用です。</p><p>射出機構が未定のため、ローラ1つと案内部の図は仕組みを説明する模式図です。ローラの回転数やディスクの回転数を、この出力だけから特定することはできません。</p></details></aside></div><section class="card launch-reflection">${reflection()}</section>`}<div class="basics-footer"><p>${topic === 'measure' ? '測定 → 予測 → 1枚で確かめる → 記録を増やす、を繰り返します。' : '一度に変える条件を一つにすると、結果が変わった理由を考えやすくなります。'}</p><button id="launchNext" class="primary">${topic === 'measure' ? '最初の実験へ戻る' : '次へ：' + LAUNCH_TOPICS[LAUNCH_TOPICS.findIndex((t) => t.id === topic) + 1].title + ' →'}</button></div>`;
  document
    .querySelectorAll('[data-launch-topic]')
    .forEach((b) => (b.onclick = () => select(b.dataset.launchTopic)));
  if (topic === 'measure') $('launchNext').textContent = '小テストで確かめる →';
  $('launchNext').onclick = () => {
    if (topic === 'measure')
      document.dispatchEvent(new CustomEvent('quiz-open', { detail: 'launch' }));
    else select(LAUNCH_TOPICS[LAUNCH_TOPICS.findIndex((t) => t.id === topic) + 1].id);
  };
  if (topic === 'measure') {
    bindMeasurement();
    return;
  }
  $('launchPower').oninput = () => {
    s.power = Number($('launchPower').value);
    $('launchPowerValue').textContent = s.power + '%';
    if (s.run)
      $('launchStatus').textContent =
        '出力の設定を変えました。図と記録は前の実験のままです。「1枚飛ばす」で確かめます。';
  };
  $('launchRun').onclick = run;
  $('launchPlay').onclick = () => (playing ? pause() : play());
  $('launchSeek').oninput = () => {
    const selected = Number($('launchSeek').value);
    pause();
    s.index = selected;
    draw();
    updatePlayback();
  };
  $('launchExport').onclick = () =>
    download(
      'QUESTiX-LAB-射出-模擬.csv',
      launchCSV(
        s.records.map((r) => ({ power: r.config.power, range: r.range })),
        'simulation',
      ),
    );
  if (topic === 'forces') {
    $('launchForceToggle').checked = showForces;
    $('launchReference').checked = showReference;
    $('launchForceToggle').onchange = () => {
      showForces = $('launchForceToggle').checked;
      draw();
    };
    $('launchReference').onchange = () => {
      showReference = $('launchReference').checked;
      draw();
    };
  }
  if (topic === 'target')
    $('launchTargetNext').onclick = () => {
      if (!hitTargets.has(targetIndex) || targetIndex === 2) return;
      pause();
      targetIndex++;
      s.run = null;
      s.index = 0;
      s.complete = false;
      s.observed = 0;
      render();
    };
  drawLaunchRobot($('launchRobot'));
  draw();
  chartView();
  updatePlayback();
  if (s.complete) finish(false);
}
function measurementHTML() {
  return `<div class="launch-layout"><section class="card launch-data"><div class="section-top"><h2>測定した出力と飛距離</h2></div><p id="launchSourceNote"></p><div id="launchMeasuredGraph"></div><p>横軸は出力、縦軸は飛距離です。同じ出力の平均を緑の線でつなぎ、縦線でその出力の最小〜最大の範囲を示します。狙う距離の黄色い水平線と緑の線の交点から下へ読むと、出力の候補が分かります。例えば40%で1 m、60%で2 mなら、中間の1.5 mには50%を候補にします。このように測った2点の間から見積もる方法を補間といいます。実際に届くかは次の1枚で確かめます。</p><div id="launchMeasuredRows" class="launch-table"></div><div class="launch-file-row"><button id="launchMeasuredExport" class="small">この記録をCSV保存</button><button id="launchRemoveMeasurement" class="small">最後の1枚を削除</button><label class="vision-file">測定CSVを開く<input id="launchImport" type="file" accept=".csv,text/csv"></label></div><p id="launchImportStatus" role="status"></p></section><aside class="guide card launch-guide"><label class="launch-source-label" for="launchSource">使用するデータ</label><select id="launchSource" aria-label="測定データの種類"><option value="measured">実機の測定</option><option value="example">入力例（模擬）</option></select><h2>1枚の測定を記録する</h2><form id="launchMeasurementForm"><label for="launchMeasuredPower">モーターへの出力指示（%）</label><input id="launchMeasuredPower" type="number" min="0" max="100" step="1" value="40" required><label for="launchMeasuredRange">最初の接地点までの距離（m）</label><input id="launchMeasuredRange" type="number" min="0" max="30" step="0.01" placeholder="例：1.25" required><button id="launchAddMeasurement" type="submit" class="primary full">測定値を追加</button></form><p class="helper">同じ出力の記録も追加できます。入力例の表示中は追加できません。</p><label for="launchMeasuredTarget">次に狙う距離（m）</label><input id="launchMeasuredTarget" type="number" min="0.1" max="30" step="0.1" value="${measureTarget}"><div class="launch-calibration" id="launchCalibration" role="status"></div><button id="launchTemplate" class="small full">空の測定CSVを保存</button><p class="helper">CSVは、1行に1枚分の測定を並べた表のファイルです。「空の測定CSVを保存」でひな形を作れます。列名 output_pct は出力の%、range_m は飛距離のmです。読み込むと、この画面の実機測定記録がファイルの内容に置き換わります。</p></aside></div><section class="card launch-reflection"><h2>実機では、何をそろえて測る？</h2><ol><li>ロボットの位置・向き・射出する高さを固定し、同じ種類のディスクを使います。実際の質量と、ローラが回り始める出力も確認します。</li><li>射出口の真下を0 mとして、最初に床に触れた位置を測ります。跳ねたり滑ったりして止まった位置とは区別します。同じ出力で3枚程度から繰り返し、ばらつきを記録します。</li><li>正面の目標をはさむ2種類以上の出力で測り、候補を見積もります。新しい出力で1枚試し、その結果も加えて確かめます。</li></ol><p>実験は教員が管理し、人のいない射出方向と回収範囲を確保します。ディスクの詰まりを直すときはモーターを停止します。</p><details data-help-dialog><summary>搭載センサーとROS 2をどう使う？</summary><p>RGB-DカメラのRGB映像は、ディスクが離れる瞬間や最初に床へ触れる位置の確認に使えます。距離画像を使う場合は、測れる範囲とディスクに対応する画素を確認します。速い飛行や薄い縁を毎フレーム測れるとは限らないので、まず床の目盛りと映像で照合します。</p><p>機体のIMUは機体の傾きの変化を確認するために使います。飛んでいるディスクの姿勢や回転は測れません。LiDARは周囲の距離を測ります。駆動輪の回転数センサーでは、車輪が回っていないかを確認できます。機体そのものが動いていないかは、床の目印や映像でも確かめます。駆動輪のセンサーで射出ローラの回転数は測れません。</p><p>ROS 2は、ロボット内のセンサーやプログラム同士でデータを受け渡す仕組みです。データを流す名前付きの通路をトピックと呼びます。実機ではカメラ映像やIMUの値と、射出した時刻・出力を一緒に保存すると、どの指示の飛行かを照合できます。接続や記録の準備は教員・開発担当者と行い、実機にあるトピック名を確認してください。この教材から射出指示は送らず、測った飛距離をCSVで取り込みます。</p></details><details><summary>位置を狙う課題の範囲</summary><p>この章で調整するのは、固定された射出方向に沿った距離です。横方向のずれや高さの異なる的は扱いません。実機で左右に散らばる場合は、左右のずれも別に記録し、姿勢や送り込み方を確かめる必要があります。</p></details></section>`;
}
function measurementView() {
  const rows = dataSource === 'measured' ? measured : sample,
    e = launchEstimate(rows, measureTarget);
  $('launchSourceNote').textContent =
    dataSource === 'measured'
      ? '実機で測った値だけを表示します。ブラウザの飛行モデルの数値は混ぜません。'
      : '入力例の模擬データです。実機で測った値ではありません。実機の記録は別に保持しています。';
  $('launchMeasuredGraph').innerHTML = launchChart(
    rows,
    Number.isFinite(measureTarget) && measureTarget > 0 ? measureTarget : null,
    e,
  );
  $('launchCalibration').textContent = e.ok
    ? '出力の候補：約 ' + fmt(e.power, 1) + '%。' + e.message
    : e.message;
  $('launchMeasuredRows').innerHTML = rows.length
    ? `<table><thead><tr><th>出力</th><th>枚数</th><th>平均</th><th>最小〜最大</th></tr></thead><tbody>${e.groups.map((g) => `<tr><td>${g.power}%</td><td>${g.count}</td><td>${fmt(g.mean, 2)} m</td><td>${fmt(g.min, 2)}〜${fmt(g.max, 2)} m</td></tr>`).join('')}</tbody></table>`
    : '<p>実機の記録はまだありません。入力欄から追加するか、測定CSVを開いてください。</p>';
  $('launchAddMeasurement').disabled = dataSource !== 'measured';
  $('launchMeasuredPower').disabled = dataSource !== 'measured';
  $('launchMeasuredRange').disabled = dataSource !== 'measured';
  $('launchMeasuredExport').disabled = !rows.length;
  $('launchRemoveMeasurement').disabled = dataSource !== 'measured' || !measured.length;
}
function bindMeasurement() {
  $('launchSource').value = dataSource;
  $('launchSource').onchange = () => {
    dataSource = $('launchSource').value;
    measurementView();
  };
  $('launchMeasurementForm').onsubmit = (e) => {
    e.preventDefault();
    if (dataSource !== 'measured') return;
    try {
      if (!$('launchMeasuredRange').value.trim()) throw new Error('測った距離を入力してください。');
      const row = {
        power: Number($('launchMeasuredPower').value),
        range: Number($('launchMeasuredRange').value),
      };
      launchEstimate([row], measureTarget);
      if (measured.length >= 300) throw new Error('記録は300枚までです。');
      measured.push(row);
      $('launchMeasuredRange').value = '';
      $('launchImportStatus').textContent = '測定値を追加しました。';
      measurementView();
    } catch (error) {
      $('launchImportStatus').textContent = error.message;
    }
  };
  $('launchRemoveMeasurement').onclick = () => {
    if (dataSource === 'measured') {
      measured.pop();
      measurementView();
    }
  };
  $('launchMeasuredTarget').oninput = () => {
    measureTarget = Number($('launchMeasuredTarget').value);
    measurementView();
  };
  $('launchMeasuredExport').onclick = () =>
    download(
      'QUESTiX-LAB-射出-' + (dataSource === 'measured' ? '実測' : '入力例') + '.csv',
      launchCSV(
        dataSource === 'measured' ? measured : sample,
        dataSource === 'measured' ? 'measured' : 'example',
      ),
    );
  $('launchTemplate').onclick = () =>
    download('QUESTiX-LAB-射出-測定用.csv', '\uFEFFoutput_pct,range_m\n');
  $('launchImport').onchange = async () => {
    const file = $('launchImport').files?.[0];
    if (!file) return;
    try {
      if (file.size > 100000) throw new Error('CSVは100 KB以下にしてください。');
      const parsed = launchParseCSV(await file.text());
      measured = parsed;
      dataSource = 'measured';
      if (topic !== 'measure') return;
      $('launchSource').value = dataSource;
      $('launchImportStatus').textContent = parsed.length + '枚の測定値を読み込みました。';
      measurementView();
    } catch (error) {
      if (topic === 'measure') $('launchImportStatus').textContent = error.message;
    } finally {
      if (topic === 'measure') $('launchImport').value = '';
    }
  };
  measurementView();
}
function select(id) {
  pause();
  topic = id;
  render();
  window.scrollTo({ top: 0, behavior: 'auto' });
}
function initLaunch() {
  render();
  document.addEventListener('series-leave', pause);
  document.addEventListener('supplement-open', pause);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });
  window.addEventListener('resize', () => {
    if (!$('launchPage').hidden) {
      draw();
      if ($('launchRobot')) drawLaunchRobot($('launchRobot'));
    }
  });
}
function activateLaunch() {
  draw();
  if ($('launchRobot')) drawLaunchRobot($('launchRobot'));
}
function reviewLaunch(id) {
  if (!LAUNCH_TOPICS.some((t) => t.id === id)) return false;
  select(id);
  return true;
}

export { initLaunch, activateLaunch, reviewLaunch };
