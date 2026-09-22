import { html, svg, nothing } from '../vendor/lit-html.js';
import { loadJson, fillSentence as fill } from '../core/content.js';

// Scenes and charts of the six "systems" courses, as lit templates. Every function here is pure:
// it turns a finished run and the sample index being shown into markup, and holds no state.
// The readings and explanations that go with a scene live in narration.js. Every caption comes
// from content/systems/render.json; the run's status names come from content/systems/core.json,
// the file core.js takes them from, because a few scenes compare against them.

const copy = await loadJson('content/systems/render.json');
const { status: STATUS } = await loadJson('content/systems/core.json');

const SERIES_COLORS = ['#3d8b77', '#5d83bf', '#c18837', '#a4abb2']; // one per chart line, in order
const STROKE = '#77939e';
const INK = '#bdcfd6';
const SCENE_BACKGROUND = '#1b303b';
const ROBOT_ACCENT = '#8bd6be'; // sensor ring of the top-view robot

const num = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '—');

// --- drawing primitives -----------------------------------------------------------------------

function line(x1, y1, x2, y2, color = STROKE, width = 2, dash = '') {
  return svg`<path
    d="M${x1},${y1}L${x2},${y2}"
    fill="none"
    stroke=${color}
    stroke-width=${width}
    stroke-dasharray=${dash || nothing}
  />`;
}

function label(x, y, text, color = INK, size = 16) {
  return svg`<text x=${x} y=${y} fill=${color} font-size=${size}>${text}</text>`;
}

function circle(x, y, radius, color, fill = 'none') {
  return svg`<circle cx=${x} cy=${y} r=${radius} stroke=${color} fill=${fill} stroke-width="2" />`;
}

function box(x, y, width, height, fill, extra = {}) {
  return svg`<rect
    x=${x}
    y=${y}
    width=${width}
    height=${height}
    rx=${extra.rx ?? nothing}
    fill=${fill}
    stroke=${extra.stroke ?? nothing}
    stroke-width=${extra.strokeWidth ?? nothing}
  />`;
}

function topRobot(accent) {
  return svg`<rect x="-21" y="-29" width="42" height="58" rx="10" fill="#d1e0e2" /><rect
      x="-29"
      y="-20"
      width="10"
      height="40"
      rx="3"
      fill="#182a33"
      stroke="#86a3b0"
    /><rect
      x="19"
      y="-20"
      width="10"
      height="40"
      rx="3"
      fill="#182a33"
      stroke="#86a3b0"
    /><rect x="-13" y="-27" width="26" height="10" rx="5" fill="#21485d" /><circle
      cx="-6"
      cy="-22"
      r="3"
      fill="#92d1fd"
    /><circle cx="6" cy="-22" r="3" fill="#92d1fd" /><rect
      x="-14"
      y="-11"
      width="28"
      height="31"
      rx="8"
      fill="#29414a"
    /><circle r="9" cy="3" fill="#1a3038" stroke=${accent} stroke-width="3" />`;
}

const sideRobot = () =>
  svg`<rect x="-23" y="-31" width="48" height="23" rx="6" fill="#cedbdc" /><rect
      x="15"
      y="-39"
      width="13"
      height="11"
      rx="4"
      fill="#93bde0"
    /><circle
      cx="-8"
      cy="-11"
      r="14"
      fill="#1d2930"
      stroke="#92adb5"
      stroke-width="3"
    /><circle cx="21" cy="-4" r="6" fill="#1d2930" stroke="#92adb5" stroke-width="2" />`;

function robot(x, y, angle = 0, side = false, accent = ROBOT_ACCENT) {
  return svg`<g transform="translate(${x} ${y}) rotate(${angle})">
    ${side ? sideRobot() : topRobot(accent)}
  </g>`;
}

// The standard 800×350 stage every scene but the tracking one is drawn on.
function scene(body, description) {
  return html`<svg
    viewBox="0 0 800 350"
    role="img"
    aria-label=${description}
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect width="800" height="350" fill=${SCENE_BACKGROUND} />
    ${body}
  </svg>`;
}

const sceneDescription = (sample) =>
  fill(copy.scene.description, { status: sample.status, time: num(sample.t, 1) });

// --- scenes -----------------------------------------------------------------------------------

const VIEW_LABELS = {
  coordination: copy.scene.viewLabels.coordination,
  behavior: copy.scene.viewLabels.behavior,
};
const viewLabel = (course) => VIEW_LABELS[course] ?? copy.scene.viewLabels.sideView;

const GROUND_Y = 260; // baseline the side-view robots stand on

// Metre ticks along the floor of a side view.
function floorAxis(toX, lastMark, step = 1) {
  const marks = [];
  for (let metre = 0; metre <= lastMark; metre += step) marks.push(metre);
  return [
    line(45, GROUND_Y, 750, GROUND_Y, '#8c9fa5', 2),
    marks.map((metre) => [
      line(toX(metre), GROUND_Y, toX(metre), GROUND_Y + 8),
      label(toX(metre) - 8, GROUND_Y + 30, metre + ' m', undefined, 14),
    ]),
  ];
}

function armScene(run, index) {
  const text = copy.arm;
  const sample = run.samples[index];
  const toX = (mm) => 120 + mm * 1.65;
  const toY = (mm) => 302 - mm * 1.05;
  const markers = [
    { x: 140, z: 80 },
    { x: 210, z: 130 },
    { x: 130, z: 180 },
  ];
  const body = [
    label(28, 32, viewLabel('coordination')),
    line(120, 302, 750, 302),
    line(120, 302, 120, 76),
    label(558, 330, text.horizontalAxis, undefined, 14),
    label(22, 70, text.heightAxis, undefined, 14),
    label(72, 330, text.shoulder, undefined, 14),
    line(toX(40), toY(30), toX(sample.target.x), toY(sample.target.z), '#708995', 1.5, '5 5'),
    run.topic === 'calibrate'
      ? markers.map((marker) => circle(toX(marker.x), toY(marker.z), 5, '#aebbd6'))
      : nothing,
    line(toX(0), toY(0), toX(sample.elbow.x), toY(sample.elbow.z), '#8bd6be', 13),
    line(
      toX(sample.elbow.x),
      toY(sample.elbow.z),
      toX(sample.tip.x),
      toY(sample.tip.z),
      '#95b9ee',
      11,
    ),
    [sample.base, sample.elbow, sample.tip].map((joint) =>
      circle(toX(joint.x), toY(joint.z), 8, '#d7e6e7', '#203c48'),
    ),
    box(toX(sample.target.x) - 12, toY(sample.target.z) - 12, 24, 24, '#e9ca8533', {
      rx: 3,
      stroke: '#e9ca85',
      strokeWidth: 2,
    }),
    circle(toX(sample.estimate.x), toY(sample.estimate.z), 8, '#91bfff'),
    label(458, 58, text.targetKey, '#e9ca85'),
    label(458, 82, text.estimateKey, '#91bfff'),
    box(toX(40) - 12, toY(30) - 7, 24, 14, '#91bfff', { rx: 4 }),
    label(toX(40) + 24, toY(30), text.camera, '#91bfff', 14),
    label(458, 110, fill(text.tipDistance, { distance: num(sample.error, 1) }), '#dfeaed'),
  ];
  return scene(body, sceneDescription(sample));
}

function roomScene(run, index) {
  const sample = run.samples[index];
  const toX = (x) => 55 + x * 145;
  const toY = (y) => 57 + y * 75;
  const parcelY = run.topic === 'missing' ? 0.7 : 2;
  // Every third sample is enough for a smooth trail and keeps the path short.
  const trail = run.samples
    .slice(0, index + 1)
    .filter((_, position) => position % 3 === 0)
    .map((point, position) => (position ? 'L' : 'M') + toX(point.x) + ',' + toY(point.y))
    .join('');
  const body = [
    label(28, 32, viewLabel('behavior')),
    box(55, 50, 690, 270, '#233e4a', { rx: 8 }),
    svg`<path d=${trail} fill="none" stroke="#74b7a0" stroke-width="2" />`,
    box(toX(1.3) - 8, toY(parcelY) - 8, 16, 16, '#dab57e', { rx: 3 }),
    label(toX(1.3) - 30, toY(parcelY) - 23, copy.room.parcel, undefined, 14),
    circle(toX(4.3), toY(2), 26, '#e7ca81'),
    label(toX(4.3) - 30, toY(2) - 39, copy.room.delivery, undefined, 14),
    sample.blocked
      ? [
          box(toX(2.45), toY(1.4), 58, 90, '#ab7459', { rx: 5 }),
          label(toX(2.4), toY(1.25), copy.room.obstacle, '#e7b692', 14),
        ]
      : nothing,
    robot(toX(sample.x), toY(sample.y), (sample.theta * 180) / Math.PI + 90),
    sample.hasParcel ? box(toX(sample.x) - 6, toY(sample.y) - 6, 12, 12, '#e2bd80') : nothing,
  ];
  return scene(body, sceneDescription(sample));
}

function mechanicsScene(run, index) {
  const text = copy.mechanics;
  const sample = run.samples[index];
  // Keep the whole run on screen, with a little room past the furthest point reached.
  const extent =
    Math.max(4.4, ...run.samples.map((point) => Math.max(point.x, point.odom ?? 0))) * 1.06;
  const toX = (metres) => 55 + (metres / extent) * 690;
  const transition = run.events.find(
    (event) => event.kind === 'power-off' || event.kind === 'brake',
  );
  const transitionLabel =
    transition?.kind === 'power-off' ? text.powerOffPosition : text.brakePosition;
  const body = [
    label(28, 32, viewLabel('mechanics')),
    floorAxis(toX, Math.floor(extent), extent > 10 ? 2 : 1),
    run.topic === 'braking'
      ? [
          line(toX(3), 100, toX(3), GROUND_Y, '#e7ca81', 3),
          label(toX(3) - 25, 80, text.stopLine, '#e7ca81', 15),
        ]
      : nothing,
    transition && transition.t <= sample.t
      ? [
          line(toX(transition.x), 145, toX(transition.x), GROUND_Y, '#dfac64', 2, '5 5'),
          circle(toX(transition.x), GROUND_Y, 5, '#dfac64', '#dfac64'),
          label(
            Math.max(40, Math.min(565, toX(transition.x) - 65)),
            132,
            transitionLabel,
            '#e7bf80',
            14,
          ),
        ]
      : nothing,
    run.topic === 'traction'
      ? [
          svg`<g opacity=".55">${robot(toX(sample.odom), GROUND_Y, 0, true)}</g>`,
          label(
            Math.max(32, Math.min(565, toX(sample.odom) - 100)),
            180,
            text.odometryPosition,
            '#91bfff',
            14,
          ),
        ]
      : nothing,
    robot(toX(sample.x), GROUND_Y, 0, true),
    label(toX(sample.x) - 22, 197, run.config.mass + ' kg', '#c7dadd', 14),
    label(
      45,
      104,
      fill(text.forces, { force: num(sample.force, 1), accel: num(sample.accel, 2) }),
      '#c6d6dd',
      16,
    ),
    label(
      45,
      70,
      fill(text.speeds, { speed: num(sample.v), wheelSpeed: num(sample.wheelSpeed) }),
      '#a8dcca',
      17,
    ),
  ];
  return scene(body, sceneDescription(sample));
}

const DIAGNOSTICS_EXTENT = 4.8; // metres shown across the scene

function distanceParts(sample, toX) {
  const text = copy.diagnostics;
  return [
    box(toX(3.2), 174, toX(4) - toX(3.2), 62, '#b57959'),
    label(toX(3.05) - 10, 152, text.shelf, '#e3b794', 15),
    line(toX(sample.x), 245, toX(4), 245, '#7dd4cb', 2, '5 4'),
    line(toX(sample.x) + 25, 222, toX(3.2), 222, '#98bfff', 2, '5 4'),
    label(48, 77, fill(text.lidarRange, { distance: num(sample.lidar) }), '#7dd4cb', 17),
    label(48, 109, fill(text.cameraRange, { distance: num(sample.depth) }), '#98bfff', 17),
  ];
}

const DATA_LOSS_TIME = 1.5; // seconds; after this the range stops being updated

function missingParts(sample, toX) {
  const text = copy.diagnostics;
  const stale = sample.t >= DATA_LOSS_TIME;
  return [
    box(toX(3.2), 145, 20, 115, '#a8846b'),
    label(toX(3.2) - 22, 125, text.obstacle, '#e3b794', 15),
    line(toX(sample.x), 235, toX(3.2), 235, '#7dd4cb', 2, stale ? '2 8' : '5 4'),
    label(48, 79, fill(text.lastRange, { distance: num(sample.range) }), '#98bfff', 18),
    label(48, 111, stale ? text.staleRange : text.freshRange, stale ? '#e7bf80' : '#bdcfd6', 15),
    label(48, 325, fill(text.currentRange, { distance: num(sample.depth) }), '#bdcfd6', 15),
  ];
}

function impactParts(run, sample, toX) {
  const text = copy.diagnostics;
  const shock = run.events.find((event) => event.kind === 'shock');
  const happened = shock && sample.t >= shock.t;
  return [
    label(48, 80, fill(text.imuAcceleration, { accel: num(sample.accel, 1) }), '#dce5ea', 18),
    label(
      48,
      112,
      fill(text.impactLimit, { limit: num(run.config.impactLimit, 1) }),
      '#e7bf80',
      15,
    ),
    happened
      ? [
          line(toX(shock.x), 165, toX(shock.x), GROUND_Y, '#e7bf80', 2, '4 5'),
          label(
            Math.max(48, toX(shock.x) - 65),
            146,
            fill(text.shockMarker, { event: shock.label }),
            '#e7bf80',
            16,
          ),
          // A short flash around the robot marks the moment of the shock.
          sample.t < 2.2 ? circle(toX(sample.x), GROUND_Y - 24, 36, '#e7bf80') : nothing,
        ]
      : nothing,
    label(48, 325, text.impactNote, '#bdcfd6', 15),
  ];
}

function diagnosticsScene(run, index) {
  const sample = run.samples[index];
  const toX = (metres) => 55 + (metres / DIAGNOSTICS_EXTENT) * 690;
  const topicParts = () => {
    if (run.topic === 'distance') return distanceParts(sample, toX);
    if (run.topic === 'missing') return missingParts(sample, toX);
    return impactParts(run, sample, toX);
  };
  const body = [
    label(28, 32, viewLabel('diagnostics')),
    floorAxis(toX, Math.floor(DIAGNOSTICS_EXTENT)),
    run.topic === 'distance'
      ? [
          box(toX(4), 75, 17, 185, '#8e9da5'),
          label(toX(4) - 13, 60, copy.diagnostics.wall, undefined, 15),
        ]
      : nothing,
    topicParts(),
    robot(toX(sample.x), GROUND_Y, 0, true),
  ];
  return scene(body, sceneDescription(sample));
}

function timingScene(run, index) {
  const text = copy.timing;
  const sample = run.samples[index];
  const mapping = run.topic === 'alignment';
  const toX = (metres) => 55 + (metres / 4.8) * 690;
  const stages = [
    [text.stages.measured, sample.stamp],
    [text.stages.received, sample.receive],
    [text.stages.used, sample.stamp === null ? null : sample.t],
  ];
  const measuredTrail =
    sample.measuredX !== null && sample.x - sample.measuredX > 0.04
      ? svg`<g opacity=".35">${robot(toX(sample.measuredX), GROUND_Y, 0, true)}</g>`
      : nothing;
  const mapParts = () => [
    label(48, 125, text.mapKey, '#98bfff', 16),
    line(toX(sample.wallEstimate), 140, toX(sample.wallEstimate), GROUND_Y, '#91bfff', 4),
    line(toX(sample.mapBaseX), 184, toX(sample.wallEstimate), 184, '#91bfff', 2, '5 4'),
    label(48, 157, fill(text.wallEstimate, { distance: num(sample.wallEstimate) }), '#91bfff', 17),
  ];
  const rangeParts = () => [
    label(48, 125, fill(text.rangeWhenMeasured, { distance: num(sample.rawRange) }), '#e6c189', 16),
    label(48, 156, fill(text.currentRange, { distance: num(sample.range) }), '#8bd6be', 16),
    line(toX(sample.measuredX), 179, toX(4), 179, '#e6c189', 2, '4 5'),
    line(toX(sample.x), 200, toX(4), 200, '#8bd6be', 2),
  ];
  const legend = mapping ? text.mapLegend : text.rangeLegend;
  const body = [
    label(28, 28, text.title),
    stages.map(([title, time], position) => {
      const x = 48 + position * 245;
      return [
        label(x, 59, title, '#b8ccd5', 13),
        label(x, 86, num(time, 2) + ' 秒', '#e0ebef', 19),
        position < 2 ? label(x + 195, 80, '→', '#90aab6', 20) : nothing,
      ];
    }),
    floorAxis(toX, 4),
    box(toX(4), 132, 17, 128, '#8e9da5'),
    label(toX(4) - 24, 119, text.realWall, '#cedbe0', 14),
    mapping ? nothing : line(toX(3.5), 220, toX(3.5), GROUND_Y, '#e7ca81', 2, '5 4'),
    sample.measuredX !== null
      ? [measuredTrail, mapping ? mapParts() : rangeParts()]
      : label(48, 134, text.waitingFirstData, '#c6d9e3', 16),
    robot(toX(sample.x), GROUND_Y, 0, true),
    label(48, 324, legend, '#c3d5dc', 14),
  ];
  const description =
    fill(text.description, {
      stamp: num(sample.stamp, 2),
      receive: num(sample.receive, 2),
      now: num(sample.t, 2),
    }) +
    (mapping ? text.mapDescription : text.rangeDescription) +
    sample.status;
  return scene(body, description);
}

// --- the tracking scene, drawn on a taller stage of its own ------------------------------------

const TRACKING_SCALE = 115; // pixels per metre
const TRACKING_RADIUS = 0.18 * TRACKING_SCALE; // collision circle of either robot
const TARGET_ACCENT = '#d2dce1'; // the other robot is drawn in grey, not in QUESTiX green

function arrow(x1, y1, x2, y2, color) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = 9;
  return [
    line(x1, y1, x2, y2, color, 3),
    line(x2, y2, x2 - head * Math.cos(angle - 0.55), y2 - head * Math.sin(angle - 0.55), color, 3),
    line(x2, y2, x2 - head * Math.cos(angle + 0.55), y2 - head * Math.sin(angle + 0.55), color, 3),
  ];
}

const centered = (x, y, text, color, size = 17) =>
  svg`<g text-anchor="middle">${label(x, y, text, color, size)}</g>`;

function trackingRobot(x, y, angle, isTarget = false) {
  return svg`<g data-tracking-robot=${isTarget ? 'target' : 'questix'} transform="translate(${x} ${y})">
    ${circle(0, 0, TRACKING_RADIUS, isTarget ? '#aebec5' : '#82cfb5', isTarget ? '#6e859042' : '#67b59920')}
    <g transform="scale(${TRACKING_RADIUS / 37})">
      ${robot(0, 0, angle, false, isTarget ? TARGET_ACCENT : ROBOT_ACCENT)}
    </g>
  </g>`;
}

function trackingScene(run, index) {
  const text = copy.tracking;
  const sample = run.samples[index];
  const crossing = run.topic === 'crossing';
  const predicting = run.topic === 'prediction';
  // Rotate the room, not the simulation: QUESTiX faces up and its target crosses
  // right to left. Keep one fixed metric scale, including both collision circles.
  const toX = (y) => 250 + y * TRACKING_SCALE;
  const toY = (x) => 590 - x * TRACKING_SCALE;
  const questixX = toX(sample.y);
  const questixY = toY(sample.x);
  const targetX = toX(sample.cart.y);
  const targetY = toY(sample.cart.x);
  const measuredX = toX(sample.obs.y);
  const direction = sample.actualVelocity < 0 ? -1 : 1;
  const forecastX = sample.predicted ? toX(sample.predicted.y) : null;
  const drawnForecastX = forecastX === null ? null : Math.max(48, Math.min(752, forecastX));
  const offscreen = forecastX !== null && forecastX !== drawnForecastX;
  const questixLabelY = Math.max(110, Math.min(553, questixY + 6));
  const contact = crossing && sample.status === STATUS.contact;

  const goalParts = [
    box(questixX - 43, 60, 86, 510, '#78c8a915', { rx: 8 }),
    line(questixX, 545, questixX, 108, '#86bda8', 2, '8 9'),
    circle(questixX, toY(4.4), TRACKING_RADIUS, '#92d8bd'),
    centered(questixX, toY(4.4) + 6, '◎', '#a6e6cb', 22),
    label(questixX + 39, toY(4.4) + 6, text.goal, '#b5e8d4', 18),
    centered(questixX, targetY - 69, text.crossingPoint, '#e0dbb8', 16),
  ];
  const facingParts = [
    arrow(questixX, questixY - 40, questixX, questixY - 110, '#8bd6be'),
    label(questixX + 24, questixY - 83, text.cameraFront, '#a6e0cc', 17),
  ];
  const positionAxis = [
    label(54, 110, text.positionAxis, '#afc6d0', 15),
    line(92, 145, 710, 145, '#718d99', 1),
    [-1, 0, 1, 2, 3].map((metre) => [
      line(toX(metre), 139, toX(metre), 151, '#a5bbc5', 1),
      centered(toX(metre), 133, String(metre), '#c2d2d9', 16),
    ]),
    line(questixX, questixY - 22, measuredX, targetY, '#83b7ec66', 1.5, '4 7'),
  ];
  const previousObservation =
    !crossing && sample.previousObs
      ? [
          circle(toX(sample.previousObs.y), targetY, 6, '#9ac3ff'),
          line(toX(sample.previousObs.y), targetY, measuredX, targetY, '#9ac3ff', 2),
        ]
      : nothing;
  const forecastParts =
    predicting && sample.predicted
      ? [
          line(measuredX, targetY, drawnForecastX, targetY, '#efcf80', 2, '5 5'),
          svg`<circle
            data-tracking-forecast
            cx=${drawnForecastX}
            cy=${targetY}
            r=${TRACKING_RADIUS + 6}
            fill="none"
            stroke="#efcf80"
            stroke-width="3"
            stroke-dasharray="5 4"
          />`,
          line(drawnForecastX, targetY - 31, drawnForecastX, targetY - 57, '#efcf80', 1.5),
          centered(
            Math.max(122, Math.min(674, drawnForecastX)),
            targetY - 68,
            offscreen
              ? text.offscreenForecast
              : fill(text.forecastPosition, { time: num(sample.predicted.targetTime, 1) }),
            '#efcf80',
            17,
          ),
        ]
      : nothing;

  const body = [
    box(28, 28, 744, 552, '#233e4a', { rx: 14 }),
    // The pale strip is the scenario's route; only blue dots are measurements.
    box(40, targetY - 43, 720, 86, '#bacad00e', { rx: 8 }),
    line(40, targetY - 43, 760, targetY - 43, '#76919b', 1),
    line(40, targetY + 43, 760, targetY + 43, '#76919b', 1),
    label(54, targetY + 72, text.otherRoute, '#c3d3db', 18),
    crossing ? goalParts : facingParts,
    label(54, 64, text.view, '#bfd1d8', 17),
    crossing ? nothing : positionAxis,
    previousObservation,
    forecastParts,
    arrow(
      targetX + direction * 32,
      targetY,
      Math.max(48, Math.min(752, targetX + direction * 95)),
      targetY,
      '#d9e2e7',
    ),
    trackingRobot(targetX, targetY, direction < 0 ? -90 : 90, true),
    trackingRobot(questixX, questixY, 0),
    circle(measuredX, targetY, 6, '#c6dfff', '#568bd9'),
    centered(Math.max(108, Math.min(690, targetX)), targetY + 105, text.otherRobot, '#e0e9ee', 18),
    label(questixX + 38, questixLabelY, 'QUESTiX', '#a6e0cc', 18),
    contact
      ? [
          circle(
            (targetX + questixX) / 2,
            (targetY + questixY) / 2,
            TRACKING_RADIUS + 12,
            '#ee9b83',
          ),
          label(questixX + 38, questixLabelY + 25, text.contact, '#ffb7a4', 18),
        ]
      : label(
          questixX + 38,
          questixLabelY + 25,
          trackingStatusLabel(sample, crossing),
          '#c4d6dd',
          16,
        ),
  ];
  const description = trackingDescription(run, sample, direction);
  return html`<div class="sys-tracking-scene">
    <div class="sys-tracking-context">
      <strong>${trackingIntro(crossing)}</strong>
    </div>
    <svg viewBox="0 0 800 610" role="img" aria-label=${description}>
      <rect width="800" height="610" fill=${SCENE_BACKGROUND} />
      ${body}
    </svg>
    <div class="sys-tracking-key">
      <span
        ><i class="tracking-measured"></i>${text.measuredKey}<span class="sys-tracking-stamp"
          >${fill(text.measurementStamp, { time: num(sample.obs.t, 1) })}</span
        ></span
      >${predicting ? forecastKey(run, sample, offscreen) : nothing}
    </div>
  </div>`;
}

// The scene's accessible description: who faces where, what moves, and the time shown.
function trackingDescription(run, sample, direction) {
  const text = copy.tracking.description;
  const crossing = run.topic === 'crossing';
  const predicting = run.topic === 'prediction';
  return (
    fill(text.opening, { direction: direction < 0 ? text.rightToLeft : text.leftToRight }) +
    (crossing ? text.crossing : text.watching) +
    text.measured +
    (predicting ? fill(text.forecast, { horizon: num(run.config.horizon, 1) }) : '') +
    fill(text.elapsed, { time: num(sample.t, 1) })
  );
}

function trackingStatusLabel(sample, crossing) {
  if (!crossing) return copy.tracking.observing;
  if (sample.status === STATUS.tracking.waitForOther) return copy.tracking.waiting;
  return sample.status;
}

function trackingIntro(crossing) {
  if (crossing) return copy.tracking.crossingIntro;
  return copy.tracking.watchingIntro;
}

function forecastKey(run, sample, offscreen) {
  const text = copy.tracking;
  const stamp = sample.predicted
    ? fill(text.forecastStamp, { time: num(sample.predicted.targetTime, 1) }) +
      (offscreen ? text.forecastOffscreen : '')
    : text.forecastPending;
  const caption = fill(text.forecastCaption, { horizon: num(run.config.horizon, 1) });
  return html`<span
    ><i class="tracking-predicted"></i>${caption}<span class="sys-tracking-stamp"
      >${stamp}</span
    ></span
  >`;
}

function systemScene(run, index) {
  if (run.course === 'timing') return timingScene(run, index);
  if (run.course === 'tracking') return trackingScene(run, index);
  if (run.course === 'coordination') return armScene(run, index);
  if (run.course === 'behavior') return roomScene(run, index);
  if (run.course === 'diagnostics') return diagnosticsScene(run, index);
  return mechanicsScene(run, index);
}

// --- charts -----------------------------------------------------------------------------------

// Chart titles, units and the sample key and caption of each line, per course, in display order.
const SYSTEM_CHARTS = copy.charts;

const CHART_TOP = 40; // y where the "now" and transition rules start
const CHART_BOTTOM = 195; // y of the lowest gridline; values grow upwards from here
const CHART_LEFT = 62;
const CHART_RIGHT = 738;
const CHART_PLOT_HEIGHT = 150; // pixels the value range is spread over
const CHART_PLOT_WIDTH = 675; // pixels the run's duration is spread over
const CHART_PAD_RATIO = 0.08; // head- and footroom added to the value range
const TIMING_STOP_RANGE = 0.6; // metres; the stop threshold drawn on the timing distance chart
const TRANSITION_KINDS = ['power-off', 'brake', 'data-loss', 'shock', 'turn', 'stop-command'];

// The first diagnostics chart shows different sensors depending on the experiment.
function chartFor(run, chartIndex) {
  const chart = SYSTEM_CHARTS[run.course][chartIndex] || SYSTEM_CHARTS[run.course][0];
  if (run.course !== 'diagnostics' || chartIndex !== 0) return chart;
  if (run.topic === 'missing') return { ...chart, lines: copy.diagnosticsSensorLines.missing };
  return { ...chart, lines: copy.diagnosticsSensorLines.shelf };
}

// The value at which the experiment decides to stop, drawn as a dashed line; null when the chart
// has no such threshold.
function chartThreshold(run, chartIndex) {
  if (run.course === 'timing') return chartIndex === 0 ? TIMING_STOP_RANGE : null;
  if (run.course !== 'diagnostics') return null;
  if (run.topic === 'distance' && chartIndex === 0) return run.config.stopDistance;
  if (run.topic === 'missing' && chartIndex === 1 && run.config.watchdog)
    return run.config.staleLimit;
  if (run.topic === 'impact' && chartIndex === 2) return run.config.impactLimit;
  return null;
}

// One polyline per chart line; a gap in the data starts a new sub-path instead of a straight jump.
function linePath(samples, key, toX, toY) {
  let connected = false;
  return samples
    .map((sample) => {
      if (!Number.isFinite(sample[key])) {
        connected = false;
        return '';
      }
      const command = connected ? 'L' : 'M';
      connected = true;
      return command + toX(sample.t).toFixed(1) + ',' + toY(sample[key]).toFixed(1);
    })
    .join('');
}

const CHART_STYLE_KEY = copy.chart.styleKey;

function chartLegend(chart, previous) {
  return html`<div class="sys-chart-legend">
    ${chart.lines.map(
      ([, caption], position) =>
        html`<span><i style="background:${SERIES_COLORS[position]}"></i>${caption}</span>`,
    )}${previous ? html`<span class="sys-chart-style-key">${CHART_STYLE_KEY}</span>` : nothing}
  </div>`;
}

function systemChart(run, index, chartIndex = 0, previous = null) {
  const chart = chartFor(run, chartIndex);
  const seen = run.samples.slice(0, index + 1);
  const keys = chart.lines.map(([key]) => key);
  const values = seen.flatMap((sample) => keys.map((key) => sample[key]).filter(Number.isFinite));
  const threshold = chartThreshold(run, chartIndex);
  if (threshold !== null) values.push(threshold);
  if (previous)
    values.push(
      ...previous.samples.flatMap((sample) =>
        keys.map((key) => sample[key]).filter(Number.isFinite),
      ),
    );
  const low = Math.min(0, ...values);
  const high = Math.max(1, ...values);
  const pad = (high - low) * CHART_PAD_RATIO;
  const toY = (value) =>
    CHART_BOTTOM - ((value - low + pad) / (high - low + 2 * pad)) * CHART_PLOT_HEIGHT;
  const duration = Math.max(run.duration, previous?.duration ?? 0);
  const toX = (t) => CHART_LEFT + (t / duration) * CHART_PLOT_WIDTH;

  const transition = run.events.find((event) => TRANSITION_KINDS.includes(event.kind));
  const reached = transition && transition.t <= seen.at(-1).t;
  const transitionMarker =
    transition && (transition.kind === 'power-off' || reached)
      ? svg`<g class="sys-chart-transition">
          ${line(toX(transition.t), CHART_TOP, toX(transition.t), CHART_BOTTOM, '#b27628', 2, '5 4')}
          ${label(
            Math.min(595, Math.max(95, toX(transition.t) + 8)),
            24,
            fill(copy.chart.transition, { time: num(transition.t, 1), label: transition.label }),
            '#885817',
            14,
          )}
        </g>`
      : nothing;
  const thresholdMarker =
    threshold !== null
      ? [
          line(CHART_LEFT, toY(threshold), CHART_RIGHT, toY(threshold), '#a9633b', 1.5, '6 4'),
          label(
            550,
            Math.max(50, toY(threshold) - 8),
            fill(copy.chart.threshold, { value: num(threshold, 1) }),
            '#885817',
            13,
          ),
        ]
      : nothing;

  return html`${chartLegend(chart, previous)}
    <svg
      viewBox="0 0 800 235"
      role="img"
      aria-label=${fill(copy.chart.description, { unit: chart.unit })}
    >
      <rect width="800" height="235" fill="#f6f8f9" />
      ${[low, (low + high) / 2, high].map((value) => [
        line(CHART_LEFT, toY(value), CHART_RIGHT, toY(value), '#dfe6e8', 1),
        label(8, toY(value) + 5, num(value, 1), '#586e79', 14),
      ])}
      ${label(14, 22, chart.unit, '#586e79', 14)}
      ${[0, duration / 2, duration].map((t) =>
        label(toX(t) - 9, 222, num(t, 1) + '秒', '#586e79', 14),
      )}
      ${
        previous
          ? keys.map(
              (key, position) =>
                svg`<path
                d=${linePath(previous.samples, key, toX, toY)}
                fill="none"
                stroke=${SERIES_COLORS[position]}
                stroke-opacity=".65"
                stroke-width="2"
                stroke-dasharray="6 5"
              />`,
            )
          : nothing
      }
      ${keys.map(
        (key, position) =>
          svg`<path
            d=${linePath(seen, key, toX, toY)}
            fill="none"
            stroke=${SERIES_COLORS[position]}
            stroke-width="2.5"
          />`,
      )}
      ${transitionMarker}${thresholdMarker}
      ${line(toX(seen.at(-1).t), CHART_TOP, toX(seen.at(-1).t), CHART_BOTTOM, '#627581', 1, '3 4')}
    </svg>`;
}

export { SYSTEM_CHARTS, systemChart, systemScene };
