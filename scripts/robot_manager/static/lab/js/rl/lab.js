import { lessonGuide, figureGuide } from '../shell/lesson-guide.js';
import { experimentSteps, sensorTabs, SENSOR_COPY } from '../shell/lesson-ui.js';
import { World, COURSES, DEFAULT_REWARD, FEATURE_NAMES } from '../core/engine.js';
import { drawArena, drawCamera, drawTrajectory, drawStartMap } from '../core/renderer.js';
import { drawLidar, drawGraph, graphSpec } from './sensors.js';
import { Experiment, clone, statistics, resultName, REWARDS } from './experiment.js';

let supplementOpen = false,
  missionGoal = '';
const $ = (id) => document.getElementById(id),
  $$ = (s) => [...document.querySelectorAll(s)],
  wait = () => new Promise((r) => setTimeout(r, 0));
const sessions = new Map(),
  taskCourses = new Map(),
  arena = $('arena'),
  camera = $('cameraView');
const labVisible = () => !$('introPage').hidden && !$('labPage').hidden;
let experiment = null,
  world = null,
  stage = 'setup',
  busy = false,
  token = 0,
  playback = null,
  displayFrame = null,
  shownTrace = [],
  sensor = 'lidar',
  imuView = 'impact',
  manual = false,
  manualStop = false,
  command = [0, 0],
  manualHistory = [],
  lastTick = 0,
  manualAccumulator = 0,
  playing = false,
  selectedTrial = null,
  chartMetric = 'score',
  trainProgress = null,
  returnStage = 'setup',
  activeTask = 'delivery';
const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const mainTemplate = [
  '<div class="page-heading lab-heading"><h2 id="missionTitle"></h2><div class="course-control"><label for="courseSelect">コース</label><select id="courseSelect"><option value="standard">基本配置</option><option value="open">広い通路</option><option value="turns">曲がり道</option></select><button id="manualOpen" class="text-button">ロボットを操作</button></div></div>',
  experimentSteps('data-stage'),
  '<div id="labLessonBrief"></div>',
  '<div class="lab-layout experiment-layout"><div class="workspace"><section class="card simulation-card" id="arenaCard"><div class="arena-toolbar"><div><span class="live-dot"></span><strong id="sceneTitle">学習の準備</strong><span id="sceneTime"></span></div><label class="scan-option"><input type="checkbox" id="scanVisible">LiDARの照射線</label></div><div id="arenaHost"></div><div class="playback-bar" id="playbackBar" hidden><button id="playPause" aria-label="再生・一時停止">▶</button><button id="replayStart" class="small">最初から</button><input id="seek" type="range" min="0" max="1" step="0.01" value="0" aria-label="走行の再生位置"><label class="sr-only" for="speed">再生速度</label><select id="speed"><option value="1">1倍</option><option value="2">2倍</option><option value="4">4倍</option></select></div><div id="sceneCaption" class="scene-caption">青いレンズ側が機体の正面です。左右の車輪の回転数を変えて曲がります。</div><button id="sceneNext" class="primary scene-next" hidden></button><details id="runRewards" class="run-rewards" hidden><summary>この走行に付いた点数を見る</summary><div id="rewardBreakdown" class="reward-breakdown"></div><div class="run-reward-total">ここまでの合計<strong id="runRewardTotal"></strong></div><p class="helper">再生位置までに受け取った点数です。学習では、先々までもらう点数の合計を増やすように、動き方を更新します。</p></details><div id="manualControls" hidden></div></section>',
  '<section id="trainingBoard" class="card" hidden><div class="section-top"><h2 id="learningTitle">試した経験から、走り方を更新中</h2><span id="trainingCount" class="muted"></span></div><div class="training-progress"><progress id="trainingProgress" max="4000" value="0"></progress><p>さまざまな車輪の動かし方を試し、合計点の高い走り方を探しています。</p></div><div class="checkpoint-grid" id="checkpointGrid"></div><div class="training-chart"><div class="chart-tabs" role="group" aria-label="学習のグラフ"><button data-metric="score" aria-pressed="true">得られた点数</button><button data-metric="rate">到着率</button><button data-metric="arrivalTime">到着までの時間</button><button data-metric="commandRate">車輪の変化</button></div><div id="learningChart"></div><p id="chartNote" class="helper"></p></div></section>',
  '<section id="resultsBoard" class="card" hidden></section>',
  '<section id="sensorSection" class="card sensor-section"><button id="sensorTogglePanel" class="sensor-disclosure" aria-expanded="false"><span><strong>センサーの値を見る</strong><small>周囲の距離・RGB-Dカメラ・IMU・車輪</small></span><span id="sensorChevron">＋</span></button><div id="sensorBody" hidden>' +
    sensorTabs('data-sensor') +
    '<div class="sensor-content"><div class="sensor-chart"><canvas id="lidarView" width="640" height="430" role="img" aria-label="LiDARが測った周囲の距離"></canvas><div id="cameraHost" hidden></div><canvas id="sensorGraph" width="760" height="420" role="img" aria-label="センサー値の時間変化" hidden></canvas></div><div class="sensor-explanation"><p class="eyebrow" id="sensorName"></p><h3 id="sensorTitle"></h3><select id="imuSelect" aria-label="IMUで調べる値" hidden><option value="impact">衝撃</option><option value="tilt">前後・左右の傾き</option><option value="heading">向いている方向</option><option value="rotation">向きを変える速さ</option></select><p id="sensorDescription"></p><div id="sensorReading"></div><p class="helper" id="sensorNote"></p></div></div></div></section>',
  '</div><aside class="guide card lab-guide" id="guidePanel"></aside></div>',
  '<details data-help-dialog class="method-note"><summary>このロボットと、学習の仕組みについて</summary><div class="method-grid"><div><h3>2つの車輪と4種類のセンサー</h3><p>左右の駆動輪の回転数を変えて走ります。1台のRGB-DカメラのRGB画像で目印を見つけ、対応するデプスで奥行きを測ります。LiDARは周囲の障害物までの距離を測ります。IMUは加速度・回転・磁気を測り、車輪の回転数センサーとともに、機体の動きや位置の推定に使います。</p></div><div><h3>実際に試して学習しています</h3><p>例えば、壁に近いときにどれくらい曲がるか、届け先が遠いときにどれくらい進むかを、数値で調整します。ここでは距離や方向などの情報へ掛ける数値（係数）を少しずつ変え、同じ条件で走った合計点を比べます。点数が高くなる方向へ係数を直す方法がARSです。基礎のQ学習は、状況ごとの3つの行動の見積もりを表に記録する方法でした。このコースでは表を使わず、センサー情報から車輪の速さを計算する方法を学びます。</p></div><div><h3>実機につなげる前に</h3><p>位置・速度は連続値で計算し、車輪の遅れ・滑り・測定誤差も含めています。RGB-Dによる目印の認識と測距、姿勢の揺れは簡易モデルです。実機ではセンサーの校正、制御周期、安全停止の仕組みを別途検証する必要があります。</p><button id="exportPolicy" class="small" disabled>学習結果を書き出す</button></div></div></details>',
  '<p class="page-footnote">実験の記録は、このタブを開いている間保持されます。走りの良し悪しは、報酬の合計ではなく、到着・接触・時間などの共通の指標で比べます。</p>',
].join('');

function init() {
  $('labPage').innerHTML = mainTemplate;
  $('arenaHost').append(arena);
  $('cameraHost').append(camera);
  $('courseSelect').onchange = () => openLab(activeTask, $('courseSelect').value);
  $$('[data-stage]').forEach((b) => (b.onclick = () => navigate(b.dataset.stage)));
  $('manualOpen').onclick = startManual;
  $('scanVisible').onchange = () => {
    $('sensorToggle').checked = $('scanVisible').checked;
    paint();
  };
  $('playPause').onclick = () => {
    playing = !playing;
    if (playback && playback.cursor >= playback.result.time) playback.cursor = 0;
    updatePlayback();
  };
  $('replayStart').onclick = () => {
    if (playback) {
      playback.cursor = 0;
      playing = true;
      updatePlayback();
      paintPlayback();
    }
  };
  $('seek').oninput = () => {
    if (playback) {
      playback.cursor = Number($('seek').value);
      playing = false;
      paintPlayback();
      updatePlayback();
    }
  };
  $('sensorTogglePanel').onclick = () => toggleSensors();
  $$('[data-sensor]').forEach(
    (b) =>
      (b.onclick = () => {
        sensor = b.dataset.sensor;
        renderSensor();
      }),
  );
  $('imuSelect').onchange = () => {
    imuView = $('imuSelect').value;
    renderSensor();
  };
  $$('[data-metric]').forEach(
    (b) =>
      (b.onclick = () => {
        chartMetric = b.dataset.metric;
        drawLearning();
      }),
  );
  $('sceneNext').onclick = () => {
    if (stage === 'test' && experiment.run.results.length < 20) testRemaining();
    else if (stage === 'learn') startTest();
    else {
      playing = false;
      playback = null;
      toggleSensors(false);
      render();
      focusWorkspace();
    }
  };
  $('exportPolicy').onclick = exportPolicy;
  $('runRewards').ontoggle = drawRunRewards;
  requestAnimationFrame(tick);
}
function openLab(task = 'delivery', course = 'standard') {
  if (busy) return;
  toggleSensors(false);
  token++;
  playing = false;
  playback = null;
  manual = false;
  manualStop = false;
  command = [0, 0];
  selectedTrial = null;
  activeTask = task;
  const key = task + ':' + course;
  if (!sessions.has(key)) sessions.set(key, new Experiment(task, course));
  experiment = sessions.get(key);
  $('introPage').hidden = false;
  $('labPage').hidden = false;
  $('courseSelect').value = course;
  taskCourses.set(task, course);
  $('missionTitle').textContent =
    task === 'delivery' ? '障害物をよけて、届け先へ運ぶ' : '充電ポートに、向きを合わせて止まる';
  missionGoal =
    task === 'delivery'
      ? '棚にぶつからずに荷物を届け、黄色の範囲内で止まらせます。開始位置を変えた20回で、16回以上の到着と接触2回以下を目指します。'
      : 'ロボットを充電場所へ戻します。充電器につなぐには、到着する位置だけでなく向きもそろえる必要があります。黄色の範囲内で、向きのずれ8°以内に止めます。20か所から試し、16回以上の成功と接触2回以下を目指します。';
  stage = experiment.run?.results.length === 20 ? 'test' : experiment.run ? 'learn' : 'setup';
  world = new World(task, experiment.draft.rewards, experiment.draft.physics);
  world.reset(100);
  displayFrame = world.snapshot();
  shownTrace = [displayFrame];
  trainProgress = experiment.run;
  render();
  paint();
}
function activateLab(task = 'delivery') {
  if (busy) return;
  // Returning to the same experiment preserves the current stage, settings and replay.
  if (experiment && activeTask === task) {
    render();
    paint();
    return;
  }
  openLab(task, taskCourses.get(task) || 'standard');
}
function navigate(next) {
  toggleSensors(false);
  if (busy) return;
  if (next === 'learn' && !experiment.run) return;
  if ((next === 'test' || next === 'improve') && !experiment.run) return;
  if (next === 'improve' && experiment.run.results.length !== 20) return;
  playing = false;
  manual = false;
  command = [0, 0];
  playback = null;
  stage = next;
  render();
  focusWorkspace();
}
function focusWorkspace() {
  document.querySelector('#labPage .step-nav').scrollIntoView({ block: 'start' });
  const heading = $('guidePanel').querySelector('h2');
  heading?.setAttribute('tabindex', '-1');
  heading?.focus({ preventScroll: true });
}
function setDisabled(disabled) {
  $('courseSelect').disabled = disabled;
  $('manualOpen').disabled = disabled;
  $$('[data-stage],[data-rl-group],[data-rl-topic]').forEach((b) => (b.disabled = disabled));
}
function render() {
  const guideKey = 'lab-' + (manual ? 'manual' : stage);
  $('labLessonBrief').innerHTML =
    lessonGuide(guideKey, manual ? '' : missionGoal) + figureGuide(guideKey);
  setDisabled(busy);
  $$('[data-stage]').forEach((b) => {
    const s = b.dataset.stage;
    b.setAttribute('aria-current', !manual && s === stage ? 'step' : 'false');
    if (!busy)
      b.disabled =
        ((s === 'learn' || s === 'test') && !experiment.run) ||
        (s === 'improve' && experiment.run?.results.length !== 20);
  });
  $('trainingBoard').hidden = manual || stage !== 'learn' || !!playback;
  $('resultsBoard').hidden =
    manual ||
    !['test', 'improve'].includes(stage) ||
    experiment.run?.results.length !== 20 ||
    !!playback;
  $('arenaCard').hidden = !manual && (!$('trainingBoard').hidden || !$('resultsBoard').hidden);
  document.querySelector('.lab-layout').classList.toggle('manual-mode', manual);
  $('manualControls').hidden = !manual;
  $('playbackBar').hidden = !playback || manual;
  $('runRewards').hidden = !playback || manual;
  $('sensorSection').hidden = $('arenaCard').hidden;
  $('exportPolicy').disabled = !experiment.run;
  if (manual) {
    renderManual();
    return;
  }
  if (stage === 'setup') renderSetup();
  if (stage === 'learn') {
    renderLearningGuide();
    drawLearning();
  }
  if (stage === 'test') renderTestGuide();
  if (stage === 'improve') renderImprove();
  if (!$('resultsBoard').hidden) renderResults();
  updateScene();
  renderSensor();
  paint();
}
function startSummary(config) {
  return config.startMode === 'near' ? '同じ場所の近く' : 'いろいろな位置・向き';
}
function renderSetup() {
  const c = experiment.draft,
    hasPrevious = !!experiment.previous;
  $('guidePanel').innerHTML =
    '<p class="eyebrow">1 · 条件を決める</p><h2 data-lesson-cue="action">' +
    (hasPrevious ? '前の実験から、一つ変える' : 'まずは、この点数で試してみる') +
    '</h2><p>' +
    (hasPrevious
      ? '変更した条件で、同じ回数だけ学習し直します。テストは前の実験と同じ20か所です。'
      : '目標への接近や到着に加点し、接触したら減点します。どんな走りになるか、学習させて確かめましょう。') +
    '</p>' +
    '<div class="reward-summary">' +
    REWARDS.slice(0, 3)
      .map(
        (r) =>
          '<div><span>' +
          r.name +
          '</span><strong>' +
          (c.rewards.enabled[r.key] ? r.sign + c.rewards[r.key] : 'なし') +
          '<small>' +
          r.unit +
          '</small></strong></div>',
      )
      .join('') +
    '</div>' +
    '<button id="trainNow" class="primary full">この条件で学習させる →</button><p class="helper">学習では、車輪の動かし方を変えた候補で走り、もらった合計点を比べます。報酬を編集しただけでは、前に学んだ動き方は変わりません。このボタンで最初から学び直します。</p><details id="rewardSettings"><summary>点数の値・有効／無効を変える</summary><div id="rewardEditor"></div><div class="preset-line"><button id="recommended" class="small">基本の点数に戻す</button></div><p class="helper">「点 / m」は1 mあたり、「点 / 秒」は1秒あたり、「点 / 回」は条件を満たした1回あたりの点数です。例えば近づく点数が25点 / mなら、20 cm近づいて5点です。到着のときだけでなく、途中で近づく動きにも点数を付けると、役立つ動き方を探す手がかりが増えます。</p></details>' +
    '<div class="start-setting"><label for="startMode">学習するときの開始位置</label><select id="startMode"><option value="near">同じ場所の近く</option><option value="varied">いろいろな位置・向き</option></select><p class="helper">「同じ場所の近く」では、狭い範囲の位置と向きから学びます。「いろいろな位置・向き」では、学習が進むにつれて開始範囲を広げます。テストには別に決めた20か所を使います。</p></div>' +
    (hasPrevious
      ? '<p class="change-note">今回の変更：' + escape(experiment.change) + '</p>'
      : '') +
    '';
  $('startMode').value = c.startMode;
  $('startMode').onchange = () => {
    c.startMode = $('startMode').value;
    showStart();
  };
  $('rewardEditor').innerHTML = REWARDS.filter((r) => !r.dock || c.task === 'dock')
    .map(
      (r) =>
        '<div class="reward-row"><label><input type="checkbox" data-enable="' +
        r.key +
        '" ' +
        (c.rewards.enabled[r.key] ? 'checked' : '') +
        '><span>' +
        r.name +
        '</span></label><div><span>' +
        r.sign +
        '</span><input type="number" min="0" max="' +
        r.max +
        '" step="' +
        r.step +
        '" value="' +
        c.rewards[r.key] +
        '" data-value="' +
        r.key +
        '" aria-label="' +
        r.name +
        'の点数" ' +
        (!c.rewards.enabled[r.key] ? 'disabled' : '') +
        '><small>' +
        r.unit +
        '</small></div><p>' +
        r.description +
        '</p></div>',
    )
    .join('');
  $$('[data-enable]').forEach(
    (x) =>
      (x.onchange = () => {
        c.rewards.enabled[x.dataset.enable] = x.checked;
        document.querySelector('[data-value="' + x.dataset.enable + '"]').disabled = !x.checked;
        refreshRewardSummary();
      }),
  );
  $$('[data-value]').forEach(
    (x) =>
      (x.onchange = () => {
        const r = REWARDS.find((r) => r.key === x.dataset.value);
        x.value = Math.max(0, Math.min(r.max, Number(x.value) || 0));
        c.rewards[r.key] = Number(x.value);
        refreshRewardSummary();
      }),
  );
  $('recommended').onclick = () => {
    c.rewards = clone(DEFAULT_REWARD);
    renderSetup();
    $('rewardSettings').open = true;
  };
  $('trainNow').onclick = startTraining;
  showStart();
}
function refreshRewardSummary() {
  const c = experiment.draft;
  document.querySelector('.reward-summary').innerHTML = REWARDS.slice(0, 3)
    .map(
      (r) =>
        '<div><span>' +
        r.name +
        '</span><strong>' +
        (c.rewards.enabled[r.key] ? r.sign + c.rewards[r.key] : 'なし') +
        '<small>' +
        r.unit +
        '</small></strong></div>',
    )
    .join('');
}
function showStart() {
  world = new World(experiment.draft.task, experiment.draft.rewards, experiment.draft.physics);
  world.reset(100);
  displayFrame = world.snapshot();
  shownTrace = [displayFrame];
  $('sceneCaption').textContent =
    '学習の開始位置：' +
    startSummary(experiment.draft) +
    '。' +
    (world.task === 'dock' ? '向きのずれ8°以内で、' : '') +
    '点線の円の中で0.5秒止まると到着です。';
  paint();
}
async function startTraining() {
  if (busy) return;
  toggleSensors(false);
  busy = true;
  stage = 'learn';
  playback = null;
  playing = false;
  trainProgress = { episodes: 0, history: [], checkpoints: [] };
  render();
  focusWorkspace();
  try {
    const currentToken = ++token;
    await experiment.train(
      (progress) => {
        trainProgress = progress;
        drawLearning();
      },
      () => token !== currentToken,
    );
    if (currentToken !== token) return;
    trainProgress = experiment.run;
    busy = false;
    render();
  } catch (error) {
    busy = false;
    stage = 'setup';
    render();
    $('guidePanel').insertAdjacentHTML(
      'afterbegin',
      '<p role="alert" class="error">学習を完了できませんでした。もう一度試してください。</p>',
    );
    console.error(error);
  }
}
function renderLearningGuide() {
  $('guidePanel').innerHTML =
    '<p class="eyebrow">2 · 実験する</p><h2 data-lesson-cue="observe">' +
    (busy ? '点数を手がかりに、試行錯誤しています' : '学習した走りを確かめよう') +
    '</h2><p>' +
    (busy
      ? '車輪の動かし方を少しずつ変え、点数が増える選び方を探しています。走行が終わるたびに、開始位置に戻って次を試します。'
      : 'まず、学習した場所で、棚をよけて目標の場所に止まれたかを見ます。そのあと、別の位置からでも同じ課題を達成できるかテストします。') +
    '</p>' +
    '<div class="learning-explanation"><div><b>動く</b><span>センサーを見て、車輪を動かす</span></div><div><b>受け取る</b><span>動いた結果に、設定した点数が付く</span></div><div><b>更新する</b><span>合計点を増やせる走り方を探す</span></div></div>' +
    (busy
      ? '<p class="helper">学習はこのブラウザ内で計算しています。グラフと軌跡は、その結果です。</p>'
      : '<button id="testNow" class="primary full">別の位置でテストする →</button><button id="knownReplay" class="full secondary-space">学習した場所の走りを見る</button>' +
        (playback
          ? '<button id="returnLearning" class="text-button full">学習のグラフに戻る</button>'
          : '')) +
    '<details><summary>グラフと軌跡は何を表している？</summary><p>グラフは、その時点の動き方で5回走った確認結果です。横軸は、それまでの累計走行回数です。3枚の軌跡は学習前・途中・後に残した動き方を、同じ出発点で試した記録です。途中と後には、それまでの確認で平均点が最も高かった動き方を残すため、最後のグラフの点と同じ動き方とは限りません。再生ボタンでは選んだ記録を最初から見られます。</p><p>条件の違いを比べるため、1回を合計4,000走行にそろえています。内訳は、動かし方を変えて比べる3,840走行と、途中の確認160走行です。この回数で成功する保証はありません。最後の20か所のテストは、この4,000走行とは別です。</p></details>';
  if ($('returnLearning'))
    $('returnLearning').onclick = () => {
      playback = null;
      playing = false;
      render();
    };
  if (!busy) {
    $('testNow').onclick = startTest;
    $('knownReplay').onclick = () =>
      playRecord(experiment.run.checkpoints.at(-1).result, '学習した場所での走行');
  }
}
function drawLearning() {
  if (!trainProgress) return;
  const p = trainProgress,
    history = p.history || [];
  $('learningTitle').textContent = busy
    ? '試した経験から、走り方を更新中'
    : '学習で、走り方はどう変わった？';
  $('trainingCount').textContent = (p.episodes || 0).toLocaleString() + ' / 4,000 走行';
  $('trainingProgress').value = p.episodes || 0;
  const checkpoints = p.checkpoints || [];
  $('checkpointGrid').innerHTML = [0, 1, 2]
    .map(
      (i) =>
        '<div class="checkpoint"><div><strong>' +
        ['学習前', '途中', '学習後'][i] +
        '</strong><span>' +
        (checkpoints[i] ? checkpoints[i].episodes.toLocaleString() + ' 走行' : 'これから') +
        '</span></div><canvas id="checkpoint' +
        i +
        '" width="420" height="290" role="img" aria-label="' +
        ['学習前', '学習途中', '学習後'][i] +
        'の走行軌跡"></canvas><button data-checkpoint="' +
        i +
        '" class="small" ' +
        (busy || !checkpoints[i] ? 'disabled' : '') +
        '>' +
        (checkpoints[i] ? resultName(checkpoints[i].result) + ' · 再生' : '学習後に表示') +
        '</button></div>',
    )
    .join('');
  const env = new World(experiment.draft.task, experiment.draft.rewards, experiment.draft.physics);
  env.reset(100);
  for (let i = 0; i < 3; i++) drawTrajectory($('checkpoint' + i), env, checkpoints[i]?.result);
  $$('[data-checkpoint]').forEach(
    (b) =>
      (b.onclick = () =>
        playRecord(
          checkpoints[Number(b.dataset.checkpoint)].result,
          b.parentElement.querySelector('strong').textContent + 'の走行',
        )),
  );
  const spec = {
    score: {
      name: '合計点',
      unit: '点',
      note: '1走行の間にもらった合計点を、5回分平均した値です。学習は点数が高くなる動き方を探します。報酬の設定を変えると点数の基準も変わるため、別設定の優劣は到着・接触・時間で比べます。',
    },
    rate: {
      name: '到着率',
      unit: '%',
      note: 'その時点の動き方で5回走り、到着できた割合です。テスト20か所の結果とは異なります。',
    },
    arrivalTime: {
      name: '到着まで',
      unit: '秒',
      note: '到着できた走行だけの平均時間。小さいほど早く到着しています。到着がない区間は線を描きません。',
    },
    commandRate: {
      name: '回転数指令の変化',
      unit: 'rpm/秒',
      note: '到着した走行だけを集計します。左右の車輪へ指定した回転数が変わった量を積み上げ、1秒あたりに直した値です。rpmは1分間あたりの回転数、rpm/秒はその変化を1秒あたりに直した単位です。小さいほど急な指令変更が少なく、車体の揺れそのものを測った値ではありません。',
    },
  }[chartMetric];
  $$('[data-metric]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.metric === chartMetric)),
  );
  $('chartNote').textContent = spec.note;
  const values = history.map((x) => x[chartMetric]).filter((x) => x !== null && Number.isFinite(x));
  if (!values.length) {
    $('learningChart').innerHTML =
      '<div class="chart-empty">' +
      (history.length ? 'まだ到着した走行がありません' : '最初の学習結果を計算しています') +
      '</div>';
    return;
  }
  const min = chartMetric === 'score' ? Math.min(0, ...values) : 0,
    max = chartMetric === 'rate' ? 100 : Math.max(1, ...values) * 1.08,
    W = 760,
    H = 210,
    L = 55,
    R = 735,
    T = 22,
    B = 166,
    X = (x) => L + (x / 4000) * (R - L),
    Y = (y) => B - ((y - min) / (max - min)) * (B - T);
  let path = '',
    gap = true;
  history.forEach((v) => {
    const y = v[chartMetric];
    if (y === null || !Number.isFinite(y)) {
      gap = true;
      return;
    }
    path += (gap ? 'M' : 'L') + X(v.episodes).toFixed(1) + ' ' + Y(y).toFixed(1) + ' ';
    gap = false;
  });
  const ticks = [min, (min + max) / 2, max];
  $('learningChart').innerHTML =
    '<svg viewBox="0 0 ' +
    W +
    ' ' +
    H +
    '" role="img" aria-label="' +
    spec.name +
    'の学習中の変化">' +
    ticks
      .map(
        (v) =>
          '<line x1="' +
          L +
          '" x2="' +
          R +
          '" y1="' +
          Y(v) +
          '" y2="' +
          Y(v) +
          '" stroke="#e0e8e3"/><text x="' +
          (L - 10) +
          '" y="' +
          (Y(v) + 5) +
          '" text-anchor="end">' +
          v.toFixed(0) +
          '</text>',
      )
      .join('') +
    '<path d="' +
    path +
    '" fill="none" stroke="#1c756b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><text x="' +
    L +
    '" y="194">0</text><text x="385" y="194" text-anchor="middle">2,000</text><text x="' +
    R +
    '" y="194" text-anchor="end">4,000 走行</text><text x="' +
    L +
    '" y="14">' +
    spec.unit +
    '</text></svg>';
}
function startTest() {
  if (!experiment.run || busy) return;
  if (experiment.run.results.length) experiment.freshTest();
  stage = 'test';
  experiment.run.results = [];
  selectedTrial = 0;
  const result = experiment.testOne(0);
  playRecord(result, 'テスト · 1か所目', () => renderTestGuide());
}
function renderTestGuide() {
  const run = experiment.run,
    n = run.results.length,
    complete = n === 20;
  $('guidePanel').innerHTML =
    '<p class="eyebrow">3 · 結果を見る</p><h2 data-lesson-cue="result">' +
    (busy
      ? 'ほかの開始位置も計算しています'
      : complete
        ? '出発場所が変わっても、目標に止まれた？'
        : n
          ? 'まず、1か所目の走りを見る'
          : '学習していない位置でも走れる？') +
    '</h2><p>' +
    (busy
      ? '残りの走行はまとめて計算します。すべての走行を、あとから選んで再生できます。'
      : complete
        ? '20か所の結果を並べました。気になる走りを選ぶと、最初から再生してセンサーも調べられます。'
        : n
          ? '開始位置と向きをランダムに変えました。テストでは、学習した動き方を使い、報酬からの更新はしません。'
          : '開始位置と向きをランダムに変えて、走りを確かめます。') +
    '</p>' +
    (busy
      ? '<progress max="20" value="' + n + '"></progress><p class="helper">' + n + ' / 20か所</p>'
      : complete
        ? '<div class="result-highlight">' +
          statistics(run.results).successCount +
          '<span> / 20か所で到着</span></div><button id="considerChange" class="primary full">結果から改良を考える →</button>' +
          (playback
            ? '<button id="showOverview" class="full secondary-space">20か所の結果に戻る</button>'
            : statistics(run.results).cleared
              ? '<button id="nextCourse" class="full secondary-space">別のコースに挑戦する</button>'
              : '') +
          ''
        : n
          ? '<div class="test-first-result" id="firstResult">' +
            (playing
              ? '走行を再生中'
              : resultName(run.results[0]) + ' · ' + run.results[0].time.toFixed(1) + ' 秒') +
            '</div><button id="testRemaining" class="primary full">ほかの19か所も調べる →</button><p class="helper">まとめて計算し、計20か所の結果を表示します。</p>'
          : '<button id="firstTest" class="primary full">別の位置でテストする →</button>') +
    (experiment.previous
      ? '<p class="comparison-note">前の実験と同じ開始位置・向き・車輪の条件で比較しています。</p>'
      : '') +
    (playback
      ? '<button id="openSensorFromGuide" class="text-button full">この走行のセンサーを見る ↓</button>'
      : '');
  if ($('testRemaining')) $('testRemaining').onclick = testRemaining;
  if ($('firstTest')) $('firstTest').onclick = startTest;
  if ($('nextCourse'))
    $('nextCourse').onclick = () => {
      const names = Object.keys(COURSES);
      openLab(activeTask, names[(names.indexOf(experiment.draft.course) + 1) % names.length]);
    };
  if ($('considerChange'))
    $('considerChange').onclick = () => {
      playing = false;
      playback = null;
      stage = 'improve';
      render();
      focusWorkspace();
    };
  if ($('showOverview'))
    $('showOverview').onclick = () => {
      playing = false;
      playback = null;
      selectedTrial = null;
      render();
    };
  if ($('openSensorFromGuide')) $('openSensorFromGuide').onclick = () => toggleSensors(true);
}
async function testRemaining() {
  if (busy) return;
  toggleSensors(false);
  playing = false;
  playback = null;
  busy = true;
  render();
  try {
    for (let i = experiment.run.results.length; i < 20; i++) {
      experiment.testOne(i);
      renderTestGuide();
      await wait();
    }
    experiment.record();
    busy = false;
    render();
    focusWorkspace();
  } catch (error) {
    busy = false;
    render();
    $('guidePanel').insertAdjacentHTML(
      'afterbegin',
      '<p role="alert" class="error">テストを完了できませんでした。もう一度試してください。</p>',
    );
    console.error(error);
  }
}
function metric(value, digits = 1) {
  return value === null ? '—' : value.toFixed(digits);
}
function renderResults() {
  const run = experiment.run,
    s = statistics(run.results),
    before = experiment.previous ? statistics(experiment.previous.results) : null;
  $('resultsBoard').innerHTML =
    '<div class="section-top"><h2>20か所から走らせた結果</h2><span class="result-badge ' +
    (s.cleared ? 'cleared' : '') +
    '">' +
    (s.cleared ? '目標を達成' : '実験 ' + run.revision) +
    '</span></div>' +
    '<div class="result-metrics"><div><span>到着した回数</span><strong>' +
    s.successCount +
    '<small> / 20</small></strong>' +
    (before ? '<em>前の実験 ' + before.successCount + '回</em>' : '') +
    '</div><div><span>接触した回数</span><strong>' +
    s.contacts +
    '<small> 回</small></strong>' +
    (before ? '<em>前の実験 ' + before.contacts + '回</em>' : '') +
    '</div><div><span>到着した走行の平均時間</span><strong>' +
    metric(s.arrivalTime) +
    '<small> 秒</small></strong>' +
    (before ? '<em>前の実験 ' + metric(before.arrivalTime) + '秒</em>' : '') +
    '</div></div>' +
    '<div class="result-detail"><div><canvas id="testMap" width="480" height="320" role="img" aria-label="テストの開始位置と結果"></canvas><p class="helper">● 到着　× 未到着<br>点はそれぞれの開始位置です。</p></div><div><h3>気になる走行を選ぶ</h3><div class="trial-grid">' +
    run.results
      .map(
        (r, i) =>
          '<button data-trial="' +
          i +
          '" class="' +
          (r.success ? 'success' : 'failure') +
          '" aria-label="テスト' +
          (i + 1) +
          ' ' +
          resultName(r) +
          'を再生"><b>' +
          String(i + 1).padStart(2, '0') +
          '</b><span>' +
          (r.success ? '○' : r.collision ? '×' : '△') +
          '</span></button>',
      )
      .join('') +
    '</div><p class="helper">○ 到着　× 接触　△ その他の未到着</p></div></div>' +
    (before
      ? '<div class="comparison-verdict"><strong>' +
        comparisonText(s, before) +
        '</strong><p>同じ20条件で比較。時間は到着した走行だけの平均です。到着した試行が異なる場合、速さの差だけでは優劣を決められません。</p></div>'
      : '') +
    '<details class="results-more"><summary>車輪の変化・実験の記録</summary><p>到着した走行の車輪への指令変化：' +
    metric(s.commandRate) +
    ' rpm/秒' +
    (before ? '（前の実験 ' + metric(before.commandRate) + ' rpm/秒）' : '') +
    '。車輪へ指定した回転数の変化を積み上げ、1秒あたりに直した値です。小さいほど急な変更が少なく、車体の振動を直接測った値ではありません。</p><p>学習の開始位置：' +
    startSummary(run.config) +
    '。' +
    run.episodes.toLocaleString() +
    '走行で学習。今回の変更：' +
    escape(run.change) +
    '。</p>' +
    (run.note ? '<p>予想：' + escape(run.note) + '</p>' : '') +
    '<div class="experiment-log">' +
    experiment.records
      .map((r) => {
        const v = statistics(r.results);
        return (
          '<p>実験 ' +
          r.revision +
          ' · ' +
          escape(r.change) +
          '<br><strong>' +
          v.successCount +
          '/20 到着 · ' +
          v.contacts +
          '回接触 · 平均' +
          metric(v.arrivalTime) +
          '秒</strong></p>'
        );
      })
      .join('') +
    '</div><button id="freshBatch" class="small">新しい20か所でテストする</button><p class="helper">学んだ動き方は変えず、開始位置・向きなどを新しく20条件抽選します。前の実験と同じ条件で比べた後に、別の条件でも使えるか確かめるためのテストです。新しい結果は、前の実験との同条件比較には使いません。</p></details>';
  const env = new World(run.config.task, run.config.rewards, run.config.physics);
  drawStartMap($('testMap'), env, { results: run.results });
  $$('[data-trial]').forEach(
    (b) =>
      (b.onclick = () => {
        selectedTrial = Number(b.dataset.trial);
        playRecord(run.results[selectedTrial], 'テスト · ' + (selectedTrial + 1) + 'か所目');
      }),
  );
  $('freshBatch').onclick = () => {
    experiment.freshTest();
    startTest();
  };
}
function comparisonText(after, before) {
  const delta = after.successCount - before.successCount;
  if (delta > 0) return '到着できた場所が ' + delta + 'か所増えました。';
  if (delta < 0) return '到着できた場所が ' + -delta + 'か所減りました。条件の変え方を見直せます。';
  if (after.contacts < before.contacts) return '到着の回数は同じで、接触が減りました。';
  if (after.contacts > before.contacts) return '到着の回数は同じですが、接触が増えました。';
  return '到着と接触の回数は同じでした。時間や走り方の違いも見てみましょう。';
}
function renderImprove() {
  const run = experiment.run,
    s = statistics(run.results),
    collisionIndex = run.results.findIndex((r) => r.collision),
    failureIndex = run.results.findIndex((r) => !r.success),
    index = collisionIndex >= 0 ? collisionIndex : failureIndex >= 0 ? failureIndex : 0;
  const risky = s.contacts > 0,
    near = run.config.startMode === 'near',
    clearanceOn = run.config.rewards.enabled.clearance;
  $('guidePanel').innerHTML =
    '<p class="eyebrow">4 · 条件を変えて比べる</p><h2 data-lesson-cue="reflect">' +
    (risky
      ? '接触する前に、何が起きていた？'
      : s.successCount < 16
        ? '目標に止まれなかった走りは、何が違う？'
        : '到着できた。その先をよくするには？') +
    '</h2>' +
    '<p>' +
    (risky
      ? '20か所のうち' +
        s.contacts +
        'か所で接触しました。まず走りを見て、近づきすぎたことに気づける情報があるか考えましょう。'
      : s.successCount < 16
        ? '開始位置や向きによって、結果が変わっていないでしょうか。未到着の走行を一つ調べてみましょう。'
        : '時間や車輪の動きも比べてみましょう。早くするための変更が、安全な走りにつながるとは限りません。') +
    '</p>' +
    '<button id="inspectExample" class="full">テスト ' +
    String(index + 1).padStart(2, '0') +
    ' の走りを調べる</button>' +
    '<details class="hint"><summary>考えるヒント</summary><p>' +
    (risky
      ? clearanceOn
        ? '今は、障害物に近づくと最大' +
          run.config.rewards.clearance +
          '点/秒を減点しています。減点の強さや開始位置での経験を変えると、走りはどう変わるでしょうか？'
        : 'LiDARは、ぶつかる前の距離も測っています。接触したときだけ減点する設定では、接触せずに近づく動きには、どんな点数が付くでしょうか？'
      : near
        ? '同じ場所の近くだけで学習しました。向きや開始位置が違う場面での経験は、十分にあったでしょうか？'
        : '到着した回数が同じでも、所要時間や車輪への指令の変化は違います。改善したい指標を一つ決めてみましょう。') +
    '</p></details>' +
    '<h3 class="next-question">次の実験で、何を変える？</h3><fieldset class="choice-list improvement-choices"><legend class="sr-only">次に変える条件</legend>' +
    (near
      ? '<label class="choice"><input type="radio" name="improvement" value="starts"><span><strong>学習の開始位置を広げる</strong><small>いろいろな位置と向きから経験を積む。</small></span></label>'
      : '') +
    '<label class="choice"><input type="radio" name="improvement" value="clearance" ' +
    (clearanceOn && run.config.rewards.clearance >= 20 ? 'disabled' : '') +
    '><span><strong>' +
    (clearanceOn ? '近づきすぎたときの減点を強める' : '近づきすぎたら減点する') +
    '</strong><small>障害物に接触する前の距離も、報酬に使う。</small></span></label>' +
    '<label class="choice"><input type="radio" name="improvement" value="time" ' +
    (run.config.rewards.time >= 8 ? 'disabled' : '') +
    '><span><strong>時間の減点を増やす</strong><small>早く到着することを、より重視する。</small></span></label><label class="choice"><input type="radio" name="improvement" value="custom"><span><strong>自分で点数を調整する</strong><small>報酬の組み合わせや強さを試す。</small></span></label></fieldset>' +
    '<label class="note-label" for="hypothesis">どう変わると思う？ <span>任意</span></label><textarea id="hypothesis" rows="2" maxlength="240" placeholder="例：壁から離れて走るようになる"></textarea>' +
    '<button id="applyImprovement" class="primary full" disabled>変更する条件を選ぶ</button><p class="helper">次も同じ20か所でテストし、変更前と比べます。</p>';
  $('inspectExample').onclick = () => {
    selectedTrial = index;
    playRecord(run.results[index], 'テスト · ' + (index + 1) + 'か所目');
    if (risky) {
      sensor = 'lidar';
      toggleSensors(true);
    }
  };
  $('hypothesis').value = experiment.reflection.note;
  $('hypothesis').oninput = () => (experiment.reflection.note = $('hypothesis').value);
  $$('[name="improvement"]').forEach((x) => {
    x.checked = x.value === experiment.reflection.choice;
    x.onchange = () => {
      experiment.reflection.choice = x.value;
      $('applyImprovement').disabled = false;
      $('applyImprovement').textContent = 'この変更で、次の実験を準備 →';
    };
  });
  if (experiment.reflection.choice) {
    $('applyImprovement').disabled = false;
    $('applyImprovement').textContent = 'この変更で、次の実験を準備 →';
  }
  $('applyImprovement').onclick = () => {
    const choice = document.querySelector('[name="improvement"]:checked')?.value;
    if (!choice) return;
    const c = (experiment.draft = clone(run.config));
    let change;
    if (choice === 'starts') {
      c.startMode = 'varied';
      change = '学習の開始位置を広げる';
    }
    if (choice === 'clearance') {
      c.rewards.enabled.clearance = true;
      c.rewards.clearance = run.config.rewards.enabled.clearance
        ? Math.min(20, run.config.rewards.clearance + 4)
        : 4;
      change = '近づきすぎると減点：' + c.rewards.clearance + '点/秒（最大）';
    }
    if (choice === 'time') {
      c.rewards.enabled.time = true;
      c.rewards.time = Math.min(8, c.rewards.time + 1);
      change = '時間の減点：' + c.rewards.time + '点/秒';
    }
    if (choice === 'custom') change = '報酬を自分で調整';
    experiment.prepareRevision(change, $('hypothesis').value);
    stage = 'setup';
    playback = null;
    playing = false;
    render();
    focusWorkspace();
    if (choice === 'custom') $('rewardSettings').open = true;
  };
}
function playRecord(result, label, onEnd) {
  manual = false;
  command = [0, 0];
  manualStop = false;
  playback = { result, label, cursor: 0, onEnd };
  playing = true;
  const config = experiment.run.config;
  world = new World(config.task, config.rewards, config.physics);
  render();
  paintPlayback();
  updatePlayback();
  if (matchMedia('(max-width: 900px)').matches) $('arenaCard').scrollIntoView({ block: 'start' });
  else focusWorkspace();
}
function updatePlayback() {
  if (!playback) return;
  $('playPause').textContent = playing ? 'Ⅱ' : '▶';
  $('playPause').setAttribute('aria-label', playing ? '一時停止' : '再生');
  $('seek').max = playback.result.time;
  $('seek').value = playback.cursor;
}
function paintPlayback() {
  if (!playback) return;
  const trace = playback.result.trace,
    index = Math.max(
      0,
      trace.findLastIndex((f) => f.state.t <= playback.cursor + 0.001),
    );
  displayFrame = trace[index];
  shownTrace = trace.slice(0, index + 1);
  paint();
  if ($('runRewards').open) drawRunRewards();
  updateScene();
  renderSensor();
  $('seek').value = playback.cursor;
}
function drawRunRewards() {
  if (!playback) return;
  const totals = new Map();
  for (const frame of shownTrace)
    for (const p of frame.pieces || []) totals.set(p.text, (totals.get(p.text) || 0) + p.value);
  $('rewardBreakdown').innerHTML =
    [...totals]
      .filter(([, v]) => Math.abs(v) > 0.0001)
      .map(
        ([text, value]) =>
          '<div><span>' +
          text +
          '</span><b>' +
          (value > 0 ? '+' : '') +
          value.toFixed(1) +
          ' 点</b></div>',
      )
      .join('') || '<p class="helper">まだ点数を受け取っていません。</p>';
  $('runRewardTotal').textContent = (displayFrame.state.total || 0).toFixed(1) + ' 点';
}
function updateScene() {
  if (!displayFrame) return;
  $('sceneNext').hidden = !playback || manual || playback.cursor < playback.result.time;
  $('sceneNext').textContent =
    stage === 'test' && experiment.run.results.length < 20
      ? 'ほかの19か所も調べる →'
      : stage === 'learn'
        ? '別の位置でテストする →'
        : stage === 'improve'
          ? '改良を考える画面に戻る →'
          : '20か所の結果に戻る';
  $('sceneTitle').textContent = manual
    ? manualStop
      ? '停止中'
      : '手動で操作中'
    : playback
      ? playback.label
      : stage === 'setup'
        ? '学習の準備'
        : '走行の確認';
  $('sceneTime').textContent = playback || manual ? displayFrame.state.t.toFixed(1) + ' s' : '';
  if (manual)
    $('sceneCaption').textContent = manualStop
      ? '停止中です。「停止を解除する」を押すと、手動操作を続けられます。'
      : '方向ボタンを押している間、ロボットが動きます。離すと止まります。';
  else if (playback) {
    const ended = playback.cursor >= playback.result.time;
    $('sceneCaption').textContent = ended
      ? resultName(playback.result) +
        ' · この走行の記録はここまでです。再生位置を戻すと、途中のセンサー値を調べられます。'
      : playing
        ? '選んだ1回の記録を、出発時点から再生しています。Ⅱで止め、下のバーで時刻を選ぶと、そのときの位置とセンサー値を確かめられます。'
        : '一時停止中。再生位置を動かして、走りとセンサーを見比べられます。';
  }
}
function paint() {
  if (!world || !displayFrame) return;
  drawArena(
    world,
    displayFrame.state,
    shownTrace.map((f) => f.state),
    displayFrame.observation,
  );
  drawCamera(world, displayFrame.state, displayFrame.observation);
}
function toggleSensors(force) {
  const open = force ?? $('sensorBody').hidden;
  $('sensorBody').hidden = !open;
  $('sensorTogglePanel').setAttribute('aria-expanded', String(open));
  $('sensorChevron').textContent = open ? '−' : '＋';
  if (open) renderSensor();
}
function sensorHistory() {
  return shownTrace.flatMap((f) => {
    const o = f.observation,
      i = o.imu,
      p = {
        t: f.state.t,
        impact: f.impact || 0,
        left: o.wheelRpm[0],
        right: o.wheelRpm[1],
        pitch: (i.pitch * 180) / Math.PI,
        roll: (i.roll * 180) / Math.PI,
        yaw: (i.yaw * 180) / Math.PI,
        gyro: i.gyro[2],
      };
    return sensor === 'imu' && imuView === 'impact' && f.events?.length
      ? f.events.map((e) => ({ ...p, t: e.t, impact: e.impact }))
      : p;
  });
}
function renderSensor() {
  if (!displayFrame) return;
  $$('[data-sensor]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.sensor === sensor)),
  );
  $('lidarView').hidden = sensor !== 'lidar';
  $('cameraHost').hidden = sensor !== 'camera';
  $('sensorGraph').hidden = sensor === 'lidar' || sensor === 'camera';
  $('imuSelect').hidden = sensor !== 'imu';
  const o = displayFrame.observation;
  $('sensorReading').innerHTML = '';
  if (sensor === 'lidar') {
    $('sensorName').textContent = SENSOR_COPY.lidar.name;
    $('sensorTitle').textContent = SENSOR_COPY.lidar.title;
    $('sensorDescription').textContent =
      '中央がロボットで、上が機体の正面です。周りの点が近いほど、その方向に近い障害物があります。';
    $('sensorNote').textContent =
      '橙色の点は、ロボットの中心から50cm未満。円の外側は測定できる範囲の限界です。';
    drawLidar($('lidarView'), o.scan);
    const clearance = Math.max(0, Math.min(...o.scan) - world.physics.bodyRadius);
    $('sensorReading').innerHTML =
      '<strong>' +
      Math.round(clearance * 100) +
      '<small> cm</small></strong><span>車体から、最も近い障害物まで</span>';
  } else if (sensor === 'camera') {
    $('sensorName').textContent = SENSOR_COPY.camera.name;
    $('sensorTitle').textContent = SENSOR_COPY.camera.title;
    $('sensorDescription').textContent =
      '正面のRGB-Dカメラ1台から、RGBの目印認識と対応するデプスの奥行きを得る想定です。ここでは認識後の距離・方向を模擬し、位置の推定と学習に使います。障害物の陰や視野の外では見えません。';
    $('sensorNote').textContent =
      'RGB映像を模擬表示しています。生のRGB・デプス画素から直接学習するモデルではありません。測距の欠けや位置合わせは、画像処理教材で別に確かめられます。';
    $('sensorReading').innerHTML =
      '<strong class="text-reading">' +
      (o.camera.visible ? '目印を検出' : '目印は見えていません') +
      '</strong>' +
      (o.camera.visible
        ? '<p>目印の奥行き Z：' +
          (o.camera.distance * Math.cos(o.camera.bearing)).toFixed(2) +
          ' m（模擬）</p>'
        : '');
    drawCamera(world, displayFrame.state, o);
  } else {
    const mode = sensor === 'wheels' ? 'wheels' : imuView === 'impact' ? 'impact' : 'attitude',
      spec = graphSpec(mode, imuView);
    $('sensorName').textContent = SENSOR_COPY[sensor].name;
    $('sensorTitle').textContent = spec.title;
    $('sensorDescription').textContent = spec.note;
    $('sensorNote').textContent =
      sensor === 'wheels'
        ? '左右が同じ回転数なら直進し、差があると曲がります。単位rpmは1分間あたりの回転数です。'
        : imuView === 'impact'
          ? '水平加速度の大きさが12 m/秒²以上になると停止する設定です。再生中は、そのときの記録を表示しています。'
          : 'ここでは向きをジャイロ・磁気・見えた目印から見積もります。前後・左右の傾きは、平らな床で加減速したときの小さな揺れを計算した表示です。';
    const values = drawGraph($('sensorGraph'), sensorHistory(), spec, world.settings.threshold, []);
    $('sensorReading').innerHTML = values
      .map(
        (v) =>
          '<div class="sensor-value"><i style="background:' +
          v.color +
          '"></i><span>' +
          v.label +
          '</span><b>' +
          v.value +
          '</b><small>' +
          spec.unit +
          '</small></div>',
      )
      .join('');
  }
}
function startManual() {
  if (busy) return;
  returnStage = stage;
  manual = true;
  playback = null;
  playing = false;
  manualStop = false;
  command = [0, 0];
  world = new World(experiment.draft.task, experiment.draft.rewards, experiment.draft.physics);
  world.reset(100);
  displayFrame = world.snapshot();
  manualHistory = [displayFrame];
  shownTrace = manualHistory;
  render();
  paint();
  if (matchMedia('(max-width: 900px)').matches) $('arenaCard').scrollIntoView({ block: 'start' });
  else focusWorkspace();
}
function renderManual() {
  $('guidePanel').innerHTML =
    '<p class="eyebrow">ロボットを操作する</p><h2>棚をよけて進むには、車輪をどう回す？</h2><p>まず自分で方向を指示して、目標の場所へ近づけてみます。方向ボタンを押している間だけ動き、キーボードの矢印キーでも操作できます。前進と旋回を試し、「センサーの値を見る」で左右の車輪の回転数を比べてください。</p><div class="manual-tips"><p><strong>直進</strong>左右の車輪を同じ速さで回す。</p><p><strong>旋回</strong>左右の車輪の回転数に差を付ける。</p><p><strong>後退</strong>車輪を逆に回す。橙色の矢印が移動方向。</p></div><button id="returnFromManual" class="primary full">実験に戻る →</button><p class="helper">手動で動かした経験は、ロボットの学習には使われません。</p>';
  $('manualControls').innerHTML =
    '<div class="drive-pad"><button data-drive="forward" aria-label="前進">↑</button><button data-drive="left" aria-label="左に旋回">↶</button><button data-drive="back" aria-label="後退">↓</button><button data-drive="right" aria-label="右に旋回">↷</button></div><div class="safety-controls"><button id="emergency" class="emergency ' +
    (manualStop ? 'latched' : '') +
    '">' +
    (manualStop ? '停止を解除する' : '■ 緊急停止') +
    '</button><p id="safetyReason">' +
    (manualStop
      ? '車輪は停止しています。解除後も手動操作のままです。'
      : '衝撃を検知した場合も停止します。') +
    '</p><button id="manualReset" class="text-button">最初の位置に戻す</button></div>';
  const commands = {
    forward: [0.6, 0.6],
    back: [-0.45, -0.45],
    left: [-0.4, 0.4],
    right: [0.4, -0.4],
  };
  $$('[data-drive]').forEach((b) => {
    b.disabled = manualStop;
    b.onpointerdown = (e) => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      command = commands[b.dataset.drive];
      b.classList.add('pressed');
    };
    const release = () => {
      command = [0, 0];
      b.classList.remove('pressed');
    };
    b.onpointerup = release;
    b.onpointercancel = release;
    b.onlostpointercapture = release;
  });
  $('emergency').onclick = () =>
    manualStop ? releaseManual() : stopManual('緊急停止ボタンで停止しました。');
  $('manualReset').onclick = startManual;
  $('returnFromManual').onclick = () => {
    manual = false;
    command = [0, 0];
    stage = returnStage;
    playback = null;
    render();
  };
  updateScene();
  renderSensor();
}
function stopManual(reason) {
  command = [0, 0];
  manualStop = true;
  world.state.latched = true;
  world.state.done = true;
  world.state.left = 0;
  world.state.right = 0;
  world.state.targetL = 0;
  world.state.targetR = 0;
  world.state.v = 0;
  world.state.omega = 0;
  world.queue = [];
  world.observe();
  displayFrame = { ...world.snapshot(), impact: displayFrame?.impact || 0 };
  renderManual();
  $('safetyReason').textContent = reason + ' 解除すると、この位置から操作を続けられます。';
  paint();
}
function releaseManual() {
  const { x, y, theta } = world.state;
  command = [0, 0];
  world.reset(100, { initial: { x, y, theta } });
  manualStop = false;
  displayFrame = world.snapshot();
  manualHistory = [displayFrame];
  shownTrace = manualHistory;
  renderManual();
  paint();
}
const keyCommands = {
  ArrowUp: [0.6, 0.6],
  ArrowDown: [-0.45, -0.45],
  ArrowLeft: [-0.4, 0.4],
  ArrowRight: [0.4, -0.4],
};
document.addEventListener('keydown', (e) => {
  if (supplementOpen || !labVisible()) return;
  if (
    manual &&
    !manualStop &&
    keyCommands[e.key] &&
    !['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)
  ) {
    e.preventDefault();
    command = keyCommands[e.key];
  }
  if (
    manual &&
    e.code === 'Space' &&
    !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(e.target.tagName)
  ) {
    e.preventDefault();
    stopManual('キーボードから停止しました。');
  }
});
document.addEventListener('keyup', (e) => {
  if (keyCommands[e.key]) command = [0, 0];
});
window.addEventListener('blur', () => {
  command = [0, 0];
  playing = false;
});
document.addEventListener('visibilitychange', () => {
  command = [0, 0];
  playing = false;
});
function tick(now) {
  const dt = Math.min(0.1, (now - lastTick) / 1000 || 0);
  lastTick = now;
  if (labVisible() && !supplementOpen) {
    if (manual && !manualStop) {
      manualAccumulator += dt;
      if (manualAccumulator >= 0.1) {
        manualAccumulator = 0;
        const out = world.step(command, { capture: true });
        displayFrame = { ...world.snapshot(), impact: out.impact, events: out.trace };
        manualHistory.push(displayFrame);
        if (manualHistory.length > 1000) manualHistory.shift();
        shownTrace = manualHistory;
        paint();
        updateScene();
        if (!$('sensorBody').hidden) renderSensor();
        if (out.done)
          stopManual(
            out.emergency
              ? '衝撃を検知しました。'
              : out.collision
                ? '障害物に接触しました。'
                : out.success
                  ? '目標に到着しました。'
                  : '走行時間の上限に達しました。',
          );
      }
    } else if (playing && playback) {
      playback.cursor = Math.min(
        playback.result.time,
        playback.cursor + dt * Number($('speed').value),
      );
      paintPlayback();
      if (playback.cursor >= playback.result.time) {
        playing = false;
        updatePlayback();
        if (stage === 'test') renderTestGuide();
        playback.onEnd?.();
      }
    }
  }
  requestAnimationFrame(tick);
}
function exportPolicy() {
  const run = experiment.run;
  if (!run) return;
  const content = {
    format: 'robo-lab-policy-v1',
    config: run.config,
    weights: [...run.weights],
    features: FEATURE_NAMES,
    controlDt: 0.1,
    note: 'Sensor preprocessing and calibration are required. This is not a safety-certified real-robot controller.',
  };
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }),
    ),
    a = document.createElement('a');
  a.href = url;
  a.download = 'robo-lab-' + run.config.task + '-policy.json';
  a.click();
  URL.revokeObjectURL(url);
}
init();
document.addEventListener('open-lab', (e) => activateLab(e.detail.task));

document.addEventListener('series-leave', () => {
  command = [0, 0];
  playing = false;
});
document.addEventListener('rl-topic-change', () => {
  command = [0, 0];
  playing = false;
});
document.addEventListener('supplement-open', () => {
  command = [0, 0];
  playing = false;
  supplementOpen = true;
});
document.addEventListener('supplement-close', () => {
  supplementOpen = false;
});
