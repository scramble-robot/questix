import { html } from '../vendor/lit-html.js';
import { depthColorBar } from '../core/depth-core.js';

// The colour bar of a depth image in metres, with the hatch of "not measured" (audit V3). Shared
// by the vision RGB-D chapter and the SLAM camera view, which colour depth with the same
// depthColor(). `text`: {label, title, near, far, missing} from the course's content file.

const DEPTH_BAR = depthColorBar();

function depthColorKey(text) {
  return html`<div class="depth-color-key" role="img" aria-label=${text.label}>
    <strong>${text.title}</strong>
    <div class="depth-color-scale">
      <div class="depth-color-bar" style=${`background: ${DEPTH_BAR.gradient}`}></div>
      <div class="depth-color-ticks">
        ${DEPTH_BAR.ticks.map(
          (tick) => html`<span style=${`left: ${tick.at}%`}>${String(tick.metres)}</span>`,
        )}
      </div>
      <div class="depth-color-ends"><span>${text.near}</span><span>${text.far}</span></div>
    </div>
    <span class="depth-color-missing"><i aria-hidden="true"></i>${text.missing}</span>
  </div>`;
}

export { depthColorKey };
