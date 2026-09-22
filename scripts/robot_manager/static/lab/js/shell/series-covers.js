import { loadJson } from '../core/content.js';
import { escapeHtml } from './html-escape.js';

// Cover illustration of every course on the catalogue page. The same robot identifies the
// hardware in each picture; the composition shows what that course's experiment is about.
// Inline SVG keeps the catalogue sharp and available without extra files. Each cover's title and
// description (read by assistive technology) live in content/shell/covers.json.

const COVER_WIDTH = 600; // SVG user units
const COVER_HEIGHT = 280;

const copy = await loadJson('content/shell/covers.json');

const COLOR = {
  bg: '#1c323e',
  panel: '#263f4c',
  line: '#66828e',
  ink: '#e2eef0',
  muted: '#a8c0c9',
  mint: '#96dcc5',
  blue: '#98bee9',
  gold: '#ebc27c',
  red: '#e69a89',
  box: '#c78459',
};

// SVG primitives. Defaults are the catalogue's usual stroke and fill so the drawings stay terse.
const text = (x, y, label, color = COLOR.ink, size = 21, anchor = 'start') =>
  `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" text-anchor="${anchor}">${escapeHtml(label)}</text>`;
const path = (d, color = COLOR.line, width = 2, dash = '', extra = '') =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" ${dash ? `stroke-dasharray="${dash}"` : ''} ${extra}/>`;
const rect = (x, y, width, height, fill = COLOR.panel, radius = 8, stroke = 'none') =>
  `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
const circle = (x, y, radius, fill = 'none', stroke = COLOR.line, width = 2) =>
  `<circle cx="${x}" cy="${y}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${width}"/>`;
const ellipse = (x, y, radiusX, radiusY, fill, stroke = 'none') =>
  `<ellipse cx="${x}" cy="${y}" rx="${radiusX}" ry="${radiusY}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;

const ARROW_HEAD_LENGTH = 10; // user units
const ARROW_HEAD_ANGLE = 0.5; // radians between the shaft and each side of the head

function arrow(fromX, fromY, toX, toY, color = COLOR.mint, width = 3, dash = '') {
  const angle = Math.atan2(toY - fromY, toX - fromX);
  const side = (turn) =>
    `${toX - ARROW_HEAD_LENGTH * Math.cos(angle + turn)} ${toY - ARROW_HEAD_LENGTH * Math.sin(angle + turn)}`;
  const shaft = path(`M${fromX} ${fromY}L${toX} ${toY}`, color, width, dash);
  const head = path(
    `M${side(-ARROW_HEAD_ANGLE)}L${toX} ${toY}L${side(ARROW_HEAD_ANGLE)}`,
    color,
    width,
  );
  return shaft + head;
}

// Recurring props: the cargo box, the robot seen from above and from the side, the wheel bench,
// the SO-ARM101 arm, a goal marker and a cart.
function crate(x, y, scale = 1, color = COLOR.box) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><path d="M-23-15L0-27 25-15 2-2Z" fill="#e3a474"/><path d="M-23-15L2-2V27L-23 13Z" fill="${color}"/><path d="M2-2L25-15V13L2 27Z" fill="#9e6349"/>${path('M-10-21L15-8V7', '#f1cf9a', 5)}</g>`;
}
function topRobot(x, y, heading = 0, scale = 1, opacity = 1) {
  const wheelTreads = [-14, 0, 14]
    .map((offset) => path(`M${offset}-31v8M${offset} 23v8`, '#4c6875', 2))
    .join('');
  return `<g transform="translate(${x} ${y}) rotate(${heading}) scale(${scale})" opacity="${opacity}">${ellipse(0, 6, 39, 30, '#10232b99')}${rect(-21, -33, 42, 12, '#10232b', 4, '#809ba6')}${rect(-21, 21, 42, 12, '#10232b', 4, '#809ba6')}${wheelTreads}${rect(-33, -23, 66, 46, '#cbdcde', 13, '#e3edf0')}${rect(-24, -16, 42, 32, '#304f5d', 10)}${circle(-3, 0, 11, '#1c3540', COLOR.mint, 3)}${circle(-3, 0, 3, COLOR.mint, 'none')}${rect(23, -14, 10, 28, '#254a61', 5)}${circle(28, -7, 3, '#aee0ff', 'none')}${circle(28, 7, 3, '#aee0ff', 'none')}${rect(-27, -16, 4, 13, '#eb934b', 2)}</g>`;
}
function sideRobot(x, y, scale = 1, opacity = 1, carriesLoad = false) {
  const load = carriesLoad ? crate(3, -88, 0.66) : '';
  return `<g transform="translate(${x} ${y}) scale(${scale})" opacity="${opacity}">${ellipse(0, 2, 52, 7, '#112731aa')}${rect(-43, -55, 85, 34, '#cbdcde', 11)}${rect(-32, -46, 49, 10, '#3b5966', 4)}${rect(-24, -66, 27, 12, '#62818d', 5)}${ellipse(-10, -66, 13, 4, '#9ac4c9')}${rect(33, -53, 18, 14, '#2a5064', 5)}${circle(46, -46, 3, '#aee0ff', 'none')}${circle(-20, -20, 20, '#142c38', '#94adb6', 4)}${circle(-20, -20, 8, '#526f7c', 'none')}${path('M-20-34v7', COLOR.mint, 3)}${circle(30, -8, 8, '#142c38', '#94adb6', 3)}${load}</g>`;
}
function wheelBench(x, y) {
  return `<g transform="translate(${x} ${y})">${path('M-66 61H63', COLOR.line, 3)}${rect(-49, 15, 13, 44, '#516f7b', 2)}${rect(39, 15, 13, 44, '#516f7b', 2)}${rect(-60, 9, 121, 9, '#8ba5af', 3)}${rect(-56, -50, 115, 39, '#cbdcde', 10)}${rect(42, -44, 25, 16, '#31556a', 5)}${circle(57, -37, 4, COLOR.blue, 'none')}${circle(-3, 8, 31, '#132b35', '#93aab2', 4)}${circle(-3, 8, 20, '#395963', 'none')}${path('M-3 8L14-6', COLOR.mint, 5)}${circle(-3, 8, 6, '#cbdcde', 'none')}</g>`;
}
// The other elbow position that reaches the same tip: the elbow mirrored across the base–tip line.
function mirrorElbow(base, elbow, tip) {
  const dx = tip[0] - base[0];
  const dy = tip[1] - base[1];
  const along = ((elbow[0] - base[0]) * dx + (elbow[1] - base[1]) * dy) / (dx * dx + dy * dy);
  return [2 * (base[0] + along * dx) - elbow[0], 2 * (base[1] + along * dy) - elbow[1]];
}
function arm(base, elbow, tip, color = COLOR.mint, opacity = 1) {
  const joints = [base, elbow, tip]
    .map(([x, y]) => circle(x, y, 8, COLOR.bg, '#d0e3e6', 3))
    .join('');
  const gripper = path(`M${tip[0]} ${tip[1]}l13 0m0-11v22m0-22h13m-13 22h13`, COLOR.ink, 4);
  return `<g opacity="${opacity}">${path(`M${base[0]} ${base[1]}L${elbow[0]} ${elbow[1]}`, color, 13)}${path(`M${elbow[0]} ${elbow[1]}L${tip[0]} ${tip[1]}`, COLOR.blue, 11)}${joints}${gripper}</g>`;
}
function goal(x, y, radius = 19) {
  return circle(x, y, radius, '#e9c78412', COLOR.gold, 2) + circle(x, y, 5, COLOR.gold, 'none');
}
function cart(x, y, opacity = 1, outline = false) {
  const bodyFill = outline ? 'none' : '#94a8b5';
  const bodyStroke = outline ? COLOR.gold : '#c6d4db';
  const wheelFill = outline ? 'none' : '#132b35';
  const wheelStroke = outline ? COLOR.gold : 'none';
  const wheel = (wheelX, wheelY) => rect(wheelX, wheelY, 12, 8, wheelFill, 2, wheelStroke);
  const load = outline ? '' : rect(-19, -12, 38, 24, '#b98761', 3);
  return `<g transform="translate(${x} ${y})" opacity="${opacity}">${rect(-30, -22, 60, 44, bodyFill, 5, bodyStroke)}${wheel(-23, -30)}${wheel(12, -30)}${wheel(-23, 22)}${wheel(12, 22)}${load}</g>`;
}

// One drawing per course id, in the shared coordinate space (COVER_WIDTH × COVER_HEIGHT).
const DRAWINGS = {
  mechanics: () =>
    rect(30, 67, 242, 180, '#23403f', 14) +
    rect(328, 67, 242, 180, '#35403f', 14) +
    text(151, 99, '出力 50 %', COLOR.mint, 22, 'middle') +
    text(450, 99, '出力 0 %', COLOR.gold, 22, 'middle') +
    path('M49 216H254M346 216H552', COLOR.line, 2) +
    sideRobot(138, 212, 1.02) +
    sideRobot(411, 212, 1.02) +
    arrow(178, 180, 238, 180, COLOR.mint) +
    path('M475 168l16 12-16 12m24-24l16 12-16 12', COLOR.gold, 3) +
    arrow(280, 156, 320, 156, COLOR.muted, 2) +
    text(300, 132, '3秒後', COLOR.muted, 18, 'middle'),
  control: () =>
    wheelBench(133, 162) +
    path('M278 211H552M280 211V86', COLOR.line, 2) +
    path('M283 126H550', COLOR.gold, 2, '6 6') +
    text(550, 99, '目標 60 rpm', COLOR.gold, 21, 'end') +
    path('M286 205C320 205 318 98 355 112S400 145 425 127 470 127 548 126', COLOR.mint, 4) +
    text(451, 178, '測った速さ', COLOR.mint, 20, 'middle') +
    arrow(185, 116, 253, 116, COLOR.blue, 2) +
    path('M435 226Q435 252 278 252H134V239', COLOR.blue, 2) +
    path('M126 246l8-8 8 8', COLOR.blue, 2) +
    text(298, 241, '測って調整', COLOR.blue, 18, 'middle'),
  launch: () =>
    path('M37 231H565', COLOR.line, 2) +
    sideRobot(111, 225, 1.04) +
    rect(143, 134, 12, 36, '#829aa5', 2) +
    rect(99, 125, 88, 10, '#a9bcc5', 3) +
    circle(151, 120, 15, '#466575', COLOR.blue, 3) +
    path('M115 138H188', COLOR.line, 3) +
    path('M185 130Q310 130 365 230', COLOR.line, 2, '5 7') +
    path('M185 130Q355 98 501 230', COLOR.mint, 3) +
    path('M185 130Q392 71 551 230', COLOR.line, 2, '5 7') +
    ellipse(338, 139, 30, 5, COLOR.gold, '#f4d9a3') +
    rect(308, 139, 60, 5, COLOR.gold, 2) +
    ellipse(501, 230, 33, 9, '#e8c27a12', COLOR.gold) +
    ellipse(501, 230, 15, 4, 'none', COLOR.gold) +
    text(342, 95, '横向きのディスク', COLOR.ink, 20, 'middle') +
    path('M188 253H501M188 248v10M501 248v10', COLOR.line, 2) +
    text(345, 251, '飛距離', COLOR.muted, 18, 'middle'),
  arm: () =>
    path('M63 248H543', COLOR.line, 2) +
    rect(128, 194, 94, 54, '#617f8b', 5) +
    arm([172, 194], mirrorElbow([172, 194], [251, 95], [404, 126]), [404, 126], COLOR.mint, 0.23) +
    arm([172, 194], [251, 95], [404, 126]) +
    path('M207 194A35 35 0 0 0 194 167', COLOR.gold, 3) +
    text(218, 210, '角度', COLOR.gold, 20) +
    goal(443, 126, 23) +
    text(410, 75, '手先の位置', COLOR.ink, 21, 'middle') +
    path('M418 81L439 97', COLOR.line, 2),
  vision: () => {
    const rgb =
      rect(186, 70, 167, 166, '#70808a', 9) +
      path('M194 202L271 125 345 198M271 125V77', '#a4b0b566', 1) +
      crate(310, 138, 0.63, '#638ca9') +
      crate(244, 182, 1) +
      rect(214, 148, 62, 68, 'none', 3, COLOR.mint);
    const depth =
      rect(382, 70, 167, 166, '#1b2949', 9) +
      path('M390 202L467 125 541 198M467 125V77', '#426caa', 1) +
      rect(481, 118, 31, 39, '#557dcc', 3) +
      rect(410, 153, 48, 58, '#8bdac8', 3) +
      rect(407, 148, 55, 68, 'none', 3, '#d3f4e6');
    return (
      path('M128 160H169M159 160V59H466', COLOR.blue, 2) +
      circle(159, 160, 3, COLOR.blue, 'none') +
      arrow(169, 160, 181, 160, COLOR.blue, 2) +
      arrow(466, 59, 466, 69, COLOR.blue, 2) +
      topRobot(94, 162, 0, 1.05) +
      rgb +
      depth +
      text(91, 230, 'カメラ', COLOR.muted, 19, 'middle') +
      text(269, 259, '色', COLOR.ink, 21, 'middle') +
      text(466, 259, '奥行き', COLOR.blue, 21, 'middle')
    );
  },
  slam: () => {
    const hits = [
      [95, 99],
      [128, 79],
      [192, 79],
      [280, 79],
      [359, 79],
      [384, 121],
      [384, 145],
      [525, 166],
      [525, 225],
      [439, 225],
      [430, 146],
    ];
    return (
      path('M95 145V79H525V225H371M261 225H95V199', '#8aabb5', 6) +
      rect(384, 115, 66, 31, '#557582', 3) +
      path('M118 210Q153 177 176 201T249 178', COLOR.mint, 3, '5 5') +
      hits
        .map(
          ([x, y]) =>
            path(`M263 169L${x} ${y}`, '#6595a355', 1.5) + circle(x, y, 3, COLOR.blue, 'none'),
        )
        .join('') +
      topRobot(263, 169, -32, 0.9) +
      circle(263, 169, 47, 'none', '#96dcc554', 2) +
      text(383, 61, '壁の地図', COLOR.blue, 20) +
      text(172, 257, '自分の位置', COLOR.mint, 20) +
      path('M232 242L255 207', COLOR.mint, 2)
    );
  },
  tracking: () =>
    rect(40, 83, 520, 94, '#bacad010', 7) +
    path('M40 83H560M40 177H560', COLOR.line, 1) +
    path('M299 225L428 129', COLOR.blue, 2, '4 6') +
    topRobot(299, 234, -90, 0.85) +
    topRobot(430, 130, 180, 0.92) +
    circle(430, 130, 5, COLOR.blue, '#c6dfff', 2) +
    arrow(383, 130, 324, 130, COLOR.muted, 3) +
    circle(273, 130, 33, 'none', COLOR.gold, 2) +
    path('M297 130H377', COLOR.gold, 2, '4 5') +
    text(432, 61, '相手のロボット', COLOR.ink, 19, 'middle') +
    text(272, 61, '1秒先の予測', COLOR.gold, 19, 'middle') +
    text(382, 247, 'QUESTiX', COLOR.mint, 19),
  timing: () =>
    path('M45 223H562', COLOR.line, 2) +
    rect(540, 112, 15, 111, '#6b8592', 3) +
    topRobot(110, 190, 0, 0.85, 0.38) +
    topRobot(458, 190, 0, 0.85) +
    path('M158 176L535 176', COLOR.blue, 2, '3 7') +
    path('M149 135Q200 89 253 126M347 126Q399 89 452 135', COLOR.blue, 2, '5 6') +
    circle(300, 120, 36, '#263f4d', COLOR.blue, 3) +
    path('M300 97V121L317 133', COLOR.ink, 3) +
    rect(196, 103, 19, 13, COLOR.blue, 2) +
    rect(387, 103, 19, 13, COLOR.blue, 2) +
    text(112, 87, '測った時', COLOR.muted, 22, 'middle') +
    text(465, 87, '届いた時', COLOR.ink, 22, 'middle') +
    rect(225, 163, 150, 30, COLOR.bg, 5) +
    text(300, 187, '情報の遅れ', COLOR.blue, 20, 'middle') +
    path('M137 249H484M137 244v10M484 244v10', COLOR.mint, 2) +
    text(306, 242, 'その間も進む', COLOR.mint, 19, 'middle'),
  planning: () =>
    rect(50, 66, 503, 180, '#233e49', 9) +
    rect(248, 118, 139, 106, '#ebc27c12', 15, '#b38c5155') +
    rect(270, 140, 95, 63, '#5d7583', 5) +
    path('M148 194H264', COLOR.red, 2, '5 6') +
    path('M247 185l17 17m0-17l-17 17', COLOR.red, 3) +
    path('M119 190V93Q119 82 132 82H486Q515 82 515 113V188', COLOR.mint, 5) +
    topRobot(119, 195, -90, 0.85) +
    goal(514, 197, 22) +
    text(321, 176, '棚', '#d3e0e5', 20, 'middle') +
    text(475, 65, '目的地', COLOR.gold, 20, 'middle'),
  coordination: () =>
    path('M36 239H562', COLOR.line, 2) +
    rect(405, 181, 120, 10, '#8098a3', 3) +
    rect(419, 191, 9, 47, '#546f7c', 2) +
    rect(504, 191, 9, 47, '#546f7c', 2) +
    crate(465, 151, 1.1) +
    rect(433, 114, 64, 68, 'none', 4, COLOR.gold) +
    sideRobot(128, 234, 1.22) +
    arm([125, 168], [219, 79], [387, 126]) +
    path('M177 179L433 114M177 179L433 182', '#98bee96b', 2, '4 5') +
    arrow(177, 179, 230, 179, COLOR.blue, 2) +
    arrow(177, 179, 177, 146, COLOR.blue, 2) +
    arrow(125, 168, 162, 168, COLOR.mint, 2) +
    arrow(125, 168, 125, 135, COLOR.mint, 2) +
    text(310, 70, '手を伸ばす', COLOR.mint, 21, 'middle') +
    text(461, 96, '見つける', COLOR.gold, 20, 'middle'),
  behavior: () =>
    rect(30, 76, 155, 165, '#263f4c', 12) +
    rect(224, 76, 155, 165, '#24453f', 12) +
    rect(418, 76, 155, 165, '#3a403c', 12) +
    text(108, 106, '受け取る', COLOR.blue, 21, 'middle') +
    text(302, 106, '運ぶ', COLOR.mint, 21, 'middle') +
    text(496, 106, '届ける', COLOR.gold, 21, 'middle') +
    crate(110, 149, 0.7) +
    topRobot(104, 206, -90, 0.62) +
    topRobot(301, 177, 0, 0.85) +
    crate(296, 172, 0.47) +
    rect(463, 155, 69, 44, '#4c6268', 5) +
    crate(499, 158, 0.75) +
    topRobot(454, 219, -30, 0.53) +
    arrow(192, 163, 214, 163, COLOR.muted, 2) +
    arrow(386, 163, 408, 163, COLOR.muted, 2),
  diagnostics: () =>
    path('M49 229H559', COLOR.line, 2) +
    rect(425, 105, 20, 124, '#997861', 3) +
    path('M271 181L425 110M271 181L425 151M271 181L425 209', COLOR.gold, 2, '4 5') +
    circle(425, 151, 4, COLOR.gold, 'none') +
    circle(425, 110, 4, COLOR.gold, 'none') +
    circle(425, 209, 4, COLOR.gold, 'none') +
    topRobot(239, 183, 0, 1.08) +
    path('M133 98L153 132H113Z', COLOR.gold, 3) +
    text(133, 125, '!', COLOR.gold, 21, 'middle') +
    circle(489, 191, 33, '#713f3e', '#e7a191', 3) +
    rect(478, 180, 22, 22, '#f1d7cf', 3) +
    text(487, 249, '停止', COLOR.red, 22, 'middle') +
    text(268, 90, '異常を検知', COLOR.gold, 21, 'middle') +
    path('M92 224H135', COLOR.line, 2, '3 6'),
  rl: () =>
    rect(31, 76, 244, 172, '#2c3c49', 10) +
    rect(325, 76, 244, 172, '#25463f', 10) +
    text(65, 103, '学習前', COLOR.muted, 20) +
    text(359, 103, '学習後', COLOR.mint, 20) +
    rect(153, 150, 48, 56, '#647882', 4) +
    rect(448, 150, 48, 56, '#647882', 4) +
    goal(231, 125, 16) +
    goal(527, 125, 26) +
    path('M71 218Q82 168 98 199T139 179', COLOR.red, 3, '4 5') +
    topRobot(134, 187, 0, 0.6) +
    circle(205, 223, 17, '#764b47', 'none') +
    text(205, 230, '−1', '#f4d3ca', 18, 'middle') +
    path('M364 221V143Q364 124 383 124H502', COLOR.mint, 4) +
    topRobot(527, 125, 0, 0.6) +
    rect(460, 209, 79, 30, '#386952', 15) +
    text(499, 231, '+10', COLOR.mint, 22, 'middle') +
    arrow(285, 170, 315, 170, COLOR.muted, 2),
};

function seriesCover(id, elementId = 'series-cover-' + id) {
  const draw = DRAWINGS[id];
  if (!draw) throw new Error('Missing course illustration: ' + id);
  const { title, description } = copy[id];
  const prefix = 'cover-' + id;
  return `<svg id="${escapeHtml(elementId)}" data-series-illustration="${id}" viewBox="0 0 ${COVER_WIDTH} ${COVER_HEIGHT}" role="img" aria-labelledby="${prefix}-title" aria-describedby="${prefix}-description" xmlns="http://www.w3.org/2000/svg"><title id="${prefix}-title">${escapeHtml(title)}</title><desc id="${prefix}-description">${escapeHtml(description)}</desc><rect width="${COVER_WIDTH}" height="${COVER_HEIGHT}" fill="${COLOR.bg}"/><g font-family="system-ui, sans-serif" font-weight="500">${draw()}</g></svg>`;
}

export { seriesCover };
