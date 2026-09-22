import { html, nothing } from '../vendor/lit-html.js';
import { formatNumber } from '../core/dom.js';
import { slider, select, helpDetails, checkbox, paragraph } from './controls-view.js';

// Templates of the two depth chapters, "左右の像から測る" (stereo) and "RGBと奥行きを使う" (RGB-D).
// Every function is pure: it turns the model built by depth-ui.js into markup for one of the
// containers that ui.js provides (controls, evidence, motion, reflection). Learner-facing
// sentences come from content/vision/depth.json (`copy`); only short labels live here.

const STEREO_HISTORY_ROWS = 5; // most recent measurements listed under "計算した結果を比べる"
const CENTIMETRES_PER_METRE = 100;

// Geometry of the top-down placement diagram, in its own viewBox units.
const DIAGRAM = {
  farTargetY: 35, // svg y of the target at the far end of the distance slider
  yPerMetre: 30, // svg y the target moves per metre it comes closer
  farDistance: 3, // metres; the distance that puts the target at farTargetY
  lensY: 168,
};
// The alignment strip magnifies the remaining mismatch so that a single pixel stays visible.
const ALIGNMENT = { centreX: 160, magnification: 6, axisY: 40 };

const metres = (value) => formatNumber(value, 2);
const pixels = (value) => formatNumber(value, 1);

// ---- 左右の像から測る -------------------------------------------------------------------------

// Top-down sketch of the one device, its two imaging units and the box they both look at.
function stereoDiagram(model, copy) {
  const text = copy.stereo.diagram;
  const targetY = DIAGRAM.farTargetY + (DIAGRAM.farDistance - model.distance) * DIAGRAM.yPerMetre;
  const sightLines = `M266 ${DIAGRAM.lensY}L320 ${targetY + 17}L374 ${DIAGRAM.lensY}`;
  return html`<div class="depth-diagram">
    <svg viewBox="0 0 640 225" role="img" aria-label=${text.label}>
      <text x="22" y="28">${text.caption}</text>
      <rect x="190" y="155" width="260" height="44" rx="12" fill="#52777e" />
      <circle cx="266" cy=${DIAGRAM.lensY} r="9" fill="#9fd3e3" />
      <circle cx="374" cy=${DIAGRAM.lensY} r="9" fill="#9fd3e3" />
      <rect x="310" y="174" width="20" height="12" rx="3" fill="#cfdecd" />
      <path d=${sightLines} fill="none" stroke="#a6d7ce" stroke-width="2" />
      <rect x="302" y=${targetY} width="36" height="27" rx="3" fill="#c66d4e" />
      <text x="349" y=${targetY + 20}>${text.targetLabel}</text>
      <text x="458" y="182">${text.rgbLabel}</text>
      <text x="320" y="221" text-anchor="middle">${text.deviceLabel}</text>
      <text x="208" y="150">左</text>
      <text x="402" y="150">右</text>
    </svg>
  </div>`;
}

// Magnified view of how far the learner's shift still misses the true disparity.
function alignmentStrip(model, copy) {
  const text = copy.stereo.alignment;
  const offset = (model.shift - model.disparity) * ALIGNMENT.magnification;
  return html`<svg class="depth-alignment" viewBox="0 0 320 90" role="img" aria-label=${text.label}>
    <line x1="15" x2="305" y1=${ALIGNMENT.axisY} y2=${ALIGNMENT.axisY} stroke="#ccdada" />
    <line x1="160" x2="160" y1="10" y2="65" stroke="#3e8174" stroke-width="3" />
    <circle cx=${ALIGNMENT.centreX + offset} cy=${ALIGNMENT.axisY} r="8" fill="#4e7cb9" />
    <text x="160" y="85" text-anchor="middle" fill="#435e66">${text.caption}</text>
  </svg>`;
}

function stereoResult(model, copy) {
  const text = copy.stereo;
  const { measurement } = model;
  if (!measurement) return text.resultPrompt;
  const headline = measurement.close ? text.measured.close : text.measured.off;
  const formula = `${model.focal} × ${model.baseline} ÷ ${measurement.shift} = ${metres(measurement.depth)} m`;
  const gap = pixels(measurement.error * CENTIMETRES_PER_METRE);
  const comparison = `実際 ${metres(measurement.distance)} mとの差：${gap} cm`;
  return html`<strong>${headline}</strong>${paragraph([formula, comparison])}`;
}

function stereoControls(model, copy, actions) {
  const text = copy.stereo;
  return html`<p class="eyebrow">${text.eyebrow}</p>
    <h2>${text.heading}</h2>
    <p>${text.intro}</p>
    ${slider({
      id: 'vsDistance',
      label: '実際の奥行き',
      value: pixels(model.distance),
      min: 0.8,
      max: 3,
      step: 0.1,
      suffix: ' m',
      onInput: actions.setDistance,
    })}
    <hr />
    <p>${text.alignmentIntro}</p>
    <div id="vsAlignment">${alignmentStrip(model, copy)}</div>
    ${slider({
      id: 'vsShift',
      label: '右の点を右へ動かす量',
      value: model.shift,
      min: 1,
      max: 30,
      step: 0.5,
      suffix: ' px',
      onInput: actions.setShift,
    })}
    <button class="primary full" id="vsMeasure" @click=${actions.measure}>
      このずれから距離を計算する
    </button>
    <div id="vsResult" class="depth-result" role="status">${stereoResult(model, copy)}</div>
    ${helpDetails(text.help)}`;
}

function stereoHistory(model, copy) {
  const text = copy.stereo.evidence;
  if (!model.history.length) return nothing;
  const row = (entry) =>
    `実際 ${metres(entry.distance)} m ／ 視差 ${pixels(entry.shift)} px → 計算 ${metres(entry.depth)} m`;
  return html`<details>
    <summary>${text.historySummary}</summary>
    ${model.history.slice(-STEREO_HISTORY_ROWS).map((entry) => html`<p>${row(entry)}</p>`)}
  </details>`;
}

function stereoEvidence(model, copy) {
  const text = copy.stereo.evidence;
  return html`<h2>${text.title}</h2>
    <p>${text.text}</p>
    ${helpDetails(text.help)} ${stereoHistory(model, copy)}`;
}

function stereoReflect(copy) {
  const text = copy.stereo.reflect;
  return html`<h2>${text.title}</h2>
    ${text.paragraphs.map(paragraph)}`;
}

// ---- RGBと奥行きを使う ------------------------------------------------------------------------

function rgbdControls(model, copy, actions) {
  const text = copy.rgbd;
  return html`<p class="eyebrow">${text.eyebrow}</p>
    <h2>${text.heading}</h2>
    <p>${model.imported ? text.intro.imported : text.intro.sample}</p>
    ${checkbox({
      id: 'vdUseDepth',
      label: text.useDepthLabel,
      checked: model.useDepth,
      onChange: actions.setUseDepth,
    })}
    ${slider({
      id: 'vdMax',
      label: '残す奥行きの上限',
      value: model.maxDepth,
      min: 0.5,
      max: 4,
      step: 0.1,
      suffix: ' m',
      onInput: actions.setMaxDepth,
    })}
    <button id="vdRun" class="primary full" @click=${actions.run}>この条件で荷箱を選ぶ</button>
    ${select({
      id: 'vdCondition',
      label: text.conditionLabel,
      value: model.condition,
      disabled: model.imported,
      onChange: actions.setCondition,
      options: Object.entries(text.conditionNames),
    })}
    <p class="helper">${text.helper}</p>
    ${helpDetails(text.help)}`;
}

// RGB and depth of the one pixel the learner picked.
function pickedPixel(model, copy) {
  const text = copy.rgbd.evidence;
  const { picked } = model;
  const point = picked.point;
  const rgbLine = `RGB：${picked.rgb.join(' / ')}`;
  const straightLine = point && Math.hypot(point.x, point.y, point.z);
  const depthLine = point
    ? `奥行き Z：${metres(point.z)} m ／ カメラからの直線距離：${metres(straightLine)} m`
    : text.depthUnknown;
  const position = point
    ? `カメラ基準の位置：右 X ${metres(point.x)} m・下 Y ${metres(point.y)} m・正面 Z ${metres(point.z)} m`
    : null;
  return html`<strong>横 ${picked.u}・縦 ${picked.v} の画素</strong>${paragraph([
      rgbLine,
      depthLine,
    ])}${position ? html`<p>${position}</p>` : nothing}`;
}

function selectionSummary(model, copy, actions) {
  const text = copy.rgbd;
  const { selection } = model;
  if (!selection) return text.evidence.noSelection;
  // The summary describes the run, so it keeps the mode that run used.
  const method = selection.usedDepth ? '色＋奥行き' : '色だけ';
  // The learner's own log has no answer key, so target and background are not counted.
  const breakdown = model.imported
    ? ''
    : ` ／ 手前 ${selection.target}・それ以外 ${selection.background}画素`;
  const counts = `赤い画素のうち、奥行きが不明：${selection.unknown}画素${breakdown}`;
  return html`<strong>${method}で選んだ画素：${selection.selected}</strong>
    <p>${counts}</p>
    <button id="vdMap" class="small" @click=${actions.showDepthImage}>奥行き画像に戻す</button>`;
}

function rgbdEvidence(model, copy, actions) {
  const text = copy.rgbd.evidence;
  return html`<h2>${text.title}</h2>
    <div id="vdPoint" class="depth-result">${pickedPixel(model, copy)}</div>
    <div id="vdSelection" class="depth-result">${selectionSummary(model, copy, actions)}</div>
    ${helpDetails(text.help)}`;
}

function rgbdReflect(copy) {
  const text = copy.rgbd.reflect;
  return html`<h2>${text.title}</h2>
    ${text.paragraphs.map(paragraph)}`;
}

export {
  stereoControls,
  stereoDiagram,
  stereoEvidence,
  stereoReflect,
  rgbdControls,
  rgbdEvidence,
  rgbdReflect,
};
