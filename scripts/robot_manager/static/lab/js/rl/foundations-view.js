import { html, nothing, unsafeHTML } from '../vendor/lit-html.js';
import { formatNumber } from '../core/dom.js';
import { lessonGuide, figureGuide } from '../shell/lesson-guide.js';
import { ACTION_LABELS } from './foundations-core.js';
import { fillSentence } from '../core/content.js';
import { rewardCurveLayout } from './curve-core.js';
import { curveChart } from './curve-view.js';
import { OUTCOME_SYMBOLS } from './outcome-marks.js';
import { questixTopSvg } from '../core/questix-art.js';

// Templates of the reinforcement-learning foundation chapters. Every function is pure: it turns
// the model built by foundations.js into markup. The learner-facing sentences come from
// content/rl/foundations.json (`copy`); only short labels and table headers live here.
//
// index.html owns the containers (#rlControls, #rlFigure, …), so `chapterPanels` returns one
// template per container instead of a single page template.

const DESTINATION_BAR_FULL_SCALE = 4; // points of mean reward that fill a destination bar
const SIGNED_CHART_CENTRE = 50; // percent: where zero sits on a chart that shows negative values
// Points a training run can reach, kept on the curve's axis from the first point on, so the axis
// does not move while the curve grows: arriving from the fixed start earns about 8 × 3.1 + 8.
const CURVE_RANGE = [0, 35];
const FRONT_BEARING = 0.02; // radians within which the goal counts as straight ahead
const DEGREES_PER_RADIAN = 180 / Math.PI;

const format = (value, digits = 1) => formatNumber(value, digits);
const signed = (value, digits = 1) =>
  (value >= 0 ? '+' : '−') + formatNumber(Math.abs(value), digits);
// Fills the {placeholders} of a sentence from content/rl/foundations.json. Shared with
// foundations.js, which builds the status line; js/core is outside this course to extend.

const helpDetails = (title, body) =>
  html`<details>
    <summary>${title}</summary>
    <p>${body}</p>
  </details>`;
// A word defined where it is first used: tapping it opens its meaning in place.
const termChip = (term) =>
  html`<details class="rl-term">
    <summary>${term.term}</summary>
    <span>${term.definition}</span>
  </details>`;

function termList(keys, copy) {
  return html`<div class="rl-terms">
    <span>${copy.termsLabel}</span>${keys.map((key) => termChip(copy.terms[key]))}
  </div>`;
}

// The result of the last press, right under the buttons, so a phone shows it without scrolling.
const pressResult = (text, id) =>
  html`<p id=${id} class="rl-press-result" role="status" ?hidden=${!text}>${text}</p>`;

const dialogDetails = (title, paragraphs) =>
  html`<details data-help-dialog>
    <summary>${title}</summary>
    ${paragraphs.map((paragraph) => html`<p>${paragraph}</p>`)}
  </details>`;

// Small pictograms that stand in for the parcel, the corridor, the goal and the robot itself. The
// robot is the CAD top view (js/core/questix-art.js), front up.
const ICON_HEADING_UP = -90; // degrees
const ICONS = {
  parcel: html`<svg viewBox="0 0 72 66" aria-hidden="true" focusable="false">
    <path d="M22 24L36 17L50 24V44L36 51L22 44Z" fill="#f4d8a3" stroke="#ac7a30" stroke-width="2" />
    <path
      d="M22 24L36 31L50 24M36 31V51M29 20L43 27"
      fill="none"
      stroke="#ac7a30"
      stroke-width="2"
    />
  </svg>`,
  road: html`<svg viewBox="0 0 72 66" aria-hidden="true" focusable="false">
    <path d="M18 8V58M54 8V58" stroke="#9eb4bd" stroke-width="3" />
    <path d="M36 8V15M36 51V58" stroke="#9eb4bd" stroke-width="2" />
    ${questixTopSvg(36, 33, ICON_HEADING_UP, 28)}
  </svg>`,
  goal: html`<svg viewBox="0 0 72 66" aria-hidden="true" focusable="false">
    <path d="M23 55V10L53 10L46 22L53 34H23" fill="#e6f1ed" stroke="#39776e" stroke-width="2" />
    <path d="M31 21L36 26L44 17" fill="none" stroke="#39776e" stroke-width="3" />
    <path d="M15 56H37" stroke="#39776e" stroke-width="2" />
  </svg>`,
  robot: html`<svg viewBox="0 0 72 66" aria-hidden="true" focusable="false">
    ${questixTopSvg(36, 34, ICON_HEADING_UP, 50)}
  </svg>`,
};

// ---------------------------------------------------------------- navigation

function groupsNav(model, copy, actions) {
  return html`${copy.groups.map(
    (name, index) =>
      html`<button
        data-rl-group=${index}
        aria-pressed=${String(index === model.group)}
        .disabled=${model.busy}
        @click=${() => actions.openGroup(index)}
      >
        ${name}
      </button>`,
  )}`;
}

function topicsNav(model, actions) {
  return html`${model.groupTopics.map(
    (topic) =>
      html`<button
        data-rl-topic=${topic.id}
        aria-pressed=${String(topic.id === model.topic)}
        .disabled=${model.busy}
        @click=${() => actions.openTopic(topic.id)}
      >
        ${topic.label}
      </button>`,
  )}`;
}

// ------------------------------------------------------- shared result parts

// How a single evaluation run ended: the short form names the run in the list of twenty, the long
// form reads as a sentence opener under the map.
const runOutcome = (run, copy) => {
  if (run.success) return OUTCOME_SYMBOLS.arrived + ' ' + copy.results.arrived;
  if (run.hit) return OUTCOME_SYMBOLS.contact + ' ' + copy.results.contact;
  return OUTCOME_SYMBOLS.timeout + ' ' + copy.results.timeout;
};

const runEnding = (run, copy) => {
  if (run.success) return copy.results.arrived;
  return run.hit ? copy.results.contactEnded : copy.results.timeout;
};

const meanTimeLabel = (meanTime) => (meanTime === null ? '—' : format(meanTime) + '秒');

function resultMetrics(result, copy) {
  return [
    [copy.results.arrived, `${result.successes} / ${result.runs.length}回`],
    [copy.results.contact, `${result.contacts} / ${result.runs.length}回`],
    [
      '到着できた走行の平均時間',
      result.meanTime === null ? copy.results.noArrival : format(result.meanTime) + '秒',
    ],
  ];
}

// Two labelled result rows side by side; `earlier` is missing until a second run exists.
function recordTable(earlier, later, copy) {
  if (!earlier) return nothing;
  const row = (result) =>
    html`<tr>
      <th>${result.label}</th>
      <td>${result.successes}/${result.runs.length}</td>
      <td>${result.contacts}/${result.runs.length}</td>
      <td>${meanTimeLabel(result.meanTime)}</td>
    </tr>`;
  return html`<div class="rl-table-wrap">
    <table>
      <caption>
        ${copy.results.tableCaption}
      </caption>
      <thead>
        <tr>
          <th>条件</th>
          <th>到着</th>
          <th>接触</th>
          <th>到着した走行の平均時間</th>
        </tr>
      </thead>
      <tbody>
        ${row(earlier)}${row(later)}
      </tbody>
    </table>
  </div>`;
}

// ------------------------------------------------------------- action values

// Position of one bar on the track, in percent.
function barGeometry(value, limit, signedScale) {
  const width = (Math.abs(value) / limit) * (signedScale ? SIGNED_CHART_CENTRE : 100);
  if (!signedScale) return { left: 0, width };
  return { left: value < 0 ? SIGNED_CHART_CENTRE - width : SIGNED_CHART_CENTRE, width };
}

function valueBar(value, limit, signedScale, previous) {
  const { left, width } = barGeometry(value, limit, signedScale);
  const classes = [previous ? 'is-previous' : '', value < 0 ? 'is-negative' : '']
    .filter(Boolean)
    .join(' ');
  return html`<i class=${classes} style="left:${left}%;width:${width}%"></i>`;
}

function chartRow({ label, value, caption, previous }, limit, signedScale) {
  const changed = previous !== undefined && previous !== value;
  return html`<div>
    <span>${label}</span>
    <div>
      <div class=${signedScale ? 'rl-value-track signed' : 'rl-value-track'}>
        ${changed ? valueBar(previous, limit, signedScale, true) : nothing}${valueBar(
          value,
          limit,
          signedScale,
          false,
        )}
      </div>
      <small>${caption}</small>
    </div>
    <strong>${format(value, 2)}</strong>
  </div>`;
}

// The longest bar is the largest estimate on screen (before or after this step), so even small
// estimates such as 0.29 or −0.01 are visible; the scale is written under the bars.
function valueLimit(rows) {
  const sizes = rows.flatMap((row) => [row.value, row.previous ?? 0]).map(Math.abs);
  const largest = Math.max(...sizes);
  return largest > 0 ? largest : 1;
}

// Bars for the estimated value of every action, with the value before this step as a faint
// dotted bar. Negative estimates grow to the left of a centre line, so the scale is only split
// in two when some value is actually negative.
function valueChart(rows, copy) {
  const signedScale = rows.some((row) => row.value < 0 || row.previous < 0);
  const limit = valueLimit(rows);
  return html`<div class="rl-value-chart">
      ${rows.map((row) => chartRow(row, limit, signedScale))}
    </div>
    <p class="helper rl-value-scale">
      ${fillSentence(copy.chart.valueScale, { limit: format(limit, 2) })}
      ${signedScale ? copy.chart.signedScaleNote : ''}
    </p>`;
}

// ------------------------------------------------- chapter "experience" (行動と報酬)

function bearingLabel(bearing) {
  if (Math.abs(bearing) < FRONT_BEARING) return '正面';
  const side = bearing > 0 ? '右 ' : '左 ';
  return side + format(Math.abs(bearing) * DEGREES_PER_RADIAN, 0) + '°';
}

function experiencePress(chapter, text) {
  const event = chapter.event;
  if (!event) return '';
  return fillSentence(text.pressResult, {
    action: event.actionLabel,
    from: format(event.fromDistance, 2),
    to: format(event.toDistance, 2),
    reward: signed(event.reward, 2),
  });
}

function experienceControls(chapter, copy, actions) {
  const text = copy.experience;
  // The buttons come right after the title, so on a phone they sit just under the map they move.
  return html`<p class="eyebrow">${text.eyebrow}</p>
    <h2>${text.controlsTitle}</h2>
    <div class="rl-action-buttons">
      ${ACTION_LABELS.map(
        (label, action) =>
          html`<button
            id=${'rlAction' + action}
            class="full"
            .disabled=${chapter.finished}
            @click=${() => actions.act(action)}
          >
            ${label}
          </button>`,
      )}
    </div>
    ${pressResult(experiencePress(chapter, text), 'rlActionResult')}
    <button
      id="rlAuto"
      class="primary full"
      .disabled=${chapter.finished}
      @click=${actions.actAutomatically}
    >
      ロボットに1回選ばせる
    </button>
    <button id="rlRestart" class="full" @click=${actions.restart}>出発点に戻す</button>
    <p class="helper rl-turn-note">${text.turnNote}</p>
    <p>${text.controlsIntro}</p>
    ${termList(['estimate', 'policy'], copy)}
    <p class="helper">${text.controlsNote}</p>
    ${helpDetails(text.whyTitle, text.why)}${helpDetails(text.observationTitle, text.observation)}
    <button id="rlForget" class="full" @click=${actions.forget}>
      学んだ記録も消してやり直す
    </button>`;
}

function experienceExplanation(chapter, copy) {
  const text = copy.experience;
  const event = chapter.event;
  if (!event) return nothing;
  const before = format(event.change.before, 2);
  const after = format(event.change.after, 2);
  const valueChanged = fillSentence(before === after ? text.valueUnchanged : text.valueChanged, {
    before,
    after,
  });
  return html`<h3>${text.eventTitle}</h3>
    <p>
      距離 ${format(event.fromDistance, 2)} m → <strong>${event.actionLabel}</strong> → 距離
      ${format(event.toDistance, 2)} m →
      <strong>${signed(event.reward, 2)}点</strong>。${event.movement}${valueChanged}
    </p>`;
}

function experienceExtra(chapter, copy) {
  const text = copy.experience;
  const event = chapter.event;
  if (!event) return nothing;
  const rows = ACTION_LABELS.map((label, action) => ({
    label,
    value: event.values[action],
    previous: event.previousValues[action],
    caption: action === event.action ? text.updatedAction : text.unchangedAction,
  }));
  const wheels = fillSentence(text.wheels, {
    left: format(event.rpm[0], 0),
    right: format(event.rpm[1], 0),
  });
  // Open from the start: the estimates are what the robot learned from this step.
  return html`<details open>
    <summary>${text.wheelsTitle}</summary>
    ${valueChart(rows, copy)}
    <p class="helper">${text.valuesNote}</p>
    <p>${wheels}</p>
  </details>`;
}

function experienceMetrics(chapter) {
  return [
    ['届け先までの距離', format(chapter.distance, 2) + ' m'],
    ['機体から見た方向', bearingLabel(chapter.bearing)],
  ];
}

// ------------------------------------------------------ chapter "explore" (未経験の配達先)

function destinationCard(index, chapter, text) {
  const value = chapter.values[index];
  const count = chapter.counts[index];
  const letter = text.destinations[index];
  const barWidth = (value / DESTINATION_BAR_FULL_SCALE) * 100;
  return html`<article
    class=${index === chapter.best ? 'rl-destination is-best' : 'rl-destination'}
  >
    <header>
      <span class="rl-destination-letter">${letter}</span><span>配達先 ${letter}</span>
    </header>
    ${ICONS.parcel}
    <span class="rl-score-label">${count ? text.meanScore : text.untried}</span>
    <strong class="rl-destination-score"
      >${count ? html`${format(value)}<small>点</small>` : '？'}</strong
    >
    <div class="rl-destination-bar"><i style="width:${barWidth}%"></i></div>
    <span class="rl-destination-count">${count}回の経験</span>
  </article>`;
}

function batchItem(delivery, text) {
  const letter = text.destinations[delivery.action];
  const how = delivery.exploring ? text.chosenRandomly : text.chosenByMean;
  return html`<li
    class=${delivery.exploring ? 'is-exploring' : ''}
    aria-label=${`配達先${letter}、${delivery.reward}点、${how}`}
  >
    <b>${letter}</b><span>${delivery.reward}点</span>${
      delivery.exploring ? html`<i aria-hidden="true">＊</i>` : nothing
    }
  </li>`;
}

function batchRecord(chapter, text) {
  if (!chapter.batch.length) return html`<p>${text.recordEmpty}</p>`;
  return html`<ol class="rl-batch-record">
      ${chapter.batch.map((delivery) => batchItem(delivery, text))}
    </ol>
    <p class="rl-record-key">${text.recordKey}</p>`;
}

function choiceMix(exploration) {
  const byMean = (1 - exploration) * 100;
  const atRandom = exploration * 100;
  return html`<div class="rl-mix-bar" aria-hidden="true">
      <i style="width:${byMean}%"></i><i style="width:${atRandom}%"></i>
    </div>
    <p>平均点で選ぶ ${Math.round(byMean)}% <span>ランダム ${Math.round(atRandom)}%</span></p>`;
}

function explorePress(chapter, text) {
  if (!chapter.batch.length) return '';
  const counts = text.destinations.map(
    (letter, index) =>
      letter + ' ' + chapter.batch.filter((delivery) => delivery.action === index).length + '回',
  );
  const total = chapter.batch.reduce((sum, delivery) => sum + delivery.reward, 0);
  return fillSentence(text.pressResult, {
    count: chapter.batch.length,
    mix: counts.join('・'),
    total,
  });
}

function exploreControls(chapter, copy, actions) {
  const text = copy.explore;
  return html`<h2>${text.controlsTitle}</h2>
    <label class="vision-select"
      >どう選ばせる？<select
        id="rlExploreRate"
        .value=${String(chapter.exploration)}
        @change=${(event) => actions.setExploration(Number(event.target.value))}
      >
        <option value="0">平均点が高い先だけを選ぶ</option>
        <option value="0.3">ときどきランダムにも試す</option>
        <option value="1">毎回ランダムに選ぶ</option>
      </select></label
    >
    <div id="rlChoiceMix" class="rl-choice-mix">${choiceMix(chapter.exploration)}</div>
    <button id="rlTryTen" class="primary full" @click=${actions.deliverBatch}>
      10回配達させる
    </button>
    ${pressResult(explorePress(chapter, text), 'rlExploreResult')}
    <p id="rlExploreNext" class="rl-next-instruction">${chapter.nextHint}</p>
    <div class="rl-secondary-actions">
      <button id="rlTryOne" class="full" @click=${actions.deliverOnce}>1回だけ試す</button
      ><button id="rlRouteReset" class="full" @click=${actions.resetDestinations}>
        記録を消してやり直す
      </button>
    </div>
    ${dialogDetails(text.rulesTitle, text.rules)}`;
}

function exploreFigure(chapter, copy) {
  const text = copy.explore;
  const title = chapter.batch.length
    ? `今回の${chapter.batch.length}回で選んだ先と点数`
    : text.recordTitle;
  return html`<div class="rl-destination-board">
    <p class="rl-board-caption">${text.boardCaption}</p>
    <div class="rl-destination-cards">
      ${chapter.values.map((_, index) => destinationCard(index, chapter, text))}
    </div>
    <div class="rl-batch">
      <h3>${title}</h3>
      ${batchRecord(chapter, text)}
    </div>
  </div>`;
}

function exploreExtra(chapter, copy) {
  const text = copy.explore;
  const paragraphs = [...text.singleScore, text.totalPrefix + chapter.total + '点。'];
  return dialogDetails(text.singleScoreTitle, paragraphs);
}

function exploreMetrics(chapter, copy) {
  const text = copy.explore;
  const best = chapter.best < 0 ? text.unknownBest : `配達先 ${text.destinations[chapter.best]}`;
  return [
    ['配達した回数', chapter.deliveries + '回'],
    ['今の記録から選ぶなら', best],
  ];
}

// ------------------------------------------------------- chapter "future" (後でもらう報酬)

function futureControls(copy, actions) {
  const text = copy.future;
  return html`<h2>${text.controlsTitle}</h2>
    <p>${text.controlsIntro}</p>
    <button id="rlFutureTrain" class="primary full" @click=${actions.learnFutureBatch}>
      学習させて比べる
    </button>
    <p class="rl-next-instruction">${text.trainNote}</p>
    <div class="rl-secondary-actions">
      <button id="rlFutureOne" class="full" @click=${actions.learnFutureOnce}>
        1回ずつ学習させる</button
      ><button id="rlFutureReset" class="full" @click=${actions.resetFuture}>
        両方の記録を消してやり直す
      </button>
    </div>
    ${dialogDetails(text.whyTitle, text.why)}`;
}

function choiceCard(card, chapter, text) {
  const choice = card.choice === 'delivery' ? text.delivery : text.quickJob;
  const icon = chapter.trained && card.choice === 'delivery' ? ICONS.goal : ICONS.robot;
  return html`<article
    class=${card.gamma ? 'rl-learning-result looks-ahead' : 'rl-learning-result'}
    data-future-gamma=${card.gamma}
  >
    <h3>${card.title}</h3>
    <div class="rl-result-choice">
      ${icon}
      <div>
        <span>${text.choiceLabel}</span
        ><strong>${chapter.trained ? choice : text.notTrained}</strong>
      </div>
    </div>
  </article>`;
}

function futureFigure(chapter, copy) {
  const text = copy.future;
  const experience = chapter.trained ? `それぞれ${chapter.episodes}回の経験` : text.untrained;
  return html`<div class="rl-future-board">
    <h3 class="rl-board-caption">${text.boardCaption}</h3>
    <div class="rl-work-options">
      <div class="rl-quick-job">
        ${ICONS.parcel}<strong>${text.quickJob}</strong
        ><span class="rl-reward-pill">1点で終了</span>
      </div>
      <div class="rl-long-job">
        <strong>${text.delivery}</strong>
        <ol class="rl-job-stages">
          <li>${ICONS.parcel}<span>荷物を受け取る</span><b>0点</b></li>
          <li>${ICONS.road}<span>通路を進む</span><b>0点</b></li>
          <li>${ICONS.goal}<span>届ける</span><b class="rl-reward-pill">8点で終了</b></li>
        </ol>
      </div>
    </div>
    <div class="rl-results-heading">
      <h3>${text.resultsTitle}</h3>
      <span>${experience}</span>
    </div>
    <div class="rl-learning-results">
      ${chapter.cards.map((card) => choiceCard(card, chapter, text))}
    </div>
  </div>`;
}

function futureExtra(chapter, copy) {
  const text = copy.future;
  return html`<details data-help-dialog>
    <summary>${text.valuesTitle}</summary>
    <p>${text.valuesIntro}</p>
    <div class="rl-table-wrap">
      <table>
        <thead>
          <tr>
            <th>行動</th>
            <th>すぐ後だけ</th>
            <th>その先も含める</th>
          </tr>
        </thead>
        <tbody>
          ${chapter.valueRows.map(
            (row) =>
              html`<tr>
                <th>${row.label}</th>
                <td>${format(row.immediate, 2)}</td>
                <td>${format(row.lookAhead, 2)}</td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>
    ${text.valuesNotes.map((note) => html`<p>${note}</p>`)}
  </details>`;
}

// ---------------------------------------------------------- chapter "test" (学習とテスト)

const placeName = (startMode, copy) =>
  startMode === 'fixed' ? copy.test.placeFixed : copy.test.placeVaried;

// Mean reward per 50 training runs of the model being trained (or the last one), with the model
// trained before it as a grey dotted line.
function learningCurve(curve, copy) {
  const text = copy.chart;
  const lines = [];
  if (curve.previous)
    lines.push({
      role: 'previous',
      label: fillSentence(text.previousLine, { place: placeName(curve.previous.startMode, copy) }),
      rewards: curve.previous.rewards,
    });
  if (curve.current)
    lines.push({
      role: 'actual',
      label: fillSentence(text.currentLine, { place: placeName(curve.current.startMode, copy) }),
      rewards: curve.current.rewards,
    });
  const layout = rewardCurveLayout(lines, curve.total, CURVE_RANGE);
  return html`<div id="rlCurve" class="rl-curve-wrap">
    ${curveChart(layout, {
      title: text.curveTitle,
      yTitle: text.curveY,
      xTitle: text.curveX,
      unit: '点',
      empty: text.curveEmpty,
      ariaLabel: text.curveTitle,
    })}
    <p class="helper">${text.curveNote}</p>
  </div>`;
}

function testPress(chapter, copy) {
  const text = copy.test;
  if (chapter.training) return fillSentence(text.pressTraining, chapter.training);
  if (chapter.result)
    return fillSentence(text.pressResult, {
      successes: chapter.result.successes,
      contacts: chapter.result.contacts,
      runs: chapter.result.runs.length,
    });
  return chapter.hasModel ? text.pressTrained : '';
}

function testControls(chapter, model, copy, actions) {
  const text = copy.test;
  return html`<p class="eyebrow">${text.eyebrow}</p>
    <h2>${text.controlsTitle}</h2>
    <p>${text.controlsIntro}</p>
    ${termList(['model'], copy)}
    <label class="vision-select"
      >学習の開始位置<select
        id="rlTrainMode"
        .value=${chapter.mode}
        .disabled=${model.busy}
        @change=${(event) => actions.setTrainMode(event.target.value)}
      >
        <option value="fixed">毎回、同じ位置・向き</option>
        <option value="varied">毎回、異なる位置・向き</option>
      </select></label
    >
    <button
      id="rlTrainModel"
      class="primary full"
      .disabled=${model.busy}
      @click=${actions.trainTestModel}
    >
      この条件で800回学習する
    </button>
    <button
      id="rlTestModel"
      class="full"
      .disabled=${model.busy || !chapter.hasModel}
      @click=${actions.runTest}
    >
      学習済みの動きを20か所でテスト
    </button>
    ${pressResult(testPress(chapter, copy), 'rlTestResult')}
    <p class="helper">${text.controlsNote}</p>
    ${helpDetails(text.differenceTitle, text.difference)}
    ${helpDetails(text.generalisationTitle, text.generalisation)}`;
}

// The three start marks of the test map, in the same symbols as the list of runs.
function testMapKey(chapter, copy) {
  if (!chapter.result) return nothing;
  const text = copy.results;
  return html`<p class="rl-map-key">
    <span data-outcome="arrived">${OUTCOME_SYMBOLS.arrived} ${text.arrived}</span
    ><span data-outcome="contact">${OUTCOME_SYMBOLS.contact} ${text.contact}</span
    ><span data-outcome="timeout">${OUTCOME_SYMBOLS.timeout} ${text.timeout}</span
    ><span data-outcome="selected">◯ ${text.selected}</span>
  </p>`;
}

function testExplanation(chapter, copy) {
  if (!chapter.result) return nothing;
  const run = chapter.result.runs[chapter.index];
  return html`<h3>表示中：テスト ${chapter.index + 1} / ${chapter.result.runs.length}</h3>
    <p>${runEnding(run, copy)}・${format(run.time)}秒。${copy.test.runNote}</p>`;
}

function testExtra(chapter, copy, actions) {
  if (!chapter.result) return nothing;
  const runs = chapter.result.runs;
  return html`<label class="vision-select"
      >確認する走行<select
        id="rlTrial"
        @change=${(event) => actions.showTrial(Number(event.target.value))}
      >
        ${runs.map(
          (run, index) =>
            html`<option value=${index} .selected=${index === chapter.index}>
              ${index + 1}回目 · ${runOutcome(run, copy)}
            </option>`,
        )}
      </select></label
    >
    ${recordTable(chapter.previous, chapter.result, copy)}`;
}

function testMetrics(chapter, copy) {
  if (chapter.result) return resultMetrics(chapter.result, copy);
  const trained = chapter.trainedModel;
  const place = trained?.startMode === 'fixed' ? copy.test.placeFixed : copy.test.placeVaried;
  return [
    ['学習済みモデル', trained ? `${trained.episodes}回 · ${place}` : copy.results.noModel],
    ['テスト', copy.results.notRun],
  ];
}

// ------------------------------------------------------ chapter "transfer" (実機との違い)

const timeText = (seconds) => (seconds === null ? '—' : format(seconds));

function transferPress(chapter, copy) {
  const text = copy.transfer;
  if (chapter.training) return fillSentence(copy.test.pressTraining, chapter.training);
  if (!chapter.result) return chapter.hasModel ? text.pressTrained : '';
  const { normal, changed } = chapter.result;
  return fillSentence(text.pressResult, {
    normal: normal.successes,
    changed: changed.successes,
    normalTime: timeText(normal.meanTime),
    changedTime: timeText(changed.meanTime),
  });
}

function transferControls(chapter, model, copy, actions) {
  const text = copy.transfer;
  return html`<p class="eyebrow">${text.eyebrow}</p>
    <h2>${text.controlsTitle}</h2>
    <p>${text.controlsIntro}</p>
    ${termList(['model', 'policy'], copy)}
    <button
      id="rlTransferTrain"
      class=${chapter.hasModel ? 'full' : 'primary full'}
      .disabled=${model.busy}
      @click=${actions.trainTransferModel}
    >
      通常の車輪で学習する
    </button>
    <label class="basics-slider" for="rlWheelGain"
      ><span
        >左車輪の実際の移動量<output id="rlWheelGainValue">${chapter.gainPercent}%</output></span
      ><input
        id="rlWheelGain"
        type="range"
        min="40"
        max="120"
        step="10"
        .value=${String(chapter.gainPercent)}
        @input=${(event) => actions.setWheelGain(Number(event.target.value))}
    /></label>
    <button
      id="rlTransferTest"
      class="primary full"
      .disabled=${model.busy || !chapter.hasModel}
      @click=${actions.runTransferTest}
    >
      同じモデルで通常・変更後をテスト
    </button>
    ${pressResult(transferPress(chapter, copy), 'rlTransferResult')}
    <button
      id="rlTransferRetrain"
      class="full"
      .disabled=${model.busy || !chapter.hasModel}
      @click=${actions.retrainWithVariedWheels}
    >
      車輪のばらつきを含めて学び直す
    </button>
    <p class="helper">${text.gainNote}</p>
    ${helpDetails(text.retrainTitle, text.retrain)}${helpDetails(text.scopeTitle, text.scope)}`;
}

function transferFigure(chapter, copy) {
  const text = copy.transfer;
  if (!chapter.result)
    return html`<canvas id="rlRobotMap" role="img" aria-label=${text.mapLabel}></canvas>`;
  const firstRun = (result) => {
    const run = result.runs[0];
    return runEnding(run, copy) + ' ' + format(run.time) + '秒';
  };
  return html`<div class="rl-transfer-plots">
    <figure>
      <figcaption>
        通常の車輪 · 左右100%<br /><strong>${firstRun(chapter.result.normal)}</strong>
      </figcaption>
      <canvas id="rlNormalMap" role="img" aria-label=${text.normalMapLabel}></canvas>
    </figure>
    <figure>
      <figcaption>
        変更後 · 左${Math.round(chapter.result.gain * 100)}%<br /><strong
          >${firstRun(chapter.result.changed)}</strong
        >
      </figcaption>
      <canvas id="rlChangedMap" role="img" aria-label=${text.changedMapLabel}></canvas>
    </figure>
  </div>`;
}

function transferExplanation(chapter, copy) {
  if (!chapter.result) return nothing;
  const text = copy.transfer;
  return html`<h3>${text.resultTitle}</h3>
    <p>${fillSentence(text.resultText, { label: chapter.result.label })}</p>`;
}

function transferExtra(chapter, copy) {
  const text = copy.transfer;
  const ros = helpDetails(text.rosTitle, text.ros);
  if (!chapter.result) return ros;
  const result = chapter.result;
  const normal = { ...result.normal, label: text.normalWheels };
  const changed = { ...result.changed, label: text.changedWheels };
  const comparable = chapter.previous && chapter.previous.gain === result.gain;
  const retrained = comparable
    ? recordTable(
        { ...chapter.previous.changed, label: text.beforeRetrain },
        { ...result.changed, label: text.afterRetrain },
        copy,
      )
    : nothing;
  return html`${recordTable(normal, changed, copy)}${retrained}${ros}`;
}

function transferMetrics(chapter, copy) {
  if (chapter.result) return resultMetrics(chapter.result.changed, copy);
  const text = copy.transfer;
  const trained = chapter.variedWheels ? text.modelVaried : text.modelNormal;
  return [
    ['学習済みモデル', chapter.hasModel ? trained : copy.results.noModel],
    ['通常・変更後の比較', copy.results.notRun],
  ];
}

// -------------------------------------------------------------------- panels

// The situation/purpose brief and the two figure guides, written by shell/lesson-guide.js as
// ready-made HTML.
function lessonGuides(model) {
  const key = 'rl-' + model.topic;
  return {
    rlLessonBrief: unsafeHTML(lessonGuide(key)),
    rlFigureGuide: unsafeHTML(figureGuide(key)),
    rlRewardFigureGuide: unsafeHTML(figureGuide('rl-reward')),
  };
}

function question(text) {
  return html`<h2>${text.title}</h2>
    <p>${text.text}</p>
    ${helpDetails('考えるためのヒント', text.hint)}`;
}

function metricsPanel(items) {
  return html`${items.map(
    ([label, value]) => html`<div><span>${label}</span><strong>${value}</strong></div>`,
  )}`;
}

function chapterControls(model, copy, actions) {
  const chapter = model.chapter;
  if (chapter.kind === 'experience') return experienceControls(chapter, copy, actions);
  if (chapter.kind === 'explore') return exploreControls(chapter, copy, actions);
  if (chapter.kind === 'future') return futureControls(copy, actions);
  if (chapter.kind === 'test') return testControls(chapter, model, copy, actions);
  return transferControls(chapter, model, copy, actions);
}

function chapterFigure(model, copy) {
  const chapter = model.chapter;
  if (chapter.kind === 'experience')
    return html`<canvas
      id="rlRobotMap"
      role="img"
      aria-label=${copy.experience.mapLabel}
    ></canvas>`;
  if (chapter.kind === 'explore') return exploreFigure(chapter, copy);
  if (chapter.kind === 'future') return futureFigure(chapter, copy);
  if (chapter.kind === 'test')
    return html`<canvas id="rlRobotMap" role="img" aria-label=${copy.test.mapLabel}></canvas>
      ${testMapKey(chapter, copy)}${learningCurve(chapter.curve, copy)}`;
  return transferFigure(chapter, copy);
}

function chapterMetrics(model, copy) {
  const chapter = model.chapter;
  if (chapter.kind === 'experience') return experienceMetrics(chapter);
  if (chapter.kind === 'explore') return exploreMetrics(chapter, copy);
  if (chapter.kind === 'future') return [];
  if (chapter.kind === 'test') return testMetrics(chapter, copy);
  return transferMetrics(chapter, copy);
}

function chapterExplanation(model, copy) {
  const chapter = model.chapter;
  if (chapter.kind === 'experience') return experienceExplanation(chapter, copy);
  if (chapter.kind === 'test') return testExplanation(chapter, copy);
  if (chapter.kind === 'transfer') return transferExplanation(chapter, copy);
  return nothing;
}

function chapterExtra(model, copy, actions) {
  const chapter = model.chapter;
  if (chapter.kind === 'experience') return experienceExtra(chapter, copy);
  if (chapter.kind === 'explore') return exploreExtra(chapter, copy);
  if (chapter.kind === 'future') return futureExtra(chapter, copy);
  if (chapter.kind === 'test') return testExtra(chapter, copy, actions);
  return transferExtra(chapter, copy);
}

// The figure caption normally names the chapter's step; after one experience step it reports what
// that step earned instead.
function figureStep(model, copy) {
  const chapter = model.chapter;
  if (chapter.kind === 'experience' && chapter.event)
    return `今回の報酬 ${signed(chapter.event.reward, 2)}点 · ${chapter.event.actionLabel}`;
  return copy.topics.find((topic) => topic.id === model.topic).subtitle;
}

// One template per container of #rlFoundationLesson. `question` is null in the chapters that hide
// the question card.
function chapterPanels(model, copy, actions) {
  const topic = copy.topics.find((entry) => entry.id === model.topic);
  const text = copy[model.topic];
  return {
    rlFigureTitle: topic.title,
    rlFigureStep: figureStep(model, copy),
    rlControls: chapterControls(model, copy, actions),
    rlFigure: chapterFigure(model, copy),
    rlMetrics: metricsPanel(chapterMetrics(model, copy)),
    rlObservation: model.status,
    rlExplanation: chapterExplanation(model, copy),
    rlExtra: chapterExtra(model, copy, actions),
    rlQuestion: text.question ? question(text.question) : null,
  };
}

export { groupsNav, topicsNav, lessonGuides, chapterPanels };
