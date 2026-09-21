import { lessonLabel } from '../shell/lesson-ui.js';
import { schoolTips } from '../shell/school-tips.js';
import { lessonBrief } from '../shell/lesson-brief.js';
import {
  CONTROL_GROUPS,
  CONTROL_TOPICS,
  controlDefaults,
  normalizeControlConfig,
  simulateControl,
  controlCSV,
  controlMethod,
  controlLoad,
  controlCalibration,
} from './core.js';
import { drawRobot } from '../core/renderer.js';
import { controlWheelAngle, drawControlBench } from './render.js';
import { controlConceptLesson, bindControlConcept } from './concepts.js';

const $ = (id) => document.getElementById(id);
const loadNames = {
  nominal: '負荷なし・事前計測と同じ',
  drag: '5秒後に負荷が増える',
  mismatch: '事前計測より回りにくい機体',
};
const methodNames = {
  feedforward: '見積もりだけ',
  feedback: 'ずれの修正だけ',
  both: '見積もり＋ずれの修正',
  fixed: '一定出力',
};
const calibration = controlCalibration();
const names = { standard: '標準', heavy: '荷物あり', noisy: '測定の揺らぎあり' };
const states = new Map(
  CONTROL_TOPICS.map((t) => [
    t.id,
    {
      config: controlDefaults(t.id),
      runs: [],
      result: null,
      previous: null,
      index: 0,
      observedMax: 0,
      complete: false,
    },
  ]),
);
let active = 'output',
  playing = false,
  raf = 0,
  playStart = 0,
  playFrom = 0,
  playSpeed = 1;
const topic = () => CONTROL_TOPICS.find((t) => t.id === active);
const state = () => states.get(active);
const fmt = (v, d = 1) => Number(v).toFixed(d);
const configKey = (c) => JSON.stringify({ ...c, scenario: 'standard' });
const dirty = () =>
  state().result && JSON.stringify(state().config) !== JSON.stringify(state().result.config);
const distance = () => topic().mode === 'distance';
function playbackLabel() {
  if ($('controlReplay'))
    $('controlReplay').textContent = playing
      ? 'Ⅱ 一時停止'
      : state().result && state().index < state().result.samples.length - 1
        ? '▶ 続きから見る'
        : '▶ 動きを最初から見る';
}
function playbackStatus() {
  const s = state();
  if (!$('controlRunStatus')) return;
  $('controlRunStatus').textContent = dirty()
    ? '設定を変更しました。表示は前の設定のままです。実験ボタンで新しい設定を試せます。'
    : !s.result
      ? '実験を始めると、16秒間の動きとグラフが一緒に進みます。途中で一時停止できます。'
      : s.complete
        ? playing
          ? '記録した実験を再生しています。'
          : '実験が終わりました。下の結果を確認し、設定を一つ変えて比べましょう。'
        : playing
          ? '実験中です。動きと測定値を見比べてください。一時停止して、途中の値も確認できます。'
          : '実験を一時停止しています。「続きから見る」で再開できます。';
}
function timeLabel() {
  const s = state(),
    r = s.result;
  if ($('controlTime'))
    $('controlTime').textContent = r
      ? (playing
          ? s.complete
            ? '再生中'
            : '実験中'
          : s.index >= r.samples.length - 1
            ? '終了'
            : '一時停止') +
        ' · ' +
        fmt(r.samples[s.index].time) +
        ' / 16.0 秒'
      : '実験前';
}
function stop() {
  playing = false;
  cancelAnimationFrame(raf);
  playbackLabel();
  playbackStatus();
  timeLabel();
}
function startPlayback() {
  const s = state();
  if (!s.result) return;
  if (s.index >= s.result.samples.length - 1) s.index = 0;
  playFrom = s.index;
  playStart = performance.now();
  playing = true;
  playbackStatus();
  tick();
}
function completeRun() {
  const s = state();
  if (s.complete) return;
  s.complete = true;
  s.runs.push(s.result);
  renderResult();
}

function slider(key, label, max, step, help) {
  return `<label class="control-setting" for="control-${key}"><span>${label}<output id="control-${key}-value">${fmt(state().config[key], ['power', 'targetRPM'].includes(key) ? 0 : 2)}</output></span><input id="control-${key}" data-control-setting="${key}" type="range" min="${key === 'targetRPM' ? 20 : 0}" max="${max}" step="${step}" value="${state().config[key]}"><small>${help}</small></label>`;
}
function controls() {
  const t = topic(),
    s = state();
  let fields = '';
  if (active === 'output')
    fields =
      slider(
        'power',
        'モーターへの出力（%）',
        100,
        5,
        '出力はモーターへ出す指示の大きさです。0%は出力なし、100%は最大です。出力を変え、実際の速さを比べます。',
      ) +
      '<p class="helper">目標は60 rpm、1秒に1回転です。この速さになる出力を探します。この実験の途中では負荷は変わりません。</p>';
  else if (['feedforward', 'combined'].includes(active)) {
    fields = slider(
      'targetRPM',
      '目標の回転数（rpm）',
      80,
      10,
      '出したい速さを決めます。出力は計算で決まります。',
    );
    fields += `<label class="control-select" for="controlLoadCase">機体と負荷の条件</label><select class="control-select-input" id="controlLoadCase">${Object.entries(
      loadNames,
    )
      .map(
        ([k, v]) =>
          `<option value="${k}" ${s.config.loadCase === k ? 'selected' : ''}>${v}</option>`,
      )
      .join('')}</select>`;
    if (active === 'combined')
      fields += `<label class="control-select" for="controlStrategy">指示の決め方</label><select class="control-select-input" id="controlStrategy">${['feedforward', 'feedback', 'both'].map((k) => `<option value="${k}" ${s.config.strategy === k ? 'selected' : ''}>${methodNames[k]}</option>`).join('')}</select><p class="helper">ずれの修正には、今のずれから作るPと、ずれが残った時間から作るIを使います。計算する強さはP 1.2・I 1.2に固定し、方式だけを切り替えます。詳しい働きは次の段階で一つずつ試します。</p>`;
    fields += `<details><summary>出力の見積もり方を変える</summary>${slider('ffGain', '1 rpmあたりの出力（%）', 2, 0.05, '目標が60 rpmでこの値が1なら、見積もる出力は60×1＝60%です。1.2なら72%になります。機体や負荷が違うと、必要な値も変わります。')}</details>`;
  } else if (active === 'reference')
    fields = `<fieldset class="choice-list"><legend>最終目標60 rpmへの変え方</legend><label class="choice"><input type="radio" name="controlProfile" value="step" ${s.config.profile === 'step' ? 'checked' : ''}><span><strong>一度に変える</strong><small>最初から60 rpmを指示します。</small></span></label><label class="choice"><input type="radio" name="controlProfile" value="ramp" ${s.config.profile === 'ramp' ? 'checked' : ''}><span><strong>3秒かけて変える</strong><small>毎秒20 rpmずつ目標を上げます。</small></span></label></fieldset><p class="helper">事前に見積もった出力に、測ったずれを補う調整（P・I）を加えます。その強さと機体は同じにして、目標の出し方だけを比べます。</p>`;
  else if (active === 'feedback')
    fields = `<fieldset class="choice-list"><legend>出力の決め方</legend><label class="choice"><input type="radio" name="controlFeedback" value="off" ${s.config.feedback ? '' : 'checked'}><span><strong>出力を一定にする</strong><small>回転数が変わっても、指示は変えません。</small></span></label><label class="choice"><input type="radio" name="controlFeedback" value="on" ${s.config.feedback ? 'checked' : ''}><span><strong>測って調整する</strong><small>目標との差を使い、出力を繰り返し調整します。</small></span></label></fieldset><details id="controlFixedPower" ${s.config.feedback ? 'hidden' : ''}><summary>一定出力の値を変える（初期値60%）</summary>${slider('power', '一定にする出力（%）', 100, 5, '100%が最大出力です。')}</details><p class="helper">目標は60 rpm。rpmは1分間あたりの回転数です。</p>`;
  else if (active === 'limits')
    fields = `<label class="choice"><input id="controlAntiWindup" type="checkbox" ${s.config.antiWindup ? 'checked' : ''}><span><strong>Iのたまり過ぎを抑える</strong><small>出力が上限に達したら、さらに出力を増やす方向にはIをためません。</small></span></label><p class="helper">P = 1.2、I = 3で固定。ほかの条件を揃えて比較します。</p>`;
  else if (active === 'noise')
    fields =
      slider(
        'filter',
        'Dの計算をなめらかにする時間（秒）',
        0.6,
        0.02,
        '0秒では今回測った変化をそのままDに使います。まず0.2秒にすると、細かな揺れを平均化できますが、本当の動きへの反応も遅れます。この値は実験や測定の間隔ではありません。',
      ) + '<p class="helper">P = 2.2、D = 1で固定。両方の実験に同じ測定の揺らぎを加えます。</p>';
  else {
    fields += slider(
      'kp',
      'P：現在のずれに掛ける数',
      8,
      0.1,
      '目標と測定値の差から、その時点の指示を計算します。大きくすると同じずれでも強く動かしますが、行き過ぎや揺れが増える場合があります。',
    );
    if (['i', 'challenge'].includes(active))
      fields += slider(
        'ki',
        'I：ずれを積み重ねる強さ',
        6,
        0.1,
        'ずれに続いた時間を掛けて足し、その分の指示をPに加えます。0では使いません。大きくすると残るずれを早く補えますが、ためすぎると行き過ぎます。',
      );
    if (['d', 'challenge'].includes(active))
      fields += slider(
        'kd',
        'D：近づく速さへの補正の強さ',
        3,
        0.1,
        '壁までの距離が急に減るほど、前進の指示を弱めます。0では使いません。大きくすると行き過ぎを抑えやすくなりますが、止まるまでが遅くなる場合があります。',
      );
  }
  if (active === 'challenge')
    fields =
      `<label class="control-select" for="controlScenario">走らせる条件<select id="controlScenario">${Object.entries(
        names,
      )
        .map(
          ([k, v]) =>
            `<option value="${k}" ${s.config.scenario === k ? 'selected' : ''}>${v}</option>`,
        )
        .join('')}</select></label>` + fields;
  return `<aside class="guide card control-guide"><p class="eyebrow">条件を決める</p><h2 id="controlGoal">${distance() ? '壁の50 cm手前で止める' : '車輪を' + s.config.targetRPM + ' rpmで回す'}</h2>${fields}<button id="controlRun" class="primary full">${s.result ? 'この設定でもう一度試す' : 'この設定で実験する'}</button><p id="controlRunStatus" class="helper" role="status">実験を始めると、16秒間の動きとグラフが一緒に進みます。途中で一時停止できます。</p><button id="controlReset" class="text-button">設定を初期値に戻す</button>${active === 'challenge' ? '<div id="controlBadges" class="control-badges"></div>' : ''}</aside>`;
}
function figureCopy() {
  return distance()
    ? '上から見たロボットと壁です。青いレンズ側が正面です。黄色の線は壁の50 cm手前に止まる位置、矢印は移動方向です。左右の車輪へ同じ回転数を指示し、直進と後退だけを行います。'
    : '横から見たロボットです。支持台で機体を支え、タイヤを床から離しています。車輪が回っても機体は進みません。画面の奥にあるもう一つの車輪にも同じ出力を与え、回転数センサーで速さを測ります。';
}
function explanation() {
  const specific = {
    output:
      'この実験では、あなたがモーターへの出力を%で指定し、回転数センサーが車輪の速さを測ります。車輪が加速するには時間がかかるので、指示を変えた直後からグラフを追ってみましょう。速さが落ち着いたときの値を比べると、目標に必要な出力を探せます。次の実験では、この関係を使って出力を計算します。',
    feedforward:
      'フィードフォワード（FF）は、機体について分かっている関係や目標から、必要な指示を計算する方法です。例えば表のように出力を2倍にすると回転数も2倍になる関係なら、「40%で40 rpm」という測定から、60 rpmには60%が必要と見積もれます。この実験では回転数を観察用に測りますが、その値をFFの出力計算には戻しません。負荷を見積もりに含めていなければ、負荷によるずれもそのまま残ります。',
    feedback:
      'フィードバック（FB）は、動いた結果を測り、目標とのずれを次の指示に反映する方法です。この教材では0.05秒ごとに測り直します。予定していなかった変化にも対応できますが、測定の遅れや強すぎる修正で行き過ぎることがあります。',
    combined:
      '見積もりの出力（FF）と、測定したずれから求めた修正（FB）を足して、モーターへ指示します。FFが回し続けるための出力を受け持ち、FBが残るずれを補います。組み合わせても自動的に最良になるわけではなく、行き過ぎや出力の上限も確認します。',
    p: '目標60 rpm・測定50 rpmなら、ずれは+10 rpm。この「目標−測定値」を偏差と呼びます。この教材のPを1.2にすると、Pの出力は+12%です。測定が70 rpmならずれは−10 rpm、出力は−12%で、逆向きに回そうとします。これは前の出力に毎回足す量ではなく、その時点のずれから計算し直す出力です。ずれが2倍なら出力も2倍になるので、比例（Proportional）の頭文字でPと呼びます。ただし出力には±100%の上限があります。ずれが0ならPの出力も0になり、回し続けるのに必要な出力を保てないため、Pだけでは遅い状態で落ち着くことがあります。',
    i: '例えば+10 rpmのずれが2秒続くと、積み重ねは10×2＝20 rpm・秒です。この教材でIが1なら、Iの補正はその間に20ポイント増え（例えば40%から60%へ）、Pの出力に加わります。これは出力上限による抑制がない場合の例です。ずれが0になれば増えなくなりますが、ためた補正は残って車輪を回し続けます。速すぎてずれが負になると、補正は減っていきます。この時間に沿った足し算を積分（Integral）と呼びます。ためた補正が大きいと、目標を越えてからも強い出力が残り、行き過ぎや揺れを起こすことがあります。',
    d: '壁までの距離が0.1秒で1.00 mから0.98 mへ減ったなら、変化の速さは(0.98−1.00)÷0.1＝−0.2 m/秒です。この教材ではDが1なら、フィルター処理前の補正は−20%となり、Pが出す前進の指示を弱めます。壁から離れて距離が増えると、補正の向きも反対になります。このように短い時間の変化から速さを求める考え方を微分（Derivative）と呼びます。Dは行き過ぎを抑える助けになりますが、Dだけでは止まっているときのずれを直せません。強すぎると接近が遅くなり、測定の小さな揺れにも反応します。',
    reference:
      '最終的に出したい速さへ、一度に目標を変える必要はありません。少しずつ目標を変えると、急な加速を抑えられます。その分、最終目標へ到達するまでに時間がかかる場合があります。「目標をどう作るか」と「その目標に合わせてどう制御するか」を分けて考えます。',
    limits:
      '計算で120%の出力が必要になっても、モーターへ送れるのは100%までです。3〜7秒に車輪が動けないと、ずれは減らず、Iの計算だけが増え続けることがあります。その補正が残ると、7秒後に負荷がなくなっても強い出力を出し、回り過ぎます。上限をさらに越える方向にはIをためない方法をアンチワインドアップと呼びます。Iを常に0にする機能ではなく、ためすぎる場面だけ積み増しを止めます。逆方向も−100%が下限です。',
    noise:
      'Dは測定値の変化を見るため、小さな測定ノイズにも反応します。フィルターは前までの変化の速さに今回の値を少しずつ混ぜ、揺れを弱めます。一方、本当の変化を反映するのも遅れます。この実験は0.05秒ごとに指示を計算します。フィルターの秒数を大きくすると、過去の値を長く残して変化をなめらかにするため、揺れの減り方と反応の遅れを一緒に確かめます。',
    challenge:
      '壁までの距離が0.50 mより大きければ手前、小さければ行き過ぎです。距離のずれは「測定した距離−0.50 m」とし、P・I・Dから左右の車輪へ送る回転数の割合を求めます。+100%なら前進80 rpm、−100%なら後退80 rpmです。達成には、10秒以内に距離0.45〜0.55 m・車輪−3〜+3 rpmへ入り、実験終了まで保つこと、行き過ぎが10 cm以下であることが必要です。最後の2秒のずれの平均も5 cm以下か確かめます。荷物ありは動きの反応が遅くなる条件で、同じ補正が効くとは限りません。',
  }[active];
  const ff = ['feedforward', 'combined', 'reference'].includes(active),
    intro = topic().group === 0;
  const flow =
    active === 'output'
      ? ['出力を決める', '車輪を回す', '速さを測る', '関係を調べる']
      : active === 'feedforward'
        ? ['目標を決める', '関係から出力を見積もる', '車輪を回す', '結果を観察する']
        : active === 'combined'
          ? ['目標からFFを計算', '測ったずれからFBを計算', '二つを足して指示', '動かして再び測る']
          : ['目標と測定を比べる', '修正する出力を計算', '車輪を動かす', 'もう一度測る'];
  return `<section class="card control-explanation"><h2>${active === 'output' ? '出力を変えた後、車輪はどう動く？' : '指示をどう決めている？'}</h2><p>${specific}</p>${controlConceptLesson(active)}<div class="control-loop" aria-label="制御の流れ">${flow.map((x, i) => (i ? '<b aria-hidden="true">→</b>' : '') + '<span>' + x + '</span>').join('')}</div><details data-help-dialog><summary>式と数値の扱いを見る</summary>${active === 'output' ? '<p>この実験は人が出力を決める操作です。自動で修正せず、指示を出して結果を観察する方法を開ループと呼びます。実際の機体では摩擦や電池の状態によって、出力と速さの関係も変わります。</p>' : `<p><strong>${active === 'feedforward' ? 'FFの出力（%）＝目標の回転数（rpm）×1 rpmあたりの出力' : active === 'feedback' ? '目標の回転数と測定値を比べて、次の出力を調整する' : active === 'combined' ? '指示＝FFの見積もり＋FBの修正' : ff ? '指示＝FFの見積もり＋Pの補正＋Iの補正＋Dの補正' : '指示＝Pの補正＋Iの補正＋Dの補正'}</strong></p>${ff ? '<p>このFFは一定の速さを保つ出力だけを見積もる簡略版です。加速に必要な出力、摩擦、既知の負荷も見積もりに加えられます。未来の実際の動きを知っているわけではありません。</p>' : ''}${!intro ? '<p>Pは今のずれ、Iは時間とともに積み重ねたずれ、Dは測定値の変化の速さを使います。各項に掛ける強さを「ゲイン」と呼びます。</p>' : ''}`}${intro ? '<p>画面の出力は、モーターに与える指示の大きさを%で表しています。0%は出力なし、100%はこの実験での最大、負の値は逆向きに回す指示です。車輪の速さがどう変わるかは、回転数センサーで確かめます。</p>' : `<p>${distance() ? '距離のずれは「測定した距離 − 0.5 m」。正なら前進、負なら後退を指示します。100%は左右とも80 rpmです。車輪の回転数制御の外側で、距離から目標回転数を決める構成を想定しています。' : '速さのずれは「目標の回転数 − 測定した回転数」。FBの計算では100 rpmを1として扱います。出力の負の値は逆回転です。回転数を指定できる駆動装置の内部の制御を簡略化しています。'}</p><p>出力は合計してから±100%に制限します。Dは目標の急変で大きな指示が出ないよう測定値の変化から計算します。制御周期は0.05秒、測定遅れは約0.1秒です。実機のゲインやFFの見積もりは、その機体で確かめます。</p>`}</details></section>`;
}
function calibrationCard() {
  return active === 'feedforward'
    ? `<section class="card control-calibration"><h2>事前に調べた、出力と回転数の関係</h2><p>標準の機体・負荷なしで、十分待って測ったシミュレーションの値です。</p><table><thead><tr><th>モーターへの出力</th>${calibration.map((x) => `<td>${x.power}%</td>`).join('')}</tr></thead><tbody><tr><th>車輪の回転数</th>${calibration.map((x) => `<td>${fmt(x.rpm, 0)} rpm</td>`).join('')}</tr></tbody></table><p>この計測から、初期設定では1 rpmにつき1%の出力を用意します。測る条件が変われば、この関係も変わります。</p></section>`
    : '';
}
function loadDescription(r = state().result, time = null) {
  const id = r?.id || active,
    c = r?.config || state().config;
  if (id === 'limits')
    return time === null
      ? '3〜7秒は車輪が動けない条件です。'
      : time >= 3 && time < 7
        ? '負荷が大きく、車輪が動けない'
        : time >= 7
          ? '負荷がなくなった'
          : '3〜7秒に大きな負荷を加える';
  if (distance()) return '目標より距離が小さいと、止まる位置を行き過ぎています。';
  const load = controlLoad(id, c);
  return load === 'nominal'
    ? '負荷は途中で変わりません。'
    : load === 'mismatch'
      ? '事前に調べた機体より回りにくい条件です。'
      : time === null
        ? '5秒で負荷が増えます。'
        : time >= 5
          ? '負荷が増えた状態'
          : '5秒後に負荷が増える';
}

function render() {
  stop();
  const t = topic(),
    s = state(),
    idx = CONTROL_TOPICS.indexOf(t);
  $('controlPage').innerHTML =
    `<div class="page-heading"><div><p class="eyebrow course-label">${lessonLabel('control')}</p><h1>${t.title}</h1></div></div>
 <nav class="basics-topics basics-groups" aria-label="学ぶ順序">${CONTROL_GROUPS.map((g, i) => `<button data-control-group="${i}" aria-pressed="${t.group === i}"><span>${i + 1}</span>${g}</button>`).join('')}</nav>
 <nav class="learning-subtopics" aria-label="この段階の制御実験">${CONTROL_TOPICS.filter(
   (x) => x.group === t.group,
 )
   .map(
     (x) =>
       `<button data-control-topic="${x.id}" aria-pressed="${active === x.id}">${x.name}</button>`,
   )
   .join('')}</nav>
 ${lessonBrief('control-' + active, t)}${schoolTips('control-' + active)}
 <div class="control-layout"><div class="control-workspace">${calibrationCard()}<section id="controlVisual" class="card control-visual"><div class="section-top"><h2>${distance() ? '距離を測って停止する' : '車輪の速さを測る'}</h2><span id="controlTime" class="control-time">実験前</span></div><canvas id="controlRobot" width="960" height="300" role="img" aria-label="${distance() ? '壁の手前で停止するロボットの図' : '横から見たロボット。支持台が機体を支え、タイヤと床の間にすき間があります'}"></canvas><div id="controlReadings" class="control-readings"></div><div id="controlContributions" class="control-contributions" hidden></div><div class="control-playbar"><button id="controlReplay" ${s.result ? '' : 'disabled'}>▶ 動きを最初から見る</button><label for="controlScrub" class="sr-only">確認する時刻（観察済みの範囲）</label><input id="controlScrub" type="range" min="0" max="320" value="${s.index}" ${s.result ? '' : 'disabled'}><label class="control-speed" for="controlSpeed">再生速度<select id="controlSpeed"><option value="1" ${playSpeed === 1 ? 'selected' : ''}>1倍</option><option value="2" ${playSpeed === 2 ? 'selected' : ''}>2倍</option></select></label></div><p class="figure-guide"><strong>図の見方</strong>${figureCopy()}</p></section>
 <section class="card control-graphs"><div class="section-top"><h2>時間とともに、値はどう変わった？</h2><label class="control-compare"><input id="controlCompare" type="checkbox" checked ${s.previous ? '' : 'disabled'}>前の実験と重ねる</label></div><div id="controlCharts"></div><p class="control-chart-note">横軸は実験開始からの時間、縦軸はグラフの見出しにある量です。緑が今回の値、黄色の破線が目標、灰色の線が前回の値と目標です。回転数は目標線より上なら速すぎ、壁までの距離は目標線より下なら近づきすぎです。同じ時刻で上の測定値と下の出力を見比べてください。線は表示中の時刻まで伸びます。<span id="controlLoadNote">${loadDescription()}</span></p></section>
 </div>${controls()}</div>
 <section id="controlResults" class="card control-results" ${s.result ? '' : 'hidden'}></section>
 ${explanation()}
 <section class="card control-question"><h2>結果を見て、次に何を一つ変える？</h2><p>${t.question}</p><details><summary>結果に合わせたヒントを見る</summary><p id="controlHint"></p></details><label for="controlNote">考えた理由を記録する <span>（任意・このタブを開いている間だけ保存）</span></label><textarea id="controlNote" rows="2" placeholder="例：負荷が増えてから遅くなった。測ったずれで修正できるか試したい。"></textarea></section>
 <details class="card control-history"><summary>この実験の記録を比べる <span id="controlHistoryCount"></span></summary><div id="controlHistory"></div></details>
 <details data-help-dialog class="card control-hardware"><summary>同じロボット・ROS 2で確かめるには</summary><div class="control-hardware-body"><h2>まず測定値を記録し、小さな指示から比べる</h2><p>この教材のロボットは、独立して回転数を制御できる左右の駆動輪、回転数センサー、9軸IMU、2D LiDAR、RGB画像も撮れるデプスカメラ1台を備えています。回転数制御には車輪の測定値、壁の手前で止まる制御にはLiDARを使いました。IMUで旋回や衝撃、RGB-Dカメラで目印と奥行きを確認できますが、この直進だけの計算には使っていません。</p><ol><li><strong>駆動装置の仕様を確認する。</strong>目標回転数を受け付ける装置は、すでに内部で回転数を制御している場合があります。その場合は、距離から目標回転数を決める外側の制御を試します。FFの実験では、出力指示やFF係数の設定に装置が対応しているか確認します。対応していなければ、まず回転数の応答を記録して比べます。</li><li><strong>先生と、停止操作・出力上限・通信切断時の停止を確認する。</strong>最初は機体を固定し、車輪を安全に浮かせた状態で、低い回転数から測ります。手で車輪を止める実験は行いません。</li><li><strong>時刻・目標・測定値・指示を同時に記録する。</strong>ROS 2の車輪の状態、LiDAR、制御指示をrosbag2などで記録します。トピック名と単位は機体ごとに確認します。rad/sをrpmに直すには60÷(2π)を掛けます。</li><li><strong>条件を一つ変えて比較する。</strong>出力を指定できる装置では、条件を揃えて複数の出力と安定した回転数を記録し、FFの見積もりを作ります。その見積もりを別の目標・負荷でも確かめます。回転数のずれや行き過ぎを確認してから、安全な空間で距離の制御へ進みます。LiDARが測れない場合や大きな衝撃を検知した場合に止める処理は、PIDとは別に設けます。</li></ol><p>ブラウザの「実験データを保存」で、比較用のCSVと設定記録を持ち出せます。実機ではシミュレーションのような「実際の正しい値」は通常得られません。計測誤差や記録周期を確認してから比べてください。この画面から実機への指示は送りません。</p><p class="helper">モデルの範囲：平面での直進、左右の車輪は同じ応答、車輪半径6.5 cm。モーターの遅れ・出力上限・測定遅れを簡略化し、滑り、電池電圧、通信のばらつきは省略しています。荷物ありは車輪の応答が遅くなる条件です。実機の安全を保証するモデルではありません。</p><p class="control-sources">参考：<a href="https://docs.wpilib.org/en/stable/docs/software/advanced-controls/controllers/combining-feedforward-feedback.html" target="_blank" rel="noopener noreferrer">WPILib：FFとFBの組み合わせ</a> · <a href="https://docs.wpilib.org/en/stable/docs/software/advanced-controls/controllers/pidcontroller.html" target="_blank" rel="noopener noreferrer">WPILib：PID制御</a> · <a href="https://control.ros.org/master/doc/ros2_controllers/pid_controller/doc/userdoc.html" target="_blank" rel="noopener noreferrer">ros2_control：PID Controller（開発版の資料）</a></p></div></details>
 <div class="basics-footer"><p>${idx + 1} / ${CONTROL_TOPICS.length} の実験 · 設定と結果は教材を切り替えても残ります。</p><button id="controlNext" class="primary">${idx < CONTROL_TOPICS.length - 1 ? '次へ：' + CONTROL_TOPICS[idx + 1].name : '小テストで確かめる →'}</button></div>`;
  bind();
  $('controlNote').value = s.note || '';
  renderResult();
  drawFrame();
  stop();
  if (dirty()) changed();
}
function bind() {
  bindControlConcept(active);
  document
    .querySelectorAll('[data-control-group]')
    .forEach(
      (b) =>
        (b.onclick = () =>
          selectTopic(CONTROL_TOPICS.find((t) => t.group === Number(b.dataset.controlGroup)).id)),
    );
  document
    .querySelectorAll('[data-control-topic]')
    .forEach((b) => (b.onclick = () => selectTopic(b.dataset.controlTopic)));
  document.querySelectorAll('[data-control-setting]').forEach(
    (input) =>
      (input.oninput = () => {
        const key = input.dataset.controlSetting;
        state().config[key] = Number(input.value);
        $('control-' + key + '-value').textContent = fmt(
          input.value,
          ['power', 'targetRPM'].includes(key) ? 0 : 2,
        );
        changed();
      }),
  );
  document.querySelectorAll('[name="controlFeedback"]').forEach(
    (input) =>
      (input.onchange = () => {
        state().config.feedback = input.value === 'on';
        $('controlFixedPower').hidden = state().config.feedback;
        changed();
      }),
  );
  document.querySelectorAll('[name="controlProfile"]').forEach(
    (input) =>
      (input.onchange = () => {
        state().config.profile = input.value;
        changed();
      }),
  );
  for (const [id, key] of [
    ['controlLoadCase', 'loadCase'],
    ['controlStrategy', 'strategy'],
  ])
    if ($(id))
      $(id).onchange = () => {
        state().config[key] = $(id).value;
        changed();
      };
  if ($('controlAntiWindup'))
    $('controlAntiWindup').onchange = () => {
      state().config.antiWindup = $('controlAntiWindup').checked;
      changed();
    };
  if ($('controlScenario'))
    $('controlScenario').onchange = () => {
      state().config.scenario = $('controlScenario').value;
      changed();
    };
  $('controlRun').onclick = run;
  $('controlReset').onclick = () => {
    state().config = controlDefaults(active);
    render();
    changed();
  };
  $('controlCompare').onchange = () => {
    renderCharts();
    drawFrame();
  };
  $('controlNext').onclick = () => {
    const i = CONTROL_TOPICS.findIndex((t) => t.id === active);
    if (i === CONTROL_TOPICS.length - 1)
      document.dispatchEvent(new CustomEvent('quiz-open', { detail: 'control' }));
    else selectTopic(CONTROL_TOPICS[i + 1].id);
  };
  $('controlNote').oninput = () => {
    state().note = $('controlNote').value;
  };
  $('controlScrub').oninput = () => {
    stop();
    state().index = Math.min(state().observedMax, Math.max(0, Number($('controlScrub').value)));
    $('controlScrub').value = String(state().index);
    drawFrame();
  };
  $('controlReplay').onclick = () => {
    if (playing) stop();
    else startPlayback();
  };
  $('controlSpeed').onchange = () => {
    const resume = playing;
    stop();
    playSpeed = Number($('controlSpeed').value) === 2 ? 2 : 1;
    if (resume) startPlayback();
  };
}
function selectTopic(id) {
  stop();
  active = id;
  render();
  $('controlPage').scrollIntoView({ block: 'start', behavior: 'instant' });
}
function changed() {
  stop();
  $('controlGoal').textContent = distance()
    ? '壁の50 cm手前で止める'
    : '車輪を' + state().config.targetRPM + ' rpmで回す';
  $('controlRunStatus').textContent = dirty()
    ? '設定を変更しました。グラフは前の設定の結果です。もう一度実験すると更新します。'
    : state().result
      ? 'グラフは表示中の設定で実験した結果です。'
      : '条件を決めたら、実験ボタンを押してください。';
  if (!state().result) {
    renderCharts();
    drawFrame();
  }
  updateBadges();
}
function run() {
  stop();
  const s = state();
  s.config = normalizeControlConfig(active, s.config);
  s.previous =
    [...s.runs]
      .reverse()
      .find(
        (r) =>
          r.config.scenario === s.config.scenario &&
          r.config.loadCase === s.config.loadCase &&
          r.config.targetRPM === s.config.targetRPM,
      ) ||
    s.runs.at(-1) ||
    null;
  s.result = simulateControl(active, s.config);
  s.index = 0;
  s.observedMax = 0;
  s.complete = false;
  $('controlScrub').disabled = false;
  $('controlScrub').max = '320';
  $('controlScrub').value = '0';
  $('controlReplay').disabled = false;
  $('controlCompare').disabled = !s.previous;
  $('controlRun').textContent = 'この設定でもう一度試す';
  renderResult();
  const bounds = $('controlVisual').getBoundingClientRect();
  if (bounds.top < 80 || bounds.top > window.innerHeight - 200)
    $('controlVisual').scrollIntoView({ block: 'start', behavior: 'instant' });
  startPlayback();
}
function tick() {
  if (!playing) return;
  const s = state(),
    last = s.result.samples.length - 1;
  s.index = Math.min(
    last,
    Math.floor((((performance.now() - playStart) / 1000) * playSpeed) / 0.05) + playFrom,
  );
  s.observedMax = Math.max(s.observedMax, s.index);
  $('controlScrub').value = String(s.index);
  if (s.index >= last) {
    completeRun();
    stop();
  } else raf = requestAnimationFrame(tick);
  drawFrame();
}
function gainText(c) {
  if (active === 'output') return '一定出力 ' + c.power + '%';
  if (active === 'feedforward')
    return 'FF ' + fmt(c.ffGain, 2) + ' %/rpm・目標 ' + c.targetRPM + ' rpm';
  if (active === 'combined')
    return (
      methodNames[c.strategy] +
      (c.strategy === 'feedback' ? '' : '・FF ' + fmt(c.ffGain, 2) + ' %/rpm') +
      '・目標 ' +
      c.targetRPM +
      ' rpm'
    );
  if (active === 'reference')
    return c.profile === 'ramp' ? '目標を3秒かけて変える' : '目標を一度に変える';
  return active === 'feedback'
    ? c.feedback
      ? '測って調整'
      : '一定出力 ' + c.power + '%'
    : active === 'limits'
      ? 'Iの抑制 ' + (c.antiWindup ? 'あり' : 'なし')
      : active === 'noise'
        ? 'フィルター ' + fmt(c.filter, 2) + '秒'
        : `P ${fmt(c.kp)} / I ${fmt(c.ki)} / D ${fmt(c.kd)}`;
}
function metricText(r) {
  const m = r.metrics;
  return [
    fmt(m.finalError * (r.mode === 'distance' ? 100 : 1)) +
      (r.mode === 'distance' ? ' cm' : ' rpm'),
    fmt(m.overshoot * (r.mode === 'distance' ? 100 : 1)) + (r.mode === 'distance' ? ' cm' : ' rpm'),
    m.settling === null ? '落ち着かず' : fmt(m.settling) + ' 秒',
  ];
}
function renderResult() {
  const s = state(),
    r = s.complete ? s.result : null;
  $('controlResults').hidden = !r;
  if (!r) $('controlResults').innerHTML = '';
  renderCharts();
  if (r) {
    const [error, over, settle] = metricText(r),
      m = r.metrics;
    $('controlResults').innerHTML =
      `<div class="control-result-heading"><div><p class="eyebrow">結果を見る · ${s.runs.length}回目</p><h2>${active === 'challenge' ? (m.passed ? 'この条件は達成しました' : 'この条件を、もう少し改善しよう') : '何が変わったかをデータで確かめる'}</h2><p>${gainText(r.config)}${active === 'challenge' ? ' · ' + names[r.config.scenario] : ['feedforward', 'combined'].includes(active) ? ' · ' + loadNames[r.config.loadCase] : ''}</p></div><button id="controlExport">実験データを保存</button></div><div class="control-metrics"><div><span>最後の2秒のずれ</span><strong>${error}</strong><small>実際の値と目標との差の大きさの平均</small></div><div><span>最大の行き過ぎ</span><strong>${over}</strong><small>${distance() ? '50 cmより壁に近づいた量' : r.target + ' rpmを上回った量'}（実験全体）</small></div><div><span>${distance() ? '停止するまで' : m.after ? '負荷が変わってから落ち着くまで' : '目標に落ち着くまで'}</span><strong>${settle}</strong><small>${distance() ? '距離±5 cm・回転数±3 rpm内を保つ' : m.after + '秒以降、' + r.target + '±3 rpm内を保つ'}</small></div></div>${active === 'reference' ? `<p class="control-result-note">最大の加速・減速の大きさ：<strong>${fmt(m.peakAcceleration)} rpm/秒</strong>。回転数が1秒あたりどれだけ変わる勢いかを、隣り合う測定時刻の実際の回転数から計算します。</p>` : ''}${active === 'combined' ? methodComparison() : ''}${active === 'noise' ? `<p class="control-result-note">1回の更新で指示が変わった量：平均 <strong>${fmt(m.chatter)}ポイント</strong>。下の出力グラフと合わせ、細かな指示の揺れを比較します。</p>` : ''}${r.collision ? '<p class="control-alert">壁との距離が12 cm以下になり、シミュレーションを停止しました。次の実験は開始位置からやり直します。</p>' : ''}<p class="control-result-note">${hint(r)}</p><p class="helper">「最後の2秒のずれ」は14〜16秒の差の大きさの平均、「最大の行き過ぎ」は実験中で目標を最も越えた量です。「落ち着くまで」は、その後ずっと条件内に収まった時点までの時間です。最後の瞬間だけ合っても、落ち着いたとは数えません。グラフは測定値、これらの指標はシミュレーション内の実際の値から計算するため、測定の揺らぎがあると見た目と少し違います。</p>${active === 'challenge' ? '<p class="helper">達成条件：10秒以内に停止し、その後も停止条件を保つ・行き過ぎ10 cm以下・最後の2秒のずれ5 cm以下。</p>' : ''}`;
    $('controlExport').onclick = () => download(r);
  }
  $('controlHint').textContent = r
    ? hint(r)
    : s.result
      ? '実験が終わると、測定したデータに合わせてヒントを表示します。'
      : 'まず初期設定のままで実験してください。結果が出ると、測定したデータに合わせてヒントを表示します。';
  $('controlHistoryCount').textContent = `（${s.runs.length}回）`;
  $('controlHistory').innerHTML = s.runs.length
    ? `<p>下ほど新しい実験です。前の実験の線は、条件が同じ直前の結果を優先し、なければ直前の結果を使います。グラフ上部で前の条件を確認できます。</p><div class="control-table-scroll"><table><thead><tr><th>回</th><th>設定</th><th>最後のずれ</th><th>行き過ぎ</th><th>落ち着くまで</th></tr></thead><tbody>${s.runs
        .map(
          (r, i) =>
            `<tr><td>${i + 1}</td><td>${gainText(r.config)}${active === 'challenge' ? '・' + names[r.config.scenario] : ['feedforward', 'combined'].includes(active) ? '・' + loadNames[r.config.loadCase] : ''}</td>${metricText(
              r,
            )
              .map((v) => `<td>${v}</td>`)
              .join('')}</tr>`,
        )
        .join('')}</tbody></table></div>`
    : '<p>実験すると、設定と結果がここに記録されます。</p>';
  updateBadges();
}
function methodComparison() {
  const s = state(),
    r = s.result,
    match = (x) =>
      x.config.targetRPM === r.config.targetRPM &&
      x.loadCase === r.loadCase &&
      x.config.ffGain === r.config.ffGain &&
      x.config.kp === r.config.kp &&
      x.config.ki === r.config.ki;
  return `<div class="control-method-comparison"><h3>同じ条件で3方式を比べる</h3><p>目標${r.target} rpm・${loadNames[r.loadCase]}。係数も同じ実験を並べます。</p><div class="control-table-scroll"><table><thead><tr><th>指示の決め方</th><th>1秒後の回転数</th><th>最後のずれ</th><th>最大の行き過ぎ</th></tr></thead><tbody>${[
    'feedforward',
    'feedback',
    'both',
  ]
    .map((method) => {
      const item = [...s.runs].reverse().find((x) => x.method === method && match(x));
      return `<tr><th>${methodNames[method]}</th>${item ? `<td>${fmt(item.samples[20].actual)} rpm</td><td>${fmt(item.metrics.finalError)} rpm</td><td>${fmt(item.metrics.overshoot)} rpm</td>` : '<td colspan="3">まだ試していません</td>'}</tr>`;
    })
    .join('')}</tbody></table></div></div>`;
}

function hint(r) {
  const m = r.metrics;
  if (active === 'output')
    return m.finalError < 3
      ? '60 rpmに近づきました。別の出力も試し、回転数との関係を調べたら、次はその関係を出力の見積もりに使います。'
      : r.samples.at(-1).actual < r.target
        ? '目標より遅く回っています。出力を少し増やしたとき、結果がどれだけ変わるか比べましょう。'
        : '目標より速く回っています。出力を少し下げて、60 rpmに近づけてみましょう。';
  if (active === 'feedforward')
    return m.finalError < 3
      ? 'この条件では見積もりが合いました。次は目標だけを変え、さらに負荷や機体の条件も変えて、関係がいつまで使えるか確かめましょう。'
      : '見積もりと実際が合わず、ずれが残っています。目標と係数が同じなら、FFの指示は変わりません。見積もりを直す方法と、測ったずれで補う方法を考えます。';
  if (active === 'combined' && r.method === 'feedforward' && m.finalError < 3)
    return 'この条件では、FFの見積もりだけで目標に近づきました。負荷が増える条件でも同じように動くか試し、必要な修正を考えましょう。';
  if (active === 'combined')
    return r.method === 'feedforward'
      ? 'FFだけでは、見積もりに含まれない変化によるずれを修正できません。同じ条件で、ずれを測って直す方式も試しましょう。'
      : r.method === 'feedback'
        ? '測ったずれを使って出力を作っています。次はFFも加え、最初の1秒と、5秒以降の動き、行き過ぎを比べましょう。'
        : '出力の内訳で、FFが用意した出力にFBの修正が加わる様子を確認します。速く近づいても、行き過ぎが増える場合があります。次の段階で修正の強さを調べます。';
  if (active === 'reference')
    return r.config.profile === 'step'
      ? '急に目標を変えたときの加速の大きさを確認します。目標を3秒かけて変えると、車輪の速さと到着までの時間はどう変わるでしょう。'
      : '最大の加速と、最終目標に落ち着くまでの時間を前回と比べます。目標をゆっくり変えることで得られる良さと、時間のかかり方を考えましょう。';
  if (r.collision)
    return '壁に近づき過ぎました。PやIを強くし過ぎていないかを確認し、Dで近づく勢いを抑える設定も試してください。';
  if (active === 'feedback')
    return r.config.feedback
      ? '測定した速さが下がると出力が増え、目標へ戻っています。出力を一定にした実験と重ねて、5秒以降を比べましょう。'
      : '出力は一定でも、負荷が増えると回転数が下がっています。「測って調整する」に切り替えると、出力の線はどう変わるでしょう。';
  if (active === 'p')
    return m.finalError > 3
      ? '目標より遅いままです。Pを少し上げて比べてください。Pを大きくするだけで、ずれと揺れの両方を小さくできるでしょうか。'
      : '目標に近づきました。出力が頻繁に上下していないかも確かめましょう。';
  if (active === 'i')
    return r.config.ki === 0
      ? 'Pだけではずれが残っています。Iを少し加えると、目標に届くまで出力がどう変わるか試しましょう。'
      : m.overshoot > 8
        ? '目標を越えて回っています。Iを少し弱め、目標に近づく時間も比べてください。'
        : '残るずれが小さくなりました。Iを変える前の線と重ねて、負荷が増えた後に目標へ戻る様子を確認してください。';
  if (active === 'limits')
    return r.config.antiWindup
      ? 'Iの補正を抑える前と、7秒後の行き過ぎを比べましょう。下のグラフで「Iの補正」も表示できます。'
      : '3〜7秒は出力が上限に達しています。下のグラフで「Iの補正」を表示すると、出せない出力がたまる様子を確認できます。';
  if (active === 'noise')
    return r.config.filter === 0
      ? '距離の揺らぎが小さくても、出力は細かく上下しています。フィルターを0.2秒程度に変えて比べてください。'
      : '出力の揺れが減ったか、前の線と重ねて見ます。フィルターをさらに強めたら、止まるまでの時間も確認してください。';
  if (m.overshoot > 0.1)
    return '止まる位置を10 cm以上行き過ぎています。まずDを少し加え、近づく勢いを抑えられるか試してみましょう。';
  if (m.settling === null || m.settling > 10)
    return '落ち着くまでに時間がかかっています。Pが弱すぎる場合と、Dが強すぎる場合があります。一つずつ変更して比べてください。';
  if (active === 'challenge')
    return 'この条件では達成です。設定を保ったまま、まだ確かめていない条件に切り替えてください。';
  return '行き過ぎと停止までの時間を、Dを加える前と比べましょう。Dを強くし過ぎた場合も確かめると、調整の限界が分かります。';
}
function updateBadges() {
  if (active !== 'challenge' || !$('controlBadges')) return;
  const s = state(),
    key = configKey(s.config),
    ok = new Set(
      s.runs
        .filter((r) => r.metrics.passed && configKey(r.config) === key)
        .map((r) => r.config.scenario),
    );
  $('controlBadges').innerHTML =
    `<strong>この設定で達成 ${ok.size} / 3</strong><p>設定を変えたら、各条件をもう一度確かめます。</p>${Object.entries(
      names,
    )
      .map(
        ([k, v]) =>
          `<span class="${ok.has(k) ? 'achieved' : ''}">${ok.has(k) ? '✓' : '○'} ${v}</span>`,
      )
      .join(
        '',
      )}${ok.size === 3 ? '<p><strong>3条件で停止できました。</strong>達成した設定と、効いた変更を記録しておきましょう。</p>' : ''}`;
}
function chart(
  r,
  previous,
  key,
  { title, unit, target = false, extra = false, breakdown = false },
) {
  const W = Math.max(320, Math.min(740, ($('controlCharts').clientWidth || 740) - 32)),
    H = 224,
    left = 58,
    right = 20,
    top = 28,
    bottom = 36,
    w = W - left - right,
    h = H - top - bottom;
  const fallback = distance() ? 0.5 : state().config.targetRPM;
  const values = r
    ? [
        ...r.samples.map((s) => s[key]),
        ...(previous ? previous.samples.map((s) => s[key]) : []),
        ...(target ? r.samples.map((s) => s.target) : []),
        ...(target && previous ? previous.samples.map((s) => s.target) : []),
        ...(extra ? r.samples.map((s) => s.i) : []),
        ...(breakdown ? r.samples.flatMap((s) => [s.ff, s.correction]) : []),
      ]
    : [0, distance() ? 1.6 : fallback];
  let min = Math.min(0, ...values),
    max = Math.max(...values);
  if (max - min < 1e-5) max = min + 1;
  const step = key === 'command' ? 25 : distance() ? 0.5 : 20;
  max = Math.ceil((max + 1e-6) / step) * step;
  min = Math.floor(min / step) * step;
  if (key === 'command' && !extra && !breakdown) max = 100;
  const x = (t) => left + (t / 16) * w,
    y = (v) => top + ((max - v) / (max - min)) * h,
    path = (data, k) =>
      data
        .map((s, i) => (i ? 'L' : 'M') + x(s.time).toFixed(2) + ',' + y(s[k]).toFixed(2))
        .join(' ');
  const clip =
    key === 'measured' ? 'url(#control-reveal-measured)' : 'url(#control-reveal-command)';
  const hasLoad = (r ? r.loadCase : controlLoad(active, state().config)) === 'drag';
  const event =
    active === 'limits'
      ? `<rect x="${x(3)}" y="${top}" width="${x(7) - x(3)}" height="${h}" fill="#e4c18b" opacity=".2"/>`
      : !distance() && hasLoad
        ? `<line x1="${x(5)}" y1="${top}" x2="${x(5)}" y2="${top + h}" stroke="#b77c34" stroke-dasharray="3 4"/>`
        : '';
  const reference = r
    ? path(r.samples, 'target')
    : `M${left},${y(fallback)}L${W - right},${y(fallback)}`;
  return `<div class="control-chart"><h3>${title}<span>${unit}</span></h3><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}。横軸は0から16秒、縦軸は${unit}。${r ? '表示中の時刻まで測定値を表示します。実験終了後に結果をまとめます。' : '実験するとグラフを表示します。'}">${event}${[
    0, 0.5, 1,
  ]
    .map((a) => {
      const v = min + (max - min) * a;
      return `<line x1="${left}" y1="${y(v)}" x2="${W - right}" y2="${y(v)}" stroke="#dbe4e6"/><text x="${left - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v, max - min < 4 ? 1 : 0)}</text>`;
    })
    .join(
      '',
    )}${[0, 4, 8, 12, 16].map((t) => `<text x="${x(t)}" y="${H - 10}" text-anchor="middle">${t}秒</text>`).join('')}${target ? `${previous ? `<path d="${path(previous.samples, 'target')}" fill="none" stroke="#a3adb8" stroke-width="1.5" stroke-dasharray="9 6"/>` : ''}<path d="${reference}" fill="none" stroke="#af8136" stroke-width="2" stroke-dasharray="7 5"/><text x="${W - right}" y="${y(r ? r.target : fallback) - 7}" text-anchor="end">${active === 'reference' ? '最終目標' : '目標'} ${distance() ? '0.50 m' : (r ? r.target : fallback) + ' rpm'}</text>` : ''}${r ? `${previous ? `<path d="${path(previous.samples, key)}" fill="none" stroke="#a3adb8" stroke-width="2.5" stroke-dasharray="4 3"/>` : ''}<defs><clipPath id="control-reveal-${key}"><rect class="control-chart-reveal" data-plot-width="${w}" x="${left - 2}" y="0" width="${(r.samples[state().index].time / 16) * w + 2}" height="${H}"/></clipPath></defs><g clip-path="${clip}"><path d="${path(r.samples, key)}" fill="none" stroke="#38786e" stroke-width="2.5" stroke-linejoin="round"/>${extra ? `<path d="${path(r.samples, 'i')}" fill="none" stroke="#9367a3" stroke-width="2"/>` : ''}${breakdown ? `<path d="${path(r.samples, 'ff')}" fill="none" stroke="#9367a3" stroke-width="2"/><path d="${path(r.samples, 'correction')}" fill="none" stroke="#5d81b7" stroke-width="2" stroke-dasharray="2 3"/>` : ''}</g><line class="control-chart-cursor" data-plot-width="${w}" x1="${x(state().index * 0.05)}" x2="${x(state().index * 0.05)}" y1="${top}" y2="${top + h}" stroke="#173d4d" stroke-width="1" opacity=".5"/>` : `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">実験すると、測定値を表示します</text>`}</svg></div>`;
}
function renderCharts() {
  const s = state(),
    r = s.result,
    prev = $('controlCompare').checked ? s.previous : null,
    breakdown = active === 'combined';
  $('controlCharts').innerHTML =
    `<div class="control-chart-legend"><span class="measured">今回の測定値</span><span class="target">今回の目標</span>${prev ? '<span class="previous">前の測定値・目標</span>' : ''}</div>${prev ? `<p class="control-previous-note">前の実験：${gainText(prev.config)}${['feedforward', 'combined'].includes(active) ? '・' + loadNames[prev.loadCase] : ''}</p>` : ''}${chart(r, prev, 'measured', { title: distance() ? '壁までの距離' : '車輪の回転数', unit: distance() ? 'm' : 'rpm', target: true })}<details ${['output', 'feedforward', 'combined', 'feedback', 'limits', 'noise', 'reference'].includes(active) ? 'open' : ''}><summary>${distance() ? '車輪へ指示した回転数の割合' : 'モーターへの出力'}を見る</summary><p>${active === 'limits' ? '色の付いた3〜7秒は車輪が動けない期間です。Iの補正は、出力の上限を越えてたまる場合があります。' : distance() ? '100%は80 rpm。負の指示は後退です。' : '100%が最大出力、負の指示は逆回転です。'}${active === 'limits' ? '<label class="control-compare"><input id="controlShowI" type="checkbox">Iの補正も表示する（紫）</label>' : ''}</p>${breakdown ? '<div class="control-chart-legend"><span class="measured">実際の指示</span><span class="ff-line">見積もり FF</span><span class="fb-line">ずれの修正 FB</span></div>' : ''}<div id="controlCommandGraph">${chart(r, prev, 'command', { title: distance() ? '車輪への指示' : 'モーターへの出力', unit: '%', breakdown })}</div></details>`;
  if ($('controlShowI'))
    $('controlShowI').onchange = () => {
      $('controlCommandGraph').innerHTML = chart(r, prev, 'command', {
        title: '出力とIの補正',
        unit: '%',
        extra: $('controlShowI').checked,
      });
    };
  if ($('controlLoadNote')) $('controlLoadNote').textContent = loadDescription();
}

function drawFrame() {
  const s = state(),
    r = s.result,
    frame = r?.samples[s.index] || {
      time: 0,
      actual: distance() ? 1.6 : 0,
      measured: distance() ? 1.6 : 0,
      command: 0,
      rpm: 0,
    },
    c = $('controlRobot');
  // Keep enough backing pixels for zoom / high-density screens; CSS keeps the aspect ratio.
  const compact = (c.clientWidth || 960) < 600,
    logicalWidth = compact ? 480 : 960,
    logicalHeight = distance() ? (compact ? 240 : 300) : 340;
  const width = Math.max(
      logicalWidth,
      Math.round((c.clientWidth || 960) * (window.devicePixelRatio || 1)),
    ),
    height = Math.round((width * logicalHeight) / logicalWidth);
  if (c.width !== width || c.height !== height) {
    c.width = width;
    c.height = height;
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(width / logicalWidth, 0, 0, height / logicalHeight, 0, 0);
  ctx.fillStyle = '#182d38';
  ctx.fillRect(0, 0, logicalWidth, logicalHeight);
  ctx.font = '20px system-ui';
  if (!distance()) {
    drawControlBench(ctx, {
      compact,
      angle: r ? controlWheelAngle(r.samples, s.index) : 0,
      measured: frame.measured,
      started: !!r,
      blocked: frame.blocked,
      description: loadDescription(r, frame.time),
    });
  } else if (compact) {
    drawCompact(ctx, frame);
  } else if (distance()) {
    const wall = 845,
      scale = 370,
      x = wall - frame.actual * scale;
    ctx.fillStyle = '#526574';
    ctx.fillRect(wall, 36, 32, 222);
    ctx.fillStyle = '#cedce0';
    ctx.fillText('壁', 848, 28);
    ctx.strokeStyle = '#425864';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(70, 212);
    ctx.lineTo(wall, 212);
    ctx.stroke();
    ctx.strokeStyle = '#e3c078';
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(wall - 0.5 * scale, 44);
    ctx.lineTo(wall - 0.5 * scale, 244);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#e3c078';
    ctx.fillText('停止する位置', wall - 0.5 * scale - 66, 275);
    drawRobot(ctx, { x, y: 150 }, { theta: 0, left: frame.rpm, right: frame.rpm });
    ctx.strokeStyle = '#98d6cc';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 96);
    ctx.lineTo(wall, 96);
    ctx.stroke();
    ctx.fillStyle = '#cae6e2';
    ctx.fillText(
      'LiDARで測る距離 ' + fmt(frame.measured, 2) + ' m',
      Math.max(40, Math.min(540, x + 30)),
      73,
    );
    if (Math.abs(frame.rpm) > 3) {
      const dir = Math.sign(frame.rpm);
      ctx.strokeStyle = dir > 0 ? '#9bdcc6' : '#edb467';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x, 230);
      ctx.lineTo(x + dir * 60, 230);
      ctx.lineTo(x + dir * 48, 222);
      ctx.moveTo(x + dir * 60, 230);
      ctx.lineTo(x + dir * 48, 238);
      ctx.stroke();
    }
  }
  timeLabel();
  $('controlReadings').innerHTML =
    `<div><span>${active === 'reference' ? 'いまの目標' : '目標'}</span><strong>${distance() ? '0.50 m' : fmt(r ? frame.target : state().config.targetRPM, 0) + ' rpm'}</strong></div><div><span>${topic().sensor}</span><strong>${r ? fmt(frame.measured, distance() ? 2 : 1) : '—'} ${distance() ? 'm' : 'rpm'}</strong></div><div><span>${distance() ? '左右の車輪の回転数' : 'モーターへの出力'}</span><strong>${r ? fmt(distance() ? frame.rpm : frame.command) : '—'} ${distance() ? 'rpm' : '%'}</strong></div>`;
  const contributions = $('controlContributions');
  contributions.hidden = !['feedforward', 'combined'].includes(active);
  contributions.innerHTML = r
    ? active === 'feedforward'
      ? `<span>目標 <strong>${fmt(frame.target, 0)} rpm</strong></span><b>×</b><span>1 rpmあたり <strong>${fmt(r.config.ffGain, 2)}%</strong></span><b>→</b><span>出力 <strong>${fmt(frame.command)}%</strong></span>${frame.ff > 100 ? '<small>見積もりが100%を越えるため、出力を上限に制限しています。</small>' : ''}`
      : `<span>見積もり FF <strong>${fmt(frame.ff)}%</strong></span><b>＋</b><span>ずれの修正 FB <strong>${fmt(frame.correction)}%</strong></span><b>→</b><span>出力 <strong>${fmt(frame.command)}%</strong></span>${Math.abs(frame.ff + frame.correction) > 100 ? '<small>合計が上限を越えるため、出力を制限しています。</small>' : ''}`
    : '実験すると、見積もりと修正の内訳をここに表示します。';
  playbackLabel();
  document
    .querySelectorAll('.control-chart-reveal')
    .forEach((el) =>
      el.setAttribute('width', (frame.time / 16) * Number(el.getAttribute('data-plot-width')) + 2),
    );
  document.querySelectorAll('.control-chart-cursor').forEach((el) => {
    const x = 58 + (frame.time / 16) * Number(el.getAttribute('data-plot-width'));
    el.setAttribute('x1', x);
    el.setAttribute('x2', x);
  });
}
function drawCompact(ctx, frame) {
  ctx.font = '18px system-ui';
  ctx.fillStyle = '#c7dce0';
  if (distance()) {
    const wall = 440,
      scale = 215,
      x = wall - frame.actual * scale;
    ctx.fillText('LiDARで壁までの距離を測る', 20, 30);
    ctx.fillStyle = '#637b86';
    ctx.fillRect(wall, 52, 16, 154);
    ctx.strokeStyle = '#e3c078';
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(wall - 0.5 * scale, 55);
    ctx.lineTo(wall - 0.5 * scale, 206);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#e3c078';
    ctx.fillText('50 cm手前', wall - 0.5 * scale - 53, 229);
    drawRobot(ctx, { x, y: 145 }, { theta: 0, left: frame.rpm, right: frame.rpm });
    ctx.strokeStyle = '#92cfbc';
    ctx.beginPath();
    ctx.moveTo(x, 85);
    ctx.lineTo(wall, 85);
    ctx.stroke();
    ctx.fillStyle = '#c7dce0';
    ctx.fillText(fmt(frame.measured, 2) + ' m', Math.min(x, 360), 70);
  }
}

function download(r) {
  const save = (contents, type, name) => {
    const url = URL.createObjectURL(new Blob([contents], { type })),
      a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  save(controlCSV(r), 'text/csv;charset=utf-8', `QUESTiX-LAB-control-${r.id}.csv`);
  // The CSV contains simulation readings and the configuration used for this run.
  $('controlRunStatus').textContent =
    `CSVを保存しました。設定：${gainText(r.config)}。記録欄にも設定と結果が残っています。`;
}
function activateControl() {
  renderCharts();
  drawFrame();
}
function reviewControl(id) {
  if (!CONTROL_TOPICS.some((t) => t.id === id)) return false;
  selectTopic(id);
  return true;
}
function initControl() {
  render();
  document.addEventListener('series-leave', stop);
  document.addEventListener('supplement-open', stop);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
  });
  window.addEventListener('resize', () => {
    if (!$('controlPage').hidden) {
      renderCharts();
      drawFrame();
    }
  });
}

export { activateControl, reviewControl, initControl };
