import { html } from '../vendor/lit-html.js';
import { formatNumber } from '../core/dom.js';
import { fillSentence } from '../core/content.js';

// Templates of the reward primer (the "報酬を設計する" chapter). Pure functions of the model built
// by app.js; the sentences come from content/rl/primer.json (`copy`).
//
// index.html owns the primer's markup, so these are grouped by the container they render into:
// `primerLabels` returns the short captions, `primerPanels` the three cards.

// The miniature map of a saved run, in SVG user units.
const HISTORY_PLOT = { x: 16, y: 12, scale: 53 }; // scale is pixels per metre

const historyPoint = (pose) =>
  formatNumber(HISTORY_PLOT.x + pose.x * HISTORY_PLOT.scale, 1) +
  ',' +
  formatNumber(HISTORY_PLOT.y + pose.y * HISTORY_PLOT.scale, 1);

function historyCaption(run, copy) {
  if (run.success) return fillSentence(copy.comparison.arrived, { time: formatNumber(run.time) });
  return fillSentence(copy.comparison.missed, { distance: formatNumber(run.distance) });
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
      <circle
        cx=${HISTORY_PLOT.x + start.x * HISTORY_PLOT.scale}
        cy=${HISTORY_PLOT.y + start.y * HISTORY_PLOT.scale}
        r="4"
        fill="#fff"
      />
    </svg>
    <p>${historyCaption(run, copy)}</p>
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
  return fillSentence(copy.missedCaption, { distance: formatNumber(run.distance) });
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
    primerEvidence: model.result ? evidencePanel(model, copy) : null,
    primerConclusion: model.result ? conclusionPanel(model, copy) : null,
    primerComparison: model.history.length ? comparisonPanel(model, copy) : null,
  };
}

export { primerLabels, primerPanels };
