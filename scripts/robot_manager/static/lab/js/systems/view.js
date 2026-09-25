import { html, nothing, unsafeHTML, live } from '../vendor/lit-html.js';
import { decimalsOf } from '../core/chart-scale.js';
import { lessonBrief } from '../shell/lesson-brief.js';
import { schoolTips } from '../shell/school-tips.js';
import { systemScene, systemChart, stateDiagram, SYSTEM_CHARTS } from './render.js';
import { systemEvidence } from './narration.js';

// Templates of the six "systems" courses. Every function is pure: it turns the model built by
// ui.js (selected topic, experiment state, playback, draft settings, measured figure widths) into
// markup. Learner-facing sentences come from content/systems/ui.json (`copy`); only short labels
// live here.

const PLAYBACK_SPEEDS = [1, 2, 4];
const LAST_TOPIC_POSITION = 2; // three topics per course; the last one leads to the quiz

// Which charts a topic offers (in index order) and which one it opens with.
const TOPIC_CHARTS = {
  'mechanics/force': { shown: [0, 1, 2], initial: 0 },
  'tracking/velocity': { shown: [0, 3], initial: 0 },
  'tracking/prediction': { shown: [0, 1, 3], initial: 1 },
  'tracking/crossing': { shown: [2], initial: 2 },
  'timing/delay': { shown: [0, 1], initial: 0 },
  'timing/alignment': { shown: [2], initial: 2 },
  'timing/queue': { shown: [0, 1, 3], initial: 0 },
  'diagnostics/distance': { shown: [0], initial: 0 },
  'diagnostics/missing': { shown: [0, 1], initial: 1 },
  'diagnostics/impact': { shown: [2], initial: 2 },
};

function chartChoices(course, topicId) {
  const all = SYSTEM_CHARTS[course].map((_, index) => index);
  const shown = TOPIC_CHARTS[`${course}/${topicId}`]?.shown ?? all;
  return shown.map((index) => ({ index, title: SYSTEM_CHARTS[course][index].title }));
}

function initialChart(course, topicId) {
  return TOPIC_CHARTS[`${course}/${topicId}`]?.initial ?? 0;
}

// Metric values are numbers with a unit, or a ready-made word such as "あり".
function metricText(metric) {
  if (typeof metric.value !== 'number') return metric.value;
  return `${metric.value.toFixed(metric.digits)} ${metric.unit}`;
}

const seconds = (value, digits = 1) => `${value.toFixed(digits)} 秒`;

function fillTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key]));
}

function chapterNav(model, actions) {
  return html`<nav class="sys-chapters" aria-label="この教材の実験">
    ${model.topics.map(
      (topic, index) =>
        html`<button
          data-chapter=${topic.id}
          aria-current=${topic.id === model.topic.id ? 'step' : 'false'}
          @click=${() => actions.openTopic(topic.id)}
        >
          <span>${index + 1}</span>${topic.label}
        </button>`,
    )}
  </nav>`;
}

// On a phone the lesson brief is long: the first thing to try and a start button come first.
function quickStart(model, copy, actions) {
  return html`<section class="sys-quickstart" aria-label=${copy.quickStart.title}>
    <h2>${copy.quickStart.title}</h2>
    <p>${model.topic.first}</p>
    <div class="sys-quickstart-actions">
      <button
        class="primary"
        data-sys-quickrun
        ?disabled=${model.playing || model.releaseNeeded}
        @click=${actions.quickRun}
      >
        ${runButtonLabel(model, copy)}
      </button>
      <a href="#${model.course}-settings" @click=${actions.showSettings}
        >${copy.quickStart.settings}</a
      >
    </div>
  </section>`;
}

function statusText(model, copy) {
  if (!model.started) return copy.observation.statusBefore;
  if (model.playing) return model.sample.status;
  const phase = model.finished ? copy.observation.statusFinished : copy.observation.statusPaused;
  return phase + model.sample.status;
}

// A reading whose value is the contact itself (a status word such as 「接触」, not a number read
// at that moment) is shown in the danger role: red, with a warning sign in front of it.
function showsContact(model) {
  const value = model.drive?.value;
  return Boolean(
    model.started && model.sample?.contact && value && !Number.isFinite(parseFloat(value)),
  );
}

function driveReading(model) {
  const drive = model.drive;
  const fields = drive?.fields ?? [];
  const danger = showsContact(model);
  return html`<div
    class="sys-drive"
    data-sys-drive
    data-mode=${drive ? (danger ? 'danger' : drive.mode) : nothing}
    ?hidden=${!drive}
  >
    <div class="sys-drive-reading">
      <span data-sys-drive-label>${drive?.label ?? ''}</span
      ><strong data-sys-drive-value
        >${danger ? html`<span class="sys-danger-icon" aria-hidden="true">⚠</span>` : nothing}${
          drive?.value ?? ''
        }</strong
      >
    </div>
    <div class="sys-drive-body">
      <p data-sys-drive-text>${drive?.text ?? ''}</p>
      ${
        fields.length
          ? html`<dl class="sys-drive-fields">
              ${fields.map(
                (field) =>
                  html`<div>
                    <dt>${field.label}</dt>
                    <dd>${field.value}</dd>
                  </div>`,
              )}
            </dl>`
          : nothing
      }
    </div>
  </div>`;
}

function playButtonLabel(model, copy) {
  if (model.playing) return copy.playbar.pause;
  if (model.atEnd) return copy.playbar.restart;
  return copy.playbar.play;
}

function playbar(model, copy, actions) {
  const hintId = `${model.course}-seekhint`;
  const seekTime = model.started
    ? `${model.sample.t.toFixed(1)} / ${model.run.duration.toFixed(1)} 秒`
    : copy.playbar.seekTimeBefore;
  const seekHint = model.started ? copy.playbar.seekHintRunning : copy.playbar.seekHintBefore;
  return html`<div class="sys-playbar">
    <button data-sys-pause ?disabled=${!model.started} @click=${actions.togglePlay}>
      ${playButtonLabel(model, copy)}
    </button>
    <label
      >${copy.playbar.speed}
      <select
        data-sys-speed
        .value=${String(model.speed)}
        @change=${(event) => actions.setSpeed(Number(event.target.value))}
      >
        ${PLAYBACK_SPEEDS.map((speed) => html`<option value=${speed}>${speed}倍</option>`)}
      </select></label
    >
    <button
      data-sys-transition
      ?hidden=${!model.drive?.event || !model.drive?.replay}
      ?disabled=${!model.started}
      @click=${actions.replayTransition}
    >
      ${model.drive?.replay ?? ''}
    </button>
    <label class="sys-seek"
      >${copy.playbar.seek}
      <input
        data-sys-seek
        aria-describedby=${hintId}
        aria-label=${copy.playbar.seekAria}
        aria-valuetext="${model.sample.t.toFixed(2)}秒 / 全体 ${model.run.duration.toFixed(2)}秒"
        type="range"
        min="0"
        max=${model.run.samples.length - 1}
        value="0"
        step="1"
        .value=${String(model.index)}
        ?disabled=${!model.started}
        @pointerdown=${actions.holdPlayback}
        @keydown=${actions.seekByKey}
        @input=${(event) => actions.seek(Number(event.target.value))}
        @pointerup=${actions.refresh}
        @pointercancel=${actions.refresh}
      /><span class="sys-seek-time" data-sys-seektime>${seekTime}</span></label
    >
    ${model.fastForward ? html`<p class="sys-fast" role="status">${copy.playbar.fastForward}</p>` : nothing}
    <p class="sys-seek-hint" id=${hintId} data-sys-seekhint>${seekHint}</p>
  </div>`;
}

// One chart: a heading when the topic has only one, a choice when it has several.
function chartPicker(model, copy, actions) {
  if (model.chartChoices.length === 1)
    return html`<h3 class="sys-chart-title">
      ${fillTemplate(copy.observation.chartSingle, { title: model.chartChoices[0].title })}
    </h3>`;
  return html`<label class="sys-chart-pick"
    >${copy.observation.chartPick}
    <select data-sys-chart @change=${(event) => actions.selectChart(Number(event.target.value))}>
      ${model.chartChoices.map(
        (choice) =>
          html`<option value=${choice.index} ?selected=${choice.index === model.chartIndex}>
            ${choice.title}
          </option>`,
      )}
    </select></label
  >`;
}

function chartSection(model, copy, actions) {
  return html`<div class="sys-data">
    ${chartPicker(model, copy, actions)}
    <div data-sys-chartview>
      ${systemChart(model.run, model.index, model.chartIndex, model.previous, model.figure)}
    </div>
  </div>`;
}

function eventList(model, copy) {
  if (!model.events.length) {
    const text = model.started ? copy.observation.eventsNone : copy.observation.eventsBefore;
    return html`<li>${text}</li>`;
  }
  return model.events.map(
    (event) =>
      html`<li ?data-kind=${Boolean(event.kind)}>
        <time>${event.t.toFixed(1)}秒</time
        ><span
          >${event.text}${
            event.count > 1
              ? html`<small
                  >${fillTemplate(copy.observation.repeated, {
                    count: event.count,
                    every: event.every.toFixed(1),
                  })}</small
                >`
              : nothing
          }</span
        >
      </li>`,
  );
}

// The event list and (behaviour) the state diagram appear twice: under the scene on narrow
// screens, in the free column under the settings on wide ones. CSS shows one of the two.
function sideParts(model, copy, place) {
  return html`<div class="sys-side" data-place=${place}>
    <div class="sys-events">
      <h3 data-lesson-cue=${place === 'inline' ? 'observe' : nothing}>
        ${copy.observation.eventsTitle}
      </h3>
      <ol data-sys-events=${place}>
        ${eventList(model, copy)}
      </ol>
    </div>
  </div>`;
}

function observationCard(model, copy, actions) {
  return html`<section class="card sys-observation" aria-label=${copy.observation.ariaLabel}>
    <div class="sys-live-head">
      <strong data-sys-status>${statusText(model, copy)}</strong
      ><span data-sys-clock>${seconds(model.sample.t)}</span>
    </div>
    ${driveReading(model)}
    <div class="sys-figures">
      <div class="sys-figure-scene" data-sys-scene>
        ${systemScene(model.run, model.index, model.figure)}
        ${model.course === 'behavior' ? stateDiagram(model.run, model.index) : nothing}
      </div>
      ${chartSection(model, copy, actions)}
    </div>
    ${playbar(model, copy, actions)}
    <div class="sys-evidence" data-sys-evidence>
      ${systemEvidence(model.run, model.index, model.started)}
    </div>
    <p class="sys-reading">${model.topic.observe}</p>
    ${sideParts(model, copy, 'inline')}
  </section>`;
}

function checkField(control, id, value, actions) {
  return html`<label class="sys-check"
    ><input
      id=${id}
      data-setting=${control.key}
      type="checkbox"
      .checked=${live(Boolean(value))}
      @change=${(event) => actions.editSetting(control.key, event.target.checked)}
    /><span
      >${control.label}${control.note ? html`<small>${control.note}</small>` : nothing}</span
    ></label
  >`;
}

function selectField(control, id, value, actions, disabled) {
  return html`<select
    id=${id}
    data-setting=${control.key}
    ?disabled=${disabled}
    @change=${(event) => actions.editSetting(control.key, event.target.value)}
  >
    ${control.options.map(
      ([option, label]) =>
        html`<option value=${option} ?selected=${value === option}>${label}</option>`,
    )}
  </select>`;
}

// A bounded number is a slider with its value and range next to it: no keyboard needed on a
// phone, and the learner sees how far the setting can go.
function sliderField(control, id, value, actions, disabled) {
  const digits = decimalsOf(control.step);
  const shown = Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : String(value);
  const unit = control.unit ? ' ' + control.unit : '';
  return html`<span class="sys-slider"
      ><input
        id=${id}
        data-setting=${control.key}
        type="range"
        min=${control.min}
        max=${control.max}
        step=${control.step}
        .value=${live(String(value))}
        ?disabled=${disabled}
        @input=${(event) => actions.editSetting(control.key, event.target.value)}
      /><output for=${id}>${shown}${unit}</output></span
    ><span class="sys-range"
      >${Number(control.min).toFixed(digits)}〜${Number(control.max).toFixed(digits)}${unit}</span
    >`;
}

// A setting that does nothing with the current choice of another one is disabled, with the reason.
function disabledReason(model, control) {
  const rule = control.disabledUnless;
  if (!rule) return null;
  return model.draft[rule.key] === rule.value ? null : control.disabledNote;
}

function settingField(model, control, actions) {
  const id = `sys-${model.course}-${control.key}`;
  const value = model.draft[control.key];
  if (control.type === 'check') return checkField(control, id, value, actions);
  const reason = disabledReason(model, control);
  const input =
    control.type === 'select'
      ? selectField(control, id, value, actions, Boolean(reason))
      : sliderField(control, id, value, actions, Boolean(reason));
  return html`<label class="sys-field" for=${id} ?data-off=${Boolean(reason)}
    ><span>${control.label}</span>${input}${
      reason ? html`<small class="sys-off-reason">${reason}</small>` : nothing
    }${control.note ? html`<small>${control.note}</small>` : nothing}</label
  >`;
}

function runButtonLabel(model, copy) {
  if (model.playing) return copy.settings.running;
  if (model.releaseNeeded) return copy.settings.releaseFirst;
  return model.started ? copy.settings.again : copy.settings.start;
}

function settingsNote(model, copy) {
  if (model.note === 'changed') return copy.settings.noteChanged;
  if (model.note === 'running') return copy.settings.noteRunning;
  return copy.settings.noteBefore;
}

function calibrationPanel(model, copy, actions) {
  const calibration = model.calibration;
  if (!calibration) return nothing;
  const message = calibration.fitted
    ? fillTemplate(copy.calibration.fitted, calibration.fitted)
    : '';
  return html`<div class="sys-calibration">
    <h3>${copy.calibration.title}</h3>
    <p>${copy.calibration.intro}</p>
    <button data-sys-measure ?disabled=${model.playing} @click=${actions.measurePairs}>
      ${copy.calibration.measure}
    </button>
    <div data-sys-pairs>${calibration.pairs ? pairTable(calibration.pairs, copy) : nothing}</div>
    <button
      data-sys-fit
      ?disabled=${model.playing || !calibration.pairs}
      @click=${actions.fitCamera}
    >
      ${copy.calibration.fit}
    </button>
    <p data-sys-fitmessage role="status">${message}</p>
  </div>`;
}

function pairTable(pairs, copy) {
  return html`<table>
    <caption>
      ${copy.calibration.tableCaption}
    </caption>
    <thead>
      <tr>
        <th>目印</th>
        <th>カメラから<br />d 前, h 上</th>
        <th>根元から<br />x 横, z 高さ</th>
      </tr>
    </thead>
    <tbody>
      ${pairs.map(
        (pair, index) =>
          html`<tr>
            <th>${'①②③'[index] ?? index + 1}</th>
            <td>${pair.camera.x.toFixed(1)}, ${pair.camera.z.toFixed(1)}</td>
            <td>${pair.body.x}, ${pair.body.z}</td>
          </tr>`,
      )}
    </tbody>
  </table>`;
}

function settingsPanel(model, copy, actions) {
  return html`<aside class="card sys-settings" id="${model.course}-settings">
    <h2 data-lesson-cue="action">${copy.settings.title}</h2>
    <form data-sys-form @submit=${actions.submitSettings}>
      <fieldset ?disabled=${model.playing}>
        ${model.topic.controls.map((control) => settingField(model, control, actions))}
      </fieldset>
      <button
        class="primary full"
        type="submit"
        data-sys-run
        ?disabled=${model.playing || model.releaseNeeded}
      >
        ${runButtonLabel(model, copy)}
      </button>
      <p class="muted" data-sys-settingnote>${settingsNote(model, copy)}</p>
    </form>
    <button
      type="button"
      class="full sys-stop-link"
      data-sys-stoplink
      ?hidden=${!model.releaseNeeded}
      @click=${actions.showRestart}
    >
      ${copy.settings.stopLink}
    </button>
    ${calibrationPanel(model, copy, actions)}
    <details class="sys-hint">
      <summary>${copy.settings.hintSummary}</summary>
      <p>${model.topic.hint}</p>
    </details>
    <details data-help-dialog>
      <summary>${copy.settings.mechanismSummary}</summary>
      <h2>${model.topic.label}${copy.settings.mechanismTitleSuffix}</h2>
      <p>${model.topic.explanation}</p>
      <p>${model.real.limit}</p>
    </details>
  </aside>`;
}

function comparisonNote(result, model, copy) {
  if (!result.previous) return copy.results.first;
  if (!result.changed.length) return copy.results.same;
  return copy.results.changed + result.changed.join('、');
}

function manyChangedNote(result, model, copy) {
  if (result.changed.length < 2) return nothing;
  const calibrating = model.course === 'coordination' && model.topic.id === 'calibrate';
  const text = calibrating ? copy.results.calibrateChanged : copy.results.manyChanged;
  return html`<p class="muted">${text}</p>`;
}

function previousMetric(result, index, copy) {
  const before = result.previous?.metrics[index];
  if (!before) return nothing;
  return html`<small>${copy.results.previous}${metricText(before)}</small>`;
}

function resultCard(model, copy) {
  const result = model.result;
  if (!result)
    return html`<section
      class="card sys-result"
      data-sys-result
      hidden
      aria-live="polite"
    ></section>`;
  return html`<section class="card sys-result" data-sys-result aria-live="polite">
    <h2 data-lesson-cue="result">${copy.results.title}</h2>
    <p class="sys-result-outcome">${result.outcome}</p>
    ${result.comparison ? html`<p class="sys-result-compare">${result.comparison}</p>` : nothing}
    <div class="sys-metrics">
      ${result.metrics.map(
        (metric, index) =>
          html`<div>
            <span>${metric.label}</span
            ><strong>${metricText(metric)}</strong>${previousMetric(result, index, copy)}
          </div>`,
      )}
    </div>
    <p>${comparisonNote(result, model, copy)}</p>
    ${manyChangedNote(result, model, copy)}
  </section>`;
}

// Before releasing a latched stop, the learner reads what the robot recorded and picks the cause.
function restartCard(model, copy, actions) {
  const restart = model.restart;
  const cause = restart.cause;
  const options = copy.restart.causes[model.topic.id] ?? copy.restart.causes.default;
  const feedback = () => {
    if (!restart.picked) return '';
    return restart.cleared ? copy.restart.right : copy.restart.wrong;
  };
  return html`<section class="card sys-restart" data-sys-restart ?hidden=${!restart.visible}>
    <h2>${restart.released ? copy.restart.released : copy.restart.held}</h2>
    ${cause ? html`<p class="sys-restart-cause">${cause.sentence}</p>` : nothing}
    <p>${copy.restart.text}</p>
    <fieldset class="sys-cause" ?disabled=${restart.released}>
      <legend>${copy.restart.question}</legend>
      ${options.map(
        ([id, text]) =>
          html`<label class="sys-check"
            ><input
              type="radio"
              name="${model.course}-cause"
              data-sys-cause=${id}
              .checked=${live(restart.picked === id)}
              @change=${() => actions.pickCause(id)}
            /><span>${text}</span></label
          >`,
      )}
    </fieldset>
    <p class="sys-cause-feedback" role="status" ?data-right=${restart.cleared}>${feedback()}</p>
    <button data-sys-release ?disabled=${!restart.releaseEnabled} @click=${actions.release}>
      ${copy.restart.release}
    </button>
    <p data-sys-releasemessage role="status">
      ${restart.messageShown ? copy.restart.releasedMessage : ''}
    </p>
  </section>`;
}

function settingSummary(control, config, copy) {
  if (control.type === 'select')
    return control.options.find(([option]) => option === config[control.key])[1];
  if (control.type === 'check')
    return config[control.key] ? copy.history.checkOn : copy.history.checkOff;
  return config[control.key] + control.unit;
}

function historyRow(run, index, model, copy) {
  const conditions = model.topic.controls.map(
    (control) => `${control.label}：${settingSummary(control, run.config, copy)}`,
  );
  return html`<tr>
    <th>${index + 1}</th>
    <td>${conditions.map((text, i) => html`${i ? html`<br />` : nothing}${text}`)}</td>
    ${run.metrics.map((metric) => html`<td>${metricText(metric)}</td>`)}
  </tr>`;
}

function historyTable(model, copy) {
  if (!model.history.length) return html`<p>${copy.history.empty}</p>`;
  return html`<div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>実験</th>
          <th>使った条件</th>
          ${model.history[0].metrics.map((metric) => html`<th>${metric.label}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${model.history.map((run, index) => historyRow(run, index, model, copy))}
      </tbody>
    </table>
  </div>`;
}

function historyCard(model, copy, actions) {
  return html`<details class="card" data-sys-history>
    <summary>${fillTemplate(copy.history.summary, { count: model.history.length })}</summary>
    <div data-sys-records>${historyTable(model, copy)}</div>
    <button data-sys-csv ?disabled=${!model.completed} @click=${actions.saveCsv}>
      ${copy.history.csv}
    </button>
  </details>`;
}

function realRobotCard(model, copy) {
  const real = model.real;
  return html`<details class="card" data-help-dialog>
    <summary>${copy.realRobot.summary}</summary>
    <h2>${copy.realRobot.title}</h2>
    <p>${real.text}</p>
    <h3>${copy.realRobot.recordTitle}</h3>
    <p>${copy.realRobot.recordNote}</p>
    <code>ros2 bag record ${real.topics}</code>
    <p>${copy.realRobot.csvNote}</p>
    <p>${real.limit}</p>
    ${
      real.url
        ? html`<p>
            <a href=${real.url} target="_blank" rel="noreferrer"
              >${real.source}${copy.realRobot.sourceSuffix}</a
            >
          </p>`
        : nothing
    }
  </details>`;
}

function nextStep(model, copy, actions) {
  const next = model.topics[model.position + 1];
  const last = model.position >= LAST_TOPIC_POSITION;
  return html`<div class="sys-next">
    <p>${last ? copy.next.last : copy.next.more}</p>
    <button class="primary" data-sys-next @click=${actions.next}>
      ${last ? copy.next.quiz : copy.next.nextPrefix + next.label}
    </button>
  </div>`;
}

function systemPage(model, copy, actions) {
  const lessonKey = `${model.course}-${model.topic.id}`;
  return html`<div class="lesson-heading">
      <p class="eyebrow">
        ${model.meta.title} <span class="course-terms">${model.meta.summary}</span>
      </p>
      <h1>${model.topic.title}</h1>
    </div>
    ${chapterNav(model, actions)} ${quickStart(model, copy, actions)}
    ${unsafeHTML(lessonBrief(lessonKey, model.topic) + schoolTips(lessonKey))}
    <div class="sys-workspace">
      ${observationCard(model, copy, actions)} ${settingsPanel(model, copy, actions)}
      ${sideParts(model, copy, 'aside')}
    </div>
    ${resultCard(model, copy)} ${restartCard(model, copy, actions)}
    <div class="sys-bottom">${historyCard(model, copy, actions)} ${realRobotCard(model, copy)}</div>
    ${nextStep(model, copy, actions)}`;
}

export { systemPage, initialChart, chartChoices };
