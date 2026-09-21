import { initRLCurriculum } from './foundations.js';
import { IntroLearner, introRandom, introRollout, introDistance } from './intro.js';
import { drawRobot } from '../core/renderer.js';

const $ = (id) => document.getElementById(id),
  $$ = (s) => [...document.querySelectorAll(s)];
const pause = () => new Promise((r) => setTimeout(r, 0));
let primerRule = 'approach',
  primerResult = null,
  primerModel = null,
  primerBusy = false,
  primerPlaying = false,
  primerToken = 0;
const primerBaseline = introRollout(null),
  primerHistory = new Map();
function renderPrimerComparison() {
  const node = $('primerComparison');
  node.hidden = primerHistory.size === 0;
  node.innerHTML =
    '<h3>報酬を変えた結果を残して比べる</h3><div class="primer-history-grid">' +
    [...primerHistory]
      .map(([rule, run]) => {
        const point = (p) => (16 + p.x * 53).toFixed(1) + ',' + (12 + p.y * 53).toFixed(1);
        return `<article><h4>${rule === 'approach' ? '近づくと加点' : '回転すると加点'}</h4><svg viewBox="0 0 290 190" role="img" aria-label="${rule === 'approach' ? '接近' : '回転'}報酬で学習した走行の全軌跡"><rect x="16" y="12" width="254" height="159" fill="#1b3540"/><circle cx="222.7" cy="91.5" r="12" fill="none" stroke="#e5c274" stroke-dasharray="3 3"/><polyline points="${run.trace.map(point).join(' ')}" fill="none" stroke="#8ed8bc" stroke-width="2"/><circle cx="${16 + run.trace[0].x * 53}" cy="${12 + run.trace[0].y * 53}" r="4" fill="#fff"/></svg><p>${run.success ? run.time.toFixed(1) + '秒で到着' : '未到着 · 残り' + run.distance.toFixed(1) + ' m'}</p></article>`;
      })
      .join('') +
    '</div><p class="helper">同じ出発位置からの記録です。白い点が出発点、黄色い円が届け先です。報酬の合計点は、付け方が違うため単純には比べません。</p>';
}
function drawPrimer(id, run, time = Infinity) {
  const c = $(id).getContext('2d'),
    W = 600,
    H = 400,
    k = 108,
    ox = 40,
    oy = 32,
    point = (p) => ({ x: ox + p.x * k, y: oy + p.y * k });
  c.fillStyle = '#102832';
  c.fillRect(0, 0, W, H);
  c.strokeStyle = '#38505a';
  c.strokeRect(ox, oy, 4.8 * k, 3 * k);
  const g = point({ x: 3.9, y: 1.5 });
  c.setLineDash([6, 5]);
  c.strokeStyle = '#efd18e';
  c.fillStyle = '#efd18e19';
  c.lineWidth = 2;
  c.beginPath();
  c.arc(g.x, g.y, 24, 0, Math.PI * 2);
  c.fill();
  c.stroke();
  c.setLineDash([]);
  c.fillStyle = '#efd18e';
  c.font = '22px system-ui';
  c.textAlign = 'center';
  c.fillText('届け先', g.x, g.y - 40);
  const trace = run?.trace || [{ x: 0.8, y: 1.5, theta: -Math.PI / 2, left: 0, right: 0, time: 0 }],
    index = Math.max(
      0,
      trace.findLastIndex((p) => p.time <= time),
    );
  c.strokeStyle = id === 'primerBefore' ? '#91a9b3' : '#8edec1';
  c.lineWidth = 3;
  c.beginPath();
  trace.slice(0, index + 1).forEach((p, i) => {
    const q = point(p);
    i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y);
  });
  c.stroke();
  const p = trace[index];
  drawRobot(c, point(p), p);
  c.fillStyle = '#8fa8b0';
  c.font = '19px system-ui';
  c.textAlign = 'left';
  c.fillText(
    run ? Math.min(time, run.time).toFixed(1) + ' 秒' : '学習前と同じ位置からスタート',
    40,
    385,
  );
}
function stillPrimer() {
  drawPrimer('primerBefore', primerBaseline);
  drawPrimer('primerAfter', primerResult);
}
function replayPrimer() {
  if (!primerResult || primerBusy) return;
  primerToken++;
  if (primerPlaying) {
    primerPlaying = false;
    stillPrimer();
    $('primerReplay').textContent = '▶ 走りを再生';
    return;
  }
  primerPlaying = true;
  const token = primerToken,
    start = performance.now(),
    end = Math.max(primerBaseline.time, primerResult.time);
  $('primerReplay').textContent = '結果を表示';
  function frame(now) {
    if (token !== primerToken) return;
    const t = Math.min(end, ((now - start) / 1000) * 2);
    drawPrimer('primerBefore', primerBaseline, t);
    drawPrimer('primerAfter', primerResult, t);
    if (t < end) requestAnimationFrame(frame);
    else {
      primerPlaying = false;
      $('primerReplay').textContent = '▶ 走りを再生';
    }
  }
  requestAnimationFrame(frame);
}
async function learnPrimer() {
  if (primerBusy) return;
  primerBusy = true;
  primerToken++;
  primerPlaying = false;
  $('primerLearn').disabled = true;
  $$('[name="primerRule"]').forEach((x) => (x.disabled = true));
  $('primerStatus').textContent = '動きを試して報酬を受け取り、選び方を更新しています。';
  primerModel = new IntroLearner(primerRule, introRandom(71));
  for (let i = 0; i < 10; i++) {
    primerModel.train(80);
    await pause();
  }
  primerResult = introRollout(primerModel);
  primerHistory.set(primerRule, primerResult);
  renderPrimerComparison();
  stillPrimer();
  $('primerAfterLabel').textContent = '学習後';
  $('primerAfterSubtitle').textContent =
    primerRule === 'approach' ? '近づくと加点' : '回転すると加点';
  $('primerAfterCaption').textContent = primerResult.success
    ? primerResult.time.toFixed(1) + ' 秒で届け先に到着'
    : '届け先まで ' + primerResult.distance.toFixed(1) + ' m · まだ到着していません';
  $('primerConclusion').hidden = false;
  $('primerConclusion').innerHTML =
    primerRule === 'approach'
      ? '<h3>近づくことを評価して、行動の選び方を学びました</h3><p>右の線と残り距離を見て、届け先へ進めたか確かめます。次に「回転すると加点」へ変えて学び直し、同じ出発点でも結果が変わるか比べてください。報酬を変えると、学習で目指す動きも変わります。</p>'
      : '<h3>回転で点数が増えると、届けなくてもよくなる</h3><p>右の図で位置と向きを見てください。その場で回っても報酬が増えるため、届け先へ進む理由が点数に含まれていません。下に残った「近づくと加点」の軌跡と比べ、人の目的に合う点数の付け方を考えましょう。</p>';
  const e = primerModel.example;
  $('primerEvidence').hidden = false;
  $('primerEvidence').innerHTML =
    '<p class="eyebrow">実際の学習で起きたこと</p><p><strong>' +
    ['前に進んだ', '左に曲がった', '右に曲がった'][e.action] +
    '</strong> → ' +
    (primerRule === 'approach'
      ? '届け先までの距離が ' +
        introDistance(e.from).toFixed(2) +
        ' m から ' +
        introDistance(e.state).toFixed(2) +
        ' m に縮まった'
      : '回転した') +
    ' → <strong>+' +
    e.reward.toFixed(1) +
    ' 点</strong><br>この経験を、同じような状況での動きの選び方に反映しました。</p>';
  $('primerStatus').textContent =
    primerModel.episodes + '回の走行で学習しました。左右は、同じ位置・向きからの走行です。';
  $('primerReplay').disabled = false;
  $('primerLearn').disabled = false;
  $('primerLearn').textContent = 'この点数で最初から学び直す';
  $$('[name="primerRule"]').forEach((x) => (x.disabled = false));
  primerBusy = false;
  if (matchMedia('(max-width: 900px)').matches) {
    document.querySelector('.intro-visual').scrollIntoView({ block: 'start' });
  }
}
$$('[name="primerRule"]').forEach(
  (x) =>
    (x.onchange = () => {
      primerRule = x.value;
      primerToken++;
      primerPlaying = false;
      primerResult = null;
      stillPrimer();
      $('primerAfterSubtitle').textContent = 'これから学習します';
      $('primerAfterCaption').textContent = '選んだ点数で、最初から学び直します';
      $('primerConclusion').hidden = true;
      $('primerEvidence').hidden = true;
      $('primerReplay').disabled = true;
      $('primerReplay').textContent = '▶ 走りを再生';
      $('primerLearn').textContent = 'この点数で学習させる';
      $('primerStatus').textContent =
        'ルールを変更しました。学習させると、新しい走り方を比べられます。';
    }),
);
$('primerLearn').onclick = learnPrimer;
$('primerReplay').onclick = replayPrimer;
function openLab(task = 'delivery') {
  document.dispatchEvent(new CustomEvent('open-lab', { detail: { task } }));
}

stillPrimer();
function stopPrimer() {
  primerToken++;
  primerPlaying = false;
  $('primerReplay').textContent = '▶ 走りを再生';
}
for (const event of ['rl-topic-change', 'series-leave', 'open-lab', 'supplement-open'])
  document.addEventListener(event, stopPrimer);
initRLCurriculum(openLab);
