import { loadJson } from '../core/content.js';
import { SYSTEM_TOPICS } from '../systems/data.js';
import { escapeHtml } from './html-escape.js';

// Connections between an experiment and school mathematics/physics: not prerequisites and not
// additional simulator inputs. All worked numbers are illustrative examples, never live
// measurements. Tips are keyed `<course>-<topic>` in content/school-tips.json; the systems
// courses carry their tips inside their topic data. High-school grades (SCHOOL_GRADES) are one
// possible course sequence, not a nationally fixed allocation.
// The tip card is an HTML string because course modules embed it in their own markup; the
// grade-by-grade overview on the catalogue page is rendered by series-view.js.

const { SCHOOL_TIPS, SCHOOL_GRADES } = await loadJson('content/school-tips.json');
const copy = await loadJson('content/shell/school-tips.json');

for (const [course, topics] of Object.entries(SYSTEM_TOPICS))
  for (const topic of topics) SCHOOL_TIPS[`${course}-${topic.id}`] = topic.tip;

// Tip format: [subjects, title, connection, formula, example, what to observe].
function tipFields([subjects, title, connection, formula, example, observe]) {
  return { subjects, title, connection, formula, example, observe };
}

function tipSummary(tip) {
  return `<summary><span class="school-tip-label">${copy.label}</span> <span class="school-tip-topic">${escapeHtml(tip.title)}</span></summary>`;
}

function tipConnection(tip) {
  return `<div><h3>${copy.connectionHeading}</h3><p>${escapeHtml(tip.connection)}</p><div class="school-tip-example"><h4>${copy.exampleHeading}</h4><p class="school-tip-formula">${escapeHtml(tip.formula)}</p><p>${escapeHtml(tip.example)}</p></div></div>`;
}

function tipObservation(tip) {
  return `<div class="school-tip-observe"><h3>${copy.observeHeading}</h3><p>${escapeHtml(tip.observe)}</p><p class="school-tip-note">${copy.note}</p></div>`;
}

// `details[data-help-dialog]` is what supplement-ui.js turns into a "解説を開く" button + dialog.
function schoolTips(key) {
  if (!SCHOOL_TIPS[key]) return '';
  const tip = tipFields(SCHOOL_TIPS[key]);
  const body = `<div class="school-tip-body"><p class="school-tip-subjects">${escapeHtml(tip.subjects)}</p><div class="school-tip-grid">${tipConnection(tip)}${tipObservation(tip)}</div></div>`;
  return `<details data-help-dialog class="school-tip" data-school-tip="${escapeHtml(key)}">${tipSummary(tip)}${body}</details>`;
}

export { SCHOOL_TIPS, schoolTips, SCHOOL_GRADES };
