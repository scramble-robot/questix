import { html, nothing, unsafeHTML } from '../vendor/lit-html.js';
import { formatNumber } from '../core/dom.js';
import { lessonLabel } from '../shell/lesson-ui.js';
import { schoolTips } from '../shell/school-tips.js';
import { lessonBrief } from '../shell/lesson-brief.js';
import { PLAN_TOPICS } from './core.js';

// Templates of the path-planning course. Every function is pure: it turns the model built by
// ui.js (current topic, experiment state, playback) into markup. Learner-facing sentences come
// from content/planning.json (`copy`); only short labels live here.

const GAP_BAR_FULL_SCALE = 0.4; // metres of clearance that fill the comparison bar
const ALGORITHM_LABELS = { astar: 'A*', dijkstra: 'ダイクストラ' };

const gapLabel = (metres) => (metres < 0.01 ? '1 cm未満' : formatNumber(metres * 100, 0) + ' cm');
const moved = (run) => run.samples.length > 1;

function topicNav(model, actions) {
  return html`<nav class="basics-topics basics-groups planning-topics" aria-label="学ぶ順序">
    ${PLAN_TOPICS.map(
      (topic, index) =>
        html`<button
          data-planning-topic=${topic.id}
          aria-pressed=${String(topic.id === model.topic)}
          @click=${() => actions.openTopic(topic.id)}
        >
          <span>${index + 1}</span>${topic.label}
        </button>`,
    )}
  </nav>`;
}

function playButtonLabel({ playing, awaitingNewPlan, atEnd, run }) {
  if (playing) return 'Ⅱ 一時停止';
  if (awaitingNewPlan) return '▶ 新しい道で走る';
  return run && !atEnd ? '▶ 続きから見る' : '▶ 最初から見る';
}

function runButtonLabel(model, topicCopy) {
  if (model.playing) return '走行中…';
  if (!model.resumable) return topicCopy.runLabel;
  return model.awaitingNewPlan ? '新しい道で走る' : '続きから見る';
}

function actionHint(model, copy, topicCopy) {
  if (!model.resumable) return topicCopy.runHint;
  return model.playing ? copy.playback.hintPlaying : copy.playback.hintPaused;
}

function timeLabel({ sample, playing, finished }) {
  if (!sample) return '実験前';
  const phase = playing ? '走行中' : finished ? '走行終了' : '一時停止';
  return `${phase} · ${formatNumber(sample.t)} 秒`;
}

function readings(sample, copy) {
  if (!sample) return copy.playback.readingsIdle;
  return `左の車輪 ${formatNumber(sample.left, 0)} rpm　右の車輪 ${formatNumber(sample.right, 0)} rpm　移動 ${formatNumber(sample.travel, 2)} m`;
}

function mapCard(model, copy, topicCopy, actions) {
  const drawing = model.topic === 'draw';
  return html`<section class="card">
    <div class="section-top">
      <h2>予定した道と、実際の動き</h2>
      <span id="planningTime">${timeLabel(model)}</span>
    </div>
    <canvas
      id="planningCanvas"
      width="720"
      height="500"
      tabindex="0"
      role="img"
      aria-label=${'棚のある部屋の地図。スタートは左、目的地は右。' + topicCopy.mapLabel}
      @click=${drawing ? actions.clickMap : nothing}
      @keydown=${drawing ? actions.keyOnMap : nothing}
    ></canvas>
    <div class="planning-legend">
      <span class="planning-planned">予定した道</span><span class="planning-actual">走った軌跡</span
      ><span>円：直径36 cmの機体が占める範囲</span>
    </div>
    <div class="planning-playbar">
      <button id="planningPlay" ?disabled=${!model.canPlay} @click=${actions.togglePlay}>
        ${playButtonLabel(model)}
      </button>
      <label for="planningSeek" class="sr-only">確認する時刻（観察済みの範囲）</label>
      <input
        id="planningSeek"
        type="range"
        min="0"
        max=${model.observed}
        value="0"
        .value=${String(model.index)}
        ?disabled=${!model.run}
        @input=${(event) => actions.seek(Number(event.target.value))}
      />
      <label
        >再生速度<select
          id="planningSpeed"
          .value=${String(model.speed)}
          @change=${(event) => actions.setSpeed(Number(event.target.value))}
        >
          <option value="1">1倍</option>
          <option value="2">2倍</option>
          <option value="4">4倍</option>
        </select></label
      >
    </div>
    <p id="planningReadings" class="planning-readings">${readings(model.sample, copy)}</p>
    <p id="planningStatus" class="planning-status" role="status">${model.status}</p>
    <details class="planning-map-help">
      <summary>地図の見方</summary>
      <p>${topicCopy.brief.figure}</p>
      ${drawing ? html`<p>${copy.playback.keyboardHelp}</p>` : nothing}
    </details>
  </section>`;
}

function drawControls(copy, actions) {
  return html`<p>${copy.controls.drawIntro}</p>
    <div class="planning-edit">
      <button id="planningEdit" @click=${actions.redraw}>道を描き直す</button
      ><button id="planningUndo" @click=${actions.undoPoint}>一つ戻す</button
      ><button id="planningClear" @click=${actions.clearPoints}>通過点を消す</button>
    </div>
    <details>
      <summary>道の例から試す</summary>
      <button id="planningNear" class="full" @click=${() => actions.useExample('near')}>
        棚の角に沿う道</button
      ><button id="planningWide" class="full" @click=${() => actions.useExample('wide')}>
        棚から離れた道
      </button>
      <p>${copy.controls.drawExamplesNote}</p>
    </details>`;
}

function checkControl(id, title, note, checked, onChange) {
  return html`<label class="planning-check"
    ><input
      id=${id}
      type="checkbox"
      .checked=${checked}
      @change=${(event) => onChange(event.target.checked)}
    /><span><strong>${title}</strong><small>${note}</small></span></label
  >`;
}

function marginControl(config, copy, actions) {
  const centimetres = Math.round(config.margin * 100);
  return html`<label class="planning-slider" for="planningMargin"
      >機体の外側に設ける余裕 <output id="planningMarginValue">${centimetres} cm</output></label
    ><input
      id="planningMargin"
      type="range"
      min="0"
      max="35"
      step="5"
      .value=${String(centimetres)}
      @input=${(event) => actions.setCondition('margin', Number(event.target.value) / 100)}
    />
    <p class="helper">${copy.controls.marginNote}</p>`;
}

function searchDetails(model, copy, actions) {
  return html`<details>
    <summary>道を探す計算を調べる</summary>
    <label for="planningAlgorithm">探索方法</label
    ><select
      id="planningAlgorithm"
      .value=${model.config.algorithm}
      @change=${(event) => actions.setCondition('algorithm', event.target.value)}
    >
      <option value="astar">A*：残りの距離も見積もる</option>
      <option value="dijkstra">ダイクストラ：進んだ距離で比べる</option>
    </select>
    <p>${copy.controls.searchMethod}</p>
    <p>${copy.controls.searchCompare}</p>
    <label class="planning-check"
      ><input
        id="planningSearch"
        type="checkbox"
        .checked=${model.showSearch}
        @change=${(event) => actions.showSearch(event.target.checked)}
      /><span>コンピューターが調べた区画を表示</span></label
    >
    <p id="planningSearchCount" class="helper">${searchCount(model.countedRun)}</p>
  </details>`;
}

function searchCount(run) {
  if (!run) return '';
  const replanned = run.newPlan ? ` → 計画し直し ${run.newPlan.expanded.length}` : '';
  return `調べた区画：${run.plan.expanded.length}${replanned} 個。機体が走った場所ではありません。`;
}

function conditionControl(model, copy, actions) {
  const { topic, config } = model;
  if (topic === 'width')
    return checkControl(
      'planningBody',
      '機体の幅を考える',
      copy.controls.bodyNote,
      config.body,
      (on) => actions.setCondition('body', on),
    );
  if (topic === 'margin') return marginControl(config, copy, actions);
  if (topic === 'replan')
    return checkControl(
      'planningReplan',
      '新しい道を計算する',
      copy.controls.replanNote,
      config.replan,
      (on) => actions.setCondition('replan', on),
    );
  return nothing;
}

function controlPanel(model, copy, topicCopy, actions) {
  const drawing = model.topic === 'draw';
  const runButton = html`<button
    class=${drawing ? 'primary full planning-first-run' : 'primary full'}
    id="planningRun"
    ?disabled=${model.playing}
    @click=${actions.runOrResume}
  >
    ${runButtonLabel(model, topicCopy)}
  </button>`;
  return html`<aside class="card guide planning-guide">
    <p class="eyebrow">条件を決める</p>
    <h2>${topicCopy.controlsTitle}</h2>
    ${drawing ? html`${runButton}${drawControls(copy, actions)}` : conditionControl(model, copy, actions)}
    ${drawing ? nothing : runButton}
    <p class="helper" id="planningActionHint">${actionHint(model, copy, topicCopy)}</p>
    ${drawing ? nothing : searchDetails(model, copy, actions)}
  </aside>`;
}

function resultExplanation(run, topic, copy) {
  const text = copy.results.explanations;
  if (run.status === 'no-path' || run.status === 'no-replan') return text.noPath;
  if (run.status === 'contact') return topic === 'draw' ? text.contactDrawn : text.contactPlanned;
  if (run.status === 'blocked') return text.blocked;
  if (topic === 'margin') return run.config.margin < 0.1 ? text.marginNarrow : text.marginWide;
  return text[topic];
}

function metric(label, value) {
  return html`<div><span>${label}</span><strong>${value}</strong></div>`;
}

function resultsCard(model, copy, topicCopy, actions) {
  const run = model.finishedRun;
  if (!run) return html`<section id="planningResults" class="card" hidden></section>`;
  const names = copy.results.names;
  return html`<section id="planningResults" class="card">
    <div class="section-top">
      <h2>今回の結果</h2>
      <button id="planningCSV" class="small" @click=${actions.saveCsv}>走行記録を保存</button>
    </div>
    <div class="planning-metrics">
      ${metric('結果', names[run.status])}
      ${metric('走行距離', moved(run) ? formatNumber(run.distance, 2) + ' m' : '—')}
      ${metric('経過時間', moved(run) ? formatNumber(run.time) + ' 秒' : '—')}
      ${metric('最も近づいた間隔', moved(run) ? gapLabel(run.minimum) : '—')}
    </div>
    <p class="figure-guide">${copy.results.gapNote}</p>
    <div class="planning-reflection">
      <h3>${topicCopy.reflectionTitle}</h3>
      <p>${resultExplanation(run, model.topic, copy)}</p>
    </div>
  </section>`;
}

function conditionSummary(topic, config) {
  if (topic === 'draw') return `${config.points.length}個の通過点`;
  if (topic === 'width') return `機体の幅 ${config.body ? 'あり' : 'なし'}`;
  if (topic === 'margin') return `余裕 ${Math.round(config.margin * 100)} cm`;
  return `計画し直し ${config.replan ? 'あり' : 'なし'}`;
}

function historyRow(run, index, topic, names) {
  const planned = topic !== 'draw';
  const expanded =
    run.plan.expanded.length + (run.newPlan ? ` / 再計画 ${run.newPlan.expanded.length}` : '');
  const gapBar = `--gap:${Math.min(100, (run.minimum / GAP_BAR_FULL_SCALE) * 100)}%`;
  return html`<tr>
    <th>
      ${index + 1}回目 ·
      ${conditionSummary(topic, run.config)}${
        planned ? html`<small>${ALGORITHM_LABELS[run.config.algorithm]}</small>` : nothing
      }
    </th>
    <td>${names[run.status]}</td>
    <td>${moved(run) ? formatNumber(run.distance, 2) + ' m' : '—'}</td>
    <td>${moved(run) ? formatNumber(run.time) + ' 秒' : '—'}</td>
    <td>
      ${moved(run) ? html`<span class="planning-gap" style=${gapBar}>${gapLabel(run.minimum)}</span>` : '—'}
    </td>
    <td>${planned ? expanded : '—'}</td>
  </tr>`;
}

function historyCard(model, copy) {
  const { records, topic } = model;
  if (records.length < 2) return html`<section id="planningHistory" class="card" hidden></section>`;
  return html`<section id="planningHistory" class="card">
    <div class="section-top">
      <h2>同じ地図で、条件を変えて比べる</h2>
      <span>この段階の直近${records.length}回</span>
    </div>
    <div class="planning-table">
      <table>
        <thead>
          <tr>
            <th>条件</th>
            <th>結果</th>
            <th>距離</th>
            <th>時間</th>
            <th>最小間隔</th>
            <th>調べた区画</th>
          </tr>
        </thead>
        <tbody>
          ${records.map((run, index) => historyRow(run, index, topic, copy.results.names))}
        </tbody>
      </table>
    </div>
    <p class="figure-guide">${copy.results.historyNote}</p>
  </section>`;
}

function explanationCard(copy, topicCopy) {
  return html`<section class="card planning-explanation">
    <h2>${topicCopy.explanationTitle}</h2>
    <p>${topicCopy.explanation}</p>
    <details data-help-dialog>
      <summary>計算とシミュレーションの範囲</summary>
      ${copy.scope.map((paragraph) => html`<p>${paragraph}</p>`)}
    </details>
  </section>`;
}

function footer(model, copy, actions) {
  const position = PLAN_TOPICS.findIndex((topic) => topic.id === model.topic);
  const next = PLAN_TOPICS[position + 1];
  return html`<div class="basics-footer">
    <p>${position + 1} / ${PLAN_TOPICS.length} · ${next ? copy.footer.next : copy.footer.last}</p>
    <button id="planningNext" class="primary" @click=${actions.next}>
      ${next ? `次へ：${next.label} →` : copy.footer.lastButton}
    </button>
  </div>`;
}

function hardwareSection(hardwareHtml, actions) {
  return html`<details data-help-dialog id="planningHardware" class="card planning-hardware">
    <summary>ROS 2の実機で確かめる</summary>
    ${unsafeHTML(hardwareHtml)}
    <button id="planningGuideDownload" @click=${actions.saveHardwareGuide}>
      実機で比べる手順を保存
    </button>
  </details>`;
}

function planningPage(model, copy, hardwareHtml, actions) {
  const topicCopy = copy.topics[model.topic];
  const title = PLAN_TOPICS.find((topic) => topic.id === model.topic).title;
  const lessonKey = 'planning-' + model.topic;
  return html`<div class="page-heading">
      <div>
        <p class="eyebrow course-label">${unsafeHTML(lessonLabel('planning'))}</p>
        <h1>${title}</h1>
      </div>
    </div>
    ${topicNav(model, actions)}
    ${unsafeHTML(lessonBrief(lessonKey, topicCopy.brief) + schoolTips(lessonKey))}
    <div class="planning-layout">
      <div class="planning-workspace">
        ${mapCard(model, copy, topicCopy, actions)}${resultsCard(model, copy, topicCopy, actions)}
        ${historyCard(model, copy)}
      </div>
      ${controlPanel(model, copy, topicCopy, actions)}
    </div>
    ${explanationCard(copy, topicCopy)}${footer(model, copy, actions)}
    ${hardwareSection(hardwareHtml, actions)}`;
}

export { planningPage };
