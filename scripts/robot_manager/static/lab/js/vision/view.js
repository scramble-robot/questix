import { html, nothing, unsafeHTML } from '../vendor/lit-html.js';
import { lessonLabel } from '../shell/lesson-ui.js';
import { lessonGuide, figureGuide } from '../shell/lesson-guide.js';
import { FACE_SCORE } from './face.js';

// Templates of the vision course page. Every function is pure: it turns the model built by ui.js
// (chapter, image source, chapter state, messages) into markup. Sentences come from
// content/vision/ui.json (`copy`); only short labels live here.
//
// Foundation chapters (撮り方, まとまり, 距離, 左右, RGB-D, ライン) are drawn by basics.js and
// depth-ui.js, which write straight into #visionControls, #visionEvidence, #visionReflect,
// #visionTakeaway, #visionMotion, the figure captions and #visionSourceName. For those chapters the
// model keeps every binding inside these elements at a value that does not change until the page
// is rebuilt, so lit never touches what those modules wrote.

const FEATURE_LABELS = { color: '色', both: '色と形', shape: '形' };

function pageHeading(title) {
  return html`<div class="page-heading">
    <div>
      <p class="eyebrow course-label">${unsafeHTML(lessonLabel('vision'))}</p>
      <h1>${title}</h1>
    </div>
  </div>`;
}

function groupNav(model, actions) {
  return html`<nav class="basics-topics vision-groups" aria-label="学ぶ順序">
    ${model.groups.map(
      (label, index) =>
        html`<button
          data-vision-group=${index}
          aria-pressed=${String(index === model.group)}
          @click=${() => actions.openGroup(index)}
        >
          <span>${index + 1}</span>${label}
        </button>`,
    )}
  </nav>`;
}

function chapterNav(model, actions) {
  return html`<nav class="vision-subtopics" aria-label="この段階の実験">
    ${model.groupChapters.map(
      (chapter) =>
        html`<button
          data-vision-chapter=${chapter.id}
          aria-pressed=${String(chapter.id === model.chapter)}
          @click=${() => actions.openChapter(chapter.id)}
        >
          ${chapter.label}
        </button>`,
    )}
  </nav>`;
}

function sourceBar(model, actions) {
  const depth = model.chapter === 'depth';
  return html`<div class="vision-sourcebar" ?hidden=${model.sceneOnly}>
    <span id="visionSourceName">${model.sourceName}</span>
    <div>
      <button id="visionSample" class="small" @click=${actions.restoreSample}>教材画像に戻す</button
      ><label class="vision-file small" ?hidden=${depth}
        >画像を開く<input
          id="visionFile"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          @change=${actions.openImageFile}
      /></label>
      <button id="visionCamera" class="small" ?hidden=${depth} @click=${actions.startCamera}>
        RGB画像を撮る</button
      ><button
        id="visionRobot"
        class="small run-mode-live-button"
        ?hidden=${depth}
        @click=${actions.useRobotCamera}
      >
        実機カメラの画像を使う</button
      ><label class="vision-file small" ?hidden=${!model.rgbdAllowed}
        >RGB-Dログを開く<input
          id="visionRGBDFile"
          type="file"
          accept="application/json,.json"
          @change=${actions.openRgbdFile}
      /></label>
    </div>
  </div>`;
}

function captureCard(model, copy, actions) {
  return html`<section class="card vision-capture" id="visionCapture" ?hidden=${!model.cameraOpen}>
    <video id="visionVideo" autoplay playsinline muted .srcObject=${model.stream}></video>
    <div>
      <p>${copy.frame.captureNote}</p>
      <button id="visionCaptureNow" class="primary" @click=${actions.captureFrame}>
        この1枚を使う</button
      ><button id="visionCameraStop" @click=${actions.stopCamera}>カメラを閉じる</button>
    </div>
  </section>`;
}

function pendingNote(message, copy) {
  if (!message) return nothing;
  return html`<strong>${copy.frame.pendingTitle}</strong><span>${message}</span>`;
}

function figureGuideNote(model, copy) {
  if (model.external && model.chapter !== 'learn')
    return html`<p class="figure-guide">
      <strong>${copy.frame.ownImageGuideTitle}</strong>${copy.frame.ownImageGuide}
    </p>`;
  return unsafeHTML(figureGuide('vision-' + model.chapter));
}

function pixelCell(cell) {
  return html`<i
    style=${`background:rgb(${cell.rgb[0]},${cell.rgb[1]},${cell.rgb[2]})`}
    class=${cell.selected ? 'selected' : nothing}
  ></i>`;
}

function pixelProbe(model, copy) {
  const probe = model.probe;
  return html`<div id="visionPixel" class="vision-pixel" ?hidden=${model.chapter !== 'pixels'}>
    <div id="visionPixelGrid">${probe ? probe.cells.map(pixelCell) : nothing}</div>
    <p id="visionPixelText">${probe ? probe.text : copy.frame.pixelHint}</p>
  </div>`;
}

function sceneCard(model, copy, actions) {
  const pending = model.messages.pending;
  return html`<section class="card vision-scene">
    <div id="visionMotion" class="vision-motion" hidden></div>
    <div class="vision-image-pair">
      <figure>
        <figcaption>
          <strong id="visionInputTitle">${copy.frame.inputTitle}</strong
          ><span id="visionInputNote">${model.messages.inputNote}</span>
        </figcaption>
        <canvas
          id="visionInput"
          width="320"
          height="220"
          role="img"
          aria-label=${copy.frame.inputAlt}
          @click=${actions.probePixel}
        ></canvas>
      </figure>
      <figure>
        <figcaption>
          <strong id="visionOutputTitle">${model.outputTitle}</strong
          ><span id="visionOutputNote">${model.messages.outputNote}</span>
        </figcaption>
        <canvas
          id="visionOutput"
          width="320"
          height="220"
          role="img"
          aria-label=${copy.frame.outputAlt}
          ?hidden=${Boolean(pending)}
        ></canvas>
        <div id="visionPending" class="vision-pending" ?hidden=${!pending}>
          ${pendingNote(pending, copy)}
        </div>
      </figure>
    </div>
    ${figureGuideNote(model, copy)}
    <div id="visionReading" class="vision-reading" role="status">${model.messages.status}</div>
    ${pixelProbe(model, copy)}
  </section>`;
}

// ---- 画素を調べる ---------------------------------------------------------------------------

function pixelsControls(model, copy, actions) {
  const text = copy.pixels.controls;
  return html`<p class="eyebrow">${text.eyebrow}</p>
    <h2>${text.heading}</h2>
    <p>${text.text}</p>
    <label class="vision-select"
      >処理の方法<select
        id="visionMode"
        .value=${model.pixels.mode}
        @change=${(event) => actions.setMode(event.target.value)}
      >
        <option value="red">赤い部分を取り出す</option>
        <option value="gray">明るさだけにする（グレースケール）</option>
        <option value="binary">明るさで白黒に分ける（二値化）</option>
        <option value="edge">明るさの境目を探す（輪郭）</option>
      </select></label
    >
    <label class="basics-slider" for="visionThreshold"
      >判断のしきい値 <output id="visionThresholdValue">${model.threshold}</output
      ><input
        id="visionThreshold"
        type="range"
        min="0"
        max="230"
        .value=${String(model.threshold)}
        ?disabled=${model.pixels.mode === 'gray'}
        @input=${(event) => actions.setThreshold(Number(event.target.value))}
    /></label>
    <button id="visionProcess" class="primary full" @click=${actions.process}>
      この条件で処理する
    </button>
    <label class="vision-select"
      >撮影する場面<select
        id="visionCondition"
        ?disabled=${model.external}
        .value=${model.pixels.condition}
        @change=${(event) => actions.setCondition(event.target.value)}
      >
        <option value="normal">明るい場所の赤い荷箱</option>
        <option value="dark">照明を暗くする</option>
        <option value="blue">青い荷箱に置き換える</option>
        <option value="clutter">背景にも赤い物を置く</option>
      </select></label
    >
    <p class="helper">${text.helper}</p>`;
}

// ---- 画像と正解で学ぶ -----------------------------------------------------------------------

function learningControls(model, copy, actions) {
  const text = copy.learn.controls;
  const learning = model.learning;
  return html`<p class="eyebrow">${text.eyebrow}</p>
    <h2>${text.heading}</h2>
    <p>${text.textBefore}<strong>${text.textLabel}</strong>${text.textAfter}</p>
    <div class="vision-labels">
      ${copy.labels.map(
        (name, label) =>
          html`<button
            data-vision-label=${label}
            ?disabled=${learning.reviewing}
            @click=${() => actions.addSample(label)}
          >
            ${name}として登録
          </button>`,
      )}
    </div>
    <button id="visionNewSample" class="full small" @click=${actions.newCandidate}>
      別の色・形の画像を用意する
    </button>
    <label class="vision-select"
      >分類の手がかり<select
        id="visionFeatures"
        .value=${learning.featureMode}
        @change=${(event) => actions.setFeatures(event.target.value)}
      >
        <option value="color">色だけ</option>
        <option value="both">色と形</option>
        <option value="shape">形だけ</option>
      </select></label
    >
    <button id="visionTrain" class="primary full" @click=${actions.train}>
      ${learning.samples.length}${text.trainSuffix}
    </button>
    <button id="visionTest" class="full" ?disabled=${!learning.trained} @click=${actions.test}>
      学習に使っていない10枚でテスト
    </button>
    <p class="helper">${text.helper}</p>
    <button id="visionDataSave" class="text-button" @click=${actions.saveDataset}>
      登録した画像とラベルを保存
    </button>`;
}

function sampleTile(sample, copy, actions) {
  const name = copy.labels[sample.label];
  const text = copy.learn.evidence;
  return html`<div>
    <button
      data-sample=${sample.id}
      aria-label=${name + text.registeredImage + sample.id}
      @click=${() => actions.showSample(sample.id)}
    >
      <img src=${sample.thumbnail} alt=${text.thumbnailAlt} /><span>${name}</span>
    </button>
    <button
      class="vision-remove"
      data-remove=${sample.id}
      aria-label=${text.removeImage + sample.id + text.removeSuffix}
      @click=${() => actions.removeSample(sample.id)}
    >
      ×
    </button>
  </div>`;
}

function testTile(result, index, copy, actions) {
  const correct = result.label === result.prediction.label;
  const verdict = copy.labels[result.prediction.label] || copy.learn.evidence.undecided;
  return html`<button
    data-test=${index}
    class=${correct ? 'correct' : 'incorrect'}
    @click=${() => actions.showTest(index)}
  >
    <img src=${result.thumbnail} alt=${result.condition + 'の' + copy.labels[result.label]} /><span
      >${correct ? '○' : '×'} ${verdict}</span
    ><small>${copy.learn.evidence.answerPrefix}${copy.labels[result.label]}</small>
  </button>`;
}

function historyLine(history, copy) {
  const text = copy.learn.evidence;
  const shown = history.slice(-4);
  const firstNumber = history.length - shown.length + 1;
  return shown
    .map(
      (entry, index) =>
        `${firstNumber + index}${text.attempt}${entry.correct}${text.correctSuffix}${entry.count}${text.countSuffix}${FEATURE_LABELS[entry.mode]}）`,
    )
    .join(' → ');
}

function learningEvidence(model, copy, actions) {
  const learning = model.learning;
  const text = copy.learn.evidence;
  return html`<div class="section-top">
      <h2>学習に使う画像 · ${learning.samples.length}${text.datasetSuffix}</h2>
      <span class="helper">${text.datasetNote}</span>
    </div>
    <div class="vision-dataset">
      ${learning.samples.map((sample) => sampleTile(sample, copy, actions))}
    </div>
    ${
      learning.testResults
        ? html`<h3>${text.testHeading}</h3>
            <div class="vision-test-grid">
              ${learning.testResults.map((result, index) => testTile(result, index, copy, actions))}
            </div>`
        : nothing
    }
    ${
      learning.history.length
        ? html`<p class="vision-history">${historyLine(learning.history, copy)}</p>`
        : nothing
    }`;
}

// ---- ARマーカーを読む -----------------------------------------------------------------------

function markerControls(model, copy, actions) {
  const text = copy.marker.controls;
  const marker = model.marker;
  const fixed = model.external; // an opened photo cannot be rotated or tilted
  return html`<p class="eyebrow">${text.eyebrow}</p>
    <h2>${text.heading}</h2>
    <p>${text.text}</p>
    <label class="vision-select"
      >教材画像のマーカー<select
        id="visionMarkerId"
        ?disabled=${fixed}
        .value=${String(marker.id)}
        @change=${(event) => actions.setMarkerId(Number(event.target.value))}
      >
        <option value="0">ArUco ID 0</option>
        <option value="1">ArUco ID 1</option>
        <option value="2">ArUco ID 2</option>
        <option value="3">ArUco ID 3</option>
      </select></label
    >
    <button id="visionMarkerRotate" class="full" ?disabled=${fixed} @click=${actions.rotateMarker}>
      90°回す
    </button>
    <label class="basics-slider"
      >斜めから見る<input
        id="visionMarkerTilt"
        type="range"
        min="0"
        max="36"
        .value=${String(marker.tilt)}
        ?disabled=${fixed}
        @input=${(event) => actions.setTilt(Number(event.target.value))}
    /></label>
    <label class="basics-check"
      ><input
        id="visionMarkerCover"
        type="checkbox"
        .checked=${marker.cover}
        ?disabled=${fixed}
        @change=${(event) => actions.setCover(event.target.checked)}
      />模様の一部を隠す</label
    >
    <label class="basics-slider" for="visionMarkerThreshold"
      >白黒に分けるしきい値 <output id="visionMarkerThresholdValue">${model.threshold}</output
      ><input
        id="visionMarkerThreshold"
        type="range"
        min="20"
        max="220"
        .value=${String(model.threshold)}
        @input=${(event) => actions.setThreshold(Number(event.target.value))}
    /></label>
    <button id="visionMarkerRead" class="primary full" @click=${actions.readMarker}>
      模様からIDを読み取る
    </button>
    <button id="visionMarkerPrint" class="full small" @click=${actions.saveMarkerSvg}>
      このIDの印刷用マーカーを保存
    </button>
    <p class="helper">${text.helper}</p>`;
}

function markerEvidence(reading, copy) {
  const text = copy.marker.evidence;
  const detection = reading.detection;
  return html`<h2>${text.heading}</h2>
    ${
      detection
        ? html`<div class="vision-bits">
              ${detection.bits.map((bit) => html`<span class=${bit ? 'white' : 'black'}>${bit}</span>`)}
            </div>
            <p>${text.bitsNote}</p>`
        : html`<p>${text.noFrame}</p>`
    }`;
}

// ---- 顔を見つける ---------------------------------------------------------------------------

function faceControls(model, copy, actions) {
  const text = copy.face.controls;
  const face = model.face;
  return html`<p class="eyebrow">${text.eyebrow}</p>
    <h2>${text.heading}</h2>
    <p>${text.text}</p>
    <button
      id="visionFaceLoad"
      class=${face.ready ? 'full' : 'primary full'}
      ?disabled=${face.busy}
      @click=${actions.loadDetector}
    >
      ${face.ready ? '検出器を準備済み' : '顔検出器を読み込む'}
    </button>
    <p class="helper">${text.loadHelper}</p>
    <button
      id="visionFacePhoto"
      class="full small"
      ?disabled=${face.busy}
      @click=${actions.loadSamplePhoto}
    >
      実写の教材画像を読み込む
    </button>
    <p class="helper">${text.photoHelper}</p>
    <button
      id="visionFaceRun"
      class="primary full"
      ?disabled=${!face.ready || face.busy}
      @click=${actions.detectFaces}
    >
      この画像から顔を検出する
    </button>
    <label class="basics-slider" for="visionScore"
      >表示するスコアの下限 <output id="visionScoreValue">${face.threshold}</output
      ><input
        id="visionScore"
        type="range"
        min=${FACE_SCORE.min}
        max=${FACE_SCORE.max}
        step=${FACE_SCORE.step}
        .value=${String(face.threshold)}
        @input=${(event) => actions.setScore(Number(event.target.value))}
    /></label>`;
}

function faceCandidate(candidate, index, copy) {
  const text = copy.face.evidence;
  return html`<span
    ><b>${index + 1}</b
    >${text.candidate}<b>${candidate.score.toFixed(1)}</b>${candidate.depthLabel}</span
  >`;
}

function faceEvidence(detection, copy) {
  const text = copy.face.evidence;
  return html`<h2>${text.heading}</h2>
    <p>${text.intro}</p>
    <p>${detection.hasDepth ? text.withDepth : text.withoutDepth}</p>
    ${
      detection.boxes.length
        ? html`<div class="vision-detections">
            ${detection.candidates.map((candidate, index) => faceCandidate(candidate, index, copy))}
          </div>`
        : html`<p>${text.none}</p>`
    }`;
}

// ---- shared cards ---------------------------------------------------------------------------

function controlPanel(model, copy, actions) {
  if (model.chapter === 'pixels') return pixelsControls(model, copy, actions);
  if (model.chapter === 'learn') return learningControls(model, copy, actions);
  if (model.chapter === 'marker') return markerControls(model, copy, actions);
  if (model.chapter === 'face') return faceControls(model, copy, actions);
  return nothing; // foundation chapters: filled by basics.js / depth-ui.js
}

function evidenceContent(model, copy, actions) {
  if (model.chapter === 'learn') return learningEvidence(model, copy, actions);
  if (model.chapter === 'marker' && model.marker.reading)
    return markerEvidence(model.marker.reading, copy);
  if (model.chapter === 'face' && model.face.detection)
    return faceEvidence(model.face.detection, copy);
  return null;
}

function reflectContent(reflect) {
  if (!reflect) return nothing;
  return html`<h2>${reflect.title}</h2>
    <p>${reflect.text}</p>
    <details ?data-help-dialog=${reflect.dialog}>
      <summary>${reflect.hintTitle}</summary>
      ${reflect.hints.map((hint) => html`<p>${hint}</p>`)}
    </details>`;
}

function footer(model, copy, actions) {
  return html`<div class="basics-footer">
    <p id="visionTakeaway">${model.takeaway}</p>
    <button class="primary" id="visionNext" @click=${actions.next}>${model.nextLabel}</button>
  </div>`;
}

function realRobotNote(copy, actions) {
  const text = copy.realRobot;
  return html`<details data-help-dialog class="method-note vision-real">
    <summary>${text.title}</summary>
    <div class="method-grid">
      <div>
        <h3>${text.captureHeading}</h3>
        <p>${text.captureText}</p>
        <button id="visionRosDownload" @click=${actions.saveCameraScript}>RGB画像の保存</button
        ><button id="visionRGBDDownload" @click=${actions.saveRgbdScript}>RGB-Dログの保存</button>
      </div>
      <div>
        <h3>${text.openHeading}</h3>
        <p>${text.openText}</p>
        <button id="visionGuideDownload" @click=${actions.saveGuide}>実機の実験手順</button>
      </div>
      <div>
        <h3>${text.cautionHeading}</h3>
        <p>${text.cautionText}</p>
      </div>
    </div>
  </details>`;
}

function referencesNote(referencesHtml) {
  return html`<details data-help-dialog class="method-note">
    <summary>この教材の計算と参考資料</summary>
    ${unsafeHTML(referencesHtml)}
  </details>`;
}

function visionPage(model, copy, referencesHtml, actions) {
  const evidence = evidenceContent(model, copy, actions);
  return html`<div id="visionRoot" data-chapter=${model.chapter}>
    ${pageHeading(model.title)}${groupNav(model, actions)}${chapterNav(model, actions)}
    ${unsafeHTML(lessonGuide('vision-' + model.chapter))}${sourceBar(model, actions)}
    ${captureCard(model, copy, actions)}
    <div class="experiment-layout vision-layout">
      <div class="vision-workspace">
        ${sceneCard(model, copy, actions)}
        <section id="visionEvidence" class="card vision-evidence" ?hidden=${!evidence}>
          ${evidence ?? nothing}
        </section>
      </div>
      <aside class="guide card" id="visionControls">${controlPanel(model, copy, actions)}</aside>
    </div>
    <section id="visionReflect" class="card vision-reflect">
      ${reflectContent(model.reflect)}
    </section>
    ${footer(model, copy, actions)}${realRobotNote(copy, actions)}${referencesNote(referencesHtml)}
  </div>`;
}

export { visionPage };
