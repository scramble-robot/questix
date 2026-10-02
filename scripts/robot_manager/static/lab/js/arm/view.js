import { html, nothing, classMap, unsafeHTML } from '../vendor/lit-html.js';
import { lessonLabel } from '../shell/lesson-ui.js';
import { schoolTips } from '../shell/school-tips.js';
import { lessonBrief } from '../shell/lesson-brief.js';
import { runModeBadgeHtml } from '../shell/run-mode.js';
import { ARM_GOALS, ARM_MODEL, ARM_TOPICS, SO101_JOINTS } from './core.js';
import { PART_COLORS } from './render.js';

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
const ANGLE_TICKS = [-90, 0, 90]; // degrees marked under the sliders

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

// "+ 11.3" or "− 11.3": a signed term of a sum, with a proper minus sign.
function signedTerm(text) {
  return text.startsWith('-') ? `− ${text.slice(1)}` : `+ ${text}`;
}

// One line of forward kinematics with the angles and lengths put in:
// 「x = 160×cos20° + 130×cos(20°+65°) = 150.4 + 11.3 = 161.7 mm」 (A5).
function calculationLine(axis, angles, pose) {
  const [shoulder, elbow] = angles.map((angle) => formatValue(angle, 0));
  const trig = axis === 'x' ? 'cos' : 'sin';
  const sum = `${shoulder}°${signedTerm(elbow + '°').replace(' ', '')}`;
  const first = formatValue(pose.elbow[axis]);
  const second = formatValue(pose.tip[axis] - pose.elbow[axis]);
  return (
    `${axis} = ${ARM_MODEL.l1}×${trig}${shoulder}° + ${ARM_MODEL.l2}×${trig}(${sum})` +
    ` = ${first} ${signedTerm(second)} = ${formatValue(pose.tip[axis])} mm`
  );
}

function calculationBox(model, copy) {
  return html`<div id="armCalculation" class="arm-calculation">
    <div>
      <span>横の位置</span><strong>${calculationLine('x', model.angles, model.pose)}</strong>
    </div>
    <div><span>高さ</span><strong>${calculationLine('z', model.angles, model.pose)}</strong></div>
    <p>${copy.workspace.calculationNote}</p>
  </div>`;
}

// The key of the side view, in HTML so it stays readable on a phone (A1, A3). Each entry names a
// mark by its shape and label as the lesson text does.
function sceneLegend(model, copy) {
  const legend = copy.legend;
  const items = [
    ['arm-key-link1', legend.link1],
    ['arm-key-link2', legend.link2],
    ['arm-key-tip', legend.tip],
    ['arm-key-ghost', model.inverse ? legend.ghostPoses : legend.ghost],
    ['arm-key-trail', legend.trail],
  ];
  if (model.topic === 'joints' || model.topic === 'forward')
    items.push(['arm-key-angle', legend.angles]);
  if (model.topic === 'forward') items.push(['arm-key-projection', legend.projections]);
  if (model.topic === 'reach') items.push(['arm-key-reach', legend.reach]);
  if (model.inverse) items.push(['arm-key-target', legend.target]);
  if (model.topic === 'challenge')
    items.push(['arm-key-post', legend.post], ['arm-key-contact', legend.contact]);
  return html`<ul class="arm-legend" aria-label="図の見方">
    ${items.map(([key, label]) => html`<li><i class=${key} aria-hidden="true"></i>${label}</li>`)}
  </ul>`;
}

function readings(model) {
  const { angles, pose } = model;
  return html`<dl class="arm-readings">
    <div>
      <dt>手先の横位置 x</dt>
      <dd id="armX">${millimetres(pose.tip.x)}</dd>
    </div>
    <div>
      <dt>肩からの高さ z</dt>
      <dd id="armZ">${millimetres(pose.tip.z)}</dd>
    </div>
    <div>
      <dt>現在の肩 θ₁ / 肘 θ₂</dt>
      <dd id="armAngles">${formatValue(angles[0], 0)}° / ${formatValue(angles[1], 0)}°</dd>
    </div>
  </dl>`;
}

// The figure, its key, the play controls and the numbers read from it: first on a phone.
function figureCard(model, copy, actions) {
  const pickable = model.inverse && model.topic !== 'challenge';
  return html`<section class="card arm-workspace arm-figure-card">
    <div class="arm-view-head">
      <h2>${workspaceTitle(model)}</h2>
      <span>${copy.workspace.axesNote}</span>
    </div>
    <canvas
      id="armScene"
      width="760"
      height="490"
      aria-label=${copy.workspace.sceneLabel}
      @click=${pickable ? actions.pickTarget : nothing}
    ></canvas>
    ${sceneLegend(model, copy)}
    <div class="arm-playbar">
      <button id="armPause" ?disabled=${!model.motion} @click=${actions.togglePlay}>
        ${playButtonLabel(model)}
      </button>
      <span id="armClock">${clockLabel(model)}</span>
    </div>
    ${readings(model)}
  </section>`;
}

// What happened and, in the forward topic, the calculation: after the main controls on a phone.
function resultCard(model, copy) {
  return html`<section class="card arm-result-card">
    <p id="armStatus" class="arm-status" role="status">${model.status}</p>
    ${model.topic === 'forward' ? calculationBox(model, copy) : nothing}
  </section>`;
}

function angleSlider(index, model, actions) {
  const label = index === 0 ? '肩 θ₁：右向きからの角度' : '肘 θ₂：手前の棒からの曲げ角度';
  return html`<label class="arm-angle-label" for="armAngle${index}"
      >${label}<output id="armAngleValue${index}">${model.desired[index]}°</output></label
    ><input
      id="armAngle${index}"
      type="range"
      min=${ANGLE_RANGE.min}
      max=${ANGLE_RANGE.max}
      step="1"
      list="armAngleTicks"
      .value=${String(model.desired[index])}
      ?disabled=${model.playing}
      @input=${(event) => actions.setDesiredAngle(index, Number(event.target.value))}
    />`;
}

// Tick marks at −90°, 0° and 90° under both angle sliders (A10).
const angleTicks = html`<datalist id="armAngleTicks">
  ${ANGLE_TICKS.map((value) => html`<option value=${value} label=${`${value}°`}></option>`)}
</datalist>`;

function anglePresets(model, actions) {
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
  </div>`;
}

function angleControls(model, copy, actions) {
  // Pressing with the sliders on the current pose would "move" for a moment without moving.
  const samePose = model.desired.every((angle, index) => angle === model.angles[index]);
  return html`${angleSlider(0, model, actions)}${angleSlider(1, model, actions)}${angleTicks}
    <button
      class="primary full"
      id="armRun"
      ?disabled=${model.playing || samePose}
      @click=${actions.run}
    >
      この角度まで動かす
    </button>
    ${samePose && !model.playing ? html`<p class="helper">${copy.controls.samePose}</p>` : nothing}
    ${model.topic === 'forward' ? anglePresets(model, actions) : nothing}
    <p class="helper">${copy.controls.angleHelp}</p>`;
}

function targetField(axis, model, actions) {
  const id = axis === 'x' ? 'armTargetX' : 'armTargetZ';
  const label = axis === 'x' ? '横位置 x（mm）' : '高さ z（mm）';
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

function solutionNote(candidate, selected, copy) {
  if (!candidate.allowed) return copy.solutions.outsideLimits;
  if (candidate.endsOnObstacle) return copy.solutions.endsOnObstacle;
  if (selected) return copy.solutions.selected;
  return copy.solutions.choose;
}

// A positive elbow bend turns the second bar counter-clockwise, which leaves the elbow below the
// line from the shoulder to the tip (A6).
const elbowSide = (candidate) => (candidate.q[1] >= 0 ? '肘が下' : '肘が上');

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
    <strong>姿勢${POSE_NAMES[index]}（${elbowSide(candidate)}）</strong
    ><span>肩 θ₁ ${formatValue(candidate.q[0])}° ／ 肘 θ₂ ${formatValue(candidate.q[1])}°</span
    ><small>${solutionNote(candidate, index === model.selected && candidate.allowed, copy)}</small>
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

function challengeProgress(model, actions) {
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
    </button>`;
}

function challengeExtras(copy, actions) {
  return html`<details class="arm-extra">
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

// The main controls: right under the figure on a phone.
function guidePanel(model, copy, actions) {
  const inverse = model.inverse;
  return html`<aside class="card arm-guide">
    <p class="eyebrow">
      ${inverse ? '① 行き先 → ② 角度を計算 → ③ 動かす' : '角度を決めて、動きを確かめる'}
    </p>
    <h2>${inverse ? '手先をどこへ運ぶ？' : '関節を何度にする？'}</h2>
    ${inverse ? targetControls(model, copy, actions) : angleControls(model, copy, actions)}
    ${model.topic === 'challenge' ? challengeProgress(model, actions) : nothing}
  </aside>`;
}

function formulaDetails(fragments) {
  return html`<details data-help-dialog>
    <summary>位置を計算する式を見る</summary>
    ${unsafeHTML(fragments.formula)}
  </details>`;
}

// Retries, formulas and model notes: after the result on a phone.
function morePanel(model, copy, fragments, actions) {
  return html`<aside class="card arm-guide arm-guide-more">
    ${model.topic === 'challenge' ? challengeExtras(copy, actions) : nothing}
    ${model.topic === 'forward' ? formulaDetails(fragments) : nothing} ${modelNotes(copy)}
  </aside>`;
}

// Figure → main controls → result → details on a phone; figure and result on the left, the
// controls on the right on a wide screen (arm.css, hs-arm-vision-slam.css).
function armLayout(figure, guide, result, more) {
  return html`<div class="arm-layout">
    <div class="arm-main-col">${figure}${result}</div>
    <div class="arm-side-col">${guide}${more}</div>
  </div>`;
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

// The answer stays folded until the learner has predicted it: it opens by itself after the
// first finished motion of the topic, or on click (C1).
function reflectionCard(topicCopy, model) {
  const { question, answer, hint } = topicCopy.reflection;
  return html`<section class="card arm-reflection">
    <h2>${question}</h2>
    <details class="reflection-answer" ?open=${model.tried}>
      <summary>予想してから答えを見る</summary>
      <p>${answer}</p>
    </details>
    <details>
      <summary>次に試すためのヒント</summary>
      <p>${hint}</p>
    </details>
  </section>`;
}

function experimentPage(model, copy, topicCopy, fragments, actions) {
  return html`${armLayout(
    figureCard(model, copy, actions),
    guidePanel(model, copy, actions),
    resultCard(model, copy),
    morePanel(model, copy, fragments, actions),
  )}
  ${model.topic === 'challenge' ? historyCard(model, copy) : nothing}
  ${reflectionCard(topicCopy, model)}`;
}

function jointSlider(joint, index, model, actions) {
  const angle = model.hardware.angles[index];
  return html`<label class="arm-angle-label" for="armReal${index}"
      ><span
        ><i class="arm-joint-dot" style=${`--joint-color: ${PART_COLORS[index]}`} aria-hidden="true"
          >${index + 1}</i
        >${joint.label}</span
      ><output id="armRealValue${index}"
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

function hardwareLegend(copy) {
  return html`<ul class="arm-legend" aria-label="図の見方">
    ${['x', 'y', 'z'].map(
      (axis) =>
        html`<li>
          <i class="arm-key-axis-${axis}" aria-hidden="true"></i>${copy.legend.axes[axis]}
        </li>`,
    )}
    <li><i class="arm-key-number" aria-hidden="true">1</i>${copy.legend.jointNumbers}</li>
    <li><i class="arm-key-drop" aria-hidden="true"></i>${copy.legend.drop}</li>
  </ul>`;
}

function hardwareFigure(model, copy) {
  const { tip } = model.hardware;
  return html`<section class="card arm-workspace arm-figure-card">
    <div class="arm-view-head">
      <h2>${copy.hardware.figureTitle}</h2>
      <span>${copy.hardware.figureNote}</span>
    </div>
    <canvas id="armScene" width="760" height="490" aria-label=${copy.hardware.sceneLabel}></canvas>
    ${hardwareLegend(copy)}
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
  </section>`;
}

function hardwareResult(model, copy) {
  const hardwareCopy = copy.hardware;
  return html`<section class="card arm-result-card">
    <p id="armRealSource" class="arm-status">
      ${model.hardware.source}${hardwareCopy.sourceSuffix}
    </p>
    <div class="arm-hardware-note">
      <h2>${hardwareCopy.noteTitle}</h2>
      <p>${hardwareCopy.note}</p>
    </div>
  </section>`;
}

function hardwareGuide(model, copy, actions) {
  return html`<aside class="card arm-guide">
    <p class="eyebrow">実機の寸法で、角度から位置を計算</p>
    <h2>5つの関節角度を変える</h2>
    <button id="armRealZero" class="full" @click=${actions.showZeroPose}>
      全関節0°の計算を見る
    </button>
    ${SO101_JOINTS.map((joint, index) => jointSlider(joint, index, model, actions))}
    <p class="helper">${copy.hardware.slidersHelp}</p>
  </aside>`;
}

function hardwareMore(copy, fragments) {
  return html`<aside class="card arm-guide arm-guide-more">
    <details data-help-dialog>
      <summary>${copy.hardware.urdfSummary}</summary>
      ${unsafeHTML(fragments.urdfNotes)}
    </details>
    ${modelNotes(copy)}
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
              >${axis}（mm）<input id="armMeasured${axis}" type="number" step="any" required
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
        <th>計算位置 x / y / z（mm）</th>
        <th>測定位置（mm）</th>
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
      <h2>${unsafeHTML(runModeBadgeHtml('data'))} ${copy.hardware.labTitle}</h2>
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
  return html`${armLayout(
    hardwareFigure(model, copy),
    hardwareGuide(model, copy, actions),
    hardwareResult(model, copy),
    hardwareMore(copy, fragments),
  )}
  ${realLab(model, copy, fragments, actions)}`;
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
    }`;
}

export { armPage, formatValue };
