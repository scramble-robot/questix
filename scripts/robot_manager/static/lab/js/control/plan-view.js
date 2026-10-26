import { html, svg, nothing } from '../vendor/lit-html.js';
import { niceScale, scaleTo, formatTick } from '../core/chart-scale.js';
import { CHART_ROLE_COLORS } from '../core/palette.js';
import { fillSentence as fill } from '../core/content.js';
import {
  PLAN_SPEEDS,
  PLAN_TIMES,
  PLAN_RADIUS,
  minimumTime,
  formatSpeed,
  formatTime,
  simulationPlan,
} from './simulation-plan.js';

const endTime = (plan) => (plan.time < 0.5 ? plan.end.toFixed(3) : formatTime(plan.end));

function planFields(model, copy, actions) {
  const chosen = model.config.targetSpeed;
  return html`<label class="control-select" for="controlSimulationSpeed"
      >${copy.demo.speedLabel}
      <select
        id="controlSimulationSpeed"
        class="control-select-input"
        .value=${chosen === undefined ? '' : String(chosen)}
        @change=${(e) => actions.setSimulationSpeed(e.target.value)}
      >
        <option value="">${copy.demo.chooseSpeed}</option>
        ${PLAN_SPEEDS.map((speed) => html`<option value=${String(speed)}>${formatSpeed(speed)} m/s</option>`)}
      </select></label
    >
    <label class="control-select" for="controlAcceleration"
      >${copy.demo.timeLabel}
      <select
        id="controlAcceleration"
        class="control-select-input"
        ?disabled=${chosen === undefined}
        .value=${model.accelerationChoice ?? ''}
        @change=${(e) => actions.setAcceleration(e.target.value)}
      >
        <option value="">${copy.demo.chooseTime}</option>
        ${chosen === undefined ? nothing : html`<option value="minimum">${fill(copy.demo.minimumOption, { time: formatTime(minimumTime(chosen)) })}</option>`}
        ${PLAN_TIMES.map((time) => html`<option value=${String(time)} ?disabled=${chosen === undefined || time < minimumTime(chosen)}>${time.toFixed(1)} s</option>`)}
      </select></label
    >`;
}

function planGraph(plan, copy, width) {
  const w = Math.max(320, Math.min(width, 900)),
    h = 260;
  const left = 54,
    right = w - 18,
    top = 24,
    bottom = 210;
  const x = (t) => left + (t / plan.end) * (right - left);
  const scale = niceScale([0, plan.speed], { ticks: 4, padding: 0.1 });
  const y = scaleTo(scale, bottom, top),
    zero = y(0);
  return html`<svg
    class="control-plan-chart"
    viewBox=${`0 0 ${w} ${h}`}
    role="img"
    aria-label=${fill(copy.demo.graphDescription, { speed: formatSpeed(plan.speed), time: formatTime(plan.time), end: endTime(plan) })}
  >
    ${scale.ticks.map((v) => svg`<line x1=${left} x2=${right} y1=${y(v)} y2=${y(v)} stroke=${CHART_ROLE_COLORS.grid}/><text x=${left - 8} y=${y(v) + 4} text-anchor="end">${formatTick(v, scale.step)}</text>`)}
    <g data-plan-plot>
      <path
        d=${`M${left},${zero} L${x(plan.time)},${y(plan.speed)} L${x(plan.time)},${zero} Z`}
        fill="#cae5d9"
        stroke="#3c7966"
      />
      <path
        d=${`M${x(plan.time)},${zero} L${x(plan.time)},${y(plan.speed)} L${right},${y(plan.speed)} L${right},${zero} Z`}
        fill="#f7e4b6"
        stroke="#987023"
      />
      <path
        d=${`M${left},${zero} L${x(plan.time)},${y(plan.speed)} L${right},${y(plan.speed)}`}
        fill="none"
        stroke=${CHART_ROLE_COLORS.target}
        stroke-width="3"
      />
      <path
        d=${`M${left},${zero} L${x(plan.time)},${zero} L${x(plan.time)},${y(plan.speed)}`}
        fill="none"
        stroke="#486b7c"
        stroke-dasharray="4 4"
      />
    </g>
    <text x=${left} y="15">${copy.demo.velocityAxis}</text>
    <text x=${left} y="231">0</text>
    ${x(plan.time) - left > 70 ? svg`<text x=${x(plan.time)} y="231" text-anchor="middle">${formatTime(plan.time)}</text>` : nothing}
    <text x=${right} y="231" text-anchor="end">${endTime(plan)}</text>
    <text x=${right} y="252" text-anchor="end">${copy.demo.timeAxis}</text>
  </svg>`;
}

function planCard(model, copy) {
  if (model.distance || model.topicId === 'output') return nothing;
  const ready = model.simulationReady;
  if (!ready)
    return html`<section id="controlPlan" class="card control-plan">
      <h2>${copy.demo.title}</h2>
      <p>${copy.demo.chooseBoth}</p>
    </section>`;
  const p = simulationPlan(model.config.targetSpeed, model.config.accelerationSeconds);
  const values = {
    speed: formatSpeed(p.speed),
    time: formatTime(p.time),
    angular: p.angular.toFixed(1),
    rpm: p.rpm.toFixed(0),
    acceleration: p.acceleration.toFixed(2),
    end: endTime(p),
    hold: p.hold.toFixed(1),
    triangle: p.triangle.toFixed(3),
    rectangle: p.rectangle.toFixed(3),
    distance: p.distance.toFixed(3),
    radius: PLAN_RADIUS.toFixed(2),
  };
  return html`<section id="controlPlan" class="card control-plan">
    <h2>${copy.demo.title}</h2>
    ${planGraph(p, copy, model.chartWidth)}
    <div class="control-plan-formulas" data-plan-explanation>
      <p>${fill(copy.demo.accelerationFormula, values)}</p>
      <p>${fill(copy.demo.angularFormula, values)}</p>
      <p>${fill(copy.demo.areaInterval, values)}</p>
      <p>${fill(copy.demo.triangleFormula, values)}</p>
      <p>${fill(copy.demo.rectangleFormula, values)}</p>
      <p><strong>${fill(copy.demo.totalFormula, values)}</strong></p>
    </div>
    <p class="helper">${copy.demo.areaNote}</p>
    <p class="helper">${copy.demo.slipNote}</p>
    <p class="helper">${copy.demo.roundingNote}</p>
  </section>`;
}
export { planFields, planCard };
