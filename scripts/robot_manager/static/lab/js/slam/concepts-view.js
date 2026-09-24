import { html, svg, nothing } from '../vendor/lit-html.js';
import { formatNumber } from '../core/dom.js';
import { snapToZero, fillText } from './basics-core.js';
import { figureArt, metric, helpDialog } from './basics-view.js';
import { pointInWorld, MAPPING_ROOM, MAPPING_POSES } from './concepts-core.js';
import { htmlChart } from './chart-view.js';
import { niceScale } from '../core/chart-scale.js';
import { roleStyle } from '../core/palette.js';

// Templates of the four concept chapters of the SLAM course (pose, occupancy map, localization,
// loop closure). Every function is pure: it turns the model built by concepts.js into markup, and
// hands it back as one set of slots, because the chapters share the page frame that basics-view.js
// renders. Learner-facing sentences come from content/slam/concepts.json (`copy`).

const { figure, robot, line, label, slider } = figureArt;

const quantity = (value, digits = 1) => formatNumber(snapToZero(value), digits);

const plainDetails = (summary, paragraphs, extra = nothing) =>
  html`<details>
    <summary>${summary}</summary>
    ${paragraphs.map((paragraph) => html`<p>${paragraph}</p>`)}${extra}
  </details>`;

// The answer stays folded until the learner has predicted it (C1, S4).
function conceptQuestion({ title, text, hint }, hintSummary) {
  return html`<h2>${title}</h2>
    <details class="reflection-answer">
      <summary>予想してから答えを見る</summary>
      <p>${text}</p>
    </details>
    ${plainDetails(hintSummary, [hint])}`;
}

// --- 位置と向き -------------------------------------------------------------------------------

const POSE_PLOT = { originX: 25, originY: 235, scale: 65 }; // pixels per metre
const POSE_GRID_COLOUR = '#36505b';
const POSE_HEADING_COLOUR = '#84d5bb';
const POSE_LANDMARK_COLOUR = '#f1c27c';
const POSE_FORWARD_LABEL_STYLE = 'fill:#a6e3d1;font-size:14px';
const HEADING_MARK_METRES = 1.05; // where the "forward" arrow sits ahead of the robot
const FACING_FRONT_METRES = 0.1; // the landmark reads as "ahead" while it is this far forward

const poseFigureSvg = (body, ariaLabel) =>
  html`<svg viewBox="0 0 320 265" role="img" aria-label=${ariaLabel}>${body}</svg>`;

function poseGrid() {
  const { originX, originY, scale } = POSE_PLOT;
  const columns = Array.from({ length: 5 }, (_, i) =>
    line(originX + i * scale, 26, originX + i * scale, originY, POSE_GRID_COLOUR),
  );
  const rows = Array.from({ length: 4 }, (_, i) =>
    line(26, 40 + i * scale, 294, 40 + i * scale, POSE_GRID_COLOUR),
  );
  return svg`${columns}${rows}`;
}

function poseScene({ pose, landmark }, theta, title, copy) {
  const { originX, originY, scale } = POSE_PLOT;
  const robotAt = { x: originX + pose.x * scale, y: originY - pose.y * scale };
  const landmarkAt = { x: originX + landmark.x * scale, y: originY - landmark.y * scale };
  const ahead = pointInWorld({ x: HEADING_MARK_METRES, y: 0 }, { ...pose, theta });
  const aheadAt = { x: originX + ahead.x * scale, y: originY - ahead.y * scale };
  const turned = theta > 0;
  const forwardLabel = turned ? copy.scene.turnedLabel : copy.scene.straightLabel;
  return poseFigureSvg(
    svg`<rect x="18" y="18" width="284" height="225" rx="8" fill="#233d47"/>${poseGrid()}<circle cx=${robotAt.x} cy=${robotAt.y} r="36" fill="none" stroke="#90aeb9" stroke-dasharray="3 4"/>${line(robotAt.x, robotAt.y, landmarkAt.x, landmarkAt.y, POSE_LANDMARK_COLOUR, { dash: '5 5', width: 2 })}${label(156, 204, '2 m')}${line(robotAt.x, robotAt.y, aheadAt.x, aheadAt.y, POSE_HEADING_COLOUR, { width: 3 })}<g transform=${`translate(${aheadAt.x} ${aheadAt.y}) rotate(${(-theta * 180) / Math.PI})`}><path d="M-9 -5L0 0L-9 5" fill="none" stroke=${POSE_HEADING_COLOUR} stroke-width="3"/></g>${label(turned ? 104 : 112, turned ? 89 : 118, copy.scene.forward, POSE_FORWARD_LABEL_STYLE)}<circle cx=${landmarkAt.x} cy=${landmarkAt.y} r="9" fill=${POSE_LANDMARK_COLOUR}/>${label(landmarkAt.x - 15, landmarkAt.y - 22, copy.scene.landmark)}${robot(robotAt.x, robotAt.y, theta)}`,
    `${title}。${forwardLabel}`,
  );
}

function poseCaption(copy, text) {
  return html`<figcaption>${copy.caption}<strong>${text}</strong></figcaption>`;
}

function poseFigure(model, copy) {
  const distance = quantity(model.distance, 0);
  const facingFront = model.relative.x > FACING_FRONT_METRES;
  const currentTitle = model.turned ? copy.scene.after : copy.scene.unturned;
  return html`<div class="pose-comparison">
    <figure>
      <h3>${copy.scene.before}</h3>
      ${poseScene(model, 0, copy.scene.before, copy)}
      ${poseCaption(copy, fillText(copy.captionFront, { distance }))}
    </figure>
    <figure class="pose-current">
      <h3>${model.turned ? copy.scene.after : copy.scene.current}</h3>
      ${poseScene(model, model.theta, currentTitle, copy)}
      ${poseCaption(
        copy,
        fillText(facingFront ? copy.captionFront : copy.captionRight, { distance }),
      )}
    </figure>
  </div>`;
}

function poseCalculation(model, copy) {
  const distance = quantity(model.distance, 0);
  const unchanged = copy.metrics.unchangedLines.map((text) => fillText(text, { distance }));
  const compare = model.turned ? copy.metrics.compareTurned : copy.metrics.compareIdle;
  return html`${metric(copy.metrics.unchanged, lines(unchanged))}${metric(
    copy.metrics.compare,
    lines(compare),
  )}`;
}

// Metric values that the original course wrote as two lines separated by a <br>.
const lines = (texts) => texts.map((text, index) => (index === 0 ? text : html`<br />${text}`));

function poseControls(model, copy, actions) {
  return html`<h2>${copy.controlsTitle}</h2>
    <p>${copy.controlsIntro}</p>
    <button id="spTurn" class="primary full" ?disabled=${model.turned} @click=${actions.turn}>
      その場で左へ90°回す</button
    ><button id="spReset" class="full" ?disabled=${!model.turned} @click=${actions.resetPose}>
      回す前に戻す
    </button>
    <div id="spDecision" class="pose-decision" ?hidden=${!model.turned}>
      <h3>${copy.decisionTitle}</h3>
      <p>${copy.decisionIntro}</p>
      <div class="pose-answers">
        <button
          id="spForward"
          aria-pressed=${String(model.answer === 'forward')}
          @click=${() => actions.answer('forward')}
        >
          そのまま前へ進む</button
        ><button
          id="spFace"
          aria-pressed=${String(model.answer === 'face')}
          @click=${() => actions.answer('face')}
        >
          右へ90°向き直す
        </button>
      </div>
      <p id="spFeedback" role="status">${copy.feedback[model.answer] ?? ''}</p>
    </div>
    ${helpDialog(copy.help.summary, copy.help.paragraphs)}`;
}

function poseParts(model, copy, actions) {
  return {
    figureStep: copy.figureStep,
    figureTitle: copy.figureTitle,
    figure: poseFigure(model, copy),
    calculation: poseCalculation(model, copy),
    observation: model.turned ? copy.observation.turned : copy.observation.idle,
    controls: poseControls(model, copy, actions),
    question: copy.question,
    summary: copy.summary,
  };
}

// --- 見えた範囲を地図にする --------------------------------------------------------------------

const MAP_PLOT = { originX: 267, originY: 310, scale: 77 }; // the map built from measurements
const ROOM_PLOT = { originX: 26, originY: 250, scale: 40 }; // the room drawn for comparison
const ROOM_WIDTH = 4.8; // metres
const ROOM_HEIGHT = 3.2; // metres
const CELL_OVERLAP = 0.15; // pixels added to each cell so neighbours do not show a seam
const RAY_OPACITY = '.6'; // written as the original did, so the attribute reads the same
const EVERY_NTH_RAY = 10; // only a tenth of the beams are drawn, to keep the figure readable
const CELL_COLOURS = {
  unknown: '#778891',
  uncertain: '#98a2a8',
  occupied: '#263a45',
  free: '#eef6f3',
};

function roomDrawing(model, copy) {
  const { originX, originY, scale } = ROOM_PLOT;
  const pose = MAPPING_POSES[model.view];
  const shelves = MAPPING_ROOM.obstacles.map(
    (rect) =>
      svg`<rect x=${originX + rect.x * scale} y=${originY - (rect.y + rect.h) * scale} width=${rect.w * scale} height=${rect.h * scale} fill="#9eafb5"/>`,
  );
  const places = MAPPING_POSES.map(
    (place, index) =>
      svg`<circle cx=${originX + place.x * scale} cy=${originY - place.y * scale} r=${index === model.view ? 6 : 3} fill=${index === model.view ? '#8cd7c0' : '#708f9c'}/>`,
  );
  return svg`${label(24, 92, copy.figureLegend.room)}${label(267, 36, copy.figureLegend.map)}<rect x=${originX} y=${originY - ROOM_HEIGHT * scale} width=${ROOM_WIDTH * scale} height=${ROOM_HEIGHT * scale} fill="#2b444f" stroke="#b3c5cb" stroke-width="2"/>${shelves}${label(originX + 2 * scale - 1, originY - 1.6 * scale + 6, copy.figureLegend.shelf)}${places}${robot(originX + pose.x * scale, originY - pose.y * scale, pose.theta)}${label(24, 285, copy.figureLegend.robot)}`;
}

function occupancyCells(grid, model, actions) {
  const { originX, originY } = MAP_PLOT;
  const size = model.resolution * MAP_PLOT.scale;
  const cells = [];
  for (let y = 0; y < grid.h; y++)
    for (let x = 0; x < grid.w; x++) {
      const index = y * grid.w + x;
      const type = grid.cells[index];
      cells.push(
        svg`<rect data-map-cell=${index} x=${originX + x * size} y=${originY - (y + 1) * size} width=${size + CELL_OVERLAP} height=${size + CELL_OVERLAP} fill=${CELL_COLOURS[type]} stroke="#a5b7bd" stroke-width=".18" @click=${() => actions.inspectCell(type)}/>`,
      );
    }
  return cells;
}

// The beams of the most recent scan, but only while the learner is still standing where it was
// measured.
function latestRays(model) {
  const { originX, originY, scale } = MAP_PLOT;
  const latest = model.frames.at(-1);
  if (!latest || latest.view !== model.view) return nothing;
  const pose = MAPPING_POSES[model.view];
  return latest.scan
    .filter((_, index) => index % EVERY_NTH_RAY === 0)
    .map((ray) => {
      const end = pointInWorld(
        { x: ray.range * Math.cos(ray.a), y: ray.range * Math.sin(ray.a) },
        pose,
      );
      return line(
        originX + pose.x * scale,
        originY - pose.y * scale,
        originX + end.x * scale,
        originY - end.y * scale,
        '#40a795',
        { opacity: RAY_OPACITY },
      );
    });
}

function mapFigure(model, copy, actions) {
  const { originX, originY, scale } = MAP_PLOT;
  const pose = MAPPING_POSES[model.view];
  return figure(
    svg`${roomDrawing(model, copy)}${occupancyCells(model.grid, model, actions)}${latestRays(model)}${robot(originX + pose.x * scale, originY - pose.y * scale, pose.theta)}${label(267, 340, copy.figureLegend.colours)}${
      model.frames.length ? nothing : label(390, 168, copy.figureLegend.empty)
    }`,
    copy.figureLabel,
  );
}

function mapCalculation(model, copy) {
  const grid = model.grid;
  const known = Math.round((grid.known / grid.total) * 100) + '%';
  const places = new Set(model.frames.map((frame) => frame.view)).size;
  return html`${metric(copy.metrics.known, known)}${metric(
    copy.metrics.places,
    fillText(copy.metrics.placesValue, { places }),
  )}`;
}

// The options are written out, not generated: a `.value` binding is committed before a child part,
// so a select whose options arrive through `${…}` would still be empty when its value is set.
function viewChooser(model, copy, actions) {
  return html`<label class="vision-select"
    >${copy.viewLabel}<select
      id="smView"
      .value=${String(model.view)}
      @change=${(event) => actions.setView(Number(event.target.value))}
    >
      <option value="0">左下</option>
      <option value="1">右下</option>
      <option value="2">右上</option>
      <option value="3">左上</option>
    </select></label
  >`;
}

function cellSizeChooser(model, copy, actions) {
  return html`<label class="vision-select"
    >${copy.resolutionLabel}<select
      id="smResolution"
      .value=${String(model.resolution)}
      @change=${(event) => actions.setResolution(Number(event.target.value))}
    >
      <option value="0.1">10 cm</option>
      <option value="0.2">20 cm</option>
    </select></label
  >`;
}

function mapControls(model, copy, actions) {
  return html`<p class="eyebrow">${copy.eyebrow}</p>
    <h2>${copy.controlsTitle}</h2>
    <p>${copy.controlsIntro}</p>
    <button id="smScan" class="primary full" @click=${actions.scanHere}>
      この位置から周囲を測る
    </button>
    ${viewChooser(model, copy, actions)} ${cellSizeChooser(model, copy, actions)}
    <button id="smReset" class="full" @click=${actions.clearMap}>地図を消してやり直す</button>
    <p class="helper">${copy.note}</p>
    ${plainDetails(copy.help.summary, copy.help.paragraphs)}`;
}

function mapParts(model, copy, actions) {
  return {
    figureStep: copy.figureStep,
    figureTitle: copy.figureTitle,
    figure: mapFigure(model, copy, actions),
    calculation: mapCalculation(model, copy),
    observation: model.note,
    controls: mapControls(model, copy, actions),
    question: copy.question,
    summary: copy.summary,
  };
}

// --- 地図から位置を探す ------------------------------------------------------------------------

const CORRIDOR_PLOT = { originX: 62, originY: 220, scale: 69 };
const CANDIDATE_Y = 1.2; // metres: the corridor's centre line, where every candidate sits
const CHART_FROM = 0.7; // metres: first candidate on the chart's x axis
const CHART_SPAN = 6.6; // metres covered by the chart's x axis
const CHART_FLOOR = 0.15; // metres: the error axis always reaches at least this
const OVERLAY_CENTRE = { x: 138, y: 104 };
const OVERLAY_SCALE = 43; // pixels per metre in the robot's-eye comparison
const AMBIGUOUS_CANDIDATES = 3; // more plausible places than this reads as "not decided"
const CORRIDOR_TICKS = 8; // one tick per metre along the corridor
// Candidates are yellow in the corridor; on the white chart the same candidate is dark amber.
const CANDIDATE_COLOUR = '#f2c14e';
const CANDIDATE_LINE_COLOUR = '#9a6b00';

function corridorFigure(model, copy) {
  const { originX, originY, scale } = CORRIDOR_PLOT;
  const scene = model.scene;
  const shelves = model.feature
    ? scene.obstacles.map(
        (rect) =>
          svg`<rect x=${originX + rect.x * scale} y=${originY - (rect.y + rect.h) * scale} width=${rect.w * scale} height=${rect.h * scale} fill="#a3b7bd"/>`,
      )
    : nothing;
  const plausible = model.checked
    ? model.fit.plausible.map(
        (candidate) =>
          svg`<circle cx=${originX + candidate.x * scale} cy=${originY - CANDIDATE_Y * scale} r="6" fill=${CANDIDATE_COLOUR}/>`,
      )
    : nothing;
  const legend = model.checked ? copy.figureLegend.checked : copy.figureLegend.unchecked;
  return figure(
    svg`<rect x=${originX} y=${originY - scene.height * scale} width=${scene.width * scale} height=${scene.height * scale} fill="#233d47" stroke="#759ba7" stroke-width="3"/>${shelves}${plausible}${robot(originX + model.guess * scale, originY - CANDIDATE_Y * scale)}${label(originX + model.guess * scale - 42, originY - CANDIDATE_Y * scale - 47, copy.figureLegend.candidate)}${label(originX, 245, copy.figureLegend.origin)}${label(originX + 8 * scale - 25, 245, copy.figureLegend.far)}${label(62, 290, legend)}${label(62, 322, copy.figureLegend.static)}`,
    copy.figureLabel,
  );
}

// One path through the measured ranges, broken wherever the beam found nothing.
function rangeOutline(scan) {
  let connected = false;
  return scan
    .map((ray) => {
      if (!ray.hit) {
        connected = false;
        return '';
      }
      const command = connected ? 'L' : 'M';
      connected = true;
      const x = OVERLAY_CENTRE.x - ray.range * Math.sin(ray.a) * OVERLAY_SCALE;
      const y = OVERLAY_CENTRE.y - ray.range * Math.cos(ray.a) * OVERLAY_SCALE;
      return `${command}${x},${y}`;
    })
    .join(' ');
}

// Measured (blue, solid) against predicted (magenta, dash-dot) as palette.js names the roles;
// the key is HTML beside the drawing so it stays readable on a phone (S3).
function overlayFigure(model, copy) {
  const measured = roleStyle('measured');
  const plan = roleStyle('plan');
  return html`<div class="slam-overlay">
    <svg viewBox="20 0 236 215" role="img" aria-label=${copy.overlayLabel}>
      <rect x="28" y="4" width="220" height="202" rx="12" fill="#f2f6f5" />
      <circle cx=${OVERLAY_CENTRE.x} cy=${OVERLAY_CENTRE.y} r="86" fill="none" stroke="#d1dfdc" />
      <path
        d=${rangeOutline(model.observed)}
        fill="none"
        stroke=${measured.color}
        stroke-width="3"
      />
      <path
        d=${rangeOutline(model.predicted)}
        fill="none"
        stroke=${plan.color}
        stroke-width="3"
        stroke-dasharray=${plan.dash}
      />
      <path d="M138 94l-6 14h12z" fill="#263a45" />
      <text x="138" y="24" text-anchor="middle" font-size="15" fill="#597078">${copy.front}</text>
    </svg>
    <ul class="slam-overlay-key">
      <li><i class="key-measured" aria-hidden="true"></i>${copy.measured}</li>
      <li><i class="key-predicted" aria-hidden="true"></i>${copy.predicted}</li>
      <li>${copy.overlap}</li>
      <li>${copy.limit}</li>
    </ul>
  </div>`;
}

// Mismatch of every candidate along the corridor, in cm, with 1 m ticks, the band of candidates
// that fit and the learner's own candidate marked (S3). Shown as soon as the search has run.
function errorChart(model, copy) {
  const candidates = model.fit.candidates;
  const plausible = model.fit.plausible;
  const band = plausible.length
    ? [
        {
          from: plausible[0].x,
          to: plausible.at(-1).x,
          label: fillText(copy.chartBand, {
            from: quantity(plausible[0].x, 1),
            to: quantity(plausible.at(-1).x, 1),
          }),
        },
      ]
    : [];
  return htmlChart({
    label: copy.chartLabel,
    yTitle: copy.chartAxisTitle,
    xTitle: copy.chartXTitle,
    x: niceScale([CHART_FROM, CHART_FROM + CHART_SPAN], { ticks: CORRIDOR_TICKS, padding: 0 }),
    y: niceScale(
      candidates.map((candidate) => candidate.error * 100),
      { min: CHART_FLOOR * 100, ticks: 4 },
    ),
    series: [
      {
        points: candidates.map((candidate) => [candidate.x, candidate.error * 100]),
        ...roleStyle('measured'),
        label: copy.chartLine,
      },
    ],
    bands: band,
    vlines: [
      {
        x: model.guess,
        label: fillText(copy.chartGuess, { position: quantity(model.guess, 1) }),
        color: CANDIDATE_LINE_COLOUR,
        dash: '4 4',
      },
    ],
  });
}

function localizationEvidence(model, copy) {
  return html`<h2>${copy.title}</h2>
    ${overlayFigure(model, copy)}
    ${
      model.checked
        ? html`<h3 class="slam-chart-title">${copy.chartSummary}</h3>
            ${errorChart(model, copy)}
            <p>${copy.chartNote}</p>`
        : nothing
    }`;
}

function spreadValue(model, copy) {
  if (!model.checked) return copy.metrics.spreadUnknown;
  const plausible = model.fit.plausible;
  if (plausible.length === 1)
    return fillText(copy.metrics.spreadOne, { position: quantity(plausible[0].x) });
  return fillText(copy.metrics.spreadRange, {
    from: quantity(plausible[0].x),
    to: quantity(plausible.at(-1).x),
  });
}

function localizationCalculation(model, copy) {
  return html`${metric(copy.metrics.error, `${quantity(model.error * 100)} cm`)}${metric(
    copy.metrics.spread,
    spreadValue(model, copy),
  )}`;
}

function localizationObservation(model, copy) {
  if (!model.checked) return copy.observation.idle;
  return model.fit.plausible.length > AMBIGUOUS_CANDIDATES
    ? copy.observation.many
    : copy.observation.few;
}

function localizationControls(model, copy, actions) {
  return html`<p class="eyebrow">${copy.eyebrow}</p>
    <h2>${copy.controlsTitle}</h2>
    <p>${copy.controlsIntro}</p>
    <button id="slSearch" class="primary full" @click=${actions.searchCandidates}>
      地図の中で候補を探す
    </button>
    ${slider({
      id: 'slGuess',
      title: '自分で選ぶ位置の候補',
      min: 0.7,
      max: 7.3,
      step: 0.1,
      value: model.guessInput,
      text: `${model.guessInput} m`,
      // The figure is redrawn when the slider is released; dragging only moves the readout.
      onInput: (event) => actions.previewGuess(Number(event.target.value)),
      onChange: (event) => actions.setGuess(Number(event.target.value)),
    })}
    <label class="basics-check"
      ><input
        type="checkbox"
        id="slFeature"
        .checked=${model.feature}
        @change=${(event) => actions.setFeature(event.target.checked)}
      />${copy.featureLabel}</label
    >
    <p class="helper">${copy.note}</p>
    ${helpDialog(copy.help.summary, copy.help.paragraphs)}`;
}

function localizationParts(model, copy, actions) {
  return {
    figureStep: copy.figureStep,
    figureTitle: copy.figureTitle,
    figure: corridorFigure(model, copy),
    calculation: localizationCalculation(model, copy),
    observation: localizationObservation(model, copy),
    controls: localizationControls(model, copy, actions),
    evidence: localizationEvidence(model, copy.evidence),
    question: copy.question,
    summary: copy.summary,
  };
}

// --- 戻った場所から直す ------------------------------------------------------------------------

const LOOP_PLOT = { scale: 57, originY: 290, offset: 0.8 }; // metres of padding, then pixels
const LOOP_PANELS = [
  { x: 32, clip: 'loopBefore', colour: '#dca36a' },
  { x: 358, clip: 'loopAfter', colour: '#8cd7c0' },
];
const LOOP_LINK_COLOUR = '#f4cb86';
const LOOP_GAP_COLOUR = '#ff6b6b'; // danger red of palette.js (scene): the gap to close
// The gap's value sits at the panel's lower right, clear of the 出発点/最後 labels.
const LOOP_GAP_LABEL = { x: 170, y: 322 };
const EVERY_OTHER_RAY = 2; // half the beams are drawn, to keep the two panels readable

const loopPoint = (panelX, point) => ({
  x: panelX + 25 + (point.x + LOOP_PLOT.offset) * LOOP_PLOT.scale,
  y: LOOP_PLOT.originY - (point.y + LOOP_PLOT.offset) * LOOP_PLOT.scale,
});

function loopPlaceholder(copy) {
  return svg`${label(374, 30, copy.panels.placeholder)}<rect x="360" y="56" width="290" height="244" rx="12" fill="#233d47" stroke="#6c8995" stroke-dasharray="5 5"/>${label(392, 166, copy.panels.placeholderLine1)}${label(387, 202, copy.panels.placeholderLine2)}`;
}

function loopScanDots(model, panel, poses) {
  const dots = [];
  model.fixture.scans.forEach((scan, index) => {
    const pose = poses[index];
    for (const ray of scan.filter((_, j) => j % EVERY_OTHER_RAY === 0)) {
      if (!ray.hit) continue;
      const at = loopPoint(panel.x, {
        x: pose.x + ray.range * Math.cos(ray.a),
        y: pose.y + ray.range * Math.sin(ray.a),
      });
      dots.push(svg`<circle cx=${at.x} cy=${at.y} r="1.2" fill="#77949f" opacity=".65"/>`);
    }
  });
  return dots;
}

function loopTrack(panel, poses, copy) {
  const points = poses
    .map((pose) => {
      const at = loopPoint(panel.x, pose);
      return at.x + ',' + at.y;
    })
    .join(' ');
  const marks = poses.map((pose, index) => {
    const at = loopPoint(panel.x, pose);
    const dot = svg`<circle cx=${at.x} cy=${at.y} r="4" fill=${panel.colour}/>`;
    if (index === 0) return svg`${dot}${label(at.x - 22, at.y + 30, copy.panels.start)}`;
    if (index === poses.length - 1) return svg`${dot}${label(at.x + 10, at.y, copy.panels.end)}`;
    return dot;
  });
  return svg`<polyline points=${points} fill="none" stroke=${panel.colour} stroke-width="2.5"/>${marks}`;
}

function loopPanel(model, panel, poses, title, closure, copy) {
  return svg`${label(panel.x + 10, 30, title)}<defs><clipPath id=${panel.clip}><rect x=${panel.x} y="45" width="310" height="268"/></clipPath></defs><g clip-path=${`url(#${panel.clip})`}>${loopScanDots(model, panel, poses)}</g>${loopTrack(panel, poses, copy)}${closure}`;
}

// The gap between two poses as a red double arrow with its size in cm (S7).
function loopGapArrow(panel, from, to, text) {
  const a = loopPoint(panel.x, from);
  const b = loopPoint(panel.x, to);
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  const head = (at, sign) =>
    `M${at.x},${at.y}L${at.x - sign * (9 * ux - 5 * uy)},${at.y - sign * (9 * uy + 5 * ux)}M${at.x},${at.y}L${at.x - sign * (9 * ux + 5 * uy)},${at.y - sign * (9 * uy - 5 * ux)}`;
  return svg`${line(a.x, a.y, b.x, b.y, LOOP_GAP_COLOUR, { width: 3 })}<path d=${head(b, 1) + head(a, -1)} stroke=${LOOP_GAP_COLOUR} stroke-width="3" fill="none"/>${label(panel.x + LOOP_GAP_LABEL.x, LOOP_GAP_LABEL.y, text, `fill:${LOOP_GAP_COLOUR};font-weight:700`)}`;
}

function gapText(copy, from, to) {
  const centimetres = Math.hypot(to.x - from.x, to.y - from.y) * 100;
  return fillText(copy.panels.gap, { gap: quantity(centimetres, 0) });
}

function adjustedTitle(model, copy) {
  if (!model.result) return copy.panels.pending;
  return model.match === 0 ? copy.panels.closed : copy.panels.wrong;
}

function loopFigure(model, copy) {
  const [beforePanel, afterPanel] = LOOP_PANELS;
  const before = model.fixture.before;
  const beforeClosure = loopGapArrow(
    beforePanel,
    before.at(-1),
    before[0],
    gapText(copy, before.at(-1), before[0]),
  );
  let after = loopPlaceholder(copy);
  if (model.result) {
    const poses = model.result.after;
    const end = loopPoint(afterPanel.x, poses.at(-1));
    const start = loopPoint(afterPanel.x, poses[model.match]);
    const closure = line(end.x, end.y, start.x, start.y, LOOP_LINK_COLOUR, { width: 4 });
    after = loopPanel(model, afterPanel, poses, adjustedTitle(model, copy), closure, copy);
  }
  return figure(
    svg`${loopPanel(model, beforePanel, before, copy.panels.before, beforeClosure, copy)}${after}${label(30, 342, copy.panels.legend)}`,
    copy.figureLabel,
  );
}

function loopCalculation(model, copy) {
  const start = model.fixture.before.at(-1);
  const initial = Math.hypot(start.x, start.y);
  const gap = model.result
    ? fillText(copy.metrics.gapValue, { gap: quantity(model.result.gap * 100) })
    : fillText(copy.metrics.gapInitial, { gap: quantity(initial * 100) });
  const residual = model.result
    ? fillText(copy.metrics.residualValue, {
        residual: quantity(model.result.moveResidual * 100),
      })
    : copy.metrics.residualPending;
  return html`${metric(copy.metrics.gap, gap)}${metric(copy.metrics.residual, residual)}`;
}

function loopObservation(model, copy) {
  if (!model.result) return copy.observation.idle;
  return model.match === 0 ? copy.observation.closed : copy.observation.wrong;
}

function loopControls(copy, actions) {
  const wrongButton = html`<button id="scWrong" class="full" @click=${actions.closeOnWrongCorner}>
    途中の角と取り違えて計算
  </button>`;
  return html`<p class="eyebrow">${copy.eyebrow}</p>
    <h2>${copy.controlsTitle}</h2>
    <p>${copy.controlsIntro}</p>
    <button id="scClose" class="primary full" @click=${actions.closeLoop}>
      出発点の対応から全体を調整</button
    ><button id="scReset" class="full" @click=${actions.resetLoop}>調整前に戻す</button>
    ${plainDetails(copy.wrongMatch.summary, [copy.wrongMatch.note], wrongButton)}
    ${helpDialog(copy.help.summary, copy.help.paragraphs)}`;
}

function loopParts(model, copy, actions) {
  return {
    figureStep: copy.figureStep,
    figureTitle: copy.figureTitle,
    figure: loopFigure(model, copy),
    calculation: loopCalculation(model, copy),
    observation: loopObservation(model, copy),
    controls: loopControls(copy, actions),
    question: copy.question,
    summary: copy.summary,
  };
}

export { poseParts, mapParts, localizationParts, loopParts, conceptQuestion };
