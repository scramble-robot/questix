import { html, nothing, live, classMap, repeat, unsafeHTML } from '../vendor/lit-html.js';
import { formatNumber } from '../core/dom.js';
import { EXPERIMENT_STEPS } from '../shell/lesson-ui.js';
import { COURSES } from '../core/engine.js';
import { REWARDS, CHECKPOINT_LABELS, TOTAL_EPISODES, activeRewards } from './experiment.js';
import { curveLayout } from './curve-core.js';
import { curveChart } from './curve-view.js';
import { OUTCOME_SYMBOLS } from './outcome-marks.js';

// Templates of the reinforcement-learning lab. Every function is pure: it turns the model built by
// lab.js into markup and binds the actions it is given. Learner-facing sentences come from
// content/rl/lab.json (`copy`); only captions, units and column headers live here.

const TEST_PLACES = 20;
const PERCENT = 100; // the arrival rate is drawn on a fixed 0–100 % axis

// Short button captions of the sensor panel; the explanations are in SENSOR_COPY and the content
// file. Kept in the same order as shell/lesson-ui.js builds them for the SLAM course.
const SENSOR_TABS = [
  ['lidar', '周囲の距離'],
  ['camera', 'RGB-Dカメラ'],
  ['imu', 'IMU'],
  ['wheels', '車輪'],
];
const IMU_VIEWS = [
  ['impact', '衝撃'],
  ['tilt', '前後・左右の傾き'],
  ['heading', '向いている方向'],
  ['rotation', '向きを変える速さ'],
];

const orDash = (value, digits = 1) => (value === null ? '—' : formatNumber(value, digits));
const episodeCount = (episodes) => episodes.toLocaleString() + ' 走行';
const trialNumber = (index) => String(index + 1).padStart(2, '0');

// Panels the original page rebuilt from scratch on every step. Keying them on the model's
// generation makes lit throw the old nodes away too, so open <details> start closed again.
const fresh = (model, body) => repeat([model.generation], (key) => key, body);

// lit commits a <select>'s attribute parts before its children exist, so `.value` on the element
// would be applied to an empty list. The chosen option marks itself instead.
const options = (entries, chosen) =>
  entries.map(
    ([value, label]) =>
      html`<option value=${value} .selected=${live(value === chosen)}>${label}</option>`,
  );

function missionHeading(model, copy, actions) {
  return html`<div class="page-heading lab-heading">
    <h2 id="missionTitle">${model.missionTitle}</h2>
    <div class="course-control">
      <label for="courseSelect">コース</label
      ><select
        id="courseSelect"
        ?disabled=${model.busy}
        @change=${(event) => actions.openCourse(event.target.value)}
      >
        ${options(
          Object.entries(COURSES).map(([id, course]) => [id, course.name]),
          model.course,
        )}</select
      ><button
        id="manualOpen"
        class="text-button"
        ?disabled=${model.busy}
        @click=${actions.startManual}
      >
        ロボットを操作
      </button>
    </div>
  </div>`;
}

function stageNav(model, actions) {
  return html`<nav class="step-nav" aria-label="実験の手順">
    ${EXPERIMENT_STEPS.map(
      (step, index) =>
        html`<button
          data-stage=${step.key}
          aria-current=${model.currentStep === step.key ? 'step' : 'false'}
          ?disabled=${model.disabledSteps.includes(step.key)}
          @click=${() => actions.navigate(step.key)}
        >
          <span>${index + 1}</span>${step.label}
        </button>`,
    )}
  </nav>`;
}

function playbackBar(model, copy, actions) {
  const playback = model.playback;
  return html`<div class="playback-bar" id="playbackBar" ?hidden=${!model.playbackVisible}>
    <button id="playPause" @click=${actions.togglePlay}>
      ${model.playing ? '❚❚ 一時停止' : '▶ 再生'}</button
    ><button id="replayStart" class="small" @click=${actions.replayFromStart}>最初から</button
    ><input
      id="seek"
      type="range"
      min="0"
      max=${playback ? playback.duration : 1}
      step="0.01"
      aria-label="走行の再生位置"
      .value=${live(String(playback ? playback.cursor : 0))}
      @input=${(event) => actions.seek(Number(event.target.value))}
    /><label class="sr-only" for="speed">再生速度</label
    ><select id="speed" @change=${(event) => actions.setSpeed(Number(event.target.value))}>
      ${options(
        [
          ['1', '1倍'],
          ['2', '2倍'],
          ['4', '4倍'],
        ],
        String(model.speed),
      )}
    </select>
  </div>`;
}

function rewardBreakdown(model, copy) {
  const rows = model.runRewards.rows;
  if (!rows.length) return html`<p class="helper">${copy.runRewards.empty}</p>`;
  return rows.map(
    ([text, value]) =>
      html`<div><span>${text}</span><b>${value > 0 ? '+' : ''}${formatNumber(value)} 点</b></div>`,
  );
}

function runRewards(model, copy, actions) {
  return html`<details
    id="runRewards"
    class="run-rewards"
    ?hidden=${!model.playbackVisible}
    @toggle=${(event) => actions.showRunRewards(event.target.open)}
  >
    <summary>${copy.runRewards.summary}</summary>
    <div id="rewardBreakdown" class="reward-breakdown">
      ${model.runRewards.open ? rewardBreakdown(model, copy) : nothing}
    </div>
    <div class="run-reward-total">
      ${copy.runRewards.total}<strong id="runRewardTotal">${model.runRewards.total}</strong>
    </div>
    <p class="helper">${copy.runRewards.note}</p>
  </details>`;
}

function drivePad(model, copy, actions) {
  return html`<div class="drive-pad">
    ${['forward', 'left', 'back', 'right'].map(
      (direction) =>
        html`<button
          data-drive=${direction}
          aria-label=${copy.manual.drive[direction]}
          class=${classMap({ pressed: model.manualPressed === direction })}
          ?disabled=${model.manualStopped}
          @pointerdown=${(event) => actions.pressDrive(event, direction)}
          @pointerup=${actions.releaseDrive}
          @pointercancel=${actions.releaseDrive}
          @lostpointercapture=${actions.releaseDrive}
        >
          ${{ forward: '↑', left: '↶', back: '↓', right: '↷' }[direction]}
        </button>`,
    )}
  </div>`;
}

function manualControls(model, copy, actions) {
  if (!model.manual) return html`<div id="manualControls" hidden></div>`;
  return html`<div id="manualControls">
    ${drivePad(model, copy, actions)}
    <div class="safety-controls">
      <button
        id="emergency"
        class=${classMap({ emergency: true, latched: model.manualStopped })}
        @click=${actions.toggleEmergencyStop}
      >
        ${model.manualStopped ? copy.manual.releaseButton : copy.manual.stopButton}
      </button>
      <p id="safetyReason">${model.manualReason}</p>
      <button id="manualReset" class="text-button" @click=${actions.startManual}>
        ${copy.manual.resetButton}
      </button>
    </div>
  </div>`;
}

function arenaCard(model, copy, actions) {
  return html`<section class="card simulation-card" id="arenaCard" ?hidden=${!model.arenaVisible}>
    <div class="arena-toolbar">
      <div>
        <span class="live-dot"></span><strong id="sceneTitle">${model.sceneTitle}</strong
        ><span id="sceneTime">${model.sceneTime}</span>
      </div>
      <label class="scan-option"
        ><input
          type="checkbox"
          id="scanVisible"
          .checked=${live(model.scanVisible)}
          @change=${(event) => actions.showScan(event.target.checked)}
        />LiDARの照射線</label
      >
    </div>
    <div id="arenaHost"></div>
    ${playbackBar(model, copy, actions)}
    <div id="sceneCaption" class="scene-caption">${model.sceneCaption}</div>
    <button
      id="sceneNext"
      class="primary scene-next"
      ?hidden=${model.sceneNextHidden}
      @click=${actions.sceneNext}
    >
      ${model.sceneNextLabel}
    </button>
    ${runRewards(model, copy, actions)} ${manualControls(model, copy, actions)}
  </section>`;
}

function checkpointCard(model, copy, index, actions) {
  const checkpoint = model.training.checkpoints[index];
  return html`<div class="checkpoint">
    <div>
      <strong>${CHECKPOINT_LABELS[index]}</strong
      ><span>${checkpoint ? episodeCount(checkpoint.episodes) : copy.training.pending}</span>
    </div>
    <canvas
      id=${'checkpoint' + index}
      width="420"
      height="290"
      role="img"
      aria-label=${copy.training.checkpointFigureNames[index] + 'の走行軌跡'}
    ></canvas>
    <button
      data-checkpoint=${index}
      class="small"
      ?disabled=${model.busy || !checkpoint}
      @click=${() => actions.replayCheckpoint(index)}
    >
      ${checkpoint ? model.training.checkpointResults[index] + ' · 再生' : copy.training.pendingButton}
    </button>
  </div>`;
}

// The learning curve of the metric on screen. The arrival rate always spans 0–100 %; the other
// metrics take their axis from the values so far (their range is not known before training).
function learningChart(model, copy) {
  const training = model.training;
  const metric = training.metric;
  const points = training.history.map((point) => ({
    x: point.episodes,
    y: point[training.metricKey],
  }));
  const rate = training.metricKey === 'rate';
  const layout = curveLayout({
    series: [{ role: 'actual', label: metric.name, points }],
    xMax: TOTAL_EPISODES,
    yRange: rate ? [0, PERCENT] : [],
    yMax: rate ? PERCENT : undefined,
    yPadding: rate ? 0 : undefined,
  });
  const empty = training.history.length
    ? copy.training.emptyNoArrival
    : copy.training.emptyComputing;
  return curveChart(layout, {
    title: '',
    yTitle: metric.axis,
    xTitle: copy.training.xAxis,
    unit: metric.unit === '%' ? '%' : ' ' + metric.unit,
    empty,
    ariaLabel: metric.name + 'の学習中の変化',
  });
}

function trainingBoard(model, copy, actions) {
  if (!model.trainingVisible)
    return html`<section id="trainingBoard" class="card" hidden></section>`;
  const training = model.training;
  return html`<section id="trainingBoard" class="card">
    <div class="section-top">
      <h2 id="learningTitle">${model.busy ? copy.training.titleBusy : copy.training.titleDone}</h2>
      <span id="trainingCount" class="muted"
        >${training.episodes.toLocaleString()} / ${TOTAL_EPISODES.toLocaleString()} 走行</span
      >
    </div>
    <div class="training-progress">
      <progress id="trainingProgress" max=${TOTAL_EPISODES} value=${training.episodes}></progress>
      <p>${model.busy ? copy.training.progressNote : copy.training.progressDone}</p>
    </div>
    <div class="checkpoint-grid" id="checkpointGrid">
      ${[0, 1, 2].map((index) => checkpointCard(model, copy, index, actions))}
    </div>
    <div class="training-chart">
      <div class="chart-tabs" role="group" aria-label="学習のグラフ">
        ${Object.entries(copy.training.metrics).map(
          ([key, metric]) =>
            html`<button
              data-metric=${key}
              aria-pressed=${String(key === training.metricKey)}
              @click=${() => actions.showMetric(key)}
            >
              ${metric.tab}
            </button>`,
        )}
      </div>
      <div id="learningChart">${learningChart(model, copy)}</div>
      <p id="chartNote" class="helper">${training.metric.note}</p>
    </div>
  </section>`;
}

// One figure of the results board, with the same figure from the compared experiment beside it.
function resultMetric(label, value, unit, previousText) {
  return html`<div>
    <span>${label}</span><strong>${value}<small>${unit}</small></strong
    >${previousText ? html`<em>${previousText}</em>` : nothing}
  </div>`;
}

function trialButton(model, copy, result, index, actions) {
  const mark = () => {
    if (result.success) return OUTCOME_SYMBOLS.arrived;
    return result.collision ? OUTCOME_SYMBOLS.contact : OUTCOME_SYMBOLS.timeout;
  };
  return html`<button
    data-trial=${index}
    class=${result.success ? 'success' : 'failure'}
    aria-label=${
      copy.results.trialLabelPrefix +
      (index + 1) +
      ' ' +
      model.results.names[index] +
      copy.results.trialLabelSuffix
    }
    @click=${() => actions.replayTrial(index)}
  >
    <b>${trialNumber(index)}</b><span>${mark()}</span>
  </button>`;
}

function experimentLog(model, copy) {
  return html`<div class="experiment-log">
    ${model.results.log.map(
      (entry) =>
        html`<p>
          ${copy.results.logPrefix}${entry.revision} · ${entry.change}<br /><strong
            >${entry.successCount}${copy.results.logArrivals}${entry.contacts}${
              copy.results.logContacts
            }${orDash(entry.arrivalTime)}${copy.results.logSeconds}</strong
          >
        </p>`,
    )}
  </div>`;
}

function resultsDetails(model, copy, actions) {
  const results = model.results;
  return html`<details class="results-more">
    <summary>${copy.results.moreSummary}</summary>
    <p>
      ${copy.results.commandRatePrefix}${orDash(results.commandRate)}${
        copy.results.commandRateUnit
      }${
        results.previous
          ? '（' +
            copy.results.previousPrefix +
            orDash(results.previous.commandRate) +
            copy.results.commandRateUnit +
            '）'
          : ''
      }${copy.results.commandRateNote}
    </p>
    <p>
      ${copy.results.startPrefix}${results.startSummary}。${results.episodes.toLocaleString()}${
        copy.results.episodesSuffix
      }${results.change}。
    </p>
    ${results.note ? html`<p>${copy.results.notePrefix}${results.note}</p>` : nothing}
    ${experimentLog(model, copy)}
    <button id="freshBatch" class="small" @click=${actions.freshBatch}>
      ${copy.results.freshButton}
    </button>
    <p class="helper">${copy.results.freshNote}</p>
  </details>`;
}

function resultsBoard(model, copy, actions) {
  if (!model.resultsVisible) return html`<section id="resultsBoard" class="card" hidden></section>`;
  // Keyed on the generation so a new step rebuilds the board, closing its details again.
  return html`<section id="resultsBoard" class="card">
    ${fresh(model, () => resultsBody(model, copy, actions))}
  </section>`;
}

function resultsBody(model, copy, actions) {
  const results = model.results;
  const previously = (figure) =>
    results.previous ? copy.results.previousPrefix + figure(results.previous) : null;
  return html`<div class="section-top">
      <h2>${copy.results.title}</h2>
      <span class=${classMap({ 'result-badge': true, cleared: results.cleared })}
        >${
          results.cleared ? copy.results.badgeCleared : copy.results.badgePrefix + results.revision
        }</span
      >
    </div>
    <div class="result-metrics">
      ${resultMetric(
        copy.results.arrivals,
        results.successCount,
        ' / 20',
        previously((before) => before.successCount + copy.results.timesUnit),
      )}
      ${resultMetric(
        copy.results.contacts,
        results.contacts,
        ' 回',
        previously((before) => before.contacts + copy.results.timesUnit),
      )}
      ${resultMetric(
        copy.results.arrivalTime,
        orDash(results.arrivalTime),
        ' 秒',
        previously((before) => orDash(before.arrivalTime) + copy.results.secondsUnit),
      )}
    </div>
    <div class="result-detail">
      <div>
        <canvas
          id="testMap"
          width="480"
          height="320"
          role="img"
          aria-label=${copy.results.mapLabel}
        ></canvas>
        <p class="helper">${copy.results.mapKey}<br />${copy.results.mapNote}</p>
      </div>
      <div>
        <h3>${copy.results.pickTitle}</h3>
        <div class="trial-grid">
          ${results.trials.map((result, index) => trialButton(model, copy, result, index, actions))}
        </div>
        <p class="helper">${copy.results.trialKey}</p>
      </div>
    </div>
    ${
      results.verdict
        ? html`<div class="comparison-verdict">
            <strong>${results.verdict}</strong>
            <p>${copy.results.comparisonNote}</p>
          </div>`
        : nothing
    }
    ${resultsDetails(model, copy, actions)}`;
}

function sensorReading(model, copy) {
  const reading = model.sensor.reading;
  if (!reading) return nothing;
  if (reading.kind === 'lidar')
    return html`<strong>${reading.centimetres}<small> cm</small></strong
      ><span>${copy.sensors.lidar.reading}</span>`;
  if (reading.kind === 'camera')
    return html`<strong class="text-reading"
        >${reading.visible ? copy.sensors.camera.visible : copy.sensors.camera.hidden}</strong
      >${
        reading.visible
          ? html`<p>
              ${copy.sensors.camera.depthPrefix}${reading.depth}${copy.sensors.camera.depthSuffix}
            </p>`
          : nothing
      }`;
  return reading.values.map(
    (value) =>
      html`<div class="sensor-value">
        <i style=${'background:' + value.color}></i><span>${value.label}</span><b>${value.value}</b
        ><small>${model.sensor.unit}</small>
      </div>`,
  );
}

function sensorSection(model, copy, actions) {
  const sensor = model.sensor;
  return html`<section
    id="sensorSection"
    class="card sensor-section"
    ?hidden=${!model.arenaVisible}
  >
    <button
      id="sensorTogglePanel"
      class="sensor-disclosure"
      aria-expanded=${String(model.sensorsOpen)}
      @click=${() => actions.showSensors(!model.sensorsOpen)}
    >
      <span
        ><strong>${copy.sensors.summaryTitle}</strong
        ><small>${copy.sensors.summaryNote}</small></span
      ><span id="sensorChevron">${model.sensorsOpen ? '−' : '＋'}</span>
    </button>
    <div id="sensorBody" ?hidden=${!model.sensorsOpen}>
      <div class="sensor-tabs" role="group" aria-label="センサーを選ぶ">
        ${SENSOR_TABS.map(
          ([key, label]) =>
            html`<button
              data-sensor=${key}
              aria-pressed=${String(key === sensor.kind)}
              @click=${() => actions.showSensor(key)}
            >
              ${label}
            </button>`,
        )}
      </div>
      <div class="sensor-content">
        <div class="sensor-chart">
          <canvas
            id="lidarView"
            width="640"
            height="430"
            role="img"
            aria-label=${copy.sensors.lidarLabel}
            ?hidden=${sensor.kind !== 'lidar'}
          ></canvas>
          <div id="cameraHost" ?hidden=${sensor.kind !== 'camera'}></div>
          <canvas
            id="sensorGraph"
            width="760"
            height="420"
            role="img"
            aria-label=${copy.sensors.graphLabel}
            ?hidden=${sensor.kind === 'lidar' || sensor.kind === 'camera'}
          ></canvas>
        </div>
        <div class="sensor-explanation">
          <p class="eyebrow" id="sensorName">${sensor.name}</p>
          <h3 id="sensorTitle">${sensor.title}</h3>
          <select
            id="imuSelect"
            aria-label=${copy.sensors.imuSelectLabel}
            ?hidden=${sensor.kind !== 'imu'}
            @change=${(event) => actions.showImuView(event.target.value)}
          >
            ${options(IMU_VIEWS, model.imuView)}
          </select>
          <p id="sensorDescription">${sensor.description}</p>
          <div id="sensorReading">${sensorReading(model, copy)}</div>
          <p class="helper" id="sensorNote">${sensor.note}</p>
        </div>
      </div>
    </div>
  </section>`;
}

// Every reward the next training will use, so the summary never hides a point that is given.
function rewardSummary(model, copy) {
  const settings = model.draft.rewards;
  const rewards = activeRewards(settings, model.draft.task);
  return html`<p class="reward-summary-title">${copy.setup.summaryTitle}</p>
    <div class="reward-summary">
      ${rewards.map(
        (reward) =>
          html`<div>
            <span>${reward.name}</span
            ><strong>${reward.sign}${settings[reward.key]}<small>${reward.unit}</small></strong>
          </div>`,
      )}
    </div>`;
}

function rewardRow(model, copy, reward, actions) {
  const settings = model.draft.rewards;
  const enabled = settings.enabled[reward.key];
  return html`<div class="reward-row">
    <label
      ><input
        type="checkbox"
        data-enable=${reward.key}
        .checked=${live(enabled)}
        @change=${(event) => actions.enableReward(reward.key, event.target.checked)}
      /><span>${reward.name}</span></label
    >
    <div>
      <span>${reward.sign}</span
      ><input
        type="number"
        min="0"
        max=${reward.max}
        step=${reward.step}
        data-value=${reward.key}
        aria-label=${reward.name + copy.setup.rewardValueLabelSuffix}
        ?disabled=${!enabled}
        .value=${live(String(settings[reward.key]))}
        @change=${(event) => actions.setReward(reward.key, event.target.value)}
      /><small>${reward.unit}</small>
    </div>
    <p>${reward.description}</p>
  </div>`;
}

// From the foundation chapters to this page: the table of three actions gives way to a formula
// that turns sensor values into the two wheel speeds.
function bridgeNote(copy) {
  const bridge = copy.bridge;
  return html`<div class="lab-bridge">
    <strong>${bridge.title}</strong>
    <p>${bridge.before}</p>
    <p>${bridge.now}</p>
  </div>`;
}

function setupGuide(model, copy, actions) {
  const revised = model.hasPrevious;
  return html`<p class="eyebrow">${copy.setup.eyebrow}</p>
    <h2 data-lesson-cue="action">${revised ? copy.setup.titleRevision : copy.setup.titleFirst}</h2>
    <p>${revised ? copy.setup.introRevision : copy.setup.introFirst}</p>
    ${model.hasRun ? nothing : bridgeNote(copy)} ${rewardSummary(model, copy)}
    <button id="trainNow" class="primary full" @click=${actions.startTraining}>
      ${copy.setup.trainButton}
    </button>
    <p class="helper">${copy.setup.trainNote}</p>
    <details id="rewardSettings">
      <summary>${copy.setup.editorSummary}</summary>
      <div id="rewardEditor">
        ${REWARDS.filter((reward) => !reward.dock || model.draft.task === 'dock').map((reward) =>
          rewardRow(model, copy, reward, actions),
        )}
      </div>
      <div class="preset-line">
        <button id="recommended" class="small" @click=${actions.useRecommendedRewards}>
          ${copy.setup.recommendedButton}
        </button>
      </div>
      <p class="helper">${copy.setup.unitsNote}</p>
    </details>
    <div class="start-setting">
      <label for="startMode">${copy.setup.startModeLabel}</label
      ><select id="startMode" @change=${(event) => actions.setStartMode(event.target.value)}>
        ${options(Object.entries(copy.startModes), model.draft.startMode)}
      </select>
      <p class="helper">${copy.setup.startModeNote}</p>
    </div>
    ${
      revised ? html`<p class="change-note">${copy.setup.changePrefix}${model.change}</p>` : nothing
    }`;
}

function learnGuide(model, copy, actions) {
  return html`<p class="eyebrow">${copy.learn.eyebrow}</p>
    <h2 data-lesson-cue="observe">${model.busy ? copy.learn.titleBusy : copy.learn.titleDone}</h2>
    <p>${model.busy ? copy.learn.introBusy : copy.learn.introDone}</p>
    <div class="learning-explanation">
      ${copy.learn.loop.map(
        (step) => html`<div><b>${step.title}</b><span>${step.text}</span></div>`,
      )}
    </div>
    ${
      model.busy
        ? html`<p class="helper">${copy.learn.busyNote}</p>`
        : html`<button id="testNow" class="primary full" @click=${actions.startTest}>
              ${copy.learn.testButton}</button
            ><button id="knownReplay" class="full secondary-space" @click=${actions.replayLearned}>
              ${copy.learn.replayButton}
            </button>
            ${
              model.playback
                ? html`<button
                    id="returnLearning"
                    class="text-button full"
                    @click=${actions.closePlayback}
                  >
                    ${copy.learn.returnButton}
                  </button>`
                : nothing
            }`
    }
    <details>
      <summary>${copy.learn.detailsSummary}</summary>
      ${copy.learn.details.map((paragraph) => html`<p>${paragraph}</p>`)}
    </details>`;
}

function testTitle(model, copy) {
  if (model.busy) return copy.test.titleBusy;
  if (model.test.complete) return copy.test.titleComplete;
  return model.test.done ? copy.test.titleFirst : copy.test.titleStart;
}

function testIntro(model, copy) {
  if (model.busy) return copy.test.introBusy;
  if (model.test.complete) return copy.test.introComplete;
  return model.test.done ? copy.test.introFirst : copy.test.introStart;
}

function completeTestActions(model, copy, actions) {
  return html`<div class="result-highlight">
      ${model.test.successCount}<span>${copy.test.highlightSuffix}</span>
    </div>
    <button id="considerChange" class="primary full" @click=${actions.considerChange}>
      ${copy.test.considerButton}
    </button>
    ${
      model.playback
        ? html`<button
            id="showOverview"
            class="full secondary-space"
            @click=${actions.showOverview}
          >
            ${copy.test.overviewButton}
          </button>`
        : nothing
    }
    ${
      !model.playback && model.test.cleared
        ? html`<button id="nextCourse" class="full secondary-space" @click=${actions.nextCourse}>
            ${copy.test.nextCourseButton}
          </button>`
        : nothing
    }`;
}

function testActions(model, copy, actions) {
  if (model.busy)
    return html`<progress max=${TEST_PLACES} value=${model.test.done}></progress>
      <p class="helper">${model.test.done}${copy.test.progressSuffix}</p>`;
  if (model.test.complete) return completeTestActions(model, copy, actions);
  if (model.test.done)
    return html`<div class="test-first-result" id="firstResult">${model.test.firstResult}</div>
      <button id="testRemaining" class="primary full" @click=${actions.testRemaining}>
        ${copy.test.remainingButton}
      </button>
      <p class="helper">${copy.test.remainingNote}</p>`;
  return html`<button id="firstTest" class="primary full" @click=${actions.startTest}>
    ${copy.test.firstButton}
  </button>`;
}

function testGuide(model, copy, actions) {
  return html`<p class="eyebrow">${copy.test.eyebrow}</p>
    <h2 data-lesson-cue="result">${testTitle(model, copy)}</h2>
    <p>${testIntro(model, copy)}</p>
    ${testActions(model, copy, actions)}
    ${
      model.hasPrevious ? html`<p class="comparison-note">${copy.test.comparisonNote}</p>` : nothing
    }
    ${
      model.playback
        ? html`<button
            id="openSensorFromGuide"
            class="text-button full"
            @click=${() => actions.showSensors(true)}
          >
            ${copy.test.sensorButton}
          </button>`
        : nothing
    }`;
}

function improveChoice(choice, actions) {
  return html`<label class="choice"
    ><input
      type="radio"
      name="improvement"
      value=${choice.key}
      ?disabled=${choice.disabled}
      .checked=${live(choice.selected)}
      @change=${() => actions.chooseImprovement(choice.key)}
    /><span><strong>${choice.title}</strong><small>${choice.note}</small></span></label
  >`;
}

function improveGuide(model, copy, actions) {
  const improve = model.improve;
  return html`<p class="eyebrow">${copy.improve.eyebrow}</p>
    <h2 data-lesson-cue="reflect">${improve.title}</h2>
    <p>${improve.intro}</p>
    <button id="inspectExample" class="full" @click=${actions.inspectExample}>
      ${copy.improve.inspectPrefix}${trialNumber(improve.exampleIndex)}${copy.improve.inspectSuffix}
    </button>
    <details class="hint">
      <summary>${copy.improve.hintSummary}</summary>
      <p>${improve.hint}</p>
    </details>
    <h3 class="next-question">${copy.improve.question}</h3>
    <fieldset class="choice-list improvement-choices">
      <legend class="sr-only">${copy.improve.choicesLegend}</legend>
      ${improve.choices.map((choice) => improveChoice(choice, actions))}
    </fieldset>
    <label class="note-label" for="hypothesis"
      >${copy.improve.hypothesisLabel}<span>${copy.improve.hypothesisOptional}</span></label
    >
    <textarea
      id="hypothesis"
      rows="2"
      maxlength="240"
      placeholder=${copy.improve.hypothesisPlaceholder}
      .value=${live(improve.note)}
      @input=${(event) => actions.setHypothesis(event.target.value)}
    ></textarea>
    <button
      id="applyImprovement"
      class="primary full"
      ?disabled=${!improve.choice}
      @click=${actions.applyImprovement}
    >
      ${improve.choice ? copy.improve.applyReady : copy.improve.applyIdle}
    </button>
    <p class="helper">${copy.improve.applyNote}</p>`;
}

function manualGuide(model, copy, actions) {
  return html`<p class="eyebrow">${copy.manual.eyebrow}</p>
    <h2>${copy.manual.title}</h2>
    <p>${copy.manual.intro}</p>
    <div class="manual-tips">
      ${copy.manual.tips.map((tip) => html`<p><strong>${tip.title}</strong>${tip.text}</p>`)}
    </div>
    <button id="returnFromManual" class="primary full" @click=${actions.leaveManual}>
      ${copy.manual.returnButton}
    </button>
    <p class="helper">${copy.manual.note}</p>`;
}

function guideBody(model, copy, actions) {
  if (!model.ready) return nothing;
  if (model.manual) return manualGuide(model, copy, actions);
  if (model.stage === 'setup') return setupGuide(model, copy, actions);
  if (model.stage === 'learn') return learnGuide(model, copy, actions);
  if (model.stage === 'test') return testGuide(model, copy, actions);
  return improveGuide(model, copy, actions);
}

function guidePanel(model, copy, actions) {
  return html`<aside class="guide card lab-guide" id="guidePanel">
    ${model.error ? html`<p role="alert" class="error">${model.error}</p>` : nothing}${fresh(
      model,
      () => guideBody(model, copy, actions),
    )}
  </aside>`;
}

function methodNote(model, copy, actions) {
  const last = copy.method.sections.length - 1;
  return html`<details data-help-dialog class="method-note">
    <summary>${copy.method.summary}</summary>
    <div class="method-grid">
      ${copy.method.sections.map(
        (section, index) =>
          html`<div>
            <h3>${section.title}</h3>
            <p>${section.text}</p>
            ${
              index === last
                ? html`<button
                    id="exportPolicy"
                    class="small"
                    ?disabled=${!model.hasRun}
                    @click=${actions.exportPolicy}
                  >
                    ${copy.method.exportButton}
                  </button>`
                : nothing
            }
          </div>`,
      )}
    </div>
  </details>`;
}

// The situation / purpose / first-step texts of a stage are open the first time it is reached
// and folded afterwards, so a learner coming back sees the experiment first.
function lessonBrief(model, copy) {
  if (!model.lessonBrief) return nothing;
  if (!model.briefFolded) return unsafeHTML(model.lessonBrief);
  return fresh(
    model,
    () =>
      html`<details class="lab-brief-fold">
        <summary>${copy.briefFolded}</summary>
        ${unsafeHTML(model.lessonBrief)}
      </details>`,
  );
}

function labPage(model, copy, actions) {
  return html`${missionHeading(model, copy, actions)}${stageNav(model, actions)}
    <div id="labLessonBrief">${lessonBrief(model, copy)}</div>
    <div
      class=${classMap({ 'lab-layout': true, 'experiment-layout': true, 'manual-mode': model.manual })}
    >
      <div class="workspace">
        ${arenaCard(model, copy, actions)}${trainingBoard(model, copy, actions)}${resultsBoard(
          model,
          copy,
          actions,
        )}${sensorSection(model, copy, actions)}
      </div>
      ${guidePanel(model, copy, actions)}
    </div>
    ${methodNote(model, copy, actions)}
    <p class="page-footnote">${copy.footnote}</p>`;
}

export { labPage };
