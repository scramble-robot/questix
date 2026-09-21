import {
  pointInRobot,
  pointInWorld,
  measureRoom,
  MAPPING_ROOM,
  MAPPING_POSES,
  occupancyFromScans,
  localizationRoom,
  localizeOnKnownMap,
  rangeMismatch,
  loopFixture,
  closeLoop,
} from './concepts-core.js';

const $ = (id) => document.getElementById(id),
  fmt = (n, d = 1) => (Math.abs(n) < 0.00001 ? 0 : n).toFixed(d);
const pose = { x: 1, y: 1, theta: 0 },
  landmark = { x: 3, y: 1 };
let poseTurned = false,
  poseAnswer = null,
  mapView = 0,
  mapResolution = 0.1,
  mapFrames = [],
  mapCell = null,
  feature = false,
  guess = 2.5,
  locationChecked = false,
  loopResult = null,
  loopMatch = 0;
const fixture = loopFixture();
const SLAM_TOPICS = [
  ['pose', '位置と向き', 0],
  ['wheels', '車輪で移動を測る', 0],
  ['imu', 'IMUで向きを測る', 0],
  ['lidar', 'LiDARの点を重ねる', 1],
  ['map', '見えた範囲を地図にする', 1],
  ['ambiguity', '地図から位置を探す', 1],
  ['loop', '戻った場所から直す', 2],
];
const SLAM_GROUPS = ['位置と移動を知る', '周囲から地図と位置を求める', 'ずれを確かめて直す'];
function metrics(items) {
  $('basicsCalculation').innerHTML = items
    .map(([name, value]) => `<div><span>${name}</span><strong>${value}</strong></div>`)
    .join('');
}
function prompt(title, text, hint) {
  $('basicsQuestion').innerHTML =
    `<h2>${title}</h2><p>${text}</p><details><summary>考えるためのヒント</summary><p>${hint}</p></details>`;
}
function renderSlamConcept(topic, art) {
  if (topic === 'pose') drawPose(art);
  else if (topic === 'map') drawMap(art);
  else if (topic === 'ambiguity') drawLocalization(art);
  else drawLoop(art);
}
function drawPose({ robot, line, label }) {
  $('basicsFigureStep').textContent = '位置と向きが必要になる理由';
  $('basicsFigureTitle').textContent = '同じ場所なら、「前へ進む」だけで目印へ行ける？';
  $('basicsControls').innerHTML =
    `<h2>その場で、左へ向きを変える</h2><p>ロボットも目印も、場所は変えません。ロボットが左へ90°回ると、目印はロボットのどちら側になるでしょうか。</p><button id="spTurn" class="primary full">その場で左へ90°回す</button><button id="spReset" class="full">回す前に戻す</button><div id="spDecision" class="pose-decision" hidden><h3>目印へ進むには、まずどうする？</h3><p>回した後の、緑の矢印と目印の位置を見て選んでください。</p><div class="pose-answers"><button id="spForward" aria-pressed="false">そのまま前へ進む</button><button id="spFace" aria-pressed="false">右へ90°向き直す</button></div><p id="spFeedback" role="status"></p></div><details data-help-dialog><summary>位置と向きは、どう表す？</summary><p>地図の左下などに基準を決め、そこから右へ何mかをx、上へ何mかをyで表します。これが地図上の位置です。向きは、地図の右向きを0°として角度で表せます。</p><p>この例では、回す前も後も位置はx＝1 m、y＝1 mです。向きだけが、右向きの0°から上向きの90°に変わります。</p><p>センサーが測る「前に何m、右に何m」はロボットを基準にしています。その点を地図の上に置くときも、ロボットの位置と向きを使います。</p></details>`;
  const scene = (theta, title) => {
    const s = 65,
      ox = 25,
      oy = 235,
      p = { x: ox + pose.x * s, y: oy - pose.y * s },
      q = { x: ox + landmark.x * s, y: oy - landmark.y * s },
      front = pointInWorld({ x: 1.05, y: 0 }, { ...pose, theta }),
      turned = theta > 0;
    const grid =
      Array.from({ length: 5 }, (_, i) => line(25 + i * s, 26, 25 + i * s, 235, '#36505b')).join(
        '',
      ) +
      Array.from({ length: 4 }, (_, i) => line(26, 40 + i * s, 294, 40 + i * s, '#36505b')).join(
        '',
      );
    return `<svg viewBox="0 0 320 265" role="img" aria-label="${title}。${turned ? 'ロボットは地図の上向きで、目印は右に2 m。' : 'ロボットは地図の右向きで、目印は正面に2 m。'}"><rect x="18" y="18" width="284" height="225" rx="8" fill="#233d47"/>${grid}<circle cx="${p.x}" cy="${p.y}" r="36" fill="none" stroke="#90aeb9" stroke-dasharray="3 4"/>${line(p.x, p.y, q.x, q.y, '#f1c27c', 'stroke-dasharray="5 5" stroke-width="2"')}${label(156, 204, '2 m')}${line(p.x, p.y, ox + front.x * s, oy - front.y * s, '#84d5bb', 'stroke-width="3"')}<g transform="translate(${ox + front.x * s} ${oy - front.y * s}) rotate(${(-theta * 180) / Math.PI})"><path d="M-9 -5L0 0L-9 5" fill="none" stroke="#84d5bb" stroke-width="3"/></g>${label(turned ? 104 : 112, turned ? 89 : 118, '前へ進む方向', 'style="fill:#a6e3d1;font-size:14px"')}<circle cx="${q.x}" cy="${q.y}" r="9" fill="#f1c27c"/>${label(q.x - 15, q.y - 22, '目印')}${robot(p.x, p.y, theta)}</svg>`;
  };
  const render = () => {
    const theta = poseTurned ? Math.PI / 2 : 0,
      relative = pointInRobot(landmark, { ...pose, theta }),
      distance = Math.hypot(relative.x, relative.y);
    $('basicsFigure').innerHTML =
      `<div class="pose-comparison"><figure><h3>回す前</h3>${scene(0, '回す前')}<figcaption>目印は<strong>正面に ${fmt(distance, 0)} m</strong></figcaption></figure><figure class="pose-current"><h3>${poseTurned ? '左へ90°回した後' : '操作するロボット'}</h3>${scene(theta, poseTurned ? '左へ90°回した後' : '回す前と同じ向き')}<figcaption>目印は<strong>${relative.x > 0.1 ? '正面' : '右'}に ${fmt(distance, 0)} m</strong></figcaption></figure></div>`;
    metrics([
      ['変わらないもの', `ロボットと目印の位置<br>目印までの距離：${fmt(distance, 0)} m`],
      [
        '比べるもの',
        poseTurned ? 'ロボットの向き<br>目印の方向：正面 → 右' : 'ロボットの向きと、目印の方向',
      ],
    ]);
    $('spTurn').disabled = poseTurned;
    $('spReset').disabled = !poseTurned;
    $('spDecision').hidden = !poseTurned;
    $('spForward').setAttribute('aria-pressed', String(poseAnswer === 'forward'));
    $('spFace').setAttribute('aria-pressed', String(poseAnswer === 'face'));
    $('spFeedback').textContent =
      poseAnswer === 'forward'
        ? '今の「前」は地図の上方向です。そのまま進むと目印のある場所から外れます。目印はロボットの右にあるので、まず右へ向き直す必要があります。'
        : poseAnswer === 'face'
          ? 'その通りです。右へ90°向き直すと、目印が正面に戻ります。目印へ進むには、居場所に加えて向きの情報も必要です。'
          : '';
    $('basicsObservation').textContent = poseTurned
      ? '位置と距離は変わっていませんが、目印は正面から右側になりました。このまま前へ進んでも、目印には向かいません。進む方向を決めるには、向きの情報も必要です。'
      : '回す前は、目印が正面にあります。緑の矢印の方向へ進めば、目印へ近づけます。向きを変えた後も同じでしょうか。';
  };
  $('spTurn').onclick = () => {
    poseTurned = true;
    poseAnswer = null;
    render();
  };
  $('spReset').onclick = () => {
    poseTurned = false;
    poseAnswer = null;
    render();
  };
  $('spForward').onclick = () => {
    poseAnswer = 'forward';
    render();
  };
  $('spFace').onclick = () => {
    poseAnswer = 'face';
    render();
  };
  render();
  prompt(
    'この後、センサーで何を求める？',
    'ロボットが自分で動くには、移動した後も「どこにいるか」と「どちらを向いているか」を知る必要があります。センサーの情報から、この二つを見積もることを「自己位置推定」といいます。',
    '次は、左右の車輪が回った量から、どれだけ進み、どれだけ向きが変わったかを求めます。',
  );
  $('basicsSummary').textContent = '次は、車輪の回転を使って、動いた後の位置と向きを求めます。';
}
function drawMap({ svg, robot, line, label }) {
  $('basicsFigureStep').textContent = '測った光の通り道と、その先の面';
  $('basicsFigureTitle').textContent = '点がない場所は、空いているとは限らない';
  $('basicsControls').innerHTML =
    `<p class="eyebrow">ミッション · 棚の裏も調べる</p><h2>測る位置を変え、棚の裏側も地図に加える</h2><p>LiDARの光が通った場所と、物に当たった場所を小さなマスに記録します。棚の裏は、別の位置から測る必要があります。</p><button id="smScan" class="primary full">この位置から周囲を測る</button><label class="vision-select">測る位置<select id="smView">${['左下', '右下', '右上', '左上'].map((v, i) => `<option value="${i}" ${mapView === i ? 'selected' : ''}>${v}</option>`).join('')}</select></label><label class="vision-select">地図の1マスの大きさ<select id="smResolution"><option value="0.1" ${mapResolution === 0.1 ? 'selected' : ''}>10 cm</option><option value="0.2" ${mapResolution === 0.2 ? 'selected' : ''}>20 cm</option></select></label><button id="smReset" class="full">地図を消してやり直す</button><p class="helper">ここではロボットの位置と向きは分かっているものとして、地図の作り方だけを確かめます。「1マス10 cm」は床の10 cm四方を一つにまとめる意味です。20 cmにすると記録するマスは減りますが、細い隙間や物の境目を区別しにくくなります。</p><details><summary>地図の色は何を表す？</summary><p>白：光が通った場所。濃い色：光が物に当たった場所。灰色：まだ測れていないか、情報が足りない場所です。占有地図と呼びます。</p><p>同じ場所を何度か測り、観測を重ねます。実際のSLAMでは測定の誤差や動く人もあるので、障害物がある確からしさとして扱います。</p><p>白いマスも、ロボットが通れる幅とは限りません。機体の大きさや停止距離を考えるのは、その後の走行計画です。</p></details>`;
  const render = () => {
    const grid = occupancyFromScans(mapFrames, { resolution: mapResolution }),
      s = 77,
      ox = 267,
      oy = 310,
      k = mapResolution * s,
      p = MAPPING_POSES[mapView];
    const rs = 40,
      rx = 26,
      ry = 250;
    let body =
      label(24, 92, '実際の部屋（観察用）') +
      label(267, 36, '測定から作る地図') +
      `<rect x="${rx}" y="${ry - 3.2 * rs}" width="${4.8 * rs}" height="${3.2 * rs}" fill="#2b444f" stroke="#b3c5cb" stroke-width="2"/>`;
    body += MAPPING_ROOM.obstacles
      .map(
        (r) =>
          `<rect x="${rx + r.x * rs}" y="${ry - (r.y + r.h) * rs}" width="${r.w * rs}" height="${r.h * rs}" fill="#9eafb5"/>`,
      )
      .join('');
    body += label(rx + 2 * rs - 1, ry - 1.6 * rs + 6, '棚');
    body += MAPPING_POSES.map(
      (v, i) =>
        `<circle cx="${rx + v.x * rs}" cy="${ry - v.y * rs}" r="${i === mapView ? 6 : 3}" fill="${i === mapView ? '#8cd7c0' : '#708f9c'}"/>`,
    ).join('');
    body += robot(rx + p.x * rs, ry - p.y * rs, p.theta) + label(24, 285, '機体：いま測る位置');
    for (let y = 0; y < grid.h; y++)
      for (let x = 0; x < grid.w; x++) {
        const type = grid.cells[y * grid.w + x],
          color = {
            unknown: '#778891',
            uncertain: '#98a2a8',
            occupied: '#263a45',
            free: '#eef6f3',
          }[type];
        body += `<rect data-map-cell="${y * grid.w + x}" x="${ox + x * k}" y="${oy - (y + 1) * k}" width="${k + 0.15}" height="${k + 0.15}" fill="${color}" stroke="#a5b7bd" stroke-width=".18"/>`;
      }
    const latest = mapFrames.at(-1);
    if (latest && latest.view === mapView)
      body += latest.scan
        .filter((_, i) => i % 10 === 0)
        .map((ray) => {
          const end = pointInWorld(
            { x: ray.range * Math.cos(ray.a), y: ray.range * Math.sin(ray.a) },
            p,
          );
          return line(
            ox + p.x * s,
            oy - p.y * s,
            ox + end.x * s,
            oy - end.y * s,
            '#40a795',
            'stroke-opacity=".6"',
          );
        })
        .join('');
    body +=
      robot(ox + p.x * s, oy - p.y * s, p.theta) +
      label(267, 340, '白：空間　濃い色：表面　灰：不明');
    if (!mapFrames.length) body += label(390, 168, 'まだ測っていません');
    $('basicsFigure').innerHTML = svg(body, '観測済みの空間と障害物、未観測の範囲を示す地図');
    metrics([
      ['調べて判断できたマス', `${Math.round((grid.known / grid.total) * 100)}%`],
      ['測った位置', `${new Set(mapFrames.map((f) => f.view)).size} / 4か所`],
    ]);
    $('basicsFigure')
      .querySelectorAll('[data-map-cell]')
      .forEach(
        (r) =>
          (r.onclick = () => {
            mapCell = Number(r.dataset.mapCell);
            const type = grid.cells[mapCell];
            $('basicsObservation').textContent = {
              unknown: 'このマスは未観測です。物がないのか、棚に隠れているのか、まだ分かりません。',
              uncertain: 'このマスは観測が食い違っています。別の位置からもう一度測って確かめます。',
              free: 'このマスには光が通りました。この高さでは障害物を観測していません。機体が通れるかは幅や別の高さの情報も必要です。',
              occupied: 'このマスで物の表面を観測しました。その奥まで測れたことにはなりません。',
            }[type];
          }),
      );
  };
  $('smView').onchange = () => {
    mapView = Number($('smView').value);
    render();
    $('basicsObservation').textContent =
      '測る位置を変えました。地図はまだ増えていません。ここから測ると、棚の裏側も見えるでしょうか。';
  };
  $('smResolution').onchange = () => {
    mapResolution = Number($('smResolution').value);
    render();
    $('basicsObservation').textContent =
      '同じ測定を、違う大きさのマスに入れ直しました。大きなマスは軽く扱えますが、細い隙間や境界の表現が粗くなります。';
  };
  $('smScan').onclick = () => {
    const repeated = mapFrames.some((f) => f.view === mapView);
    if (!repeated)
      mapFrames.push({
        view: mapView,
        pose: MAPPING_POSES[mapView],
        scan: measureRoom(MAPPING_ROOM, MAPPING_POSES[mapView]),
      });
    render();
    $('basicsObservation').textContent = repeated
      ? 'この位置は測定済みです。この簡略例では同じ観測なので地図は変わりません。別の位置へ移ってみましょう。'
      : '測れた範囲を地図に加えました。灰色の場所を押して見方を確かめ、別の位置からも測ってみましょう。';
  };
  $('smReset').onclick = () => {
    mapFrames = [];
    render();
    $('basicsObservation').textContent = 'まだ何も測っていないので、地図全体が灰色です。';
  };
  render();
  $('basicsObservation').textContent = mapFrames.length
    ? '測った地図は残っています。灰色の場所や棚の裏に注目してください。'
    : '測定前は、部屋の形も棚の位置も地図には入っていません。まず周囲を測りましょう。';
  prompt(
    '「何も写っていない」と「何もない」は同じ？',
    '物に隠れた場所には、距離の点が届きません。空間の地図には「まだ分からない」を残します。',
    'ここでは位置を既知としました。実際には、その位置の見積もりがずれると地図もずれます。次は、できた地図を手がかりに位置を探します。',
  );
  $('basicsSummary').textContent =
    '占有地図では、障害物だけでなく、観測した空間と未観測の空間を区別します。';
}
function drawLocalization({ svg, robot, line, label, slider }) {
  const scene = localizationRoom(feature),
    observed = measureRoom(scene, { x: 3.7, y: 1.2, theta: 0 }, 72, 2),
    fit = localizeOnKnownMap(observed, scene),
    predicted = measureRoom(scene, { x: guess, y: 1.2, theta: 0 }, 72, 2),
    error = rangeMismatch(observed, predicted);
  $('basicsFigureStep').textContent = '先にある地図と、今測った距離を照合';
  $('basicsFigureTitle').textContent = '同じ景色の通路で、位置を一つに決められる？';
  $('basicsControls').innerHTML =
    `<p class="eyebrow">ミッション · 現在地の候補を探す</p><h2>今見えている壁の形は、地図のどの場所と合う？</h2><p>この通路の地図は、すでにあります。LiDARが今測った距離と、各候補から見えるはずの距離を比べます。</p><button id="slSearch" class="primary full">地図の中で候補を探す</button>${slider('slGuess', '自分で選ぶ位置の候補', 0.7, 7.3, 0.1, guess, ' m')}<label class="basics-check"><input type="checkbox" id="slFeature" ${feature ? 'checked' : ''}>通路に形の違う設備がある場面</label><p class="helper">この例では、通路の中央にいて右を向いていることは分かっています。調べるのは通路に沿った位置だけです。LiDARは2 m先までしか測らないので、遠くの端の壁を手がかりにはできません。候補を動かしても同じ左右の壁しか見えない場所があるか比べます。</p><details data-help-dialog><summary>自己位置推定とSLAMはどう違う？</summary><p>できている地図の中で現在地を求めるのが、この実験の自己位置推定です。地図も作りながら位置を求めるのがSLAMです。</p><p>同じ壁が続くと、進んだ方向の位置は決めにくくなります。車輪やIMUで予測を保ち、角や特徴のある場所を見たときに確かめます。測れないときに無理に一つの位置へ決めつけないことも大切です。</p></details>`;
  const s = 69,
    ox = 62,
    oy = 220;
  let body = `<rect x="${ox}" y="${oy - scene.height * s}" width="${scene.width * s}" height="${scene.height * s}" fill="#233d47" stroke="#759ba7" stroke-width="3"/>`;
  if (feature)
    body += scene.obstacles
      .map(
        (r) =>
          `<rect x="${ox + r.x * s}" y="${oy - (r.y + r.h) * s}" width="${r.w * s}" height="${r.h * s}" fill="#a3b7bd"/>`,
      )
      .join('');
  if (locationChecked)
    body += fit.plausible
      .map((c) => `<circle cx="${ox + c.x * s}" cy="${oy - 1.2 * s}" r="5" fill="#f2bf77"/>`)
      .join('');
  body +=
    robot(ox + guess * s, oy - 1.2 * s) +
    label(ox + guess * s - 42, oy - 1.2 * s - 47, '位置の候補') +
    label(ox, 245, '地図の横の位置：0 m') +
    label(ox + 8 * s - 25, 245, '8 m') +
    label(
      62,
      290,
      locationChecked
        ? `黄色：測った距離とよく合う位置の候補`
        : 'ロボットの図は、あなたが選んだ位置の候補です',
    ) +
    label(62, 322, '候補を動かしても、実際のロボットは動きません');
  $('basicsFigure').innerHTML = svg(body, '同じ距離が測れる場所の候補を地図に表示');
  const max = Math.max(0.15, ...fit.candidates.map((c) => c.error)),
    chart = `<svg viewBox="0 0 640 180" role="img" aria-label="位置の候補ごとの距離の食い違い。低いほど観測と一致"><path d="M62 40V140H620" fill="none" stroke="#a2b8be"/><polyline points="${fit.candidates.map((c) => `${62 + ((c.x - 0.7) / 6.6) * 558},${140 - (c.error / max) * 92}`).join(' ')}" fill="none" stroke="#397f74" stroke-width="3"/><line x1="${62 + ((guess - 0.7) / 6.6) * 558}" x2="${62 + ((guess - 0.7) / 6.6) * 558}" y1="40" y2="140" stroke="#c77d37" stroke-dasharray="4 4"/><g fill="#597078" font-size="13"><text x="62" y="169">0.7 m</text><text x="578" y="169">7.3 m</text><text x="62" y="22">測った距離との食い違い（cm）</text><text x="52" y="52" text-anchor="end">${(max * 100).toFixed(0)}</text><text x="52" y="144" text-anchor="end">0</text></g></svg>`;
  const points = (scan) => {
    let connected = false;
    return scan
      .map((r) => {
        if (!r.hit) {
          connected = false;
          return '';
        }
        const command = connected ? 'L' : 'M';
        connected = true;
        return `${command}${138 - r.range * Math.sin(r.a) * 43},${104 - r.range * Math.cos(r.a) * 43}`;
      })
      .join(' ');
  };
  const overlay = `<svg viewBox="0 0 640 215" role="img" aria-label="ロボットから見た距離の比較。緑はLiDARの測定、橙の破線は候補位置での予測"><rect x="28" y="4" width="220" height="202" rx="12" fill="#f2f6f5"/><circle cx="138" cy="104" r="86" fill="none" stroke="#d1dfdc"/><path d="${points(observed)}" fill="none" stroke="#397f74" stroke-width="3"/><path d="${points(predicted)}" fill="none" stroke="#c77d37" stroke-width="3" stroke-dasharray="5 4"/><path d="M138 94l-6 14h12z" fill="#263a45"/><g font-size="15"><text x="125" y="22" fill="#597078">正面</text><text x="276" y="63" fill="#397f74">緑：LiDARが今測った形</text><text x="276" y="99" fill="#a46324">橙：この候補で見えるはずの形</text><text x="276" y="145" fill="#597078">重なるほど、候補と測定が合います。</text><text x="276" y="176" fill="#597078">2 mより先は測っていません。</text></g></svg>`;
  $('basicsEvidence').hidden = false;
  $('basicsEvidence').innerHTML =
    `<h2>測った形と、予測した形を比べる</h2>${overlay}${locationChecked ? `<details><summary>すべての候補の食い違いを見る</summary>${chart}<p>横軸は通路内の位置の候補、縦軸はその候補で予測した距離と実測した距離の食い違いです。現在地そのものの誤差ではなく、距離の測定がどれだけ合うかを比べています。緑の線が低い場所ほど測定によく合います。低い場所が広く続くなら、この測定だけでは位置を一つに決められません。橙の縦線は自分で選んだ候補です。</p></details>` : ''}`;
  metrics([
    ['選んだ候補と測定の食い違い', `${fmt(error * 100, 1)} cm`],
    [
      'よく合う候補の広がり',
      locationChecked
        ? fit.plausible.length === 1
          ? `${fmt(fit.plausible[0].x)} m付近`
          : `${fmt(fit.plausible[0].x)} ～ ${fmt(fit.plausible.at(-1).x)} m`
        : '「候補を探す」で確認',
    ],
  ]);
  $('slGuess').oninput = () => {
    $('slGuessValue').textContent = $('slGuess').value + ' m';
  };
  $('slGuess').onchange = () => {
    guess = Number($('slGuess').value);
    updateLocalization(artObject());
  };
  // Re-render after the slider is released; do not replace it during a drag.
  function artObject() {
    return { svg, robot, line, label, slider };
  }
  function updateLocalization(art) {
    const focus = $('slGuess'),
      v = focus.value;
    drawLocalization(art);
    $('slGuess').value = v;
    $('slGuess').focus({ preventScroll: true });
  }
  $('slFeature').onchange = () => {
    feature = $('slFeature').checked;
    locationChecked = false;
    drawLocalization({ svg, robot, line, label, slider });
  };
  $('slSearch').onclick = () => {
    locationChecked = true;
    drawLocalization({ svg, robot, line, label, slider });
  };
  $('basicsObservation').textContent = locationChecked
    ? fit.plausible.length > 3
      ? '低い誤差で合う場所が何か所もあります。今の測定だけでは現在地を一つに決められません。設備がある場面でも試してください。'
      : '設備の形を手がかりに、候補を狭い範囲へ絞れました。地図と測った距離を照らし合わせた結果です。'
    : '位置の候補を動かして、食い違いが小さい場所を探しましょう。通路の中央では、動かしても同じように見えるかもしれません。';
  prompt(
    '計算が「合った」と言えば、位置は正しい？',
    '同じ観測と合う場所が複数あることもあります。一つの値だけでなく、どこまで候補を絞れたかを見ます。',
    '角、棚の端、別の目印などが増えると候補を区別しやすくなります。カメラの目印も手がかりにできますが、この例の照合にはLiDARだけを使っています。',
  );
  $('basicsSummary').textContent =
    '地図があっても、見える形が似ていれば位置は決めにくい。センサーの組み合わせと、周囲の特徴が大切です。';
}
function drawLoop({ svg, robot, line, label }) {
  $('basicsFigureStep').textContent = 'すでに一周した走行記録を使う実験';
  $('basicsFigureTitle').textContent = '一周したのに、出発点とつながらない';
  $('basicsControls').innerHTML =
    `<p class="eyebrow">ミッション · 一周の記録をつなぐ</p><h2>出発点へ戻った記録を使い、位置と地図を直す</h2><p>少しずつ位置がずれ、同じ出発点なのに別の位置として記録されています。最後にいた場所が出発点と同じだという情報を与え、途中の位置も計算し直します。操作の前後で、最後の点だけでなく壁の二重写りや途中の軌跡も比べます。</p><button id="scClose" class="primary full">出発点の対応から全体を調整</button><button id="scReset" class="full">調整前に戻す</button><details><summary>別の角を、同じ場所だと間違えたら？</summary><p>似た景色を取り違えた対応でも、計算はその条件を満たそうとします。戻り位置の数字が小さくなるだけで、正しいとは言えません。</p><button id="scWrong" class="full">途中の角と取り違えて計算</button></details><details data-help-dialog><summary>何を直している？</summary><p>丸い点は、センサーで測定した各時刻の推定位置です。隣り合う点の間隔は、車輪などから見積もった移動量を表します。「最後と出発点は同じ場所」という条件を追加すると、これまでの移動量とは少し食い違います。その矛盾を一か所へ押し付けず、各区間へ分けるように全体の位置を計算し直します。</p><p>食い違いを二乗して合計し、それが小さくなる答えを探す方法を最小二乗法といいます。この実験では向きは分かっているものとし、平面上の位置だけを直します。「同じ場所」の判断はボタンで与えており、自動では探しません。実用のSLAMでは、対応が正しいかを確かめ、向きも含めて調整します。</p></details>`;
  const panels = [
    { poses: fixture.before, x: 32, title: '調整前', color: '#dca36a' },
    {
      poses: loopResult?.after || fixture.before,
      x: 358,
      title: loopResult
        ? loopMatch === 0
          ? '出発点でつないだ後'
          : '別の角とつないだ後'
        : '調整後（まだ未実行）',
      color: '#8cd7c0',
    },
  ];
  let body = '';
  for (const panel of panels) {
    if (panel === panels[1] && !loopResult) {
      body +=
        label(374, 30, '調整後') +
        `<rect x="360" y="56" width="290" height="244" rx="12" fill="#233d47" stroke="#6c8995" stroke-dasharray="5 5"/>` +
        label(392, 166, 'まだ調整していません') +
        label(387, 202, 'ボタンを押して比べます');
      continue;
    }
    const s = 57,
      ox = panel.x + 25,
      oy = 290,
      point = (p) => ({ x: ox + (p.x + 0.8) * s, y: oy - (p.y + 0.8) * s });
    body +=
      label(panel.x + 10, 30, panel.title) +
      `<defs><clipPath id="${panel.x === 32 ? 'loopBefore' : 'loopAfter'}"><rect x="${panel.x}" y="45" width="310" height="268"/></clipPath></defs><g clip-path="${panel.x === 32 ? 'url(#loopBefore)' : 'url(#loopAfter)'}">`;
    fixture.scans.forEach((scan, i) => {
      const p = panel.poses[i];
      for (const ray of scan.filter((_, j) => j % 2 === 0)) {
        if (!ray.hit) continue;
        const q = point({
          x: p.x + ray.range * Math.cos(ray.a),
          y: p.y + ray.range * Math.sin(ray.a),
        });
        body += `<circle cx="${q.x}" cy="${q.y}" r="1.2" fill="#77949f" opacity=".65"/>`;
      }
    });
    body += '</g>';
    body +=
      `<polyline points="${panel.poses
        .map((p) => {
          const q = point(p);
          return q.x + ',' + q.y;
        })
        .join(' ')}" fill="none" stroke="${panel.color}" stroke-width="2.5"/>` +
      panel.poses
        .map((p, i) => {
          const q = point(p);
          return (
            `<circle cx="${q.x}" cy="${q.y}" r="4" fill="${panel.color}"/>` +
            (i === 0
              ? label(q.x - 22, q.y + 30, '出発点')
              : i === panel.poses.length - 1
                ? label(q.x + 10, q.y, '最後')
                : '')
          );
        })
        .join('');
    if (panel === panels[0]) {
      const a = point(panel.poses[0]),
        b = point(panel.poses.at(-1));
      body += line(a.x, a.y, b.x, b.y, '#f4cb86', 'stroke-dasharray="4 4"');
    }
    if (panel === panels[1] && loopResult) {
      const end = point(panel.poses.at(-1)),
        start = point(panel.poses[loopMatch]);
      body += line(end.x, end.y, start.x, start.y, '#f4cb86', 'stroke-width="4"');
    }
  }
  body += label(30, 342, '点群：測った壁　　丸：各時刻の位置　　線：移動のつながり');
  $('basicsFigure').innerHTML = svg(
    body,
    '一周の軌跡と測った地図を、位置のつながりから調整する前後の図',
  );
  const initial = Math.hypot(fixture.before.at(-1).x, fixture.before.at(-1).y);
  metrics([
    [
      '同じ場所と指定した2点のずれ',
      loopResult
        ? `${fmt(loopResult.gap * 100, 1)} cm`
        : `出発点と最後 ${fmt(initial * 100, 1)} cm`,
    ],
    [
      '測った移動量からの変更（1区間あたり）',
      loopResult ? `${fmt(loopResult.moveResidual * 100, 1)} cm` : 'まだ調整していません',
    ],
  ]);
  $('scClose').onclick = () => {
    loopMatch = 0;
    loopResult = closeLoop(fixture, 0);
    drawLoop({ svg, robot, line, label });
  };
  $('scWrong').onclick = () => {
    loopMatch = 4;
    loopResult = closeLoop(fixture, 4);
    drawLoop({ svg, robot, line, label });
  };
  $('scReset').onclick = () => {
    loopResult = null;
    loopMatch = 0;
    drawLoop({ svg, robot, line, label });
  };
  $('basicsObservation').textContent = !loopResult
    ? '最後の位置だけでなく、壁の点が二重になっている場所にも注目します。全体を調整するとどうなるでしょうか。'
    : loopMatch === 0
      ? '出発点との対応を加え、途中の位置と、そこに置く壁の点も調整しました。この全体の修正をループ閉じ込みと呼びます。'
      : '指定した2点は近づきましたが、途中の移動が大きく変わり、地図が崩れました。「同じ場所」の対応が正しいか確認する必要があります。';
  prompt(
    '「戻り位置のずれが小さい」だけで、成功？',
    '途中の軌跡や地図の形も確認しましょう。間違った対応に合わせても、指定した2点のずれは小さくできます。',
    '同じ場所との対応を見つけ、確認して、過去の位置と地図を調整するのが一連の流れです。次の総合実験では、同じ走行データでセンサーを変えて比較します。',
  );
  $('basicsSummary').textContent =
    'SLAMは、移動の予測と周囲の照合を繰り返します。戻った場所の対応は、過去も含めたずれを直す手がかりになります。';
}

export { SLAM_TOPICS, SLAM_GROUPS, renderSlamConcept };
