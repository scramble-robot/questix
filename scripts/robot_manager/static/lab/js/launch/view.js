import { html, nothing, unsafeHTML } from '../vendor/lit-html.js';
import { formatNumber } from '../core/dom.js';
import { lessonLabel } from '../shell/lesson-ui.js';
import { schoolTips } from '../shell/school-tips.js';
import { lessonBrief } from '../shell/lesson-brief.js';
import { LAUNCH_TOPICS } from './core.js';
import { launchMechanism, launchChart } from './render.js';
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

function legend(topic) {
  return html`<div class="launch-legend">
    <span>━ 今回</span
    >${topic === 'power' ? html`<span class="launch-previous">┄ 前回</span>` : nothing}${
      topic === 'forces' ? html`<span class="launch-vacuum">┄ 空気がない計算</span>` : nothing
    }<span>5倍スロー</span>
  </div>`;
}

function flightCard(model, copy, actions) {
  return html`<section class="card">
    <div class="section-top">
      <h2>出力と飛び方を比べる</h2>
      <span id="launchTime">${timeLabel(model)}</span>
    </div>
    <p class="launch-model-note">${copy.flight.modelNote}</p>
    <div class="diagram-scroll" role="region" aria-label=${copy.flight.regionLabel} tabindex="0">
      <canvas
        id="launchFlight"
        width="760"
        height="350"
        role="img"
        aria-label=${copy.flight.canvasLabel}
      ></canvas>
    </div>
    <p class="diagram-scroll-hint">${copy.flight.scrollHint}</p>
    ${legend(model.topic)}
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
        max=${model.observed}
        value="0"
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
      ${metric('出力指示', run.config.power + '%')}
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
        <th>出力指示</th>
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
    <div id="launchGraph">${unsafeHTML(launchChart(model.rows, model.target))}</div>
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
  return html`<label class="launch-check"
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
      >モーターへの出力指示<output id="launchPowerValue">${model.power}%</output></label
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

function measurementTable(measurement, copy) {
  if (!measurement.rows.length) return html`<p>${copy.measurement.empty}</p>`;
  return html`<table>
    <thead>
      <tr>
        <th>出力</th>
        <th>枚数</th>
        <th>平均</th>
        <th>最小〜最大</th>
      </tr>
    </thead>
    <tbody>
      ${measurement.estimate.groups.map(
        (group) =>
          html`<tr>
            <td>${group.power}%</td>
            <td>${group.count}</td>
            <td>${formatNumber(group.mean, 2)} m</td>
            <td>${formatNumber(group.min, 2)}〜${formatNumber(group.max, 2)} m</td>
          </tr>`,
      )}
    </tbody>
  </table>`;
}

function measurementCard(measurement, copy, actions) {
  const sourceNote =
    measurement.source === 'measured'
      ? copy.measurement.sourceMeasured
      : copy.measurement.sourceExample;
  return html`<section class="card launch-data">
    <div class="section-top"><h2>測定した出力と飛距離</h2></div>
    <p id="launchSourceNote">${sourceNote}</p>
    <div id="launchMeasuredGraph">
      ${unsafeHTML(launchChart(measurement.rows, measurement.chartTarget, measurement.estimate))}
    </div>
    <p>${copy.measurement.chartNote}</p>
    <div id="launchMeasuredRows" class="launch-table">${measurementTable(measurement, copy)}</div>
    <div class="launch-file-row">
      <button
        id="launchMeasuredExport"
        class="small"
        ?disabled=${!measurement.rows.length}
        @click=${actions.saveMeasurementsCsv}
      >
        この記録をCSV保存</button
      ><button
        id="launchRemoveMeasurement"
        class="small"
        ?disabled=${!measurement.canRemove}
        @click=${actions.removeLastMeasurement}
      >
        最後の1枚を削除</button
      ><label class="vision-file"
        >測定CSVを開く<input
          id="launchImport"
          type="file"
          accept=".csv,text/csv"
          @change=${actions.importCsv}
      /></label>
    </div>
    <p id="launchImportStatus" role="status">${measurement.importStatus}</p>
  </section>`;
}

function calibrationText(estimate, copy) {
  if (!estimate.ok) return estimate.message;
  const candidate = fillSentence(copy.measurement.candidate, {
    power: formatNumber(estimate.power, 1),
  });
  return candidate + estimate.message;
}

// The number fields keep what the learner typed: their `value` is bound as an attribute (the
// default), which the browser ignores once the field has been edited, exactly as the original
// page never wrote back into them. The form reads them when it is submitted.
function measurementPanel(measurement, copy, actions) {
  const editable = measurement.editable;
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
    <h2>1枚の測定を記録する</h2>
    <form id="launchMeasurementForm" @submit=${actions.addMeasurement}>
      <label for="launchMeasuredPower">モーターへの出力指示（%）</label
      ><input
        id="launchMeasuredPower"
        type="number"
        min="0"
        max="100"
        step="1"
        value="40"
        required
        ?disabled=${!editable}
      /><label for="launchMeasuredRange">最初の接地点までの距離（m）</label
      ><input
        id="launchMeasuredRange"
        type="number"
        min="0"
        max="30"
        step="0.01"
        placeholder="例：1.25"
        required
        ?disabled=${!editable}
      /><button id="launchAddMeasurement" type="submit" class="primary full" ?disabled=${!editable}>
        測定値を追加
      </button>
    </form>
    <p class="helper">${copy.measurement.formHelper}</p>
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
    <button id="launchTemplate" class="small full" @click=${actions.saveCsvTemplate}>
      空の測定CSVを保存
    </button>
    <p class="helper">${copy.measurement.csvHelper}</p>
  </aside>`;
}

function measurementBody(model, copy, fragments, actions) {
  return html`<div class="launch-layout">
      ${measurementCard(model.measurement, copy, actions)}${measurementPanel(
        model.measurement,
        copy,
        actions,
      )}
    </div>
    <section class="card launch-reflection">${unsafeHTML(fragments.measureReflection)}</section>`;
}

function footer(model, copy, actions) {
  if (model.topic === 'measure')
    return html`<div class="basics-footer">
      <p>${copy.footer.measure}</p>
      <button id="launchNext" class="primary" @click=${actions.openQuiz}>
        小テストで確かめる →
      </button>
    </div>`;
  const position = LAUNCH_TOPICS.findIndex((topic) => topic.id === model.topic);
  const next = LAUNCH_TOPICS[position + 1];
  return html`<div class="basics-footer">
    <p>${copy.footer.experiment}</p>
    <button id="launchNext" class="primary" @click=${() => actions.openTopic(next.id)}>
      次へ：${next.title} →
    </button>
  </div>`;
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
    ${unsafeHTML(lessonBrief(lessonKey, topicCopy.brief) + schoolTips(lessonKey))}
    ${body(model, copy, fragments, actions)}${footer(model, copy, actions)}`;
}

export { launchPage };
