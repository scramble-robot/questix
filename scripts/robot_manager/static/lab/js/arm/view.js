import { html, nothing, classMap, unsafeHTML } from '../vendor/lit-html.js';
import { lessonLabel } from '../shell/lesson-ui.js';
import { schoolTips } from '../shell/school-tips.js';
import { lessonBrief } from '../shell/lesson-brief.js';
import { ARM_GOALS, ARM_TOPICS, SO101_JOINTS } from './core.js';

// Templates of the arm course. Every function is pure: it turns the model built by ui.js into
// markup. Learner-facing sentences come from content/arm.json (`copy`) and the HTML fragments
// under content/arm/ (`fragments`); only short labels live here.

const GOAL_COUNT = ARM_GOALS.length;
const MAX_HISTORY_ROWS = 5;
const MAX_MEASUREMENT_ROWS = 6;
const ANGLE_PRESETS = [
  { angles: [0, 0], label: '横へまっすぐ' },
  { angles: [90, 0], label: '上へまっすぐ' },
  { angles: [0, 90], label: '直角に曲げる' },
];
const TARGET_PRESETS = [
  { point: { x: 330, z: 0 }, label: '遠すぎる位置' },
  { point: { x: 10, z: 0 }, label: '近すぎる位置' },
  { point: { x: 180, z: -50 }, label: '角度制限の例' },
];
const POSE_NAMES = ['A', 'B'];
const ANGLE_RANGE = { min: -150, max: 150 }; // degrees the sliders offer

// toFixed keeps the sign of tiny negative results of the trigonometry ("-0.0"); learners should
// read those as 0.
function formatValue(value, digits = 1) {
  const number = Number(value);
  const rounded = Math.abs(number) < 0.5 * 10 ** -digits ? 0 : number;
  return rounded.toFixed(digits);
}

const degrees = (radians) => (radians * 180) / Math.PI;
const millimetres = (value) => formatValue(value) + ' mm';

function topicNav(model, actions) {
  return html`<nav class="arm-topics" aria-label="アームの学習順序">
    ${ARM_TOPICS.map(
      (topic, index) =>
        html`<button
          data-arm-topic=${topic.id}
          aria-current=${topic.id === model.topic ? 'step' : 'false'}
          @click=${() => actions.openTopic(topic.id)}
        >
          <span>${index + 1}</span>${topic.label}
        </button>`,
    )}
  </nav>`;
}

function playButtonLabel({ playing, motion }) {
  if (playing) return 'Ⅱ 一時停止';
  if (motion && !motion.atEnd) return '▶ 続きから見る';
  return '▶ 同じ動きを見る';
}

function clockLabel({ playing, motion }) {
  if (!motion) return '実験前';
  const phase = playing ? '移動中' : '停止中';
  return `${phase} · ${formatValue(motion.time)} 秒`;
}

function workspaceTitle(model) {
  if (model.topic === 'challenge') return `目標 ${model.goal + 1}：支柱を避けて届ける`;
  return '角度と手先の位置を見比べる';
}

function calculationBox(pose, copy) {
  const { elbow, tip } = pose;
  return html`<div id="armCalculation" class="arm-calculation">
    <div>
      <span>横の位置 x</span
      ><strong
        >${formatValue(elbow.x)} + ${formatValue(tip.x - elbow.x)} = ${formatValue(tip.x)}
        mm</strong
      >
    </div>
    <div>
      <span>高さ z</span
      ><strong
        >${formatValue(elbow.z)} + ${formatValue(tip.z - elbow.z)} = ${formatValue(tip.z)}
        mm</strong
      >
    </div>
    <p>${copy.workspace.calculationNote}</p>
  </div>`;
}

function workspaceCard(model, copy, actions) {
  const { angles, pose } = model;
  const pickable = model.inverse && model.topic !== 'challenge';
  return html`<section class="card arm-workspace">
    <div class="arm-view-head">
      <h2>${workspaceTitle(model)}</h2>
      <span>肩の中心が0：右方向をx、上方向をzで表す</span>
    </div>
    <div
      class="diagram-scroll"
      role="region"
      aria-label=${copy.workspace.diagramRegionLabel}
      tabindex="0"
    >
      <canvas
        id="armScene"
        width="760"
        height="490"
        aria-label=${copy.workspace.sceneLabel}
        @click=${pickable ? actions.pickTarget : nothing}
      ></canvas>
    </div>
    <p class="diagram-scroll-hint">${copy.workspace.scrollHint}</p>
    <div class="arm-playbar">
      <button id="armPause" ?disabled=${!model.motion} @click=${actions.togglePlay}>
        ${playButtonLabel(model)}
      </button>
      <span id="armClock">${clockLabel(model)}</span>
      <span>実線：現在 ／ 細線：到着姿勢</span>
    </div>
    <dl class="arm-readings">
      <div>
        <dt>手先の横位置 x</dt>
        <dd id="armX">${millimetres(pose.tip.x)}</dd>
      </div>
      <div>
        <dt>肩からの高さ z</dt>
        <dd id="armZ">${millimetres(pose.tip.z)}</dd>
      </div>
      <div>
        <dt>現在の肩 / 肘</dt>
        <dd id="armAngles">${formatValue(angles[0], 0)}° / ${formatValue(angles[1], 0)}°</dd>
      </div>
    </dl>
    <p id="armStatus" class="arm-status" role="status">${model.status}</p>
    ${model.topic === 'forward' ? calculationBox(pose, copy) : nothing}
  </section>`;
}

function angleSlider(index, model, actions) {
  const label = index === 0 ? '肩：右向きからの角度' : '肘：手前の棒からの曲げ角度';
  return html`<label class="arm-angle-label" for="armAngle${index}"
      >${label}<output id="armAngleValue${index}">${model.desired[index]}°</output></label
    ><input
      id="armAngle${index}"
      type="range"
      min=${ANGLE_RANGE.min}
      max=${ANGLE_RANGE.max}
      step="1"
      .value=${String(model.desired[index])}
      ?disabled=${model.playing}
      @input=${(event) => actions.setDesiredAngle(index, Number(event.target.value))}
    />`;
}

function anglePresets(model, fragments, actions) {
  return html`<div class="arm-presets">
      ${ANGLE_PRESETS.map(
        (preset) =>
          html`<button
            data-arm-preset=${preset.angles.join(',')}
            ?disabled=${model.playing}
            @click=${() => actions.usePreset(preset.angles)}
          >
            ${preset.label}
          </button>`,
      )}
    </div>
    <details data-help-dialog>
      <summary>位置を計算する式を見る</summary>
      ${unsafeHTML(fragments.formula)}
    </details>`;
}

function angleControls(model, copy, fragments, actions) {
  return html`${angleSlider(0, model, actions)}${angleSlider(1, model, actions)}
    <p class="helper">${copy.controls.angleHelp}</p>
    <button class="primary full" id="armRun" ?disabled=${model.playing} @click=${actions.run}>
      この角度まで動かす
    </button>
    ${model.topic === 'forward' ? anglePresets(model, fragments, actions) : nothing}`;
}

function targetField(axis, model, actions) {
  const id = axis === 'x' ? 'armTargetX' : 'armTargetZ';
  const label = axis === 'x' ? '横位置 x (mm)' : '高さ z (mm)';
  const bounds = model.targetBounds[axis];
  return html`<label for=${id}
    >${label}<input
      id=${id}
      type="number"
      min=${bounds.min}
      max=${bounds.max}
      .value=${model.targetText[axis]}
      ?readonly=${model.topic === 'challenge'}
      ?disabled=${model.playing}
      @change=${(event) => actions.editTarget(axis, event.target.value)}
  /></label>`;
}

function targetPresets(model, copy, actions) {
  return html`<div class="arm-presets">
      ${TARGET_PRESETS.map(
        (preset) =>
          html`<button
            data-arm-target=${`${preset.point.x},${preset.point.z}`}
            ?disabled=${model.playing}
            @click=${() => actions.useTargetPreset(preset.point)}
          >
            ${preset.label}
          </button>`,
      )}
    </div>
    <label class="arm-check"
      ><input
        id="armLimit"
        type="checkbox"
        .checked=${model.limited}
        ?disabled=${model.playing}
        @change=${(event) => actions.setLimited(event.target.checked)}
      />関節の角度を制限する</label
    >
    <p class="helper">${copy.controls.limitHelp}</p>`;
}

function solutionNote(candidate, copy) {
  if (!candidate.allowed) return copy.solutions.outsideLimits;
  if (candidate.endsOnObstacle) return copy.solutions.endsOnObstacle;
  return copy.solutions.choose;
}

function solutionButton(candidate, index, model, copy, actions) {
  return html`<button
    type="button"
    class="arm-solution"
    data-arm-pose=${index}
    data-blocked=${String(!candidate.allowed)}
    aria-pressed=${String(index === model.selected)}
    ?disabled=${model.playing || !candidate.allowed}
    @click=${() => actions.selectPose(index)}
  >
    <strong>姿勢${POSE_NAMES[index]}</strong
    ><span>肩 ${formatValue(candidate.q[0])}° ／ 肘 ${formatValue(candidate.q[1])}°</span
    ><small>${solutionNote(candidate, copy)}</small>
  </button>`;
}

function solutionList(model, copy, actions) {
  const candidates = model.candidates;
  if (!candidates) return html`<p class="helper">${copy.solutions.beforeSolve}</p>`;
  if (!candidates.length) return html`<p class="arm-no-solution">${copy.solutions.none}</p>`;
  return candidates.map((candidate, index) =>
    solutionButton(candidate, index, model, copy, actions),
  );
}

function targetControls(model, copy, actions) {
  const challenge = model.topic === 'challenge';
  return html`<div class="arm-input-pair">
      ${targetField('x', model, actions)}${targetField('z', model, actions)}
    </div>
    <p class="helper">
      ${challenge ? copy.controls.challengeTargetHelp : copy.controls.targetHelp}
    </p>
    ${model.topic === 'reach' ? targetPresets(model, copy, actions) : nothing}
    <button
      class=${classMap({ primary: model.solvePrimary, full: true })}
      id="armSolve"
      ?disabled=${model.playing}
      @click=${actions.solve}
    >
      届く角度を計算
    </button>
    <div id="armSolutions" class="arm-solutions">${solutionList(model, copy, actions)}</div>
    <button
      class="primary full"
      id="armMove"
      ?hidden=${!model.hasAllowedSolution}
      ?disabled=${model.playing || !model.canMove}
      @click=${actions.move}
    >
      選んだ姿勢へ動かす
    </button>`;
}

function challengeExtras(model, copy, actions) {
  const reached = model.hits.includes(model.goal);
  return html`<p id="armProgress" class="arm-progress">
      ${model.hits.length} / ${GOAL_COUNT} 個に到着
    </p>
    <button
      id="armNextGoal"
      class="full"
      ?disabled=${model.playing || !reached}
      ?hidden=${model.goal === GOAL_COUNT - 1}
      @click=${actions.nextGoal}
    >
      次の目標へ →
    </button>
    <details class="arm-extra">
      <summary>通過点とやり直し</summary>
      <p>${copy.controls.waypointHelp}</p>
      <button id="armWaypoint" @click=${actions.useWaypoint}>高い通過点を使う</button>
      <button id="armGoal" @click=${actions.backToGoal}>目標へ戻す</button>
      <button id="armReset" @click=${actions.resetPose}>開始姿勢に戻す</button>
    </details>`;
}

function modelNotes(copy) {
  return html`<details data-help-dialog>
    <summary>${copy.modelNotes.summary}</summary>
    ${copy.modelNotes.paragraphs.map((paragraph) => html`<p>${paragraph}</p>`)}
  </details>`;
}

function guidePanel(model, copy, fragments, actions) {
  const inverse = model.inverse;
  return html`<aside class="card arm-guide">
    <p class="eyebrow">
      ${inverse ? '① 行き先 → ② 角度を計算 → ③ 動かす' : '角度を決めて、動きを確かめる'}
    </p>
    <h2>${inverse ? '手先をどこへ運ぶ？' : '関節を何度にする？'}</h2>
    ${
      inverse
        ? targetControls(model, copy, actions)
        : angleControls(model, copy, fragments, actions)
    }
    ${model.topic === 'challenge' ? challengeExtras(model, copy, actions) : nothing}
    ${modelNotes(copy)}
  </aside>`;
}

function historyRow(record) {
  return html`<tr>
    <td>${record.waypoint ? '通過点' : `目標 ${record.goal}`}</td>
    <td>${record.collision ? '支柱に接触' : '到着'}</td>
    <td>${millimetres(record.error)}</td>
  </tr>`;
}

function historyTable(records, copy) {
  if (!records.length) return html`<p>${copy.history.empty}</p>`;
  return html`<table>
    <thead>
      <tr>
        <th>行き先</th>
        <th>結果</th>
        <th>到着時のずれ</th>
      </tr>
    </thead>
    <tbody>
      ${records.slice(-MAX_HISTORY_ROWS).map(historyRow)}
    </tbody>
  </table>`;
}

function historyCard(model, copy) {
  return html`<section class="card arm-reflection">
    <h2 data-lesson-cue="result">試した結果を比べる</h2>
    <div id="armHistory" class="arm-table">${historyTable(model.records, copy)}</div>
  </section>`;
}

function reflectionCard(topicCopy) {
  const { question, answer, hint } = topicCopy.reflection;
  return html`<section class="card arm-reflection">
    <h2>${question}</h2>
    <p>${answer}</p>
    <details>
      <summary>次に試すためのヒント</summary>
      <p>${hint}</p>
    </details>
  </section>`;
}

function experimentPage(model, copy, topicCopy, fragments, actions) {
  return html`<div class="arm-layout">
      ${workspaceCard(model, copy, actions)}${guidePanel(model, copy, fragments, actions)}
    </div>
    ${model.topic === 'challenge' ? historyCard(model, copy) : nothing} ${reflectionCard(topicCopy)}`;
}

function jointSlider(joint, index, model, actions) {
  const angle = model.hardware.angles[index];
  return html`<label class="arm-angle-label" for="armReal${index}"
      >${index + 1}. ${joint.label}<output id="armRealValue${index}"
        >${formatValue(angle, model.hardware.digits[index])}°</output
      ></label
    ><input
      id="armReal${index}"
      type="range"
      min=${degrees(joint.limit[0]).toFixed(3)}
      max=${degrees(joint.limit[1]).toFixed(3)}
      step="1"
      .value=${String(angle)}
      @input=${(event) => actions.setJointAngle(index, Number(event.target.value))}
    />`;
}

function hardwareWorkspace(model, copy) {
  const { tip, source } = model.hardware;
  const hardwareCopy = copy.hardware;
  return html`<section class="card arm-workspace">
    <div
      class="diagram-scroll"
      role="region"
      aria-label=${copy.workspace.diagramRegionLabel}
      tabindex="0"
    >
      <canvas id="armScene" width="760" height="490" aria-label=${hardwareCopy.sceneLabel}></canvas>
    </div>
    <p class="diagram-scroll-hint">${copy.workspace.scrollHint}</p>
    <dl class="arm-readings">
      <div>
        <dt>手先 x</dt>
        <dd id="armRealX">${millimetres(tip.x)}</dd>
      </div>
      <div>
        <dt>手先 y</dt>
        <dd id="armRealY">${millimetres(tip.y)}</dd>
      </div>
      <div>
        <dt>手先 z</dt>
        <dd id="armRealZ">${millimetres(tip.z)}</dd>
      </div>
    </dl>
    <p id="armRealSource" class="arm-status">${source}${hardwareCopy.sourceSuffix}</p>
    <div class="arm-hardware-note">
      <h2>${hardwareCopy.noteTitle}</h2>
      <p>${hardwareCopy.note}</p>
    </div>
  </section>`;
}

function hardwareGuide(model, copy, fragments, actions) {
  return html`<aside class="card arm-guide">
    <p class="eyebrow">実機の寸法で、角度から位置を計算</p>
    <h2>5つの関節角度を変える</h2>
    ${SO101_JOINTS.map((joint, index) => jointSlider(joint, index, model, actions))}
    <p class="helper">${copy.hardware.slidersHelp}</p>
    <button id="armRealZero" class="full" @click=${actions.showZeroPose}>
      全関節0°の計算を見る
    </button>
    <details data-help-dialog>
      <summary>${copy.hardware.urdfSummary}</summary>
      ${unsafeHTML(fragments.urdfNotes)}
    </details>
  </aside>`;
}

function jointStateColumn(model, copy, fragments, actions) {
  return html`<div>
    <h3>${copy.hardware.readTitle}</h3>
    ${unsafeHTML(fragments.jointStateIntro)}
    <label for="armJointData">角度データ（JSON）</label>
    <textarea
      id="armJointData"
      rows="5"
      spellcheck="false"
      .value=${model.hardware.jointInput}
      @input=${(event) => actions.editJointInput(event.target.value)}
    ></textarea>
    <div class="arm-actions">
      <button id="armJointExample" @click=${actions.fillJointExample}>模擬データを入れる</button>
      <button id="armJointRead" class="primary" @click=${actions.readJointInput}>
        この角度を読み込む
      </button>
    </div>
    <label class="arm-json-file"
      >JSONファイルを開く<input
        id="armJointFile"
        type="file"
        accept=".json,application/json"
        @change=${actions.openJointFile}
    /></label>
    <p id="armRealError" role="status">${model.hardware.error}</p>
  </div>`;
}

function measurementColumn(model, copy, actions) {
  return html`<div>
    <h3>${copy.hardware.measureTitle}</h3>
    <p>${copy.hardware.measureIntro}</p>
    <form id="armMeasureForm" @submit=${actions.recordMeasurement}>
      <div class="arm-input-triple">
        ${['x', 'y', 'z'].map(
          (axis) =>
            html`<label for="armMeasured${axis}"
              >${axis} (mm)<input id="armMeasured${axis}" type="number" step="any" required
            /></label>`,
        )}
      </div>
      <button type="submit" class="primary">計算との差を記録する</button>
    </form>
    <p id="armMeasureStatus" role="status">${model.hardware.measureStatus}</p>
  </div>`;
}

const coordinates = (point) => ['x', 'y', 'z'].map((axis) => formatValue(point[axis])).join(' / ');

function measurementRow(record, number) {
  return html`<tr>
    <td>${number}</td>
    <td>${record.source}</td>
    <td>${coordinates(record.expected)}</td>
    <td>${coordinates(record.measured)}</td>
    <td>${millimetres(record.error)}</td>
  </tr>`;
}

function measurementTable(measurements, copy) {
  if (!measurements.length) return html`<p>${copy.hardware.noMeasurements}</p>`;
  const firstNumber = Math.max(0, measurements.length - MAX_MEASUREMENT_ROWS) + 1;
  return html`<table>
    <thead>
      <tr>
        <th>記録</th>
        <th>角度の出所</th>
        <th>計算位置 x / y / z (mm)</th>
        <th>測定位置 (mm)</th>
        <th>位置のずれ</th>
      </tr>
    </thead>
    <tbody>
      ${measurements
        .slice(-MAX_MEASUREMENT_ROWS)
        .map((record, index) => measurementRow(record, firstNumber + index))}
    </tbody>
  </table>`;
}

function procedureDetails(copy, fragments, actions) {
  return html`<details data-help-dialog>
    <summary>${copy.hardware.procedureSummary}</summary>
    ${unsafeHTML(fragments.procedure)}
    <button id="armROSDownload" @click=${actions.saveRecorderScript}>
      角度を1件保存するPythonを取得
    </button>
    ${unsafeHTML(fragments.procedureRun)}
  </details>`;
}

function realLab(model, copy, fragments, actions) {
  return html`<section class="card arm-real-lab">
    <div>
      <p class="eyebrow">実機で確かめる</p>
      <h2>${copy.hardware.labTitle}</h2>
      <p>${copy.hardware.labIntro}</p>
    </div>
    <div class="arm-real-columns">
      ${jointStateColumn(model, copy, fragments, actions)}${measurementColumn(model, copy, actions)}
    </div>
    <div id="armMeasurements" class="arm-table">
      ${measurementTable(model.hardware.measurements, copy)}
    </div>
    <button
      id="armExport"
      ?disabled=${!model.hardware.measurements.length}
      @click=${actions.saveCsv}
    >
      比較した記録をCSVで保存
    </button>
    ${procedureDetails(copy, fragments, actions)}
  </section>`;
}

function hardwarePage(model, copy, fragments, actions) {
  return html`<div class="arm-layout">
      ${hardwareWorkspace(model, copy)}${hardwareGuide(model, copy, fragments, actions)}
    </div>
    ${realLab(model, copy, fragments, actions)}`;
}

function footer(model, actions) {
  const last = model.position === ARM_TOPICS.length - 1;
  return html`<div class="arm-bottom">
    <button id="armPrevious" ?disabled=${model.position === 0} @click=${actions.previous}>
      ← 前の実験
    </button>
    <span>${model.position + 1} / ${ARM_TOPICS.length}</span>
    <button id="armNext" @click=${actions.next}>
      ${last ? '小テストで確かめる →' : '次の実験 →'}
    </button>
  </div>`;
}

function armPage(model, copy, fragments, actions) {
  const topicCopy = copy.topics[model.topic];
  const lessonKey = 'arm-' + model.topic;
  return html`<div class="page-heading">
      <div>
        <p class="eyebrow course-label">${unsafeHTML(lessonLabel('arm'))}</p>
        <h1>${topicCopy.title}</h1>
      </div>
    </div>
    ${topicNav(model, actions)}
    ${unsafeHTML(lessonBrief(lessonKey, topicCopy.brief) + schoolTips(lessonKey))}
    ${
      model.topic === 'hardware'
        ? hardwarePage(model, copy, fragments, actions)
        : experimentPage(model, copy, topicCopy, fragments, actions)
    }
    ${footer(model, actions)}`;
}

export { armPage, formatValue };
