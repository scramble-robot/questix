import { html } from '../vendor/lit-html.js';

// Form controls shared by the vision foundation chapters (basics-view.js) and the stereo/RGB-D
// chapters (depth-view.js). Pure templates: every control reports through the callback it is given.

// `suffix` carries the unit shown next to the value, e.g. ' m' or '画素以上'.
function slider({ id, label, value, min, max, step = 1, suffix = '', onInput }) {
  return html`<label class="basics-slider" for=${id}
    >${label}<output id=${id + 'Value'}>${value}${suffix}</output
    ><input
      id=${id}
      type="range"
      min=${min}
      max=${max}
      step=${step}
      .value=${String(value)}
      @input=${(event) => onInput(Number(event.target.value))}
  /></label>`;
}

// `options` is a list of [value, label]. The selection is bound per option: lit commits the
// `<select>`'s own parts before its children exist, so a `.value` binding on the select itself
// would have nothing to match yet. Binding the `selected` property (not the attribute) also moves
// the selection after the learner has already picked a value by hand.
function select({ id, label, value, disabled = false, onChange, options }) {
  return html`<label class="vision-select"
    >${label}<select
      id=${id}
      ?disabled=${disabled}
      @change=${(event) => onChange(event.target.value)}
    >
      ${options.map(
        ([optionValue, optionLabel]) =>
          html`<option value=${optionValue} .selected=${String(optionValue) === String(value)}>
            ${optionLabel}
          </option>`,
      )}
    </select></label
  >`;
}

// A paragraph is either one string or a list of lines separated by <br>, e.g. a formula and the
// sentence that reads it out.
function paragraph(text) {
  if (!Array.isArray(text)) return html`<p>${text}</p>`;
  return html`<p>${text.flatMap((line, index) => (index ? [html`<br />`, line] : [line]))}</p>`;
}

// Reference material that shell/supplement-ui.js moves into the shared dialog.
function helpDetails({ summary, paragraphs }) {
  return html`<details data-help-dialog>
    <summary>${summary}</summary>
    ${paragraphs.map(paragraph)}
  </details>`;
}

function checkbox({ id, label, checked, onChange }) {
  return html`<label class="basics-check"
    ><input
      id=${id}
      type="checkbox"
      .checked=${checked}
      @change=${(event) => onChange(event.target.checked)}
    />${label}</label
  >`;
}

export { slider, select, helpDetails, checkbox, paragraph };
