import { lessonGuide, figureGuide } from '../shell/lesson-guide.js';
import {
  generateSlamLog,
  estimateSlam,
  slamMetrics,
  SLAM_METHODS,
  SLAM_CASES,
  validateSlamLog,
} from './engine.js';
import { recordSlamLog } from '../live/slam-recorder.js';
import { lessonLabel, experimentSteps, sensorTabs, SENSOR_COPY } from '../shell/lesson-ui.js';
import { drawRobot } from '../core/renderer.js';
import { basicsTemplate, initSlamBasics, reviewSlamBasics } from './basics.js';
import { drawSlamCamera } from './camera.js';

const $ = (id) => document.getElementById(id),
  all = (s) => [...document.querySelectorAll(s)];
const SLAM_RECORD_SECONDS = 15,
  SLAM_RECORD_LABEL = '実機から' + SLAM_RECORD_SECONDS + '秒記録する';
let log = null,
  runs = [],
  active = null,
  cursor = 0,
  playing = false,
  busy = false,
  last = 0,
  elapsed = 0,
  method = 'wheel',
  caseId = 'slip',
  calibrate = false,
  real = false,
  slamStage = 'setup',
  slamGuideKey = '';
const colors = { wheel: '#eab075', imu: '#93baff', slam: '#7bdec3' },
  cm = (x) => (x === null ? '基準なし' : (x * 100).toFixed(1) + ' cm');
const safe = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
// Keep drawing coordinates independent of the canvas bitmap. CSS size and screen
// density determine the backing resolution, including browser zoom changes.
function sharpCanvas(id, width, height) {
  const canvas = $(id);
  canvas.style.aspectRatio = width + ' / ' + height;
  const box = canvas.getBoundingClientRect(),
    density = window.devicePixelRatio || 1;
  const scale =
    (box.width && box.height ? Math.min(box.width / width, box.height / height) : 1) * density;
  const pixelsWide = Math.max(1, Math.round(width * scale)),
    pixelsHigh = Math.max(1, Math.round(height * scale));
  if (canvas.width !== pixelsWide) canvas.width = pixelsWide;
  if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh;
  const context = canvas.getContext('2d');
  context.setTransform(pixelsWide / width, 0, 0, pixelsHigh / height, 0, 0);
  context.clearRect(0, 0, width, height);
  context.lineWidth = 1;
  return context;
}
function watchCanvasSize() {
  let pending = false;
  const redraw = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (!log || $('slamPage').hidden) return;
      drawMaps();
      drawSensor();
      if ($('slamTiltDemo').open && !$('slamTiltDemo').hidden) drawTilt();
    });
  };
  const observer = new ResizeObserver(redraw);
  for (const id of ['slamTruth', 'slamMap', 'slamSensorCanvas', 'slamTiltCanvas'])
    observer.observe($(id));
  const watchDensity = () => {
    const query = matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
    query.addEventListener(
      'change',
      () => {
        redraw();
        watchDensity();
      },
      { once: true },
    );
  };
  watchDensity();
  window.addEventListener('resize', redraw);
}
const template = `<div class="page-heading"><div><p class="eyebrow course-label">${lessonLabel('slam')}</p><h1 id="slamHeading">センサーの値から、位置と地図を求める</h1></div><nav class="slam-mode" aria-label="実験の進め方"><button id="slamBasicsTab" aria-pressed="true">仕組みを知る</button><button id="slamSimTab" aria-pressed="false">センサーを比べる</button><button id="slamRealTab" aria-pressed="false">ROS 2の実機で確かめる</button></nav></div>
<div id="slamExperimentBrief" hidden></div>
${basicsTemplate()}
<section id="slamHardware" class="card hardware-panel" hidden>
<div class="section-top"><h2>実機のセンサーで計算した位置を、床の目印と比べる</h2><span class="tag">読み込みは端末内だけ</span></div>
<div class="hardware-steps"><div><b>1</b><h3>位置の目印を置く</h3><p>床に出発点と途中の測定点を印し、寸法を測ります。低速で一周し、最後は出発点に機体の位置・向きを合わせて止めます。</p></div><div><b>2</b><h3>センサーを記録する</h3><p>収録開始後、まず2秒静止。その後に走行します。左右の車輪、IMU、LiDARをROS 2で記録します。</p><button id="slamLogger" class="small">収録スクリプトを保存</button></div><div><b>3</b><h3>同じログで比較する</h3><p>JSONを開き、使うセンサーを変えます。床の実測値と比べて、どの条件でずれたかを調べます。</p><label class="primary upload-label">計測ログを開く<input id="slamUpload" type="file" accept=".json,application/json"></label><button id="slamRecord" class="small">${SLAM_RECORD_LABEL}</button></div></div>
<p id="slamImportStatus" class="import-status" role="status">実機のログを読み込むと、下の画面で比較できます。</p>
<details data-help-dialog><summary>接続・実験の手順とデータ形式</summary><div id="slamHardwareGuide"></div><button id="slamGuideDownload" class="small">実験手順を保存</button><button id="slamSample" class="small">サンプルJSONを保存</button></details>
<p class="hardware-note">この教材からモーター指令は送りません。実機の走行は既存の操縦系で行い、物理的な停止手段を用意してください。読み込んだファイルは送信されません。</p>
</section>

<div id="slamSteps">${experimentSteps('data-slam-stage')}</div>
<div class="slam-layout experiment-layout" id="slamExperiment">
<div class="slam-workspace"><section class="card slam-scene"><div class="section-top"><h2 id="slamSceneTitle">同じ走行を、センサーの使い方で比べる</h2><span id="slamTime">準備</span></div>
<div class="slam-maps"><figure><figcaption><strong id="slamTruthTitle">実際の走行</strong><small id="slamTruthNote">シミュレーターだけが知る位置</small></figcaption><canvas id="slamTruth" width="600" height="440" role="img" aria-label="実際の走行軌跡"></canvas></figure><figure><figcaption><strong id="slamEstimateTitle">車輪から計算した位置</strong><small>点：LiDARの距離を位置に重ねた地図</small></figcaption><canvas id="slamMap" width="600" height="440" role="img" aria-label="推定した走行軌跡と距離の地図"></canvas></figure></div>
<p class="slam-map-note">どの方法でも、壁の点を描く材料は同じLiDARの測定です。「車輪だけ」でも点は表示しますが、その方法では点の重なりを位置の修正には使いません。位置や向きを違って見積もると、同じ壁の点も違う場所に置かれ、地図が二重になったり傾いたりします。</p><div class="slam-playbar playback-bar"><button id="slamPlay" aria-label="走行を再生" disabled>▶</button><button id="slamRestart" class="small" disabled>最初から</button><input id="slamSeek" type="range" min="0" max="1" step="1" value="0" aria-label="SLAM実験の再生位置" disabled><label>再生速度<select id="slamSpeed"><option value="1">1倍</option><option value="2" selected>2倍</option><option value="4">4倍</option></select></label><button id="slamEnd" class="small" disabled>結果まで進む</button></div>
<p class="slam-caption" id="slamCaption">右の「この条件で位置を計算する」から始めます。道順は共通で、位置の計算方法だけを変えます。</p>
<div class="slam-metrics" id="slamMetrics" hidden></div><button id="slamReflectJump" class="primary slam-reflect-jump" hidden>条件を変えて比べる →</button>
</section>
<section class="card slam-comparison" id="slamComparison" hidden><div class="section-top"><h2>実験の結果</h2><button id="slamExport" class="small">推定結果をCSVで保存</button></div><div id="slamRunCards"></div><div id="slamErrorGraph"></div><p id="slamGraphNote" class="helper"></p></section>
<section class="card sensor-section" id="slamSensors"><button id="slamSensorToggle" class="sensor-disclosure" aria-expanded="false"><span><strong>センサーの値を見る</strong><small>周囲の距離・RGB-Dカメラ・IMU・車輪</small></span><span id="slamSensorChevron">＋</span></button><div id="slamSensorBody" hidden>${sensorTabs('data-slam-sensor')}<div class="sensor-content"><div class="sensor-chart"><canvas id="slamSensorCanvas" width="800" height="320" role="img" aria-label="再生位置に対応するセンサーの計測値"></canvas></div><div class="sensor-explanation"><p class="eyebrow" id="slamSensorName"></p><h3 id="slamSensorTitle"></h3><label id="slamCameraChoice" for="slamCameraMode" hidden>同じ装置の出力<select id="slamCameraMode"><option value="rgb">RGB映像</option><option value="depth">奥行き画像（デプス）</option></select></label><p id="slamSensorText"></p></div></div><div class="sensor-extra"><details id="slamTiltDemo" hidden><summary>動いていない機体の傾きを、IMUから調べる</summary><div class="tilt-demo"><canvas id="slamTiltCanvas" width="440" height="190" aria-label="傾きによる重力の計測値"></canvas><div><label>前後の傾き<input id="slamPitch" type="range" min="-30" max="30" value="0"></label><label>左右の傾き<input id="slamRoll" type="range" min="-30" max="30" value="0"></label><p id="slamTiltReading"></p></div></div><p>機体が水平か傾いているかを知りたいとき、静止中のIMUで測る重力の方向が手がかりになります。前後・左右の傾きを変え、三方向の棒がどう変わるか比べてください。水平では重力による値が主に上下zに現れ、傾けると前後xや左右yにも分かれて現れます。棒の右・左は値の正・負を表します。実際に走ると加減速の影響も混ざるため、加速度の値だけをそのまま傾きと読み替えることはできません。</p></details></div></div></section>
</div>
<aside class="guide card slam-guide"><div id="slamSettings"><p class="eyebrow">1 · 条件を決める</p><h2>同じ走行記録で、現在地の求め方を比べる</h2><div id="slamChallengeBar" class="challenge-bar"><label>実験する条件<select id="slamCase"><option value="slip">01 · 車輪が少し滑る床</option><option value="bias">02 · IMUのずれ</option><option value="corridor">03 · 長いまっすぐな通路</option></select></label></div><p id="slamMethodExplanation"></p>
<fieldset class="choice-list"><legend class="sr-only">位置の計算に使うセンサー</legend><label class="choice"><input type="radio" name="slamMethod" value="wheel" checked><span><strong>車輪だけ</strong><small>回転数から、距離と向きを計算</small></span></label><label class="choice"><input type="radio" name="slamMethod" value="imu"><span><strong>車輪 ＋ IMU</strong><small>距離は車輪、向きの変化はジャイロ</small></span></label><label class="choice"><input type="radio" name="slamMethod" value="slam"><span><strong>車輪 ＋ IMU ＋ LiDAR</strong><small>測った壁の形と地図を照らし合わせる</small></span></label></fieldset>
<label class="calibrate-choice" id="slamCalibrateLabel" hidden><input type="checkbox" id="slamCalibrate">停止中にも出ていた回転の値を差し引く（ジャイロの補正）</label>
<button class="primary full" id="slamRun">この条件で位置を計算する →</button><p class="helper" id="slamRunNote">車輪が回った距離と、床の上で進んだ距離は、同じでしょうか。</p>

<details class="slam-principles"><summary>この方法で分かること・苦手なこと</summary><div id="slamPrincipleText"></div></details></div><div id="slamProgressGuide" hidden></div><div id="slamReflection" hidden></div>
</aside></div>
<details data-help-dialog class="method-note"><summary>SLAMの仕組みと、この教材の範囲</summary><div class="method-grid"><div><h3>地図も位置も、最初は分からない</h3><p>車輪とIMUで次の位置を予測し、LiDARが測った壁の形を、それまでの地図に重ねて位置を調整します。その位置で地図を更新するのが、この教材のSLAMです。正解の地図や位置は計算に渡していません。</p></div><div><h3>同じ場所に戻ったと気づく</h3><p>実用的なSLAMでは、以前見た場所との対応を見つけ、過去の軌跡と地図全体を調整する「ループ閉じ込み」も使います。総合実験と実機ログの比較は、近くの計測を照合する局所SLAMです。地図全体を直す考え方は「戻った場所から直す」で、位置だけの簡略計算として別に体験します。</p></div></div><p class="helper">実装：2次元差動二輪の積分、静止時バイアス補正、点と線のICP照合。総合実験は距離の点群地図です。占有地図は「見えた範囲を地図にする」で、位置を既知とした別の実験として扱います。走査中の動きの補正・3D姿勢を用いた距離補正は未実装です。</p><p class="helper">参考：<a href="https://google-cartographer-ros.readthedocs.io/en/latest/algo_walkthrough.html" target="_blank" rel="noreferrer">CartographerのSLAM解説</a> · <a href="https://github.com/cra-ros-pkg/robot_localization/blob/rolling-devel/doc/preparing_sensor_data.rst" target="_blank" rel="noreferrer">ROSのセンサーデータ準備</a></p></details>`;
function initSlam(hardware) {
  $('slamPage').innerHTML = template;
  $('slamHardwareGuide').innerHTML = hardware.html;
  $('slamLogger').onclick = () => download('robo_lab_record.py', hardware.python, 'text/x-python');
  $('slamGuideDownload').onclick = () =>
    download('QUESTiX-LAB-ROS2-実験手順.md', hardware.guide, 'text/markdown');
  $('slamSample').onclick = () =>
    download(
      'robo-lab-sample.json',
      JSON.stringify(generateSlamLog('slip'), null, 2),
      'application/json',
    );
  // A file and a live recording enter through the same validation.
  const loadHardwareLog = (input, name, note = '') => {
    const parsed = validateSlamLog(input);
    reset(parsed);
    $('slamImportStatus').textContent =
      name +
      ' · ' +
      parsed.frames.length +
      'フレームを読み込みました。正解位置はありません。' +
      note;
    $('slamExperiment').hidden = false;
    $('slamSteps').hidden = false;
    $('slamRun').textContent = 'この条件で位置を計算する →';
  };
  $('slamUpload').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      if (file.size > 12000000) throw Error('12MB以下のJSONを選んでください。');
      loadHardwareLog(JSON.parse(await file.text()), file.name);
    } catch (error) {
      $('slamImportStatus').textContent = '読み込めませんでした：' + error.message;
    }
    e.target.value = '';
  };
  let recording = null;
  $('slamRecord').onclick = async () => {
    if (recording) {
      recording.abort();
      return;
    }
    recording = new AbortController();
    $('slamRecord').textContent = '記録を中止する';
    try {
      const { log, moved } = await recordSlamLog({
        seconds: SLAM_RECORD_SECONDS,
        signal: recording.signal,
        onProgress: (count) => {
          $('slamImportStatus').textContent =
            '実機から記録中… ' +
            count +
            '回のLiDAR測定。コントローラーでゆっくり走らせてください。';
        },
      });
      loadHardwareLog(
        log,
        '実機からの記録',
        ' IMUの値はないため0としています。' +
          (moved ? '' : '記録中、ロボットは動いていませんでした。'),
      );
    } catch (error) {
      $('slamImportStatus').textContent = '記録できませんでした：' + error.message;
    } finally {
      recording = null;
      if ($('slamRecord')) $('slamRecord').textContent = SLAM_RECORD_LABEL;
    }
  };
  $('slamSimTab').onclick = () => setReal(false);
  $('slamRealTab').onclick = () => setReal(true);
  $('slamBasicsTab').onclick = showBasics;
  initSlamBasics(() => {
    setReal(false);
    $('slamSteps').scrollIntoView({ block: 'start' });
  });
  $('slamCase').onchange = () => {
    caseId = $('slamCase').value;
    reset(generateSlamLog(caseId));
  };
  all('[data-slam-stage]').forEach((b) => (b.onclick = () => goSlamStage(b.dataset.slamStage)));
  all('[name="slamMethod"]').forEach(
    (r) =>
      (r.onchange = () => {
        method = r.value;
        slamStage = 'setup';
        updateMethod();
        updateSlamSteps();
      }),
  );
  $('slamCalibrate').onchange = () => {
    calibrate = $('slamCalibrate').checked;
    slamStage = 'setup';
    updateMethod();
    updateSlamSteps();
  };
  $('slamReflectJump').onclick = () => goSlamStage('improve');
  $('slamRun').onclick = run;
  $('slamExport').onclick = exportResults;
  $('slamPlay').onclick = () => {
    if (!active) return;
    if (cursor >= log.frames.length - 1) {
      cursor = 0;
      elapsed = 0;
    }
    slamStage = 'learn';
    playing = !playing;
    render();
  };
  $('slamRestart').onclick = () => {
    if (!active) return;
    cursor = 0;
    elapsed = 0;
    playing = true;
    slamStage = 'learn';
    render();
  };
  $('slamEnd').onclick = () => {
    playing = false;
    cursor = log.frames.length - 1;
    slamStage = 'test';
    render();
  };
  $('slamSeek').oninput = () => {
    playing = false;
    cursor = Number($('slamSeek').value);
    elapsed = log.frames[cursor].t;
    slamStage = cursor === log.frames.length - 1 ? 'test' : 'learn';
    render();
  };
  $('slamCameraMode').onchange = drawSensor;
  $('slamSensorToggle').onclick = () => {
    const open = $('slamSensorBody').hidden;
    $('slamSensorBody').hidden = !open;
    $('slamSensorToggle').setAttribute('aria-expanded', String(open));
    $('slamSensorChevron').textContent = open ? '−' : '＋';
    if (open) drawSensor();
  };
  $('slamTiltDemo').ontoggle = drawTilt;
  $('slamPitch').oninput = drawTilt;
  $('slamRoll').oninput = drawTilt;
  all('[data-slam-sensor]').forEach(
    (b) =>
      (b.onclick = () => {
        sensor = b.dataset.slamSensor;
        all('[data-slam-sensor]').forEach((x) => x.setAttribute('aria-pressed', x === b));
        drawSensor();
      }),
  );

  document.addEventListener('series-leave', () => (playing = false));
  document.addEventListener('supplement-open', pauseSlam);
  reset(generateSlamLog());
  showBasics();
  watchCanvasSize();
  requestAnimationFrame(tick);
}
function pauseSlam() {
  playing = false;
}
function reviewSlam(id) {
  pauseSlam();
  showBasics();
  return reviewSlamBasics(id);
}
function updateSlamSteps() {
  all('[data-slam-stage]').forEach((b) => {
    b.setAttribute('aria-current', b.dataset.slamStage === slamStage ? 'step' : 'false');
    b.disabled = busy || (b.dataset.slamStage !== 'setup' && !active);
  });
  $('slamSettings').hidden = slamStage !== 'setup';
  $('slamProgressGuide').hidden = !['learn', 'test'].includes(slamStage);
  $('slamReflection').hidden = slamStage !== 'improve';
  const guideKey = [slamStage, busy, active?.id].join(':');
  if (guideKey === slamGuideKey) return;
  slamGuideKey = guideKey;
  if (slamStage === 'learn') {
    $('slamProgressGuide').innerHTML =
      '<p class="eyebrow">2 · 実験する</p><h2>位置の計算結果を、走行と見比べる</h2><p>' +
      (busy
        ? 'センサーの計測値から、位置と地図を計算しています。'
        : '同じ走行の記録を再生しています。気になるところで止めて、軌跡やセンサーの値を見比べましょう。') +
      '</p><button id="slamViewResults" class="primary full" ' +
      (busy ? 'disabled' : '') +
      '>結果を見る →</button><p class="helper">走行の再生位置を動かしても、計算した結果は変わりません。</p>';
    $('slamViewResults').onclick = () => goSlamStage('test');
  } else if (slamStage === 'test' && active) {
    const hardware = log.source === 'hardware',
      metric = hardware ? active.metrics.closure : active.metrics.endError;
    $('slamProgressGuide').innerHTML =
      '<p class="eyebrow">3 · 結果を見る</p><h2>' +
      (hardware ? '実測した位置と比べる' : 'どのくらい位置がずれた？') +
      '</h2><p>' +
      (hardware
        ? '出発点からの推定距離は ' + cm(metric) + ' です。実測した位置と照らし合わせて確かめます。'
        : '一周後の位置のずれは ' +
          cm(metric) +
          ' です。軌跡とグラフから、いつずれ始めたかも確認しましょう。') +
      '</p><button id="slamConsiderChange" class="primary full">条件を変えて比べる →</button><button id="slamReviewRun" class="full secondary-space">走行とセンサーを見直す</button><p class="helper">前の実験も「実験の結果」から選んで表示できます。</p>';
    $('slamConsiderChange').onclick = () => goSlamStage('improve');
    $('slamReviewRun').onclick = () => goSlamStage('learn');
  }
}
function goSlamStage(next) {
  if (busy || (!active && next !== 'setup')) return;
  playing = false;
  slamStage = next;
  if (next === 'test' || next === 'improve') cursor = log.frames.length - 1;
  render();
  const target =
    next === 'setup'
      ? document.querySelector('.slam-guide')
      : next === 'learn'
        ? document.querySelector('.slam-scene')
        : next === 'test'
          ? $('slamComparison')
          : $('slamReflection');
  target.scrollIntoView({ block: 'start' });
}
function showBasics() {
  playing = false;
  $('slamBasics').hidden = false;
  $('slamExperimentBrief').hidden = true;
  for (const id of ['slamHardware', 'slamSteps', 'slamExperiment']) $(id).hidden = true;
  document.querySelector('#slamPage .method-note').hidden = true;
  $('slamHeading').textContent = '目的の場所へ進むために、現在地と周囲の地図を知る';
  $('slamBasicsTab').setAttribute('aria-pressed', 'true');
  $('slamSimTab').setAttribute('aria-pressed', 'false');
  $('slamRealTab').setAttribute('aria-pressed', 'false');
}
function renderExperimentBrief() {
  const key = real ? 'slam-real' : 'slam-compare',
    goal = real
      ? ''
      : caseId === 'corridor'
        ? '途中の位置のずれにも注目し、LiDARだけでは位置を見分けにくい場所を探します。'
        : '比較の目安として、一周後の位置のずれ15 cm以内を目指します。途中のずれも比べます。';
  $('slamExperimentBrief').innerHTML = lessonGuide(key, goal) + figureGuide(key);
}
function setReal(value) {
  const wasReal = real;
  real = value;
  playing = false;
  $('slamBasics').hidden = true;
  $('slamExperimentBrief').hidden = false;
  renderExperimentBrief();
  document.querySelector('#slamPage .method-note').hidden = false;
  $('slamHeading').textContent = real
    ? '実機のセンサーで、位置のずれを確かめる'
    : '使うセンサーを変え、位置のずれを比べる';
  $('slamBasicsTab').setAttribute('aria-pressed', 'false');
  $('slamHardware').hidden = !real;
  $('slamChallengeBar').hidden = real;
  $('slamSimTab').setAttribute('aria-pressed', !real);
  $('slamRealTab').setAttribute('aria-pressed', real);
  if (!real) {
    if (wasReal) reset(generateSlamLog(caseId));
    $('slamExperiment').hidden = false;
  } else {
    $('slamExperiment').hidden = log.source !== 'hardware';
  }
  $('slamSteps').hidden = $('slamExperiment').hidden;
  render();
}
function reset(data) {
  slamStage = 'setup';
  log = data;
  runs = [];
  active = null;
  cursor = 0;
  elapsed = 0;
  playing = false;
  method = 'wheel';
  calibrate = false;
  all('[name="slamMethod"]').forEach((r) => (r.checked = r.value === method));
  $('slamCalibrate').checked = false;
  renderExperimentBrief();
  $('slamComparison').hidden = true;
  $('slamReflection').hidden = true;
  updateMethod();
  render();
}
const explanations = {
  wheel:
    '車輪が何回転したかを数えると、進んだ距離と曲がった角度を計算できます。これをオドメトリと呼びます。',
  imu: '車輪の回転から進んだ距離を見積もり、IMUのジャイロで回る速さを測ります。回る速さに経過時間を掛けて足すと、向きの変化を求められます。車輪が滑る場合も回転の手がかりになりますが、ジャイロ自体の偏りや、進んだ距離のずれは残ります。',
  slam: '車輪とIMUで位置を予測し、LiDARが測った壁の形を地図に重ねます。重なり方から位置を調整し、地図も更新します。',
};
const principles = {
  wheel:
    '<h3>身近な計算で位置が分かる</h3><p>1回転の距離は「車輪の直径 × 円周率」。左右の進んだ距離の差から、向きの変化も計算します。</p><p>ただし、滑りや車輪の寸法の誤差は積み重なります。周囲を見ていないため、自分ではずれを直せません。</p>',
  imu: '<h3>姿勢と位置は別の情報</h3><p>9軸IMUは加速度・角速度・磁気を各3軸で測ります。静止に近い状態では、加速度から重力方向を見て傾きを推定できます。ジャイロを積み重ねると向きの変化が分かります。</p><p>小さなジャイロの偏りも時間とともに積み重なります。磁気も金属やモーターの影響を受けます。加速度を2回積分するだけで位置を求めると、誤差が急速に増えます。ここでは位置の距離成分は車輪を使います。</p>',
  slam: '<h3>周囲の形が、ずれを直す手がかり</h3><p>LiDARは距離を測ります。位置を直接教えてくれるわけではありません。以前の距離の形と照合して、移動量を求めます。</p><p>長い平行な壁や、似た景色が続く場所では、どれだけ進んだか判断しにくくなります。ガラス、動く人、測定範囲の外も苦手です。車輪・IMUの予測も大切です。</p>',
};
function updateMethod() {
  $('slamMethodExplanation').textContent = explanations[method];
  $('slamPrincipleText').innerHTML = principles[method];
  $('slamCalibrateLabel').hidden = method === 'wheel';
  $('slamRun').textContent =
    log.source === 'hardware'
      ? 'この条件で位置を計算する →'
      : runs.length
        ? 'この条件で位置を計算する →'
        : 'この条件で位置を計算する →';
  $('slamRunNote').textContent =
    method === 'wheel'
      ? '車輪が回った距離と、床の上で進んだ距離は、同じでしょうか。'
      : method === 'imu'
        ? '向きのずれは減るでしょうか。距離のずれも直るでしょうか。'
        : '地図に重ねると位置はどう変わるでしょうか。';
  if (
    active &&
    (active.method !== method || active.calibrate !== (method !== 'wheel' && calibrate))
  )
    $('slamRunNote').textContent += ' 画面には、前の実験結果を残しています。';
}
async function run() {
  if (busy) return;
  busy = true;
  slamStage = 'learn';
  playing = false;
  updateSlamSteps();
  $('slamRun').disabled = true;
  $('slamRun').textContent = '計測データから計算中…';
  await new Promise((r) => setTimeout(r, 20));
  try {
    const result = estimateSlam(log.frames, log.config, {
      method,
      calibrate: method !== 'wheel' && calibrate,
      stationarySeconds: log.stationarySeconds,
    });
    result.metrics = slamMetrics(result, log);
    result.id = runs.length;
    active = result;
    runs.push(result);
    cursor = 0;
    elapsed = 0;
    playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!playing) {
      cursor = log.frames.length - 1;
      slamStage = 'test';
    }
    $('slamSeek').max = log.frames.length - 1;
    render();
    $('slamRunCards').innerHTML = runs
      .map(
        (r, i) =>
          '<button data-slam-run="' +
          i +
          '"><span>' +
          safe(SLAM_METHODS[r.method]) +
          (r.calibrate ? ' · 補正あり' : '') +
          '</span><strong>' +
          cm(log.source === 'hardware' ? r.metrics.closure : r.metrics.endError) +
          '</strong><small>' +
          (log.source === 'hardware' ? '出発点からの推定距離' : '一周後の位置のずれ') +
          '</small></button>',
      )
      .join('');
    all('[data-slam-run]').forEach(
      (b) =>
        (b.onclick = () => {
          active = runs[Number(b.dataset.slamRun)];
          cursor = log.frames.length - 1;
          playing = false;
          slamStage = 'test';
          render();
        }),
    );
    $('slamComparison').hidden = false;
    drawErrorGraph();
    if (matchMedia('(max-width: 900px)').matches)
      document.querySelector('.slam-scene').scrollIntoView({ block: 'start' });
  } catch (e) {
    slamStage = 'setup';
    $('slamCaption').textContent = '計算できませんでした：' + e.message;
  } finally {
    busy = false;
    $('slamRun').disabled = false;
    updateMethod();
    updateSlamSteps();
  }
}
function render() {
  updateSlamSteps();
  $('slamRestart').disabled = !active;
  const ready = !!active,
    finished = ready && cursor >= log.frames.length - 1,
    f = log.frames[cursor];
  $('slamPlay').disabled = !ready;
  $('slamSeek').disabled = !ready;
  $('slamEnd').disabled = !ready;
  $('slamSeek').value = cursor;
  $('slamPlay').textContent = playing ? 'Ⅱ' : '▶';
  $('slamPlay').setAttribute('aria-label', playing ? '走行を一時停止' : '走行を再生');
  $('slamTime').textContent = ready
    ? f.t.toFixed(1) + ' / ' + log.frames.at(-1).t.toFixed(1) + ' s'
    : '準備';
  $('slamEstimateTitle').textContent = ready
    ? SLAM_METHODS[active.method] + (active.calibrate ? ' · 補正あり' : '')
    : '推定した位置と地図';
  $('slamTruthTitle').textContent = log.source === 'hardware' ? '計測ログの基準' : '実際の走行';
  $('slamTruth').setAttribute(
    'aria-label',
    log.source === 'hardware' ? '実機の基準位置は別途計測が必要です' : '実際の走行軌跡',
  );
  $('slamTruthNote').textContent =
    log.source === 'hardware' ? '正解位置は記録されていません' : 'シミュレーターだけが知る位置';
  $('slamCaption').textContent = !ready
    ? log.source === 'hardware'
      ? '「この条件で位置を計算する」で、センサーから位置と地図を求めます。'
      : '共通の操縦記録を使い、位置の計算方法だけを変えます。「この条件で位置を計算する」から始めます。'
    : finished
      ? '走行が終わりました。再生位置を戻し、いつずれ始めたか調べられます。'
      : playing
        ? '同じ計測データを再生しています。気になるところで一時停止できます。'
        : '一時停止中。動きとセンサーの値を見比べられます。';
  $('slamMetrics').hidden = !ready;
  $('slamReflectJump').hidden = !finished;
  if (ready) {
    const p = active.states[cursor],
      ref = log.reference?.[cursor],
      error = ref ? Math.hypot(p.x - ref.x, p.y - ref.y) : null;
    $('slamMetrics').innerHTML =
      '<div><small>' +
      (ref ? 'この時点の位置のずれ' : '出発点からの推定距離') +
      '</small><strong>' +
      cm(ref ? error : Math.hypot(p.x, p.y)) +
      '</strong></div><div><small>出発点からの推定位置</small><strong class="pose-reading">x ' +
      p.x.toFixed(2) +
      ' / y ' +
      p.y.toFixed(2) +
      ' m</strong></div><div><small>LiDARによる位置補正</small><strong>' +
      (active.method !== 'slam'
        ? '使っていません'
        : p.weak
          ? '手がかりが少ない'
          : p.matched
            ? '照合して補正'
            : '予測を使用') +
      '</strong></div>';
  }
  drawMaps();
  if ($('slamSensorBody').hidden) returnReflection(finished);
  drawSensor();
  returnReflection(finished);
}
function returnReflection(finished) {
  const visible = finished && slamStage === 'improve';
  $('slamReflection').hidden = !visible;
  if (!visible) return;
  const m = active.metrics,
    hardware = log.source === 'hardware';
  let title, body, next;
  if (hardware) {
    title = '実測した位置と、照らし合わせよう';
    body =
      'ここに出る距離は、出発点からの推定値です。実機を正確に出発点へ戻した場合に限り、最後の値を戻り位置のずれとして使えます。途中の精度は、床の測定点でも確認しましょう。';
    next = active.method === 'wheel' ? 'imu' : active.method === 'imu' ? 'slam' : null;
  } else if (caseId === 'corridor') {
    title = '戻り位置だけなら、正確に見える？';
    body =
      '途中の位置のずれもグラフで確かめましょう。平行な壁だけでは、壁に沿う方向の移動をLiDARから決めにくくなります。往復で誤差が相殺される場合もあります。';
    next = active.method !== 'slam' ? 'slam' : null;
  } else if (caseId === 'bias' && active.method === 'imu' && !active.calibrate) {
    title = 'IMUの値は、止まっているときも0？';
    body =
      '止まっていた最初の2秒で、角速度は0になっていますか。小さな偏りを引いてから積み重ねると、どう変わるか試しましょう。';
    next = 'calibrate';
  } else if (active.method === 'wheel') {
    title = m.endError <= 0.15 ? '車輪だけで目標を達成' : '同じ床なのに、地図がゆがんだ';
    body =
      '距離の点を置くには、そのときの位置と向きが必要です。車輪の滑りで向きがずれると、同じ壁も違う場所に記録されます。IMUの回転の計測を使うとどうなるでしょう。';
    next = 'imu';
  } else if (active.method === 'imu') {
    title = m.endError <= 0.15 ? '位置のずれを15cm以内にできた' : '向き以外のずれも残っている';
    body =
      'IMUは回転を測れますが、車輪の滑りで生じた距離の誤差を直接は直せません。次は、壁の形を重ねて位置を調整してみましょう。';
    next = 'slam';
  } else {
    title = m.endError <= 0.15 ? '位置のずれを15cm以内にできた' : 'まだ位置のずれが残っている';
    body =
      '距離の計測を地図に重ね、位置を補正した結果です。いつも成功するとは限りません。次はIMUのずれや、長い通路でも確かめましょう。';
    next = null;
  }
  $('slamReflection').innerHTML =
    '<div class="result-reflection"><p class="eyebrow">4 · 条件を変えて比べる</p><h3>' +
    title +
    '</h3><p>' +
    body +
    '</p><details><summary>予想と結果を、ひとこと残す</summary><textarea id="slamMemo" aria-label="実験の考察" placeholder="どの値が、いつからずれた？ 次は何を変える？">' +
    safe(active.note || '') +
    '</textarea></details>' +
    (next
      ? '<button class="primary full" id="slamNext">' +
        (next === 'calibrate'
          ? '静止データで補正してみる'
          : next === 'imu'
            ? '次はIMUも使って比べる'
            : '次はLiDARも使って比べる') +
        ' →</button>'
      : '<button class="small" id="slamNextCase">' +
        (caseId === 'slip'
          ? 'IMUのずれに挑戦'
          : caseId === 'bias'
            ? '長い通路に挑戦'
            : '実機で確かめる') +
        ' →</button>') +
    '<button id="slamChooseConditions" class="text-button full">自分で条件を選ぶ</button></div>';
  $('slamChooseConditions').onclick = () => goSlamStage('setup');
  $('slamMemo').oninput = () => (active.note = $('slamMemo').value);
  if (next)
    $('slamNext').onclick = () => {
      if (next === 'calibrate') {
        calibrate = true;
        $('slamCalibrate').checked = true;
      } else {
        method = next;
        all('[name="slamMethod"]').forEach((r) => (r.checked = r.value === method));
      }
      slamStage = 'setup';
      updateMethod();
      updateSlamSteps();
      $('slamRun').focus();
    };
  else
    $('slamNextCase').onclick = () => {
      if (hardware || caseId === 'corridor') setReal(true);
      else {
        caseId = caseId === 'slip' ? 'bias' : 'corridor';
        $('slamCase').value = caseId;
        reset(generateSlamLog(caseId));
      }
    };
}
function bounds() {
  const pts = [{ x: -1, y: -1 }, { x: 4.6, y: 3.3 }, ...(log.reference || [])];
  if (log.scene) {
    pts.push(
      { x: -log.scene.start.x - 0.25, y: -log.scene.start.y - 0.25 },
      {
        x: log.scene.width - log.scene.start.x + 0.25,
        y: log.scene.height - log.scene.start.y + 0.25,
      },
    );
  }
  if (active) {
    pts.push(...active.states);
    for (let i = 0; i < active.states.length; i += 6) pts.push(...active.states[i].points);
  }
  return {
    x0: Math.min(...pts.map((p) => p.x)) - 0.3,
    x1: Math.max(...pts.map((p) => p.x)) + 0.3,
    y0: Math.min(...pts.map((p) => p.y)) - 0.3,
    y1: Math.max(...pts.map((p) => p.y)) + 0.3,
  };
}
function drawMaps() {
  const b = bounds();
  for (const [id, truth] of [
    ['slamTruth', true],
    ['slamMap', false],
  ]) {
    const c = sharpCanvas(id, 600, 440),
      W = 600,
      H = 440,
      k = Math.min((W - 48) / (b.x1 - b.x0), (H - 48) / (b.y1 - b.y0)),
      ox = (W - (b.x1 - b.x0) * k) / 2,
      oy = (H - (b.y1 - b.y0) * k) / 2,
      X = (x) => ox + (x - b.x0) * k,
      Y = (y) => H - oy - (y - b.y0) * k;
    c.fillStyle = '#102832';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = '#24424d';
    c.lineWidth = 1;
    for (let x = Math.ceil(b.x0); x < b.x1; x++) {
      c.beginPath();
      c.moveTo(X(x), 24);
      c.lineTo(X(x), H - 24);
      c.stroke();
    }
    for (let y = Math.ceil(b.y0); y < b.y1; y++) {
      c.beginPath();
      c.moveTo(24, Y(y));
      c.lineTo(W - 24, Y(y));
      c.stroke();
    }
    if (truth && log.scene) {
      const s = log.scene;
      c.strokeStyle = '#809ba6';
      c.strokeRect(X(-s.start.x), Y(s.height - s.start.y), s.width * k, s.height * k);
      c.fillStyle = '#49616e';
      for (const w of s.walls)
        c.fillRect(X(w.x - s.start.x), Y(w.y + w.h - s.start.y), w.w * k, w.h * k);
    }
    if (truth && !log.reference) {
      c.fillStyle = '#b8d1dc';
      c.font = '22px system-ui';
      c.textAlign = 'center';
      c.fillText('実機の正解位置は不明', W / 2, H / 2 - 15);
      c.font = '16px system-ui';
      c.fillText('床の目印・実測値で確かめます', W / 2, H / 2 + 20);
      continue;
    }
    if (!truth && active) {
      c.fillStyle = '#b3d9e044';
      for (let i = 0; i <= cursor; i += 2)
        for (const p of active.states[i].points) c.fillRect(X(p.x) - 1, Y(p.y) - 1, 2.2, 2.2);
      const latest = active.states[cursor];
      c.fillStyle = '#c3eff1';
      for (const p of latest.points) c.fillRect(X(p.x) - 1.5, Y(p.y) - 1.5, 3, 3);
    }
    const path = truth ? log.reference : active?.states || [],
      limit = active ? cursor : 0;
    c.strokeStyle = truth ? '#d6e4ed' : colors[active?.method || 'wheel'];
    c.lineWidth = 3;
    c.beginPath();
    path
      ?.slice(0, limit + 1)
      .forEach((p, i) => (i ? c.lineTo(X(p.x), Y(p.y)) : c.moveTo(X(p.x), Y(p.y))));
    c.stroke();
    c.setLineDash([4, 4]);
    c.strokeStyle = '#f4d38c';
    c.beginPath();
    c.arc(X(0), Y(0), Math.max(7, 0.15 * k), 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);
    const p = path?.[limit] || { x: 0, y: 0, theta: 0 };
    c.save();
    c.translate(X(p.x), Y(p.y));
    c.scale(0.48, 0.48);
    drawRobot(c, { x: 0, y: 0 }, { theta: -p.theta, left: 1, right: 1 });
    c.restore();
    c.fillStyle = '#c7dae0';
    c.font = '16px system-ui';
    c.textAlign = 'left';
    c.fillText('出発点', X(0) + 12, Y(0) + 24);
    c.strokeStyle = '#c7dae0';
    c.beginPath();
    c.moveTo(30, H - 20);
    c.lineTo(30 + k, H - 20);
    c.stroke();
    c.fillText('1 m', 35, H - 29);
  }
}
function drawErrorGraph() {
  if (!log.reference) {
    $('slamErrorGraph').innerHTML = '';
    $('slamGraphNote').textContent =
      '実機ログに正解位置はないため、位置誤差のグラフは表示しません。戻り位置だけで、途中の精度を判断しないようにしましょう。';
    return;
  }
  const W = 720,
    H = 190,
    L = 52,
    R = 700,
    T = 22,
    B = 150,
    series = runs.map((r) => ({
      r,
      values: r.states.map((p, i) =>
        Math.hypot(p.x - log.reference[i].x, p.y - log.reference[i].y),
      ),
    })),
    max = Math.max(0.2, ...series.flatMap((s) => s.values));
  $('slamErrorGraph').innerHTML =
    '<svg viewBox="0 0 ' +
    W +
    ' ' +
    H +
    '" role="img" aria-label="時間に対する位置の誤差"><path d="M' +
    L +
    ',' +
    T +
    'V' +
    B +
    'H' +
    R +
    '" fill="none" stroke="#9aafb2"/>' +
    series
      .map(
        ({ r, values }) =>
          '<polyline fill="none" stroke="' +
          { wheel: '#a65a32', imu: '#366da0', slam: '#236f61' }[r.method] +
          '" stroke-width="2.5" ' +
          (r.calibrate ? 'stroke-dasharray="7 3"' : '') +
          ' points="' +
          values
            .map(
              (v, i) =>
                (L + ((R - L) * i) / (values.length - 1)).toFixed(1) +
                ',' +
                (B - (v / max) * (B - T)).toFixed(1),
            )
            .join(' ') +
          '"/>',
      )
      .join('') +
    '<g fill="#587079" font-size="13"><text x="8" y="30">' +
    max.toFixed(1) +
    ' m</text><text x="26" y="152">0</text><text x="52" y="174">0秒</text><text x="650" y="174">' +
    log.frames.at(-1).t.toFixed(0) +
    '秒</text></g></svg>';
  $('slamGraphNote').textContent =
    '横軸は走行開始からの時間、縦軸は同じ時刻の実際の位置と推定位置の離れです。単位はmで、0.1 mは10 cm。下に近いほど正確です。橙＝車輪、青＝IMU追加、緑＝LiDAR追加、破線＝静止時の偏りを補正。終点だけでなく、途中で線が高くなる場所も比べます。';
}
let sensor = 'lidar';
function drawSensor() {
  if (!log || $('slamSensorBody').hidden) return;
  $('slamCameraChoice').hidden = sensor !== 'camera';
  $('slamTiltDemo').hidden = sensor !== 'imu';
  $('slamSensorName').textContent = SENSOR_COPY[sensor].name;
  $('slamSensorTitle').textContent = SENSOR_COPY[sensor].title;
  const c = sharpCanvas('slamSensorCanvas', 800, 320),
    f = log.frames[cursor],
    W = 800,
    H = 320;
  c.fillStyle = '#f4f8fa';
  c.fillRect(0, 0, W, H);
  c.fillStyle = '#2e505c';
  c.font = '18px system-ui';
  c.textAlign = 'left';
  if (sensor === 'lidar') {
    const cx = 400,
      cy = 168,
      k = 40;
    c.strokeStyle = '#d2e0e5';
    for (let r = 1; r <= 3; r++) {
      c.beginPath();
      c.arc(cx, cy, r * k, 0, 2 * Math.PI);
      c.stroke();
    }
    c.fillStyle = '#284c60';
    c.beginPath();
    c.moveTo(cx, cy - 9);
    c.lineTo(cx - 7, cy + 6);
    c.lineTo(cx + 7, cy + 6);
    c.fill();
    f.ranges.forEach((r, i) => {
      if (r === null) return;
      const a = f.angleMin + i * f.angleIncrement;
      c.fillStyle = r < 0.5 ? '#bc782d' : '#3d8c83';
      c.beginPath();
      c.arc(cx - r * Math.sin(a) * k, cy - r * Math.cos(a) * k, 2.6, 0, Math.PI * 2);
      c.fill();
    });
    $('slamSensorText').textContent =
      '中央がLiDAR、上がその正面です。中心から点までの長さが、その方向で測った距離を表し、円の間隔は1 mです。ここは地図全体ではなく、今いる機体から見た周囲の形です。LiDARを位置計算にも使う方法では、この形を過去の地図へ重ね、位置を調整します。';
  } else if (sensor === 'camera') {
    drawSlamCamera(c, log, cursor, W, H, $('slamCameraMode').value);
    $('slamSensorTitle').textContent =
      log.source === 'hardware' ? 'RGB・デプスは未収録' : 'ロボットの正面に見えるもの';
    $('slamSensorText').textContent =
      log.source === 'hardware'
        ? '読み込んだログにはRGB・デプス画像がないため、カメラ映像は表示できません。ブラウザのシミュレーション映像とは別のデータです。'
        : '1台のRGB-DカメラのRGBとデプスを切り替えます。両方とも「実際の走行」と同じ位置・向きの部屋から描く模擬画像で、デプスは正面方向の奥行きZです（0.25〜5 mは教材上の範囲）。点群を地図に重ねるには撮影時の位置・向きも必要です。今回の自己位置計算は車輪・IMU・2D LiDARを使い、RGB-D SLAMは実装していません。';
  } else {
    const values = log.frames.slice(0, cursor + 1),
      wheels = sensor === 'wheels',
      keys = wheels ? ['leftRpm', 'rightRpm'] : ['gyroZ'],
      scale = wheels ? 1 : 180 / Math.PI;
    // Keep the axes fixed while replaying; IMU ticks and the current value use degrees/second.
    const peak = Math.max(
        wheels ? 50 : 5,
        ...log.frames.flatMap((v) => keys.map((key) => Math.abs(v[key] * scale))),
      ),
      step = peak > 20 ? 10 : 1,
      max = Math.ceil(peak / step) * step;
    const endTime = log.frames.at(-1).t,
      X = (t) => 76 + (t / Math.max(0.01, endTime)) * 684,
      Y = (v) => 154 - (v / max) * 100;
    const labelSize = Math.max(
      18,
      Math.min(32, (12 * 800) / ($('slamSensorCanvas').getBoundingClientRect().width || 800)),
    );
    c.font = labelSize + 'px system-ui';
    c.lineWidth = 1;
    for (const value of [-max, 0, max]) {
      c.strokeStyle = value === 0 ? '#9bafb7' : '#dae4e8';
      c.beginPath();
      c.moveTo(76, Y(value));
      c.lineTo(760, Y(value));
      c.stroke();
      c.fillStyle = '#2e505c';
      c.textAlign = 'right';
      c.fillText(String(value), 64, Y(value) + 6);
    }
    c.strokeStyle = '#9bafb7';
    c.beginPath();
    c.moveTo(76, 54);
    c.lineTo(76, 254);
    c.stroke();
    keys.forEach((key, index) => {
      c.strokeStyle = index ? '#4a9c8c' : '#518bc7';
      c.lineWidth = 2;
      c.beginPath();
      values.forEach((v, i) =>
        i ? c.lineTo(X(v.t), Y(v[key] * scale)) : c.moveTo(X(v.t), Y(v[key] * scale)),
      );
      c.stroke();
    });
    c.fillStyle = '#2e505c';
    c.textAlign = 'left';
    c.fillText(
      wheels
        ? '左 ' + f.leftRpm.toFixed(1) + ' rpm / 右 ' + f.rightRpm.toFixed(1) + ' rpm'
        : '回転の速さ ' + ((f.gyroZ * 180) / Math.PI).toFixed(2) + ' °/秒',
      76,
      28,
    );
    c.textAlign = 'right';
    c.fillText(wheels ? '縦軸：rpm' : '縦軸：°/秒', 760, 28);
    c.textAlign = 'left';
    c.fillText('0秒', 76, 287);
    c.textAlign = 'center';
    c.fillText((endTime / 2).toFixed(1) + '秒', X(endTime / 2), 287);
    c.textAlign = 'right';
    c.fillText(endTime.toFixed(1) + '秒', 760, 287);
    c.textAlign = 'left';
    $('slamSensorText').textContent =
      sensor === 'wheels'
        ? '横軸は時間、縦方向は車輪の回る速さで、青が左、緑が右です。rpmは1分間の回転数、0より下は逆回転を表します。滑らなければ左右が同じ速さで直進し、差があると曲がります。回転数センサーは空回りも数えるため、床で滑った分はこのグラフだけでは分かりません。'
        : '横軸は時間、縦方向は床の上で機体が回る速さです。0より上は左回り、下は右回りで、上の数値は1秒あたり何度回るかを表します。止まっている最初の2秒でも0からずれていれば、その偏りも向きの計算に足され続けます。補正は、この静止時の平均値を測定値から引く操作です。' +
          (f.accel
            ? ' 加速度 z：' + f.accel[2].toFixed(2) + ' m/秒²（水平に静止したときは約9.81 m/秒²）。'
            : '') +
          (active?.calibrate ? ' 補正に使った静止データ：' + active.calibrationCount + '回。' : '');
  }
}
function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000 || 0);
  last = now;
  if (playing && !$('slamPage').hidden && active) {
    elapsed += dt * Number($('slamSpeed').value);
    let next = cursor;
    while (next < log.frames.length - 1 && log.frames[next].t < elapsed) next++;
    if (next !== cursor) {
      cursor = next;
      if (cursor === log.frames.length - 1) {
        playing = false;
        slamStage = 'test';
      }
      render();
    }
  }
  requestAnimationFrame(tick);
}
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type })),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function drawTilt() {
  const roll = (Number($('slamRoll').value) * Math.PI) / 180,
    pitch = (Number($('slamPitch').value) * Math.PI) / 180,
    c = sharpCanvas('slamTiltCanvas', 440, 190),
    values = [
      -9.81 * Math.sin(pitch),
      9.81 * Math.sin(roll) * Math.cos(pitch),
      9.81 * Math.cos(roll) * Math.cos(pitch),
    ];
  c.fillStyle = '#edf4f6';
  c.fillRect(0, 0, 440, 190);
  c.strokeStyle = '#768d99';
  c.beginPath();
  c.moveTo(25, 110);
  c.lineTo(220, 110);
  c.stroke();
  c.save();
  c.translate(120, 100 + pitch * 45);
  c.rotate(roll);
  c.fillStyle = '#83b5c7';
  c.fillRect(-64, -12, 128, 24);
  c.fillStyle = '#1b4256';
  c.fillRect(-55, 12, 27, 13);
  c.fillRect(30, 12, 27, 13);
  c.restore();
  c.fillStyle = '#315462';
  c.font = '16px system-ui';
  ['前後 x', '左右 y', '上下 z'].forEach((text, i) => {
    c.fillText(text, 260, 35 + i * 51);
    c.fillStyle = ['#be884c', '#5686c3', '#358879'][i];
    c.fillRect(260, 42 + i * 51, values[i] * 12, 12);
    c.fillStyle = '#315462';
  });
  $('slamTiltReading').textContent =
    '前後 ' +
    $('slamPitch').value +
    '° / 左右 ' +
    $('slamRoll').value +
    '°。加速度：x ' +
    values[0].toFixed(2) +
    '、y ' +
    values[1].toFixed(2) +
    '、z ' +
    values[2].toFixed(2) +
    ' m/s²';
}

function exportResults() {
  if (!runs.length) return;
  const rows = ['experiment,method,gyro_calibrated,time_s,x_m,y_m,yaw_rad,position_error_m'];
  for (let n = 0; n < runs.length; n++) {
    const r = runs[n];
    r.states.forEach((s, i) => {
      const truth = log.reference?.[i];
      rows.push(
        [
          n + 1,
          r.method,
          r.calibrate,
          s.t,
          s.x,
          s.y,
          s.theta,
          truth ? Math.hypot(s.x - truth.x, s.y - truth.y) : '',
        ].join(','),
      );
    });
  }
  download('robo-lab-estimates.csv', rows.join('\n'), 'text/csv');
}

export { initSlam, pauseSlam, reviewSlam };
