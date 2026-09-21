import { lessonLabel } from '../shell/lesson-ui.js';
import { validateRGBD, depthInBox } from '../core/depth-core.js';
import { setDepthFrame, getDepthFrame, clearDepthFrame } from './depth-ui.js';
import { lessonGuide, figureGuide } from '../shell/lesson-guide.js';
import {
  detectionTags,
  imageOperation,
  imageFeatures,
  trainImageClassifier,
  classifyImage,
  markerBits,
  rotateBits,
  quadTransform,
  detectMarkers,
} from './core.js';
import { makeVisionImage, visionTestSet } from './images.js';
import { latestRobot, robotState } from '../live/robot-link.js';
import {
  FACE_SAMPLE_URL,
  FACE_SAMPLE_NAME,
  FACE_SCORE,
  loadFaceDetector,
  faceDetectorReady,
  detectFaces,
  selectFaces,
} from './face.js';
import { VISION_ROS_GUIDE, VISION_ROS_SCRIPT, VISION_RGBD_SCRIPT } from './ros.js';
import {
  VISION_CHAPTERS,
  VISION_GROUPS,
  FOUNDATION_CONTENT,
  foundationSource,
  renderFoundation,
  pauseVisionBasics,
  pendingVisionOutput,
} from './basics.js';

const $ = (id) => document.getElementById(id),
  chapters = VISION_CHAPTERS,
  names = ['荷箱', 'ボール'];
let chapter = 'capture',
  started = false,
  source = null,
  sourceName = '教材画像',
  external = false,
  sourceVersion = 0,
  processed = null,
  mode = 'red',
  threshold = 60,
  condition = 'normal',
  classifier = null,
  samples = [],
  history = [],
  testResults = null,
  featureMode = 'color',
  nextId = 1,
  candidate = 0,
  reviewingTest = false,
  markerId = 0,
  markerTurn = 0,
  markerTilt = 0,
  markerCover = false,
  markerResult = null,
  output = null,
  faceBusy = false,
  faceThreshold = FACE_SCORE.initial,
  status = '',
  stream = null,
  cameraRequest = 0;
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
function download(name, data, type) {
  const a = document.createElement('a'),
    url = URL.createObjectURL(new Blob([data], { type }));
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function imageCanvas(image) {
  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  c.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  return c;
}
function showImage(canvas, image) {
  if (canvas.id === 'visionOutput') {
    $('visionPending').hidden = true;
    canvas.hidden = false;
  }
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
}
function cloneImage(image) {
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
}
function sampleSource() {
  external = false;
  sourceName =
    chapter === 'regions'
      ? '室内の教材画像（AI生成）・細かな点や暗さは実験用に追加'
      : '教材画像（カメラの見え方を想定）';
  source = FOUNDATION_CONTENT[chapter]
    ? foundationSource(chapter)
    : chapter === 'marker'
      ? makeMarker()
      : makeVisionImage({
          kind: chapter === 'learn' ? candidate % 2 : 0,
          color:
            chapter === 'learn'
              ? candidate < 2
                ? 'red'
                : 'blue'
              : condition === 'blue'
                ? 'blue'
                : 'red',
          light: condition === 'dark' ? 0.55 : 1,
          variant: candidate,
          clutter: chapter === 'pixels' && condition === 'clutter',
        });
  invalidate();
}
function invalidate() {
  reviewingTest = false;
  sourceVersion++;
  processed = null;
  markerResult = null;
  output = null;
  status = '';
}
function initVision() {
  $('visionPage').innerHTML = '<div id="visionRoot"></div>';
  document.addEventListener('series-leave', stopCamera);
  document.addEventListener('series-leave', pauseVisionBasics);
  document.addEventListener('supplement-open', pauseVisionBasics);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopCamera();
      pauseVisionBasics();
    }
  });
}
function activateVision() {
  if (!started) {
    started = true;
    for (let label = 0; label < 2; label++)
      for (let v = 0; v < 2; v++)
        samples.push({
          id: nextId++,
          label,
          image: makeVisionImage({ kind: label, color: label ? 'blue' : 'red', variant: v }),
        });
    sampleSource();
  }
  render();
}
function render() {
  stopCamera();
  pauseVisionBasics();
  $('visionRoot').dataset.chapter = chapter;
  const content =
    FOUNDATION_CONTENT[chapter] ||
    {
      pixels: [
        '赤い荷箱を探すために、画素の色を調べる',
        '画素の色や明るさを数値として調べると、色を取り出したり、形の境目を見つけたりできます。',
      ],
      learn: [
        '画像の例を教えて、荷箱とボールを見分ける',
        '「この画像は荷箱」と名前を付けた例から分類器を作り、学習に使わなかった画像で確かめます。',
      ],
      marker: [
        '届け先の目印を、白黒の番号で見分ける',
        '決められた模様を目印にすると、ロボットは場所や物を区別できます。回転しても同じIDとして読めるでしょうか。',
      ],
      face: [
        '人の顔が、画像のどこにあるかを探す',
        '顔検出器は、顔の画像と顔でない画像の例から学習した検出モデルです。ここでは学習済みの検出器を使います。',
      ],
    }[chapter];
  $('visionRoot').innerHTML =
    `<div class="page-heading"><div><p class="eyebrow course-label">${lessonLabel('vision')}</p><h1>${content[0]}</h1></div></div><nav class="basics-topics vision-groups" aria-label="学ぶ順序">${VISION_GROUPS.map((label, i) => `<button data-vision-group="${i}" aria-pressed="${chapters.find((c) => c[0] === chapter)[2] === i}"><span>${i + 1}</span>${label}</button>`).join('')}</nav><nav class="vision-subtopics" aria-label="この段階の実験">${chapters
      .filter((c) => c[2] === chapters.find((v) => v[0] === chapter)[2])
      .map(
        ([key, label]) =>
          `<button data-vision-chapter="${key}" aria-pressed="${chapter === key}">${label}</button>`,
      )
      .join('')}</nav>
 ${lessonGuide('vision-' + chapter)}
 <div class="vision-sourcebar" ${['geometry', 'follow', 'stereo'].includes(chapter) ? 'hidden' : ''}><span id="visionSourceName"></span><div><button id="visionSample" class="small">教材画像に戻す</button><label class="vision-file small" ${chapter === 'depth' ? 'hidden' : ''}>画像を開く<input id="visionFile" type="file" accept="image/png,image/jpeg,image/webp"></label><button id="visionCamera" class="small" ${chapter === 'depth' ? 'hidden' : ''}>RGB画像を撮る</button><button id="visionRobot" class="small" ${chapter === 'depth' ? 'hidden' : ''}>実機カメラの画像を使う</button><label class="vision-file small" ${['depth', 'face'].includes(chapter) ? '' : 'hidden'}>RGB-Dログを開く<input id="visionRGBDFile" type="file" accept="application/json,.json"></label></div></div>
 <section class="card vision-capture" id="visionCapture" hidden><video id="visionVideo" autoplay playsinline muted></video><div><p>この端末で取得できるRGB映像です。この操作では奥行きは取得しません。ロボットのRGBとデプスの組は、ROS 2で保存した「RGB-Dログ」から読み込みます。</p><button id="visionCaptureNow" class="primary">この1枚を使う</button><button id="visionCameraStop">カメラを閉じる</button></div></section>
 <div class="experiment-layout vision-layout"><div class="vision-workspace"><section class="card vision-scene"><div id="visionMotion" class="vision-motion" hidden></div><div class="vision-image-pair"><figure><figcaption><strong id="visionInputTitle">RGB画像</strong><span id="visionInputNote"></span></figcaption><canvas id="visionInput" width="320" height="220" role="img" aria-label="画像処理に使う画像"></canvas></figure><figure><figcaption><strong id="visionOutputTitle"></strong><span id="visionOutputNote"></span></figcaption><canvas id="visionOutput" width="320" height="220" role="img" aria-label="画像処理・認識の結果"></canvas><div id="visionPending" class="vision-pending" hidden></div></figure></div>${external && chapter !== 'learn' ? '<p class="figure-guide"><strong>自分の画像で試す</strong>教材の目印や正解は、この画像には当てはまりません。選ばれた画素や囲み枠を、元の画像と見比べて確認します。</p>' : figureGuide('vision-' + chapter)}<div id="visionReading" class="vision-reading" role="status"></div><div id="visionPixel" class="vision-pixel" ${chapter === 'pixels' ? '' : 'hidden'}><div id="visionPixelGrid"></div><p id="visionPixelText">左の画像を押すと、その場所の画素とRGBの値を見られます。</p></div></section><section id="visionEvidence" class="card vision-evidence" hidden></section></div><aside class="guide card" id="visionControls"></aside></div>
 <section id="visionReflect" class="card vision-reflect"></section><div class="basics-footer"><p id="visionTakeaway"></p><button class="primary" id="visionNext"></button></div>
 <details data-help-dialog class="method-note vision-real"><summary>ロボットのRGB-Dカメラで確かめる · ROS 2</summary><div class="method-grid"><div><h3>同じ物を、違う条件で撮る</h3><p>1台のRGB-Dカメラから、色の画像であるRGBと、画素ごとの奥行きであるデプスを記録します。二つの画像の同じ画素が同じ物を表すよう位置を合わせ、カメラの写り方を表す校正値も保存します。明るさ・距離・反射を一つずつ変え、学習用とテスト用は撮影する場面を分けます。</p><button id="visionRosDownload">RGB画像の保存</button><button id="visionRGBDDownload">RGB-Dログの保存</button></div><div><h3>RGB画像・RGB-Dログを教材で開く</h3><p>RGB画像では撮り方、色の抽出、分類、マーカー、顔検出を確かめます。RGB-Dログでは奥行きの値や、検出した枠の中の奥行きも調べられます。見逃しと誤検出の両方を数えましょう。</p><button id="visionGuideDownload">実機の実験手順</button></div><div><h3>実機で扱う前に知ること</h3><p>画像の左右はカメラの左右です。物体までの距離や床上の位置は、RGBの囲み枠だけでは分かりません。RGB-Dログでは、同じ時刻・同じ画素に位置合わせした奥行きを使えます。校正や取り付け姿勢も確認します。</p></div></div></details>
 <details data-help-dialog class="method-note"><summary>この教材の計算と参考資料</summary><p>画像処理は画素の数値を実際に計算します。教師あり学習は色・形の特徴を用いる最近傍法で、深層学習ではありません。ARマーカーはArUco 4×4のID 0〜3に対応する簡易検出器です。強い傾きや複雑な背景では見つからない場合があります。マーカーからの姿勢・距離の推定は行いません。顔検出は、画素の明るさを比べる決定木を重ねた検出器（pico）を使い、正面に近い顔を対象とします。</p><p>撮影条件は明るさの倍率・横方向の平均・面積平均による縮小で簡略化します。色の抽出はRGB/HSV、領域は上下左右のつながりから実際に計算します。RGBからの位置と距離の実験は、ゆがみのない正面向きの目印を仮定します。ステレオ実験は配置から左右の画像を描く幾何モデルです。模擬デプスは配置から作り、実際の画素照合は行いません。デプスの欠けも教材用の例です。ライン追従は、毎回の模擬画像からずれを求めて2輪の運動を計算します。</p><p><a href="https://docs.opencv.org/4.10.0/df/d9d/tutorial_py_colorspaces.html" target="_blank" rel="noreferrer">OpenCV：色の表し方</a> · <a href="https://docs.opencv.org/4.12.0/d9/d61/tutorial_py_morphological_ops.html" target="_blank" rel="noreferrer">領域を整える処理</a> · <a href="https://docs.opencv.org/4.13.0/dc/dbb/tutorial_py_calibration.html" target="_blank" rel="noreferrer">カメラ校正</a></p><p><a href="https://docs.opencv.org/4.x/dd/d53/tutorial_py_depthmap.html" target="_blank" rel="noreferrer">OpenCV：左右の視差と奥行き</a> · <a href="https://github.com/ros-infrastructure/rep/blob/master/rep-0118.rst" target="_blank" rel="noreferrer">ROS REP 118：デプス画像の単位と欠測</a></p><p>顔検出は端末内で実行します。検出器のファイルは教材と同じ場所から読み込み、画像はサーバーに送信しません。教材はモーター指令を送りません。</p><p><a href="https://docs.opencv.org/4.x/d5/dae/tutorial_aruco_detection.html" target="_blank" rel="noreferrer">OpenCVのArUco解説</a> · <a href="https://github.com/nenadmarkus/picojs" target="_blank" rel="noreferrer">利用する顔検出器 pico.js（MITライセンス）</a></p></details>`;
  document
    .querySelectorAll('[data-vision-chapter]')
    .forEach((b) => (b.onclick = () => changeChapter(b.dataset.visionChapter)));
  document
    .querySelectorAll('[data-vision-group]')
    .forEach(
      (b) =>
        (b.onclick = () =>
          changeChapter(chapters.find((c) => c[2] === Number(b.dataset.visionGroup))[0])),
    );
  $('visionSample').onclick = () => {
    clearDepthFrame();
    sampleSource();
    render();
  };
  $('visionRGBDFile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const requestChapter = chapter,
      version = sourceVersion;
    try {
      if (f.size > 16000000) throw Error('RGB-Dログは16 MB以下にしてください。');
      const frame = validateRGBD(JSON.parse(await f.text()));
      if (chapter !== requestChapter || sourceVersion !== version) return;
      setDepthFrame(frame);
      source = { width: frame.width, height: frame.height, data: frame.rgb };
      external = true;
      sourceName = 'RGBと奥行きの計測ログ';
      invalidate();
      render();
    } catch (error) {
      setStatus(error.message);
    }
  };
  $('visionFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      if (file.size > 12000000) throw Error('画像は12 MB以下にしてください。');
      await readImage(URL.createObjectURL(file), file.name, true);
    } catch (e) {
      setStatus(e.message);
    }
  };
  $('visionCamera').onclick = startCamera;
  $('visionRobot').onclick = useRobotCamera;
  $('visionCameraStop').onclick = stopCamera;
  $('visionCaptureNow').onclick = capture;
  $('visionRGBDDownload').onclick = () =>
    download('robo_lab_rgbd_capture.py', VISION_RGBD_SCRIPT, 'text/x-python');
  $('visionRosDownload').onclick = () =>
    download('robo_lab_camera_capture.py', VISION_ROS_SCRIPT, 'text/x-python');
  $('visionGuideDownload').onclick = () =>
    download('QUESTiX-LAB-画像処理-実機手順.md', VISION_ROS_GUIDE, 'text/markdown');
  $('visionNext').textContent =
    chapter === 'face'
      ? '小テストで確かめる →'
      : '次へ：' + chapters[chapters.findIndex((c) => c[0] === chapter) + 1][1] + ' →';
  $('visionNext').onclick = () => {
    if (chapter === 'face') {
      document.dispatchEvent(new CustomEvent('quiz-open', { detail: 'vision' }));
      return;
    }
    changeChapter(chapters[chapters.findIndex((c) => c[0] === chapter) + 1][0]);
    $('visionRoot').scrollIntoView({ block: 'start' });
  };
  $('visionSourceName').textContent = sourceName;
  $('visionInputNote').textContent = source.width + ' × ' + source.height + ' 画素';
  showImage($('visionInput'), source);
  showImage($('visionOutput'), source);
  $('visionInput').onclick = (e) => {
    if (chapter !== 'pixels') return;
    const r = e.currentTarget.getBoundingClientRect();
    pixel(
      Math.min(source.width - 1, Math.floor(((e.clientX - r.left) / r.width) * source.width)),
      Math.min(source.height - 1, Math.floor(((e.clientY - r.top) / r.height) * source.height)),
    );
  };
  if (FOUNDATION_CONTENT[chapter])
    renderFoundation(chapter, {
      source,
      external,
      showImage,
      setStatus,
      replaceSample: () => {
        sampleSource();
        render();
      },
    });
  else if (chapter === 'pixels') renderPixels();
  else if (chapter === 'learn') renderLearning();
  else if (chapter === 'marker') renderMarker();
  else renderFace();
}
function changeChapter(next) {
  const previous = chapter;
  chapter = next;
  stopCamera();
  pauseVisionBasics();
  if (
    reviewingTest ||
    !external ||
    ['geometry', 'follow', 'stereo', 'depth'].includes(chapter) ||
    ['geometry', 'follow', 'stereo', 'depth'].includes(previous)
  )
    sampleSource();
  else invalidate();
  render();
}
function reviewVision(id) {
  if (!chapters.some((t) => t[0] === id)) return false;
  changeChapter(id);
  return true;
}
function setStatus(text) {
  status = text;
  if ($('visionReading')) $('visionReading').textContent = text;
}
function pixel(x, y) {
  const k = (y * source.width + x) * 4,
    rgb = Array.from(source.data.slice(k, k + 3));
  $('visionPixelText').textContent =
    `横 ${x}・縦 ${y} の画素：赤 ${rgb[0]} / 緑 ${rgb[1]} / 青 ${rgb[2]}。それぞれ0〜255の強さです。画像は、このような数値が並んだものです。`;
  let cells = '';
  for (let yy = y - 4; yy <= y + 4; yy++)
    for (let xx = x - 4; xx <= x + 4; xx++) {
      const p =
        (Math.max(0, Math.min(source.height - 1, yy)) * source.width +
          Math.max(0, Math.min(source.width - 1, xx))) *
        4;
      cells += `<i style="background:rgb(${source.data[p]},${source.data[p + 1]},${source.data[p + 2]})" ${xx === x && yy === y ? 'class="selected"' : ''}></i>`;
    }
  $('visionPixelGrid').innerHTML = cells;
}
function renderPixels() {
  $('visionOutputTitle').textContent = '処理した画像';
  $('visionControls').innerHTML =
    `<p class="eyebrow">条件を決める</p><h2>赤い荷箱の画素を選ぶ条件を決める</h2><p>まず赤い荷箱を探してみましょう。赤さが設定した値を超える画素だけを残すと、何が見えるでしょうか。</p><label class="vision-select">処理の方法<select id="visionMode"><option value="red">赤い部分を取り出す</option><option value="gray">明るさだけにする（グレースケール）</option><option value="binary">明るさで白黒に分ける（二値化）</option><option value="edge">明るさの境目を探す（輪郭）</option></select></label><label class="basics-slider" for="visionThreshold">判断のしきい値 <output id="visionThresholdValue">${threshold}</output><input id="visionThreshold" type="range" min="0" max="230" value="${threshold}"></label><button id="visionProcess" class="primary full">この条件で処理する</button><label class="vision-select">撮影する場面<select id="visionCondition" ${external ? 'disabled' : ''}><option value="normal">明るい場所の赤い荷箱</option><option value="dark">照明を暗くする</option><option value="blue">青い荷箱に置き換える</option><option value="clutter">背景にも赤い物を置く</option></select></label><p class="helper">しきい値は、選ぶ・選ばないを分ける境界です。「赤い部分」では、赤が緑・青よりどれだけ強いかを比べます。たとえばRGBが180・70・50なら差は110なので、しきい値60では残り、120では消えます。値を変えた後は処理ボタンを押してください。</p>`;
  $('visionMode').value = mode;
  $('visionCondition').value = condition;
  $('visionMode').onchange = () => {
    mode = $('visionMode').value;
    processed = null;
    renderPixels();
  };
  $('visionThreshold').disabled = mode === 'gray';
  $('visionThreshold').oninput = () => {
    threshold = Number($('visionThreshold').value);
    $('visionThresholdValue').textContent = threshold;
    setStatus('条件を変更しました。「この条件で処理する」で結果を更新します。');
  };
  $('visionProcess').onclick = () => {
    processed = imageOperation(source, mode, threshold);
    showImage($('visionOutput'), processed);
    $('visionOutputNote').textContent = {
      red: '赤 − 緑・青の大きい方 > ' + threshold,
      gray: 'RGBから明るさを計算',
      binary: '明るさ ≥ ' + threshold,
      edge: '周囲との明るさの差を計算',
    }[mode];
    setStatus(
      mode === 'red'
        ? `全${source.width * source.height}画素のうち、${processed.selected}画素を選びました。白い部分が、決めた条件に合った場所です。`
        : 'グレースケールは色の違いを捨て、明るさを残します。二値化は境界以上の明るさを白、それ以外を黒にします。輪郭は周囲との明るさの差を調べるので、箱の縁だけでなく影の境目にも線が出ます。選んだ処理の結果を元の画像と比べてください。',
    );
  };
  $('visionCondition').onchange = () => {
    condition = $('visionCondition').value;
    sampleSource();
    render();
  };
  if (processed) showImage($('visionOutput'), processed);
  else {
    pendingVisionOutput('「この条件で処理する」を押すと、画素を計算した結果を表示します。');
    setStatus('左の箱をクリックして画素を確かめたら、右の条件で処理してください。');
    $('visionOutputNote').textContent = 'まだ処理していません';
  }
  $('visionReflect').innerHTML =
    '<h2>赤いところが見つかれば、荷箱だと言える？</h2><p>背景にも赤い物がある場面で試してみましょう。条件を厳しくすると背景は消えても、暗い荷箱まで消えることがあります。</p><details><summary>考えるためのヒント</summary><p>この処理が調べているのは「赤さ」です。「荷箱」という物の意味を理解しているわけではありません。色だけで区別できないとき、形も手がかりになるでしょうか。</p></details>';
  $('visionTakeaway').textContent =
    '画像処理は、画素の数値に計算をすること。今は人が決めたルールで、必要な情報を取り出しました。';
  pixel(Math.floor(source.width / 2), Math.floor(source.height / 2));
}
function renderLearning() {
  if (!classifier)
    pendingVisionOutput('用意された画像と正解の組で学習すると、判定に使った例を表示します。');
  $('visionOutputTitle').textContent = '判定と、似ていた学習画像';
  $('visionOutputNote').textContent = classifier
    ? '学習画像に近い特徴から分類'
    : 'まだ学習していません';
  $('visionControls').innerHTML =
    `<p class="eyebrow">画像を集める → 学習 → テスト</p><h2>荷箱・ボールの正解を画像に付ける</h2><p>画像に付ける正しい名前を<strong>ラベル</strong>と呼びます。分類器は、新しい画像にどのラベルを付けるか決める仕組みです。ここでは色の割合や形を数値にした「特徴」を比べ、特徴が最も近い学習画像のラベルを答えにします。</p><div class="vision-labels"><button data-vision-label="0">荷箱として登録</button><button data-vision-label="1">ボールとして登録</button></div><button id="visionNewSample" class="full small">別の色・形の画像を用意する</button><label class="vision-select">分類の手がかり<select id="visionFeatures"><option value="color">色だけ</option><option value="both">色と形</option><option value="shape">形だけ</option></select></label><button id="visionTrain" class="primary full">${samples.length}枚の画像で学習する</button><button id="visionTest" class="full" ${classifier ? '' : 'disabled'}>学習に使っていない10枚でテスト</button><p class="helper">形の特徴には、囲み枠の縦横の比や、枠を物体の画素がどれだけ埋めるかを使います。箱と丸いボールでは、この値が違うことが手がかりになります。1枚の1つの物体を分類する方法なので、写真では背景を単純にし、色のある物体を中央に大きく写してください。</p><button id="visionDataSave" class="text-button">登録した画像とラベルを保存</button>`;
  $('visionFeatures').value = featureMode;
  $('visionFeatures').onchange = () => {
    featureMode = $('visionFeatures').value;
    classifier = null;
    testResults = null;
    renderLearning();
    setStatus('手がかりを変えました。もう一度学習してから、同じ10枚で比べましょう。');
  };
  document.querySelectorAll('[data-vision-label]').forEach(
    (b) =>
      (b.onclick = () => {
        if (samples.length >= 40) {
          setStatus('この実験では40枚まで登録できます。不要な例を削除して入れ替えてください。');
          return;
        }
        if (!imageFeatures(source).valid) {
          setStatus(
            '色のある物体を十分に見つけられません。明るい場所で、物体を大きく写してください。',
          );
          return;
        }
        samples.push({
          id: nextId++,
          label: Number(b.dataset.visionLabel),
          image: cloneImage(source),
        });
        classifier = null;
        testResults = null;
        renderLearning();
        setStatus('画像とラベルを登録しました。学習し直すと、新しい例が判定に使われます。');
      }),
  );
  $('visionNewSample').onclick = () => {
    candidate = (candidate + 1) % 4;
    condition = 'normal';
    sampleSource();
    render();
  };
  $('visionTrain').onclick = () => {
    try {
      classifier = trainImageClassifier(samples, featureMode);
      renderLearning();
      showPrediction();
      setStatus(
        '登録した画像の特徴とラベルから分類器を作りました。次は、別に用意した10枚で確かめましょう。',
      );
    } catch (e) {
      setStatus(e.message);
    }
  };
  $('visionTest').onclick = () => {
    testResults = visionTestSet().map((t) => ({
      ...t,
      prediction: classifyImage(classifier, t.image),
    }));
    const correct = testResults.filter((t) => t.label === t.prediction.label).length;
    history.push({ correct, count: samples.length, mode: featureMode });
    renderLearning();
    setStatus(
      `学習に使っていない10枚中、${correct}枚を正しく分類しました。下の画像を選ぶと、間違えた例も詳しく見られます。`,
    );
  };
  $('visionDataSave').onclick = () =>
    download(
      'QUESTiX-LAB-画像とラベル.json',
      JSON.stringify(
        {
          format: 'robo-lab-image-labels-v1',
          labels: names,
          samples: samples.map((s) => ({
            label: names[s.label],
            image: imageCanvas(s.image).toDataURL('image/png'),
          })),
        },
        null,
        2,
      ),
      'application/json',
    );
  $('visionEvidence').hidden = false;
  $('visionEvidence').innerHTML =
    `<div class="section-top"><h2>学習に使う画像 · ${samples.length}枚</h2><span class="helper">名前は人が付けた正解</span></div><div class="vision-dataset">${samples.map((s) => `<div><button data-sample="${s.id}" aria-label="${esc(names[s.label])}として登録した画像 ${s.id}"><img src="${imageCanvas(s.image).toDataURL()}" alt="学習画像"><span>${names[s.label]}</span></button><button class="vision-remove" data-remove="${s.id}" aria-label="学習画像 ${s.id}を削除">×</button></div>`).join('')}</div>${testResults ? '<h3>別の10枚で確かめた結果</h3><div class="vision-test-grid">' + testResults.map((t, i) => `<button data-test="${i}" class="${t.label === t.prediction.label ? 'correct' : 'incorrect'}"><img src="${imageCanvas(t.image).toDataURL()}" alt="${t.condition}の${names[t.label]}"><span>${t.label === t.prediction.label ? '○' : '×'} ${names[t.prediction.label] || '判定できず'}</span><small>正解：${names[t.label]}</small></button>`).join('') + '</div>' : ''}${
      history.length
        ? '<p class="vision-history">' +
          history
            .slice(-4)
            .map(
              (h, i) =>
                `${history.length - Math.min(4, history.length) + i + 1}回目：${h.correct}/10 正解（${h.count}枚・${{ color: '色', both: '色と形', shape: '形' }[h.mode]}）`,
            )
            .join(' → ') +
          '</p>'
        : ''
    }`;
  document.querySelectorAll('[data-sample]').forEach(
    (b) =>
      (b.onclick = () => {
        source = cloneImage(samples.find((s) => s.id === Number(b.dataset.sample)).image);
        sourceName = '登録した学習画像';
        external = true;
        invalidate();
        render();
        showPrediction();
      }),
  );
  document.querySelectorAll('[data-remove]').forEach(
    (b) =>
      (b.onclick = () => {
        samples = samples.filter((s) => s.id !== Number(b.dataset.remove));
        classifier = null;
        testResults = null;
        renderLearning();
        setStatus('学習画像を削除しました。もう一度学習してください。');
      }),
  );
  document.querySelectorAll('[data-test]').forEach(
    (b) =>
      (b.onclick = () => {
        const t = testResults[Number(b.dataset.test)],
          n = t.prediction.neighbors[0];
        source = cloneImage(t.image);
        sourceName = 'テスト専用の画像 · ' + t.condition;
        external = true;
        invalidate();
        reviewingTest = true;
        render();
        $('visionInputNote').textContent =
          'テスト画像 ' + (Number(b.dataset.test) + 1) + ' · 正解：' + names[t.label];
        $('visionOutputNote').textContent =
          '最も似た学習画像 · 判定：' + (names[t.prediction.label] || 'できず');
        setStatus(
          `テスト画像 ${Number(b.dataset.test) + 1}（${t.condition}）：正解は${names[t.label]}、判定は${names[t.prediction.label] || 'できず'}。${n ? '特徴が近かった学習画像のラベルは「' + names[n.label] + '」でした。' : ''}このテスト画像は学習に使いません。`,
        );
        document.querySelector('.vision-scene').scrollIntoView({ block: 'start' });
      }),
  );
  document.querySelectorAll('[data-vision-label]').forEach((b) => (b.disabled = reviewingTest));
  $('visionReflect').innerHTML =
    `<h2>${testResults ? '間違えた画像は、学習した画像と何が違う？' : '最初の学習画像に、偏りはない？'}</h2><p>最初にあるのは、赤い荷箱と青いボールです。色が違う荷箱やボールも区別できるでしょうか。</p><details><summary>改善を考えるためのヒント</summary><p>色を入れ替えた画像も正しくラベル付けして追加し、同じ10枚で再テストしましょう。「色と形」も手がかりにできます。一度に変える条件を一つにすると、改善の理由を確かめやすくなります。</p><p>このモデルは、特徴が最も近い学習画像のラベルを選ぶので、見本のラベルが間違っていれば判定にも影響します。また、同じ10枚を見て何度も直すと、その10枚にだけ合う工夫になることがあります。実機での確かめには、改善に使わなかった別の撮影場面も用意します。</p></details>`;
  $('visionTakeaway').textContent =
    '教師あり学習では、画像と正解の例が見分け方を決めます。学習した画像の成績だけでなく、別の画像で確かめることが大切です。';
  if (classifier) showPrediction();
  else
    setStatus(
      '登録した' + samples.length + '枚を見て、画像とラベルの対応を確かめてから学習しましょう。',
    );
}
function showPrediction() {
  if (!classifier) return;
  const p = classifyImage(classifier, source),
    nearest = samples.find((s) => s.id === p.neighbors[0]?.id);
  showImage($('visionOutput'), nearest?.image || source);
  $('visionOutputNote').textContent =
    p.label === null ? '判定できません' : '判定：' + names[p.label];
  if (p.neighbors.length)
    setStatus(`特徴が最も近かった学習画像は、${names[p.neighbors[0].label]}と教えられた画像です。`);
  else setStatus(p.reason);
}
function makeMarker() {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 220;
  const c = canvas.getContext('2d');
  c.fillStyle = '#e8eceb';
  c.fillRect(0, 0, 320, 220);
  const tilt = markerTilt,
    quad = [
      { x: 88 + tilt, y: 28 },
      { x: 240 - tilt, y: 40 },
      { x: 246, y: 196 },
      { x: 72, y: 187 },
    ],
    map = quadTransform(quad);
  let bits = markerBits(markerId);
  for (let i = 0; i < markerTurn; i++) bits = rotateBits(bits);
  const cell = (x, y, color) => {
    c.fillStyle = color;
    c.beginPath();
    [
      [x / 6, y / 6],
      [(x + 1) / 6, y / 6],
      [(x + 1) / 6, (y + 1) / 6],
      [x / 6, (y + 1) / 6],
    ].forEach(([u, v], i) => {
      const p = map(u, v);
      i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y);
    });
    c.closePath();
    c.fill();
  };
  c.fillStyle = '#101010';
  c.beginPath();
  quad.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
  c.closePath();
  c.fill();
  for (let y = 1; y < 5; y++)
    for (let x = 1; x < 5; x++) if (bits[(y - 1) * 4 + x - 1]) cell(x, y, '#fafafa');
  if (markerCover) {
    c.fillStyle = '#777';
    c.fillRect(118, 65, 60, 80);
  }
  return c.getImageData(0, 0, 320, 220);
}
function renderMarker() {
  $('visionOutputTitle').textContent = '白黒の模様と読み取ったID';
  $('visionControls').innerHTML =
    `<p class="eyebrow">条件を決める</p><h2>模様を変えて、読み取りを試す</h2><p>まず黒い四角の枠を探し、内側の縦4×横4、合計16マスの白黒を読みます。その並びを登録済みの模様と比べ、目印の番号であるIDを決めます。例えばID 2を充電場所に、ID 3を荷物の届け先に付けておけば、読んだ番号からどちらの場所かを区別できます。</p><label class="vision-select">教材画像のマーカー<select id="visionMarkerId" ${external ? 'disabled' : ''}>${[0, 1, 2, 3].map((id) => `<option value="${id}">ArUco ID ${id}</option>`).join('')}</select></label><button id="visionMarkerRotate" class="full" ${external ? 'disabled' : ''}>90°回す</button><label class="basics-slider">斜めから見る<input id="visionMarkerTilt" type="range" min="0" max="36" value="${markerTilt}" ${external ? 'disabled' : ''}></label><label class="basics-check"><input id="visionMarkerCover" type="checkbox" ${markerCover ? 'checked' : ''} ${external ? 'disabled' : ''}>模様の一部を隠す</label><label class="basics-slider" for="visionMarkerThreshold">白黒に分けるしきい値 <output id="visionMarkerThresholdValue">${threshold}</output><input id="visionMarkerThreshold" type="range" min="20" max="220" value="${threshold}"></label><button id="visionMarkerRead" class="primary full">模様からIDを読み取る</button><button id="visionMarkerPrint" class="full small">このIDの印刷用マーカーを保存</button><p class="helper">しきい値は、各マスを白とみなす明るさの境界です。値や見え方を変えた後は「模様からIDを読み取る」を押して比べます。この簡易検出器はArUco 4×4のID 0〜3に対応します。印刷した目印を撮影し、「画像を開く」からも試せます。</p>`;
  $('visionMarkerId').value = markerId;
  $('visionMarkerId').onchange = () => {
    markerId = Number($('visionMarkerId').value);
    sampleSource();
    render();
  };
  $('visionMarkerRotate').onclick = () => {
    markerTurn = (markerTurn + 1) % 4;
    sampleSource();
    render();
  };
  $('visionMarkerTilt').oninput = () => {
    markerTilt = Number($('visionMarkerTilt').value);
    sampleSource();
    showImage($('visionInput'), source);
    pendingVisionOutput('角度を変えた画像は、もう一度読み取りを実行してください。');
    $('visionOutputNote').textContent = 'まだ読み取っていません';
    $('visionEvidence').hidden = true;
    setStatus('見る角度を変えました。IDをもう一度読み取ってください。');
  };
  $('visionMarkerCover').onchange = () => {
    markerCover = $('visionMarkerCover').checked;
    sampleSource();
    render();
  };
  $('visionMarkerThreshold').oninput = () => {
    threshold = Number($('visionMarkerThreshold').value);
    $('visionMarkerThresholdValue').textContent = threshold;
  };
  $('visionMarkerRead').onclick = () => {
    markerResult = detectMarkers(source, threshold);
    const binary = imageOperation(source, 'binary', threshold);
    showImage($('visionOutput'), binary);
    const c = $('visionOutput').getContext('2d'),
      r = markerResult[0];
    if (r) {
      c.strokeStyle = r.id === null ? '#d77e40' : '#35ab83';
      c.lineWidth = Math.max(2, source.width / 150);
      c.beginPath();
      r.quad.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.closePath();
      c.stroke();
    }
    $('visionOutputNote').textContent =
      r?.id !== null && r?.id !== undefined
        ? 'ID ' + r.id + ' · 模様の不一致 ' + r.errors + '個'
        : 'IDを確定できません';
    setStatus(
      r?.id !== null && r?.id !== undefined
        ? '白黒の並びを、回転させながら登録済みの模様と比較してIDを決めました。'
        : '四角や模様を十分に読めませんでした。隠れ・傾き・しきい値を一つずつ変えてください。',
    );
    $('visionEvidence').hidden = false;
    $('visionEvidence').innerHTML =
      '<h2>内側の16マスを読む</h2>' +
      (r
        ? '<div class="vision-bits">' +
          r.bits.map((b) => `<span class="${b ? 'white' : 'black'}">${b}</span>`).join('') +
          '</div><p>白を1、黒を0として読みます。数字の大きさを測るのではなく、模様の組み合わせを区別します。</p>'
        : '<p>まず黒い四角い枠を見つける必要があります。</p>');
  };
  $('visionMarkerPrint').onclick = () => {
    let cells =
      '<rect width="8" height="8" fill="white"/><rect x="1" y="1" width="6" height="6" fill="black"/>';
    markerBits(markerId).forEach((bit, i) => {
      if (bit)
        cells += `<rect x="${2 + (i % 4)}" y="${2 + Math.floor(i / 4)}" width="1" height="1" fill="white"/>`;
    });
    download(
      'ArUco-4x4-ID' + markerId + '.svg',
      `<svg xmlns="http://www.w3.org/2000/svg" width="80mm" height="80mm" viewBox="0 0 8 8">${cells}</svg>`,
      'image/svg+xml',
    );
  };
  $('visionReflect').innerHTML =
    '<h2>向きを変えても、同じ目印だと分かる？</h2><p>90°回して読み取り、次は模様の一部を隠してみましょう。読めなかった理由を考えて、撮り方やしきい値を変えます。</p><details data-help-dialog><summary>物体認識との違い</summary><p>マーカーは機械が読みやすいように作った目印です。荷箱そのものの見た目を学習しているわけではありません。IDを「充電場所」などに対応付ければ、ロボットに場所の名前を知らせられます。</p><p>その場所へ実際に移動するには、方向や距離も必要です。RGB画像からマーカーの位置・向きを求める方法では、マーカーの実寸とカメラの校正情報を使います。RGB-Dカメラなら、対応するデプスの値で奥行きを調べる方法もあります。この実験は、まず番号を読み取る部分を扱います。</p></details>';
  $('visionTakeaway').textContent =
    'ARマーカーでは、あらかじめ決めた白黒の模様を読みます。枠と模様が十分に見えていることが大切です。';
  setStatus('左の模様を読み取り、回転や隠れによって結果がどう変わるか確かめましょう。');
  pendingVisionOutput('「模様からIDを読み取る」で、白黒の判定と検出した枠を表示します。');
}
function renderFace() {
  $('visionOutputTitle').textContent = '顔の位置と囲み枠';
  $('visionControls').innerHTML =
    `<p class="eyebrow">学習済みモデルを使う</p><h2>写真に写った人の顔を、学習済みの検出器で探す</h2><p>この検出器は、顔の画像と顔でない画像の例から「顔らしい明るさの並び」を学習しています。前の章で付けた「荷箱・ボール」のラベルが、この検出器へ自動で引き継がれるわけではありません。</p><button id="visionFaceLoad" class="${faceDetectorReady() ? '' : 'primary'} full" ${faceBusy ? 'disabled' : ''}>${faceDetectorReady() ? '検出器を準備済み' : '顔検出器を読み込む'}</button><p class="helper">この操作で約240 KBの検出器を、教材と同じ場所から読み込みます。インターネット接続は不要で、画像処理は端末内で行います。</p><button id="visionFacePhoto" class="full small" ${faceBusy ? 'disabled' : ''}>実写の教材画像を読み込む</button><p class="helper">写真はNASAが公開しているパブリックドメインの画像です。自分の画像を使う場合は、上の「画像を開く」を選びます。</p><button id="visionFaceRun" class="primary full" ${!faceDetectorReady() || faceBusy ? 'disabled' : ''}>この画像から顔を検出する</button><label class="basics-slider" for="visionScore">表示するスコアの下限 <output id="visionScoreValue">${faceThreshold}</output><input id="visionScore" type="range" min="${FACE_SCORE.min}" max="${FACE_SCORE.max}" step="${FACE_SCORE.step}" value="${faceThreshold}"></label>`;
  $('visionFaceLoad').onclick = async () => {
    if (faceBusy) return;
    faceBusy = true;
    renderFace();
    setStatus('検出器を準備しています…');
    try {
      await loadFaceDetector((text) => {
        status = text;
        if (chapter === 'face') setStatus(text);
      });
      status = '検出器を準備しました。写真を用意し、顔を検出してください。';
    } catch (e) {
      status = '読み込めませんでした。' + e.message;
    } finally {
      faceBusy = false;
      if (chapter === 'face') {
        renderFace();
        setStatus(status);
      }
    }
  };
  $('visionFacePhoto').onclick = async () => {
    try {
      setStatus('サンプル写真を読み込み中…');
      await readImage(FACE_SAMPLE_URL, FACE_SAMPLE_NAME, false);
    } catch (e) {
      setStatus(e.message + ' 自分で保存した写真を「画像を開く」から選ぶこともできます。');
    }
  };
  $('visionFaceRun').onclick = () => {
    if (faceBusy) return;
    try {
      output = detectFaces(cloneImage(source));
      status = '検出が終わりました。スコアの下限を変え、見逃しと誤検出を比べましょう。';
    } catch (e) {
      output = null;
      status = '検出できませんでした：' + e.message;
    }
    renderFace();
    setStatus(status);
  };
  $('visionScore').oninput = () => {
    faceThreshold = Number($('visionScore').value);
    $('visionScoreValue').textContent = faceThreshold;
    drawBoxes();
  };
  $('visionReflect').innerHTML =
    '<h2>枠が出たもの・出なかったものを、人も確認する</h2><p>スコアは、検出器が各候補に付ける「顔らしさ」の値で、重なった候補の点数を合計しています。下限10なら10未満の枠を表示しません。下限を上げると間違った枠を減らせる一方、本当にある顔の枠も消えることがあります。同じ写真で下限だけを変え、見逃しと誤検出を両方数えてください。</p><details data-help-dialog><summary>自分のロボット専用の物を見つけたいときは？</summary><p>その物の写真を集め、「何が写っているか」と「どこにあるか」の囲み枠を正解として付け、別途検出モデルを学習します。背景、距離、照明の違う画像を含め、別の撮影場面で評価します。この教材内では検出器の追加学習は行いません。</p><p>表示するスコアは検出器の出力値です。「この確率で正しい」という保証ではありません。横顔、傾いた顔、小さい顔、逆光やマスクの顔は見逃しやすくなります。</p></details>';
  $('visionTakeaway').textContent =
    '画像の分類は「何か」を、物体検出は「何が、どこにあるか」を答えます。学習済みの検出器にも、学習した対象や撮影条件による得意・不得意があります。';
  drawBoxes();
  if (!output) {
    pendingVisionOutput('写真と検出器を用意し、「この画像から顔を検出する」を押してください。');
    setStatus(status || '顔検出はまだ実行していません。検出器と写真を用意してから検出します。');
  }
}
function drawBoxes() {
  if (!output) {
    $('visionOutputNote').textContent = '検出結果はまだありません';
    pendingVisionOutput('写真と検出器を用意して、検出を実行してください。');
    return;
  }
  showImage($('visionOutput'), source);
  const boxes = selectFaces(output, faceThreshold);
  const c = $('visionOutput').getContext('2d'),
    scale = Math.max(0.25, source.width / 420),
    shown = boxes.slice(0, 30),
    tags = detectionTags(shown, source.width, source.height);
  c.lineWidth = 2 * scale;
  boxes.forEach((b) => {
    c.strokeStyle = '#f0c86a';
    c.strokeRect(b.x, b.y, b.right - b.x, b.bottom - b.y);
  });
  tags.forEach((tag, i) => {
    if (!tag) return;
    const b = shown[i];
    c.strokeStyle = '#f0c86a';
    c.lineWidth = scale;
    c.beginPath();
    c.moveTo(tag.x + tag.w / 2, tag.y + tag.h / 2);
    c.lineTo(b.x, b.y);
    c.stroke();
  });
  tags.forEach((tag) => {
    if (!tag) return;
    c.fillStyle = '#173b37';
    c.fillRect(tag.x, tag.y, tag.w, tag.h);
    c.fillStyle = 'white';
    c.font = 14 * tag.scale + 'px system-ui';
    c.textAlign = 'center';
    c.fillText(String(tag.number), tag.x + tag.w / 2, tag.y + 16 * tag.scale);
  });
  c.textAlign = 'left';
  $('visionOutputNote').textContent =
    boxes.length +
    '個の候補 · 下限 ' +
    faceThreshold +
    (boxes.length > 30 ? '（番号はスコア上位30件）' : '') +
    (tags.some((t) => !t) ? ' · 画像に入りきらない番号は一覧で確認してください' : '');
  $('visionEvidence').hidden = false;
  $('visionEvidence').innerHTML =
    '<h2>検出した候補</h2><p>画像の番号と一覧の番号を見比べてください。検出器が各候補に付けたスコアを表示します。スコアは正解を保証する値ではありません。</p><p>' +
    (getDepthFrame() && source.data === getDepthFrame().rgb
      ? '各枠の中央寄りの範囲から、測れた奥行きを小さい順に並べ、真ん中付近の値を表示します。これが中央値です。横幅・縦幅をそれぞれ半分に絞った範囲を使い、その範囲の有効な画素が半分未満なら不明とします。Zはカメラの正面方向の奥行きで、対象までの斜めの直線距離ではありません。枠には背景や別の物が混ざる場合もあります。'
      : 'このRGB画像には対応する奥行きがありません。距離も調べるときは「RGB-Dログを開く」で同時に記録した組を使います。') +
    '</p>' +
    (boxes.length
      ? '<div class="vision-detections">' +
        shown
          .map((b, i) => {
            const frame = getDepthFrame(),
              m = frame && source.data === frame.rgb ? depthInBox(frame, b) : null;
            return `<span><b>${i + 1}</b> 顔の候補 <b>${b.score.toFixed(1)}</b>${m ? (m.depth === null ? '奥行きは不明' : '奥行き Z ' + m.depth.toFixed(2) + ' m') : ''}</span>`;
          })
          .join('') +
        '</div>'
      : '<p>この下限では候補がありません。「顔がない」とは限りません。顔が正面に近い向きか、十分に大きく写っているかを確かめましょう。</p>');
}
function readImage(url, name, revoke) {
  const requestChapter = chapter,
    requestVersion = sourceVersion;
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!revoke) img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => {
      img.src = '';
      if (revoke) URL.revokeObjectURL(url);
      reject(Error('画像を読み込めませんでした。'));
    }, 30000);
    img.onload = () => {
      clearTimeout(timer);
      try {
        if (requestChapter !== chapter || requestVersion !== sourceVersion) {
          resolve();
          return;
        }
        clearDepthFrame();
        if (img.width * img.height > 24000000)
          throw Error('画像が大きすぎます。2400万画素以下で保存してください。');
        const scale = Math.min(1, 960 / Math.max(img.width, img.height)),
          c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        const ctx = c.getContext('2d');
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        source = ctx.getImageData(0, 0, c.width, c.height);
        sourceName = name;
        external = true;
        invalidate();
        render();
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        if (revoke) URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      clearTimeout(timer);
      if (revoke) URL.revokeObjectURL(url);
      reject(Error('画像を開けませんでした。PNG・JPEG・WebPを選んでください。'));
    };
    img.src = url;
  });
}
// Takes the newest frame relayed from the robot (live link); it then follows the same path as an opened file.
function useRobotCamera() {
  const frame = latestRobot('camera');
  if (!frame) {
    setStatus(
      robotState().phase === 'open'
        ? 'ロボットからカメラの画像がまだ届いていません。ロボット側のカメラの設定（camera_topic）を確かめてください。'
        : '先に画面右上の「実機」からロボットに接続してください。',
    );
    return;
  }
  stopCamera();
  readImage(URL.createObjectURL(frame), '実機カメラの画像', true).catch((e) =>
    setStatus(e.message),
  );
}
function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('この環境ではカメラを開けません。撮影済みの画像を「画像を開く」から選んでください。');
    return;
  }
  const version = sourceVersion,
    request = ++cameraRequest;
  navigator.mediaDevices
    .getUserMedia({ video: { width: 640, height: 480 }, audio: false })
    .then((s) => {
      if (request !== cameraRequest || $('visionPage').hidden || version !== sourceVersion) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stopCamera();
      stream = s;
      $('visionCapture').hidden = false;
      $('visionVideo').srcObject = s;
    })
    .catch(() =>
      setStatus(
        'カメラを開けませんでした。接続や使用許可を確認するか、画像ファイルを使ってください。',
      ),
    );
}
function stopCamera() {
  cameraRequest++;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (started && $('visionCapture')) {
    $('visionCapture').hidden = true;
    const video = $('visionVideo');
    if (video) video.srcObject = null;
  }
}
function capture() {
  clearDepthFrame();
  const video = $('visionVideo');
  if (!video.videoWidth) {
    setStatus('カメラの映像を待っています。');
    return;
  }
  const canvas = document.createElement('canvas'),
    scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  source = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  sourceName = '接続したカメラの静止画';
  external = true;
  stopCamera();
  invalidate();
  render();
}

export { initVision, activateVision, reviewVision };
