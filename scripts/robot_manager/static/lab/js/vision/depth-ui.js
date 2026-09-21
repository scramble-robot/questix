import {
  DEPTH_CAMERA,
  stereoProjection,
  depthFromDisparity,
  rgbdScene,
  depthImage,
  depthPoint,
  selectDepthPixels,
} from '../core/depth-core.js';

const $ = (id) => document.getElementById(id);
const stereo = { z: 1.2, shift: 6, history: [] },
  settings = { condition: 'normal', useDepth: false, maxDepth: 1.8, ran: false },
  fmt = (x, n = 2) => x.toFixed(n);
let imported = null,
  selected = { u: 118, v: 126 };
const DEPTH_CONTENT = {
  stereo: [
    '荷箱までの距離を、左右の画像から測る',
    '1台のデプスカメラの中にある左右にある画像を撮る部分（撮像部）は、同じ物を少し違う位置から見ます。近い物ほど、画像上の位置の差が大きくなります。',
  ],
  depth: [
    '色と奥行きを合わせて、手前の荷箱を選ぶ',
    'RGBは色、デプスは画素ごとの奥行きです。同じ装置から得た二つの情報を対応させ、赤い物の中から手前の荷箱を選びます。',
  ],
};
function setDepthFrame(frame) {
  imported = frame;
  selected = { u: Math.floor(frame.width / 2), v: Math.floor(frame.height / 2) };
  settings.ran = false;
}
function clearDepthFrame() {
  imported = null;
  selected = { u: 118, v: 126 };
  settings.ran = false;
}
function getDepthFrame() {
  return imported;
}
function depthSource(chapter) {
  const f =
    chapter === 'stereo'
      ? rgbdScene({ targetZ: stereo.z, cameraX: -DEPTH_CAMERA.baseline / 2 })
      : imported || rgbdScene(settings);
  return { width: f.width, height: f.height, data: f.rgb };
}
function slider(id, label, value, min, max, step, unit) {
  return `<label class="basics-slider" for="${id}">${label}<output id="${id}Value">${value}${unit}</output><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"></label>`;
}
function renderDepth(chapter, api) {
  if (chapter === 'stereo') renderStereo(api);
  else renderRGBD(api);
}
function renderStereo({ showImage, setStatus }) {
  $('visionInputTitle').textContent = '装置内の左の撮像部';
  $('visionOutputTitle').textContent = '装置内の右の撮像部';
  $('visionControls').innerHTML =
    `<p class="eyebrow">左右で同じ点を探す</p><h2>点Aのずれから距離を求める</h2><p>テープの中央にある黒い印が点Aです。この実験では、距離の誤差10 cm以内を目指します。まず荷箱を近づけたり遠ざけたりし、左右で写る位置がどう変わるか見てください。</p>${slider('vsDistance', '実際の奥行き', stereo.z, 0.8, 3, 0.1, ' m')}<hr><p>次に、下の拡大図で青い点を動かし、緑の線へ重ねます。重なるまで動かした画素数が、左右の画像に写った同じ点の横位置の差、つまり「視差（しさ）」です。pxは画素の単位で、カメラそのものを動かす量ではありません。</p><div id="vsAlignment"></div>${slider('vsShift', '右の点を右へ動かす量', stereo.shift, 1, 30, 0.5, ' px')}<button class="primary full" id="vsMeasure">このずれから距離を計算する</button><div id="vsResult" class="depth-result" role="status"></div><details data-help-dialog><summary>両眼視（りょうがんし）と同じ仕組み？</summary><p>指を顔の前に立て、左右の目を交互に閉じると、指が背景に対して動いて見えます。指を近づけるほど、その差は大きくなります。カメラも左右の画像で同じ点を探し、この差を使います。</p><p>ここではステレオ方式のRGB-Dカメラ1台を想定します。左右の撮像部は同じ本体の中にあり、RGB撮影部も含まれます。実機の距離計測用画像は赤外線の白黒画像の場合もあります。光の往復時間を使うToF方式など、両眼視を使わないデプスカメラもあります。</p></details>`;
  const draw = () => {
    const k = DEPTH_CAMERA,
      p = stereoProjection(stereo.z, { lateral: -0.21 }),
      v = k.cy + (k.fy * 0.125) / stereo.z;
    for (const [id, eye, x] of [
      ['visionInput', -k.baseline / 2, p.left],
      ['visionOutput', k.baseline / 2, p.right],
    ]) {
      const f = rgbdScene({ targetZ: stereo.z, cameraX: eye });
      showImage($(id), { width: f.width, height: f.height, data: f.rgb });
      const c = $(id).getContext('2d');
      c.strokeStyle = '#fbec9a';
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, 220);
      c.stroke();
      c.beginPath();
      c.arc(x, v, 6, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = '#fff';
      c.font = '14px system-ui';
      c.fillText('A', x + 8, v - 8);
    }
    $('visionInputNote').textContent = `模擬画像 · 点Aの横位置 ${fmt(p.left, 1)} px`;
    $('visionOutputNote').textContent = `模擬画像 · 点Aの横位置 ${fmt(p.right, 1)} px`;
    $('visionMotion').hidden = false;
    const targetY = 35 + (3 - stereo.z) * 30;
    $('visionMotion').innerHTML =
      `<div class="depth-diagram"><svg viewBox="0 0 640 225" role="img" aria-label="1台の装置の左右の撮像部から、同じ荷箱へ視線を伸ばした上面図"><text x="22" y="28">配置の模式図（上から）</text><rect x="190" y="155" width="260" height="44" rx="12" fill="#52777e"/><circle cx="266" cy="168" r="9" fill="#9fd3e3"/><circle cx="374" cy="168" r="9" fill="#9fd3e3"/><rect x="310" y="174" width="20" height="12" rx="3" fill="#cfdecd"/><path d="M266 168L320 ${targetY + 17}L374 168" fill="none" stroke="#a6d7ce" stroke-width="2"/><rect x="302" y="${targetY}" width="36" height="27" rx="3" fill="#c66d4e"/><text x="349" y="${targetY + 20}">同じ荷箱の点A</text><text x="458" y="182">RGB撮影部も内蔵</text><text x="320" y="221" text-anchor="middle">RGB-Dカメラ 1台（左右の間隔は7.5 cm）</text><text x="208" y="150">左</text><text x="402" y="150">右</text></svg></div>`;

    $('vsAlignment').innerHTML =
      `<svg class="depth-alignment" viewBox="0 0 320 90" role="img" aria-label="緑の線が左の点A、青が移動させた右の点A。位置の差を6倍に拡大"><line x1="15" x2="305" y1="40" y2="40" stroke="#ccdada"/><line x1="160" x2="160" y1="10" y2="65" stroke="#3e8174" stroke-width="3"/><circle cx="${160 + (stereo.shift - p.disparity) * 6}" cy="40" r="8" fill="#4e7cb9"/><text x="160" y="85" text-anchor="middle" fill="#435e66">緑の線に青い点を重ねる（差を6倍）</text></svg>`;
    $('vsResult').textContent = '点を重ねたら、距離を計算してください。';
    $('visionEvidence').hidden = false;
    $('visionEvidence').innerHTML =
      `<h2>二つの方向が交わる所に、物がある</h2><p>片目では「この方向のどこか」にあるとしか分かりません。左右から見た方向を組み合わせると、交わる位置から奥行きが決まります。上の配置図で、左右の撮像部から点Aに伸びる線を見てください。</p><details data-help-dialog><summary>なぜ、ずれから距離が分かる？</summary><p>片方の画像だけでは、点がどの方向にあるかまでしか決まりません。左右それぞれから見える方向を伸ばし、交わる位置を探すと、点までの奥行きが決まります。左右の撮像部の間隔と、レンズの写り方を事前に調べておく必要があります。</p><p>奥行き Z ＝ 焦点距離 f × 左右の間隔 B ÷ 視差 d<br>この教材では f = 240 px、B = 0.075 mです。たとえば視差が15 pxなら、240 × 0.075 ÷ 15 = 1.2 mになります。視差が半分になると、計算される奥行きは2倍です。横位置の差で比べられるよう、実機ではレンズのゆがみや左右の傾きも補正します。</p></details>${
        stereo.history.length
          ? '<details><summary>計算した結果を比べる</summary>' +
            stereo.history
              .slice(-5)
              .map(
                (r) =>
                  `<p>実際 ${fmt(r.actual)} m ／ 視差 ${fmt(r.shift, 1)} px → 計算 ${fmt(r.depth)} m</p>`,
              )
              .join('') +
            '</details>'
          : ''
      }`;
  };
  $('vsDistance').oninput = () => {
    stereo.z = Number($('vsDistance').value);
    $('vsDistanceValue').textContent = fmt(stereo.z, 1) + ' m';
    draw();
    setStatus('奥行きを変えました。左右の画像で点Aの位置を比べ、もう一度重ねてください。');
  };
  $('vsShift').oninput = () => {
    stereo.shift = Number($('vsShift').value);
    $('vsShiftValue').textContent = stereo.shift + ' px';
    draw();
  };
  $('vsMeasure').onclick = () => {
    const z = depthFromDisparity(stereo.shift),
      error = Math.abs(z - stereo.z),
      ok = error <= 0.1;
    stereo.history.push({ actual: stereo.z, shift: stereo.shift, depth: z });
    draw();
    $('vsResult').innerHTML =
      `<strong>${ok ? '10 cm以内のずれで測れました' : '点の重なりをもう少し調整してみましょう'}</strong><p>240 × 0.075 ÷ ${stereo.shift} = ${fmt(z)} m<br>実際 ${fmt(stereo.z)} mとの差：${fmt(error * 100, 1)} cm</p>`;
    setStatus(
      ok
        ? '次は荷箱を遠ざけ、同じ1 pxの合わせ間違いが距離にどれだけ響くか比べましょう。'
        : '青い点を緑の線に重ねてから、もう一度計算してください。',
    );
  };
  draw();
  setStatus('左右の画像は、別々に搭載したカメラではなく、1台の装置の中の二つの視点です。');
  $('visionReflect').innerHTML =
    '<h2>遠い物ほど、なぜ測りにくくなる？</h2><p>遠ざかると視差が小さくなります。同じ1 pxの間違いでも、計算する奥行きの差が大きくなります。また、模様のない面や同じ模様が続く面では、左右のどこが同じ点かを決めにくくなります。</p><p>この実験の画像と奥行きは、配置から計算した理想的な例です。実機の画素照合アルゴリズムは実行していません。</p>';
  $('visionTakeaway').textContent =
    '左右の画像で同じ場所を見つけ、その横位置の差から奥行きを計算します。';
}
function renderRGBD({ showImage, setStatus }) {
  const frame = imported || rgbdScene(settings);
  $('visionInputTitle').textContent = '同じ装置のRGB画像';
  $('visionOutputTitle').textContent = '位置を合わせた奥行き画像';
  $('visionSourceName').textContent = imported
    ? '読み込んだRGB-D計測ログ'
    : '部屋と荷箱の模擬RGB-D画像';
  $('visionInputNote').textContent = `${frame.width} × ${frame.height} 画素`;
  $('visionOutputNote').textContent = '橙：近い ／ 青：遠い ／ 濃い灰：測れない';
  $('visionControls').innerHTML =
    `<p class="eyebrow">手前の赤い荷箱を選ぶ</p><h2>色だけで選んでから、距離を加える</h2><p>${imported ? 'まず画像の中をクリックし、RGBと奥行きの対応を確認します。外部ログは自動採点しません。' : '赤い荷箱が手前と奥にあります。まず色だけで選びます。奥の箱まで残ったら「奥行きの条件も使う」にチェックし、同じ場面で再実行します。上限1.8 mなら、赤い画素の中から正面方向の奥行きが1.8 m以内のものを残します。'}</p><label class="basics-check"><input id="vdUseDepth" type="checkbox" ${settings.useDepth ? 'checked' : ''}>奥行きの条件も使う</label>${slider('vdMax', '残す奥行きの上限', settings.maxDepth, 0.5, 4, 0.1, ' m')}<button id="vdRun" class="primary full">この条件で荷箱を選ぶ</button><label class="vision-select">測れる条件を変える<select id="vdCondition" ${imported ? 'disabled' : ''}><option value="normal">模様があり、測れる</option><option value="holes">一部の画素が測れない</option><option value="plain">模様の乏しい面で測れない例</option><option value="glass">反射する包材で測れない例</option></select></label><p class="helper">測れない画素は0 mでも、空いている場所でもありません。ここでは選ぶ対象から外し、「不明」として数えます。</p><details data-help-dialog><summary>RGBとデプスの位置を合わせる</summary><p>同じ装置でも撮影する位置や画角が違うため、生の画像の同じ画素が同じ物とは限りません。校正値でデプスをRGB画像に位置合わせし、撮影時刻も揃えてから使います。右は位置合わせ済みの例です。</p></details>`;
  $('vdCondition').value = settings.condition;
  const draw = () => {
    $('visionOutputTitle').textContent = '位置を合わせた奥行き画像';
    $('visionOutputNote').textContent = '橙：近い ／ 青：遠い ／ 濃い灰：測れない';
    showImage($('visionInput'), { width: frame.width, height: frame.height, data: frame.rgb });
    showImage($('visionOutput'), depthImage(frame));
    for (const id of ['visionInput', 'visionOutput']) {
      const c = $(id).getContext('2d');
      c.strokeStyle = '#fff';
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(selected.u, selected.v, 5, 0, Math.PI * 2);
      c.stroke();
    }
    showPoint(frame);
  };
  for (const id of ['visionInput', 'visionOutput'])
    $(id).onclick = (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      selected = {
        u: Math.max(
          0,
          Math.min(
            frame.width - 1,
            Math.floor(((e.clientX - rect.left) / rect.width) * frame.width),
          ),
        ),
        v: Math.max(
          0,
          Math.min(
            frame.height - 1,
            Math.floor(((e.clientY - rect.top) / rect.height) * frame.height),
          ),
        ),
      };
      draw();
    };
  $('vdUseDepth').onchange = () => {
    settings.useDepth = $('vdUseDepth').checked;
    setStatus('条件を変更しました。実行して、前の結果と比べます。');
  };
  $('vdMax').oninput = () => {
    settings.maxDepth = Number($('vdMax').value);
    $('vdMaxValue').textContent = settings.maxDepth + ' m';
    setStatus('奥行きの上限を変えました。「この条件で荷箱を選ぶ」で更新します。');
  };
  $('vdCondition').onchange = () => {
    settings.condition = $('vdCondition').value;
    settings.ran = false;
    renderRGBD({ showImage, setStatus });
  };
  $('vdRun').onclick = () => {
    const result = selectDepthPixels(frame, settings);
    settings.ran = true;
    showImage($('visionOutput'), result);
    $('visionOutputTitle').textContent = '条件に合った画素';
    $('visionOutputNote').textContent = '色の残った部分が選ばれた画素';
    const good = !imported && result.target > 100 && result.background === 0;
    setStatus(
      imported
        ? `${result.selected}画素を選びました。対象が残ったか、元の画像と見比べてください。`
        : good
          ? '手前の荷箱だけを残せました。次は、測れない画素がある条件でも確かめましょう。'
          : !result.target
            ? '手前の箱が残りませんでした。距離の上限と、測れない画素がないかを確かめます。'
            : '奥の赤い箱も残っています。色が同じ物を区別するには、距離の条件が使えそうです。',
    );
    $('vdSelection').innerHTML =
      `<strong>${settings.useDepth ? '色＋奥行き' : '色だけ'}で選んだ画素：${result.selected}</strong><p>赤い画素のうち、奥行きが不明：${result.unknown}画素${imported ? '' : ` ／ 手前 ${result.target}・それ以外 ${result.background}画素`}</p><button id="vdMap" class="small">奥行き画像に戻す</button>`;
    $('vdMap').onclick = () => {
      settings.ran = false;
      renderRGBD({ showImage, setStatus });
    };
  };
  $('visionEvidence').hidden = false;
  $('visionEvidence').innerHTML =
    '<h2>画素を押して、色と奥行きを確かめる</h2><div id="vdPoint" class="depth-result"></div><div id="vdSelection" class="depth-result">まだ条件で選んでいません。最初は「奥行きの条件も使う」を外して実行します。</div><details data-help-dialog><summary>奥行きから3Dの点へ</summary><p>画像の横・縦位置は「どの方向か」、デプスのZは「正面方向にどれだけ先か」を表します。カメラの写り方を表す校正値を合わせると、右・下・正面の3方向の位置を計算できます。たとえばX = (横の画素位置 − 画像中心の横位置) × Z ÷ fxです。fxは横方向の焦点距離を画素単位で表した値です。Xは右、Yは下、Zは正面を正とし、左側ならXは負になります。このような3Dの点を集めたものが点群です。</p><p>点群1枚は「いま見えている面」です。地図として重ねるには、撮影時のロボットの位置・向きを推定し、座標を揃える必要があります。RGB-D SLAMはこのような情報も利用します。今回のSLAM教材の推定器は車輪・IMU・2D LiDARを使います。</p></details>';
  draw();
  setStatus('左の荷箱をクリックすると、右の対応する画素と奥行きを確認できます。');
  $('visionReflect').innerHTML =
    '<h2>見えているのに、距離が測れないときは？</h2><p>RGBに写る物でも、模様、反射、透明さ、遮られ方、距離などによってデプスが欠けることがあります。「測れない」を「障害物なし」に置き換えず、見る位置を変える、再計測する、LiDARも確認する、といった方法を考えます。</p><p>2D LiDARは一定の高さの断面を広く測ります。デプスカメラは前方の面を上下にも測ります。得意な範囲が異なり、どちらにも計測できない条件があります。この模擬画像の欠けは学習用に加えたもので、特定機種の性能を表してはいません。</p>';
  $('visionTakeaway').textContent =
    'RGBで「どの部分か」、デプスで「どれだけ手前か」を調べます。測れなかった場所は不明のまま扱います。';
}
function showPoint(frame) {
  const { u, v } = selected,
    p = depthPoint(frame, u, v),
    i = (v * frame.width + u) * 4;
  $('vdPoint').innerHTML =
    `<strong>横 ${u}・縦 ${v} の画素</strong><p>RGB：${Array.from(frame.rgb.slice(i, i + 3)).join(' / ')}<br>${p ? `奥行き Z：${fmt(p.z)} m ／ カメラからの直線距離：${fmt(Math.hypot(p.x, p.y, p.z))} m` : '奥行き：不明（この場所は測れません）'}</p>${p ? `<p>カメラ基準の位置：右 X ${fmt(p.x)} m・下 Y ${fmt(p.y)} m・正面 Z ${fmt(p.z)} m</p>` : ''}`;
}

export { DEPTH_CONTENT, setDepthFrame, clearDepthFrame, getDepthFrame, depthSource, renderDepth };
