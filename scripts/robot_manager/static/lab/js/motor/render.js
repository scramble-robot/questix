import { html, svg } from '../vendor/lit-html.js';
import { roleStyle } from '../core/palette.js';
import { questixSideSvg, questixSideLayout } from '../core/questix-art.js';
import { coilStates, coilPoles, transmissionValues } from './core.js';

// Figures of the motor course as lit SVG templates, drawn from plain data handed in by ui.js / view.js.
// Each figure has its own small viewBox, so its few labels (pole letters, numbered markers) stay
// at 12 px or more on a 390 px phone; the words that explain a figure are an HTML key next to it
// (view.js). Colours of what is measured or aimed at come from js/core/palette.js; the copper,
// iron and magnet colours are the parts' own.

const INK = '#294a58';
const GUIDE = '#68838d';
const BACKGROUND = '#e5eef1';
const COPPER_BACK = '#925635';
const COPPER_FRONT = '#b9713e';
const COPPER_SHINE = '#edb780';
const IRON = '#9aaeb8';
const IRON_EDGE = '#5f7885';
const NORTH = '#b95849'; // red end of a magnet, labelled N
const SOUTH = '#467da7'; // blue end, labelled S
const ARROW = '#287b6c';
const MARKER_RADIUS = 15; // user units; the markers' numbers are MARKER_TEXT units high
const MARKER_TEXT = 19;
const POLE_TEXT = 20;

const DEGREES = Math.PI / 180;
const fixed = (value) => Number(value.toFixed(2));

const line = (x1, y1, x2, y2, color = GUIDE, width = 2, dash = '') =>
  svg`<path d=${`M${fixed(x1)} ${fixed(y1)}L${fixed(x2)} ${fixed(y2)}`} fill="none" stroke=${color} stroke-width=${width} stroke-dasharray=${dash || 'none'} stroke-linecap="round"/>`;
const circle = (x, y, r, fill = 'none', stroke = GUIDE, width = 2) =>
  svg`<circle cx=${fixed(x)} cy=${fixed(y)} r=${r} fill=${fill} stroke=${stroke} stroke-width=${width}/>`;
const box = (x, y, width, height, fill = '#fff', stroke = '#bed0d5') =>
  svg`<rect x=${x} y=${y} width=${width} height=${height} rx="9" fill=${fill} stroke=${stroke}/>`;
const label = (x, y, text, { size = 18, fill = INK, anchor = 'middle', weight = 600 } = {}) =>
  svg`<text x=${fixed(x)} y=${fixed(y)} fill=${fill} font-size=${size} font-weight=${weight} text-anchor=${anchor} dominant-baseline="central">${text}</text>`;

// A numbered marker that the HTML key under the figure explains, with an optional leader line.
// `scale` enlarges it in the wide gear figure, which a phone shrinks the most.
function marker(number, x, y, leader = null, scale = 1) {
  return svg`${leader ? line(x, y, leader[0], leader[1], INK, 1.5) : ''}${circle(x, y, MARKER_RADIUS * scale, '#fff', INK, 2)}${label(x, y + scale, number, { size: MARKER_TEXT * scale, weight: 700 })}`;
}

function figure(viewBox, ariaLabel, body, className = '') {
  const [x, y, width, height] = viewBox.split(' ').map(Number);
  return html`<svg
    class=${`motor-figure ${className}`}
    viewBox=${viewBox}
    role="img"
    aria-label=${ariaLabel}
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x=${x} y=${y} width=${width} height=${height} fill=${BACKGROUND} />
    <g font-family="system-ui, sans-serif">${body}</g>
  </svg>`;
}

// --- Parts shared by the figures ---------------------------------------------------------------

// Copper wire wound on an iron core; rear arcs are drawn before the core, front arcs over it.
function woundCoil() {
  const turns = [-25, -15, -5, 5, 15, 25];
  const back = turns.map(
    (x) =>
      svg`<path d=${`M${x} -22C${x - 10} -22 ${x - 10} 22 ${x} 22`} fill="none" stroke=${COPPER_BACK} stroke-width="4"/>`,
  );
  const front = turns
    .slice(0, -1)
    .map(
      (x) =>
        svg`<path d=${`M${x} 22C${x + 12} 22 ${x + 18} -22 ${x + 10} -22`} fill="none" stroke=${COPPER_FRONT} stroke-width="5"/><path d=${`M${x + 2} 18C${x + 11} 14 ${x + 13} -14 ${x + 10} -18`} fill="none" stroke=${COPPER_SHINE} stroke-width="1.5"/>`,
    );
  return svg`${back}<rect x="-43" y="-12" width="86" height="24" rx="4" fill=${IRON} stroke=${IRON_EDGE}/>${line(-37, -7, 36, -7, '#d1dce0', 3)}${front}${line(-25, -22, -43, -32, COPPER_FRONT, 3)}${line(25, 22, 43, 32, COPPER_FRONT, 3)}`;
}

// A small motor seen at an angle, its shaft turned by `angle` degrees.
function motorBody(x, y, angle) {
  const bolts = [45, 135, 225, 315].map((a) =>
    circle(35 * Math.cos(a * DEGREES), 35 * Math.sin(a * DEGREES), 3, '#405660', '#405660'),
  );
  const fins = [-28, -14, 0, 14, 28].map((finY) =>
    line(-88, finY - 40, -29, finY - 11, '#b8c7ce', 3),
  );
  return svg`<g transform=${`translate(${x} ${y})`}>${line(-91, -45, -126, -61, '#b15b40', 4)}${line(-91, -35, -128, -41, '#364952', 4)}<path d="M-80-84L0-44A44 44 0 0 1 0 44L-80 4A44 44 0 0 1-80-84Z" fill="#81969f" stroke="#4e6672" stroke-width="2"/>${fins}<path d="M-66 20L-8 49L-8 59L-74 26Z" fill="#506b78"/>${circle(0, 0, 44, '#b8c8ce', '#4e6672', 3)}${circle(0, 0, 27, '#435b66', '#829ba5', 2)}${bolts}<g transform=${`rotate(${fixed(angle)})`}>${circle(0, 0, 13, '#bd7b49', '#895937', 2)}${line(0, 0, 11, 0, '#fff', 3)}</g></g>`;
}

const shaft = (x1, y1, x2, y2) =>
  svg`${line(x1, y1, x2, y2, '#667b86', 12)}${line(x1, y1 - 2, x2, y2 - 2, '#bdcbd2', 6)}`;

// --- Structure: outside, inside, one coil --------------------------------------------------------

function exteriorFigure(ariaLabel) {
  const body = svg`${motorBody(150, 120, 0)}${shaft(150, 120, 330, 215)}${line(405, 282, 352, 245, ARROW, 4)}<path d="M346 241l15 1-6 13z" fill=${ARROW}/>${marker('①', 34, 214, [66, 150])}${marker('②', 268, 250, [270, 186])}${marker('③', 398, 248)}`;
  return figure('0 0 430 300', ariaLabel, body, 'motor-figure-exterior');
}

const SECTION_CENTRE = 220;
const COIL_OFFSET = 123;
const POLE_BADGE_OFFSET = 90;

function sectionCoil(coil) {
  const rad = coil.degrees * DEGREES;
  const glow = coil.on
    ? svg`<g opacity=${coil.strength.toFixed(2)}><rect x="-45" y="-27" width="90" height="54" rx="9" fill="#f7ce8d" stroke="#cc8a34" stroke-width="3"/></g>`
    : '';
  const badgeX = SECTION_CENTRE + POLE_BADGE_OFFSET * Math.cos(rad);
  const badgeY = SECTION_CENTRE - POLE_BADGE_OFFSET * Math.sin(rad);
  const badge = coil.on
    ? svg`${circle(badgeX, badgeY, 15, coil.pole === 'N' ? NORTH : SOUTH, '#fff', 1.5)}${label(badgeX, badgeY + 1, coil.pole, { size: 19, fill: '#fff', weight: 700 })}`
    : '';
  return svg`<g transform=${`translate(${SECTION_CENTRE} ${SECTION_CENTRE}) rotate(${-coil.degrees})`}><g transform=${`translate(${COIL_OFFSET} 0)`}>${glow}${woundCoil()}</g></g>${badge}`;
}

// The motor seen from the end of its shaft: fixed case and coils, the magnet and shaft turning by
// `angle` radians; `field` is the direction the coils pull towards when `powered`.
function motorSection({ angle, field, powered }, ariaLabel) {
  const c = SECTION_CENTRE;
  const coils = coilStates(field, powered).map(sectionCoil);
  const rotor = svg`<g transform=${`translate(${c} ${c}) rotate(${fixed(-angle / DEGREES)})`}><rect x="-66" y="-19" width="66" height="38" rx="9" fill=${SOUTH} stroke="#355f81"/><rect x="0" y="-19" width="66" height="38" rx="9" fill=${NORTH} stroke="#964c3d"/></g>`;
  const letters = svg`${label(c - 44 * Math.cos(angle), c + 44 * Math.sin(angle), 'S', { size: POLE_TEXT, fill: '#fff', weight: 700 })}${label(c + 44 * Math.cos(angle), c - 44 * Math.sin(angle), 'N', { size: POLE_TEXT, fill: '#fff', weight: 700 })}`;
  const body = svg`${circle(c, c, 167, '#d5e1e5', '#58727f', 3)}${circle(c, c, 153, '#eef3f5', '#acbfc7', 2)}${coils}${rotor}${letters}${circle(c, c, 14, '#adbec6', '#4b6877', 3)}${circle(c, c, 6, '#365565', '#365565')}`;
  return figure('44 44 352 352', ariaLabel, body, 'motor-figure-section');
}

function coilCloseup(current, copy, ariaLabel) {
  const poles = coilPoles(current);
  const wire = current ? '#bd7b45' : '#889da6';
  const poleLabel = (x, pole) =>
    label(x, 132, pole, { size: 26, fill: pole === 'N' ? '#a74b3f' : '#356e98', weight: 800 });
  const body = svg`<path d="M114 66H36V282H150M286 194H364V282H250" fill="none" stroke=${wire} stroke-width="5"/><g transform="translate(200 130) scale(2)">${woundCoil()}</g>${poles ? svg`${poleLabel(90, poles.left)}${poleLabel(310, poles.right)}` : ''}${box(150, 252, 100, 58, '#fff', '#7e97a2')}${label(200, 270, copy.label, { size: 18 })}${label(200, 294, current ? copy.on : copy.off, { size: 16, fill: current ? ARROW : '#617781' })}${marker('①', 200, 30, [200, 80])}${marker('②', 262, 214, [246, 146])}${marker('③', 118, 281)}`;
  return figure('0 0 400 320', ariaLabel, body, 'motor-figure-coil');
}

// --- Rotating shaft (load, ESC) ------------------------------------------------------------------

const SLOW_DOWN = { load: 20, esc: 80 }; // the drawing turns this many times slower than the motor

function rotorFigure({ angle, topic, boxTitle, boxValue }, ariaLabel) {
  const shown = (angle / DEGREES / SLOW_DOWN[topic]) % 360;
  const wires = [0, 1, 2].map((index) =>
    line(146, 96 + index * 17, 214, 96 + index * 17, COPPER_FRONT, 4),
  );
  const spokes = svg`${line(300, 113, 344, 113, ARROW, 8)}${line(300, 113, 278, 151, ARROW, 8)}${line(300, 113, 278, 75, ARROW, 8)}`;
  const body = svg`${box(14, 68, 132, 96)}${label(80, 100, boxTitle, { size: 20 })}${label(80, 134, boxValue, { size: 22, weight: 700 })}${wires}${circle(300, 113, 90, '#364950', '#6e8891', 4)}${circle(300, 113, 60, BACKGROUND, '#b4c8ce', 3)}<g transform=${`rotate(${fixed(-shown)} 300 113)`}>${spokes}</g>${circle(300, 113, 12, '#273d45', '#273d45')}`;
  return figure('0 10 400 210', ariaLabel, body, 'motor-figure-rotor');
}

// --- Servo: the feed arm seen from above ---------------------------------------------------------

const PIVOT = [190, 205];
const ARM = 140;

function armEnd(degrees, length) {
  return [
    PIVOT[0] + length * Math.cos(degrees * DEGREES),
    PIVOT[1] - length * Math.sin(degrees * DEGREES),
  ];
}

function servoFigure({ reference, degrees, pushed }, copy, ariaLabel) {
  const target = roleStyle('target');
  const actual = roleStyle('actual');
  const event = roleStyle('event');
  const [tx, ty] = armEnd(reference, ARM + 14);
  const [ax, ay] = armEnd(degrees, ARM);
  const [lx, ly] = armEnd(reference, ARM + 40);
  const side = [Math.sin(degrees * DEGREES), Math.cos(degrees * DEGREES)]; // clockwise side
  const [mx, my] = armEnd(degrees, ARM * 0.62);
  const actualLabel = [mx + side[0] * 30, my + side[1] * 30];
  const push = pushed
    ? svg`<path d=${`M${fixed(ax + side[0] * 34 - Math.cos(degrees * DEGREES) * 6)} ${fixed(ay + side[1] * 34 + Math.sin(degrees * DEGREES) * 6)}l${fixed(side[0] * 22)} ${fixed(side[1] * 22)}`} stroke=${event.color} stroke-width="4" marker-end="url(#motorPushHead)"/>`
    : '';
  const body = svg`<defs><marker id="motorPushHead" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0L10 5L0 10z" fill=${event.color}/></marker></defs>${line(PIVOT[0], PIVOT[1], PIVOT[0] + 176, PIVOT[1], '#9bafb6', 2, '5 5')}${label(PIVOT[0] + 176, PIVOT[1] + 2, '0°', { size: 18, anchor: 'end', fill: '#51656d' })}<path d=${`M${PIVOT[0] - 100} ${PIVOT[1]}A100 100 0 0 1 ${PIVOT[0] + 100} ${PIVOT[1]}`} fill="none" stroke="#b7cbd2" stroke-width="2"/>${line(PIVOT[0], PIVOT[1], ax, ay, actual.color, 14)}${circle(ax, ay, 10, '#fff', actual.color, 4)}${line(PIVOT[0], PIVOT[1], tx, ty, '#fff', 6)}${line(PIVOT[0], PIVOT[1], tx, ty, target.color, 3, target.dash)}${label(lx, ly, copy.servoTarget, { size: 18, fill: target.color, weight: 700 })}${label(actualLabel[0], actualLabel[1], copy.servoActual, { size: 18, fill: '#146e4c', weight: 700 })}${push}${circle(PIVOT[0], PIVOT[1], 24, '#303d42', '#95acb3', 3)}`;
  return figure('0 10 390 222', ariaLabel, body, 'motor-figure-servo');
}

// --- Transmission --------------------------------------------------------------------------------

// Pitch radii and tooth counts use the same ratio, so the teeth mesh as the input is scrubbed.
function gearTeeth(radius, count) {
  return Array.from({ length: count }, (_, tooth) =>
    [-0.5, -0.3, -0.22, 0.22, 0.3, 0.5]
      .map((offset, corner) => {
        const a = ((tooth + offset) * 2 * Math.PI) / count;
        const r = radius + ([2, 3].includes(corner) ? 3 : -3);
        return `${fixed(Math.cos(a) * r)},${fixed(Math.sin(a) * r)}`;
      })
      .join(' '),
  ).join(' ');
}

function gear(x, y, radius, teeth, angle, color) {
  const arms = [0, 120, 240].map(
    (a) =>
      svg`<g transform=${`rotate(${a})`}>${line(0, 0, radius * 0.65, 0, color, Math.max(5, radius * 0.16))}</g>`,
  );
  return svg`<g transform=${`translate(${x} ${y}) rotate(${fixed(angle)})`}><polygon points=${gearTeeth(radius, teeth)} fill=${color} stroke="#47616b" stroke-width="1.5"/>${circle(0, 0, radius * 0.66, BACKGROUND, '#709098', 2)}${arms}${line(radius * 0.78, 0, radius - 2, 0, '#fff', 4)}${circle(0, 0, 7, '#dbe5e8', '#47616b', 2)}</g>`;
}

function wheel(x, y, angle) {
  const spokes = [0, 60, 120, 180, 240, 300].map(
    (a) => svg`<g transform=${`rotate(${a})`}>${line(12, 0, 31, 0, '#405b68', 9)}</g>`,
  );
  return svg`<g transform=${`translate(${x} ${y})`}>${circle(-20, -10, 61, '#263b45', '#263b45')}<path d="M-20-71L0-61V61L-20 51Z" fill="#344b56"/>${circle(0, 0, 61, '#344b56', '#243b47', 3)}${circle(0, 0, 52, 'none', '#5b737e', 2)}<g transform=${`rotate(${fixed(angle)})`}>${circle(0, 0, 36, '#adbec6', '#7f99a4', 3)}${spokes}${line(0, -51, 0, -60, '#fff', 6)}</g>${circle(0, 0, 13, '#dce6e9', '#6d8793', 3)}${circle(0, 0, 5, '#486472', '#486472')}</g>`;
}

const GEAR_MARKER = 1.35; // the gear figure is 590 units wide, so its markers are drawn larger

// `turns`: motor revolutions the learner has scrubbed to.
function gearFigure(ratio, turns, ariaLabel) {
  const values = transmissionValues(ratio);
  const direct = values.ratio === 1;
  const input = turns * 360;
  const output = (input / values.ratio) * (direct ? 1 : -1);
  const pinion = 96 / values.ratio; // pitch radius of the 12-tooth gear
  const gearX = 260 + pinion + 96;
  const wheelX = direct ? 500 : gearX + 150;
  const wheelY = direct ? 280 : 262;
  const drive = direct
    ? svg`${motorBody(220, 145, input)}${shaft(220, 145, wheelX, wheelY)}${marker('①', 100, 250, [140, 190], GEAR_MARKER)}${marker('②', 400, 140, [372, 206], GEAR_MARKER)}`
    : svg`${motorBody(200, 155, input)}${shaft(200, 155, 260, 185)}${gear(260, 185, pinion, 12, input, '#be8454')}${gear(gearX, 185, 96, values.teeth, 180 / values.teeth + output, '#5e9a8e')}${shaft(gearX, 185, wheelX, wheelY)}${marker('①', 100, 262, [140, 195], GEAR_MARKER)}${marker('②', 230, 318, [255, 185 + pinion + 4], GEAR_MARKER)}${marker('③', gearX - 110, 72, [gearX - 60, 110], GEAR_MARKER)}`;
  const body = svg`${drive}${wheel(wheelX, wheelY, output)}${marker('④', wheelX + 72, wheelY - 78, [wheelX + 30, wheelY - 40], GEAR_MARKER)}`;
  return figure('50 40 590 320', ariaLabel, body, 'motor-figure-gear');
}

// --- QUESTiX: where the motors are ---------------------------------------------------------------

// Positions on the side view as fractions of its image: the drive wheel and the launcher box.
const WHEEL_ON_SIDE = [0.63, 0.94];
const LAUNCHER_ON_SIDE = [0.86, 0.66];

function questixMotorsFigure(copy, ariaLabel) {
  const centre = 170;
  const floor = 286;
  const width = 250;
  const place = questixSideLayout(centre, floor, width);
  const at = ([fx, fy]) => [place.x + fx * place.width, place.y + fy * place.height];
  const [wx, wy] = at(WHEEL_ON_SIDE);
  const [lx, ly] = at(LAUNCHER_ON_SIDE);
  const body = svg`${line(20, floor, 330, floor, '#8aa0a8', 2)}${questixSideSvg(centre, floor, width)}${marker('①', wx - 40, floor + 26, [wx, wy])}${marker('②', lx + 20, ly - 104, [lx, ly - 10])}${line(262, 26, 318, 26, INK, 2)}<path d="M320 26l-10-6v12z" fill=${INK}/>${label(258, 27, copy.front, { size: 18, anchor: 'end' })}`;
  return figure('0 0 340 336', ariaLabel, body, 'motor-figure-questix');
}

export {
  exteriorFigure,
  motorSection,
  coilCloseup,
  rotorFigure,
  servoFigure,
  gearFigure,
  questixMotorsFigure,
};
