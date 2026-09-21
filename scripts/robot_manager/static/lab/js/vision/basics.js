import { DEPTH_CONTENT, depthSource, renderDepth } from './depth-ui.js';
import {
  cameraEffects,
  brightnessHistogram,
  colorMask,
  morphology,
  maskImage,
  connectedRegions,
  regionScene,
  evaluateRegions,
  projectedTarget,
  cameraGeometry,
  linePath,
  lineCamera,
  lineObservation,
  runLineTrial,
} from './basics-core.js';
import { makeVisionImage } from './images.js';
import { drawRobot } from '../core/renderer.js';

const $ = (id) => document.getElementById(id);
const VISION_CHAPTERS = [
  ['capture', '撮り方を変える', 0],
  ['pixels', '画素を調べる', 0],
  ['regions', 'まとまりを見つける', 0],
  ['geometry', 'RGBだけで距離は分かる？', 1],
  ['stereo', '左右の像から測る', 1],
  ['depth', 'RGBと奥行きを使う', 1],
  ['follow', 'ラインをたどる', 1],
  ['learn', '画像と正解で学ぶ', 2],
  ['marker', 'ARマーカーを読む', 2],
  ['face', '顔を見つける', 2],
];
const VISION_GROUPS = ['RGB画像を調べる', '奥行きと動きを調べる', '対象を見分ける'];
const FOUNDATION_CONTENT = {
  ...DEPTH_CONTENT,
  capture: [
    '赤い荷箱を見つけるために、写り方を整える',
    '同じ対象でも、暗さ・ぶれ・解像度で残る情報が変わります。まず、赤い荷箱の色と輪郭が見える撮り方を探しましょう。',
  ],
  regions: [
    '床の目印を、背景と区別して見つける',
    '色で選んだ点には、ノイズや背景も混ざります。不要な点を減らし、つながった領域の大きさと中心を調べます。',
  ],
  geometry: [
    '目印までの距離を、RGB画像から求める',
    '画面のどちら側にあるかは画素から調べられます。一方、大きく写る理由は「近いから」だけではありません。',
  ],
  follow: [
    '床のラインを見ながら、ゴールまで走る',
    '床のラインを見つけ、画面の中央からのずれに応じて曲がります。画像処理の結果が走り方にどうつながるか試しましょう。',
  ],
};
const capture = { exposure: 2.8, blur: 0, width: 320 },
  region = {
    scene: 'clean',
    method: 'rgb',
    operation: 'none',
    radius: 1,
    minArea: 1,
    roi: false,
    history: [],
  },
  geometry = { distance: 1, width: 0.2, lateral: 0, knownWidth: 0.2, focal: 250 },
  follow = {
    speed: 0.35,
    gain: 0.3,
    threshold: 90,
    scene: 'normal',
    trial: null,
    index: 0,
    history: [],
  };
let playback = null;
function pauseVisionBasics() {
  if (playback !== null) {
    clearInterval(playback);
    playback = null;
  }
  const b = $('vfPlay');
  if (b) b.textContent = '記録を再生';
}
function foundationSource(chapter) {
  if (['stereo', 'depth'].includes(chapter)) return depthSource(chapter);
  if (chapter === 'regions') return regionScene(region.scene).image;
  if (chapter === 'geometry') return projectedTarget(geometry).image;
  if (chapter === 'follow') return lineCamera({ x: 0, y: 0, theta: 0 });
  return makeVisionImage();
}
function slider(id, label, value, min, max, step = 1, suffix = '') {
  return `<label class="basics-slider" for="${id}">${label}<output id="${id}Value">${value}${suffix}</output><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"></label>`;
}
function select(id, label, values, value) {
  return `<label class="vision-select">${label}<select id="${id}">${values.map(([v, t]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;
}
function reflect(title, text, hint) {
  $('visionReflect').innerHTML =
    `<h2>${title}</h2><p>${text}</p><details><summary>考えるためのヒント</summary><p>${hint}</p></details>`;
}
function evidence(html) {
  $('visionEvidence').hidden = false;
  $('visionEvidence').innerHTML = html;
}
function histogram(image) {
  const b = brightnessHistogram(image),
    max = Math.max(...b);
  return `<svg class="vision-histogram" viewBox="0 0 400 104" role="img" aria-label="横軸は画素の明るさ、棒の高さは画素数"><line x1="20" x2="380" y1="76" y2="76" stroke="#b7c9cc"/>${b.map((v, i) => `<rect x="${20 + i * 11.25}" y="${76 - (60 * v) / max}" width="9" height="${(60 * v) / max}" fill="#548980"/>`).join('')}<text x="20" y="98">暗い 0</text><text x="380" y="98" text-anchor="end">255 明るい</text></svg>`;
}
function renderFoundation(chapter, api) {
  pauseVisionBasics();
  if (['stereo', 'depth'].includes(chapter)) {
    renderDepth(chapter, api);
    return;
  }
  if (chapter === 'capture') renderCapture(api);
  else if (chapter === 'regions') renderRegions(api);
  else if (chapter === 'geometry') renderGeometry(api);
  else renderFollow(api);
}
function renderCapture({ source, showImage, setStatus }) {
  $('visionOutputTitle').textContent = '撮影条件を変えた画像';
  $('visionControls').innerHTML =
    `<p class="eyebrow">撮り方を調整する</p><h2>荷箱の色と輪郭が見える写り方にする</h2><p>右は、条件を変えて撮り直した場合の簡略画像です。まず基準に戻し、明るさを上げて箱の色が白く消える様子を比べます。pxは画素の単位で、ぶれが大きいほど像が横に広がります。横の画素数を減らすと、細い模様を表す点も減ります。</p>${slider('vcExposure', '明るさの倍率', capture.exposure, 0.15, 3, 0.05, '倍')}${slider('vcBlur', '横方向のぶれ', capture.blur, 0, 18, 1, ' px')}${select(
      'vcWidth',
      '横の画素数',
      [
        [320, '320画素'],
        [160, '160画素'],
        [80, '80画素'],
        [40, '40画素'],
      ],
      capture.width,
    )}<button class="primary full" id="vcReset">基準の写り方に戻す</button><p class="helper">1倍・ぶれなしが基準です。実際のカメラでは、露光時間や照明、走行速度、ピントも調整します。</p>`;
  const update = () => {
    const out = cameraEffects(source, capture);
    showImage($('visionOutput'), out);
    $('visionOutputNote').textContent =
      `${out.width} × ${out.height}画素 · 明るさ${capture.exposure.toFixed(2)}倍`;
    let clipped = 0;
    for (let i = 0; i < out.data.length; i += 4)
      if (out.data[i] >= 250 && out.data[i + 1] >= 250 && out.data[i + 2] >= 250) clipped++;
    const ratio = Math.round((clipped / (out.width * out.height)) * 100);
    evidence(
      `<h2>画像に残った明るさ</h2><p>横軸は明るさで、左端の0が黒、右端の255が白です。棒が高いほど、その明るさに近い画素が多くあります。右端に集中すると、明るい部分の色や細かい差が白くつぶれているかもしれません。棒の高さは画像ごとに調整されるので、条件を変えた前後では分布の形を比べます。</p>${histogram(out)}<p>ほぼ白い画素：${ratio}%　画素数：${(out.width * out.height).toLocaleString()}</p>`,
    );
    setStatus(
      ratio > 40
        ? '明るい部分が白くつぶれています。撮影後に暗くしても、失った色の違いは元に戻りません。'
        : capture.blur > 8
          ? 'ぶれで箱の境目が広がりました。「横方向のぶれ」を小さくして、箱の輪郭や細い模様がどこまで見えるようになるか比べましょう。'
          : capture.width <= 80
            ? '小さな画像は計算を軽くできますが、細い模様が消えることがあります。マーカーや遠くの物も読める画素数が必要です。'
            : '明るさ、ぶれ、画素数を一つずつ変えて、何の情報が失われるか見比べましょう。',
    );
  };
  for (const [id, key, suffix] of [
    ['vcExposure', 'exposure', '倍'],
    ['vcBlur', 'blur', ' px'],
  ])
    $(id).oninput = () => {
      capture[key] = Number($(id).value);
      $(id + 'Value').textContent = capture[key] + suffix;
      update();
    };
  $('vcWidth').onchange = () => {
    capture.width = Number($('vcWidth').value);
    update();
  };
  $('vcReset').onclick = () => {
    Object.assign(capture, { exposure: 1, blur: 0, width: 320 });
    renderCapture({ source, showImage, setStatus });
  };
  update();
  reflect(
    'うまく認識できないとき、計算だけを直せばよい？',
    '白飛びや強いぶれで失われた情報は、後から計算しても完全には戻せません。実機では、まず元の画像を見ます。',
    '明るさの倍率は露出の簡略モデル、ぶれは横方向の平均です。実機では照明、シャッター、ピント、取り付け位置を分けて確かめます。',
  );
  $('visionTakeaway').textContent = 'よい入力画像を用意することも、画像処理の一部です。';
}
function pendingVisionOutput(message) {
  $('visionOutput').hidden = true;
  $('visionPending').hidden = false;
  $('visionPending').innerHTML =
    '<strong>処理結果はここに表示します</strong><span>' + message + '</span>';
}
function renderRegions({ source, external, showImage, setStatus, replaceSample }) {
  $('visionOutputTitle').textContent = '色の抽出と、領域の中心';
  $('visionControls').innerHTML =
    `<p class="eyebrow">処理する条件</p><h2>床の停止目印だけを残すには？</h2><p>最初は赤い部分をすべて選ぶため、床のマットだけでなく壁の掲示も候補になります。まず実行し、橙の枠がどこに付くかを見ます。その後、大きさや画像内の場所で条件を絞り、床のマット2枚だけに枠を付けられるか比べてください。</p><button id="vrRun" class="primary full">この条件で目印を探す</button>${select(
      'vrScene',
      '場面',
      [
        ['clean', '部屋をそのまま見る'],
        ['noise', '細かい点や欠けが混ざった画像'],
        ['dark', '同じ画像を暗くする'],
      ],
      region.scene,
    )}${select(
      'vrMethod',
      '色を選ぶ方法',
      [
        ['rgb', '赤さの差で選ぶ（RGB）'],
        ['hsv', '色合いで選ぶ（HSV）'],
      ],
      region.method,
    )}<div class="vision-region-controls"><h3>大きさと場所で候補を絞る</h3>${slider('vrArea', '残すまとまりの面積', region.minArea, 1, 3000, 1, '画素以上')}<p>面積は、そのまとまりに含まれる画素の数です。この値より小さいまとまりを囲み枠の候補から外します。白い画素自体は残るので、橙の枠と候補数の変化を見ます。1なら小さな点にも枠が付きます。</p><label class="basics-check"><input id="vrRoi" type="checkbox" ${region.roi ? 'checked' : ''}>画像の下60%だけを調べる</label><p>チェックすると、点線より下だけを調べます。停止目印が床にあると分かっているため、上側の壁の掲示を候補から外せます。ただし必要な目印が上側に写った場合は、それも見逃します。</p></div><details class="vision-adjust"><summary>細かい点や欠けが混ざるとき</summary><p>点状のノイズは、実際の物体とは違う小さな色の乱れです。白黒に分けた画像で、周囲の画素とのつながりを使って整えます。</p>${select(
      'vrOperation',
      '選んだ白い部分を整える',
      [
        ['none', '処理しない'],
        ['open', '小さな白い点を除く'],
        ['close', '白い部分の小さな穴を埋める'],
        ['both', '点を除いて、穴を埋める'],
      ],
      region.operation,
    )}${slider('vrRadius', '周囲を見る範囲', region.radius, 1, 4, 1, ' px')}</details><details data-help-dialog><summary>RGB・HSV・領域とは？</summary><p>RGBは赤・緑・青の強さです。HSVは、赤や青という色合い、色の鮮やかさ、明るさに分けた表し方です。同じ赤いマットを暗くするとRGBの値は小さくなりますが、色合いは比較的保たれます。そのためHSVが役立つ場合があります。ただし暗すぎる場合や、照明自体の色が変わった場合は、同じようには選べません。</p><p>上下左右につながった白い画素を1つの領域として数えます。面積は画素数、中心は画素の位置の平均です。調べる範囲を絞ることをROIと呼びます。</p><p>オープニングは白い領域を縮めてから広げます。クロージングは広げてから縮めます。範囲が大きすぎると、別の物がつながったり細い物が消えたりします。</p></details>`;
  $('vrScene').disabled = external;
  $('vrScene').onchange = () => {
    region.scene = $('vrScene').value;
    replaceSample();
  };
  const drawRange = () => {
    showImage($('visionInput'), source);
    if (region.roi) {
      const c = $('visionInput').getContext('2d');
      c.fillStyle = 'rgba(16,35,42,.40)';
      c.fillRect(0, 0, source.width, source.height * 0.4);
      c.strokeStyle = '#fff';
      c.lineWidth = 1.5;
      c.setLineDash([5, 4]);
      c.beginPath();
      c.moveTo(0, source.height * 0.4);
      c.lineTo(source.width, source.height * 0.4);
      c.stroke();
      c.setLineDash([]);
    }
  };
  drawRange();
  const dirty = () => {
    drawRange();
    $('visionOutputNote').textContent = '前の条件の結果 · 再実行で更新';
    setStatus('条件を変更しました。「この条件で目印を探す」で結果を更新します。');
  };
  for (const [id, key] of [
    ['vrMethod', 'method'],
    ['vrOperation', 'operation'],
  ])
    $(id).onchange = () => {
      region[key] = $(id).value;
      dirty();
    };
  for (const [id, key, suffix] of [
    ['vrRadius', 'radius', ' px'],
    ['vrArea', 'minArea', '画素'],
  ])
    $(id).oninput = () => {
      region[key] = Number($(id).value);
      $(id + 'Value').textContent = region[key] + suffix;
      dirty();
    };
  $('vrRoi').onchange = () => {
    region.roi = $('vrRoi').checked;
    dirty();
  };
  $('vrRun').onclick = () => {
    const w = source.width,
      h = source.height,
      raw = colorMask(source, { method: region.method, roi: region.roi ? 0.4 : 0 }),
      mask = morphology(raw, w, h, region.operation, region.radius),
      regions = connectedRegions(mask, w, h, region.minArea);
    showImage($('visionOutput'), maskImage(mask, w, h));
    const c = $('visionOutput').getContext('2d');
    c.lineWidth = Math.max(1, w / 160);
    c.strokeStyle = '#faaf50';
    for (const r of regions.slice(0, 80)) {
      c.strokeRect(r.x, r.y, r.w, r.h);
      c.beginPath();
      c.moveTo(r.cx - 5, r.cy);
      c.lineTo(r.cx + 5, r.cy);
      c.moveTo(r.cx, r.cy - 5);
      c.lineTo(r.cx, r.cy + 5);
      c.stroke();
    }
    $('visionOutputNote').textContent = `${regions.length}個の領域 · 十字は中心`;
    const score = external ? null : evaluateRegions(regions, regionScene(region.scene).targets),
      success = score && score.found === 2 && score.falsePositive === 0;
    if (score)
      region.history.push({
        scene: region.scene,
        score,
        method: region.method,
        operation: region.operation,
        area: region.minArea,
        roi: region.roi,
      });
    evidence(
      `<h2>${score ? (success ? '目印を2つ、区別できました' : '見つかったものを確認する') : '領域の位置と面積'}</h2>${score ? `<div class="vision-metrics"><span>目印 <b>${score.found}/2</b></span><span>見逃し <b>${score.missed}</b></span><span>余計な検出 <b>${score.falsePositive}</b></span></div><p>目印と重なる囲み枠を数えて評価しています。白い画素の数が多いだけでは成功になりません。</p>` : '<p>自分の画像では正解が不明なので、自動採点しません。囲み枠を人が確認します。</p>'}<div class="vision-region-list">${
        regions
          .slice(0, 6)
          .map(
            (r, i) =>
              `<span>${i + 1}：中心 (${Math.round(r.cx)}, ${Math.round(r.cy)}) · ${r.area}画素</span>`,
          )
          .join('') || '領域が見つかりませんでした'
      }</div>${
        region.history.length
          ? '<details><summary>これまでの結果</summary>' +
            region.history
              .slice(-4)
              .map(
                (t, i) =>
                  `<p>${region.history.length - Math.min(4, region.history.length) + i + 1}回目：${{ clean: '部屋', noise: '細かな点と欠け', dark: '暗い場面' }[t.scene]}／${t.method.toUpperCase()}／${{ none: '整えなし', open: '点を除去', close: '穴を補う', both: '点と穴' }[t.operation]}／面積${t.area}以上／${t.roi ? '下側だけ' : '全体'} → 目印${t.score.found}/2・余計${t.score.falsePositive}</p>`,
              )
              .join('') +
            '</details>'
          : ''
      }`,
    );
    setStatus(
      !score
        ? '枠で囲まれた物が探したい物か、元の画像と見比べます。'
        : success
          ? '床のマット2枚だけを見つけました。次は場面を「細かい点や欠けが混ざった画像」や「同じ画像を暗くする」に変え、同じ条件が使えるか確かめましょう。'
          : score.missed
            ? 'マットを見逃しています。暗くて赤と判断できないのか、面積の条件で除かれたのか、元の画像と白黒の結果を比べましょう。'
            : score.falsePositive === 1
              ? '床のマットに加えて、壁の赤い掲示も囲まれました。赤さは同じでも、画像に写る場所や大きさは違います。どの条件なら区別できるでしょうか。'
              : 'マット以外に細かい点や壁の掲示も囲まれています。まず一種類に注目し、大きさ・場所・点を除く処理のどれが役立つか試します。',
    );
  };
  $('visionOutputNote').textContent = 'まだ実行していません';
  pendingVisionOutput('「この条件で目印を探す」を押すと、選んだ画素と囲み枠を表示します。');
  setStatus('まず、そのままの条件で目印を探してください。結果を見てから改善します。');
  reflect(
    '何を変えると、目的の目印だけを残せる？',
    '細かい点、背景、暗さでは、効く対策が違います。結果の「見逃し」と「余計な検出」の両方を見ましょう。',
    '点にはオープニングや面積の下限、上側の背景にはROIを試します。暗くするとRGBの赤さの差も小さくなります。HSVに変えて比較し、処理範囲を広げすぎた場合も確かめます。',
  );
  $('visionTakeaway').textContent =
    '色の抽出 → ノイズを減らす → まとまりを数える → 面積・中心を測る、という流れで位置を取り出せます。';
}
function renderGeometry({ showImage, setStatus }) {
  $('visionOutputTitle').textContent = '画像から測った位置';
  $('visionControls').innerHTML =
    `<p class="eyebrow">カメラと距離の実験</p><h2>目印の大きさを知らずに、距離を決められる？</h2><p>目印はカメラと正面で向き合う正方形です。上側の3つの操作は、目印の実際の配置や大きさを変えます。下側の「計算に使う幅」は、コンピューターへ教える幅です。この二つが違うと、写った幅を正しく測れても奥行きの答えがずれます。</p>${slider('vgDistance', '実際の奥行き', geometry.distance, 0.6, 4, 0.1, ' m')}${slider('vgWidth', '実際の目印の幅', geometry.width, 0.1, 0.6, 0.05, ' m')}${slider('vgLateral', '中心から右への位置', geometry.lateral, -0.4, 0.4, 0.05, ' m')}<button id="vgSame" class="full">幅も距離も2倍の場面と比べる</button><hr><h3>距離を計算するための情報</h3>${slider('vgKnown', '計算に使う目印の幅', geometry.knownWidth, 0.1, 0.6, 0.05, ' m')}${slider('vgFocal', '校正で調べる焦点距離', geometry.focal, 160, 340, 10, ' px')}<details data-help-dialog><summary>「校正」では何を調べる？</summary><p>校正は、写り方を計算するためのカメラの値を調べる作業です。寸法が分かった格子模様などを撮り、焦点距離、画像の中心、レンズのゆがみを求めます。ここでの焦点距離は、物が何画素の大きさに写るかを決める尺度で、pxは画素の単位です。画像を作る値は250 pxに固定されています。このスライダーは計算に使う値だけを変えるので、値を間違えると画像は同じでも距離の答えがずれます。</p><p>床上の点を測るなら、カメラの高さや傾きも必要です。物体が機体から何m先にあるかを知るには、カメラの取り付け位置と向きも必要です。例えばカメラが機体の中心より前に付いていれば、カメラから1 m先の物は、機体の中心からは1 mより遠くにあります。</p></details>`;
  const update = () => {
    $('visionMotion').hidden = false;
    $('visionMotion').innerHTML =
      `<div class="vision-world-diagram"><svg viewBox="0 0 640 160" role="img" aria-label="横から見たカメラと赤い目印の位置関係"><text x="20" y="22" fill="#45626d" font-size="15">実際の配置（横から見た模式図）</text><rect x="38" y="53" width="50" height="34" rx="6" fill="#397c72"/><path d="M88 60l18-8v36l-18-8z" fill="#397c72"/><text x="27" y="113" fill="#45626d" font-size="15">カメラ</text><line x1="112" x2="${145 + geometry.distance * 95}" y1="73" y2="73" stroke="#648c84" stroke-dasharray="5 4"/><rect x="${145 + geometry.distance * 95}" y="${73 - geometry.width * 80}" width="10" height="${geometry.width * 160}" fill="#be4937"/><text x="${125 + geometry.distance * 95}" y="150" fill="#45626d" font-size="15">目印 ${Math.round(geometry.width * 100)} cm</text><text x="310" y="22" fill="#45626d" font-size="15">奥行き ${geometry.distance.toFixed(1)} m</text></svg></div>`;
    const projected = projectedTarget({ ...geometry, focal: 250 }),
      input = projected.image;
    showImage($('visionInput'), input);
    showImage($('visionOutput'), input);
    const r = connectedRegions(colorMask(input), 320, 220, 10)[0],
      c = $('visionOutput').getContext('2d');
    c.strokeStyle = '#648f91';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(159.5, 0);
    c.lineTo(159.5, 220);
    c.stroke();
    $('visionInputNote').textContent =
      `奥行き ${geometry.distance.toFixed(1)} m · 幅 ${Math.round(geometry.width * 100)} cm`;
    if (!r) {
      setStatus('目印が画面の外です。横の位置を中央に近づけてください。');
      return;
    }
    c.strokeStyle = '#185e50';
    c.lineWidth = 2;
    c.strokeRect(r.x, r.y, r.w, r.h);
    const m = cameraGeometry(r, { knownWidth: geometry.knownWidth, focal: geometry.focal });
    $('visionOutputNote').textContent =
      `幅 ${r.w} px · 中心 (${r.cx.toFixed(1)}, ${r.cy.toFixed(1)})`;
    const clipped = r.x === 0 || r.x + r.w === 320 || r.y === 0 || r.y + r.h === 220;
    evidence(
      `<h2>写った幅から、目印までの奥行きを計算する</h2><div class="vision-metrics"><span>左右の方向 <b>${m.angle < 0 ? '左' : '右'} ${Math.abs(m.angle).toFixed(1)}°</b></span><span>推定した奥行き <b>${clipped ? '範囲外' : m.depth.toFixed(2) + ' m'}</b></span></div><p>推定した奥行き ≈ 計算に使う焦点距離 × 計算に使う目印の幅 ÷ 画像上の幅<br>${geometry.focal} px × ${geometry.knownWidth.toFixed(2)} m ÷ ${r.w} px ≈ ${m.depth.toFixed(2)} m</p><p>画素の座標は左上が(0, 0)。右へ進むほど横の値、下へ進むほど縦の値が増えます。ここでの奥行きはカメラの正面方向の距離で、斜めの直線距離とは異なります。</p>`,
    );
    setStatus(
      clipped
        ? '目印が画面からはみ出しています。写った幅だけでは、この式で距離を求められません。'
        : Math.abs(m.depth - geometry.distance) > 0.15
          ? '画像の幅だけでは、正しい距離に決まりません。目印の実寸とカメラの情報が合っているか確かめましょう。'
          : '実寸とカメラの情報を使うと、画像から奥行きを見積もれます。次は「幅も距離も2倍」にして、写り方を比べてください。',
    );
  };
  for (const [id, key, suffix] of [
    ['vgDistance', 'distance', ' m'],
    ['vgWidth', 'width', ' m'],
    ['vgLateral', 'lateral', ' m'],
    ['vgKnown', 'knownWidth', ' m'],
    ['vgFocal', 'focal', ' px'],
  ])
    $(id).oninput = () => {
      geometry[key] = Number($(id).value);
      $(id + 'Value').textContent = geometry[key] + suffix;
      update();
    };
  $('vgSame').onclick = () => {
    const large = geometry.distance === 2 && geometry.width === 0.4;
    geometry.distance = large ? 1 : 2;
    geometry.width = large ? 0.2 : 0.4;
    geometry.lateral = 0;
    renderGeometry({ showImage, setStatus });
    setStatus(
      '幅20 cm・奥行き1 mと、幅40 cm・奥行き2 mは同じ大きさに写ります。画像だけでは、どちらかを決められません。',
    );
  };
  update();
  reflect(
    '目印を画像で見つけたら、あと何m進めばよい？',
    '物の大きさが不明なら、小さくて近い物と大きくて遠い物は区別できません。斜め向きの目印でも、この単純な式は使えません。',
    '既知のマーカーの実寸と校正情報、床面の条件、ステレオカメラやLiDARなど、別の手がかりを使います。画像上の「右」と、地図上の「東」も同じではありません。',
  );
  $('visionTakeaway').textContent =
    '画像の座標・カメラから見た位置・地図上の位置を区別し、計算に必要な情報を確かめます。';
}
function renderFollow({ showImage, setStatus }) {
  $('visionOutputTitle').textContent = '調べる範囲と、ラインの中心';
  $('visionControls').innerHTML =
    `<p class="eyebrow">ミッション · ラインに沿って到着</p><h2>ずれを見て、曲がり方を変える</h2><p>前方の床を写すカメラを使います。ラインが右に見えたら、左車輪を速くして右へ曲がります。</p><button id="vfRun" class="primary full">この設定で走らせる</button>${slider('vfGain', 'ずれに対して曲がる強さ', follow.gain, 0, 6, 0.1)}${slider('vfSpeed', '前進する速さ', follow.speed, 0.15, 0.65, 0.05, ' m/s')}${slider('vfThreshold', '黒いラインと判断する明るさ', follow.threshold, 40, 180, 5)}${select(
      'vfScene',
      'コースの条件',
      [
        ['normal', '白い床の連続したライン'],
        ['shadow', '途中に暗い床がある'],
        ['gap', '途中でラインが途切れる'],
      ],
      follow.scene,
    )}<p class="helper">曲がる強さを0にすると、ラインがずれて見えても方向を直しません。値を上げると同じずれに対して大きく曲がります。明るさのしきい値を上げると、より明るい床までライン候補に含まれます。これは人が決めたルールによる制御で、学習はしません。ラインを特定できなくなると停止します。</p><details data-help-dialog><summary>画像から車輪までの計算</summary><p>①画像下側の一帯で暗い画素を選ぶ ②横位置の平均を求める ③中央からのずれを計算 ④ずれに比例して左右の車輪に速度差を付ける、の順です。</p><p>車輪間隔32 cm、車輪直径13 cm。画角と取り付けは簡略モデルで、滑りや画像遅延は含みません。実機ではカメラとモーターの向き、制御周期、上限速度も確認します。</p></details>`;
  const dirty = () => {
    pauseVisionBasics();
    setStatus(
      '設定を変えました。前回の記録は残してあります。「この設定で走らせる」で新しい結果を比べます。',
    );
  };
  for (const [id, key, suffix] of [
    ['vfGain', 'gain', ''],
    ['vfSpeed', 'speed', ' m/s'],
    ['vfThreshold', 'threshold', ''],
  ])
    $(id).oninput = () => {
      follow[key] = Number($(id).value);
      $(id + 'Value').textContent = follow[key] + suffix;
      dirty();
    };
  $('vfScene').onchange = () => {
    follow.scene = $('vfScene').value;
    dirty();
  };
  $('vfRun').onclick = () => {
    pauseVisionBasics();
    follow.trial = runLineTrial({
      ...follow,
      gap: follow.scene === 'gap',
      shadow: follow.scene === 'shadow',
    });
    follow.index = follow.trial.frames.length - 1;
    follow.history.push({
      success: follow.trial.success,
      reason: follow.trial.reason,
      seconds: follow.trial.seconds,
      error: follow.trial.meanError,
      gain: follow.gain,
      speed: follow.speed,
      threshold: follow.threshold,
      scene: follow.scene,
    });
    showTrial();
    setStatus(
      follow.trial.reason +
        '。記録を再生すると、カメラの画像と車輪の動きを同じ時刻で確認できます。',
    );
  };
  const frame = () => {
    const t = follow.trial,
      f = t?.frames[follow.index] || {
        pose: { x: 0, y: 0, theta: 0 },
        command: { left: 0, right: 0 },
        time: 0,
      },
      options = t?.options || {},
      input = lineCamera(f.pose, options),
      obs = lineObservation(input, { threshold: options.threshold || follow.threshold });
    showImage($('visionInput'), input);
    showImage($('visionOutput'), maskImage(obs.mask, input.width, input.height));
    const c = $('visionOutput').getContext('2d');
    c.strokeStyle = '#dfa95a';
    c.lineWidth = 1;
    c.strokeRect(0, input.height * 0.62, input.width, input.height * 0.22);
    c.strokeStyle = '#48bb9b';
    c.beginPath();
    c.moveTo(59.5, 0);
    c.lineTo(59.5, 90);
    c.stroke();
    if (obs.valid) {
      c.fillStyle = '#edb357';
      c.beginPath();
      c.arc(obs.cx, 65, 3, 0, Math.PI * 2);
      c.fill();
    }
    $('visionInputNote').textContent = `${f.time.toFixed(1)}秒 · 前方の床の簡略映像`;
    $('visionOutputNote').textContent = obs.valid
      ? `中央から${obs.error < 0 ? '左' : '右'}へ ${Math.abs(obs.cx - 59.5).toFixed(1)} px`
      : 'ラインを特定できません';
    if ($('vfFrameValue')) $('vfFrameValue').textContent = f.time.toFixed(1) + '秒';
    if ($('vfFrame')) $('vfFrame').value = follow.index;
    const rpm = (v) => ((v / (Math.PI * 0.13)) * 60).toFixed(1);
    if ($('vfWheels'))
      $('vfWheels').textContent =
        `左車輪 ${rpm(f.command.left)} rpm　／　右車輪 ${rpm(f.command.right)} rpm`;
    const canvas = $('vfMap');
    if (canvas) {
      canvas.width = 1000;
      canvas.height = 460;
      const m = canvas.getContext('2d');
      m.scale(2, 2);
      m.fillStyle = '#172f3b';
      m.fillRect(0, 0, 500, 230);
      const point = (x, y) => ({ x: 35 + x * 94, y: 115 - y * 115 });
      m.strokeStyle = '#b3c6ce';
      m.lineWidth = 7;
      m.beginPath();
      for (let x = 0; x <= 4.8; x += 0.025) {
        if (options.gap && x > 1.9 && x < 2.4) {
          m.moveTo(point(x, linePath(x)).x, point(x, linePath(x)).y);
          continue;
        }
        const p = point(x, linePath(x));
        x === 0 ? m.moveTo(p.x, p.y) : m.lineTo(p.x, p.y);
      }
      m.stroke();
      if (t) {
        m.strokeStyle = '#79d3b9';
        m.lineWidth = 2;
        m.beginPath();
        t.frames.forEach((v, i) => {
          const p = point(v.pose.x, v.pose.y);
          i ? m.lineTo(p.x, p.y) : m.moveTo(p.x, p.y);
        });
        m.stroke();
      }
      const p = point(f.pose.x, f.pose.y);
      m.save();
      m.translate(p.x, p.y);
      m.scale(0.48, 0.48);
      drawRobot(m, { x: 0, y: 0 }, { theta: -f.pose.theta });
      m.restore();
      m.fillStyle = '#dce8eb';
      m.font = '13px system-ui';
      m.fillText('スタート', 18, 203);
      m.fillText('ゴール', 430, 203);
      m.fillStyle = '#e3bc6b';
      m.fillRect(458, point(4.5, linePath(4.5)).y - 14, 3, 28);
    }
  };
  const showTrial = () => {
    const t = follow.trial;
    $('visionMotion').hidden = false;
    $('visionMotion').innerHTML =
      `<div class="vision-motion-top"><strong>コースと走行記録</strong><span id="vfWheels"></span></div>${t ? `<div class="vision-motion-player"><button id="vfPlay" class="small">記録を再生</button><button id="vfFirst" class="small">最初へ</button><label for="vfFrame">時刻 <output id="vfFrameValue"></output></label><input aria-label="記録を見る時刻" id="vfFrame" type="range" min="0" max="${t.frames.length - 1}" value="${follow.index}"></div>` : ''}<canvas id="vfMap" class="vision-follow-map" role="img" aria-label="ラインと走行軌跡、現在のロボットの位置"></canvas>`;
    evidence(
      `<h2>${t ? t.reason : 'コースと走行記録'}</h2>${t ? `<div class="vision-metrics"><span>走行時間 <b>${t.seconds.toFixed(1)}秒</b></span><span>ラインからの平均のずれ <b>${(t.meanError * 100).toFixed(1)} cm</b></span></div><p>平均のずれは、各時刻の機体と、その地点のラインの左右の離れをcmで求め、走行中の値を平均したものです。画像上のpxのずれとは別の評価値です。上のrpmは1分間の車輪の回転数です。記録を再生して、画像のずれに応じて左右の回転数が変わるか見ます。短く走って止まった結果と、完走した結果は分けて比較します。</p>` : ''}${
        follow.history.length
          ? '<details><summary>前の走行と比べる</summary>' +
            follow.history
              .slice(-4)
              .map(
                (h, i) =>
                  `<p>${follow.history.length - Math.min(4, follow.history.length) + i + 1}回目：強さ${h.gain}／${h.speed} m/s／明るさ${h.threshold}／${{ normal: '連続', shadow: '暗い床', gap: '途切れ' }[h.scene]} → ${h.reason}・平均${(h.error * 100).toFixed(1)} cm</p>`,
              )
              .join('') +
            '</details>'
          : ''
      }`,
    );
    frame();
    if (t) {
      $('vfFrame').oninput = () => {
        pauseVisionBasics();
        follow.index = Number($('vfFrame').value);
        frame();
      };
      $('vfFirst').onclick = () => {
        pauseVisionBasics();
        follow.index = 0;
        frame();
      };
      $('vfPlay').onclick = () => {
        if (playback !== null) {
          pauseVisionBasics();
          return;
        }
        if (follow.index === t.frames.length - 1) follow.index = 0;
        $('vfPlay').textContent = '一時停止';
        playback = setInterval(() => {
          follow.index = Math.min(t.frames.length - 1, follow.index + 1);
          frame();
          if (follow.index === t.frames.length - 1) pauseVisionBasics();
        }, 100);
      };
    }
  };
  showTrial();
  setStatus('まず現在の設定で走らせ、曲がり方が足りないか、曲がりすぎるかを記録から考えます。');
  reflect(
    '見つける処理と、動かす処理のどちらが原因？',
    'ラインを見つけているのに外れる場合と、ラインそのものを見失う場合は、直す条件が違います。',
    '画像にラインが残っていれば、曲がる強さや速度を見直します。暗い床全体を黒と判定していたら、明るさのしきい値を下げます。ラインが本当に途切れている場合は停止し、別のセンサーなどを使う方針が必要です。',
  );
  $('visionTakeaway').textContent =
    '画像 → 必要な領域 → 位置のずれ → 車輪の回転、というつながりを確認しました。';
}

export {
  VISION_CHAPTERS,
  VISION_GROUPS,
  FOUNDATION_CONTENT,
  pauseVisionBasics,
  foundationSource,
  renderFoundation,
  pendingVisionOutput,
};
