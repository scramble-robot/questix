import { html, svg, nothing } from '../vendor/lit-html.js';
import { loadJson, fillSentence as fill } from '../core/content.js';
import { roleStyle } from '../core/palette.js';
import { niceScale, formatTick, scaleTo } from '../core/chart-scale.js';
import {
  BEHAVIOR_PLACES,
  crossingForecast,
  deliveryDistance,
  cameraToBody,
  bodyToCamera,
} from './core.js';

// Scenes and charts of the six "systems" courses, as lit templates. Every function here is pure:
// it turns a finished run, the sample index being shown and the figure size ui.js measured into
// markup, and holds no state. The readings and explanations that go with a scene live in
// narration.js. Every caption comes from content/systems/render.json; the run's status names come
// from content/systems/core.json, the file core.js takes them from.
//
// Figures are drawn at the size they are shown (`options.sceneWidth` / `chartWidth` are the
// measured widths in CSS pixels), so a font size here is the size on screen: nothing is smaller
// than 12 px on a 390 px phone. Colours come from roles (js/core/palette.js), never from the
// order of lines, and every line also has a dash pattern or a direct label.

const copy = await loadJson('content/systems/render.json');
const { status: STATUS } = await loadJson('content/systems/core.json');

const SCENE_BACKGROUND = '#1b303b';
const ROOM_FLOOR = '#233e4a';
const INK = '#dce8ec';
const SOFT_INK = '#b9ccd3';
const STROKE = '#77939e';
const FLOOR = '#8c9fa5';
const GOAL_LINE = '#f4f8f9'; // a line on the floor the robot should stop at: white, solid
const NEUTRAL = '#c9d3d8'; // events and neutral marks in a scene
const ROBOT_ACCENT = '#8bd6be'; // sensor ring of the top-view QUESTiX
const OTHER_ACCENT = '#aab7bd'; // the other robot: grey, so nothing on it looks "measured"
const TEXT_SMALL = 12; // px on screen; the minimum (--figure-text-min)
const TEXT_BODY = 13;
const TEXT_STRONG = 14;
const EPSILON = 1e-8;

const DEFAULT_OPTIONS = { sceneWidth: 760, chartWidth: 720, narrow: false, started: true };

const num = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '—');
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const sceneRole = (role) => roleStyle(role, 'scene');
const chartRole = (role) => roleStyle(role, 'chart');

// --- drawing primitives -----------------------------------------------------------------------

function line(x1, y1, x2, y2, color = STROKE, width = 2, dash = '') {
  return svg`<path
    d="M${x1},${y1}L${x2},${y2}"
    fill="none"
    stroke=${color}
    stroke-width=${width}
    stroke-dasharray=${dash || nothing}
    vector-effect="non-scaling-stroke"
  />`;
}

function roleLine(x1, y1, x2, y2, role, width) {
  const style = sceneRole(role);
  return line(x1, y1, x2, y2, style.color, width ?? style.width, style.dash);
}

function circle(x, y, radius, color, fill = 'none', width = 2, dash = '') {
  return svg`<circle
    cx=${x}
    cy=${y}
    r=${radius}
    stroke=${color}
    fill=${fill}
    stroke-width=${width}
    stroke-dasharray=${dash || nothing}
    vector-effect="non-scaling-stroke"
  />`;
}

function box(x, y, width, height, fill, extra = {}) {
  return svg`<rect
    x=${x}
    y=${y}
    width=${Math.max(0, width)}
    height=${Math.max(0, height)}
    rx=${extra.rx ?? nothing}
    fill=${fill}
    opacity=${extra.opacity ?? nothing}
    stroke=${extra.stroke ?? nothing}
    stroke-width=${extra.strokeWidth ?? nothing}
    stroke-dasharray=${extra.dash ?? nothing}
    vector-effect="non-scaling-stroke"
  />`;
}

// Rough width of a label in px: CJK characters are about one em wide, the rest about 0.6 em.
function textWidth(content, size) {
  let width = 0;
  for (const character of String(content))
    width += character.codePointAt(0) > 0x2e7f ? size : size * 0.6;
  return width;
}

/**
 * A label kept inside the figure: `anchor` says where `x` is ('start' | 'middle' | 'end'); the
 * text is moved sideways as little as needed to stay within `bounds` ([left, right] in px).
 * A dark halo keeps it readable where it crosses a line.
 */
function label(x, y, content, options = {}) {
  const {
    color = INK,
    size = TEXT_BODY,
    anchor = 'start',
    weight = nothing,
    bounds = null,
    halo = SCENE_BACKGROUND,
  } = options;
  const width = textWidth(content, size);
  let left = x;
  if (anchor === 'middle') left = x - width / 2;
  if (anchor === 'end') left = x - width;
  if (bounds) left = clamp(left, bounds[0], Math.max(bounds[0], bounds[1] - width));
  return svg`<text
    x=${left.toFixed(1)}
    y=${y.toFixed(1)}
    fill=${color}
    font-size=${size}
    font-weight=${weight}
    stroke=${halo || nothing}
    stroke-width=${halo ? 3 : nothing}
    stroke-linejoin="round"
    paint-order="stroke"
  >${content}</text>`;
}

// A downward triangle marking where something happened on the floor, with its dashed line.
function floorEvent(stage, x, labelText, labelY) {
  return [
    line(x, labelY + 6, x, stage.ground, NEUTRAL, 1.5, '4 4'),
    label(x, labelY, labelText, {
      color: NEUTRAL,
      size: TEXT_SMALL,
      anchor: 'middle',
      bounds: stage.bounds,
    }),
  ];
}

function topRobot(accent, eye) {
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
      fill=${eye}
    /><circle cx="6" cy="-22" r="3" fill=${eye} /><rect
      x="-14"
      y="-11"
      width="28"
      height="31"
      rx="8"
      fill="#29414a"
    /><circle r="9" cy="3" fill="#1a3038" stroke=${accent} stroke-width="3" />`;
}

// Side view, about 48 px long and 42 px tall at scale 1, wheels touching y = 0.
const sideRobot = () =>
  svg`<rect x="-23" y="-31" width="48" height="23" rx="6" fill="#cedbdc" /><rect
      x="15"
      y="-39"
      width="13"
      height="11"
      rx="4"
      fill="#9fb3bd"
    /><circle
      cx="-8"
      cy="-11"
      r="14"
      fill="#1d2930"
      stroke="#92adb5"
      stroke-width="3"
    /><circle cx="21" cy="-4" r="6" fill="#1d2930" stroke="#92adb5" stroke-width="2" />`;

function sideView(x, y, scale, opacity = 1) {
  return svg`<g transform="translate(${x} ${y}) scale(${scale})" opacity=${opacity}>
    ${sideRobot()}
  </g>`;
}

function topView(x, y, angle, scale, accent = ROBOT_ACCENT, eye = '#92d1fd') {
  return svg`<g transform="translate(${x} ${y}) rotate(${angle}) scale(${scale})">
    ${topRobot(accent, eye)}
  </g>`;
}

function stageSvg(stage, body, description) {
  return html`<svg
    class="sys-scene-svg"
    viewBox="0 0 ${stage.width} ${stage.height}"
    role="img"
    aria-label=${description}
  >
    <rect width=${stage.width} height=${stage.height} fill=${SCENE_BACKGROUND} />
    ${body}
  </svg>`;
}

// --- HTML parts around a scene: key numbers above it, the key to its marks below it ----------

function swatch(role, dash, surface = 'scene') {
  const style = roleStyle(role, surface);
  return html`<svg class="sys-swatch" viewBox="0 0 24 12" width="24" height="12" aria-hidden="true">
    <path
      d="M1,6L23,6"
      stroke=${style.color}
      stroke-width=${Math.max(2, style.width)}
      stroke-dasharray=${dash ?? style.dash ?? nothing}
      fill="none"
    />
  </svg>`;
}

function readoutBand(items) {
  return html`<dl class="sys-readouts">
    ${items.map(
      (item) =>
        html`<div>
          <dt>${item.role ? swatch(item.role) : nothing}${item.label}</dt>
          <dd>${item.value}</dd>
        </div>`,
    )}
  </dl>`;
}

// Key entries are plain sentences that name each mark by its shape ("白い実線：…").
function sceneKey(entries) {
  const shown = entries.filter(Boolean);
  if (!shown.length) return nothing;
  return html`<ul class="sys-scene-key">
    ${shown.map(
      (entry) =>
        html`<li>
          ${entry.role ? swatch(entry.role, entry.dash) : nothing}<span>${entry.text}</span>
        </li>`,
    )}
  </ul>`;
}

const sceneDescription = (sample) =>
  fill(copy.scene.description, { status: sample.status, time: num(sample.t, 1) });

// --- side-view stage (mechanics, diagnostics, timing) ----------------------------------------

const SIDE_HEIGHT = { wide: 250, narrow: 220 }; // px
const SIDE_MARGIN = 22; // px left and right of the floor

function sideStage(options, extent) {
  const width = options.sceneWidth;
  const height = options.narrow ? SIDE_HEIGHT.narrow : SIDE_HEIGHT.wide;
  const ground = height - 44;
  const span = width - 2 * SIDE_MARGIN;
  return {
    width,
    height,
    ground,
    narrow: options.narrow,
    bounds: [6, width - 6],
    robotScale: clamp(width / 800, 0.72, 1),
    pixelsPerMetre: span / extent,
    toX: (metres) => SIDE_MARGIN + (metres / extent) * span,
  };
}

// Metre ticks along the floor, every 1 m or every 2 m when metres are narrow on screen.
function floorAxis(stage, extent) {
  const step = stage.pixelsPerMetre < 45 ? 2 : 1;
  const marks = [];
  for (let metre = 0; metre <= extent + EPSILON; metre += step) marks.push(metre);
  return [
    line(SIDE_MARGIN - 6, stage.ground, stage.width - SIDE_MARGIN + 6, stage.ground, FLOOR, 2),
    marks.map((metre) => [
      line(stage.toX(metre), stage.ground, stage.toX(metre), stage.ground + 7, FLOOR, 1.5),
      label(stage.toX(metre), stage.ground + 24, metre + ' ' + copy.scene.floorUnit, {
        color: SOFT_INK,
        size: TEXT_SMALL,
        anchor: 'middle',
        bounds: stage.bounds,
      }),
    ]),
  ];
}

// --- mechanics ----------------------------------------------------------------------------------

function mechanicsTransition(run) {
  return run.events.find((event) => event.kind === 'power-off' || event.kind === 'brake');
}

function brakingParts(run, sample, stage, reached) {
  const text = copy.mechanics;
  const lineX = stage.toX(3);
  const parts = [
    line(lineX, 26, lineX, stage.ground, GOAL_LINE, 4),
    label(lineX, 18, text.stopLine, {
      color: GOAL_LINE,
      size: TEXT_BODY,
      anchor: 'middle',
      weight: 600,
      bounds: stage.bounds,
    }),
    // The distances are measured from the centre of the robot: mark it on the floor.
    svg`<path
      d="M${stage.toX(sample.x)},${stage.ground + 2}l-5,9h10z"
      fill=${GOAL_LINE}
    />`,
  ];
  if (!reached) {
    const planX = stage.toX(3 - run.config.brakeAt);
    parts.push(
      roleLine(planX, 52, planX, stage.ground, 'plan'),
      label(planX, 44, text.brakePlan, {
        color: sceneRole('plan').color,
        size: TEXT_SMALL,
        anchor: 'middle',
        bounds: stage.bounds,
      }),
    );
  }
  return parts;
}

function tractionParts(sample, stage) {
  const x = stage.toX(sample.odom);
  return [
    sideView(x, stage.ground, stage.robotScale, 0.5),
    line(
      x,
      stage.ground - 50 * stage.robotScale,
      x,
      stage.ground,
      sceneRole('measured').color,
      1.5,
      '4 4',
    ),
    label(x, stage.ground - 56 * stage.robotScale, copy.mechanics.odometryPosition, {
      color: sceneRole('measured').color,
      size: TEXT_SMALL,
      anchor: 'middle',
      bounds: stage.bounds,
    }),
  ];
}

function mechanicsScene(run, index, options) {
  const text = copy.mechanics;
  const sample = run.samples[index];
  // Keep the whole run on screen, with a little room past the furthest point reached.
  const extent =
    Math.max(4.4, ...run.samples.map((point) => Math.max(point.x, point.odom ?? 0))) * 1.06;
  const stage = sideStage(options, extent);
  const transition = mechanicsTransition(run);
  const reached = Boolean(transition && transition.t <= sample.t + EPSILON);
  const markerText = transition?.kind === 'power-off' ? text.powerOffPosition : text.brakePosition;
  const body = [
    floorAxis(stage, extent),
    run.topic === 'braking' ? brakingParts(run, sample, stage, reached) : nothing,
    reached ? floorEvent(stage, stage.toX(transition.x), markerText, 44) : nothing,
    run.topic === 'traction' ? tractionParts(sample, stage) : nothing,
    sideView(stage.toX(sample.x), stage.ground, stage.robotScale),
    label(stage.toX(sample.x), stage.ground - 46 * stage.robotScale - 4, run.config.mass + ' kg', {
      color: SOFT_INK,
      size: TEXT_SMALL,
      anchor: 'middle',
      bounds: stage.bounds,
    }),
  ];
  return html`${mechanicsReadouts(run, sample, options.started)}
  ${stageSvg(stage, body, sceneDescription(sample))} ${mechanicsKey(run)}`;
}

function mechanicsReadouts(run, sample, started) {
  const text = copy.mechanics.readouts;
  const shown = (value, digits, unit) =>
    started ? `${num(value, digits)} ${unit}` : copy.scene.readoutBefore;
  return readoutBand(
    [
      { label: text.speed, value: shown(sample.v, 2, 'm/秒'), role: 'actual' },
      run.topic === 'force'
        ? null
        : { label: text.wheelSpeed, value: shown(sample.wheelSpeed, 2, 'm/秒'), role: 'measured' },
      { label: text.force, value: shown(sample.force, 1, 'N') },
      { label: text.accel, value: shown(sample.accel, 2, 'm/秒²') },
    ].filter(Boolean),
  );
}

function mechanicsKey(run) {
  const keys = copy.mechanics.keys;
  if (run.topic === 'braking')
    return sceneKey([
      { text: keys.stopLine },
      { text: keys.brake },
      { text: keys.brakePlan, role: 'plan' },
      { text: keys.centre },
    ]);
  if (run.topic === 'traction')
    return sceneKey([{ text: keys.odometry }, { text: keys.actual }, { text: keys.powerOff }]);
  return sceneKey([{ text: keys.powerOff }]);
}

// --- diagnostics --------------------------------------------------------------------------------

const DIAGNOSTICS_EXTENT = 4.8; // metres shown across the scene
const DATA_LOSS_TIME = 1.5; // seconds; after this the range stops being updated
const SHOCK_FLASH = 0.25; // seconds the ring around the robot is shown after the shock

// Heights above the floor at scale 1 (px): the LiDAR sits low, the camera near the top.
const LIDAR_HEIGHT = 11;
const CAMERA_HEIGHT = 33;
const SHELF_TOP = 86;
const SHELF_BOTTOM = 22;

function distanceParts(sample, stage) {
  const text = copy.diagnostics;
  const scale = stage.robotScale;
  const measured = sceneRole('measured');
  const front = stage.toX(sample.x) + 26 * scale;
  const lidarY = stage.ground - LIDAR_HEIGHT * scale;
  const cameraY = stage.ground - CAMERA_HEIGHT * scale;
  const shelfX = stage.toX(3.2);
  const wallX = stage.toX(4);
  return [
    box(
      shelfX,
      stage.ground - SHELF_TOP * scale,
      wallX - shelfX,
      (SHELF_TOP - SHELF_BOTTOM) * scale,
      '#b57959',
    ),
    label(shelfX, stage.ground - SHELF_TOP * scale - 8, text.shelf, {
      color: '#e3b794',
      size: TEXT_SMALL,
      bounds: stage.bounds,
    }),
    line(front, lidarY, wallX, lidarY, measured.color, 2),
    circle(wallX, lidarY, 3, measured.color, measured.color),
    label(wallX - 4, lidarY - 4, text.lidar, {
      color: measured.color,
      size: TEXT_SMALL,
      anchor: 'end',
      bounds: stage.bounds,
    }),
    line(front, cameraY, shelfX, cameraY, measured.color, 2, '7 4'),
    label(shelfX - 4, cameraY - 6, text.camera, {
      color: measured.color,
      size: TEXT_SMALL,
      anchor: 'end',
      bounds: stage.bounds,
    }),
  ];
}

// After the data stops, the last range still points from where it was measured.
function missingParts(run, sample, stage) {
  const text = copy.diagnostics;
  const scale = stage.robotScale;
  const measured = sceneRole('measured');
  const stale = sample.t >= DATA_LOSS_TIME;
  const obstacleX = stage.toX(3.2);
  const lidarY = stage.ground - LIDAR_HEIGHT * scale;
  const lastUpdate = run.samples.findLast((point) => point.t < DATA_LOSS_TIME);
  const fromX = stage.toX(stale ? lastUpdate.x : sample.x) + 26 * scale;
  return [
    box(obstacleX, stage.ground - 115 * scale, 20 * scale, 115 * scale, '#a8846b'),
    label(obstacleX, stage.ground - 115 * scale - 8, text.obstacle, {
      color: '#e3b794',
      size: TEXT_SMALL,
      anchor: 'middle',
      bounds: stage.bounds,
    }),
    stale ? sideView(stage.toX(lastUpdate.x), stage.ground, scale, 0.4) : nothing,
    line(fromX, lidarY - 16 * scale, obstacleX, lidarY - 16 * scale, measured.color, 2.5),
    label(fromX, lidarY - 16 * scale - 6, text.lastRange, {
      color: measured.color,
      size: TEXT_SMALL,
      bounds: stage.bounds,
    }),
    stale
      ? label(stage.toX(sample.x), stage.ground - 50 * scale - 4, text.stale, {
          color: '#efc584',
          size: TEXT_SMALL,
          anchor: 'middle',
          weight: 600,
          bounds: stage.bounds,
        })
      : nothing,
  ];
}

function impactParts(run, sample, stage) {
  const shock = run.events.find((event) => event.kind === 'shock');
  if (!shock || sample.t + EPSILON < shock.t) return nothing;
  const scale = stage.robotScale;
  return [
    floorEvent(
      stage,
      stage.toX(shock.x),
      fill(copy.diagnostics.shockMarker, { event: shock.label }),
      40,
    ),
    sample.t < shock.t + SHOCK_FLASH
      ? circle(stage.toX(sample.x), stage.ground - 20 * scale, 34 * scale, '#efc584', 'none', 3)
      : nothing,
  ];
}

function diagnosticsScene(run, index, options) {
  const sample = run.samples[index];
  const stage = sideStage(options, DIAGNOSTICS_EXTENT);
  const topicParts = () => {
    if (run.topic === 'distance') return distanceParts(sample, stage);
    if (run.topic === 'missing') return missingParts(run, sample, stage);
    return impactParts(run, sample, stage);
  };
  const wallX = stage.toX(4);
  const body = [
    floorAxis(stage, DIAGNOSTICS_EXTENT),
    run.topic === 'distance'
      ? [
          box(wallX, 34, Math.max(10, 17 * stage.robotScale), stage.ground - 34, '#8e9da5'),
          label(wallX + 8, 26, copy.diagnostics.wall, {
            size: TEXT_SMALL,
            anchor: 'middle',
            bounds: stage.bounds,
          }),
        ]
      : nothing,
    topicParts(),
    sideView(stage.toX(sample.x), stage.ground, stage.robotScale),
  ];
  return html`${stageSvg(stage, body, sceneDescription(sample))} ${diagnosticsKey(run)}`;
}

function diagnosticsKey(run) {
  const keys = copy.diagnostics.keys;
  if (run.topic === 'distance')
    return sceneKey([
      { text: keys.lidar, role: 'measured' },
      { text: keys.camera, role: 'measured', dash: '7 4' },
    ]);
  if (run.topic === 'missing')
    return sceneKey([{ text: keys.lastRange, role: 'measured' }, { text: keys.lastRangeGhost }]);
  return sceneKey([{ text: keys.shock }]);
}

// --- timing -------------------------------------------------------------------------------------

const TIMING_EXTENT = 4.8; // metres
const TIMING_WALL = 4; // m
const TIMING_TARGET = 3.5; // m; the centre stops here to be 0.5 m from the wall
const TIMING_STOP_RANGE = 0.6; // metres; a used range at or below this commands a stop
const TIMELINE_MIN_WINDOW = 1; // seconds shown by the time band at least
const QUEUE_BOXES = 24; // boxes drawn before the rest is counted
const SAMPLE_PERIOD = 0.05; // seconds between two range measurements

function bracket(fromX, toX, y, role) {
  const style = sceneRole(role);
  return [
    line(fromX, y, toX, y, style.color, style.width + 0.5, style.dash),
    line(fromX, y - 5, fromX, y + 5, style.color, 2),
    line(toX, y - 5, toX, y + 5, style.color, 2),
  ];
}

function rangeParts(sample, stage) {
  const text = copy.timing;
  const scale = stage.robotScale;
  const usedY = stage.ground - 50 * scale - 30;
  const actualY = stage.ground - 50 * scale - 10;
  const wallX = stage.toX(TIMING_WALL);
  const usedFrom = stage.toX(TIMING_WALL - sample.usedRange);
  const actualFrom = stage.toX(sample.x);
  return [
    bracket(usedFrom, wallX, usedY, 'measured'),
    label(usedFrom, usedY - 8, text.usedRange, {
      color: sceneRole('measured').color,
      size: TEXT_SMALL,
      bounds: stage.bounds,
    }),
    bracket(actualFrom, wallX, actualY, 'actual'),
    label(actualFrom, actualY - 7, text.actualRange, {
      color: sceneRole('actual').color,
      size: TEXT_SMALL,
      bounds: stage.bounds,
    }),
  ];
}

function mapParts(sample, stage) {
  const text = copy.timing;
  const measured = sceneRole('measured');
  const wallX = stage.toX(sample.wallEstimate);
  const y = stage.ground - 50 * stage.robotScale - 16;
  return [
    line(wallX, 44, wallX, stage.ground, measured.color, 4),
    label(wallX + 6, 56, text.mapWall, {
      color: measured.color,
      size: TEXT_SMALL,
      bounds: stage.bounds,
    }),
    bracket(stage.toX(sample.mapBaseX), wallX, y, 'measured'),
    label(stage.toX(sample.mapBaseX), y - 8, text.mapSum, {
      color: measured.color,
      size: TEXT_SMALL,
      bounds: stage.bounds,
    }),
  ];
}

function timingGuides(stage, mapping) {
  const text = copy.timing;
  const wallX = stage.toX(TIMING_WALL);
  const parts = [
    box(wallX, 34, Math.max(10, 17 * stage.robotScale), stage.ground - 34, '#8e9da5'),
    label(stage.width - 6, 18, text.realWall, {
      size: TEXT_SMALL,
      anchor: 'end',
      color: SOFT_INK,
      bounds: stage.bounds,
    }),
  ];
  if (mapping) return parts;
  const targetX = stage.toX(TIMING_TARGET);
  const thresholdX = stage.toX(TIMING_WALL - TIMING_STOP_RANGE);
  const threshold = sceneRole('target');
  parts.push(
    line(targetX, 24, targetX, stage.ground, GOAL_LINE, 3),
    label(targetX - 4, 18, text.target, {
      color: GOAL_LINE,
      size: TEXT_SMALL,
      anchor: 'end',
      bounds: stage.bounds,
    }),
    line(thresholdX, 42, thresholdX, stage.ground, threshold.color, 2, threshold.dash),
    label(thresholdX - 4, 36, text.threshold, {
      color: threshold.color,
      size: TEXT_SMALL,
      anchor: 'end',
      bounds: stage.bounds,
    }),
  );
  return parts;
}

function timingScene(run, index, options) {
  const text = copy.timing;
  const sample = run.samples[index];
  const mapping = run.topic === 'alignment';
  const stage = sideStage(options, TIMING_EXTENT);
  const hasData = sample.measuredX !== null;
  const ghost =
    hasData && sample.x - sample.measuredX > 0.04
      ? sideView(stage.toX(sample.measuredX), stage.ground, stage.robotScale, 0.35)
      : nothing;
  const body = [
    floorAxis(stage, TIMING_EXTENT),
    timingGuides(stage, mapping),
    ghost,
    hasData ? (mapping ? mapParts(sample, stage) : rangeParts(sample, stage)) : nothing,
    sideView(stage.toX(sample.x), stage.ground, stage.robotScale),
  ];
  const description =
    fill(text.description, {
      stamp: num(sample.stamp, 2),
      receive: num(sample.receive, 2),
      now: num(sample.t, 2),
    }) +
    (mapping ? text.mapDescription : text.rangeDescription) +
    sample.status;
  return html`${timeBand(sample, options.started)}
  ${run.topic === 'queue' ? queueRow(run, sample, options.started) : nothing}
  ${stageSvg(stage, body, description)} ${timingKey(mapping)}`;
}

function timingKey(mapping) {
  const keys = copy.timing.keys;
  if (mapping)
    return sceneKey([
      { text: keys.mapWall, role: 'measured' },
      { text: keys.realWall },
      { text: keys.ghost },
    ]);
  return sceneKey([
    { text: keys.usedRange, role: 'measured' },
    { text: keys.actualRange, role: 'actual' },
    { text: keys.target },
    { text: keys.threshold, role: 'target' },
    { text: keys.ghost },
  ]);
}

// ① measured → ② received → ③ used, placed on a short time axis ending now, so the age of the
// value in use is a length the learner can see.
function timeBand(sample, started) {
  const text = copy.timing.stages;
  if (!started || sample.stamp === null)
    return html`<div class="sys-timeband">
      <p class="sys-timeband-title">${text.title}</p>
      <p>${text.waiting}</p>
    </div>`;
  const age = sample.t - sample.stamp;
  const window = Math.max(TIMELINE_MIN_WINDOW, age * 1.25);
  const at = (time) => clamp(((time - (sample.t - window)) / window) * 100, 0, 100);
  const stages = [
    { name: text.measured, time: sample.stamp },
    { name: text.received, time: sample.receive },
    { name: text.used, time: sample.t },
  ];
  return html`<div class="sys-timeband">
    <p class="sys-timeband-title">${text.title}</p>
    <div class="sys-timeline" aria-hidden="true">
      <span class="sys-timeline-age" style="left:${at(sample.stamp)}%;right:0"></span>
      ${stages.map(
        (stage, position) =>
          html`<span
            class="sys-timeline-mark"
            data-stage=${position + 1}
            style="left:${at(stage.time)}%"
          ></span>`,
      )}
    </div>
    <ol class="sys-timeband-stages">
      ${stages.map((stage) => html`<li><span>${stage.name}</span><strong>${num(stage.time, 2)}秒</strong></li>`)}
    </ol>
    <p class="sys-timeband-age">${fill(text.age, { age: num(age, 2) })}</p>
  </div>`;
}

// The waiting ranges as a row of boxes, oldest on the left. With no transport delay (the queue
// topic) every step's measurement has arrived, so the waiting ones are the steps after the one
// in use.
function queueRow(run, sample, started) {
  const text = copy.timing.queue;
  if (!started) return nothing;
  const shown = Math.min(sample.queue, QUEUE_BOXES);
  const boxes = Array.from({ length: shown }, (_, position) => position);
  const latest = run.config.queue === 'latest';
  return html`<div class="sys-queue" data-queue=${sample.queue}>
    <p class="sys-timeband-title">${text.title}</p>
    <div class="sys-queue-row">
      ${
        sample.stamp === null
          ? nothing
          : html`<span class="sys-queue-using"
              >${fill(text.using, { stamp: num(sample.stamp, 2) })}</span
            >`
      }
      ${boxes.map((position) => html`<i class="sys-queue-box" title=${num(sample.stamp + (position + 1) * SAMPLE_PERIOD, 2)}></i>`)}
      ${
        sample.queue > QUEUE_BOXES
          ? html`<span class="sys-queue-more"
              >${fill(text.more, { count: sample.queue - QUEUE_BOXES })}</span
            >`
          : nothing
      }
      ${sample.queue === 0 ? html`<span class="sys-queue-more">${text.empty}</span>` : nothing}
    </div>
    ${latest ? html`<p class="sys-queue-note">${text.latest}</p>` : nothing}
  </div>`;
}

// --- the tracking scene: the room from above ---------------------------------------------------

const TRACKING_Y_MIN = -1.6; // metres across the room (the other robot's lane), left edge
const TRACKING_Y_SPAN = 5.4; // metres
const TRACKING_ROBOT_RADIUS = 0.18; // m; collision circle of either robot
const TRACKING_LANE_HALF = 0.32; // m; half width of the pale strip drawn as the route
const TRACKING_MARGIN = 12; // px
const TRACKING_MAX_HEIGHT = { wide: 360, narrow: 300 }; // px

function trackingStage(options, crossing) {
  const width = options.sceneWidth;
  const [low, high] = crossing ? [0.1, 4.75] : [0.1, 3.55];
  const maxHeight = options.narrow ? TRACKING_MAX_HEIGHT.narrow : TRACKING_MAX_HEIGHT.wide;
  const k = Math.min(
    (width - 2 * TRACKING_MARGIN) / TRACKING_Y_SPAN,
    (maxHeight - 2 * TRACKING_MARGIN) / (high - low),
  );
  const used = TRACKING_Y_SPAN * k;
  const left = (width - used) / 2;
  return {
    width,
    height: (high - low) * k + 2 * TRACKING_MARGIN,
    k,
    left,
    right: left + used,
    bounds: [left + 4, left + used - 4],
    radius: TRACKING_ROBOT_RADIUS * k,
    // Rotate the room, not the simulation: QUESTiX faces up and its target crosses sideways.
    toX: (y) => left + (y - TRACKING_Y_MIN) * k,
    toY: (x) => TRACKING_MARGIN + (high - x) * k,
  };
}

function arrow(x1, y1, x2, y2, color) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = 8;
  return [
    line(x1, y1, x2, y2, color, 2.5),
    line(
      x2,
      y2,
      x2 - head * Math.cos(angle - 0.55),
      y2 - head * Math.sin(angle - 0.55),
      color,
      2.5,
    ),
    line(
      x2,
      y2,
      x2 - head * Math.cos(angle + 0.55),
      y2 - head * Math.sin(angle + 0.55),
      color,
      2.5,
    ),
  ];
}

function trackingRobot(stage, x, y, angle, isTarget = false) {
  const ring = isTarget ? '#aebec5' : '#82cfb5';
  return svg`<g data-tracking-robot=${isTarget ? 'target' : 'questix'}>
    ${circle(x, y, stage.radius, ring, isTarget ? '#6e859042' : '#67b59920')}
    ${topView(
      x,
      y,
      angle,
      stage.radius / 37,
      isTarget ? OTHER_ACCENT : ROBOT_ACCENT,
      isTarget ? '#8a979d' : '#92d1fd',
    )}
  </g>`;
}

// Past measurements, one faint dot each ("足あと"), then the latest one on top of everything.
function measurementTrail(run, index, stage, laneY) {
  const measured = sceneRole('measured');
  const dots = [];
  for (const sample of run.samples.slice(0, index + 1))
    if (Math.abs(sample.t - sample.obs.t) < EPSILON)
      dots.push(circle(stage.toX(sample.obs.y), laneY, 3, measured.color, measured.color, 1));
  return svg`<g opacity=".45">${dots}</g>`;
}

function positionAxis(stage, laneY) {
  const axisY = laneY - TRACKING_LANE_HALF * stage.k - 30;
  const ticks = [-1, 0, 1, 2, 3];
  return [
    label(stage.left + 8, axisY - 16, copy.tracking.positionAxis, {
      color: SOFT_INK,
      size: TEXT_SMALL,
    }),
    line(stage.toX(-1.2), axisY, stage.toX(3.4), axisY, '#718d99', 1),
    ticks.map((metre) => [
      // Faint tick lines run down to the route so a position can be read off where the robot is.
      line(
        stage.toX(metre),
        axisY,
        stage.toX(metre),
        laneY + TRACKING_LANE_HALF * stage.k,
        '#718d99',
        1,
        '2 5',
      ),
      label(stage.toX(metre), axisY - 3, String(metre), {
        color: SOFT_INK,
        size: TEXT_SMALL,
        anchor: 'middle',
        halo: ROOM_FLOOR,
      }),
    ]),
  ];
}

function forecastParts(run, sample, stage, laneY) {
  if (run.topic !== 'prediction' || !sample.predicted) return nothing;
  const plan = sceneRole('plan');
  const measuredX = stage.toX(sample.obs.y);
  const forecastX = clamp(stage.toX(sample.predicted.y), stage.left + 6, stage.right - 6);
  const offscreen = forecastX !== stage.toX(sample.predicted.y);
  return [
    line(measuredX, laneY, forecastX, laneY, plan.color, 2, plan.dash),
    svg`<circle
      data-tracking-forecast
      cx=${forecastX}
      cy=${laneY}
      r=${stage.radius + 5}
      fill="none"
      stroke=${plan.color}
      stroke-width="3"
      stroke-dasharray=${plan.dash}
      vector-effect="non-scaling-stroke"
    />`,
    label(
      forecastX,
      laneY - stage.radius - 12,
      offscreen
        ? copy.tracking.offscreenForecast
        : fill(copy.tracking.forecastPosition, { time: num(sample.predicted.targetTime, 1) }),
      {
        color: plan.color,
        size: TEXT_SMALL,
        anchor: 'middle',
        bounds: stage.bounds,
        halo: ROOM_FLOOR,
      },
    ),
  ];
}

// What the crossing rule looks at: the circle the measured point must stay out of ("今の距離
// だけ"), or where both robots will be when they come closest ("この先の接近も予測する").
function crossingRuleParts(run, sample, stage) {
  const text = copy.tracking;
  const view = crossingForecast(sample, run.config);
  const questixX = stage.toX(sample.y);
  const questixY = stage.toY(sample.x);
  if (run.config.rule !== 'predict') {
    const target = sceneRole('target');
    const radius = view.current.clearance * stage.k;
    return [
      circle(questixX, questixY, radius, target.color, 'none', 2, target.dash),
      label(
        questixX - radius - 4,
        questixY + 4,
        fill(text.stopCircle, { radius: view.current.clearance }),
        {
          color: target.color,
          size: TEXT_SMALL,
          anchor: 'end',
          bounds: stage.bounds,
          halo: ROOM_FLOOR,
        },
      ),
    ];
  }
  if (sample.velocity === null) return nothing;
  const plan = sceneRole('plan');
  const self = { x: stage.toX(view.forecast.self.y), y: stage.toY(view.forecast.self.x) };
  const other = {
    x: clamp(stage.toX(view.forecast.other.y), stage.left, stage.right),
    y: stage.toY(view.forecast.other.x),
  };
  const close = view.forecast.gap < view.forecast.clearance;
  return [
    circle(self.x, self.y, stage.radius, plan.color, 'none', 2, plan.dash),
    circle(other.x, other.y, stage.radius, plan.color, 'none', 2, plan.dash),
    line(self.x, self.y, other.x, other.y, plan.color, close ? 3 : 1.5, plan.dash),
    label(
      Math.max(self.x, other.x) + stage.radius + 6,
      (self.y + other.y) / 2 + 4,
      fill(text.closest, { after: num(view.forecast.after, 1), gap: num(view.forecast.gap, 2) }),
      {
        color: plan.color,
        size: TEXT_SMALL,
        weight: close ? 600 : nothing,
        bounds: stage.bounds,
        halo: ROOM_FLOOR,
      },
    ),
  ];
}

function crossingGoal(sample, stage, laneY) {
  const questixX = stage.toX(sample.y);
  const goalY = stage.toY(4.4);
  return [
    box(
      questixX - stage.radius * 1.8,
      goalY - stage.radius * 1.5,
      stage.radius * 3.6,
      stage.toY(0.2) - goalY + stage.radius * 1.5,
      '#78c8a915',
      { rx: 6 },
    ),
    line(questixX, stage.toY(0.3), questixX, goalY, '#86bda8', 1.5, '8 9'),
    circle(questixX, goalY, stage.radius, '#92d8bd'),
    label(questixX + stage.radius + 6, goalY + 5, copy.tracking.goal, {
      color: '#b5e8d4',
      size: TEXT_BODY,
      halo: ROOM_FLOOR,
    }),
    label(
      questixX + stage.radius + 6,
      laneY - TRACKING_LANE_HALF * stage.k - 6,
      copy.tracking.crossingPoint,
      {
        color: '#e0dbb8',
        size: TEXT_SMALL,
        bounds: stage.bounds,
        halo: ROOM_FLOOR,
      },
    ),
  ];
}

function trackingScene(run, index, options) {
  const text = copy.tracking;
  const sample = run.samples[index];
  const crossing = run.topic === 'crossing';
  const stage = trackingStage(options, crossing);
  const laneY = stage.toY(sample.cart.x);
  const questixX = stage.toX(sample.y);
  const questixY = stage.toY(sample.x);
  const targetX = stage.toX(sample.cart.y);
  const measuredX = stage.toX(sample.obs.y);
  const direction = sample.actualVelocity < 0 ? -1 : 1;
  const contact = crossing && sample.status === STATUS.contact;
  const measured = sceneRole('measured');
  const laneHalf = TRACKING_LANE_HALF * stage.k;
  const body = [
    box(stage.left, 4, stage.right - stage.left, stage.height - 8, ROOM_FLOOR, { rx: 10 }),
    box(stage.left, laneY - laneHalf, stage.right - stage.left, 2 * laneHalf, '#bacad010'),
    line(stage.left, laneY - laneHalf, stage.right, laneY - laneHalf, '#76919b', 1),
    line(stage.left, laneY + laneHalf, stage.right, laneY + laneHalf, '#76919b', 1),
    label(stage.left + 8, laneY + laneHalf + 16, text.otherRoute, {
      color: SOFT_INK,
      size: TEXT_SMALL,
      halo: ROOM_FLOOR,
    }),
    crossing ? crossingGoal(sample, stage, laneY) : positionAxis(stage, laneY),
    crossing
      ? nothing
      : [
          arrow(
            questixX,
            questixY - stage.radius - 4,
            questixX,
            questixY - stage.radius - 30,
            '#8bd6be',
          ),
          label(questixX + 8, questixY - stage.radius - 22, text.cameraFront, {
            color: '#a6e0cc',
            size: TEXT_SMALL,
            bounds: stage.bounds,
            halo: ROOM_FLOOR,
          }),
        ],
    measurementTrail(run, index, stage, laneY),
    !crossing && sample.previousObs
      ? [
          circle(stage.toX(sample.previousObs.y), laneY, 6, measured.color, 'none', 2),
          line(stage.toX(sample.previousObs.y), laneY, measuredX, laneY, measured.color, 2),
        ]
      : nothing,
    forecastParts(run, sample, stage, laneY),
    crossing ? crossingRuleParts(run, sample, stage) : nothing,
    arrow(
      targetX + direction * (stage.radius + 4),
      laneY,
      clamp(targetX + direction * (stage.radius + 26), stage.left + 4, stage.right - 4),
      laneY,
      '#d9e2e7',
    ),
    trackingRobot(stage, targetX, laneY, direction < 0 ? -90 : 90, true),
    trackingRobot(stage, questixX, questixY, 0),
    line(questixX, questixY - stage.radius, measuredX, laneY, '#83b7ec66', 1.5, '4 7'),
    // The measurement is drawn last and larger than before, with a white edge, so it never
    // hides behind (or looks like part of) the other robot.
    circle(measuredX, laneY, options.narrow ? 7 : 8, '#ffffff', measured.color, 2),
    label(
      clamp(targetX, stage.left + 40, stage.right - 40),
      laneY + laneHalf + 32,
      text.otherRobot,
      {
        color: INK,
        size: TEXT_BODY,
        anchor: 'middle',
        halo: ROOM_FLOOR,
      },
    ),
    label(questixX + stage.radius + 6, questixY + 4, 'QUESTiX', {
      color: '#a6e0cc',
      size: TEXT_BODY,
      halo: ROOM_FLOOR,
      bounds: stage.bounds,
    }),
    contact
      ? [
          circle(
            (targetX + questixX) / 2,
            (laneY + questixY) / 2,
            stage.radius + 10,
            sceneRole('danger').color,
            'none',
            3,
          ),
          label(questixX + stage.radius + 6, questixY + 22, '⚠ ' + text.contact, {
            color: '#ffb7a4',
            size: TEXT_BODY,
            weight: 600,
            halo: ROOM_FLOOR,
            bounds: stage.bounds,
          }),
        ]
      : label(questixX + stage.radius + 6, questixY + 22, trackingStatusLabel(sample, crossing), {
          color: SOFT_INK,
          size: TEXT_SMALL,
          halo: ROOM_FLOOR,
          bounds: stage.bounds,
        }),
  ];
  const description = trackingDescription(run, sample, direction);
  return html`<div class="sys-tracking-scene">
    <div class="sys-tracking-context">
      <strong>${crossing ? text.crossingIntro : text.watchingIntro}</strong>
    </div>
    ${stageSvg(stage, body, description)}
    <div class="sys-tracking-key">
      <span
        ><i class="tracking-measured"></i
        >${fill(text.measuredKey, { interval: num(run.config.interval ?? 0.2, 1) })}<span
          class="sys-tracking-stamp"
          >${fill(text.measurementStamp, { time: num(sample.obs.t, 1) })}</span
        ></span
      >${run.topic === 'prediction' ? forecastKey(run, sample) : nothing}${
        crossing ? crossingKey(run) : nothing
      }
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

function forecastKey(run, sample) {
  const text = copy.tracking;
  const stamp = sample.predicted
    ? fill(text.forecastStamp, { time: num(sample.predicted.targetTime, 1) })
    : text.forecastPending;
  const caption = fill(text.forecastCaption, { horizon: num(run.config.horizon, 1) });
  return html`<span
    ><i class="tracking-predicted"></i>${caption}<span class="sys-tracking-stamp"
      >${stamp}</span
    ></span
  >`;
}

function crossingKey(run) {
  const predicting = run.config.rule === 'predict';
  const role = predicting ? 'plan' : 'target';
  return html`<span
    >${swatch(role)}${predicting ? copy.tracking.predictRuleKey : copy.tracking.currentRuleKey}</span
  >`;
}

// --- coordination: the arm from the side -------------------------------------------------------

const ARM_RANGE = { xMin: -30, xMax: 290, zMin: -25, zMax: 235 }; // mm shown
const ARM_HEIGHT = { wide: 330, narrow: 290 }; // px
const ARM_TICK = 50; // mm between ticks
const ACTUAL_CAMERA = { cameraX: 40, cameraZ: 30, cameraAngle: 10 }; // mm, mm, degrees
const CALIBRATION_MARKERS = [
  { x: 140, z: 80 },
  { x: 210, z: 130 },
  { x: 130, z: 180 },
];
const FIRST_TARGET = { x: 185, z: 145 }; // mm; where the feedback topic's object starts
const CAMERA_AXIS = 55; // mm drawn for each camera axis
const ARM_LINK = '#d6e1e5';
const ARM_FOREARM = '#a8bac2';
const CAMERA_INK = '#e4d9c5';

function armStage(options) {
  const width = options.sceneWidth;
  const height = options.narrow ? ARM_HEIGHT.narrow : ARM_HEIGHT.wide;
  const margin = 26;
  const k = Math.min(
    (width - 2 * margin) / (ARM_RANGE.xMax - ARM_RANGE.xMin),
    (height - 2 * margin) / (ARM_RANGE.zMax - ARM_RANGE.zMin),
  );
  const left = margin + 10;
  return {
    width,
    height,
    k,
    bounds: [6, width - 6],
    toX: (mm) => left + (mm - ARM_RANGE.xMin) * k,
    toY: (mm) => height - margin - (mm - ARM_RANGE.zMin) * k,
  };
}

function shoulderFrame(stage) {
  const text = copy.arm;
  const originX = stage.toX(0);
  const originY = stage.toY(0);
  const ticks = [];
  for (let mm = ARM_TICK; mm <= ARM_RANGE.xMax - 20; mm += ARM_TICK)
    ticks.push([
      line(stage.toX(mm), originY - 4, stage.toX(mm), originY + 4, SOFT_INK, 1.5),
      label(stage.toX(mm), originY + 18, String(mm), {
        color: SOFT_INK,
        size: TEXT_SMALL,
        anchor: 'middle',
      }),
    ]);
  for (let mm = ARM_TICK; mm <= ARM_RANGE.zMax - 20; mm += ARM_TICK)
    ticks.push([
      line(originX - 4, stage.toY(mm), originX + 4, stage.toY(mm), SOFT_INK, 1.5),
      label(originX - 8, stage.toY(mm) + 4, String(mm), {
        color: SOFT_INK,
        size: TEXT_SMALL,
        anchor: 'end',
      }),
    ]);
  return [
    arrow(originX, originY, stage.toX(ARM_RANGE.xMax - 8), originY, SOFT_INK),
    arrow(originX, originY, originX, stage.toY(ARM_RANGE.zMax - 8), SOFT_INK),
    label(stage.toX(ARM_RANGE.xMax - 8), originY - 8, text.xAxis, {
      color: SOFT_INK,
      size: TEXT_SMALL,
      anchor: 'end',
      bounds: stage.bounds,
    }),
    label(originX + 8, stage.toY(ARM_RANGE.zMax - 8) + 4, text.zAxis, {
      color: SOFT_INK,
      size: TEXT_SMALL,
      bounds: stage.bounds,
    }),
    label(originX - 8, originY + 18, text.shoulder, {
      color: SOFT_INK,
      size: TEXT_SMALL,
      anchor: 'end',
      bounds: stage.bounds,
    }),
    ticks,
  ];
}

// The camera body with its own axes (d forward, h up), turned by its mounting angle.
function cameraFrame(stage, camera, ghost = false) {
  const text = copy.arm;
  const origin = { x: stage.toX(camera.cameraX), y: stage.toY(camera.cameraZ) };
  const forward = cameraToBody({ x: CAMERA_AXIS, z: 0 }, camera);
  const up = cameraToBody({ x: 0, z: CAMERA_AXIS }, camera);
  const color = ghost ? sceneRole('measured').color : CAMERA_INK;
  const angle = -camera.cameraAngle;
  return svg`<g opacity=${ghost ? 0.85 : 1}>
    <g transform="translate(${origin.x} ${origin.y}) rotate(${angle})">
      ${box(-12, -7, 24, 14, ghost ? 'none' : '#6f7f86', { rx: 4, stroke: color, strokeWidth: 2, dash: ghost ? '4 3' : undefined })}
    </g>
    ${arrow(origin.x, origin.y, stage.toX(forward.x), stage.toY(forward.z), color)}
    ${arrow(origin.x, origin.y, stage.toX(up.x), stage.toY(up.z), color)}
    ${
      ghost
        ? label(origin.x, origin.y + 22, text.cameraSetting, {
            color,
            size: TEXT_SMALL,
            anchor: 'middle',
            bounds: stage.bounds,
          })
        : [
            label(stage.toX(forward.x) + 4, stage.toY(forward.z) + 4, text.cameraForward, {
              color,
              size: TEXT_SMALL,
              bounds: stage.bounds,
            }),
            label(stage.toX(up.x) + 6, stage.toY(up.z), text.cameraUp, {
              color,
              size: TEXT_SMALL,
              bounds: stage.bounds,
            }),
            label(origin.x + 14, origin.y + 20, text.camera, {
              color,
              size: TEXT_SMALL,
              bounds: stage.bounds,
            }),
          ]
    }
  </g>`;
}

const sameCamera = (a, b) =>
  ['cameraX', 'cameraZ', 'cameraAngle'].every((key) => Math.abs(Number(a[key]) - b[key]) < 0.5);

// Numbered markers where they really are, and where the settings in the form would put them.
function calibrationMarkers(stage, settings) {
  const measured = sceneRole('measured');
  const seen = settings && !sameCamera(settings, ACTUAL_CAMERA);
  return CALIBRATION_MARKERS.map((marker, position) => {
    const x = stage.toX(marker.x);
    const y = stage.toY(marker.z);
    const number = String(position + 1);
    const placed = seen ? cameraToBody(bodyToCamera(marker), settingsCamera(settings)) : null;
    return [
      placed
        ? [
            line(x, y, stage.toX(placed.x), stage.toY(placed.z), measured.color, 1.5, '3 3'),
            circle(
              stage.toX(placed.x),
              stage.toY(placed.z),
              9,
              measured.color,
              SCENE_BACKGROUND,
              2,
            ),
            label(stage.toX(placed.x), stage.toY(placed.z) + 4, number, {
              color: measured.color,
              size: TEXT_SMALL,
              anchor: 'middle',
              halo: '',
            }),
          ]
        : nothing,
      circle(x, y, 11, '#f1ecff', '#3b3553', 2),
      label(x, y + 4, number, {
        color: '#f1ecff',
        size: TEXT_SMALL,
        anchor: 'middle',
        weight: 700,
        halo: '',
      }),
    ];
  });
}

const settingsCamera = (settings) => ({
  cameraX: Number(settings.cameraX),
  cameraZ: Number(settings.cameraZ),
  cameraAngle: Number(settings.cameraAngle),
});

function armScene(run, index, options) {
  const text = copy.arm;
  const sample = run.samples[index];
  const stage = armStage(options);
  const target = sceneRole('target');
  const measured = sceneRole('measured');
  const toPoint = (point) => ({ x: stage.toX(point.x), y: stage.toY(point.z) });
  const [base, elbow, tip, goal, estimate] = [
    sample.base,
    sample.elbow,
    sample.tip,
    sample.target,
    sample.estimate,
  ].map(toPoint);
  const camera = toPoint({ x: ACTUAL_CAMERA.cameraX, z: ACTUAL_CAMERA.cameraZ });
  const raw = run.topic === 'frames' && !run.config.transform;
  const moved = run.topic === 'feedback' && sample.target.x !== FIRST_TARGET.x;
  const settings = run.topic === 'calibrate' ? options.settings : null;
  const body = [
    shoulderFrame(stage),
    run.topic === 'calibrate' ? calibrationMarkers(stage, settings) : nothing,
    settings && !sameCamera(settings, ACTUAL_CAMERA)
      ? cameraFrame(stage, settingsCamera(settings), true)
      : nothing,
    cameraFrame(stage, ACTUAL_CAMERA),
    line(camera.x, camera.y, goal.x, goal.y, '#708995', 1.5, '5 5'),
    moved
      ? [
          box(stage.toX(FIRST_TARGET.x) - 11, stage.toY(FIRST_TARGET.z) - 11, 22, 22, 'none', {
            rx: 3,
            stroke: target.color,
            strokeWidth: 1.5,
            dash: '3 4',
          }),
          label(stage.toX(FIRST_TARGET.x), stage.toY(FIRST_TARGET.z) - 16, text.objectBefore, {
            color: SOFT_INK,
            size: TEXT_SMALL,
            anchor: 'middle',
            bounds: stage.bounds,
          }),
        ]
      : nothing,
    line(base.x, base.y, elbow.x, elbow.y, ARM_LINK, 12),
    line(elbow.x, elbow.y, tip.x, tip.y, ARM_FOREARM, 10),
    [base, elbow, tip].map((joint) => circle(joint.x, joint.y, 7, '#e8f0f2', '#203c48')),
    box(goal.x - 12, goal.y - 12, 24, 24, target.color + '40', {
      rx: 3,
      stroke: target.color,
      strokeWidth: 2.5,
    }),
    label(goal.x + 16, goal.y - 10, text.object, {
      color: target.color,
      size: TEXT_BODY,
      weight: 600,
      bounds: stage.bounds,
    }),
    circle(estimate.x, estimate.y, 9, '#ffffff', measured.color, 2),
    label(estimate.x + 14, estimate.y + 18, raw ? text.estimateRaw : text.estimate, {
      color: measured.color,
      size: TEXT_SMALL,
      bounds: stage.bounds,
    }),
  ];
  return html`${stageSvg(stage, body, sceneDescription(sample))} ${armKey(run, settings)}`;
}

function armKey(run, settings) {
  const keys = copy.arm.keys;
  const calibrating = run.topic === 'calibrate';
  return sceneKey([
    { text: keys.object, role: 'target' },
    { text: keys.estimate, role: 'measured' },
    { text: keys.shoulderFrame },
    { text: keys.cameraFrame },
    calibrating ? { text: keys.markers } : null,
    calibrating && settings && !sameCamera(settings, ACTUAL_CAMERA)
      ? { text: keys.markersSeen, role: 'measured', dash: '3 3' }
      : null,
    calibrating ? { text: keys.cameraSetting, role: 'measured', dash: '4 3' } : null,
    run.topic === 'feedback' ? { text: keys.objectBefore, role: 'target' } : null,
  ]);
}

// --- behavior: the room from above, and the state diagram --------------------------------------

const ROOM_X = [0, 4.8]; // metres across
const ROOM_Y = [0.3, 2.8]; // metres down the screen
const ROOM_HEIGHT = { wide: 250, narrow: 220 }; // px

function roomStage(options) {
  const width = options.sceneWidth;
  const height = options.narrow ? ROOM_HEIGHT.narrow : ROOM_HEIGHT.wide;
  const margin = 14;
  const kx = (width - 2 * margin) / (ROOM_X[1] - ROOM_X[0]);
  const ky = (height - 2 * margin) / (ROOM_Y[1] - ROOM_Y[0]);
  return {
    width,
    height,
    bounds: [6, width - 6],
    robotScale: clamp(width / 800, 0.62, 1) * 0.8,
    toX: (x) => margin + (x - ROOM_X[0]) * kx,
    toY: (y) => margin + (y - ROOM_Y[0]) * ky,
    kx,
    ky,
  };
}

function parcelParts(run, sample, stage) {
  const text = copy.room;
  const place = BEHAVIOR_PLACES;
  const at = (point) => ({ x: stage.toX(point.x), y: stage.toY(point.y) });
  const size = 16;
  const parcel = (point) => [
    box(at(point).x - size / 2, at(point).y - size / 2, size, size, '#dab57e', { rx: 3 }),
    label(at(point).x, at(point).y - 14, text.parcel, {
      size: TEXT_SMALL,
      anchor: 'middle',
      bounds: stage.bounds,
      halo: ROOM_FLOOR,
    }),
  ];
  if (run.topic !== 'missing') return sample.hasParcel ? nothing : parcel(place.parcel);
  const empty = at(place.parcel);
  const candidate = at(place.elsewhere);
  return [
    box(empty.x - size / 2, empty.y - size / 2, size, size, 'none', {
      rx: 3,
      stroke: SOFT_INK,
      strokeWidth: 1.5,
      dash: '3 3',
    }),
    label(empty.x, empty.y + 24, text.noParcel, {
      color: SOFT_INK,
      size: TEXT_SMALL,
      anchor: 'middle',
      bounds: stage.bounds,
      halo: ROOM_FLOOR,
    }),
    sample.hasParcel
      ? nothing
      : [
          box(candidate.x - size / 2, candidate.y - size / 2, size, size, 'none', {
            rx: 3,
            stroke: '#dab57e',
            strokeWidth: 1.5,
            dash: '3 3',
          }),
          label(candidate.x, candidate.y + 4, text.candidate, {
            color: '#dab57e',
            size: TEXT_SMALL,
            anchor: 'middle',
            weight: 700,
            halo: '',
          }),
          label(candidate.x + 14, candidate.y + 4, text.candidateLabel, {
            color: '#dab57e',
            size: TEXT_SMALL,
            bounds: stage.bounds,
            halo: ROOM_FLOOR,
          }),
        ],
  ];
}

function roomScene(run, index, options) {
  const text = copy.room;
  const sample = run.samples[index];
  const stage = roomStage(options);
  const place = BEHAVIOR_PLACES;
  const at = (point) => ({ x: stage.toX(point.x), y: stage.toY(point.y) });
  // Every third sample is enough for a smooth trail and keeps the path short.
  const trail = run.samples
    .slice(0, index + 1)
    .filter((_, position) => position % 3 === 0)
    .map(
      (point, position) =>
        (position ? 'L' : 'M') + at(point).x.toFixed(1) + ',' + at(point).y.toFixed(1),
    )
    .join('');
  const detour = [at(place.detour[0]), ...place.detour.slice(1).map(at)];
  const obstacle = place.obstacle;
  const delivery = at(place.delivery);
  const actual = sceneRole('actual');
  const plan = sceneRole('plan');
  const target = sceneRole('target');
  const body = [
    box(4, 4, stage.width - 8, stage.height - 8, ROOM_FLOOR, { rx: 8 }),
    run.topic === 'blocked'
      ? [
          svg`<path
            d=${detour.map((point, position) => (position ? 'L' : 'M') + point.x + ',' + point.y).join('')}
            fill="none"
            stroke=${plan.color}
            stroke-width="2"
            stroke-dasharray=${plan.dash}
            opacity=".7"
            vector-effect="non-scaling-stroke"
          />`,
          label(detour[1].x, detour[1].y - 8, text.detour, {
            color: plan.color,
            size: TEXT_SMALL,
            anchor: 'end',
            bounds: stage.bounds,
            halo: ROOM_FLOOR,
          }),
        ]
      : nothing,
    svg`<path d=${trail} fill="none" stroke=${actual.color} stroke-width="2" vector-effect="non-scaling-stroke" />`,
    circle(delivery.x, delivery.y, 22, target.color, 'none', 2, target.dash),
    label(delivery.x, delivery.y - 30, text.delivery, {
      size: TEXT_SMALL,
      anchor: 'middle',
      bounds: stage.bounds,
      halo: ROOM_FLOOR,
    }),
    parcelParts(run, sample, stage),
    sample.blocked
      ? [
          box(
            stage.toX(obstacle.x),
            stage.toY(obstacle.y),
            obstacle.w * stage.kx,
            obstacle.h * stage.ky,
            '#ab7459',
            { rx: 5 },
          ),
          label(stage.toX(obstacle.x + obstacle.w / 2), stage.toY(obstacle.y) + 16, text.obstacle, {
            color: '#ffe3cf',
            size: TEXT_SMALL,
            anchor: 'middle',
            bounds: stage.bounds,
            halo: '#ab7459',
          }),
        ]
      : nothing,
    topView(at(sample).x, at(sample).y, (sample.theta * 180) / Math.PI + 90, stage.robotScale),
    sample.hasParcel ? box(at(sample).x - 6, at(sample).y - 6, 12, 12, '#e2bd80') : nothing,
  ];
  return html`${stageSvg(stage, body, sceneDescription(sample))} ${roomKey(run)}`;
}

function roomKey(run) {
  const keys = copy.room.keys;
  return sceneKey([
    { text: keys.trail, role: 'actual' },
    run.topic === 'blocked' ? { text: keys.detour, role: 'plan' } : null,
    run.topic === 'missing' ? { text: keys.noParcel } : null,
    run.topic === 'missing' ? { text: keys.candidate } : null,
  ]);
}

// The status names core.js reports, by the state they stand for.
const STATE_IDS = Object.fromEntries(
  Object.entries(STATUS.behavior).map(([id, name]) => [name, id]),
);

/** The transitions of a topic: `[from, to, condition key, used by this run's rules]`. */
function stateEdges(run) {
  const config = run.config;
  if (run.topic === 'missing') {
    const search = config.searchRule === 'search';
    return [
      ['toParcel', 'toElsewhere', 'notThere', search],
      ['toParcel', 'toDelivery', search ? 'pickedUp' : 'keepGoing', true],
      ['toElsewhere', 'toDelivery', 'foundElsewhere', search],
      ['toDelivery', 'arrivedEmpty', 'arrivedWithout', true],
      ['toDelivery', 'delivered', 'arrivedWith', true],
    ];
  }
  const detour = run.topic === 'blocked';
  return [
    ['toParcel', 'toDelivery', 'pickedUp', true],
    ['toDelivery', 'waiting', 'blocked', true],
    ['waiting', 'toDelivery', 'clear', true],
    ['toDelivery', 'delivered', 'arrived', true],
    detour ? ['waiting', 'detour', 'timeout', config.blockedRule === 'detour'] : null,
    detour ? ['detour', 'delivered', 'detourArrived', config.blockedRule === 'detour'] : null,
  ].filter(Boolean);
}

// The last change of state at or before the sample shown, as [from, to] state ids.
function lastTransition(run, index) {
  for (let position = index; position > 0; position--)
    if (run.samples[position].status !== run.samples[position - 1].status)
      return [STATE_IDS[run.samples[position - 1].status], STATE_IDS[run.samples[position].status]];
  return null;
}

// Grid rows of the diagram (three columns: main flow, arrows between, side states). Each cell is
// a state id, an edge index into stateEdges(), or null.
const STATE_LAYOUT = {
  flow: [
    ['toParcel', null, null],
    [{ edge: 0, arrow: '↓' }, null, null],
    [
      'toDelivery',
      [
        { edge: 1, arrow: '→' },
        { edge: 2, arrow: '←' },
      ],
      'waiting',
    ],
    [{ edge: 3, arrow: '↓' }, null, { edge: 4, arrow: '↓' }],
    ['delivered', [{ edge: 5, arrow: '←' }], 'detour'],
  ],
  missing: [
    ['toParcel', [{ edge: 0, arrow: '→' }], 'toElsewhere'],
    [{ edge: 1, arrow: '↓' }, null, { edge: 2, arrow: '↙' }],
    ['toDelivery', [{ edge: 3, arrow: '→' }], 'arrivedEmpty'],
    [{ edge: 4, arrow: '↓' }, null, null],
    ['delivered', null, null],
  ],
};

function stateDiagram(run, index) {
  const text = copy.states;
  const edges = stateEdges(run);
  const current = STATE_IDS[run.samples[index].status];
  const taken = lastTransition(run, index);
  const usedStates = new Set(edges.filter((edge) => edge[3]).flatMap((edge) => [edge[0], edge[1]]));
  const layout = run.topic === 'missing' ? STATE_LAYOUT.missing : STATE_LAYOUT.flow;
  const conditionText = (key) =>
    fill(text.conditions[key], { timeout: num(run.config.timeout, 1) });
  const edgeCell = (cell) => {
    const edge = edges[cell.edge];
    if (!edge) return null;
    const active = taken && taken[0] === edge[0] && taken[1] === edge[1];
    return html`<p class="sys-edge" ?data-active=${active} ?data-unused=${!edge[3]}>
      <span aria-hidden="true">${cell.arrow}</span>${conditionText(edge[2])}${
        edge[3] ? nothing : html`<small>${text.unused}</small>`
      }
    </p>`;
  };
  const cellTemplate = (cell) => {
    if (cell === null) return html`<div></div>`;
    if (typeof cell === 'string') {
      if (!usedStates.has(cell) && !edges.some((edge) => edge[0] === cell || edge[1] === cell))
        return html`<div></div>`;
      return html`<div
        class="sys-state"
        data-state=${cell}
        aria-current=${cell === current ? 'step' : 'false'}
        ?data-unused=${!usedStates.has(cell)}
      >
        ${cell === current ? html`<small>${text.now}</small>` : nothing}${text.names[cell]}
      </div>`;
    }
    const cells = (Array.isArray(cell) ? cell : [cell]).map(edgeCell).filter(Boolean);
    return html`<div class="sys-edges">${cells}</div>`;
  };
  return html`<figure class="sys-states" data-sys-states>
    <figcaption>${text.title}</figcaption>
    <div class="sys-states-grid">${layout.flatMap((row) => row.map(cellTemplate))}</div>
  </figure>`;
}

function systemScene(run, index, options = DEFAULT_OPTIONS) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  if (run.course === 'timing') return timingScene(run, index, settings);
  if (run.course === 'tracking') return trackingScene(run, index, settings);
  if (run.course === 'coordination') return armScene(run, index, settings);
  if (run.course === 'behavior') return roomScene(run, index, settings);
  if (run.course === 'diagnostics') return diagnosticsScene(run, index, settings);
  return mechanicsScene(run, index, settings);
}

// --- charts -----------------------------------------------------------------------------------

// Chart titles, units and lines (sample key, label, short direct label, role) per course.
const SYSTEM_CHARTS = copy.charts;

const CHART_HEIGHT = { wide: 210, narrow: 200 }; // px, including the axis labels
const CHART_TOP = 34; // px above the plot: two lanes of event labels, or the state band
const CHART_BOTTOM = 24; // px below the plot: the time tick labels
const CHART_LEFT = 46; // px for the value tick labels
const CHART_RIGHT = 12;
const EVENT_LANES = [13, 27]; // baselines of the event labels
const LABEL_GAP = 14; // px between two direct labels at line ends
const ACTUAL_UNDER_WIDTH = 7; // px; the true value drawn under a measured line
const TRANSITION_KINDS = [
  'power-off',
  'brake',
  'data-loss',
  'shock',
  'turn',
  'stop-command',
  'target-move',
];
const DERIVED = { deliveryDistance };

const valueOf = (sample, key) => {
  const value = DERIVED[key] ? DERIVED[key](sample) : sample[key];
  return Number.isFinite(value) ? value : null;
};

// The first diagnostics chart shows different sensors depending on the experiment; a line may be
// limited to some topics (the force topic has no wheel slip, so one speed line).
function chartFor(run, chartIndex) {
  const chart = SYSTEM_CHARTS[run.course][chartIndex] || SYSTEM_CHARTS[run.course][0];
  let lines = chart.lines;
  if (run.course === 'diagnostics' && chartIndex === 0)
    lines =
      run.topic === 'missing'
        ? copy.diagnosticsSensorLines.missing
        : copy.diagnosticsSensorLines.shelf;
  return {
    ...chart,
    lines: lines.filter((entry) => !entry.topics || entry.topics.includes(run.topic)),
  };
}

// Where the experiment decides to stop, drawn as a dashed line (or a band for |a| ≥ limit).
function chartThreshold(run, chartIndex) {
  const text = copy.thresholds;
  const config = run.config;
  if (run.course === 'timing' && chartIndex === 0)
    return {
      value: TIMING_STOP_RANGE,
      label: fill(text.timingStop, { value: num(TIMING_STOP_RANGE, 1) }),
    };
  if (run.course !== 'diagnostics') return null;
  if (run.topic === 'distance' && chartIndex === 0)
    return {
      value: config.stopDistance,
      label: fill(text.stopDistance, { value: num(config.stopDistance, 2) }),
    };
  if (run.topic === 'missing' && chartIndex === 1 && config.watchdog)
    return {
      value: config.staleLimit,
      label: fill(text.staleLimit, { value: num(config.staleLimit, 1) }),
    };
  if (run.topic === 'impact' && chartIndex === 2)
    return {
      value: config.impactLimit,
      band: true,
      label: fill(text.impactBand, { value: num(config.impactLimit, 0) }),
    };
  return null;
}

// Moments the text asks the learner to look for, as [{t, label}].
function chartEvents(run) {
  if (run.course === 'behavior') return [];
  const marks = [];
  for (const event of run.events) {
    if (TRANSITION_KINDS.includes(event.kind)) marks.push({ t: event.t, label: event.label });
    else if (event.kind === 'contact') marks.push({ t: event.t, label: copy.chartEvents.contact });
    else if (run.course === 'diagnostics' && !event.kind)
      marks.push({ t: event.t, label: copy.chartEvents.stop });
    else if (run.topic === 'crossing' && event.t > 0)
      marks.push({
        t: event.t,
        label: event.text === STATUS.contact ? copy.chartEvents.contact : event.text,
      });
  }
  return marks;
}

// One polyline per chart line; a gap in the data starts a new sub-path instead of a straight jump.
function linePath(samples, key, toX, toY) {
  let connected = false;
  return samples
    .map((sample) => {
      const value = valueOf(sample, key);
      if (value === null) {
        connected = false;
        return '';
      }
      const command = connected ? 'L' : 'M';
      connected = true;
      return command + toX(sample.t).toFixed(1) + ',' + toY(value).toFixed(1);
    })
    .join('');
}

function chartScales(run, chart, previous, threshold, plot) {
  const values = [];
  for (const source of [run, previous].filter(Boolean))
    for (const sample of source.samples)
      for (const entry of chart.lines) values.push(valueOf(sample, entry.key));
  if (threshold) values.push(threshold.value, ...(threshold.band ? [-threshold.value] : []));
  const y = niceScale(
    values.filter((value) => value !== null),
    { integer: Boolean(chart.integer), ticks: plot.height < 140 ? 4 : 5 },
  );
  const duration = Math.max(run.duration, previous?.duration ?? 0);
  const x = niceScale([0, duration], { ticks: Math.max(3, Math.floor(plot.width / 80)) });
  return {
    x,
    y,
    toX: scaleTo(x, plot.left, plot.left + plot.width),
    toY: scaleTo(y, plot.top + plot.height, plot.top),
  };
}

function chartGrid(scales, plot) {
  const axis = chartRole('grid');
  return [
    scales.y.ticks.map((value) => [
      line(
        plot.left,
        scales.toY(value),
        plot.left + plot.width,
        scales.toY(value),
        value === 0 ? chartRole('axis').color : axis.color,
        value === 0 ? 2 : 1,
      ),
      label(plot.left - 6, scales.toY(value) + 4, formatTick(value, scales.y.step), {
        color: chartRole('axis').color,
        size: TEXT_SMALL,
        anchor: 'end',
        halo: '',
      }),
    ]),
    scales.x.ticks.map((time) => [
      line(
        scales.toX(time),
        plot.top + plot.height,
        scales.toX(time),
        plot.top + plot.height + 5,
        axis.color,
        1,
      ),
      label(scales.toX(time), plot.top + plot.height + 18, formatTick(time, scales.x.step), {
        color: chartRole('axis').color,
        size: TEXT_SMALL,
        anchor: 'middle',
        halo: '',
      }),
    ]),
  ];
}

function thresholdParts(threshold, scales, plot) {
  if (!threshold) return nothing;
  const style = chartRole('target');
  const y = scales.toY(threshold.value);
  const right = plot.left + plot.width;
  if (threshold.band) {
    const low = scales.toY(-threshold.value);
    return [
      box_(plot.left, y, plot.width, low - y, style.color, 0.08),
      line(plot.left, y, right, y, style.color, 2, style.dash),
      line(plot.left, low, right, low, style.color, 2, style.dash),
      label(right - 4, y - 5, threshold.label, {
        color: style.color,
        size: TEXT_SMALL,
        anchor: 'end',
        halo: '#ffffff',
        weight: 600,
      }),
    ];
  }
  return [
    line(plot.left, y, right, y, style.color, 2, style.dash),
    label(right - 4, y - 5, threshold.label, {
      color: style.color,
      size: TEXT_SMALL,
      anchor: 'end',
      halo: '#ffffff',
      weight: 600,
    }),
  ];
}

const box_ = (x, y, width, height, fill, opacity) => box(x, y, width, height, fill, { opacity });

// Vertical lines at the events reached so far, labels in two lanes above the plot.
function eventParts(marks, now, scales, plot) {
  const style = chartRole('event');
  const laneEnds = EVENT_LANES.map(() => -Infinity);
  return marks
    .filter((mark) => mark.t <= now + EPSILON)
    .map((mark) => {
      const x = scales.toX(mark.t);
      const width = textWidth(mark.label, TEXT_SMALL);
      const left = clamp(x - width / 2, plot.left, plot.left + plot.width - width);
      let lane = laneEnds.findIndex((end) => end < left - 6);
      if (lane < 0) lane = 0;
      laneEnds[lane] = left + width;
      return [
        line(
          x,
          EVENT_LANES[lane] + 4,
          x,
          plot.top + plot.height,
          style.color,
          style.width,
          style.dash,
        ),
        label(left, EVENT_LANES[lane], mark.label, {
          color: style.color,
          size: TEXT_SMALL,
          halo: '#ffffff',
        }),
      ];
    });
}

// Short labels at the end of each drawn line, pushed apart so they never sit on each other.
function directLabels(chart, seen, scales, plot) {
  const labels = [];
  for (const entry of chart.lines) {
    const last = seen.findLast((sample) => valueOf(sample, entry.key) !== null);
    if (!last) continue;
    labels.push({ entry, x: scales.toX(last.t), y: scales.toY(valueOf(last, entry.key)) - 6 });
  }
  const top = plot.top + 10;
  const bottom = plot.top + plot.height - 4;
  labels.sort((a, b) => a.y - b.y);
  for (const entry of labels) entry.y = clamp(entry.y, top, bottom);
  for (let position = 1; position < labels.length; position++)
    labels[position].y = Math.max(labels[position].y, labels[position - 1].y + LABEL_GAP);
  // Labels pushed below the plot move back up, keeping their spacing.
  for (let position = labels.length - 1; position >= 0; position--) {
    const limit = position === labels.length - 1 ? bottom : labels[position + 1].y - LABEL_GAP;
    labels[position].y = Math.min(labels[position].y, limit);
  }
  return labels.map(({ entry, x, y }) => {
    const nearLeft = x < plot.left + 90;
    return label(nearLeft ? x + 6 : x - 4, y, entry.short, {
      color: chartRole(entry.role).color,
      size: TEXT_SMALL,
      anchor: nearLeft ? 'start' : 'end',
      weight: 600,
      halo: '#ffffff',
      bounds: [plot.left, plot.left + plot.width],
    });
  });
}

// Behaviour: which state the robot was in, as a labelled band above the plot.
const STATE_TONES = {
  toParcel: 'actual',
  toElsewhere: 'actual',
  toDelivery: 'actual',
  waiting: 'target',
  detour: 'plan',
  delivered: 'previous',
  arrivedEmpty: 'previous',
};

function stateBand(run, seen, scales, plot) {
  const segments = [];
  for (const sample of seen) {
    const last = segments.at(-1);
    if (last && last.status === sample.status) last.end = sample.t;
    else segments.push({ status: sample.status, start: sample.t, end: sample.t });
  }
  return segments.map((segment, position) => {
    const next = segments[position + 1];
    const from = scales.toX(segment.start);
    const to = scales.toX(next ? next.start : segment.end);
    const id = STATE_IDS[segment.status];
    const tone = chartRole(STATE_TONES[id] ?? 'previous').color;
    const name = copy.states.names[id] ?? segment.status;
    const fits = textWidth(name, TEXT_SMALL) + 6 < to - from;
    return [
      box(from, 6, Math.max(1, to - from), 22, tone, {
        opacity: 0.22,
        stroke: tone,
        strokeWidth: 1,
      }),
      fits ? label(from + 3, 21, name, { color: '#23363d', size: TEXT_SMALL, halo: '' }) : nothing,
    ];
  });
}

function chartLegend(chart, previous, threshold) {
  return html`<ul class="sys-chart-legend">
    ${chart.lines.map((entry) => html`<li>${swatch(entry.role, entry.dash, 'chart')}${entry.label}</li>`)}
    ${previous ? html`<li>${swatch('previous', undefined, 'chart')}${copy.chart.previousKey}</li>` : nothing}
    ${threshold ? html`<li>${swatch('target', undefined, 'chart')}${threshold.label}</li>` : nothing}
  </ul>`;
}

function chartNote(chart, run) {
  const note = chart.note?.[run.topic] ?? chart.note?.all;
  return note ? html`<p class="sys-chart-note">${note}</p>` : nothing;
}

function systemChart(run, index, chartIndex = 0, previous = null, options = DEFAULT_OPTIONS) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const chart = chartFor(run, chartIndex);
  const seen = run.samples.slice(0, index + 1);
  const threshold = chartThreshold(run, chartIndex);
  const width = settings.chartWidth;
  const height = settings.narrow ? CHART_HEIGHT.narrow : CHART_HEIGHT.wide;
  const plot = {
    left: CHART_LEFT,
    top: CHART_TOP,
    width: width - CHART_LEFT - CHART_RIGHT,
    height: height - CHART_TOP - CHART_BOTTOM,
  };
  const scales = chartScales(run, chart, previous, threshold, plot);
  const quantity = chart.axis ?? chart.title;
  const now = seen.at(-1).t;
  const previousLabelY = previous ? directPreviousLabel(chart, previous, scales) : null;
  return html`<div class="sys-chart">
    <p class="sys-chart-yaxis">${fill(copy.chart.yAxis, { quantity, unit: chart.unit })}</p>
    <svg
      class="sys-chart-svg"
      viewBox="0 0 ${width} ${height}"
      role="img"
      aria-label=${fill(copy.chart.description, { title: chart.title, quantity, unit: chart.unit })}
    >
      <rect width=${width} height=${height} fill="#ffffff" />
      ${chart.band === 'status' ? stateBand(run, seen, scales, plot) : nothing}
      ${chartGrid(scales, plot)} ${thresholdParts(threshold, scales, plot)}
      ${chart.band === 'status' ? nothing : eventParts(chartEvents(run), now, scales, plot)}
      ${
        previous
          ? chart.lines.map((entry) => {
              const style = chartRole('previous');
              return svg`<path
                d=${linePath(previous.samples, entry.key, scales.toX, scales.toY)}
                fill="none"
                stroke=${style.color}
                stroke-width=${style.width}
                stroke-dasharray=${style.dash}
                vector-effect="non-scaling-stroke"
              />`;
            })
          : nothing
      }
      ${previousLabelY}
      ${chart.lines.map((entry) => {
        const style = chartRole(entry.role);
        // With a measured line on top, the true value is a wide translucent band under it, so
        // it stays visible where the two agree.
        const under = entry.role === 'actual' && chart.lines.length > 1;
        return svg`<path
          d=${linePath(seen, entry.key, scales.toX, scales.toY)}
          fill="none"
          stroke=${style.color}
          stroke-width=${under ? ACTUAL_UNDER_WIDTH : style.width}
          stroke-dasharray=${entry.dash ?? (style.dash || nothing)}
          stroke-linejoin="round"
          stroke-linecap="round"
          opacity=${under ? 0.45 : nothing}
          vector-effect="non-scaling-stroke"
        />`;
      })}
      ${directLabels(chart, seen, scales, plot)}
      ${line(scales.toX(now), plot.top, scales.toX(now), plot.top + plot.height, '#627581', 1, '3 4')}
    </svg>
    <p class="sys-chart-xaxis">${copy.chart.xAxis}</p>
    ${chartLegend(chart, previous, threshold)} ${chartNote(chart, run)}
  </div>`;
}

// "前回" once, at the end of the previous run's first line.
function directPreviousLabel(chart, previous, scales) {
  const key = chart.lines[0]?.key;
  const last = previous.samples.findLast((sample) => valueOf(sample, key) !== null);
  if (!last) return nothing;
  return label(scales.toX(last.t) - 4, scales.toY(valueOf(last, key)) + 16, copy.chart.previous, {
    color: chartRole('previous').color,
    size: TEXT_SMALL,
    anchor: 'end',
    halo: '#ffffff',
  });
}

export { SYSTEM_CHARTS, systemChart, systemScene, stateDiagram, chartFor };
