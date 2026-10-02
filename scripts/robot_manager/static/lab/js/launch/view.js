import { html, nothing, unsafeHTML, repeat } from '../vendor/lit-html.js';
import { formatNumber } from '../core/dom.js';
import { lessonLabel } from '../shell/lesson-ui.js';
import { schoolTips } from '../shell/school-tips.js';
import { lessonBrief } from '../shell/lesson-brief.js';
import { runModeBadgeHtml } from '../shell/run-mode.js';
import { LAUNCH_TOPICS } from './core.js';
import { launchMechanism, launchChart } from './render.js';
import { launcherPanel } from '../live/shoot-ui.js';
import { fillSentence } from '../core/content.js';

// Templates of the disc-launcher course. Every function is pure: it turns the model built by
// ui.js (current topic, experiment state, playback, measurements) into markup. Learner-facing
// sentences come from content/launch.json (`copy`); only short labels live here.

const HISTORY_ROWS = 6; // launches listed in the numeric record table

// Fills "{name}" placeholders of a content sentence with already formatted values.

function topicNav(model, actions) {
  return html`<nav class="basics-topics launch-topics" aria-label="学ぶ順序">
    ${LAUNCH_TOPICS.map(
      (topic, index) =>
        html`<button
          data-launch-topic=${topic.id}
          aria-pressed=${String(topic.id === model.topic)}
          @click=${() => actions.openTopic(topic.id)}
        >
          <span>${index + 1}</span>${topic.title}
        </button>`,
    )}
  </nav>`;
}

function mechanismCard(copy) {
  return html`<details data-help-dialog class="card launch-intro">
    <summary>横投げのディスクと、射出部の仕組みを見る</summary>
    ${unsafeHTML(launchMechanism())}
    <p>${copy.mechanism.note}</p>
  </details>`;
}

function phaseLabel({ playing, atEnd }) {
  if (playing) return '飛行中';
  return atEnd ? '終了' : '一時停止';
}

function timeLabel(model) {
  if (!model.run) return '実験前';
  return `${phaseLabel(model)} · ${formatNumber(model.sample.t, 2)} 秒`;
}

// The slider spans the whole flight; the watched part is shaded, so a thumb at the end of the
// watched part does not look like the end of the flight.
function seekStyle(model) {
  const last = model.run ? model.run.samples.length - 1 : 0;
  const watched = last > 0 ? Math.round((model.observed / last) * 100) : 0;
  return `--watched: ${watched}%`;
}

function playButtonLabel({ playing, run, atEnd }) {
  if (playing) return 'Ⅱ 一時停止';
  if (run && !atEnd) return '▶ 続きから見る';
  return '▶ 動きを最初から見る';
}

function runButtonLabel({ playing, pending }) {
  if (playing) return '飛行を表示中…';
  if (pending) return '続きから見る';
  return 'この出力で1枚飛ばす';
}

// The key of the side view in HTML, so it stays readable on a phone. Each entry repeats the line or
// arrow drawn on the canvas (css/hs-control-launch-planning.css draws the swatches).
function legend(model, copy) {
  const text = copy.legend;
  const forces = model.topic === 'forces';
  const key = (kind, label) => html`<span class=${'launch-key launch-key-' + kind}>${label}</span>`;
  return html`<div class="launch-legend">
    ${key('flight', text.flight)}${model.topic === 'power' ? key('previous', text.previous) : nothing}${
      forces && model.showReference ? key('vacuum', text.vacuum) : nothing
    }${
      model.target === null
        ? nothing
        : key('target', fillSentence(text.target, { target: formatNumber(model.target, 1) }))
    }${
      forces && model.showForces
        ? html`${key('gravity', text.gravity)}${key('drag', text.drag)}${key('lift', text.lift)}`
        : nothing
    }<span class="launch-key-slow">${text.slow}</span>
  </div>`;
}

// The key of the record chart: hollow points, the darker mean line, and ◎ for a hit.
function chartLegend(copy, { role, target = null, hits = false }) {
  const text = copy.chart;
  return html`<div class=${'launch-chart-legend launch-chart-' + role}>
    <span class="launch-key-point">${text.point}</span
    ><span class="launch-key-mean">${text.mean}</span>${
      target === null
        ? nothing
        : html`<span class="launch-key launch-key-target"
            >${fillSentence(text.target, { target: formatNumber(target, 1) })}</span
          >`
    }${hits ? html`<span class="launch-key-hit">${text.hit}</span>` : nothing}
  </div>`;
}

function flightCard(model, copy, actions) {
  return html`<section class="card">
    <div class="section-top">
      <h2>出力と飛び方を比べる</h2>
      <span id="launchTime">${timeLabel(model)}</span>
    </div>
    <p class="launch-model-note">${copy.flight.modelNote}</p>
    <div class="launch-flight-frame" role="region" aria-label=${copy.flight.regionLabel}>
      <canvas
        id="launchFlight"
        width="760"
        height="350"
        role="img"
        aria-label=${copy.flight.canvasLabel}
      ></canvas>
    </div>
    ${legend(model, copy)}
    <div class="launch-playbar">
      <button
        id="launchPlay"
        class="small"
        ?disabled=${!model.canPlay}
        @click=${actions.togglePlay}
      >
        ${playButtonLabel(model)}</button
      ><input
        id="launchSeek"
        type="range"
        min="0"
        max=${model.run ? model.run.samples.length - 1 : 0}
        value="0"
        style=${seekStyle(model)}
        .value=${String(model.index)}
        aria-label=${copy.flight.seekLabel}
        ?disabled=${!model.run}
        @input=${(event) => actions.seek(Number(event.target.value))}
      />
    </div>
    <p id="launchStatus" class="launch-status" role="status">${model.status}</p>
    ${resultBox(model, copy)}
  </section>`;
}

function metric(label, value) {
  return html`<div><span>${label}</span><strong>${value}</strong></div>`;
}

function errorMetric(error) {
  const side = error < 0 ? '手前 ' : '奥 ';
  return side + formatNumber(Math.abs(error) * 100, 0) + ' cm';
}

function resultNote(result, topic, copy) {
  const run = result.run;
  if (topic === 'forces')
    return fillSentence(copy.results.vacuumNote, {
      range: formatNumber(run.reference.range, 2),
      time: formatNumber(run.reference.time, 2),
    });
  return fillSentence(copy.results.speedNote, { speed: formatNumber(run.speed, 2) });
}

function resultBox(model, copy) {
  const result = model.result;
  if (!result) return html`<div id="launchResult" class="launch-result" hidden></div>`;
  if (!result.released)
    return html`<div id="launchResult" class="launch-result">${copy.results.notReleased}</div>`;
  const run = result.run;
  const missed = result.error !== null;
  return html`<div id="launchResult" class="launch-result">
    <div class="launch-metrics">
      ${metric('出力指令', run.config.power + '%')}
      ${metric('最初の接地点まで', formatNumber(run.range, 2) + ' m')}
      ${
        missed
          ? metric('的の中心との差', errorMetric(result.error))
          : metric('飛んでいた時間', formatNumber(run.time, 2) + ' 秒')
      }
    </div>
    <p>${resultNote(result, model.topic, copy)}</p>
  </div>`;
}

function historyTable(rows, copy) {
  if (!rows.length) return html`<p>${copy.records.empty}</p>`;
  const firstShown = Math.max(0, rows.length - HISTORY_ROWS);
  return html`<table>
    <thead>
      <tr>
        <th>記録</th>
        <th>出力指令</th>
        <th>飛距離</th>
      </tr>
    </thead>
    <tbody>
      ${rows.slice(-HISTORY_ROWS).map(
        (row, index) =>
          html`<tr>
            <td>${firstShown + index + 1}枚目</td>
            <td>${row.power}%</td>
            <td>${formatNumber(row.range, 2)} m</td>
          </tr>`,
      )}
    </tbody>
  </table>`;
}

function recordsCard(model, copy, actions) {
  return html`<section class="card launch-data">
    <div class="section-top">
      <h2>出力と飛距離の記録</h2>
      <button
        id="launchExport"
        class="small"
        ?disabled=${!model.rows.length}
        @click=${actions.saveCsv}
      >
        CSV保存
      </button>
    </div>
    <div id="launchGraph">
      ${unsafeHTML(
        launchChart(model.rows, {
          target: model.target,
          width: model.chartWidth,
          role: 'actual',
          copy: copy.chart,
        }),
      )}
    </div>
    ${chartLegend(copy, {
      role: 'actual',
      target: model.target,
      hits: model.topic === 'target',
    })}
    <p>${copy.records.chartNote}</p>
    <details>
      <summary>数値の記録を見る（直近6枚）</summary>
      <div id="launchHistory" class="launch-table">${historyTable(model.rows, copy)}</div>
    </details>
  </section>`;
}

function conditionIntro(model, copy) {
  if (model.topic !== 'target') return html`<p>${copy.controls.powerNote}</p>`;
  return html`<p id="launchProgress">
      ${fillSentence(copy.controls.targetsReached, { count: String(model.hitCount) })}
    </p>
    <p>${copy.controls.targetNote}</p>`;
}

function forcesControls(model, copy, actions) {
  return html`<button
      id="launchShowArrows"
      class="full launch-arrows-button"
      ?disabled=${model.playing}
      @click=${actions.showArrows}
    >
      ${copy.controls.arrowButton}</button
    ><label class="launch-check"
      ><input
        type="checkbox"
        id="launchForceToggle"
        checked
        .checked=${model.showForces}
        @change=${(event) => actions.showForces(event.target.checked)}
      />働く力を矢印で見る</label
    ><label class="launch-check"
      ><input
        type="checkbox"
        id="launchReference"
        checked
        .checked=${model.showReference}
        @change=${(event) => actions.showReference(event.target.checked)}
      />空気がない計算を重ねる</label
    >
    <p class="helper">${copy.controls.forcesHelper}</p>`;
}

function estimateHint(estimate, copy) {
  if (!estimate.ok) return estimate.message;
  return fillSentence(copy.controls.estimateHint, { power: formatNumber(estimate.power, 0) });
}

function targetControls(model, copy, actions) {
  return html`<details class="launch-hint">
      <summary>記録から次の出力を考える</summary>
      <p id="launchEstimate">${estimateHint(model.estimate, copy)}</p>
    </details>
    <button
      id="launchTargetNext"
      class="full"
      ?disabled=${!model.canAdvanceTarget}
      ?hidden=${model.lastTarget}
      @click=${actions.nextTarget}
    >
      次の的へ →
    </button>`;
}

function conditionPanel(model, copy, actions) {
  const title =
    model.topic === 'target' ? `的まで ${formatNumber(model.target)} m` : 'モーターの出力を決める';
  return html`<aside class="guide card launch-guide">
    <p class="eyebrow">条件を決める</p>
    <h2>${title}</h2>
    ${conditionIntro(model, copy)}
    <label class="launch-power-label" for="launchPower"
      >モーターへの出力指令<output id="launchPowerValue">${model.power}%</output></label
    ><input
      id="launchPower"
      type="range"
      min="0"
      max="100"
      step="1"
      .value=${String(model.power)}
      ?disabled=${model.pending}
      @input=${(event) => actions.setPower(Number(event.target.value))}
    />
    <p class="helper">${copy.controls.powerHelper}</p>
    <details class="launch-power-detail">
      <summary>${copy.controls.powerDetailSummary}</summary>
      <p class="helper">${copy.controls.powerDetail}</p>
    </details>
    <button class="primary full" id="launchRun" ?disabled=${model.playing} @click=${actions.launch}>
      ${runButtonLabel(model)}
    </button>
    ${model.topic === 'forces' ? forcesControls(model, copy, actions) : nothing}
    ${model.topic === 'target' ? targetControls(model, copy, actions) : nothing}
    <details data-help-dialog class="launch-model">
      <summary>固定している条件と仮定</summary>
      ${copy.controls.assumptions.map((paragraph) => html`<p>${paragraph}</p>`)}
    </details>
  </aside>`;
}

function experimentBody(model, copy, fragments, actions) {
  return html`${mechanismCard(copy)}
    <div class="launch-layout">
      <div class="launch-workspace">
        ${flightCard(model, copy, actions)}${recordsCard(model, copy, actions)}
      </div>
      ${conditionPanel(model, copy, actions)}
    </div>
    <section class="card launch-reflection">
      ${unsafeHTML(fragments.reflections[model.topic])}
    </section>`;
}

// --- The real-robot measurement: one table of discs --------------------------------------------

const KIND_LABELS = { typed: '手入力', file: 'CSV' };

function whenText(row) {
  if (row.time) return row.time;
  return KIND_LABELS[row.kind] ?? '—';
}

// The fields of a disc still waiting: a row of its own under it (full width, so the fields and
// the button fit on a phone), with its own small form, so Enter or 「表に入れる」 takes that row.
// The fields keep what the learner types across redraws (no value binding), and `repeat` keeps
// each row's fields.
function entryRow(row, copy, actions) {
  const text = copy.measurement;
  const rangeLabel = fillSentence(text.shotRangeLabel, { count: String(row.number) });
  const powerLabel = fillSentence(text.shotPowerLabel, { count: String(row.number) });
  return html`<tr class="waiting launch-shot-entry">
    <td colspan="5">
      <form class="launch-shot-form" @submit=${(event) => actions.setShotRange(row.id, event)}>
        ${
          row.entry === 'both'
            ? html`<label for=${'launchShotPower' + row.id}>${powerLabel}</label>
                <input
                  id=${'launchShotPower' + row.id}
                  name="power"
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  inputmode="numeric"
                  value=${row.power ?? ''}
                  required
                  data-launch-shot-power=${row.id}
                />`
            : nothing
        }
        <label for=${'launchShotRange' + row.id}>${rangeLabel}</label>
        <input
          id=${'launchShotRange' + row.id}
          name="range"
          type="number"
          min="0"
          max="30"
          step="0.01"
          inputmode="decimal"
          placeholder="例：1.25"
          required
          data-launch-shot-range=${row.id}
        /><button type="submit" class="small primary">${text.enter}</button>
      </form>
    </td>
  </tr>`;
}

function distanceText(row, quickId, text) {
  if (!row.waiting) return `${formatNumber(row.range, 2)} m`;
  return row.id === quickId ? text.quickHere : text.shotWaiting;
}

// The disc fired last waits for its distance in the launcher block (quickEntry), not here.
function tableRow(row, quickId, copy, actions) {
  const text = copy.measurement;
  const power = row.power === null ? '—' : `${row.power}%`;
  const entry = row.waiting && row.id !== null && row.id !== quickId;
  return html`<tr data-launch-shot=${row.id ?? ''} class=${row.waiting ? 'waiting' : ''}>
      <td>${row.number}</td>
      <td>${whenText(row)}</td>
      <td>${row.entry === 'both' ? text.shotWaiting : power}</td>
      <td>${row.tilt === null ? '—' : `${formatNumber(row.tilt, 1)}°`}</td>
      <td>${distanceText(row, quickId, text)}</td>
    </tr>
    ${entry ? entryRow(row, copy, actions) : nothing}`;
}

function tableFiles(measurement, actions) {
  return html`<div class="launch-file-row">
    <button
      id="launchMeasuredExport"
      class="small"
      ?disabled=${!measurement.rows.length}
      @click=${actions.saveMeasurementsCsv}
    >
      この表をCSV保存</button
    ><label class="vision-file"
      >測定CSVを開く<input
        id="launchImport"
        type="file"
        accept=".csv,text/csv"
        @change=${actions.importCsv} /></label
    ><button id="launchTemplate" class="small" @click=${actions.saveCsvTemplate}>
      空の測定CSVを保存
    </button>
  </div>`;
}

/**
 * The one table of the topic: every disc, 1…N — fired from the launcher block above (time and
 * tilt filled in), added by hand (「行を手で追加」) or read from a CSV — with the distance fields of
 * the discs still waiting, and the CSV actions of the same rows under it.
 */
function shotsTable(measurement, copy, actions) {
  const text = copy.measurement;
  const example = measurement.source !== 'measured';
  return html`<section class="card launch-shots" id="launchShots" data-launch-shots>
    <h2>${unsafeHTML(runModeBadgeHtml('data'))} ${text.shotsTitle}</h2>
    <p class="helper">${example ? text.sourceExample : text.shotsNote}</p>
    ${
      measurement.waiting
        ? html`<p class="launch-shots-waiting">
            ${fillSentence(text.shotsWaiting, { count: String(measurement.waiting) })}
          </p>`
        : nothing
    }
    <div class="launch-table launch-shots-table">
      <table>
        <thead>
          <tr>
            <th>枚</th>
            <th>時刻</th>
            <th>出力</th>
            <th>角度</th>
            <th>距離</th>
          </tr>
        </thead>
        <tbody>
          ${repeat(
            measurement.table,
            (row) => row.id ?? `row-${row.number}`,
            (row) => tableRow(row, measurement.quick?.id ?? null, copy, actions),
          )}
        </tbody>
      </table>
    </div>
    ${measurement.table.length ? nothing : html`<p>${text.empty}</p>`}
    <div class="launch-table-actions">
      <button class="small" data-launch-add-row @click=${actions.addTypedRow}>行を手で追加</button
      ><button
        id="launchRemoveMeasurement"
        class="small"
        ?disabled=${!measurement.canRemove}
        @click=${actions.removeLastMeasurement}
      >
        最後の1枚を削除
      </button>
    </div>
    <p class="helper">${text.typedHelper}</p>
    <p id="launchImportStatus" role="status">${measurement.importStatus}</p>
    ${tableFiles(measurement, actions)}
    <p class="helper">${text.csvHelper}</p>
  </section>`;
}

function measurementCard(measurement, chartWidth, copy) {
  const sourceNote =
    measurement.source === 'measured'
      ? copy.measurement.sourceMeasured
      : copy.measurement.sourceExample;
  return html`<section class="card launch-data">
    <div class="section-top">
      <h2>${unsafeHTML(runModeBadgeHtml('data'))} 測定した出力と飛距離</h2>
    </div>
    <p id="launchSourceNote">${sourceNote}</p>
    <div id="launchMeasuredGraph">
      ${unsafeHTML(
        launchChart(measurement.rows, {
          target: measurement.chartTarget,
          estimate: measurement.estimate,
          width: chartWidth,
          role: 'measured',
          copy: copy.chart,
        }),
      )}
    </div>
    ${chartLegend(copy, { role: 'measured', target: measurement.chartTarget })}
    <p>${copy.measurement.chartNote}</p>
  </section>`;
}

function calibrationText(estimate, copy) {
  if (!estimate.ok) return estimate.message;
  const candidate = fillSentence(copy.measurement.candidate, {
    power: formatNumber(estimate.power, 1),
  });
  return candidate + estimate.message;
}

// Which data the chart reads and the distance to aim at next; the rows themselves are the table.
function measurementPanel(measurement, copy, actions) {
  return html`<aside class="guide card launch-guide">
    <label class="launch-source-label" for="launchSource">使用するデータ</label
    ><select
      id="launchSource"
      aria-label=${copy.measurement.sourceLabel}
      .value=${measurement.source}
      @change=${(event) => actions.setSource(event.target.value)}
    >
      <option value="measured">実機の測定</option>
      <option value="example">入力例（模擬）</option>
    </select>
    <label for="launchMeasuredTarget">次に狙う距離（m）</label
    ><input
      id="launchMeasuredTarget"
      type="number"
      min="0.1"
      max="30"
      step="0.1"
      value=${measurement.target}
      @input=${(event) => actions.setMeasurementTarget(Number(event.target.value))}
    />
    <div class="launch-calibration" id="launchCalibration" role="status">
      ${calibrationText(measurement.estimate, copy)}
    </div>
  </aside>`;
}

// The distance of the disc just fired, typed right under 「1枚発射」 (the launcher block draws it
// with its own redraws, launcherPanel `after`). Its row in the table says so.
function quickEntry(quick, copy, actions) {
  if (!quick) return nothing;
  const text = copy.measurement;
  const label = fillSentence(text.quickLabel, {
    count: String(quick.number),
    percent: String(quick.power),
    tilt: quick.tilt === null ? '—' : formatNumber(quick.tilt, 0),
  });
  return html`<form
    class="launch-shot-form launch-quick-entry"
    data-launch-quick-entry=${quick.id}
    @submit=${(event) => actions.setShotRange(quick.id, event)}
  >
    <label for=${'launchShotRange' + quick.id}>${label}</label>
    <input
      id=${'launchShotRange' + quick.id}
      name="range"
      type="number"
      min="0"
      max="30"
      step="0.01"
      inputmode="decimal"
      placeholder="例：1.25"
      required
      data-launch-shot-range=${quick.id}
    /><button type="submit" class="small primary">${text.enter}</button>
  </form>`;
}

// Firing from the lesson (js/live/shoot-ui.js draws the block itself, with the emergency stop and
// the launcher's state): each disc fired here adds a row to the table right under the block, and
// its distance field comes right under the fire button.
function shootCard(measurement, copy, actions) {
  return html`<section class="card launch-shoot">
    ${launcherPanel('launch-measure', {
      onShot: actions.addShot,
      lesson: 'launch-measure',
      after: () => quickEntry(measurement.quick, copy, actions),
    })}
  </section>`;
}

function measurementBody(model, copy, fragments, actions) {
  return html`${shootCard(model.measurement, copy, actions)}
    ${shotsTable(model.measurement, copy, actions)}
    <div class="launch-layout">
      ${measurementCard(model.measurement, model.chartWidth, copy)}${measurementPanel(
        model.measurement,
        copy,
        actions,
      )}
    </div>
    <section class="card launch-reflection">${unsafeHTML(fragments.measureReflection)}</section>`;
}

// The button of the 「最初に試すこと」 card (shell/lesson-brief.js): a simulated launch starts; on
// the real robot the launcher block comes on screen (its safety tick comes first).
function quickStart(model, copy) {
  if (model.topic === 'measure')
    return { label: copy.measurement.quickStart, target: '.launch-shoot' };
  return { label: runButtonLabel(model), target: '#launchRun', press: true };
}

function launchPage(model, copy, fragments, actions) {
  const topicCopy = copy.topics[model.topic];
  const lessonKey = 'launch-' + model.topic;
  const body = model.topic === 'measure' ? measurementBody : experimentBody;
  return html`<div class="page-heading">
      <div>
        <p class="eyebrow course-label">${unsafeHTML(lessonLabel('launch'))}</p>
        <h1>${topicCopy.title}</h1>
      </div>
    </div>
    ${topicNav(model, actions)}
    ${unsafeHTML(lessonBrief(lessonKey, topicCopy.brief, { start: quickStart(model, copy) }) + schoolTips(lessonKey))}
    ${body(model, copy, fragments, actions)}`;
}

export { launchPage };
