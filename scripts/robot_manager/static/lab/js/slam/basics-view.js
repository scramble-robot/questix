import { html, svg, nothing, unsafeHTML, ifDefined } from '../vendor/lit-html.js';
import { formatNumber } from '../core/dom.js';
import { snapToZero, fillText } from './basics-core.js';
import { questixTopSvg } from '../core/questix-art.js';

// Templates of the introductory SLAM chapters. Every function is pure: it turns the model built
// by basics.js into markup. Learner-facing sentences come from content/slam/basics.json (`copy`);
// only short labels live here. The figure toolkit (`figureArt`) is shared with the concept
// chapters through renderSlamConcept(topic, art).

const GHOST_OPACITY = 0.4; // robot drawn at its start or at its real position
const ROBOT_SIZE = 50; // viewBox units across the robot's top view
// A faint light halo keeps the dark robot visible on the dark figures (as drawQuestixTop does).
const ROBOT_HALO = 'filter: drop-shadow(0 0 3px rgba(214, 238, 244, 0.5))';
const LINE_COLOUR = '#54717e';
const LABEL_COLOUR = '#bdd2da';
const ESTIMATE_COLOUR = '#8ad7c0'; // path or beam computed from the sensor values
const ACTUAL_COLOUR = '#edb372'; // where the robot really went when the wheels slipped
const TURN_ARC_COLOUR = '#9dbbf2';
const OLD_POINT_COLOUR = '#829ca9';
const NEW_POINT_COLOUR = '#efb271';
const BEAM_END_COLOUR = '#f1c382';
const ROOM_WALL_COLOUR = '#65838e';

const WHEEL_PLOT = { originX: 260, originY: 210, scale: 240 }; // pixels per metre
const IMU_PLOT = { originX: 340, originY: 180, scale: 125 };
const LIDAR_PLOT = { originX: 240, originY: 220, scale: 100 };
const TURN_ARC_RADIUS = 0.4; // metres, drawn around the turning robot
const TURN_ARC_SEGMENTS = 30;
const EXAMPLE_SECONDS = 2; // the wheel example always runs for two seconds
const SECONDS_PER_MINUTE = 60;
const ALIGNED_ERROR = 0.035; // metres: below this the scans read as overlapping

const quantity = (value, digits = 2) => formatNumber(snapToZero(value), digits);
const SCALE_BAR_METRES = 0.2; // the wheel figure's scale bar: 20 cm

// A labelled scale bar at the lower right of a plot, so distances can be read off the figure (S5).
function scaleBar(plot, metres, text) {
  const right = 630;
  const left = right - metres * plot.scale;
  return svg`${line(left, 318, right, 318, LABEL_COLOUR, { width: 3 })}${line(left, 312, left, 324, LABEL_COLOUR, { width: 2 })}${line(right, 312, right, 324, LABEL_COLOUR, { width: 2 })}${label(left, 306, text)}`;
}

// An arc of `angle` radians around a plot point, with its value, for the angles the text names.
function angleMark(centre, radius, from, to, text, colour) {
  const steps = 24;
  const points = Array.from({ length: steps + 1 }, (_, i) => {
    const angle = from + ((to - from) * i) / steps;
    return `${centre.x + radius * Math.cos(angle)},${centre.y - radius * Math.sin(angle)}`;
  });
  const middle = (from + to) / 2;
  const at = {
    x: centre.x + (radius + 26) * Math.cos(middle),
    y: centre.y - (radius + 26) * Math.sin(middle),
  };
  return svg`<polyline points=${points.join(' ')} fill="none" stroke=${colour} stroke-width="2"/>${label(at.x - 18, at.y + 5, text, `fill:${colour}`)}`;
}
const degrees = (radians) => (radians * 180) / Math.PI;

// --- figure toolkit -------------------------------------------------------------------------

function figure(body, title) {
  return html`<svg viewBox="0 0 680 360" role="img" aria-label=${title}>
    <defs>
      <pattern id="basicsGrid" width="40" height="40" patternUnits="userSpaceOnUse">
        <path d="M40 0H0V40" fill="none" stroke="#789baa" stroke-opacity=".10" />
      </pattern>
    </defs>
    <rect width="680" height="360" fill="#192f3a" />
    <rect x="30" y="25" width="620" height="310" fill="url(#basicsGrid)" />
    ${body}
  </svg>`;
}

// The robot seen from above (the CAD top view, its front marked by the light-blue line), heading
// `angle` radians (counter-clockwise on the page). The size is a drawing size, not to the plot's
// scale, so the robot stays recognisable on every plot.
function robot(x, y, angle = 0, ghost = false) {
  return svg`<g style=${ROBOT_HALO}>${questixTopSvg(x, y, -degrees(angle), ROBOT_SIZE, ghost ? GHOST_OPACITY : 1)}</g>`;
}

function line(x1, y1, x2, y2, colour = LINE_COLOUR, { width, dash, opacity } = {}) {
  return svg`<line x1=${x1} y1=${y1} x2=${x2} y2=${y2} stroke=${colour} stroke-width=${ifDefined(width)} stroke-dasharray=${ifDefined(dash)} stroke-opacity=${ifDefined(opacity)}/>`;
}

function label(x, y, text, style) {
  return svg`<text x=${x} y=${y} fill=${LABEL_COLOUR} font-size="14" style=${ifDefined(style)}>${text}</text>`;
}

// Polyline of metre coordinates placed on a plot (origin in pixels, y up).
function path(points, plot, colour, dashed = false) {
  const pixels = points
    .map((point) => `${plot.originX + point.x * plot.scale},${plot.originY - point.y * plot.scale}`)
    .join(' ');
  return svg`<polyline points=${pixels} fill="none" stroke=${colour} stroke-width="3" stroke-dasharray=${dashed ? '6 5' : nothing}/>`;
}

function slider({ id, title, min, max, step, value, text, onInput, onChange }) {
  return html`<label class="basics-slider" for=${id}
    ><span>${title}<output id=${id + 'Value'} for=${id}>${text}</output></span
    ><input
      id=${id}
      type="range"
      min=${min}
      max=${max}
      step=${step}
      .value=${String(value)}
      @input=${onInput}
      @change=${onChange}
  /></label>`;
}

const figureArt = { figure, robot, line, label, path, slider };

const metric = (name, value) => html`<div><span>${name}</span><strong>${value}</strong></div>`;
const positionMetric = (name, value) =>
  html`<div class="basics-position"><span>${name}</span><strong>${value}</strong></div>`;
const helpDialog = (summary, paragraphs) =>
  html`<details data-help-dialog>
    <summary>${summary}</summary>
    ${paragraphs.map((paragraph) => html`<p>${paragraph}</p>`)}
  </details>`;

// --- wheels ----------------------------------------------------------------------------------

const toPixel = (plot, point) => ({
  x: plot.originX + point.x * plot.scale,
  y: plot.originY - point.y * plot.scale,
});

function wheelsFigure({ estimate, actual, slipping }, copy) {
  const { originX, originY } = WHEEL_PLOT;
  const end = toPixel(WHEEL_PLOT, estimate);
  const actualEnd = toPixel(WHEEL_PLOT, actual);
  return figure(
    svg`${line(65, originY, 630, originY)}${line(originX, 315, originX, 40)}${label(570, originY + 26, '前方向 →')}${label(originX - 58, 45, '左方向 ↑')}${robot(originX, originY, 0, true)}${path(estimate.path, WHEEL_PLOT, ESTIMATE_COLOUR)}${
      slipping
        ? svg`${path(actual.path, WHEEL_PLOT, ACTUAL_COLOUR, true)}${robot(actualEnd.x, actualEnd.y, actual.angle, true)}${label(36, 333, copy.slipLegend)}`
        : nothing
    }${robot(end.x, end.y, estimate.angle)}${label(originX - 70, originY + 70, '出発点（0, 0）')}${scaleBar(WHEEL_PLOT, SCALE_BAR_METRES, '20 cm')}`,
    copy.figureLabel,
  );
}

function wheelsCalculation({ leftRpm, rightRpm, estimate }, copy) {
  const turns = (rpm) => quantity((rpm * EXAMPLE_SECONDS) / SECONDS_PER_MINUTE, 1);
  const travel = (metres) => quantity(metres * 100, 1);
  return html`${metric(copy.perTurn, copy.perTurnValue)}${metric(
    copy.travel,
    html`${fillText(copy.travelLeft, { turns: turns(leftRpm), centimetres: travel(estimate.left) })}<br />${fillText(
        copy.travelRight,
        { turns: turns(rightRpm), centimetres: travel(estimate.right) },
      )}`,
  )}${positionMetric(
    copy.pose,
    fillText(copy.poseValue, {
      forward: travel(estimate.x),
      left: travel(estimate.y),
      degrees: quantity(degrees(estimate.angle), 1),
    }),
  )}`;
}

function wheelsObservation({ leftRpm, rightRpm, slipping }, copy) {
  if (slipping) return copy.slipObservation;
  if (leftRpm === rightRpm) return leftRpm === 0 ? copy.motion.stopped : copy.motion.straight;
  if (leftRpm === -rightRpm) return copy.motion.spin;
  return rightRpm > leftRpm ? copy.motion.turnLeft : copy.motion.turnRight;
}

function wheelsControls(wheels, copy, helpHtml, actions) {
  const rpmSlider = (id, title, value, onInput) =>
    slider({ id, title, min: -30, max: 60, step: 15, value, text: `${value} rpm`, onInput });
  return html`<h2>${copy.controlsTitle}</h2>
    <p>${copy.controlsIntro}</p>
    <div class="basics-presets">
      <button data-wheel-preset="straight" @click=${() => actions.useWheelPreset('straight')}>
        直進</button
      ><button data-wheel-preset="curve" @click=${() => actions.useWheelPreset('curve')}>
        曲がる</button
      ><button data-wheel-preset="spin" @click=${() => actions.useWheelPreset('spin')}>
        その場で回る
      </button>
    </div>
    ${rpmSlider('basicsLeft', '左の車輪', wheels.leftRpm, (event) =>
      actions.setLeftRpm(Number(event.target.value)),
    )}${rpmSlider('basicsRight', '右の車輪', wheels.rightRpm, (event) =>
      actions.setRightRpm(Number(event.target.value)),
    )}
    <p class="helper">${copy.rpmNote}</p>
    <label class="basics-check"
      ><input
        id="basicsSlip"
        type="checkbox"
        .checked=${wheels.slipping}
        @change=${(event) => actions.setSlipping(event.target.checked)}
      />${copy.slipLabel}</label
    >
    <details data-help-dialog>
      <summary>${copy.helpSummary}</summary>
      ${unsafeHTML(helpHtml)}
    </details>`;
}

function wheelsParts(model, copy, helpHtml, actions) {
  const wheels = model.wheels;
  return {
    figureStep: copy.figureStep,
    figureTitle: copy.figureTitle,
    figure: wheelsFigure(wheels, copy),
    calculation: wheelsCalculation(wheels, copy.calculation),
    observation: wheelsObservation(wheels, copy),
    controls: wheelsControls(wheels, copy, helpHtml, actions),
    question: copy.question,
    summary: copy.summary,
  };
}

// --- IMU -------------------------------------------------------------------------------------

function imuFigure({ result }, copy) {
  const { originX, originY } = IMU_PLOT;
  const end = toPixel(IMU_PLOT, result);
  const arc = Array.from({ length: TURN_ARC_SEGMENTS + 1 }, (_, i) => ({
    x: TURN_ARC_RADIUS * Math.cos((result.angle * i) / TURN_ARC_SEGMENTS),
    y: TURN_ARC_RADIUS * Math.sin((result.angle * i) / TURN_ARC_SEGMENTS),
  }));
  return figure(
    svg`${line(65, originY, 620, originY)}${line(originX, 322, originX, 35)}${label(555, originY + 24, '初めの向き')}${label(45, 40, copy.figureLegend.steps)}${path(arc, IMU_PLOT, TURN_ARC_COLOUR)}${Math.abs(result.angle) > 0.05 ? label(originX + 58, originY - 58 * Math.sign(result.angle), `${quantity(degrees(result.angle), 0)}°`, `fill:${TURN_ARC_COLOUR}`) : nothing}${robot(originX, originY, 0, true)}${path([{ x: 0, y: 0 }, result], IMU_PLOT, ESTIMATE_COLOUR)}${robot(end.x, end.y, result.angle)}${label(35, 333, copy.figureLegend.line)}`,
    copy.figureLabel,
  );
}

function imuCalculation({ rate, seconds, distance, result }, copy) {
  return html`${metric(
    copy.heading,
    fillText(copy.headingValue, { rate, seconds, degrees: rate * seconds }),
  )}${metric(copy.distance, fillText(copy.distanceValue, { distance: quantity(distance) }))}${positionMetric(
    copy.pose,
    fillText(copy.poseValue, { forward: quantity(result.x), left: quantity(result.y) }),
  )}`;
}

function imuControls(imu, copy, actions) {
  const onInput = (setter) => (event) => setter(Number(event.target.value));
  return html`<h2>${copy.controlsTitle}</h2>
    <p>${copy.controlsIntro}</p>
    ${slider({
      id: 'basicsRate',
      title: '回転の速さ',
      min: -45,
      max: 45,
      step: 15,
      value: imu.rate,
      text: `${imu.rate} °/秒`,
      onInput: onInput(actions.setTurnRate),
    })}${slider({
      id: 'basicsSeconds',
      title: '回転を続ける時間',
      min: 1,
      max: 4,
      step: 1,
      value: imu.seconds,
      text: `${imu.seconds} 秒`,
      onInput: onInput(actions.setTurnSeconds),
    })}${slider({
      id: 'basicsDistance',
      title: 'その後に進む距離（車輪で計測）',
      min: 0,
      max: 1,
      step: 0.1,
      value: imu.distance,
      text: `${quantity(imu.distance, 1)} m`,
      onInput: onInput(actions.setDriveDistance),
    })}
    <p class="helper">${copy.directionNote}</p>
    ${helpDialog(copy.accelerationHelp.summary, copy.accelerationHelp.paragraphs)}
    ${helpDialog(copy.nineAxisHelp.summary, copy.nineAxisHelp.paragraphs)}`;
}

function imuParts(model, copy, actions) {
  const imu = model.imu;
  return {
    figureStep: copy.figureStep,
    figureTitle: copy.figureTitle,
    figure: imuFigure(imu, copy),
    calculation: imuCalculation(imu, copy.calculation),
    observation: fillText(copy.observation, {
      degrees: imu.rate * imu.seconds,
      distance: quantity(imu.distance),
    }),
    controls: imuControls(imu, copy, actions),
    question: copy.question,
    summary: copy.summary,
  };
}

// --- LiDAR -----------------------------------------------------------------------------------

function scanPoint(point, shift = 0, colour = OLD_POINT_COLOUR, radius = 2.6) {
  const pixel = toPixel(LIDAR_PLOT, { x: point.x + shift, y: point.y });
  return svg`<circle cx=${pixel.x} cy=${pixel.y} r=${radius} fill=${colour}/>`;
}

function beamFigure({ beam, hit }, copy) {
  const { originX, originY } = LIDAR_PLOT;
  const end = toPixel(LIDAR_PLOT, hit);
  return figure(
    svg`<rect x=${originX - 50} y=${originY - 150} width="250" height="250" fill="none" stroke=${ROOM_WALL_COLOUR} stroke-width="5"/>${line(originX, originY, originX + 80, originY, LABEL_COLOUR, { dash: '4 4' })}${line(originX, originY, end.x, end.y, ESTIMATE_COLOUR, { width: 2 })}${Math.abs(beam) >= 5 ? angleMark({ x: originX, y: originY }, 44, 0, (beam * Math.PI) / 180, `${beam}°`, TURN_ARC_COLOUR) : nothing}${label((originX + end.x) / 2 + 8, (originY + end.y) / 2 + 20, `${quantity(hit.r)} m`, `fill:${BEAM_END_COLOUR}`)}${scanPoint(hit, 0, BEAM_END_COLOUR, 6)}${robot(originX, originY)}${label(465, 85, copy.figureLegend.room)}${label(465, 117, copy.figureLegend.point)}${label(originX - 37, originY + 62, 'ロボット')}`,
    copy.figureLabel,
  );
}

function beamCalculation({ beam, hit }, copy) {
  return html`${metric(copy.direction, fillText(copy.directionValue, { degrees: beam }))}${metric(
    copy.range,
    `${quantity(hit.r)} m`,
  )}${positionMetric(
    copy.point,
    fillText(copy.pointValue, { forward: quantity(hit.x), left: quantity(hit.y) }),
  )}`;
}

function beamControls({ beam }, copy, actions) {
  return html`<h2>${copy.controlsTitle}</h2>
    <p>${copy.controlsIntro}</p>
    ${slider({
      id: 'basicsBeam',
      title: '測る方向（機体の正面から）',
      min: -90,
      max: 90,
      step: 5,
      value: beam,
      text: `${beam}°`,
      onInput: (event) => actions.setBeam(Number(event.target.value)),
    })}
    <p class="helper">${copy.beamNote}</p>
    <button id="basicsMeasure" class="primary full" @click=${actions.startMapping}>
      周囲を測ってから、移動する →
    </button>
    <p class="helper">${copy.nextNote}</p>`;
}

function mappingFigure({ firstScan, secondScan, shift }, copy) {
  const { originX, originY, scale } = LIDAR_PLOT;
  return figure(
    svg`${firstScan.map((point) => scanPoint(point))}${secondScan.map((point) => scanPoint(point, shift, NEW_POINT_COLOUR))}${robot(originX, originY, 0, true)}${line(originX, originY, originX + shift * scale, originY, ESTIMATE_COLOUR, { dash: '4 4' })}${robot(originX + shift * scale, originY)}${label(50, 40, copy.figureLegend.search)}${label(originX - 27, originY + 64, '出発点')}${label(465, 290, copy.figureLegend.moveLine1)}${label(465, 314, copy.figureLegend.moveLine2)}`,
    copy.figureLabel,
  );
}

function mappingCalculation({ shift, error }, copy) {
  return html`${metric(copy.shift, `${quantity(shift)} m`)}${metric(
    copy.error,
    `${quantity(error * 100, 1)} cm`,
  )}${positionMetric(copy.placement, copy.placementValue)}`;
}

function mappingObservation({ matched, shift, error }, copy) {
  if (matched) return fillText(copy.matched, { shift: quantity(shift) });
  return error < ALIGNED_ERROR ? copy.aligned : copy.doubled;
}

function mappingControls({ shift }, copy, actions) {
  return html`<h2>${copy.controlsTitle}</h2>
    ${copy.controlsIntro.map((paragraph) => html`<p>${paragraph}</p>`)}
    ${slider({
      id: 'basicsShift',
      title: 'ロボットの位置の見積もり',
      min: 0.3,
      max: 1.1,
      step: 0.01,
      value: shift,
      text: `${quantity(shift)} m`,
      onInput: (event) => actions.setShift(Number(event.target.value)),
    })}
    <div class="basics-legend">
      <span><i class="old-point"></i>${copy.legend.old}</span
      ><span><i class="new-point"></i>${copy.legend.new}</span>
    </div>
    <button id="basicsMatch" class="primary full" @click=${actions.matchScans}>
      点の重なりから位置を直す</button
    ><button id="basicsScanReset" class="text-button" @click=${actions.restartMeasuring}>
      1本の距離から見直す
    </button>
    ${helpDialog(copy.help.summary, copy.help.paragraphs)}`;
}

function lidarParts(model, copy, actions) {
  const lidar = model.lidar;
  const shared = {
    figureStep: copy.figureStep,
    figureTitle: copy.figureTitle,
    question: copy.question,
    summary: copy.summary,
  };
  if (lidar.mapping)
    return {
      ...shared,
      figure: mappingFigure(lidar, { ...copy.mapping, figureLabel: copy.figureLabel }),
      calculation: mappingCalculation(lidar, copy.mapping.calculation),
      observation: mappingObservation(lidar, copy.mapping.observation),
      controls: mappingControls(lidar, copy.mapping, actions),
    };
  return {
    ...shared,
    figure: beamFigure(lidar, { ...copy.measure, figureLabel: copy.figureLabel }),
    calculation: beamCalculation(lidar, copy.measure.calculation),
    observation: copy.measure.observation,
    controls: beamControls(lidar, copy.measure, actions),
  };
}

// --- page frame ------------------------------------------------------------------------------

function sensorParts(model, copy, helpHtml, actions) {
  if (model.topic === 'wheels') return wheelsParts(model, copy.wheels, helpHtml, actions);
  if (model.topic === 'imu') return imuParts(model, copy.imu, actions);
  return lidarParts(model, copy.lidar, actions);
}

function groupNav(model, actions) {
  return html`<nav class="basics-topics basics-groups" aria-label="SLAMを学ぶ順序">
    ${model.groups.map(
      (title, index) =>
        html`<button
          data-slam-basics-group=${index}
          aria-pressed=${String(index === model.group)}
          @click=${() => actions.openGroup(index)}
        >
          ${title}
        </button>`,
    )}
  </nav>`;
}

function topicNav(model, actions) {
  return html`<nav id="slamBasicTopics" class="learning-subtopics" aria-label="この段階の実験">
    ${model.groupTopics.map(
      (topic) =>
        html`<button
          data-basics-topic=${topic.id}
          aria-pressed=${String(topic.id === model.topic)}
          @click=${() => actions.openTopic(topic.id)}
        >
          ${topic.title}
        </button>`,
    )}
  </nav>`;
}

// Concept chapters render their own content into these slots (see concepts.js), so the slots are
// left without lit parts; sensor chapters fill them here.
const CONCEPT_SLOTS = {
  figureStep: html`<p class="eyebrow" id="basicsFigureStep"></p>`,
  figureTitle: html`<h2 id="basicsFigureTitle"></h2>`,
  figure: html`<div id="basicsFigure"></div>`,
  calculation: html`<div class="basics-calculation" id="basicsCalculation"></div>`,
  observation: html`<div
    class="basics-observation"
    id="basicsObservation"
    aria-live="polite"
  ></div>`,
  controls: html`<aside class="guide card basics-guide" id="basicsControls"></aside>`,
  question: html`<section class="card basics-question" id="basicsQuestion"></section>`,
  summary: html`<p id="basicsSummary"></p>`,
};

function sensorSlots(parts) {
  return {
    figureStep: html`<p class="eyebrow" id="basicsFigureStep">${parts.figureStep}</p>`,
    figureTitle: html`<h2 id="basicsFigureTitle">${parts.figureTitle}</h2>`,
    figure: html`<div id="basicsFigure">${parts.figure}</div>`,
    calculation: html`<div class="basics-calculation" id="basicsCalculation">
      ${parts.calculation}
    </div>`,
    observation: html`<div class="basics-observation" id="basicsObservation" aria-live="polite">
      ${parts.observation}
    </div>`,
    controls: html`<aside class="guide card basics-guide" id="basicsControls">
      ${parts.controls}
    </aside>`,
    question: html`<section class="card basics-question" id="basicsQuestion">
      <h2>${parts.question.title}</h2>
      <details class="reflection-answer">
        <summary>予想してから答えを見る</summary>
        <p>${parts.question.text}</p>
      </details>
    </section>`,
    summary: html`<p id="basicsSummary">${parts.summary}</p>`,
  };
}

function basicsPage(model, copy, helpHtml, actions) {
  const slots = model.concept
    ? CONCEPT_SLOTS
    : sensorSlots(sensorParts(model, copy, helpHtml, actions));
  return html`${groupNav(model, actions)}${topicNav(model, actions)}
    <div id="slamLessonBrief">${unsafeHTML(model.brief)}</div>
    <div class="basics-layout">
      <div class="basics-workspace">
        <section class="card basics-visual">
          <div class="basics-visual-heading">${slots.figureStep}${slots.figureTitle}</div>
          ${slots.figure}
        </section>
        <section class="card basics-result">
          <div id="slamFigureGuide">${unsafeHTML(model.figureGuide)}</div>
          ${slots.calculation}${slots.observation}
        </section>
        <section
          class="card basics-evidence"
          id="basicsEvidence"
          ?hidden=${!model.evidenceShown}
        ></section>
      </div>
      ${slots.controls}
    </div>
    ${slots.question}
    <div class="basics-footer">${slots.summary}</div>`;
}

export { basicsPage, figureArt, metric, helpDialog };
