import { lessonGuide, figureGuide } from '../shell/lesson-guide.js';
import { SLAM_TOPICS, SLAM_GROUPS, renderSlamConcept } from './concepts.js';

// Small, deterministic examples. These do not alter the experiment's sensor logs.
const TAU = 2 * Math.PI,
  DIAMETER = 0.13,
  TRACK = 0.32;
const $ = (id) => document.getElementById(id),
  number = (n, d = 2) => (Math.abs(n) < 0.00001 ? 0 : n).toFixed(d);
function wheelExample(leftRpm, rightRpm, seconds = 2, grip = 1) {
  const left = ((DIAMETER * Math.PI * leftRpm * seconds) / 60) * grip,
    right = ((DIAMETER * Math.PI * rightRpm * seconds) / 60) * grip;
  const distance = (left + right) / 2,
    angle = (right - left) / TRACK;
  const point = (t) =>
    Math.abs(angle) < 1e-9
      ? { x: distance * t, y: 0 }
      : {
          x: (distance / angle) * Math.sin(angle * t),
          y: (distance / angle) * (1 - Math.cos(angle * t)),
        };
  return {
    left,
    right,
    distance,
    angle,
    ...point(1),
    path: Array.from({ length: 61 }, (_, i) => point(i / 60)),
  };
}
function imuExample(rate, seconds, distance) {
  const angle = (rate * seconds * Math.PI) / 180;
  return { angle, x: distance * Math.cos(angle), y: distance * Math.sin(angle) };
}
// Ray intersections are used only to produce demonstration measurements.
function basicsScan(x = 0, y = 0, count = 180) {
  return Array.from({ length: count }, (_, i) => {
    const a = (i * TAU) / count,
      c = Math.cos(a),
      s = Math.sin(a);
    const tx = Math.abs(c) < 1e-10 ? Infinity : ((c > 0 ? 2 : -0.5) - x) / c;
    const ty = Math.abs(s) < 1e-10 ? Infinity : ((s > 0 ? 1.5 : -1) - y) / s;
    const r = Math.min(tx, ty);
    return { x: r * c, y: r * s, r, a };
  });
}
// Deliberately limited to one translation axis, with a known heading, so learners
// can inspect the operation. The search uses measured points, never room bounds.
function scanMismatch(reference, scan, shift) {
  return (
    scan.reduce(
      (sum, p) =>
        sum + Math.min(...reference.map((q) => (p.x + shift - q.x) ** 2 + (p.y - q.y) ** 2)),
      0,
    ) / scan.length
  );
}
function matchBasicScan(reference, scan) {
  let best = { shift: 0, error: Infinity };
  for (let i = 0; i <= 120; i++) {
    const shift = i / 100,
      error = scanMismatch(reference, scan, shift);
    if (error < best.error) best = { shift, error };
  }
  return best;
}
const topics = SLAM_TOPICS;
let topic = 'pose',
  left = 30,
  right = 30,
  slip = false,
  rate = 30,
  seconds = 3,
  distance = 0.6,
  beam = 30,
  mapping = false,
  shift = 0.9,
  matched = false;
const firstScan = basicsScan(),
  secondScan = basicsScan(0.6);
const robot = (x, y, angle = 0, ghost = false) =>
  `<g transform="translate(${x} ${y}) rotate(${(-angle * 180) / Math.PI})" opacity="${ghost ? 0.28 : 1}"><rect x="-14" y="-23" width="29" height="46" rx="9" fill="#c9dcde" stroke="#7299a4"/><rect x="-12" y="-28" width="24" height="8" rx="3" fill="#152d39" stroke="#89a5b0"/><rect x="-12" y="20" width="24" height="8" rx="3" fill="#152d39" stroke="#89a5b0"/><rect x="7" y="-13" width="9" height="26" rx="4" fill="#244c65"/><circle cx="12" cy="-6" r="3" fill="#b7e6ff"/><circle cx="12" cy="6" r="3" fill="#b7e6ff"/><circle r="8" fill="#274b50" stroke="#80d5c2" stroke-width="2"/><path d="M24 -6L32 0L24 6" fill="none" stroke="#a8e2d3" stroke-width="2"/></g>`;
const line = (x1, y1, x2, y2, color = '#54717e', extra = '') =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" ${extra}/>`;
const label = (x, y, text, extra = '') =>
  `<text x="${x}" y="${y}" fill="#bdd2da" font-size="14" ${extra}>${text}</text>`;
function svg(body, title) {
  return `<svg viewBox="0 0 680 360" role="img" aria-label="${title}"><defs><pattern id="basicsGrid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#789baa" stroke-opacity=".10"/></pattern></defs><rect width="680" height="360" fill="#192f3a"/><rect x="30" y="25" width="620" height="310" fill="url(#basicsGrid)"/>${body}</svg>`;
}
function path(points, ox, oy, scale, color, dashed = false) {
  return `<polyline points="${points.map((p) => `${ox + p.x * scale},${oy - p.y * scale}`).join(' ')}" fill="none" stroke="${color}" stroke-width="3" ${dashed ? 'stroke-dasharray="6 5"' : ''}/>`;
}
const slider = (id, title, min, max, step, value, unit) =>
  `<label class="basics-slider" for="${id}"><span>${title}<output id="${id}Value" for="${id}">${value}${unit}</output></span><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"></label>`;
function basicsTemplate() {
  return `<section id="slamBasics"><nav class="basics-topics basics-groups" aria-label="SLAMを学ぶ順序">${SLAM_GROUPS.map((title, i) => `<button data-slam-basics-group="${i}" aria-pressed="${i === 0}"><span>${i + 1}</span>${title}</button>`).join('')}</nav><nav id="slamBasicTopics" class="learning-subtopics" aria-label="この段階の実験"></nav><div id="slamLessonBrief"></div><div class="basics-layout"><div class="basics-workspace"><section class="card basics-visual"><div class="basics-visual-heading"><p class="eyebrow" id="basicsFigureStep"></p><h2 id="basicsFigureTitle"></h2></div><div id="slamFigureGuide"></div><div id="basicsFigure"></div><div class="basics-calculation" id="basicsCalculation"></div><div class="basics-observation" id="basicsObservation" aria-live="polite"></div></section><section class="card basics-evidence" id="basicsEvidence" hidden></section></div><aside class="guide card basics-guide" id="basicsControls"></aside></div><section class="card basics-question" id="basicsQuestion"></section><div class="basics-footer"><p id="basicsSummary"></p><button class="primary" id="basicsNext"></button></div></section>`;
}
function initSlamBasics(onExperiment) {
  document.querySelectorAll('[data-slam-basics-group]').forEach(
    (b) =>
      (b.onclick = () => {
        topic = topics.find((t) => t[2] === Number(b.dataset.slamBasicsGroup))[0];
        show();
      }),
  );
  $('basicsNext').onclick = () => {
    const i = topics.findIndex((t) => t[0] === topic);
    if (i < topics.length - 1) {
      topic = topics[i + 1][0];
      show();
      $('slamBasics').scrollIntoView({ block: 'start' });
    } else onExperiment();
  };
  show();
}
function reviewSlamBasics(id) {
  if (!topics.some((t) => t[0] === id)) return false;
  topic = id;
  show();
  return true;
}
function show() {
  $('slamLessonBrief').innerHTML = lessonGuide('slam-' + topic);
  $('slamFigureGuide').innerHTML = figureGuide('slam-' + topic);
  const group = topics.find((t) => t[0] === topic)[2];
  document
    .querySelectorAll('[data-slam-basics-group]')
    .forEach((b) =>
      b.setAttribute('aria-pressed', String(Number(b.dataset.slamBasicsGroup) === group)),
    );
  $('slamBasicTopics').innerHTML = topics
    .filter((t) => t[2] === group)
    .map(
      ([id, title]) =>
        `<button data-basics-topic="${id}" aria-pressed="${id === topic}">${title}</button>`,
    )
    .join('');
  document.querySelectorAll('[data-basics-topic]').forEach(
    (b) =>
      (b.onclick = () => {
        topic = b.dataset.basicsTopic;
        show();
      }),
  );
  $('basicsEvidence').hidden = true;
  const index = topics.findIndex((t) => t[0] === topic);
  $('basicsNext').textContent =
    index < topics.length - 1
      ? '次へ：' + topics[index + 1][1] + ' →'
      : '総合実験：センサーを組み合わせて比べる →';
  if (!['wheels', 'imu', 'lidar'].includes(topic)) {
    renderSlamConcept(topic, { svg, robot, line, label, slider });
    return;
  }
  const question = {
    wheels: [
      '車輪が回った量と、進んだ量はいつも同じ？',
      '直進・旋回を試したら、空回りの条件を入れて比べます。回転数だけでは分からない情報は何でしょうか。',
    ],
    imu: [
      '向きの小さなずれは、位置にどう影響する？',
      '同じ距離でも、向きが変われば違う場所へ着きます。静止時の偏りと、その補正は後の総合実験で比べられます。',
    ],
    lidar: [
      '測った距離が同じでも、地図がずれるのはなぜ？',
      '距離の点を置くときに、機体の位置と向きを使うからです。位置の推定と地図づくりは、お互いに影響します。',
    ],
  }[topic];
  $('basicsQuestion').innerHTML = '<h2>' + question[0] + '</h2><p>' + question[1] + '</p>';
  if (topic === 'wheels') {
    $('basicsFigureStep').textContent = '車輪の回転 → 進んだ距離 → 位置と向き';
    $('basicsFigureTitle').textContent = '左右の車輪を、2秒間回したら？';
    $('basicsControls').innerHTML =
      `<h2>車輪の回転から、2秒後の位置を見積もる</h2><p>滑らずに転がる車輪は、1回転でタイヤの円周だけ進みます。左右の回転量から短い移動と向きの変化を計算し、出発点から足して今の位置を見積もります。回転数センサーが直接測るのは車輪の回転で、床の上を進んだ距離そのものではありません。</p><div class="basics-presets"><button data-wheel-preset="straight">直進</button><button data-wheel-preset="curve">曲がる</button><button data-wheel-preset="spin">その場で回る</button></div>${slider('basicsLeft', '左の車輪', -30, 60, 15, left, ' rpm')}${slider('basicsRight', '右の車輪', -30, 60, 15, right, ' rpm')}<p class="helper">rpmは1分間の回転数。30 rpmなら、2秒間で1回転します。マイナスは逆回転です。</p><label class="basics-check"><input id="basicsSlip" type="checkbox" ${slip ? 'checked' : ''}>床で車輪が20%空回りしたら</label><details data-help-dialog><summary>位置を計算するには？</summary><p>出発点を「0」、初めの向きを基準にします。左右の距離の平均が、機体の中心が進んだ距離です。左右の距離に差があると、機体は曲がります。</p><p>短い時間ごとに「今の向きに、どれだけ進んだか」を足すと、出発点からの位置が求まります。これが<strong>オドメトリ</strong>です。</p><p>向きの変化［ラジアン］＝（右の距離 − 左の距離）÷ 車輪の間隔です。ラジアンも角度の単位で、πラジアンが180°です。この機体の車輪は直径13 cm、左右の間隔は32 cm。右の車輪が左より長く進むと、左へ曲がります。</p></details>`;
    $('basicsLeft').oninput = () => {
      left = Number($('basicsLeft').value);
      drawWheels();
    };
    $('basicsRight').oninput = () => {
      right = Number($('basicsRight').value);
      drawWheels();
    };
    $('basicsSlip').onchange = () => {
      slip = $('basicsSlip').checked;
      drawWheels();
    };
    document.querySelectorAll('[data-wheel-preset]').forEach(
      (b) =>
        (b.onclick = () => {
          [left, right] =
            b.dataset.wheelPreset === 'straight'
              ? [30, 30]
              : b.dataset.wheelPreset === 'curve'
                ? [15, 30]
                : [-15, 15];
          $('basicsLeft').value = left;
          $('basicsRight').value = right;
          drawWheels();
        }),
    );
    $('basicsSummary').textContent =
      '車輪の回転を数えて分かるのは、出発点からどれだけ動いたか。滑ると、計算した位置と実際の位置がずれます。';
    drawWheels();
  } else if (topic === 'imu') {
    $('basicsFigureStep').textContent = '回転の速さ × 時間 → 向きの変化';
    $('basicsFigureTitle').textContent = '向きを変えてから、まっすぐ進む';
    $('basicsControls').innerHTML =
      `<h2>曲がった角度から、その後に着く位置を求める</h2><p>IMUは、回転や加速度を測るセンサーをまとめた装置です。その中のジャイロが測るのは機体の回る速さで、角速度とも呼びます。たとえば毎秒30°ずつ3秒回ると、向きは90°変わります。その向きへ、車輪の回転から求めた距離を進んだとして位置を計算します。</p>${slider('basicsRate', '回転の速さ', -45, 45, 15, rate, ' °/秒')}${slider('basicsSeconds', '回転を続ける時間', 1, 4, 1, seconds, ' 秒')}${slider('basicsDistance', 'その後に進む距離（車輪で計測）', 0, 1, 0.1, distance, ' m')}<p class="helper">プラスは左回り、マイナスは右回り。この例では、その場で回ってから直進します。</p><details data-help-dialog><summary>加速度からも位置を求められる？</summary><p>加速度は、速さが1秒にどれだけ変わるかを表す量です。たとえば1 m/s²なら、毎秒1 m/sずつ速さが増えます。短い時間ごとに「加速度×時間」を足して速さの変化を求め、その速さに時間を掛けて足すと移動距離を求められます。この積み重ねが「積分」です。</p><p>ただし、初めの速さ・位置が必要です。機体の向きを考慮して重力の影響を除く必要もあり、小さな測定誤差が位置の大きなずれになります。</p><p>たとえば静止中に0.02 m/s²の誤差が残るだけでも、10秒後には1 m進んだ計算になります。そのため、この教材では距離に車輪の情報を使います。</p></details><details data-help-dialog><summary>9軸IMUの、残りの情報は？</summary><p>加速度・回転の速さ・磁気を、それぞれ3方向で測るので9軸です。静止に近いときは加速度から重力の方向を見て傾きを推定でき、磁気は方角の手がかりになります。</p><p>走行中の加減速や周囲の金属は測定に影響します。ここで使うのは、床の上での向きの変化を測るジャイロです。</p></details>`;
    for (const [id, update] of [
      ['basicsRate', (v) => (rate = v)],
      ['basicsSeconds', (v) => (seconds = v)],
      ['basicsDistance', (v) => (distance = v)],
    ])
      $(id).oninput = () => {
        update(Number($(id).value));
        drawImu();
      };
    $('basicsSummary').textContent =
      'IMUは位置そのものを教えてくれるわけではありません。車輪で求めた距離に、IMUで求めた向きを組み合わせます。';
    drawImu();
  } else {
    $('basicsFigureStep').textContent = '距離と方向 → 壁の点 → 移動して重ねた地図';
    $('basicsFigureTitle').textContent = '測った距離を、地図の点にする';
    lidarControls();
    $('basicsSummary').textContent =
      '点の重なりから自分の位置を調整し、その位置を使って地図を更新する。この両方を一緒に行うのがSLAMです。';
    drawLidar();
  }
}
function drawWheels() {
  $('basicsLeftValue').textContent = left + ' rpm';
  $('basicsRightValue').textContent = right + ' rpm';
  const p = wheelExample(left, right),
    actual = wheelExample(left, right, 2, 0.8),
    ox = 260,
    oy = 210,
    scale = 240;
  let art =
    line(65, oy, 630, oy) +
    line(ox, 315, ox, 40) +
    label(570, oy + 26, '前方向 →') +
    label(ox - 58, 45, '左方向 ↑') +
    robot(ox, oy, 0, true) +
    path(p.path, ox, oy, scale, '#8ad7c0');
  if (slip)
    art +=
      path(actual.path, ox, oy, scale, '#edb372', true) +
      robot(ox + actual.x * scale, oy - actual.y * scale, actual.angle, true) +
      label(36, 333, '橙の破線：滑ったときの実際の動き');
  art +=
    robot(ox + p.x * scale, oy - p.y * scale, p.angle) + label(ox - 70, oy + 70, '出発点（0, 0）');
  $('basicsFigure').innerHTML = svg(art, '出発点からの車輪オドメトリの軌跡');
  $('basicsCalculation').innerHTML =
    `<div><span>1回転で進む距離</span><strong>13 cm × π ≈ 40.8 cm</strong></div><div><span>2秒間に回った量 → 移動量（前進＋・後退−）</span><strong>左 ${number(left / 30, 1)} 回 → ${number(p.left * 100, 1)} cm<br>右 ${number(right / 30, 1)} 回 → ${number(p.right * 100, 1)} cm</strong></div><div class="basics-position"><span>出発時の向きを基準にした位置と向き</span><strong>前方向 ${number(p.x * 100, 1)} cm · 左方向 ${number(p.y * 100, 1)} cm · ${number((p.angle * 180) / Math.PI, 1)}°</strong></div>`;
  const motion =
    left === right
      ? left === 0
        ? '左右とも止めると、位置は変わりません。'
        : '左右が同じだけ進むので、向きは変わらず直進します。'
      : left === -right
        ? '左右が逆向きに同じだけ進むので、その場で回ります。'
        : right > left
          ? '右の車輪の方が遠くまで進むので、機体は左へ向きを変えます。'
          : '左の車輪の方が遠くまで進むので、機体は右へ向きを変えます。';
  $('basicsObservation').textContent = slip
    ? '回転数センサーは空回りも数えます。同じ回転数でも実際の移動は小さくなり、車輪の情報だけではこのずれに気づけません。'
    : motion;
}
function drawImu() {
  $('basicsRateValue').textContent = rate + ' °/秒';
  $('basicsSecondsValue').textContent = seconds + ' 秒';
  $('basicsDistanceValue').textContent = number(distance, 1) + ' m';
  const p = imuExample(rate, seconds, distance),
    ox = 340,
    oy = 180,
    scale = 125;
  const arc = Array.from({ length: 31 }, (_, i) => ({
    x: 0.4 * Math.cos((p.angle * i) / 30),
    y: 0.4 * Math.sin((p.angle * i) / 30),
  }));
  let art =
    line(65, oy, 620, oy) +
    line(ox, 322, ox, 35) +
    label(555, oy + 24, '初めの向き') +
    label(45, 40, '① その場で回る → ② まっすぐ進む') +
    path(arc, ox, oy, scale, '#9dbbf2') +
    robot(ox, oy, 0, true) +
    path([{ x: 0, y: 0 }, p], ox, oy, scale, '#8ad7c0') +
    robot(ox + p.x * scale, oy - p.y * scale, p.angle) +
    label(35, 333, '線：車輪の距離と、IMUの向きから求めた移動');
  $('basicsFigure').innerHTML = svg(art, 'ジャイロで向きを求めてから、車輪で測った距離だけ進む図');
  $('basicsCalculation').innerHTML =
    `<div><span>① 向きの変化</span><strong>${rate}°/秒 × ${seconds} 秒 = ${rate * seconds}°</strong></div><div><span>② その向きに進む距離</span><strong>車輪で ${number(distance, 2)} m を計測</strong></div><div class="basics-position"><span>出発時の向きを基準にした位置</span><strong>前方向 ${number(p.x, 2)} m · 左方向 ${number(p.y, 2)} m</strong></div>`;
  $('basicsObservation').textContent =
    `向きが${rate * seconds}°変わってから、${number(distance, 2)} m進みました。回転する速さや時間を変えると、同じ距離を進んでも着く場所が変わります。`;
}
function lidarControls() {
  const guideKey = mapping ? 'slam-lidar-match' : 'slam-lidar';
  $('slamLessonBrief').innerHTML = lessonGuide(guideKey);
  $('slamFigureGuide').innerHTML = figureGuide(guideKey);
  $('basicsControls').innerHTML = mapping
    ? `<h2>同じ壁が重なるよう、現在地の見積もりを直す</h2><p>移動すると、壁までの距離は変わります。新しい点を地図に置くには、今のロボットの位置と向きが必要です。</p><p>車輪からは0.90 m進んだと見積もりました。灰色と橙色が同じ壁を表すように、現在地の見積もりを変えてください。この操作は、走行済みの記録を地図に置く場所を直します。実際の機体や壁を動かす操作ではありません。</p>${slider('basicsShift', 'ロボットの位置の見積もり', 0.3, 1.1, 0.01, shift, ' m')}<div class="basics-legend"><span><i class="old-point"></i>前の位置で測った点</span><span><i class="new-point"></i>今回測った点</span></div><button id="basicsMatch" class="primary full">点の重なりから位置を直す</button><button id="basicsScanReset" class="text-button">1本の距離から見直す</button><details data-help-dialog><summary>コンピューターは何を計算した？</summary><p>新しい点を少しずつずらし、各点と最も近い前の点との距離を調べます。その距離を二乗して平均し、平方根を取った値が「ずれの目安」です。小さいほど形がよく重なりますが、機体の本当の位置との誤差そのものではありません。測る場所が変わると壁上の点の間隔も変わるので、正しい位置でも0にならないことがあります。</p><p>壁の形を照らし合わせるこの処理を「スキャンマッチング」といいます。</p><p>この図は仕組みを見るために、向きが分かっている直進だけを扱います。実験では、前後・左右・回転のずれを調整します。同じ形が続く通路では、うまく位置を決められないこともあります。</p></details>`
    : `<h2>壁がどちらの方向に、何m先にあるか測る</h2><p>この教材で説明するLiDARは、光が物に当たって戻るまでの時間から距離を求めます。往復に時間がかかるほど遠い物です。測った方向と距離を組にすると、機体から見た壁の点を置けます。これだけで機体自身の現在地が分かるわけではありません。</p>${slider('basicsBeam', '測る方向（機体の正面から）', -90, 90, 5, beam, '°')}<p class="helper">線は光を出した方向、先端の点は壁に当たった場所です。これを周囲の多くの方向で繰り返します。</p><button id="basicsMeasure" class="primary full">周囲を測ってから、移動する →</button><p class="helper">次は、別の場所で測った点を地図に重ねます。</p>`;
  if (mapping) {
    $('basicsShift').oninput = () => {
      shift = Number($('basicsShift').value);
      matched = false;
      drawLidar();
    };
    $('basicsMatch').onclick = () => {
      shift = matchBasicScan(firstScan, secondScan).shift;
      matched = true;
      $('basicsShift').value = shift;
      drawLidar();
    };
    $('basicsScanReset').onclick = () => {
      mapping = false;
      matched = false;
      lidarControls();
      drawLidar();
    };
  } else {
    $('basicsBeam').oninput = () => {
      beam = Number($('basicsBeam').value);
      drawLidar();
    };
    $('basicsMeasure').onclick = () => {
      mapping = true;
      shift = 0.9;
      matched = false;
      lidarControls();
      drawLidar();
    };
  }
}
function drawLidar() {
  const scale = 100,
    ox = 240,
    oy = 220,
    point = (p, dx = 0, color = '#829ca9', radius = 2.6) =>
      `<circle cx="${ox + (p.x + dx) * scale}" cy="${oy - p.y * scale}" r="${radius}" fill="${color}"/>`;
  let art = '',
    calculation = '',
    observation = '';
  if (!mapping) {
    $('basicsBeamValue').textContent = beam + '°';
    const a = (beam * Math.PI) / 180,
      c = Math.cos(a),
      s = Math.sin(a),
      r = Math.min(
        Math.abs(c) < 1e-9 ? Infinity : 2 / c,
        Math.abs(s) < 1e-9 ? Infinity : (s > 0 ? 1.5 : -1) / s,
      ),
      p = { x: r * c, y: r * s };
    art =
      `<rect x="${ox - 50}" y="${oy - 150}" width="250" height="250" fill="none" stroke="#65838e" stroke-width="5"/>` +
      line(ox, oy, ox + p.x * scale, oy - p.y * scale, '#8ad7c0', 'stroke-width="2"') +
      point(p, 0, '#f1c382', 6) +
      robot(ox, oy) +
      label(465, 85, '上から見た部屋') +
      label(465, 117, '線の先に点を置く') +
      label(ox - 37, oy + 62, 'ロボット');
    calculation = `<div><span>測った方向</span><strong>正面から ${beam}°</strong></div><div><span>測った距離</span><strong>${number(r)} m</strong></div><div class="basics-position"><span>ロボットから見た、壁の点の位置</span><strong>前方向 ${number(p.x)} m · 左方向 ${number(p.y)} m</strong></div>`;
    observation =
      '向きと距離をセットにすると、壁に当たった場所を点で表せます。これはまだ、今いる場所から見た周囲の形です。';
  } else {
    $('basicsShiftValue').textContent = number(shift) + ' m';
    const error = Math.sqrt(scanMismatch(firstScan, secondScan, shift));
    art =
      firstScan.map((p) => point(p)).join('') +
      secondScan.map((p) => point(p, shift, '#efb271')).join('') +
      robot(ox, oy, 0, true) +
      line(ox, oy, ox + shift * scale, oy, '#8ad7c0', 'stroke-dasharray="4 4"') +
      robot(ox + shift * scale, oy) +
      label(50, 40, '点の形が重なる位置を探す') +
      label(ox - 27, oy + 64, '出発点') +
      label(465, 290, '位置を変えると、') +
      label(465, 314, '点の置き場所も変わる');
    calculation = `<div><span>出発点からの位置の見積もり</span><strong>${number(shift)} m</strong></div><div><span>前の点とのずれの目安</span><strong>${number(error * 100, 1)} cm</strong></div><div class="basics-position"><span>地図への置き方</span><strong>ロボットの向きに合わせた点を、見積もった位置に置く</strong></div>`;
    observation = matched
      ? `点どうしが近くなる位置を探すと、約${number(shift)} mになりました。この位置で今回の点を地図に重ねます。地図を手がかりに位置を直せました。`
      : error < 0.035
        ? '点の形がよく重なっています。このように周囲の形を手がかりにすると、車輪だけでは気づけなかった位置のずれを調整できます。'
        : '同じ壁なのに、点が二重になっています。測った距離が同じでも、ロボットの位置の見積もりがずれると、地図もずれます。';
  }
  $('basicsFigure').innerHTML = svg(art, 'LiDARの距離から壁の点を作り、移動後の点を地図に重ねる図');
  $('basicsCalculation').innerHTML = calculation;
  $('basicsObservation').textContent = observation;
}

export {
  wheelExample,
  imuExample,
  basicsScan,
  scanMismatch,
  matchBasicScan,
  basicsTemplate,
  initSlamBasics,
  reviewSlamBasics,
};
