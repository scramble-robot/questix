import { html, live, nothing, unsafeHTML } from '../vendor/lit-html.js';
import {
  formatValue,
  runSummary,
  isSimpleTopic,
  settledSpeed,
  speedGap,
  topicPlace,
} from './summary.js';
import { lessonLabel } from '../shell/lesson-ui.js';
import { schoolTips } from '../shell/school-tips.js';
import { liveCaptureControls } from '../live/live-view.js';
import { lessonBrief } from '../shell/lesson-brief.js';
import { runModeBadgeHtml } from '../shell/run-mode.js';
import { CONTROL_GROUPS, CONTROL_TOPICS, LAST_SAMPLE, STOP_DISTANCE, controlLoad } from './core.js';
import { controlChart, comparedStyle, liveCommandStyle } from './render.js';
import { conceptLesson } from './concepts.js';
import { fillSentence as fill } from '../core/content.js';

// Templates of the feedback-control course. Every function is pure: it turns the model built by
// ui.js (current topic, settings, finished run, playback position) into markup. Learner-facing
// sentences come from content/control/ui.json (`copy`); only short labels live here.

const SETTLED_RPM = 3; // rpm: "close enough" for the speed experiments
const OVERSHOOT_RPM = 8; // rpm of overshoot above which the I hint changes
const OVERSHOOT_METRES = 0.1; // metres past the stopping line that counts as a real overshoot
const SLOW_SETTLING = 10; // seconds
const CENTIMETRES = 100; // per metre: distances are shown in cm on the chart, readings and results

// Range, step and displayed precision of every slider, in the unit of its setting.
const SLIDER_RANGES = {
  power: { min: 0, max: 100, step: 5, digits: 0 },
  targetRPM: { min: 20, max: 80, step: 10, digits: 0 },
  ffGain: { min: 0, max: 2, step: 0.05, digits: 2 },
  filter: { min: 0, max: 0.6, step: 0.02, digits: 2 },
  kp: { min: 0, max: 8, step: 0.1, digits: 2 },
  ki: { min: 0, max: 6, step: 0.1, digits: 2 },
  kd: { min: 0, max: 3, step: 0.1, digits: 2 },
};
const FEEDFORWARD_TOPICS = ['feedforward', 'combined'];
const COMMAND_OPEN_TOPICS = [
  'output',
  'feedforward',
  'combined',
  'feedback',
  'limits',
  'noise',
  'reference',
];

const isFeedforwardTopic = (topicId) => FEEDFORWARD_TOPICS.includes(topicId);
const configKey = (config) => JSON.stringify({ ...config, scenario: 'standard' });

// --- short, reusable pieces of text -------------------------------------------------------

// One line naming the settings of a run, for the result heading and the history table.
function gainText(config, topicId, copy) {
  if (topicId === 'output') return '一定出力 ' + config.power + '%';
  if (topicId === 'feedforward')
    return 'FF ' + formatValue(config.ffGain, 2) + ' %/rpm・目標 ' + config.targetRPM + ' rpm';
  if (topicId === 'combined') {
    const estimate =
      config.strategy === 'feedback' ? '' : '・FF ' + formatValue(config.ffGain, 2) + ' %/rpm';
    return copy.labels.method[config.strategy] + estimate + '・目標 ' + config.targetRPM + ' rpm';
  }
  if (topicId === 'reference')
    return config.profile === 'ramp' ? '目標を3秒かけて変える' : '目標を一度に変える';
  if (topicId === 'feedback')
    return config.feedback ? '測って調整' : '一定出力 ' + config.power + '%';
  if (topicId === 'limits') return 'Iの抑制 ' + (config.antiWindup ? 'あり' : 'なし');
  if (topicId === 'noise') return 'フィルター ' + formatValue(config.filter, 2) + '秒';
  const { kp, ki, kd } = config;
  return `P ${formatValue(kp)} / I ${formatValue(ki)} / D ${formatValue(kd)}`;
}

// The load a run met, named only where the learner can choose it.
function loadSuffix(run, topicId, copy, separator) {
  if (!isFeedforwardTopic(topicId)) return '';
  return separator + copy.labels.load[run.loadCase];
}

// The scenario or load a run was made under, appended after its settings.
function conditionText(run, topicId, copy, separator) {
  if (topicId === 'challenge') return separator + copy.labels.scenario[run.config.scenario];
  return loadSuffix(run, topicId, copy, separator);
}

// The first stage's history columns: the speed the wheel settled at and how far that is from the
// target.
function simpleMetricText(run, copy) {
  return [formatValue(settledSpeed(run), 0) + ' rpm', speedGap(run, copy.summary)];
}

// The three headline numbers of a run: remaining error, overshoot, time to settle.
function metricText(run, copy) {
  const metrics = run.metrics;
  const distance = run.mode === 'distance';
  const scale = distance ? CENTIMETRES : 1;
  const unit = distance ? ' cm' : ' rpm';
  const digits = distance ? 0 : 1; // whole centimetres, as on the chart and in the summary
  return [
    formatValue(metrics.finalError * scale, digits) + unit,
    formatValue(metrics.overshoot * scale, digits) + unit,
    metrics.settling === null ? copy.results.notSettled : formatValue(metrics.settling) + ' 秒',
  ];
}

// What to try next, chosen from what the run actually shows.
function hintText(run, topicId, copy) {
  const hints = copy.hints;
  const metrics = run.metrics;
  if (topicId === 'output') {
    if (metrics.finalError < SETTLED_RPM) return hints.outputClose;
    return run.samples.at(-1).actual < run.target ? hints.outputSlow : hints.outputFast;
  }
  if (topicId === 'feedforward')
    return metrics.finalError < SETTLED_RPM ? hints.feedforwardMatched : hints.feedforwardMissed;
  if (topicId === 'combined' && run.method === 'feedforward' && metrics.finalError < SETTLED_RPM)
    return hints.combinedFeedforwardClose;
  if (topicId === 'combined') {
    if (run.method === 'feedforward') return hints.combinedFeedforward;
    return run.method === 'feedback' ? hints.combinedFeedback : hints.combinedBoth;
  }
  if (topicId === 'reference')
    return run.config.profile === 'step' ? hints.referenceStep : hints.referenceRamp;
  if (run.collision) return hints.collision;
  if (topicId === 'feedback') return run.config.feedback ? hints.feedbackOn : hints.feedbackOff;
  if (topicId === 'p') return metrics.finalError > SETTLED_RPM ? hints.pSlow : hints.pClose;
  if (topicId === 'i') {
    if (run.config.ki === 0) return hints.iZero;
    return metrics.overshoot > OVERSHOOT_RPM ? hints.iOvershoot : hints.iImproved;
  }
  if (topicId === 'limits') return run.config.antiWindup ? hints.limitsOn : hints.limitsOff;
  if (topicId === 'noise')
    return run.config.filter === 0 ? hints.noiseUnfiltered : hints.noiseFiltered;
  if (metrics.overshoot > OVERSHOOT_METRES) return hints.distanceOvershoot;
  if (metrics.settling === null || metrics.settling > SLOW_SETTLING) return hints.distanceSlow;
  if (topicId === 'challenge') return hints.challengePassed;
  return hints.dCompare;
}

function timeLabel(model, copy) {
  if (!model.result) return copy.time.idle;
  const phase = playbackPhase(model, copy);
  return phase + ' · ' + formatValue(model.frame.time) + ' / 16.0 秒';
}

function playbackPhase(model, copy) {
  if (model.playing) return model.complete ? copy.time.replaying : copy.time.running;
  return model.index >= LAST_SAMPLE ? copy.time.ended : copy.time.paused;
}

function replayLabel(model) {
  if (model.playing) return 'Ⅱ 一時停止';
  if (model.result && model.index < LAST_SAMPLE) return '▶ 続きから見る';
  return '▶ 動きを最初から見る';
}

// --- settings panel -----------------------------------------------------------------------

function settingSlider(key, text, model, actions) {
  const range = SLIDER_RANGES[key];
  const value = model.config[key];
  return html`<label class="control-setting" for=${'control-' + key}
    ><span
      >${text.label}<output id=${'control-' + key + '-value'}
        >${formatValue(value, range.digits)}</output
      ></span
    ><input
      id=${'control-' + key}
      data-control-setting=${key}
      type="range"
      min=${range.min}
      max=${range.max}
      step=${range.step}
      .value=${String(value)}
      @input=${(event) => actions.setNumber(key, Number(event.target.value))}
    /><small>${text.help}</small></label
  >`;
}

function optionList(labels, selected) {
  return Object.entries(labels).map(
    ([value, label]) =>
      html`<option value=${value} ?selected=${value === selected}>${label}</option>`,
  );
}

function loadCaseField(model, copy, actions) {
  return html`<label class="control-select" for="controlLoadCase">機体と負荷の条件</label
    ><select
      class="control-select-input"
      id="controlLoadCase"
      @change=${(event) => actions.setChoice('loadCase', event.target.value)}
    >
      ${optionList(copy.labels.load, model.config.loadCase)}
    </select>`;
}

function strategyField(model, copy, actions) {
  const methods = Object.fromEntries(
    ['feedforward', 'feedback', 'both'].map((key) => [key, copy.labels.method[key]]),
  );
  return html`<label class="control-select" for="controlStrategy">指示の決め方</label
    ><select
      class="control-select-input"
      id="controlStrategy"
      @change=${(event) => actions.setChoice('strategy', event.target.value)}
    >
      ${optionList(methods, model.config.strategy)}
    </select>
    <p class="helper">${copy.controls.strategyNote}</p>`;
}

function choice(name, value, checked, title, note, onSelect) {
  return html`<label class="choice"
    ><input
      type="radio"
      name=${name}
      value=${value}
      .checked=${checked}
      @change=${() => onSelect(value)}
    /><span><strong>${title}</strong><small>${note}</small></span></label
  >`;
}

function referenceFields(model, copy, actions) {
  const text = copy.controls.profile;
  const select = (value) => actions.setChoice('profile', value);
  return html`<fieldset class="choice-list">
      <legend>${text.legend}</legend>
      ${choice(
        'controlProfile',
        'step',
        model.config.profile === 'step',
        text.step.title,
        text.step.note,
        select,
      )}${choice(
        'controlProfile',
        'ramp',
        model.config.profile === 'ramp',
        text.ramp.title,
        text.ramp.note,
        select,
      )}
    </fieldset>
    <p class="helper">${text.note}</p>`;
}

function feedbackFields(model, copy, actions) {
  const text = copy.controls.feedback;
  const select = (value) => actions.setFlag('feedback', value === 'on');
  return html`<fieldset class="choice-list">
      <legend>${text.legend}</legend>
      ${choice(
        'controlFeedback',
        'off',
        !model.config.feedback,
        text.off.title,
        text.off.note,
        select,
      )}${choice(
        'controlFeedback',
        'on',
        model.config.feedback,
        text.on.title,
        text.on.note,
        select,
      )}
    </fieldset>
    <details id="controlFixedPower" ?hidden=${model.config.feedback}>
      <summary>${text.fixedPowerSummary}</summary>
      ${settingSlider('power', copy.settings.fixedPower, model, actions)}
    </details>
    <p class="helper">${text.note}</p>`;
}

function antiWindupFields(model, copy, actions) {
  const text = copy.controls.antiWindup;
  return html`<label class="choice"
      ><input
        id="controlAntiWindup"
        type="checkbox"
        .checked=${model.config.antiWindup}
        @change=${(event) => actions.setFlag('antiWindup', event.target.checked)}
      /><span><strong>${text.title}</strong><small>${text.note}</small></span></label
    >
    <p class="helper">${text.fixedNote}</p>`;
}

function gainFields(model, copy, actions) {
  const { topicId } = model;
  return html`${settingSlider('kp', copy.settings.kp, model, actions)}${
    ['i', 'challenge'].includes(topicId)
      ? settingSlider('ki', copy.settings.ki, model, actions)
      : nothing
  }${
    ['d', 'challenge'].includes(topicId)
      ? settingSlider('kd', copy.settings.kd, model, actions)
      : nothing
  }`;
}

function scenarioField(model, copy, actions) {
  return html`<label class="control-select" for="controlScenario"
    >走らせる条件<select
      id="controlScenario"
      @change=${(event) => actions.setChoice('scenario', event.target.value)}
    >
      ${optionList(copy.labels.scenario, model.config.scenario)}
    </select></label
  >`;
}

function settingFields(model, copy, actions) {
  const { topicId } = model;
  if (topicId === 'output')
    return html`${settingSlider('power', copy.settings.power, model, actions)}
      <p class="helper">${copy.controls.outputNote}</p>`;
  if (isFeedforwardTopic(topicId))
    return html`${settingSlider('targetRPM', copy.settings.targetRPM, model, actions)}${loadCaseField(
        model,
        copy,
        actions,
      )}${topicId === 'combined' ? strategyField(model, copy, actions) : nothing}
      <details>
        <summary>出力の見積もり方を変える</summary>
        ${settingSlider('ffGain', copy.settings.ffGain, model, actions)}
      </details>`;
  if (topicId === 'reference') return referenceFields(model, copy, actions);
  if (topicId === 'feedback') return feedbackFields(model, copy, actions);
  if (topicId === 'limits') return antiWindupFields(model, copy, actions);
  if (topicId === 'noise')
    return html`${settingSlider('filter', copy.settings.filter, model, actions)}
      <p class="helper">${copy.controls.noiseNote}</p>`;
  if (topicId === 'challenge')
    return html`${scenarioField(model, copy, actions)}${gainFields(model, copy, actions)}`;
  return gainFields(model, copy, actions);
}

// Which of the three challenge scenarios the current settings have already passed.
function passedScenarios(model) {
  const key = configKey(model.config);
  return new Set(
    model.runs
      .filter((run) => run.metrics.passed && configKey(run.config) === key)
      .map((run) => run.config.scenario),
  );
}

function badges(model, copy) {
  const passed = passedScenarios(model);
  const scenarios = Object.entries(copy.labels.scenario);
  return html`<div id="controlBadges" class="control-badges">
    <strong>この設定で達成 ${passed.size} / ${scenarios.length}</strong>
    <p>${copy.badges.recheck}</p>
    ${scenarios.map(
      ([id, label]) =>
        html`<span class=${passed.has(id) ? 'achieved' : ''}
          >${(passed.has(id) ? '✓ ' : '○ ') + label}</span
        >`,
    )}
    ${
      passed.size === scenarios.length
        ? html`<p><strong>${copy.badges.allPassed}</strong>${copy.badges.allPassedNote}</p>`
        : nothing
    }
  </div>`;
}

function controlPanel(model, copy, actions) {
  const goal = model.distance
    ? copy.goal.distance
    : fill(copy.goal.speed, { rpm: model.config.targetRPM });
  return html`<aside class="guide card control-guide">
    <p class="eyebrow">条件を決める</p>
    <h2 id="controlGoal">${goal}</h2>
    ${settingFields(model, copy, actions)}
    <button id="controlRun" class="primary full" @click=${actions.run}>
      ${model.result ? 'この設定でもう一度試す' : 'この設定で実験する'}
    </button>
    <p id="controlRunStatus" class="helper" role="status">${model.status}</p>
    <button id="controlReset" class="text-button" @click=${actions.reset}>
      設定を初期値に戻す
    </button>
    ${model.topicId === 'challenge' ? badges(model, copy) : nothing}
    <button class="text-button control-live-jump" data-control-live-jump @click=${actions.showLive}>
      ${copy.live.jumpToLive}
    </button>
  </aside>`;
}

// --- robot, readings and playback ---------------------------------------------------------

function readings(model, copy) {
  const { distance, frame, result } = model;
  const targetValue = distance
    ? formatValue(STOP_DISTANCE * CENTIMETRES, 0) + ' cm'
    : formatValue(result ? frame.target : model.config.targetRPM, 0) + ' rpm';
  const measured = () => {
    if (!result) return '—';
    return distance ? formatValue(frame.measured * CENTIMETRES, 0) : formatValue(frame.measured, 1);
  };
  const output = result ? formatValue(distance ? frame.rpm : frame.command) : '—';
  return html`<div>
      <span>${model.topicId === 'reference' ? 'いまの目標' : '目標'}</span
      ><strong>${targetValue}</strong>
    </div>
    <div>
      <span>${model.topic.sensor}</span><strong>${measured() + (distance ? ' cm' : ' rpm')}</strong>
    </div>
    <div>
      <span>${distance ? '左右の車輪の回転数' : 'モーターへの出力'}</span
      ><strong>${output + (distance ? ' rpm' : ' %')}</strong>
    </div>`;
}

// How the command was put together, for the two topics that build it from an estimate.
function contributions(model, copy) {
  const { frame, result } = model;
  if (!result) return copy.visual.contributionsIdle;
  if (model.topicId === 'feedforward')
    return html`<span>目標 <strong>${formatValue(frame.target, 0) + ' rpm'}</strong></span
      ><b>×</b
      ><span>1 rpmあたり <strong>${formatValue(result.config.ffGain, 2) + '%'}</strong></span
      ><b>→</b><span>出力 <strong>${formatValue(frame.command) + '%'}</strong></span
      >${frame.ff > 100 ? html`<small>${copy.visual.feedforwardCapped}</small>` : nothing}`;
  return html`<span>見積もり FF <strong>${formatValue(frame.ff) + '%'}</strong></span
    ><b>＋</b><span>ずれの修正 FB <strong>${formatValue(frame.correction) + '%'}</strong></span
    ><b>→</b><span>出力 <strong>${formatValue(frame.command) + '%'}</strong></span
    >${
      Math.abs(frame.ff + frame.correction) > 100
        ? html`<small>${copy.visual.sumCapped}</small>`
        : nothing
    }`;
}

function visualCard(model, copy, actions) {
  return html`<section id="controlVisual" class="card control-visual">
    <div class="section-top">
      <h2>${model.distance ? copy.visual.titleDistance : copy.visual.titleSpeed}</h2>
      <span id="controlTime" class="control-time">${timeLabel(model, copy)}</span>
    </div>
    <p class="figure-guide">
      <strong>図の見方</strong
      >${model.distance ? copy.visual.figureDistance : copy.visual.figureSpeed}
    </p>
    <canvas
      id="controlRobot"
      width="960"
      height="300"
      role="img"
      aria-label=${model.distance ? copy.visual.canvasDistance : copy.visual.canvasSpeed}
    ></canvas>
    <div id="controlReadings" class="control-readings">${readings(model, copy)}</div>
    <div
      id="controlContributions"
      class="control-contributions"
      ?hidden=${!isFeedforwardTopic(model.topicId)}
    >
      ${contributions(model, copy)}
    </div>
    <div class="control-playbar">
      <button id="controlReplay" ?disabled=${!model.result} @click=${actions.toggleReplay}>
        ${replayLabel(model)}
      </button>
      <label for="controlScrub" class="sr-only">確認する時刻（観察済みの範囲）</label>
      <input
        id="controlScrub"
        type="range"
        min="0"
        max=${LAST_SAMPLE}
        .value=${live(String(model.index))}
        ?disabled=${!model.result}
        @input=${(event) => actions.seek(Number(event.target.value))}
      />
      <label class="control-speed" for="controlSpeed"
        >再生速度<select
          id="controlSpeed"
          .value=${String(model.speed)}
          @change=${(event) => actions.setSpeed(Number(event.target.value))}
        >
          <option value="1">1倍</option>
          <option value="2">2倍</option>
        </select></label
      >
    </div>
  </section>`;
}

// --- charts -------------------------------------------------------------------------------

function chartMarker(model) {
  if (model.topicId === 'limits') return 'blocked';
  const loadCase = model.result ? model.result.loadCase : controlLoad(model.topicId, model.config);
  if (!model.distance && loadCase === 'drag') return 'load';
  return null;
}

// What the rpm / distance chart draws. Without a simulated run, real runs are drawn on their own:
// no "run an experiment" text, no simulated target for the wheels (the wall's 50 cm is the real
// run's target too) and no simulated load event.
function chartLayers(model) {
  const hasRun = Boolean(model.result);
  const real = Boolean(model.live.chart) || model.live.compared.length > 0;
  return {
    target: hasRun || !real || model.distance,
    marker: hasRun || !real ? chartMarker(model) : null,
  };
}

// A short line in the legend drawn like the line it names.
const swatch = (style) =>
  html`<svg class="control-legend-swatch" viewBox="0 0 24 8" aria-hidden="true">
    <line
      x1="1"
      y1="4"
      x2="23"
      y2="4"
      stroke=${style.color}
      stroke-width=${style.width}
      stroke-dasharray=${style.dash || nothing}
    />
  </svg>`;

const labelOf = (parts) => [parts.settings, parts.time].filter(Boolean).join(' ');

// Lists only the lines the chart draws; a real run is named with its settings and time.
function chartLegend(model, copy, layers) {
  const { result, comparison, live, distance } = model;
  const current = live.current;
  return html`<div class="control-chart-legend">
    ${result ? html`<span class="measured">今回</span>` : nothing}${
      layers.target ? html`<span class="target">目標</span>` : nothing
    }${comparison ? html`<span class="previous">前回</span>` : nothing}${
      layers.marker ? html`<span class="event">出来事</span>` : nothing
    }${
      current
        ? html`<span class="live"
            >${fill(copy.charts.liveLegendLabel, { label: labelOf(current.parts) })}</span
          >`
        : nothing
    }${
      current && !distance && Number.isFinite(current.command)
        ? html`<span class="swatch"
            >${swatch(liveCommandStyle())}${copy.charts.liveTargetLegend}</span
          >`
        : nothing
    }${live.compared.map(
      (entry) =>
        html`<span class="swatch"
          >${swatch(comparedStyle(entry))}${fill(copy.charts.comparedLegend, {
            letter: entry.letter,
            label: labelOf(entry.parts),
          })}</span
        >`,
    )}
  </div>`;
}

// The simulated 60 rpm and the real 0.2 m/s step are of different size: say so next to the chart.
function scaleNote(model, copy) {
  const current = model.live.current;
  if (model.distance || !current || !Number.isFinite(current.command)) return nothing;
  const rpm = formatValue(current.command, 0);
  const speed = current.conditions?.speed;
  const step = Number.isFinite(speed)
    ? fill(copy.live.scaleStep, { speed: speed.toFixed(1) + ' m/s', rpm })
    : fill(copy.live.scaleStepUnknown, { rpm });
  const target = model.result ? model.result.target : model.config.targetRPM;
  return html`<p class="control-live-scale">${fill(copy.live.scaleNote, { target, step })}</p>`;
}

// After looking at a real run, the way back to the robot block (far below on a phone).
function backToLive(model, copy, actions) {
  if (!model.live.current && !model.live.compared.length) return nothing;
  return html`<button
    class="text-button control-back-to-live"
    data-control-back-to-live
    @click=${actions.showLive}
  >
    ${copy.live.backToLive}
  </button>`;
}

function charts(model, copy, actions) {
  const { distance, result, comparison } = model;
  const fallback = distance ? STOP_DISTANCE : model.config.targetRPM;
  const layers = chartLayers(model);
  const shared = {
    run: result,
    previous: comparison,
    distance,
    fallback,
    width: model.chartWidth,
    cursorTime: model.frame.time,
    marker: layers.marker,
    copy,
  };
  const targetValue = distance
    ? formatValue(STOP_DISTANCE * CENTIMETRES, 0) + ' cm'
    : (result ? result.target : fallback) + ' rpm';
  const command = model.live.current?.command;
  const measured = controlChart({
    ...shared,
    live: model.live.chart,
    compared: model.live.compared,
    key: 'measured',
    title: distance ? '壁までの距離' : '車輪の回転数',
    unit: distance ? 'cm' : 'rpm',
    factor: distance ? CENTIMETRES : 1,
    target: layers.target,
    targetCaption: (model.topicId === 'reference' ? '最終目標' : '目標') + ' ' + targetValue,
    commandCaption: Number.isFinite(command)
      ? fill(copy.charts.liveCommandCaption, { rpm: formatValue(command, 0) })
      : '',
  });
  // Only the load is named here, even in the challenge topic, so the caption stays short.
  const previousNote = comparison
    ? gainText(comparison.config, model.topicId, copy) +
      loadSuffix(comparison, model.topicId, copy, '・')
    : '';
  return html`${chartLegend(model, copy, layers)}
  ${
    comparison
      ? html`<p class="control-previous-note">
          ${fill(copy.charts.previousSimulation, { settings: previousNote })}
        </p>`
      : nothing
  }
  ${measured}${scaleNote(model, copy)}${comparisonTable(model, copy.live)}${backToLive(
    model,
    copy,
    actions,
  )}
  ${commandSection(model, copy, actions, shared)}`;
}

function commandSection(model, copy, actions, shared) {
  const { distance, topicId } = model;
  const breakdown = topicId === 'combined';
  const options = model.integralTitled
    ? { title: '出力とIの補正', extra: model.showIntegral }
    : { title: distance ? '車輪への指示' : 'モーターへの出力', breakdown };
  const note = () => {
    if (topicId === 'limits') return copy.charts.commandLimits;
    return distance ? copy.charts.commandDistance : copy.charts.commandSpeed;
  };
  return html`<details
    ?open=${model.commandOpen}
    @toggle=${(event) => actions.setCommandOpen(event.target.open)}
  >
    <summary>${(distance ? '車輪へ指示した回転数の割合' : 'モーターへの出力') + 'を見る'}</summary>
    <p>
      ${note()}${
        topicId === 'limits'
          ? html`<label class="control-compare"
              ><input
                id="controlShowI"
                type="checkbox"
                .checked=${model.showIntegral}
                @change=${(event) => actions.setShowIntegral(event.target.checked)}
              />Iの補正も表示する（青い線「I」）</label
            >`
          : nothing
      }
    </p>
    ${
      breakdown
        ? html`<div class="control-chart-legend">
            <span class="measured">実際の指示（今回）</span><span class="ff-line">見積もり FF</span
            ><span class="fb-line">ずれの修正 FB</span>
          </div>`
        : nothing
    }
    <div id="controlCommandGraph">
      ${controlChart({ ...shared, key: 'command', unit: '%', ...options })}
    </div>
  </details>`;
}

function liveChartNote(model, copy) {
  if (!model.live.run) return nothing;
  return model.distance ? copy.charts.liveNoteDistance : copy.charts.liveNote;
}

function graphsCard(model, copy, actions) {
  return html`<section id="controlGraphs" class="card control-graphs">
    <div class="section-top">
      <h2>時間とともに、値はどう変わった？</h2>
      <label class="control-compare"
        ><input
          id="controlCompare"
          type="checkbox"
          .checked=${model.compare && Boolean(model.previous)}
          ?disabled=${!model.previous}
          @change=${(event) => actions.setCompare(event.target.checked)}
        />${copy.charts.compareToggle}${
          model.previous ? nothing : html`<small>（${copy.charts.compareLater}）</small>`
        }</label
      >
    </div>
    <div id="controlCharts">${charts(model, copy, actions)}</div>
    <p class="control-chart-note">
      ${model.distance ? copy.charts.noteDistance : copy.charts.noteSpeed}<span id="controlLoadNote"
        >${model.loadNote}</span
      >
      ${liveChartNote(model, copy)}
    </p>
  </section>`;
}

// --- calibration, results and history ------------------------------------------------------

function calibrationCard(model, copy) {
  if (model.topicId !== 'feedforward') return nothing;
  const text = copy.calibration;
  return html`<section class="card control-calibration">
    <h2>${text.title}</h2>
    <p>${text.intro}</p>
    <table>
      <thead>
        <tr>
          <th>モーターへの出力</th>
          ${model.calibration.map((point) => html`<td>${point.power + '%'}</td>`)}
        </tr>
      </thead>
      <tbody>
        <tr>
          <th>車輪の回転数</th>
          ${model.calibration.map((point) => html`<td>${formatValue(point.rpm, 0) + ' rpm'}</td>`)}
        </tr>
      </tbody>
    </table>
    <p>${text.note}</p>
  </section>`;
}

// Recording the real robot and drawing it on the same axes as the simulation. Either the learner
// drives the robot from the controller while this card records what the wheels (speed topics) or
// the LiDAR (distance topics) measured, or — on a robot that allows it — the card drives the robot
// itself: a step input (speed), or the simulation's own PID stopping in front of the wall.
function liveCard(model, copy, actions) {
  const text = copy.live;
  const shown = Boolean(model.live.run) || model.live.compared.length > 0;
  return html`<section id="controlLive" class="card control-live">
    <h2>
      ${unsafeHTML(runModeBadgeHtml('live'))}${unsafeHTML(runModeBadgeHtml('drive'))} ${text.title}
    </h2>
    <p>${model.distance ? text.distanceIntro : text.intro}</p>
    <p>${model.distance ? text.distanceHowto : text.howto}</p>
    ${model.distance ? nothing : stepSpeedSelect(model, text, actions)}
    ${liveCaptureControls(model.live.capture, actions)}
    ${
      model.live.note
        ? html`<p class="control-live-recorded" role="status">${model.live.note}</p>`
        : nothing
    }
    ${
      shown
        ? html`<button
            class="control-show-charts"
            data-control-show-charts
            @click=${actions.showCharts}
          >
            ${text.showCharts}
          </button>`
        : nothing
    }
    ${model.live.run ? html`<button @click=${actions.clearLive}>${text.clear}</button>` : nothing}
    ${compareControls(model, text, actions)}
  </section>`;
}

// The speed of the real step input; only offered while the card can drive the robot.
function stepSpeedSelect(model, text, actions) {
  const capture = model.live.capture;
  if (!capture.drive?.allowed || !capture.link.connected) return nothing;
  return html`<label class="control-live-speed"
    >${text.driveSpeedLabel}
    <select
      data-live-step-speed
      ?disabled=${capture.recording}
      @change=${(event) => actions.setLiveStepSpeed(Number(event.target.value))}
    >
      ${model.live.stepSpeeds.map(
        (option) =>
          html`<option value=${option.speed} ?selected=${option.speed === model.live.stepSpeed}>
            ${option.label}
          </option>`,
      )}
    </select></label
  >`;
}

// Other groups' saved recordings (or rosbags), drawn on the same chart.
function compareControls(model, text, actions) {
  return html`<div class="control-compare-files">
    <label
      >${text.compareOpen}
      <input
        data-live-compare
        type="file"
        multiple
        accept=".json,.mcap,application/json"
        @change=${(event) => {
          actions.addComparisons(event.target.files);
          event.target.value = '';
        }}
    /></label>
    ${
      model.live.compared.length
        ? html`<button data-live-compare-clear @click=${actions.clearComparisons}>
            ${text.compareClear}
          </button>`
        : nothing
    }
    <p class="helper">${text.compareNote}</p>
    ${model.live.compareNote ? html`<p role="status">${model.live.compareNote}</p>` : nothing}
  </div>`;
}

const secondsText = (value) => (value === null ? '—' : formatValue(value) + ' 秒');

// The numbers of one row, in the order of the columns after the name and 設定.
function metricCells(metrics, distance, text) {
  const value = (number) =>
    distance ? formatValue(number * CENTIMETRES, 0) + ' cm' : formatValue(number, 1) + ' rpm';
  const settling =
    metrics.settling === null ? text.compareNotSettled : secondsText(metrics.settling);
  const cells = [
    value(metrics.target),
    value(metrics.finalError),
    value(metrics.overshoot),
    settling,
  ];
  return distance ? cells : [...cells, secondsText(metrics.delay), secondsText(metrics.tau)];
}

// A phone card shows these numbers (最後のずれ・行き過ぎ・落ち着くまで) and folds the rest.
const KEY_METRICS = [1, 2, 3]; // indices into metricCells

function settingsCell(row, text) {
  return html`${row.settings}${
    row.stale ? html`<small class="control-compare-stale">${text.compareStale}</small>` : nothing
  }${row.file ? html`<small>${fill(text.compareFile, { name: row.file })}</small>` : nothing}`;
}

// Chromebook: one table, every run a row.
function compareTableWide(rows, columns, distance, text) {
  return html`<table class="control-compare-wide">
    <thead>
      <tr>
        ${columns.map((column) => html`<th>${column}</th>`)}
      </tr>
    </thead>
    <tbody>
      ${rows.map(
        (row) =>
          html`<tr class=${row.stale ? 'stale' : ''}>
            <th>${row.name}</th>
            <td class="control-compare-settings">${settingsCell(row, text)}</td>
            ${metricCells(row.metrics, distance, text).map((cell) => html`<td>${cell}</td>`)}
          </tr>`,
      )}
    </tbody>
  </table>`;
}

// Phone: one card per run, so no number is off screen.
function compareCards(rows, columns, distance, text) {
  const names = columns.slice(2);
  return html`<ol class="control-compare-cards">
    ${rows.map((row) => {
      const cells = metricCells(row.metrics, distance, text);
      const pair = (index) =>
        html`<div>
          <dt>${names[index]}</dt>
          <dd>${cells[index]}</dd>
        </div>`;
      const rest = cells
        .map((cell, index) => index)
        .filter((index) => !KEY_METRICS.includes(index));
      return html`<li class=${row.stale ? 'stale' : ''}>
        <h4>${row.name}</h4>
        <p>${settingsCell(row, text)}</p>
        <dl>${KEY_METRICS.map(pair)}</dl>
        <details>
          <summary>${text.compareMore}</summary>
          <dl>${rest.map(pair)}</dl>
        </details>
      </li>`;
    })}
  </ol>`;
}

// The same numbers for the simulation and every real run, by the course's own definitions, right
// under the chart that draws them, with one sentence on what changed between the last two runs.
function comparisonTable(model, text) {
  const rows = model.live.table;
  if (rows.length < 2) return nothing;
  const distance = model.distance;
  const columns = distance ? text.compareColumnsDistance : text.compareColumnsSpeed;
  return html`<div class="control-compare-table">
    <h3>${text.compareTitle}</h3>
    ${compareTableWide(rows, columns, distance, text)}${compareCards(rows, columns, distance, text)}
    ${
      model.live.conclusion
        ? html`<p class="control-compare-conclusion">${model.live.conclusion}</p>`
        : nothing
    }
    <p class="helper">${distance ? text.compareExplainDistance : text.compareExplainSpeed}</p>
  </div>`;
}

// The same three methods, under the same conditions, as far as the learner has tried them.
function methodComparison(model, run, copy) {
  const sameConditions = (other) =>
    other.config.targetRPM === run.config.targetRPM &&
    other.loadCase === run.loadCase &&
    other.config.ffGain === run.config.ffGain &&
    other.config.kp === run.config.kp &&
    other.config.ki === run.config.ki;
  const cells = (method) => {
    const match = [...model.runs].reverse().find((x) => x.method === method && sameConditions(x));
    if (!match) return html`<td colspan="3">${copy.results.notTried}</td>`;
    return html`<td>${formatValue(match.samples[20].actual) + ' rpm'}</td>
      <td>${formatValue(match.metrics.finalError) + ' rpm'}</td>
      <td>${formatValue(match.metrics.overshoot) + ' rpm'}</td>`;
  };
  return html`<div class="control-method-comparison">
    <h3>${copy.results.methodComparisonTitle}</h3>
    <p>
      ${fill(copy.results.methodComparisonIntro, {
        target: run.target,
        load: copy.labels.load[run.loadCase],
      })}
    </p>
    <div class="control-table-scroll">
      <table>
        <thead>
          <tr>
            <th>指示の決め方</th>
            <th>1秒後の回転数</th>
            <th>最後のずれ</th>
            <th>最大の行き過ぎ</th>
          </tr>
        </thead>
        <tbody>
          ${['feedforward', 'feedback', 'both'].map(
            (method) =>
              html`<tr>
                <th>${copy.labels.method[method]}</th>
                ${cells(method)}
              </tr>`,
          )}
        </tbody>
      </table>
    </div>
  </div>`;
}

// The first stage shows one number: the speed the wheel settled at, and how far from the target.
function simpleResultMetrics(run, copy) {
  const [speed, gap] = simpleMetricText(run, copy);
  return html`<div class="control-metrics control-metrics-simple">
    <div>
      <span>${copy.results.settledSpeed}</span><strong>${speed}</strong
      ><small>（${gap}）${copy.results.settledSpeedNote}</small>
    </div>
  </div>`;
}

function resultMetrics(model, run, copy) {
  if (isSimpleTopic(model.topicId)) return simpleResultMetrics(run, copy);
  const [finalError, overshoot, settling] = metricText(run, copy);
  const metrics = run.metrics;
  const distance = model.distance;
  const overshootNote = distance
    ? copy.results.overshootDistance
    : fill(copy.results.overshootSpeed, { target: run.target });
  const settlingLabel = () => {
    if (distance) return copy.results.settlingDistance;
    return metrics.after ? copy.results.settlingAfterLoad : copy.results.settlingToTarget;
  };
  const settlingNote = distance
    ? copy.results.settlingDistanceNote
    : fill(copy.results.settlingSpeedNote, { after: metrics.after, target: run.target });
  return html`<div class="control-metrics">
    <div>
      <span>最後の2秒のずれ</span><strong>${finalError}</strong
      ><small>${copy.results.finalErrorNote}</small>
    </div>
    <div>
      <span>最大の行き過ぎ</span><strong>${overshoot}</strong
      ><small>${overshootNote + copy.results.wholeRun}</small>
    </div>
    <div>
      <span>${settlingLabel()}</span><strong>${settling}</strong><small>${settlingNote}</small>
    </div>
  </div>`;
}

function resultsBody(model, run, copy, actions) {
  const { topicId } = model;
  const metrics = run.metrics;
  const heading = () => {
    if (topicId !== 'challenge') return copy.results.compare;
    return metrics.passed ? copy.results.passed : copy.results.improve;
  };
  return html`<div class="control-result-heading">
      <div>
        <p class="eyebrow">結果を見る · ${model.runs.length}回目</p>
        <h2>${heading()}</h2>
        <p>${gainText(run.config, topicId, copy) + conditionText(run, topicId, copy, ' · ')}</p>
      </div>
      <button id="controlExport" @click=${actions.save}>実験データを保存</button>
    </div>
    ${resultMetrics(model, run, copy)}
    <p id="controlSummary" class="control-summary">${runSummary(run, topicId, copy.summary)}</p>
    ${
      topicId === 'reference'
        ? html`<p class="control-result-note">
            ${copy.results.peakAccelerationLabel}<strong>${formatValue(metrics.peakAcceleration) + ' rpm/秒'}</strong>${copy.results.peakAccelerationNote}
          </p>`
        : nothing
    }
    ${topicId === 'combined' ? methodComparison(model, run, copy) : nothing}
    ${
      topicId === 'noise'
        ? html`<p class="control-result-note">
            ${copy.results.chatterLabel}<strong>${formatValue(metrics.chatter) + 'ポイント'}</strong>${copy.results.chatterNote}
          </p>`
        : nothing
    }
    ${run.collision ? html`<p class="control-alert">${copy.results.collision}</p>` : nothing}
    <p class="control-result-note">${hintText(run, topicId, copy)}</p>
    ${isSimpleTopic(topicId) ? nothing : html`<p class="helper">${copy.results.metricsNote}</p>`}
    ${
      topicId === 'challenge'
        ? html`<p class="helper">${copy.results.challengeCriteria}</p>`
        : nothing
    }`;
}

function resultsCard(model, copy, actions) {
  const run = model.finishedRun;
  return html`<section id="controlResults" class="card control-results" ?hidden=${!run}>
    ${run ? resultsBody(model, run, copy, actions) : nothing}
  </section>`;
}

function historyCard(model, copy) {
  const { runs, topicId } = model;
  const simple = isSimpleTopic(topicId);
  const columns = simple ? copy.history.simpleColumns : ['最後のずれ', '行き過ぎ', '落ち着くまで'];
  const rows = runs.map(
    (run, index) =>
      html`<tr>
        <td>${index + 1}</td>
        <td>${gainText(run.config, topicId, copy) + conditionText(run, topicId, copy, '・')}</td>
        ${(simple ? simpleMetricText(run, copy) : metricText(run, copy)).map(
          (value) => html`<td>${value}</td>`,
        )}
      </tr>`,
  );
  return html`<details class="card control-history">
    <summary>
      シミュレーションの記録を比べる <span id="controlHistoryCount">${`（${runs.length}回）`}</span>
    </summary>
    <div id="controlHistory">
      ${
        runs.length
          ? html`<p>${copy.history.intro}</p>
              <div class="control-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>回</th>
                      <th>設定</th>
                      ${columns.map((column) => html`<th>${column}</th>`)}
                    </tr>
                  </thead>
                  <tbody>
                    ${rows}
                  </tbody>
                </table>
              </div>`
          : html`<p>${copy.history.empty}</p>`
      }
    </div>
  </details>`;
}

// --- explanation, question, hardware, footer -----------------------------------------------

function formulaText(model, copy) {
  const formulas = copy.explanation.formulas;
  const { topicId } = model;
  if (topicId === 'feedforward') return formulas.feedforward;
  if (topicId === 'feedback') return formulas.feedback;
  if (topicId === 'combined') return formulas.combined;
  return model.withFeedforward ? formulas.withFeedforward : formulas.pid;
}

function formulaDetails(model, copy) {
  const text = copy.explanation;
  const intro = model.topic.group === 0;
  const formula =
    model.topicId === 'output'
      ? html`<p>${text.openLoop}</p>`
      : html`<p><strong>${formulaText(model, copy)}</strong></p>
          ${model.withFeedforward ? html`<p>${text.feedforwardScope}</p>` : nothing}
          ${intro ? nothing : html`<p>${text.gains}</p>`}`;
  const scale = intro
    ? html`<p>${text.outputScale}</p>`
    : html`<p>${model.distance ? text.errorDistance : text.errorSpeed}</p>
        <p>${text.numerics}</p>`;
  return html`<details data-help-dialog>
    <summary>式と数値の扱いを見る</summary>
    ${formula}${scale}
  </details>`;
}

function explanationCard(model, copy, actions) {
  const text = copy.explanation;
  const flow = text.flows[model.topicId] || text.flows.feedback;
  return html`<section class="card control-explanation">
    <h2>${model.topicId === 'output' ? text.titleOutput : text.titleControl}</h2>
    <p>${text.topics[model.topicId]}</p>
    ${conceptLesson(model.concept, actions)}
    <div class="control-loop" aria-label="制御の流れ">
      ${flow.map((stage, index) =>
        index
          ? html`<b aria-hidden="true">→</b><span>${stage}</span>`
          : html`<span>${stage}</span>`,
      )}
    </div>
    ${formulaDetails(model, copy)}
  </section>`;
}

function questionCard(model, copy, actions) {
  const hint = () => {
    if (model.finishedRun) return hintText(model.finishedRun, model.topicId, copy);
    return model.result ? copy.hints.whileRunning : copy.hints.beforeRun;
  };
  return html`<section class="card control-question">
    <h2>結果を見て、次に何を一つ変える？</h2>
    <p>${model.topic.question}</p>
    <details>
      <summary>結果に合わせたヒントを見る</summary>
      <p id="controlHint">${hint()}</p>
    </details>
    <label for="controlNote"
      >考えた理由を記録する <span>（任意・このタブを開いている間だけ保存）</span></label
    >
    <textarea
      id="controlNote"
      rows="2"
      placeholder=${copy.question.notePlaceholder}
      .value=${model.note}
      @input=${(event) => actions.setNote(event.target.value)}
    ></textarea>
  </section>`;
}

function hardwareCard(hardwareHtml) {
  return html`<details data-help-dialog class="card control-hardware">
    <summary>同じロボット・ROS 2で確かめるには</summary>
    <div class="control-hardware-body">${unsafeHTML(hardwareHtml)}</div>
  </details>`;
}

function footer(model, copy, actions) {
  const position = CONTROL_TOPICS.indexOf(model.topic);
  const next = CONTROL_TOPICS[position + 1];
  return html`<div class="basics-footer">
    <p>${position + 1} / ${CONTROL_TOPICS.length} ${copy.footer.note}</p>
    <button id="controlNext" class="primary" @click=${actions.next}>
      ${next ? '次へ：' + next.name : '小テストで確かめる →'}
    </button>
  </div>`;
}

function groupNav(model, actions) {
  return html`<nav class="basics-topics basics-groups" aria-label="学ぶ順序">
    ${CONTROL_GROUPS.map(
      (group, index) =>
        html`<button
          data-control-group=${index}
          aria-pressed=${String(model.topic.group === index)}
          @click=${() => actions.openGroup(index)}
        >
          <span>${index + 1}</span>${group}
        </button>`,
    )}
  </nav>`;
}

// The experiments of the current stage as numbered boxes (1-1, 1-2 …), ✓ once one has been run,
// with one line saying where the learner is.
function topicNav(model, copy, actions) {
  const siblings = CONTROL_TOPICS.filter((topic) => topic.group === model.topic.group);
  const place = topicPlace(CONTROL_TOPICS, model.topicId);
  return html`<nav class="learning-subtopics control-topic-nav" aria-label="この段階の制御実験">
      ${siblings.map((topic) => {
        const done = model.doneTopics.includes(topic.id);
        return html`<button
          data-control-topic=${topic.id}
          aria-pressed=${String(model.topicId === topic.id)}
          @click=${() => actions.openTopic(topic.id)}
        >
          <span class="control-topic-number">${topicPlace(CONTROL_TOPICS, topic.id).label}</span
          >${topic.name}${
            done
              ? html`<span class="control-topic-done" aria-label=${copy.nav.done}>✓</span>`
              : nothing
          }
        </button>`;
      })}
    </nav>
    <p class="control-topic-place">${fill(copy.nav.place, place)}</p>`;
}

function controlPage(model, copy, hardwareHtml, actions) {
  const lessonKey = 'control-' + model.topicId;
  return html`<div class="page-heading">
      <div>
        <p class="eyebrow course-label">${unsafeHTML(lessonLabel('control'))}</p>
        <h1>${model.topic.title}</h1>
      </div>
    </div>
    ${groupNav(model, actions)}${topicNav(model, copy, actions)}
    ${unsafeHTML(lessonBrief(lessonKey, model.topic) + schoolTips(lessonKey))}
    <div class="control-layout">
      <div class="control-workspace">
        ${calibrationCard(model, copy)}${visualCard(model, copy, actions)}${graphsCard(
          model,
          copy,
          actions,
        )}
      </div>
      ${controlPanel(model, copy, actions)}
    </div>
    ${resultsCard(model, copy, actions)}${explanationCard(model, copy, actions)}
    ${questionCard(model, copy, actions)}${historyCard(model, copy)}
    ${liveCard(model, copy, actions)}${hardwareCard(hardwareHtml)} ${footer(model, copy, actions)}`;
}

export { controlPage, gainText, COMMAND_OPEN_TOPICS };
