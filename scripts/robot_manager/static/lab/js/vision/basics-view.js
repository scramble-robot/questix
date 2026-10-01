import { html, svg, nothing } from '../vendor/lit-html.js';
import { formatNumber } from '../core/dom.js';
import { fillSentence } from '../core/content.js';
import { slider, select, helpDetails, checkbox } from './controls-view.js';

// Templates of the vision foundation chapters (capture, regions, geometry, line following).
// Every function is pure: it turns the model built by basics.js into markup for one of the
// containers that ui.js provides (controls, evidence, motion, reflection, pending note).
// Learner-facing sentences come from content/vision/basics.json (`copy`); only short labels
// live here.

const HISTORY_ROWS = 4; // most recent runs listed under "これまでの結果"
const REGION_ROWS = 6; // largest regions listed with centre and area
// Histogram drawing units: one bin every `pitch`, bars `barWidth` wide, `height` tall at the peak.
const HISTOGRAM = { pitch: 10, barWidth: 8, height: 100 };
const GEOMETRY_DIAGRAM = {
  cameraFront: 145, // svg x where the depth axis starts
  pixelsPerMetre: 95, // svg x per metre of depth
  axisY: 73,
  targetHalfHeightPerMetre: 80, // svg px of half target height per metre of target width
};
const WHEEL_DIAMETER = 0.13; // metres
const STRAIGHT_AHEAD_DEGREES = 0.05; // below this the direction reads 「正面」
const SECONDS_PER_MINUTE = 60;

const wheelRpm = (metresPerSecond) =>
  formatNumber((metresPerSecond / (Math.PI * WHEEL_DIAMETER)) * SECONDS_PER_MINUTE);

// Rows shown from the tail of a history list, numbered from the first run.
function recentRuns(history, rows = HISTORY_ROWS) {
  const shown = history.slice(-rows);
  const firstNumber = history.length - shown.length + 1;
  return shown.map((entry, index) => ({ number: firstNumber + index, entry }));
}

// The answer stays folded until the learner has predicted it (C1).
function reflection({ title, text, hint }, copy) {
  return html`<h2>${title}</h2>
    <details class="reflection-answer">
      <summary>予想してから答えを見る</summary>
      <p>${text}</p>
    </details>
    <details>
      <summary>${copy.hintSummary}</summary>
      <p>${hint}</p>
    </details>`;
}

function pendingNote(message, copy) {
  return html`<strong>${copy.pendingHeading}</strong><span>${message}</span>`;
}

// ---- 撮り方を変える ---------------------------------------------------------------------------

function captureControls(model, copy, actions) {
  const text = copy.capture;
  const { capture } = model;
  // On a phone the images are far above these sliders, so a small copy of the changed image
  // (drawn by basics.js) stays pinned at the top of this card while the sliders move.
  return html`<p class="eyebrow">${text.eyebrow}</p>
    <h2>${text.heading}</h2>
    <p>${text.intro}</p>
    <figure class="vision-preview" aria-hidden="true">
      <canvas id="vcPreview" width="320" height="220"></canvas>
      <figcaption>${fillSentence(text.previewCaption, { white: model.whiteRatio })}</figcaption>
    </figure>
    ${slider({
      id: 'vcExposure',
      label: '明るさの倍率',
      value: capture.exposure,
      min: 0.15,
      max: 3,
      step: 0.05,
      suffix: '倍',
      onInput: actions.setExposure,
    })}
    ${slider({
      id: 'vcBlur',
      label: '横方向のぶれ',
      value: capture.blur,
      min: 0,
      max: 18,
      suffix: ' px',
      onInput: actions.setBlur,
    })}
    ${select({
      id: 'vcWidth',
      label: '横の画素数',
      value: capture.width,
      onChange: (value) => actions.setWidth(Number(value)),
      options: [
        [320, '320画素'],
        [160, '160画素'],
        [80, '80画素'],
        [40, '40画素'],
      ],
    })}
    <button class="full" id="vcReset" @click=${actions.reset}>基準の写り方に戻す</button>
    <p class="helper">${text.helper}</p>`;
}

const shares = (bins) => {
  const total = bins.reduce((sum, count) => sum + count, 0) || 1;
  return bins.map((count) => count / total);
};

// The outline of the reference histogram, as one step line over the bars.
function stepOutline(values, peak) {
  const { pitch, height } = HISTOGRAM;
  const y = (value) => height - (height * value) / peak;
  return values
    .map(
      (value, index) => `${index ? 'L' : 'M'}${index * pitch} ${y(value)}H${(index + 1) * pitch}`,
    )
    .join('');
}

// Now (filled bars) against the reference (grey dotted outline), on one scale of "share of the
// pixels", so the two can be compared although the images have different pixel counts (V5). The
// last bin is the clipped band, its bar in the danger colour so a tall one stands out. Every label is HTML, so it stays readable on a phone.
function histogram(model, copy) {
  const text = copy.capture.histogram;
  const now = shares(model.histogram);
  const before = shares(model.baseline);
  const peak = Math.max(...now, ...before) || 1;
  const { pitch, barWidth, height } = HISTOGRAM;
  const width = now.length * pitch;
  return html`<figure class="vision-histogram-figure">
    <figcaption>${text.title}</figcaption>
    <div class="vision-histogram-plot">
      <span class="vision-histogram-y">${text.yAxis}</span>
      <svg
        class="vision-histogram"
        viewBox=${`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label=${copy.capture.histogramLabel}
      >
        <rect x=${width - pitch} y="0" width=${pitch} height=${height} fill="#f6d5d2" />
        ${now.map(
          (value, index) =>
            svg`<rect x=${index * pitch + (pitch - barWidth) / 2} y=${height - (height * value) / peak} width=${barWidth} height=${(height * value) / peak} fill=${index === now.length - 1 ? 'var(--role-danger)' : 'var(--role-measured)'}/>`,
        )}
        <path
          d=${stepOutline(before, peak)}
          fill="none"
          stroke="#6d7c83"
          stroke-width="2"
          stroke-dasharray="2 3"
          vector-effect="non-scaling-stroke"
        />
        <line
          x1="0"
          x2=${width}
          y1=${height}
          y2=${height}
          stroke="#8fa3a8"
          vector-effect="non-scaling-stroke"
        />
      </svg>
    </div>
    <div class="vision-histogram-x">
      <span>0 暗い</span><span>${text.xAxis}</span><span>明るい 255</span>
    </div>
    <ul class="vision-histogram-key">
      <li><i class="key-now" aria-hidden="true"></i>${text.now}</li>
      <li><i class="key-before" aria-hidden="true"></i>${text.before}</li>
      <li><i class="key-clipped" aria-hidden="true"></i>${text.clipped}</li>
    </ul>
  </figure>`;
}

function captureEvidence(model, copy) {
  const text = copy.capture;
  return html`<h2>${text.evidenceTitle}</h2>
    ${histogram(model, copy)}
    <p class="vision-histogram-readout">
      白飛びに近い画素：<b>${model.whiteRatio}%</b>　画素数：<b
        >${model.pixelCount.toLocaleString()}</b
      >
    </p>
    <p>${text.evidenceText}</p>`;
}

// ---- まとまりを見つける -----------------------------------------------------------------------

function regionFilters(model, copy, actions) {
  const text = copy.regions;
  return html`<div class="vision-region-controls">
    <h3>${text.filterHeading}</h3>
    ${slider({
      id: 'vrArea',
      label: '残すまとまりの面積',
      value: model.region.minArea,
      min: 1,
      max: 3000,
      suffix: '画素以上',
      onInput: actions.setMinArea,
    })}
    <p>${text.areaNote}</p>
    ${checkbox({
      id: 'vrRoi',
      label: text.roiLabel,
      checked: model.region.roi,
      onChange: actions.setRoi,
    })}
    <p>${text.roiNote}</p>
  </div>`;
}

function regionCleanup(model, copy, actions) {
  const text = copy.regions;
  return html`<details class="vision-adjust">
    <summary>${text.adjustSummary}</summary>
    <p>${text.adjustNote}</p>
    ${select({
      id: 'vrOperation',
      label: '選んだ白い部分を整える',
      value: model.region.operation,
      onChange: actions.setOperation,
      options: [
        ['none', '処理しない'],
        ['open', '小さな白い点を除く'],
        ['close', '白い部分の小さな穴を埋める'],
        ['both', '点を除いて、穴を埋める'],
      ],
    })}
    ${slider({
      id: 'vrRadius',
      label: '周囲を見る範囲',
      value: model.region.radius,
      min: 1,
      max: 4,
      suffix: ' px',
      onInput: actions.setRadius,
    })}
  </details>`;
}

function regionControls(model, copy, actions) {
  const text = copy.regions;
  return html`<p class="eyebrow">${text.eyebrow}</p>
    <h2>${text.heading}</h2>
    <p>${text.intro}</p>
    <button id="vrRun" class="primary full" @click=${actions.run}>この条件で目印を探す</button>
    ${select({
      id: 'vrScene',
      label: '場面',
      value: model.region.scene,
      disabled: model.external,
      onChange: actions.setScene,
      options: [
        ['clean', '部屋をそのまま見る'],
        ['noise', '細かい点や欠けが混ざった画像'],
        ['dark', '同じ画像を暗くする'],
      ],
    })}
    ${select({
      id: 'vrMethod',
      label: '色を選ぶ方法',
      value: model.region.method,
      onChange: actions.setMethod,
      options: [
        ['rgb', '赤さの差で選ぶ（RGB）'],
        ['hsv', '色合いで選ぶ（HSV）'],
      ],
    })}
    ${regionFilters(model, copy, actions)} ${regionCleanup(model, copy, actions)}
    ${helpDetails(text.help)}`;
}

function regionEvidenceTitle(result, text) {
  if (!result.score) return text.unscored;
  return result.success ? text.success : text.scored;
}

// The three kinds of box, with the same colour, line and symbol as in the image (V6).
function regionScore(score, text) {
  if (!score) return html`<p>${text.unscoredNote}</p>`;
  return html`<div class="vision-metrics vision-region-key">
      <span data-kind="correct"
        ><i aria-hidden="true"></i>✓ 正しく囲んだ目印 <b>${score.found}/2</b></span
      ><span data-kind="extra"
        ><i aria-hidden="true"></i>✕ 余計な枠 <b>${score.falsePositive}</b></span
      ><span data-kind="missed"
        ><i aria-hidden="true"></i>？ 見逃した目印 <b>${score.missed}</b></span
      >
    </div>
    <p>${text.scoringNote}</p>`;
}

const VERDICT_SYMBOLS = { correct: '✓', extra: '✕' };

function regionList(result, text) {
  const { regions, match } = result;
  if (!regions.length) return text.noRegions;
  return regions
    .slice(0, REGION_ROWS)
    .map(
      (region, index) =>
        html`<span data-kind=${match ? match.verdicts[index] : 'unscored'}
          ><b>${index + 1}${match ? ' ' + VERDICT_SYMBOLS[match.verdicts[index]] : ''}</b> 中心
          (${Math.round(region.cx)}, ${Math.round(region.cy)}) · ${region.area}画素</span
        >`,
    );
}

function regionHistory(history, copy) {
  const text = copy.regions;
  if (!history.length) return nothing;
  return html`<details>
    <summary>${text.evidence.historySummary}</summary>
    ${recentRuns(history).map(
      ({ number, entry }) =>
        html`<p>
          ${number}回目：${text.sceneNames[entry.scene]}／${entry.method.toUpperCase()}／${
            text.operationNames[entry.operation]
          }／面積${entry.area}以上／${entry.roi ? '下側だけ' : '全体'}
          → 目印${entry.score.found}/2・余計${entry.score.falsePositive}
        </p>`,
    )}
  </details>`;
}

function regionEvidence(model, copy) {
  const text = copy.regions.evidence;
  const { result } = model;
  return html`<h2>${regionEvidenceTitle(result, text)}</h2>
    ${regionScore(result.score, text)}
    <div class="vision-region-list">${regionList(result, text)}</div>
    ${regionHistory(model.history, copy)}`;
}

// ---- RGBだけで距離は分かる？ ------------------------------------------------------------------

function geometryControls(model, copy, actions) {
  const text = copy.geometry;
  const { geometry } = model;
  return html`<p class="eyebrow">${text.eyebrow}</p>
    <h2>${text.heading}</h2>
    <p>${text.intro}</p>
    ${slider({
      id: 'vgDistance',
      label: '実際の奥行き',
      value: geometry.distance,
      min: 0.6,
      max: 4,
      step: 0.1,
      suffix: ' m',
      onInput: (value) => actions.setPlacement('distance', value),
    })}
    ${slider({
      id: 'vgWidth',
      label: '実際の目印の幅',
      value: geometry.width,
      min: 0.1,
      max: 0.6,
      step: 0.05,
      suffix: ' m',
      onInput: (value) => actions.setPlacement('width', value),
    })}
    ${slider({
      id: 'vgLateral',
      label: '中心から右への位置',
      value: geometry.lateral,
      min: -0.4,
      max: 0.4,
      step: 0.05,
      suffix: ' m',
      onInput: (value) => actions.setPlacement('lateral', value),
    })}
    <button id="vgSame" class="full" @click=${actions.compareDoubled}>
      幅も距離も2倍の場面と比べる
    </button>
    <hr />
    <h3>${text.calculationHeading}</h3>
    ${slider({
      id: 'vgKnown',
      label: '計算に使う目印の幅',
      value: geometry.knownWidth,
      min: 0.1,
      max: 0.6,
      step: 0.05,
      suffix: ' m',
      onInput: (value) => actions.setPlacement('knownWidth', value),
    })}
    ${slider({
      id: 'vgFocal',
      label: '校正で調べる焦点距離',
      value: geometry.focal,
      min: 160,
      max: 340,
      step: 10,
      suffix: ' px',
      onInput: (value) => actions.setPlacement('focal', value),
    })}
    ${helpDetails(text.help)}`;
}

// Side view of the camera and the target, to scale with the sliders.
function geometryDiagram(model, copy) {
  const { geometry } = model;
  const { cameraFront, pixelsPerMetre, axisY, targetHalfHeightPerMetre } = GEOMETRY_DIAGRAM;
  const targetX = cameraFront + geometry.distance * pixelsPerMetre;
  const targetHalfHeight = geometry.width * targetHalfHeightPerMetre;
  return html`<div class="vision-world-diagram">
    <svg viewBox="0 0 640 160" role="img" aria-label=${copy.geometry.diagram.label}>
      <text x="20" y="22" fill="#45626d" font-size="15">${copy.geometry.diagram.caption}</text>
      <rect x="38" y="53" width="50" height="34" rx="6" fill="#397c72" />
      <path d="M88 60l18-8v36l-18-8z" fill="#397c72" />
      <text x="27" y="113" fill="#45626d" font-size="15">カメラ</text>
      <line
        x1="112"
        x2=${targetX}
        y1=${axisY}
        y2=${axisY}
        stroke="#648c84"
        stroke-dasharray="5 4"
      />
      <path
        d=${`M106 ${axisY}L${targetX} ${axisY - targetHalfHeight}M106 ${axisY}L${targetX} ${axisY + targetHalfHeight}`}
        fill="none"
        stroke="#be4937"
        stroke-width="1.5"
        stroke-dasharray="6 4"
        opacity=".7"
      />
      <rect
        x=${targetX}
        y=${axisY - targetHalfHeight}
        width="10"
        height=${targetHalfHeight * 2}
        fill="#be4937"
      />
      <text x=${targetX - 20} y="150" fill="#45626d" font-size="15">
        目印 ${Math.round(geometry.width * 100)} cm
      </text>
      <text x=${(112 + targetX) / 2} y="56" text-anchor="middle" fill="#45626d" font-size="15">
        奥行き ${formatNumber(geometry.distance)} m
      </text>
    </svg>
  </div>`;
}

// 「正面」 for a target straight ahead, otherwise the side and the angle (V7).
function directionText(angle) {
  if (Math.abs(angle) < STRAIGHT_AHEAD_DEGREES) return '正面';
  return `${angle < 0 ? '左' : '右'} ${formatNumber(Math.abs(angle))}°`;
}

function geometryEvidence(model, copy) {
  const text = copy.geometry.evidence;
  const { geometry, measurement } = model;
  const { target, angle, depth, clipped } = measurement;
  const direction = directionText(angle);
  return html`<h2>${text.title}</h2>
    <div class="vision-metrics">
      <span>左右の方向 <b>${direction}</b></span
      ><span>推定した奥行き <b>${clipped ? '範囲外' : formatNumber(depth, 2) + ' m'}</b></span>
    </div>
    <p>
      ${text.formula}<br />${geometry.focal} px × ${formatNumber(geometry.knownWidth, 2)} m ÷
      ${target.w} px ≈ ${formatNumber(depth, 2)} m
    </p>
    <p>${text.coordinates}</p>`;
}

// ---- ラインをたどる ---------------------------------------------------------------------------

function followControls(model, copy, actions) {
  const text = copy.follow;
  const { follow } = model;
  return html`<p class="eyebrow">${text.eyebrow}</p>
    <h2>${text.heading}</h2>
    <p>${text.intro}</p>
    <button id="vfRun" class="primary full" @click=${actions.run}>この設定で走らせる</button>
    ${slider({
      id: 'vfGain',
      label: 'ずれに対して曲がる強さ',
      value: follow.gain,
      min: 0,
      max: 6,
      step: 0.1,
      onInput: (value) => actions.setSetting('gain', value),
    })}
    ${slider({
      id: 'vfSpeed',
      label: '前進する速さ',
      value: follow.speed,
      min: 0.15,
      max: 0.65,
      step: 0.05,
      suffix: ' m/s',
      onInput: (value) => actions.setSetting('speed', value),
    })}
    ${slider({
      id: 'vfThreshold',
      label: '黒いラインと判断する明るさ',
      value: follow.threshold,
      min: 40,
      max: 180,
      step: 5,
      onInput: (value) => actions.setSetting('threshold', value),
    })}
    ${select({
      id: 'vfScene',
      label: 'コースの条件',
      value: follow.scene,
      onChange: actions.setScene,
      options: [
        ['normal', '白い床の連続したライン'],
        ['shadow', '途中に暗い床がある'],
        ['gap', '途中でラインが途切れる'],
      ],
    })}
    <p class="helper">${text.helper}</p>
    ${helpDetails(text.help)}`;
}

function playbackPlayer(model, actions) {
  const { trial } = model;
  return html`<div class="vision-motion-player">
    <button id="vfPlay" class="small" @click=${actions.togglePlay}>
      ${model.playing ? '一時停止' : '記録を再生'}
    </button>
    <button id="vfFirst" class="small" @click=${actions.rewind}>最初へ</button>
    <label for="vfFrame"
      >時刻 <output id="vfFrameValue">${formatNumber(model.frame.time)}秒</output></label
    >
    <input
      aria-label="記録を見る時刻"
      id="vfFrame"
      type="range"
      min="0"
      max=${trial.frames.length - 1}
      .value=${String(model.index)}
      @input=${(event) => actions.seek(Number(event.target.value))}
    />
  </div>`;
}

function followMotion(model, copy, actions) {
  const { command } = model.frame;
  return html`<div class="vision-motion-top">
      <strong>${copy.follow.motionTitle}</strong
      ><span id="vfWheels"
        >左車輪 ${wheelRpm(command.left)} rpm　／　右車輪 ${wheelRpm(command.right)} rpm</span
      >
    </div>
    ${model.trial ? playbackPlayer(model, actions) : nothing}
    <canvas
      id="vfMap"
      class="vision-follow-map"
      role="img"
      aria-label=${copy.follow.mapLabel}
    ></canvas>`;
}

function followHistory(history, copy) {
  const text = copy.follow;
  if (!history.length) return nothing;
  return html`<details>
    <summary>${text.evidence.historySummary}</summary>
    ${recentRuns(history).map(
      ({ number, entry }) =>
        html`<p>
          ${number}回目：強さ${entry.gain}／${entry.speed}
          m/s／明るさ${entry.threshold}／${text.sceneNames[entry.scene]} →
          ${text.outcomes[entry.outcome]}・平均${formatNumber(entry.error * 100)} cm
        </p>`,
    )}
  </details>`;
}

function followEvidence(model, copy) {
  const text = copy.follow;
  const { trial } = model;
  return html`<h2>${trial ? text.outcomes[trial.outcome] : text.evidence.beforeRun}</h2>
    ${
      trial
        ? html`<div class="vision-metrics">
              <span>走行時間 <b>${formatNumber(trial.seconds)}秒</b></span
              ><span>ラインからの平均のずれ <b>${formatNumber(trial.meanError * 100)} cm</b></span>
            </div>
            <p>${text.evidence.note}</p>`
        : nothing
    }
    ${followHistory(model.history, copy)}`;
}

export {
  reflection,
  pendingNote,
  captureControls,
  captureEvidence,
  regionControls,
  regionEvidence,
  geometryControls,
  geometryDiagram,
  geometryEvidence,
  followControls,
  followMotion,
  followEvidence,
};
