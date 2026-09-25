import { html, svg, nothing, live, unsafeHTML, ref } from '../vendor/lit-html.js';
import { fillSentence as fill } from '../core/content.js';
import { formatTick } from '../core/chart-scale.js';
import { measurementPlotAxes } from './measurement-core.js';
import { liveCaptureControls } from '../live/live-view.js';
import { runModeBadgeHtml } from '../shell/run-mode.js';

// Templates of the measurement lab, the panel that opens under the control, launch and SLAM
// courses. Pure functions of the model built by measurement-lab.js; sentences come from
// content/systems/measurement-lab.json (`copy`), only short labels live here.

const MODES = ['repeat', 'calibrate', 'model']; // in the order of the select
const DIGITS = 3; // every measured value is shown to the same precision

const TRAIN_COLOR = '#418777'; // points the straight line is fitted to
const TEST_COLOR = '#c18837'; // points held back to check the line with
const FIT_COLOR = '#5d83bf';

const amount = (value) => (Number.isFinite(value) ? value.toFixed(DIGITS) : '—');

// --- the scatter plot -------------------------------------------------------------------------

const GRID_COLOR = '#dde5e8';
const AXIS_COLOR = '#8a9ca2';
const TICK_TEXT_COLOR = '#43555b';
const TICK_TEXT = 13; // px on screen: the viewBox is as wide as the plot (measurementPlotAxes)
const POINT_RADIUS = 5;

function fitLine(fit, axes, correction) {
  const at = (x) => axes.toY(fit.slope * x + fit.intercept + correction);
  return svg`<path
    d="M${axes.toX(fit.min)},${at(fit.min)}L${axes.toX(fit.max)},${at(fit.max)}"
    stroke=${FIT_COLOR}
    stroke-width="2"
  />`;
}

// Grid lines at the round ticks, the zero line thicker, labels at 13 px.
function plotGrid(axes) {
  const { box, x, y } = axes;
  const yLines = y.ticks.map((value) => {
    const top = axes.toY(value);
    return svg`<line x1=${box.left} x2=${box.right} y1=${top} y2=${top}
        stroke=${value === 0 ? AXIS_COLOR : GRID_COLOR} stroke-width=${value === 0 ? 2 : 1} />
      <text x=${box.left - 6} y=${top + 4} text-anchor="end" font-size=${TICK_TEXT}
        fill=${TICK_TEXT_COLOR}>${formatTick(value, y.step)}</text>`;
  });
  const xLines = x.ticks.map((value) => {
    const left = axes.toX(value);
    return svg`<line x1=${left} x2=${left} y1=${box.top} y2=${box.bottom}
        stroke=${value === 0 ? AXIS_COLOR : GRID_COLOR} stroke-width=${value === 0 ? 2 : 1} />
      <text x=${left} y=${box.bottom + 20} text-anchor="middle" font-size=${TICK_TEXT}
        fill=${TICK_TEXT_COLOR}>${formatTick(value, x.step)}</text>`;
  });
  return [yLines, xLines];
}

function measurementPlot(model, fit, correction, copy) {
  const axes = measurementPlotAxes(model.rows, correction, model.plotWidth);
  return html`<svg
    viewBox="0 0 ${axes.width} ${axes.height}"
    role="img"
    aria-label=${copy.panel.plotAria}
  >
    <rect width=${axes.width} height=${axes.height} fill="#f6f8f9" />
    ${plotGrid(axes)}
    ${model.rows.map(
      (row) =>
        svg`<circle
          cx=${axes.toX(row.x)}
          cy=${axes.toY(row.y + correction)}
          r=${POINT_RADIUS}
          fill=${row.test ? TEST_COLOR : TRAIN_COLOR}
        />`,
    )}
    ${fit ? fitLine(fit, axes, correction) : nothing}
  </svg>`;
}

// --- the three kinds of result ------------------------------------------------------------------

function repeatResult(model, copy) {
  const text = copy.repeat;
  return html`<p>${text.intro}</p>
    <table>
      <thead>
        <tr>
          ${text.columns.map((column) => html`<th>${column}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${model.groups.map(
          (group) =>
            html`<tr>
              <th>${group.input}</th>
              <td>${group.stats.n}</td>
              <td>${amount(group.stats.mean)}</td>
              <td>${amount(group.stats.min) + '〜' + amount(group.stats.max)}</td>
              <td>${group.stats.n > 1 ? amount(group.stats.sd) : text.singleSample}</td>
            </tr>`,
        )}
      </tbody>
    </table>
    <p>${text.advice}</p>`;
}

function calibrateResult(model, copy) {
  const text = copy.calibrate;
  if (!model.stats) return html`<p>${text.noData}</p>`;
  const comparison = fill(text.comparison, {
    input: model.selectedX,
    mean: amount(model.stats.mean),
    reference: amount(model.reference),
  });
  const difference = model.reference - model.stats.mean;
  return html`<p>${comparison}</p>
    <p>
      ${text.differenceLabel}<strong>${amount(difference)}</strong>${model.correct ? text.applied : text.notApplied}
    </p>
    <p>${text.advice}</p>`;
}

function predictionTable(fit, copy) {
  const text = copy.model;
  if (!fit.predictions.length) return html`<p>${text.needTestRow}</p>`;
  return html`<table>
    <thead>
      <tr>
        ${text.columns.map((column) => html`<th>${column}</th>`)}
      </tr>
    </thead>
    <tbody>
      ${fit.predictions.map(
        (prediction) =>
          html`<tr>
            <td>${prediction.x}</td>
            <td>${amount(prediction.predicted)}</td>
            <td>${amount(prediction.y)}</td>
            <td>${amount(prediction.error) + (prediction.inside ? '' : text.outsideRange)}</td>
          </tr>`,
      )}
    </tbody>
  </table>`;
}

function modelResult(model, copy) {
  const text = copy.model;
  const fit = model.fit;
  if (!fit) return html`<p>${text.needTwoInputs}</p>`;
  const formula = fill(text.formula, {
    slope: amount(fit.slope),
    sign: fit.intercept < 0 ? text.minus : text.plus,
    intercept: amount(Math.abs(fit.intercept)),
  });
  return html`<p>${text.foundBefore}<strong>${formula}</strong>${text.foundAfter}</p>
    <p>${text.colourKey}</p>
    ${predictionTable(fit, copy)}
    <p>${text.approximation}</p>`;
}

function measurementResult(model, copy) {
  if (model.mode === 'repeat') return repeatResult(model, copy);
  if (model.mode === 'calibrate') return calibrateResult(model, copy);
  return modelResult(model, copy);
}

// --- the editable table of measurements ----------------------------------------------------------

// Where the rows came from (a recording, a file, typed in) appears once any row says so.
const hasSources = (rows) => rows.some((row) => row.from);

// Rows from one recording or file arrive together, so the source is a full-width line above each
// run of rows with the same source: readable on a phone, where a fifth column would squeeze the
// number fields.
// `fallback` names rows saved before rows said where they came from.
function sourceLine(rows, index, copy, columns, fallback) {
  if (!hasSources(rows)) return nothing;
  const from = rows[index].from ?? fallback;
  if (index > 0 && (rows[index - 1].from ?? fallback) === from) return nothing;
  return html`<tr class="measurement-from-row">
    <th colspan=${columns} scope="rowgroup">${fill(copy.labels.sourceLine, { source: from })}</th>
  </tr>`;
}

const TABLE_COLUMNS = 4;

function measurementRow(row, index, model, copy, actions) {
  const labels = copy.labels;
  const position = index + 1;
  const fallback =
    model.source === copy.sources.example ? copy.sources.example : copy.sources.unknown;
  return html`${sourceLine(model.rows, index, copy, TABLE_COLUMNS, fallback)}
    <tr>
      <td>
        <input
          aria-label=${fill(labels.rowInput, { row: position })}
          data-row=${index}
          data-col="x"
          type="number"
          step="any"
          .value=${live(String(row.x))}
          @change=${(event) => actions.editCell(index, 'x', event.target.value)}
        />
      </td>
      <td>
        <input
          aria-label=${fill(labels.rowValue, { row: position })}
          data-row=${index}
          data-col="y"
          type="number"
          step="any"
          .value=${live(String(row.y))}
          @change=${(event) => actions.editCell(index, 'y', event.target.value)}
        />
      </td>
      <td>
        <input
          aria-label=${fill(labels.rowTest, { row: position })}
          data-row=${index}
          data-col="test"
          type="checkbox"
          .checked=${live(Boolean(row.test))}
          @change=${(event) => actions.editCell(index, 'test', event.target.checked)}
        />
      </td>
      <td>
        <button
          data-remove=${index}
          aria-label=${fill(labels.rowRemove, { row: position })}
          @click=${() => actions.removeRow(index)}
        >
          ${labels.remove}
        </button>
      </td>
    </tr>`;
}

function measurementTable(model, copy, actions) {
  const scenario = model.scenario;
  return html`<div class="table-scroll" data-measure-table>
    <table>
      <thead>
        <tr>
          <th>${scenario.inputLabel}</th>
          <th>${scenario.valueLabel}</th>
          <th>${copy.labels.testColumn}</th>
          <th></th>
        </tr>
      </thead>
      <tbody data-measure-rows>
        ${model.rows.map((row, index) => measurementRow(row, index, model, copy, actions))}
      </tbody>
    </table>
  </div>`;
}

// --- the panel ------------------------------------------------------------------------------------

function modeSelect(model, copy, actions) {
  return html`<label
    >${copy.labels.mode}
    <select data-measure-mode @change=${(event) => actions.selectMode(event.target.value)}>
      ${MODES.map(
        (mode) =>
          html`<option value=${mode} ?selected=${mode === model.mode}>
            ${copy.labels.modes[mode]}
          </option>`,
      )}
    </select></label
  >`;
}

function calibrationControls(model, copy, actions) {
  return html`<div data-measure-calibration ?hidden=${model.mode !== 'calibrate'}>
    <label
      >${copy.labels.comparedInput}
      <input
        data-measure-x
        type="number"
        .value=${String(model.selectedX)}
        @change=${(event) => actions.setSelectedInput(event.target.value)}
    /></label>
    <label
      >${copy.labels.reference}
      <input
        data-measure-reference
        type="number"
        step="any"
        .value=${String(model.reference)}
        @change=${(event) => actions.setReference(event.target.value)}
    /></label>
    <label class="sys-check"
      ><input
        type="checkbox"
        data-measure-correct
        .checked=${live(model.correct)}
        @change=${(event) => actions.setCorrect(event.target.checked)}
      />${copy.labels.applyCorrection}</label
    >
  </div>`;
}

// 置き換える / 追加する for a file opened while the table already holds measurements.
function choiceButtons(copy, actions) {
  return html`<div class="measurement-choice" data-measure-choice>
    <button class="primary" @click=${() => actions.chooseIncoming('replace')}>
      ${copy.labels.replace}
    </button>
    <button @click=${() => actions.chooseIncoming('add')}>${copy.labels.add}</button>
  </div>`;
}

const tableJump = (copy, actions) =>
  html`<button class="quiet" data-measure-show-table @click=${actions.showTable}>
    ${copy.labels.showTable}
  </button>`;

function importExport(model, copy, actions) {
  return html`<div class="measurement-import">
    <label
      >${copy.labels.openCsv}
      <input
        data-measure-file
        type="file"
        accept=".csv,text/csv"
        @change=${(event) => {
          actions.openCsv(event.target.files[0]);
          // Picking the same file again (after fixing it) must fire change again.
          event.target.value = '';
        }}
    /></label>
    <button data-measure-export @click=${actions.saveCsv}>${copy.labels.saveCsv}</button>
    <p>${copy.panel.csvNote}</p>
    <p data-measure-message role="status">${model.message}</p>
    ${model.csvChoice ? choiceButtons(copy, actions) : nothing}
    ${model.csvJump ? tableJump(copy, actions) : nothing}
  </div>`;
}

// Drives found in a recording, waiting for the distance the learner measured on the floor.
function pendingDrives(model, copy, actions) {
  const pending = model.live.pending ?? [];
  if (!pending.length)
    return model.live.added
      ? html`<p role="status" data-drive-added>${model.live.added}</p>`
      : nothing;
  const text = copy.drives;
  return html`<div class="measurement-drives" data-measure-drives>
    <p>${text.intro}</p>
    <table>
      <thead>
        <tr>
          ${text.columns.map((column) => html`<th>${column}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${pending.map(
          (drive, index) =>
            html`${sourceLine(pending, index, copy, text.columns.length, copy.sources.unknown)}
              <tr>
                <td>${drive.number}</td>
                <td>${drive.wheel.toFixed(1)}</td>
                <td>${drive.turn + '°'}</td>
                <td>
                  <input
                    data-drive-floor=${index}
                    aria-label=${fill(text.floorLabel, { number: drive.number })}
                    type="number"
                    step="0.1"
                    min="0"
                    .value=${live(drive.floor)}
                    @change=${(event) => actions.setFloor(index, event.target.value)}
                  />
                </td>
              </tr>`,
        )}
      </tbody>
    </table>
    <button data-drive-add @click=${actions.addDrives}>${text.add}</button>
    ${model.live.added ? html`<p role="status" data-drive-added>${model.live.added}</p>` : nothing}
    <p class="live-capture-note">${text.note}</p>
  </div>`;
}

// How far "N cm走らせて記録する" drives; only offered while the panel can drive the robot.
function driveDistanceSelect(model, copy, actions) {
  const live = model.live;
  if (!live.driveDistances.length || !live.drive?.allowed || !live.link.connected) return nothing;
  return html`<label class="control-live-speed"
    >${copy.messages.driveDistanceLabel}
    <select
      data-drive-distance
      ?disabled=${live.recording}
      @change=${(event) => actions.setDriveDistance(Number(event.target.value))}
    >
      ${live.driveDistances.map(
        (distance) =>
          html`<option value=${distance} ?selected=${distance === live.driveDistance}>
            ${fill(copy.messages.driveDistanceOption, { cm: Math.round(distance * 100) })}
          </option>`,
      )}
    </select></label
  >`;
}

// Filling the table from the connected robot. A scenario without a `live` block says why its
// reference quantity cannot come from the robot instead of offering a button that cannot work.
// What the last recording or opened file did to the table. It stands outside the shared block,
// whose offline form is folded: a learner who opened a file there must still see this sentence.
function liveNote(model, copy, actions) {
  const live = model.live;
  if (!live.message) return nothing;
  return html`<div class="measurement-live-note" data-measure-live-note>
    <p role="status">${live.message}</p>
    ${live.choice ? choiceButtons(copy, actions) : nothing}
    ${live.jump && !live.choice ? tableJump(copy, actions) : nothing}
  </div>`;
}

function liveCapture(model, copy, actions) {
  const panel = copy.panel;
  return html`<div class="measurement-live" data-measure-live>
    <h3>
      ${model.live ? unsafeHTML(runModeBadgeHtml('live')) : nothing}
      ${model.live?.drive ? unsafeHTML(runModeBadgeHtml('drive')) : nothing} ${panel.liveTitle}
    </h3>
    ${
      model.live
        ? html`<p>${model.live.text}</p>
            ${driveDistanceSelect(model, copy, actions)} ${pendingDrives(model, copy, actions)}
            ${liveCaptureControls({ ...model.live, message: '' }, actions)}
            ${liveNote(model, copy, actions)}
            <p>${model.live.referenceNote ?? panel.liveReferenceNote}</p>`
        : html`<p>${panel.liveUnavailable}</p>`
    }
  </div>`;
}

function measurementPanel(model, copy, actions) {
  const panel = copy.panel;
  const scenario = model.scenario;
  const axes = fill(panel.axes, { input: scenario.inputLabel, value: scenario.valueLabel });
  const correction = model.mode === 'calibrate' ? model.correction : 0;
  return html`<details data-help-dialog>
    <summary>${panel.summary}</summary>
    <div class="measurement-lab">
      <h2>${panel.title}</h2>
      ${
        model.live
          ? html`<button
              class="quiet measurement-jump"
              data-measure-jump
              @click=${actions.jumpToLive}
            >
              ${panel.jumpToLive}
            </button>`
          : nothing
      }
      <p>${scenario.text}</p>
      <p>${panel.guide}</p>
      <p>${panel.sampleBefore}<strong>${panel.sampleName}</strong>${panel.sampleAfter}</p>
      ${modeSelect(model, copy, actions)}
      <p>${axes}</p>
      <div data-measure-plot ${ref(actions.watchPlot)}>
        ${measurementPlot(model, model.mode === 'model' ? model.fit : null, correction, copy)}
      </div>
      ${calibrationControls(model, copy, actions)}
      <div data-measure-result>${measurementResult(model, copy)}</div>
      <h3>${copy.labels.tableTitle}</h3>
      <p data-measure-source>${fill(panel.inUse, { source: model.source })}</p>
      ${measurementTable(model, copy, actions)}
      <button data-measure-add @click=${actions.addRow}>${copy.labels.addRow}</button>
      ${importExport(model, copy, actions)}${liveCapture(model, copy, actions)}
    </div>
  </details>`;
}

export { measurementPanel };
