import { html, nothing, svg, unsafeHTML } from '../vendor/lit-html.js';
import { fillSentence as fill } from '../core/content.js';
import { lessonLabel } from '../shell/lesson-ui.js';
import { schoolTips } from '../shell/school-tips.js';
import { lessonBrief } from '../shell/lesson-brief.js';
import {
  KEYMAP_FUNCTIONS,
  KEYMAP_SCALES,
  KEYMAP_DEADZONE,
  KEYMAP_TOPICS,
  SIM,
  robotManagerRows,
} from './core.js';

// Templates of the controller key-mapping course. Every function is pure: it turns the model
// built by ui.js into markup. Learner-facing sentences come from content/keymap.json (`copy`).

const PX_PER_M = 150; // scale of the top-down field
const FIELD_W = SIM.field.width * PX_PER_M;
const FIELD_H = SIM.field.height * PX_PER_M;
const STICK_RADIUS = 26; // px of the virtual controller's stick circles

// The on-screen controller in the browser's standard layout: [index, x, y, label].
const PAD_BUTTONS = [
  [6, 58, 22, 'L2'],
  [4, 58, 50, 'L1'],
  [7, 302, 22, 'R2'],
  [5, 302, 50, 'R1'],
  [12, 86, 94, '↑'],
  [13, 86, 138, '↓'],
  [14, 64, 116, '←'],
  [15, 108, 116, '→'],
  [3, 274, 94, '上'],
  [0, 274, 138, '下'],
  [2, 252, 116, '左'],
  [1, 296, 116, '右'],
  [8, 150, 84, '選択'],
  [9, 210, 84, '開始'],
  [16, 180, 112, 'ホーム'],
];
const PAD_STICKS = [
  { id: 'left', x: 130, y: 172, axes: [0, 1], label: '左スティック' },
  { id: 'right', x: 230, y: 172, axes: [2, 3], label: '右スティック' },
];

const fixed = (value, digits = 2) => {
  const number = Number(value);
  const rounded = Math.abs(number) < 0.5 * 10 ** -digits ? 0 : number;
  return rounded.toFixed(digits);
};
const signed = (value, digits = 2) => (Number(value) > 0 ? '+' : '') + fixed(value, digits);

function topicNav(model, actions) {
  return html`<nav class="keymap-topics" aria-label="コントローラーの割り当ての学習順序">
    ${KEYMAP_TOPICS.map(
      (topic, index) =>
        html`<button
          data-keymap-topic=${topic.id}
          aria-current=${topic.id === model.topic ? 'step' : 'false'}
          @click=${() => actions.openTopic(topic.id)}
        >
          <span>${index + 1}</span>${topic.label}
        </button>`,
    )}
  </nav>`;
}

// --- The controller ------------------------------------------------------------------------------

function padButton([index, x, y, label], model, actions) {
  const pressed = Boolean(model.input.buttons[index]);
  const wide = label.length > 2;
  const width = wide ? 44 : 30;
  return svg`<g
    class="keymap-pad-button"
    data-pressed=${pressed ? 'true' : 'false'}
    role="button"
    tabindex="0"
    aria-pressed=${pressed ? 'true' : 'false'}
    aria-label=${`ボタン${index}（${label}）`}
    @pointerdown=${(event) => actions.pressButton(event, index)}
    @pointerup=${(event) => actions.releaseButton(event, index)}
    @pointercancel=${(event) => actions.releaseButton(event, index)}
    @lostpointercapture=${(event) => actions.releaseButton(event, index)}
    @keydown=${(event) => actions.keyButton(event, index, true)}
    @keyup=${(event) => actions.keyButton(event, index, false)}
    @blur=${(event) => actions.releaseButton(event, index)}
  >
    <rect x=${x - width / 2} y=${y - 12} width=${width} height="24" rx="8"></rect>
    <text x=${x} y=${y + 1} dominant-baseline="middle" text-anchor="middle">${label}</text>
    <text class="keymap-pad-index" x=${x} y=${y + 21} text-anchor="middle">${index}</text>
  </g>`;
}

function padStick(stick, model, actions) {
  const [ax, ay] = stick.axes;
  const dx = (model.input.axes[ax] || 0) * STICK_RADIUS;
  const dy = (model.input.axes[ay] || 0) * STICK_RADIUS;
  return svg`<g
    class="keymap-pad-stick"
    role="slider"
    tabindex="0"
    aria-label=${`${stick.label}（軸${ax}・軸${ay}）。矢印キーで倒す`}
    aria-valuetext=${`軸${ax} ${fixed(model.input.axes[ax] || 0)}、軸${ay} ${fixed(model.input.axes[ay] || 0)}`}
    @pointerdown=${(event) => actions.grabStick(event, stick)}
    @pointermove=${(event) => actions.moveStick(event, stick)}
    @pointerup=${(event) => actions.dropStick(event, stick)}
    @pointercancel=${(event) => actions.dropStick(event, stick)}
    @keydown=${(event) => actions.keyStick(event, stick, true)}
    @keyup=${(event) => actions.keyStick(event, stick, false)}
    @blur=${(event) => actions.dropStick(event, stick)}
  >
    <circle class="keymap-pad-well" cx=${stick.x} cy=${stick.y} r=${STICK_RADIUS + 10}></circle>
    <circle class="keymap-pad-knob" cx=${stick.x + dx} cy=${stick.y + dy} r="15"></circle>
    <text class="keymap-pad-index" x=${stick.x} y=${stick.y + STICK_RADIUS + 22} text-anchor="middle">
      軸${ax}・${ay}
    </text>
  </g>`;
}

function virtualPad(model, actions) {
  return html`<svg
    class="keymap-pad"
    viewBox="0 0 360 230"
    role="group"
    aria-label="画面のコントローラー。ボタンは押している間、スティックはドラッグか矢印キーで倒します"
  >
    <path
      class="keymap-pad-body"
      d="M40 70 Q40 36 90 36 H270 Q320 36 320 70 L338 188 Q342 222 306 216 L252 200 H108 L54 216 Q18 222 22 188 Z"
    ></path>
    ${PAD_BUTTONS.map((item) => padButton(item, model, actions))}
    ${PAD_STICKS.map((stick) => padStick(stick, model, actions))}
  </svg>`;
}

function sourcePanel(model, copy, actions) {
  const source = copy.source;
  const pad = model.gamepad;
  const notes = [];
  if (!model.gamepadSupported) notes.push(source.unavailable);
  else if (!model.secure) notes.push(source.insecure);
  if (model.source === 'gamepad' && pad && pad.mapping !== 'standard')
    notes.push(source.nonstandard);
  if (model.source === 'virtual' && model.drift)
    notes.push(fill(source.drift, { x: signed(model.drift[0]), y: signed(model.drift[1]) }));
  return html`<section class="card keymap-source" aria-labelledby="keymapSourceHeading">
    <div class="keymap-card-heading">
      <h2 id="keymapSourceHeading">${source.heading}</h2>
      ${
        pad
          ? html`<button class="small" @click=${actions.toggleSource}>
              ${model.source === 'gamepad' ? source.useVirtual : source.useGamepad}
            </button>`
          : nothing
      }
    </div>
    <p class="keymap-source-name">
      ${model.source === 'gamepad' && pad ? fill(source.gamepad, { name: pad.id || '—' }) : source.virtual}
    </p>
    ${model.source === 'virtual' ? virtualPad(model, actions) : nothing}
    ${!pad && model.gamepadSupported ? html`<p class="helper">${source.waiting}</p>` : nothing}
    ${notes.map((note) => html`<p class="helper keymap-note">${note}</p>`)}
  </section>`;
}

function readoutPanel(model, copy) {
  const text = copy.readout;
  const pressed = model.input.buttons.flatMap((on, index) => (on ? [index] : []));
  const strongest = model.strongest;
  return html`<section class="card keymap-readout" aria-labelledby="keymapReadoutHeading">
    <h2 id="keymapReadoutHeading">${text.heading}</h2>
    <p class="keymap-readout-summary" aria-live="polite">
      ${pressed.length ? fill(text.pressed, { list: pressed.join('・') }) : text.nothing}
      <br />
      ${
        strongest.axis >= 0
          ? fill(text.moved, { axis: strongest.axis, value: signed(strongest.axisValue) })
          : text.still
      }
    </p>
    <h3>${text.buttons}</h3>
    <ol class="keymap-buttons" start="0">
      ${model.input.buttons.map(
        (on, index) =>
          html`<li data-on=${on ? 'true' : 'false'}>
            <span>${index}</span><strong>${on ? 1 : 0}</strong>
          </li>`,
      )}
    </ol>
    <h3>${text.axes}</h3>
    <ul class="keymap-axes">
      ${model.input.axes.map(
        (value, index) =>
          html`<li>
            <span>軸${index}</span>
            <span class="keymap-axis-bar" aria-hidden="true">
              <i
                style=${`left:${50 + Math.min(0, value) * 50}%;width:${Math.abs(value) * 50}%`}
              ></i>
            </span>
            <strong>${signed(value)}</strong>
          </li>`,
      )}
    </ul>
  </section>`;
}

// --- The mapping ---------------------------------------------------------------------------------

function indexOptions(kind, count, selected, copy) {
  const size = Math.max(count, selected + 1);
  const template = kind === 'axis' ? copy.mapping.axisOption : copy.mapping.buttonOption;
  return Array.from(
    { length: size },
    (_, index) =>
      html`<option value=${index} ?selected=${index === selected}>
        ${fill(template, { index })}
      </option>`,
  );
}

function problemNames(problem, copy) {
  const label = (id) =>
    copy.functions[id]?.label ||
    copy.scales[id]?.label ||
    (id === 'deadzone' ? copy.deadzone.label : id);
  return problem.ids.map(label).join('・');
}

function mappingPanel(model, copy, actions) {
  const flagged = new Set(model.problems.flatMap((problem) => problem.ids));
  return html`<section class="card keymap-mapping" aria-labelledby="keymapMappingHeading">
    <div class="keymap-card-heading">
      <h2 id="keymapMappingHeading">${copy.mapping.heading}</h2>
      <button class="small" @click=${actions.resetMapping}>${copy.mapping.resetMapping}</button>
    </div>
    <div class="keymap-fields">
      ${KEYMAP_FUNCTIONS.map((fn) => {
        const count = fn.kind === 'axis' ? model.input.axes.length : model.input.buttons.length;
        return html`<label
          class="keymap-field"
          data-flagged=${flagged.has(fn.id) ? 'true' : 'false'}
        >
          <span>${copy.functions[fn.id].label}<small>${copy.functions[fn.id].input}</small></span>
          <select @change=${(event) => actions.setIndex(fn.id, Number(event.target.value))}>
            ${indexOptions(fn.kind, count, model.mapping[fn.id], copy)}
          </select>
        </label>`;
      })}
      ${Object.entries(KEYMAP_SCALES).map(
        ([id, scale]) =>
          html`<label class="keymap-field" data-flagged=${flagged.has(id) ? 'true' : 'false'}>
            <span
              >${copy.scales[id].label}<small>${scale.unit}・${copy.scales[id].hint}</small></span
            >
            <input
              type="number"
              step="0.1"
              min=${scale.min}
              max=${scale.max}
              .value=${String(model.mapping[id])}
              @change=${(event) => actions.setNumber(id, event.target.value)}
            />
          </label>`,
      )}
      <label
        class="keymap-field keymap-deadzone"
        data-flagged=${flagged.has('deadzone') ? 'true' : 'false'}
      >
        <span
          >${copy.deadzone.label} ${fixed(model.mapping.deadzone)}<small
            >${copy.deadzone.hint}</small
          ></span
        >
        <input
          type="range"
          min=${KEYMAP_DEADZONE.min}
          max="0.6"
          step="0.01"
          .value=${String(model.mapping.deadzone)}
          @input=${(event) => actions.setNumber('deadzone', event.target.value)}
        />
      </label>
    </div>
    <h3>${copy.mapping.problemsHeading}</h3>
    <ul class="keymap-problems" aria-live="polite">
      ${
        model.problems.length
          ? model.problems.map(
              (problem) =>
                html`<li data-code=${problem.code}>
                  ${fill(copy.problems[problem.code], { names: problemNames(problem, copy) })}
                </li>`,
            )
          : html`<li data-code="none">${copy.problems.none}</li>`
      }
    </ul>
  </section>`;
}

// --- The robot model -----------------------------------------------------------------------------

const toScreen = (x, y) => [x * PX_PER_M, FIELD_H - y * PX_PER_M];

function simField(model) {
  const robot = model.robot;
  const [rx, ry] = toScreen(robot.x, robot.y);
  const degrees = (-robot.heading * 180) / Math.PI;
  const trail = model.trail.map(([x, y]) => toScreen(x, y).join(',')).join(' ');
  const grid = [];
  for (let x = 0; x <= SIM.field.width; x += 0.5)
    grid.push(svg`<line x1=${x * PX_PER_M} y1="0" x2=${x * PX_PER_M} y2=${FIELD_H}></line>`);
  for (let y = 0; y <= SIM.field.height; y += 0.5)
    grid.push(svg`<line x1="0" y1=${y * PX_PER_M} x2=${FIELD_W} y2=${y * PX_PER_M}></line>`);
  return html`<svg
    class="keymap-field-view"
    viewBox=${`0 0 ${FIELD_W} ${FIELD_H}`}
    role="img"
    aria-label="上から見たロボットの模型"
  >
    <g class="keymap-grid">${grid}</g>
    ${trail ? svg`<polyline class="keymap-trail" points=${trail}></polyline>` : nothing}
    ${robot.discs.map((disc) => {
      const [dx, dy] = toScreen(
        disc.x + Math.cos(disc.heading) * (0.18 + disc.flown),
        disc.y + Math.sin(disc.heading) * (0.18 + disc.flown),
      );
      return svg`<circle class="keymap-disc" data-weak=${disc.weak ? 'true' : 'false'} cx=${dx} cy=${dy} r="7"></circle>`;
    })}
    <g transform=${`translate(${rx} ${ry}) rotate(${degrees})`}>
      <rect class="keymap-robot-body" x="-27" y="-24" width="54" height="48" rx="8"></rect>
      <path class="keymap-robot-nose" d="M8 -14 L28 0 L8 14 Z"></path>
      <circle
        class="keymap-roller"
        data-on=${robot.roller ? 'true' : 'false'}
        cx="-10"
        cy="0"
        r="8"
      ></circle>
    </g>
  </svg>`;
}

function simPanel(model, copy, actions) {
  const text = copy.sim;
  const command = model.command;
  return html`<section class="card keymap-sim" aria-labelledby="keymapSimHeading">
    <div class="keymap-card-heading">
      <h2 id="keymapSimHeading">${text.heading}</h2>
      <button class="small" @click=${actions.resetRobot}>${text.reset}</button>
    </div>
    ${simField(model)}
    <p class="helper">${fill(text.caption, { spinUp: SIM.spinUp })}</p>
    <dl class="keymap-command">
      <div>
        <dt>${text.command}</dt>
        <dd>
          ${
            command.drive
              ? html`${fill(text.linear, { value: signed(command.drive.linear) })} ·
                ${fill(text.angular, { value: signed(command.drive.angular) })}`
              : text.noDrive
          }
        </dd>
      </div>
      <div>
        <dt>${text.launcher}</dt>
        <dd>
          ${fill(text.roller, { state: model.robot.roller ? text.rollerOn : text.rollerOff })} ·
          ${fill(text.tilt, { value: fixed(model.robot.tilt, 0) })}
        </dd>
      </div>
      <div>
        <dt>${text.shotsLabel}</dt>
        <dd>${fill(text.shots, { shots: model.robot.shots, weak: model.robot.weakShots })}</dd>
      </div>
    </dl>
    <p class="helper">${fill(text.limit, { speed: SIM.maxSpeed, turn: SIM.maxTurn })}</p>
  </section>`;
}

// --- Topic-specific blocks -----------------------------------------------------------------------

function findTable(model, copy, actions) {
  const text = copy.find;
  return html`<section class="card keymap-find" aria-labelledby="keymapFindHeading">
    <h2 id="keymapFindHeading">${text.heading}</h2>
    <p>${text.lead}</p>
    <table>
      <tbody>
        ${text.targets.map(
          (target) =>
            html`<tr>
              <th scope="row">${target.label}</th>
              <td>
                ${model.found[target.id] === undefined ? text.empty : `ボタン ${model.found[target.id]}`}
              </td>
              <td>
                <button class="small" @click=${() => actions.recordButton(target.id)}>
                  ${text.record}
                </button>
              </td>
            </tr>`,
        )}
        <tr>
          <th scope="row">${text.axisRow}</th>
          <td>
            ${
              model.found.axis
                ? fill(text.axisValue, {
                    axis: model.found.axis.axis,
                    sign: model.found.axis.value > 0 ? '＋' : '−',
                  })
                : text.axisEmpty
            }
          </td>
          <td><button class="small" @click=${actions.recordAxis}>${text.record}</button></td>
        </tr>
      </tbody>
    </table>
    ${model.findNotice ? html`<p class="helper" role="status">${model.findNotice}</p>` : nothing}
  </section>`;
}

function applyTable(model, copy, actions) {
  const text = copy.apply;
  const rows = robotManagerRows(model.mapping);
  return html`<section class="card keymap-apply" aria-labelledby="keymapApplyHeading">
    <div class="keymap-card-heading">
      <h2 id="keymapApplyHeading">${text.heading}</h2>
      <button class="small" @click=${actions.copyTable}>${text.copy}</button>
    </div>
    <p class=${model.refused.length ? 'keymap-refused' : 'helper'} role="status">
      ${model.refused.length ? text.refused : text.ready}
    </p>
    <div class="keymap-table-scroll" tabindex="0" role="region" aria-label=${text.heading}>
      <table>
        <thead>
          <tr>
            ${text.columns.map((column) => html`<th scope="col">${column}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (row) =>
              html`<tr>
                <td><code>${row.node}</code></td>
                <td><code>${row.param}</code></td>
                <td>
                  ${typeof row.value === 'number' && !Number.isInteger(row.value) ? fixed(row.value) : row.value}
                </td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>
    ${model.copyNotice ? html`<p class="helper" role="status">${model.copyNotice}</p>` : nothing}
    <p class="helper">${text.numbersNote}</p>
    <h3>${text.stepsHeading}</h3>
    <ol class="keymap-steps">
      ${text.steps.map((step) => html`<li>${step}</li>`)}
    </ol>
  </section>`;
}

function reflection(topicCopy, copy) {
  const text = topicCopy.reflection;
  return html`<section class="card keymap-reflection" aria-labelledby="keymapReflectionHeading">
    <h2 id="keymapReflectionHeading">${copy.reflection.heading}：${text.question}</h2>
    <p class="helper">${copy.reflection.hintLabel}：${text.hint}</p>
    <details>
      <summary>${copy.reflection.show}</summary>
      <p>${text.answer}</p>
    </details>
  </section>`;
}

function keymapPage(model, copy, actions) {
  const topicCopy = copy.topics[model.topic];
  const lessonKey = 'keymap-' + model.topic;
  return html`<div class="page-heading">
      <div>
        <p class="eyebrow course-label">${unsafeHTML(lessonLabel('keymap'))}</p>
        <h1>${topicCopy.title}</h1>
      </div>
    </div>
    ${topicNav(model, actions)}
    ${unsafeHTML(lessonBrief(lessonKey, topicCopy.brief) + schoolTips(lessonKey))}
    <div class="keymap-layout">
      <div class="keymap-column">
        ${sourcePanel(model, copy, actions)} ${readoutPanel(model, copy)}
      </div>
      <div class="keymap-column">
        ${model.topic === 'read' ? findTable(model, copy, actions) : nothing}
        ${model.topic === 'apply' ? applyTable(model, copy, actions) : nothing}
        ${model.topic === 'read' ? nothing : mappingPanel(model, copy, actions)}
        ${simPanel(model, copy, actions)}
      </div>
    </div>
    ${reflection(topicCopy, copy)}
    <p class="page-footnote">${copy.limitations}</p>`;
}

export { keymapPage, fixed, signed };
