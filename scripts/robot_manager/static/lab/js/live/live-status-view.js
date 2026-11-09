import { html } from '../vendor/lit-html.js';
import { fillSentence as fill } from '../core/content.js';
// The header and the active dialog use this exact template.
function liveStatusLine(model, copy) {
  const text = copy.header;
  return html`<span data-live-status-estop=${model.estop}>
      <span aria-hidden="true">${text.estop[model.estop]}</span>
      <span class="sr-only">${text.estopDescription[model.estop]}</span>
    </span>
    <span data-live-status-permission>
      <span aria-hidden="true"
        >${fill(text.permission, { drive: text.allowed[model.drive], shoot: text.allowed[model.shoot] })}</span
      >
      <span class="sr-only"
        >${fill(text.permissionDescription, { drive: text.allowed[model.drive], shoot: text.allowed[model.shoot] })}</span
      >
    </span>
    <span data-live-status-connection=${model.stage}
      >${text.connection}${copy.stageShort[model.stage]}</span
    >`;
}
export { liveStatusLine };
