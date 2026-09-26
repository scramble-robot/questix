import { html, svg, nothing } from '../vendor/lit-html.js';
import { formatNumber } from '../core/dom.js';
import { fillSentence } from '../core/content.js';
import { roleStyle } from '../core/palette.js';
import { introTurns, turnsInPlace } from './intro.js';
import { rewardCurveLayout } from './curve-core.js';
import { curveChart } from './curve-view.js';

// Templates of the reward primer (the "報酬を設計する" chapter). Pure functions of the model built
// by app.js; the sentences come from content/rl/primer.json (`copy`).
//
// index.html owns the primer's markup, so these are grouped by the container they render into:
// `primerLabels` returns the short captions, `primerPanels` the three cards.

// The miniature map of a saved run, in SVG user units.
const HISTORY_PLOT = { x: 16, y: 12, scale: 53 }; // scale is pixels per metre
const HISTORY_ARROW = 22; // length of a heading arrow in the miniature, in SVG units
// Points one run can collect under either rule (spinning earns up to 100 × 0.4), kept on the
// curve's axis from the start so it does not move while the curve grows.
const CURVE_RANGE = [0, 40];

const historyPoint = (pose) =>
  formatNumber(HISTORY_PLOT.x + pose.x * HISTORY_PLOT.scale, 1) +
  ',' +
  formatNumber(HISTORY_PLOT.y + pose.y * HISTORY_PLOT.scale, 1);

function historyCaption(rule, run, copy) {
  if (run.success) return fillSentence(copy.comparison.arrived, { time: formatNumber(run.time) });
  if (rule === 'spin')
    return fillSentence(copy.comparison.spun, {
      turns: formatNumber(introTurns(run.trace), 0),
      distance: formatNumber(run.distance),
    });
  return fillSentence(copy.comparison.missed, { distance: formatNumber(run.distance) });
}

// Short lines from where the robot turned on the spot, in the heading it turned to, so a run that
// only spins shows a fan instead of a single dot.
function headingArrows(trace) {
  const colour = roleStyle('actual', 'scene').color;
  return turnsInPlace(trace).map((pose) => {
    const x = HISTORY_PLOT.x + pose.x * HISTORY_PLOT.scale;
    const y = HISTORY_PLOT.y + pose.y * HISTORY_PLOT.scale;
    return svg`<line
      x1=${x}
      y1=${y}
      x2=${x + Math.cos(pose.theta) * HISTORY_ARROW}
      y2=${y + Math.sin(pose.theta) * HISTORY_ARROW}
      stroke=${colour}
      stroke-width="2"
      stroke-opacity="0.55"
    />`;
  });
}

function historyCard({ rule, run }, copy) {
  const text = copy.rules[rule];
  const start = run.trace[0];
  return html`<article>
    <h4>${text.name}</h4>
    <svg viewBox="0 0 290 190" role="img" aria-label=${text.traceLabel}>
      <rect x="16" y="12" width="254" height="159" fill="#1b3540" />
      <circle cx="222.7" cy="91.5" r="12" fill="none" stroke="#e5c274" stroke-dasharray="3 3" />
      <polyline
        points=${run.trace.map(historyPoint).join(' ')}
        fill="none"
        stroke="#8ed8bc"
        stroke-width="2"
      />
      ${headingArrows(run.trace)}
      <circle
        cx=${HISTORY_PLOT.x + start.x * HISTORY_PLOT.scale}
        cy=${HISTORY_PLOT.y + start.y * HISTORY_PLOT.scale}
        r="4"
        fill="#fff"
      />
    </svg>
    <p>${historyCaption(rule, run, copy)}</p>
  </article>`;
}

// One card per reward rule the learner has trained with, so the two runs can be compared.
function comparisonPanel(model, copy) {
  return html`<h3>${copy.comparison.title}</h3>
    <div class="primer-history-grid">${model.history.map((entry) => historyCard(entry, copy))}</div>
    <p class="helper">${copy.comparison.note}</p>`;
}

// One step from the training run, as evidence of what the reward actually rewarded.
function evidencePanel(model, copy) {
  const text = copy.evidence;
  const example = model.example;
  const detail =
    model.rule === 'approach'
      ? fillSentence(text.approach, {
          from: formatNumber(example.fromDistance, 2),
          to: formatNumber(example.toDistance, 2),
        })
      : text.spin;
  return html`<p class="eyebrow">${text.title}</p>
    <p>
      <strong>${text.actions[example.action]}</strong> → ${detail} →
      <strong>+${formatNumber(example.reward)} 点</strong><br />${text.note}
    </p>`;
}

function conclusionPanel(model, copy) {
  const text = copy.conclusion[model.rule];
  return html`<h3>${text.title}</h3>
    <p>${text.text}</p>`;
}

function afterCaption(model, copy) {
  const run = model.result;
  if (!run) return copy.learnAgainCaption;
  if (run.success) return fillSentence(copy.arrivedCaption, { time: formatNumber(run.time) });
  if (model.rule === 'spin')
    return fillSentence(copy.spinCaption, {
      time: formatNumber(run.time, 0),
      turns: formatNumber(introTurns(run.trace), 0),
      score: formatNumber(run.score, 0),
      distance: formatNumber(run.distance),
    });
  return fillSentence(copy.missedCaption, { distance: formatNumber(run.distance) });
}

// Mean reward per 50 training runs under the rule being learned, with the other rule's last
// curve as a grey dotted line: spinning can earn more points than delivering.
function curvePanel(model, copy) {
  const curve = model.curve;
  const text = copy.curve;
  const lines = [];
  if (curve.previous)
    lines.push({
      role: 'previous',
      label: copy.rules[curve.previous.rule].name,
      rewards: curve.previous.rewards,
    });
  if (curve.current)
    lines.push({
      role: 'actual',
      label: copy.rules[curve.current.rule].name,
      rewards: curve.current.rewards,
    });
  const layout = rewardCurveLayout(lines, curve.total, CURVE_RANGE);
  return html`<div id="primerCurve" class="rl-curve-wrap">
    ${curveChart(layout, {
      title: text.title,
      yTitle: text.yTitle,
      xTitle: text.xTitle,
      unit: '点',
      empty: text.empty,
      ariaLabel: text.title,
    })}
    <p class="helper">${curve.previous ? text.compareNote : text.note}</p>
  </div>`;
}

function evidenceAndCurve(model, copy) {
  return html`${model.result ? evidencePanel(model, copy) : nothing}${
    model.curve ? curvePanel(model, copy) : nothing
  }`;
}

function statusLine(model, copy) {
  if (model.busy) return copy.status.learning;
  if (model.result) return fillSentence(copy.status.learned, { episodes: model.episodes });
  return copy.status.ruleChanged;
}

// The short captions around the two canvases, keyed by the element they belong to.
function primerLabels(model, copy) {
  return {
    primerAfterLabel: copy.afterLabel,
    primerAfterSubtitle: model.result ? copy.rules[model.rule].name : copy.notYetLearned,
    primerAfterCaption: afterCaption(model, copy),
    primerStatus: statusLine(model, copy),
    primerLearn: model.result ? copy.learnAgain : copy.learn,
    primerReplay: model.playing ? copy.showResult : copy.replay,
  };
}

// The three cards below the canvases. A null panel stays hidden and is left as it was.
function primerPanels(model, copy) {
  return {
    primerEvidence: model.result || model.curve ? evidenceAndCurve(model, copy) : null,
    primerConclusion: model.result ? conclusionPanel(model, copy) : null,
    primerComparison: model.history.length ? comparisonPanel(model, copy) : null,
  };
}

export { primerLabels, primerPanels };
