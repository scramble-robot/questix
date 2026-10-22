import { html } from '../vendor/lit-html.js';
import { fillSentence as fill } from '../core/content.js';
// The header and the active dialog use this exact template.
function headerStatusTile(label, value, values, description, attributes) {
  return html`<span class="header-status-tile" data-header-tile=${attributes}>
    <span aria-hidden="true" class="header-status-label"
      >${label}<span class="header-status-colon">：</span></span
    >
    <span class="header-text-slot" aria-hidden="true"
      ><span>${value}</span>${values.map(
        (text) => html`<span class="header-text-reserve">${text}</span>`,
      )}</span
    ><span class="sr-only">${description}</span>
  </span>`;
}
function liveStatusLine(model, copy, header = false) {
  const text = copy.header;
  if (header)
    return html` <span data-live-status-estop=${model.estop}
        >${headerStatusTile(
          text.estopLabel,
          text.estop[model.estop].split('：')[1],
          Object.values(text.estop).map((value) => value.split('：')[1]),
          text.estopDescription[model.estop],
          'estop',
        )}</span
      >
      <span data-live-status-permission
        >${headerStatusTile(
          text.permissionLabel,
          fill(text.permission, {
            drive: text.allowed[model.drive],
            shoot: text.allowed[model.shoot],
          }).split('：')[1],
          Object.values(text.allowed).flatMap((drive) =>
            Object.values(text.allowed).map(
              (shoot) => fill(text.permission, { drive, shoot }).split('：')[1],
            ),
          ),
          fill(text.permissionDescription, {
            drive: text.allowed[model.drive],
            shoot: text.allowed[model.shoot],
          }),
          'permission',
        )}</span
      >
      <span class="header-connection" data-live-status-connection=${model.stage}
        ><span aria-hidden="true">${text.connection}</span
        ><span class="header-text-slot"
          ><span>${copy.stageShort[model.stage]}</span>${Object.values(copy.stageShort).map(
            (value) => html`<span class="header-text-reserve" aria-hidden="true">${value}</span>`,
          )}</span
        ></span
      >`;
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
