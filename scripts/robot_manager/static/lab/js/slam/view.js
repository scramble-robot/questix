import { html, nothing, unsafeHTML } from '../vendor/lit-html.js';
import { formatNumber } from '../core/dom.js';
import { lessonLabel, EXPERIMENT_STEPS, SENSOR_COPY } from '../shell/lesson-ui.js';
import { runModeBadgeHtml } from '../shell/run-mode.js';
import { SLAM_METHODS } from './engine.js';
import { htmlChart } from '../core/html-chart.js';
import { depthColorKey } from '../vision/depth-key.js';
import { niceScale } from '../core/chart-scale.js';
import { roleStyle } from '../core/palette.js';
import { captureCopy } from '../live/live-view.js';

// Templates of the SLAM experiment page. Every function is pure: it turns the model built by
// ui.js (mode, log, runs, playback, sensor view, settings) into markup. Learner-facing sentences
// come from content/slam/ui.json (`copy`); only short labels live here.

const CASE_OPTIONS = [
  ['slip', '01 · 車輪が少し滑る床'],
  ['bias', '02 · IMUのずれ'],
  ['corridor', '03 · 長いまっすぐな通路'],
];
const SENSOR_TABS = [
  ['lidar', '周囲の距離'],
  ['camera', 'RGB-Dカメラ'],
  ['imu', 'IMU'],
  ['wheels', '車輪'],
];
// One colour, dash and label per method, the same in the map and in the chart (S2): the second
// cue next to colour is the dash pattern.
const METHOD_LINES = {
  wheel: { color: '#a65a32', dash: '' },
  imu: { color: '#366da0', dash: '9 4' },
  slam: { color: '#236f61', dash: '2 4', width: 3 },
};
const GOAL_CENTIMETRES = 15; // the lesson's target for the error after one loop (ui.js GOAL_ERROR)
const CENTIMETRES_PER_METRE = 100;

const centimetres = (metres, copy) =>
  metres === null ? copy.scene.noReference : formatNumber(metres * 100, 1) + ' cm';
const sourceKey = (model) => (model.hardware ? 'hardware' : 'simulation');
const runLabel = (run, copy) =>
  SLAM_METHODS[run.method] + (run.calibrate ? copy.comparison.calibrated : '');

// --- Page heading and mode tabs -----------------------------------------------------------------

function heading(model, copy) {
  if (model.view === 'basics') return copy.headings.basics;
  return model.real ? copy.headings.hardware : copy.headings.simulation;
}

function pageHeading(model, copy, actions) {
  const basics = model.view === 'basics';
  return html`<div class="page-heading">
    <div>
      <p class="eyebrow course-label">${unsafeHTML(lessonLabel('slam'))}</p>
      <h1 id="slamHeading">${heading(model, copy)}</h1>
    </div>
    <nav class="slam-mode" aria-label="実験の進め方">
      <button id="slamBasicsTab" aria-pressed=${String(basics)} @click=${actions.showBasics}>
        ① 仕組み（7実験）</button
      ><button
        id="slamSimTab"
        aria-pressed=${String(!basics && !model.real)}
        @click=${() => actions.setReal(false)}
      >
        ② 総合実験：センサーを比べる</button
      ><button
        id="slamRealTab"
        class="run-mode-live-button"
        aria-pressed=${String(!basics && model.real)}
        @click=${() => actions.setReal(true)}
      >
        ③ 実機で確かめる（ROS 2）
      </button>
    </nav>
  </div>`;
}

// --- Real-robot panel ---------------------------------------------------------------------------

function hardwareStep(number, step, extra) {
  return html`<div>
    <b>${number}</b>
    <h3>${step.title}</h3>
    <p>${step.text}</p>
    ${extra}
  </div>`;
}

// Recording from the robot, and saving what was recorded (the shared questix-lab-recording JSON,
// which this panel and the other courses open again). Without a robot the record button is folded
// into one line, as in the other courses, with the way to connect; saving stays outside the fold.
function recordControls(model, text, actions, recordLabel) {
  const save = model.canSaveRecording
    ? html`<button id="slamSaveRecording" class="small" @click=${actions.saveRecording}>
        ${text.saveRecording}
      </button>`
    : nothing;
  const record = html`<button
    id="slamRecord"
    class="small"
    ?disabled=${!model.connected && !model.recording}
    @click=${actions.toggleRecording}
  >
    ${recordLabel}
  </button>`;
  if (model.connected || model.recording) return html`${record} ${save}`;
  return html`<details class="live-offline" data-slam-offline>
      <summary>${text.offlineSummary}</summary>
      <div class="live-capture">
        <p>${text.offlineText}</p>
        <div class="live-capture-actions">
          <button class="quiet" @click=${actions.openLink}>${text.connect}</button>${record}
        </div>
      </div>
    </details>
    ${save}`;
}

function hardwarePanel(model, copy, actions) {
  const text = copy.hardware;
  const recordLabel = model.recording ? text.recordAbortButton : model.recordButton;
  return html`<section
    id="slamHardware"
    class="card hardware-panel"
    ?hidden=${!model.hardwareVisible}
  >
    <div class="section-top">
      <h2>${unsafeHTML(runModeBadgeHtml('live'))} ${text.title}</h2>
      <span class="tag">${text.tag}</span>
    </div>
    <div class="hardware-steps">
      ${hardwareStep(1, text.steps[0], nothing)}
      ${hardwareStep(
        2,
        text.steps[1],
        html`<button id="slamLogger" class="small" @click=${actions.saveRecorderScript}>
          収録スクリプトを保存
        </button>`,
      )}
      ${hardwareStep(
        3,
        text.steps[2],
        html`<label class="primary upload-label"
            >計測ログを開く<input
              id="slamUpload"
              type="file"
              accept=".json,.mcap,application/json"
              @change=${actions.openLogFile}
          /></label>
          <button class="small" data-live-pick @click=${actions.pickRecording}>
            ${captureCopy.file.pick}
          </button>
          ${recordControls(model, text, actions, recordLabel)}`,
      )}
    </div>
    <p id="slamImportStatus" class="import-status" role="status">${model.importStatus}</p>
    <details data-help-dialog>
      <summary>${text.guideSummary}</summary>
      <div id="slamHardwareGuide">${unsafeHTML(model.hardwareGuideHtml)}</div>
      <button id="slamGuideDownload" class="small" @click=${actions.saveProcedure}>
        実験手順を保存</button
      ><button id="slamSample" class="small" @click=${actions.saveSampleLog}>
        サンプルJSONを保存
      </button>
    </details>
    <p class="hardware-note">${text.note}</p>
  </section>`;
}

// --- Experiment steps ---------------------------------------------------------------------------

function stepNav(model, actions) {
  return html`<div id="slamSteps" ?hidden=${!model.experimentVisible}>
    <nav class="step-nav" aria-label="実験の手順">
      ${EXPERIMENT_STEPS.map(
        (step, index) =>
          html`<button
            data-slam-stage=${step.key}
            aria-current=${step.key === model.stage ? 'step' : 'false'}
            ?disabled=${model.busy || (step.key !== 'setup' && !model.ready)}
            @click=${() => actions.goStage(step.key)}
          >
            <span>${index + 1}</span>${step.label}
          </button>`,
      )}
    </nav>
  </div>`;
}

// --- Scene card: the two maps and playback ------------------------------------------------------

function timeLabel(model, copy) {
  if (!model.ready) return copy.scene.timeIdle;
  return formatNumber(model.frame.t, 1) + ' / ' + formatNumber(model.endTime, 1) + ' s';
}

function caption(model, copy) {
  const text = copy.scene.captions;
  if (model.runError) return text.failed.replace('{message}', model.runError);
  if (!model.ready) return model.hardware ? text.idleHardware : text.idleSimulation;
  if (model.finished) return text.finished;
  return model.playing ? text.playing : text.paused;
}

function correctionLabel(model, copy) {
  const text = copy.scene.metrics;
  if (model.active.method !== 'slam') return text.correctionUnused;
  const state = model.active.states[model.cursor];
  if (state.weak) return text.correctionWeak;
  return state.matched ? text.correctionMatched : text.correctionPredicted;
}

function metrics(model, copy) {
  if (!model.ready) return nothing;
  const text = copy.scene.metrics;
  const pose = model.active.states[model.cursor];
  const reference = model.reference?.[model.cursor];
  const distance = reference
    ? Math.hypot(pose.x - reference.x, pose.y - reference.y)
    : Math.hypot(pose.x, pose.y);
  return html`<div>
      <small>${reference ? text.errorNow : text.closure}</small
      ><strong>${centimetres(distance, copy)}</strong>
    </div>
    <div>
      <small>${text.pose}</small
      ><strong class="pose-reading"
        >x ${formatNumber(pose.x, 2)} / y ${formatNumber(pose.y, 2)} m</strong
      >
    </div>
    <div><small>${text.correction}</small><strong>${correctionLabel(model, copy)}</strong></div>`;
}

function playbar(model, copy, actions) {
  return html`<div class="slam-playbar playback-bar">
    <button
      id="slamPlay"
      aria-label=${model.playing ? '走行を一時停止' : '走行を再生'}
      ?disabled=${!model.ready}
      @click=${actions.togglePlay}
    >
      ${model.playing ? 'Ⅱ' : '▶'}</button
    ><button id="slamRestart" class="small" ?disabled=${!model.ready} @click=${actions.restart}>
      最初から</button
    ><input
      id="slamSeek"
      type="range"
      min="0"
      max=${model.seekMax}
      step="1"
      value="0"
      .value=${String(model.cursor)}
      aria-label=${copy.scene.seekLabel}
      ?disabled=${!model.ready}
      @input=${(event) => actions.seek(Number(event.target.value))}
    /><label
      >再生速度<select
        id="slamSpeed"
        .value=${String(model.speed)}
        @change=${(event) => actions.setSpeed(Number(event.target.value))}
      >
        <option value="1">1倍</option>
        <option value="2" selected>2倍</option>
        <option value="4">4倍</option>
      </select></label
    ><button id="slamEnd" class="small" ?disabled=${!model.ready} @click=${actions.showEnd}>
      結果まで進む
    </button>
  </div>`;
}

function sceneCard(model, copy, actions) {
  const text = copy.scene;
  const source = sourceKey(model);
  const estimateTitle = model.ready ? runLabel(model.active, copy) : text.estimateTitle;
  return html`<section class="card slam-scene">
    <div class="section-top">
      <h2 id="slamSceneTitle">${text.title}</h2>
      <span id="slamTime">${timeLabel(model, copy)}</span>
    </div>
    <div class="slam-maps">
      <figure>
        <figcaption>
          <strong id="slamTruthTitle">${text.truthTitle[source]}</strong
          ><small id="slamTruthNote">${text.truthNote[source]}</small>
        </figcaption>
        <canvas
          id="slamTruth"
          width="600"
          height="440"
          role="img"
          aria-label=${text.truthLabel[source]}
        ></canvas>
      </figure>
      <figure>
        <figcaption>
          <strong id="slamEstimateTitle">${estimateTitle}</strong
          ><small>${text.estimateNote}</small>
        </figcaption>
        <canvas
          id="slamMap"
          width="600"
          height="440"
          role="img"
          aria-label=${text.estimateLabel}
        ></canvas>
      </figure>
    </div>
    <p class="slam-map-note">${text.mapNote}</p>
    ${playbar(model, copy, actions)}
    <p class="slam-caption" id="slamCaption">${caption(model, copy)}</p>
    <div class="slam-metrics" id="slamMetrics" ?hidden=${!model.ready}>${metrics(model, copy)}</div>
    <button
      id="slamReflectJump"
      class="primary slam-reflect-jump"
      ?hidden=${!model.finished}
      @click=${() => actions.goStage('improve')}
    >
      ${text.reflectJump}
    </button>
  </section>`;
}

// --- Comparison card: one button per run and the error graph ------------------------------------

function runCard(run, index, model, copy, actions) {
  const metric = model.hardware ? run.metrics.closure : run.metrics.endError;
  return html`<button data-slam-run=${index} @click=${() => actions.selectRun(index)}>
    <span>${runLabel(run, copy)}</span><strong>${centimetres(metric, copy)}</strong
    ><small>${copy.comparison.cardMetric[sourceKey(model)]}</small>
  </button>`;
}

// [time (s), error (cm)] of one run against the simulated reference.
function errorSeries(run, reference, times) {
  return run.states.map((pose, i) => [
    times[i],
    Math.hypot(pose.x - reference[i].x, pose.y - reference[i].y) * CENTIMETRES_PER_METRE,
  ]);
}

// Position error over time for every run of this log, in cm like the result cards, against the
// 15 cm target; only simulated logs have a reference. The range is fixed per log and its runs.
function errorGraph(model, copy) {
  if (!model.reference) return nothing;
  const text = copy.comparison;
  const series = model.runs.map((run) => ({
    ...METHOD_LINES[run.method],
    opacity: run.calibrate ? 0.75 : 1,
    points: errorSeries(run, model.reference, model.frameTimes),
    label: runLabel(run, copy),
  }));
  const target = roleStyle('target');
  const event = roleStyle('event');
  return htmlChart({
    label: text.graphLabel,
    yTitle: text.graphYTitle,
    xTitle: text.graphXTitle,
    x: niceScale([0, model.endTime], { padding: 0 }),
    y: niceScale(
      series.flatMap((line) => line.points.map((point) => point[1])),
      { max: GOAL_CENTIMETRES, ticks: 4 },
    ),
    series,
    hlines: [
      { y: GOAL_CENTIMETRES, label: text.graphGoal, color: target.color, dash: target.dash },
    ],
    vlines: [{ x: model.frame.t, label: text.graphNow, color: event.color, dash: event.dash }],
  });
}

function comparisonCard(model, copy, actions) {
  const text = copy.comparison;
  return html`<section
    class="card slam-comparison"
    id="slamComparison"
    ?hidden=${!model.runs.length}
  >
    <div class="section-top">
      <h2>${text.title}</h2>
      <button id="slamExport" class="small" @click=${actions.exportResults}>
        ${text.exportButton}
      </button>
    </div>
    <div id="slamRunCards">
      ${model.runs.map((run, index) => runCard(run, index, model, copy, actions))}
    </div>
    <div id="slamErrorGraph">${errorGraph(model, copy)}</div>
    <p id="slamGraphNote" class="helper">
      ${model.runs.length ? (model.reference ? text.graphNote : text.graphNoteHardware) : ''}
    </p>
  </section>`;
}

// --- Sensor readings ----------------------------------------------------------------------------

function sensorTitle(model, copy) {
  if (model.sensors.sensor === 'camera') return copy.sensors.cameraTitle[sourceKey(model)];
  return SENSOR_COPY[model.sensors.sensor].title;
}

function imuText(model, copy) {
  const text = copy.sensors;
  const frame = model.frame;
  const run = model.active;
  let result = text.imuText;
  if (frame.accel)
    result += text.imuAcceleration.replace('{value}', formatNumber(frame.accel[2], 2));
  if (run?.calibrate) result += text.imuCalibration.replace('{count}', run.calibrationCount);
  return result;
}

function sensorText(model, copy) {
  const { sensor } = model.sensors;
  if (sensor === 'lidar') return copy.sensors.lidarText;
  if (sensor === 'camera') return copy.sensors.cameraText[sourceKey(model)];
  if (sensor === 'wheels') return copy.sensors.wheelsText;
  return imuText(model, copy);
}

function tiltReading(tilt, copy) {
  if (!tilt.drawn) return '';
  const [x, y, z] = tilt.acceleration;
  return copy.sensors.tilt.reading
    .replace('{pitch}', tilt.pitchDegrees)
    .replace('{roll}', tilt.rollDegrees)
    .replace('{x}', formatNumber(x, 2))
    .replace('{y}', formatNumber(y, 2))
    .replace('{z}', formatNumber(z, 2));
}

function tiltDemo(model, copy, actions) {
  const text = copy.sensors.tilt;
  const { tilt } = model.sensors;
  return html`<details
    id="slamTiltDemo"
    ?hidden=${model.sensors.sensor !== 'imu'}
    @toggle=${actions.toggleTilt}
  >
    <summary>${text.summary}</summary>
    <div class="tilt-demo">
      <canvas id="slamTiltCanvas" width="440" height="190" aria-label=${text.canvasLabel}></canvas>
      <div>
        <label
          >${text.pitch}<input
            id="slamPitch"
            type="range"
            min="-30"
            max="30"
            value="0"
            .value=${String(tilt.pitchDegrees)}
            @input=${(event) => actions.setTilt('pitchDegrees', Number(event.target.value))}
        /></label>
        <label
          >${text.roll}<input
            id="slamRoll"
            type="range"
            min="-30"
            max="30"
            value="0"
            .value=${String(tilt.rollDegrees)}
            @input=${(event) => actions.setTilt('rollDegrees', Number(event.target.value))}
        /></label>
        <p id="slamTiltReading">${tiltReading(tilt, copy)}</p>
      </div>
    </div>
    <p>${text.text}</p>
  </details>`;
}

function sensorTabs(model, actions) {
  return html`<div class="sensor-tabs" role="group" aria-label="センサーを選ぶ">
    ${SENSOR_TABS.map(
      ([key, label]) =>
        html`<button
          data-slam-sensor=${key}
          aria-pressed=${String(key === model.sensors.sensor)}
          @click=${() => actions.selectSensor(key)}
        >
          ${label}
        </button>`,
    )}
  </div>`;
}

function sensorSection(model, copy, actions) {
  const text = copy.sensors;
  const { open, sensor, cameraMode } = model.sensors;
  return html`<section class="card sensor-section" id="slamSensors">
    <button
      id="slamSensorToggle"
      class="sensor-disclosure"
      aria-expanded=${String(open)}
      @click=${actions.toggleSensors}
    >
      <span><strong>${text.toggleTitle}</strong><small>${text.toggleNote}</small></span
      ><span id="slamSensorChevron">${open ? '−' : '＋'}</span>
    </button>
    <div id="slamSensorBody" ?hidden=${!open}>
      ${sensorTabs(model, actions)}
      <div class="sensor-content">
        <div class="sensor-chart">
          <canvas
            id="slamSensorCanvas"
            width="800"
            height="320"
            role="img"
            aria-label=${text.chartLabel}
          ></canvas>
          ${sensor === 'camera' && cameraMode === 'depth' ? depthColorKey(text.depthKey) : nothing}
        </div>
        <div class="sensor-explanation">
          <p class="eyebrow" id="slamSensorName">${SENSOR_COPY[sensor].name}</p>
          <h3 id="slamSensorTitle">${sensorTitle(model, copy)}</h3>
          <label id="slamCameraChoice" for="slamCameraMode" ?hidden=${sensor !== 'camera'}
            >${text.cameraChoice}<select
              id="slamCameraMode"
              .value=${cameraMode}
              @change=${(event) => actions.setCameraMode(event.target.value)}
            >
              <option value="rgb">RGB映像</option>
              <option value="depth">奥行き画像（デプス）</option>
            </select></label
          >
          <p id="slamSensorText">${sensorText(model, copy)}</p>
        </div>
      </div>
      <div class="sensor-extra">${tiltDemo(model, copy, actions)}</div>
    </div>
  </section>`;
}

// --- Settings (stage 1) -------------------------------------------------------------------------

function methodChoice(key, model, copy, actions) {
  const method = copy.settings.methods[key];
  return html`<label class="choice"
    ><input
      type="radio"
      name="slamMethod"
      value=${key}
      .checked=${model.settings.method === key}
      @change=${() => actions.setMethod(key)}
    /><span><strong>${method.title}</strong><small>${method.note}</small></span></label
  >`;
}

function runNote(model, copy) {
  const { method, comparesToOtherRun } = model.settings;
  const note = copy.settings.runNotes[method];
  return comparesToOtherRun ? note + copy.settings.previousResultKept : note;
}

function principles(method, copy) {
  const text = copy.settings.principles[method];
  return html`<h3>${text.title}</h3>
    ${text.paragraphs.map((paragraph) => html`<p>${paragraph}</p>`)}`;
}

function settingsPanel(model, copy, actions) {
  const text = copy.settings;
  const { method, caseId, calibrate } = model.settings;
  return html`<div id="slamSettings" ?hidden=${model.stage !== 'setup'}>
    <p class="eyebrow">${text.eyebrow}</p>
    <h2>${text.title}</h2>
    <div id="slamChallengeBar" class="challenge-bar" ?hidden=${model.real}>
      <label
        >${text.caseLabel}<select
          id="slamCase"
          .value=${caseId}
          @change=${(event) => actions.setCase(event.target.value)}
        >
          ${CASE_OPTIONS.map(([key, label]) => html`<option value=${key}>${label}</option>`)}
        </select></label
      >
    </div>
    <p id="slamMethodExplanation">${text.explanations[method]}</p>
    <fieldset class="choice-list">
      <legend class="sr-only">${text.methodLegend}</legend>
      ${['wheel', 'imu', 'slam'].map((key) => methodChoice(key, model, copy, actions))}
    </fieldset>
    ${
      model.noGyro
        ? html`<p class="slam-warning" id="slamNoGyro" role="note">${text.noGyroWarning}</p>`
        : nothing
    }
    <label class="calibrate-choice" id="slamCalibrateLabel" ?hidden=${method === 'wheel'}
      ><input
        type="checkbox"
        id="slamCalibrate"
        .checked=${calibrate}
        @change=${(event) => actions.setCalibrate(event.target.checked)}
      />${text.calibrate}</label
    >
    <button class="primary full" id="slamRun" ?disabled=${model.busy} @click=${actions.run}>
      ${model.busy ? text.computingButton : text.runButton}
    </button>
    <p class="helper" id="slamRunNote">${runNote(model, copy)}</p>
    <details class="slam-principles">
      <summary>${text.principlesSummary}</summary>
      <div id="slamPrincipleText">${principles(method, copy)}</div>
    </details>
  </div>`;
}

// --- Progress guide (stages 2 and 3) ------------------------------------------------------------

function learnGuide(model, copy, actions) {
  const text = copy.progress.learn;
  return html`<p class="eyebrow">${text.eyebrow}</p>
    <h2>${text.title}</h2>
    <p>${model.busy ? text.computing : text.replaying}</p>
    <button
      id="slamViewResults"
      class="primary full"
      ?disabled=${model.busy}
      @click=${() => actions.goStage('test')}
    >
      ${text.button}
    </button>
    <p class="helper">${text.note}</p>`;
}

function testGuide(model, copy, actions) {
  const text = copy.progress.test;
  const source = sourceKey(model);
  const metric = model.hardware ? model.active.metrics.closure : model.active.metrics.endError;
  return html`<p class="eyebrow">${text.eyebrow}</p>
    <h2>${text.title[source]}</h2>
    <p>${text.text[source].replace('{value}', centimetres(metric, copy))}</p>
    <button id="slamConsiderChange" class="primary full" @click=${() => actions.goStage('improve')}>
      ${text.compareButton}
    </button>
    <button
      id="slamReviewRun"
      class="full secondary-space"
      @click=${() => actions.goStage('learn')}
    >
      ${text.reviewButton}
    </button>
    <p class="helper">${text.note}</p>`;
}

function progressGuide(model, copy, actions) {
  const shown = model.stage === 'learn' || model.stage === 'test';
  let content = nothing;
  if (model.stage === 'learn') content = learnGuide(model, copy, actions);
  if (model.stage === 'test' && model.ready) content = testGuide(model, copy, actions);
  return html`<div id="slamProgressGuide" ?hidden=${!shown}>${content}</div>`;
}

// --- Reflection (stage 4) -----------------------------------------------------------------------

function reflectionTitle(reflection, copy) {
  const text = copy.reflection[reflection.kind];
  if (!('titleReached' in text)) return text.title;
  return reflection.reachedGoal ? text.titleReached : text.titleMissed;
}

function reflectionNextButton(reflection, copy, actions) {
  if (reflection.next)
    return html`<button class="primary full" id="slamNext" @click=${actions.takeNextStep}>
      ${copy.reflection.nextButtons[reflection.next]}
    </button>`;
  return html`<button class="small" id="slamNextCase" @click=${actions.nextCase}>
    ${copy.reflection.nextCaseButtons[reflection.caseId]}
  </button>`;
}

function reflectionPanel(model, copy, actions) {
  const { reflection } = model;
  if (!reflection) return html`<div id="slamReflection" hidden></div>`;
  const text = copy.reflection;
  return html`<div id="slamReflection">
    <div class="result-reflection">
      <p class="eyebrow">${text.eyebrow}</p>
      <h3>${reflectionTitle(reflection, copy)}</h3>
      <p>${text[reflection.kind].body}</p>
      <details>
        <summary>${text.memoSummary}</summary>
        <textarea
          id="slamMemo"
          aria-label=${text.memoLabel}
          placeholder=${text.memoPlaceholder}
          .value=${reflection.note}
          @input=${(event) => actions.setNote(event.target.value)}
        >
${reflection.note}</textarea>
      </details>
      ${reflectionNextButton(reflection, copy, actions)}
      <button
        id="slamChooseConditions"
        class="text-button full"
        @click=${() => actions.goStage('setup')}
      >
        ${text.chooseConditions}
      </button>
    </div>
  </div>`;
}

// --- Page ---------------------------------------------------------------------------------------

function experimentLayout(model, copy, actions) {
  return html`<div
    class="slam-layout experiment-layout"
    id="slamExperiment"
    ?hidden=${!model.experimentVisible}
  >
    <div class="slam-workspace">
      ${sceneCard(model, copy, actions)}${comparisonCard(model, copy, actions)}
      ${sensorSection(model, copy, actions)}
    </div>
    <aside class="guide card slam-guide">
      ${settingsPanel(model, copy, actions)}${progressGuide(model, copy, actions)}
      ${reflectionPanel(model, copy, actions)}
    </aside>
  </div>`;
}

// shell/supplement-ui.js hides the <details> and puts its own button before it, so the view's
// visibility goes on a wrapper: bound on the details, it would show them again beside the button.
function methodNote(model, copy, methodNoteHtml) {
  return html`<div class="method-note-wrap" ?hidden=${model.view === 'basics'}>
    <details data-help-dialog class="method-note">
      <summary>${copy.methodNoteSummary}</summary>
      ${unsafeHTML(methodNoteHtml)}
    </details>
  </div>`;
}

// `basicsHtml` is the markup of the "仕組みを知る" part, owned and wired by basics.js; it is
// inserted once and never re-rendered.
function slamPage(model, copy, { basicsHtml, methodNoteHtml }, actions) {
  return html`${pageHeading(model, copy, actions)}
    <div id="slamExperimentBrief" ?hidden=${model.view === 'basics'}>
      ${unsafeHTML(model.briefHtml)}
    </div>
    ${unsafeHTML(basicsHtml)}${hardwarePanel(model, copy, actions)}${stepNav(model, actions)}
    ${experimentLayout(model, copy, actions)}${methodNote(model, copy, methodNoteHtml)}`;
}

export { slamPage };
