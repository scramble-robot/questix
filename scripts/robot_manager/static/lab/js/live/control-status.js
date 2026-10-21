import { html } from '../vendor/lit-html.js';
import { loadJson } from '../core/content.js';
const copy = await loadJson('content/live/control-status.json');
const hardBlocked = (model) => model.blockers.some((blocker) => blocker.code !== 'unconfirmed');
function controlStatus(blockers, phase = '', kind = 'drive', reconfirm = '') {
  const first = blockers[0]?.code;
  const key = phase || first || 'ready';
  const entry = copy[key] ?? copy.unavailable;
  const text =
    key === 'unconfirmed' && reconfirm
      ? copy.reconfirm[kind]
      : key === 'not_allowed'
        ? entry[kind]
        : entry;
  return html`<div class="live-control-status" role="status" data-control-status=${key}>
    <span>${text[0]}</span><span>${text[1]}</span>
  </div>`;
}
export { controlStatus, hardBlocked };
