import { html, svg, nothing, live } from '../vendor/lit-html.js';
import { fillSentence as fill } from '../core/content.js';
import { liveCaptureControls } from '../live/live-view.js';

// Templates of the measurement lab, the panel that opens under the control, launch and SLAM
// courses. Pure functions of the model built by measurement-lab.js; sentences come from
// content/systems/measurement-lab.json (`copy`), only short labels live here.

const MODES = ['repeat', 'calibrate', 'model']; // in the order of the select
const DIGITS = 3; // every measured value is shown to the same precision

// Plot box inside the 730×250 drawing: the axes meet at (left, baseline) and the data is spread
// over spanX × spanY pixels from there.
const PLOT = { left: 60, baseline: 210, spanX: 590, spanY: 170 };
const TRAIN_COLOR = '#418777'; // points the straight line is fitted to
const TEST_COLOR = '#c18837'; // points held back to check the line with
const FIT_COLOR = '#5d83bf';

const amount = (value) => (Number.isFinite(value) ? value.toFixed(DIGITS) : '—');

// --- the scatter plot -------------------------------------------------------------------------

function plotScales(rows, correction) {
  const maxInput = Math.max(1, ...rows.map((row) => row.x));
  const minInput = Math.min(0, ...rows.map((row) => row.x));
  const values = rows.map((row) => row.y + correction);
  const low = Math.min(0, ...values);
  const high = Math.max(1, ...values);
  return {
    minInput,
    maxInput,
    low,
    high,
    toX: (x) => PLOT.left + ((x - minInput) / (maxInput - minInput)) * PLOT.spanX,
    toY: (y) => PLOT.baseline - ((y - low) / (high - low)) * PLOT.spanY,
  };
}

function fitLine(fit, scales, correction) {
  const at = (x) => scales.toY(fit.slope * x + fit.intercept + correction);
  return svg`<path
    d="M${scales.toX(fit.min)},${at(fit.min)}L${scales.toX(fit.max)},${at(fit.max)}"
    stroke=${FIT_COLOR}
    stroke-width="2"
  />`;
}

function measurementPlot(rows, fit, correction, copy) {
  const scales = plotScales(rows, correction);
  return html`<svg viewBox="0 0 730 250" role="img" aria-label=${copy.panel.plotAria}>
    <rect width="730" height="250" fill="#f6f8f9" />
    <path d="M60,25V210H665" stroke="#8a9ca2" fill="none" />
    ${rows.map(
      (row) =>
        svg`<circle
          cx=${scales.toX(row.x)}
          cy=${scales.toY(row.y + correction)}
          r="5"
          fill=${row.test ? TEST_COLOR : TRAIN_COLOR}
        />`,
    )}
    ${fit ? fitLine(fit, scales, correction) : nothing}
    <text x="60" y="236" font-size="14">${amount(scales.minInput)}</text>
    <text x="610" y="236" font-size="14">${amount(scales.maxInput)}</text>
    <text x="5" y="40" font-size="14">${amount(scales.high)}</text>
    <text x="5" y="210" font-size="14">${amount(scales.low)}</text>
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

function measurementRow(row, index, model, copy, actions) {
  const labels = copy.labels;
  const position = index + 1;
  return html`<tr>
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
  return html`<div class="table-scroll">
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

function importExport(model, copy, actions) {
  return html`<div class="measurement-import">
    <label
      >${copy.labels.openCsv}
      <input
        data-measure-file
        type="file"
        accept=".csv,text/csv"
        @change=${(event) => actions.openCsv(event.target.files[0])}
    /></label>
    <button data-measure-export @click=${actions.saveCsv}>${copy.labels.saveCsv}</button>
    <p>${copy.panel.csvNote}</p>
    <p data-measure-message role="status">${model.message}</p>
  </div>`;
}

// Drives found in a recording, waiting for the distance the learner measured on the floor.
function pendingDrives(model, copy, actions) {
  const pending = model.live.pending ?? [];
  if (!pending.length) return nothing;
  const text = copy.drives;
  return html`<div class="measurement-drives">
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
            html`<tr>
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
    <p class="live-capture-note">${text.note}</p>
  </div>`;
}

// Filling the table from the connected robot. A scenario without a `live` block says why its
// reference quantity cannot come from the robot instead of offering a button that cannot work.
function liveCapture(model, copy, actions) {
  const panel = copy.panel;
  return html`<div class="measurement-live">
    <h3>${panel.liveTitle}</h3>
    ${
      model.live
        ? html`<p>${model.live.text}</p>
            ${liveCaptureControls(model.live, actions)} ${pendingDrives(model, copy, actions)}
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
      <p>${scenario.text}</p>
      <p>${panel.guide}</p>
      <p>${panel.sampleBefore}<strong>${panel.sampleName}</strong>${panel.sampleAfter}</p>
      ${modeSelect(model, copy, actions)}
      <p>${axes}</p>
      <div data-measure-plot>
        ${measurementPlot(model.rows, model.mode === 'model' ? model.fit : null, correction, copy)}
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
