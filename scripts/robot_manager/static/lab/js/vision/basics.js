import { render } from '../vendor/lit-html.js';
import { loadJson, fillSentence as fill } from '../core/content.js';
import { formatNumber } from '../core/dom.js';
import { DEPTH_CONTENT, depthSource, renderDepth } from './depth-ui.js';
import {
  IMAGE_SIZE,
  cameraEffects,
  brightnessHistogram,
  nearWhiteFraction,
  colorMask,
  morphology,
  maskImage,
  connectedRegions,
  regionScene,
  evaluateRegions,
  matchRegions,
  projectedTarget,
  cameraGeometry,
  lineCamera,
  lineObservation,
  runLineTrial,
} from './basics-core.js';
import { makeVisionImage } from './images.js';
import {
  drawRoiShade,
  drawRegionBoxes,
  drawGeometryOverlay,
  drawLineOverlay,
  drawCourseMap,
} from './basics-render.js';
import {
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
} from './basics-view.js';

// Vision foundation chapters: state and behaviour of "撮り方を変える", "まとまりを見つける",
// "RGBだけで距離は分かる？" and "ラインをたどる". The stereo and RGB-D chapters live in
// depth-ui.js. ui.js builds the page skeleton (image pair, status line, containers) and calls
// renderFoundation() with the current source image; this module fills the containers it owns
// (controls, evidence, motion panel, reflection, pending note) from lit templates in
// basics-view.js and draws overlays through basics-render.js. Texts live in
// content/vision/basics.json.

const copy = await loadJson('content/vision/basics.json');

const VISION_CHAPTERS = [
  ['capture', '撮り方を変える', 0],
  ['pixels', '画素を調べる', 0],
  ['regions', 'まとまりを見つける', 0],
  ['geometry', 'RGBだけで距離は分かる？', 1],
  ['stereo', '左右の像から測る', 1],
  ['depth', 'RGBと奥行きを使う', 1],
  ['follow', 'ラインをたどる', 1],
  ['learn', '画像と正解で学ぶ', 2],
  ['marker', 'ARマーカーを読む', 2],
  ['face', '顔を見つける', 2],
];
const VISION_GROUPS = ['RGB画像を調べる', '奥行きと動きを調べる', '対象を見分ける'];
// Chapter id → [page heading, lead sentence], as ui.js expects.
const FOUNDATION_CONTENT = {
  ...DEPTH_CONTENT,
  ...Object.fromEntries(
    Object.entries(copy.chapters).map(([id, chapter]) => [id, [chapter.title, chapter.lead]]),
  ),
};
const DEPTH_CHAPTERS = ['stereo', 'depth'];

const CAPTURE_BASELINE = { exposure: 1, blur: 0, width: 320 }; // "基準の写り方"
const CLIPPED_SHARE = 40; // percent of near-white pixels from which the image counts as clipped
const STRONG_BLUR = 8; // pixels of horizontal blur that visibly widen the box edges
const SMALL_WIDTH = 80; // pixels; at this width thin patterns disappear
const ROI_TOP_FRACTION = 0.4; // share of the image height skipped by "画像の下60%だけを調べる"
const RENDER_FOCAL = 250; // pixels; the focal length the synthetic geometry image is drawn with
const TARGET_MIN_AREA = 10; // pixels; smallest red region accepted as the geometry target
const DEPTH_TOLERANCE = 0.15; // metres; larger estimation errors get the "mismatch" status
const DOUBLED_SCENE = { distance: 2, width: 0.4 }; // "幅も距離も2倍" (metres)
const SINGLE_SCENE = { distance: 1, width: 0.2 };
const PLAYBACK_PERIOD = 100; // milliseconds between recorded frames while replaying a trial
const IDLE_FRAME = { pose: { x: 0, y: 0, theta: 0 }, command: { left: 0, right: 0 }, time: 0 };
const LINE_CENTER_X = 59.5; // pixel column of the image centre in the 120 px line camera

// Experiment settings, kept while the learner moves between chapters.
const capture = { ...CAPTURE_BASELINE }; // starts at the reference, as the lesson's first step says
const region = {
  scene: 'clean',
  method: 'rgb',
  operation: 'none',
  radius: 1,
  minArea: 1,
  roi: false,
  history: [],
};
const geometry = { distance: 1, width: 0.2, lateral: 0, knownWidth: 0.2, focal: 250 };
const follow = {
  speed: 0.35,
  gain: 0.3,
  threshold: 90,
  scene: 'normal',
  trial: null,
  index: 0,
  history: [],
};

// What ui.js handed over for the chapter currently on screen: the source image, whether it is
// the learner's own image, and the callbacks that touch the shared parts of the page.
let page = null;
let regionResult = null; // last run of the regions chapter; the page rebuild clears it
let regionNote = ''; // caption under the regions output image
let measurement = null; // last successful measurement of the geometry chapter
let playbackTimer = null; // setInterval id while a line-following trial is replaying

const byId = (id) => document.getElementById(id);
const setText = (id, text) => {
  byId(id).textContent = text;
};
const renderInto = (id, template) => render(template, byId(id));

function showEvidence(template) {
  const evidence = byId('visionEvidence');
  evidence.hidden = false;
  render(template, evidence);
}

function showMotion(template) {
  const motion = byId('visionMotion');
  motion.hidden = false;
  render(template, motion);
}

function pendingVisionOutput(message) {
  byId('visionOutput').hidden = true;
  const pending = byId('visionPending');
  pending.hidden = false;
  render(pendingNote(message, copy), pending);
}

function foundationSource(chapter) {
  if (DEPTH_CHAPTERS.includes(chapter)) return depthSource(chapter);
  if (chapter === 'regions') return regionScene(region.scene).image;
  if (chapter === 'geometry') return projectedTarget(geometry).image;
  if (chapter === 'follow') return lineCamera(IDLE_FRAME.pose);
  return makeVisionImage();
}

// ---- 撮り方を変える ---------------------------------------------------------------------------

function captureModel() {
  const output = cameraEffects(page.source, capture);
  return {
    capture,
    output,
    histogram: brightnessHistogram(output),
    baseline: brightnessHistogram(cameraEffects(page.source, CAPTURE_BASELINE)),
    whiteRatio: Math.round(nearWhiteFraction(output) * 100),
    pixelCount: output.width * output.height,
  };
}

function captureStatus(model) {
  const status = copy.capture.status;
  if (model.whiteRatio > CLIPPED_SHARE) return status.clipped;
  if (capture.blur > STRONG_BLUR) return status.blurred;
  if (capture.width <= SMALL_WIDTH) return status.small;
  return status.explore;
}

// The small copy of the changed image beside the sliders (phones only, see css): pixels stay
// square blocks when the width is reduced, as in the image itself.
function drawPreview(preview, source) {
  if (!preview || !source?.width) return;
  const context = preview.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, preview.width, preview.height);
  context.drawImage(source, 0, 0, preview.width, preview.height);
}

function updateCapture() {
  const model = captureModel();
  renderInto('visionControls', captureControls(model, copy, captureActions));
  page.showImage(byId('visionOutput'), model.output);
  drawPreview(byId('vcPreview'), byId('visionOutput'));
  setText(
    'visionOutputNote',
    `${model.output.width} × ${model.output.height}画素 · 明るさ${formatNumber(capture.exposure, 2)}倍`,
  );
  showEvidence(captureEvidence(model, copy));
  page.setStatus(captureStatus(model));
}

function openCapture() {
  setText('visionOutputTitle', copy.capture.outputTitle);
  updateCapture();
  renderInto('visionReflect', reflection(copy.capture.reflect, copy));
  setText('visionTakeaway', copy.capture.takeaway);
}

const captureActions = {
  setExposure(value) {
    capture.exposure = value;
    updateCapture();
  },
  setBlur(value) {
    capture.blur = value;
    updateCapture();
  },
  setWidth(value) {
    capture.width = value;
    updateCapture();
  },
  reset() {
    Object.assign(capture, CAPTURE_BASELINE);
    updateCapture();
  },
};

// ---- まとまりを見つける -----------------------------------------------------------------------

function regionModel() {
  return { region, external: page.external, result: regionResult, history: region.history };
}

function drawRegionInput() {
  const input = byId('visionInput');
  page.showImage(input, page.source);
  if (region.roi) drawRoiShade(input, page.source, copy.regions.roiTag);
}

function drawRegionOutput() {
  if (!regionResult) {
    pendingVisionOutput(copy.regions.pending);
    return;
  }
  const output = byId('visionOutput');
  const { width, height } = page.source;
  page.showImage(output, maskImage(regionResult.mask, width, height));
  drawRegionBoxes(output, regionResult.regions, width, regionResult.match);
}

function updateRegions() {
  const model = regionModel();
  renderInto('visionControls', regionControls(model, copy, regionActions));
  drawRegionInput();
  drawRegionOutput();
  setText('visionOutputNote', regionNote);
  if (regionResult) showEvidence(regionEvidence(model, copy));
}

function openRegions() {
  regionResult = null;
  regionNote = copy.regions.notes.notRun;
  setText('visionOutputTitle', copy.regions.outputTitle);
  updateRegions();
  page.setStatus(copy.regions.status.initial);
  renderInto('visionReflect', reflection(copy.regions.reflect, copy));
  setText('visionTakeaway', copy.regions.takeaway);
}

function regionRunStatus({ score, success }) {
  const status = copy.regions.status;
  if (!score) return status.unscored;
  if (success) return status.success;
  if (score.missed) return status.missed;
  if (score.falsePositive === 1) return status.wallSign;
  return status.clutter;
}

function findRegions() {
  const { source, external } = page;
  const { width, height } = source;
  const raw = colorMask(source, { method: region.method, roi: region.roi ? ROI_TOP_FRACTION : 0 });
  const mask = morphology(raw, width, height, region.operation, region.radius);
  const regions = connectedRegions(mask, width, height, region.minArea);
  // The learner's own images have no answer key, so they are not scored.
  const targets = regionScene(region.scene).targets;
  const score = external ? null : evaluateRegions(regions, targets);
  const match = external ? null : matchRegions(regions, targets);
  const success = Boolean(score) && score.found === 2 && score.falsePositive === 0;
  return { mask, regions, score, match, success };
}

// A changed condition keeps the previous result on screen but marks it as stale.
function markRegionsStale() {
  regionNote = copy.regions.notes.stale;
  updateRegions();
  page.setStatus(copy.regions.status.changed);
}

const regionActions = {
  run() {
    regionResult = findRegions();
    if (regionResult.score)
      region.history.push({
        scene: region.scene,
        score: regionResult.score,
        method: region.method,
        operation: region.operation,
        area: region.minArea,
        roi: region.roi,
      });
    regionNote = `${regionResult.regions.length}個の領域 · 十字は中心`;
    updateRegions();
    page.setStatus(regionRunStatus(regionResult));
    page.revealScene();
  },
  setScene(value) {
    region.scene = value;
    page.replaceSample();
  },
  setMethod(value) {
    region.method = value;
    markRegionsStale();
  },
  setOperation(value) {
    region.operation = value;
    markRegionsStale();
  },
  setRadius(value) {
    region.radius = value;
    markRegionsStale();
  },
  setMinArea(value) {
    region.minArea = value;
    markRegionsStale();
  },
  setRoi(checked) {
    region.roi = checked;
    markRegionsStale();
  },
};

// ---- RGBだけで距離は分かる？ ------------------------------------------------------------------

function measureTarget(target) {
  const { angle, depth } = cameraGeometry(target, {
    knownWidth: geometry.knownWidth,
    focal: geometry.focal,
  });
  const clipped =
    target.x === 0 ||
    target.x + target.w === IMAGE_SIZE.width ||
    target.y === 0 ||
    target.y + target.h === IMAGE_SIZE.height;
  return { target, angle, depth, clipped };
}

function geometryStatus({ depth, clipped }) {
  const status = copy.geometry.status;
  if (clipped) return status.clipped;
  if (Math.abs(depth - geometry.distance) > DEPTH_TOLERANCE) return status.mismatch;
  return status.match;
}

function updateGeometry() {
  renderInto('visionControls', geometryControls({ geometry }, copy, geometryActions));
  showMotion(geometryDiagram({ geometry }, copy));
  // The image is always drawn with the fixed focal length; the slider only changes the calculation.
  const image = projectedTarget({ ...geometry, focal: RENDER_FOCAL }).image;
  const output = byId('visionOutput');
  page.showImage(byId('visionInput'), image);
  page.showImage(output, image);
  const target = connectedRegions(
    colorMask(image),
    IMAGE_SIZE.width,
    IMAGE_SIZE.height,
    TARGET_MIN_AREA,
  )[0];
  drawGeometryOverlay(output, target);
  setText(
    'visionInputNote',
    `奥行き ${formatNumber(geometry.distance)} m · 幅 ${Math.round(geometry.width * 100)} cm`,
  );
  if (!target) {
    page.setStatus(copy.geometry.status.offScreen);
    return;
  }
  measurement = measureTarget(target);
  setText(
    'visionOutputNote',
    `幅 ${target.w} px · 中心 (${formatNumber(target.cx)}, ${formatNumber(target.cy)})`,
  );
  showEvidence(geometryEvidence({ geometry, measurement }, copy));
  page.setStatus(geometryStatus(measurement));
}

function openGeometry() {
  measurement = null;
  setText('visionOutputTitle', copy.geometry.outputTitle);
  updateGeometry();
  renderInto('visionReflect', reflection(copy.geometry.reflect, copy));
  setText('visionTakeaway', copy.geometry.takeaway);
}

const geometryActions = {
  setPlacement(key, value) {
    geometry[key] = value;
    updateGeometry();
  },
  // A target twice as wide at twice the distance projects to the same size.
  compareDoubled() {
    const doubled =
      geometry.distance === DOUBLED_SCENE.distance && geometry.width === DOUBLED_SCENE.width;
    Object.assign(geometry, doubled ? SINGLE_SCENE : DOUBLED_SCENE, { lateral: 0 });
    updateGeometry();
    page.setStatus(copy.geometry.status.sameSize);
  },
};

// ---- ラインをたどる ---------------------------------------------------------------------------

const lastFrameIndex = () => follow.trial.frames.length - 1;
const currentFrame = () => follow.trial?.frames[follow.index] || IDLE_FRAME;

function followModel() {
  return {
    follow,
    trial: follow.trial,
    index: follow.index,
    playing: playbackTimer !== null,
    frame: currentFrame(),
    history: follow.history,
  };
}

function updateFollow() {
  const model = followModel();
  renderInto('visionControls', followControls(model, copy, followActions));
  showMotion(followMotion(model, copy, followActions));
  showEvidence(followEvidence(model, copy));
}

function lineNote(observation) {
  if (!observation.valid) return copy.follow.lineLost;
  const side = observation.error < 0 ? '左' : '右';
  return `中央から${side}へ ${formatNumber(Math.abs(observation.cx - LINE_CENTER_X))} px`;
}

// Camera image, detector mask and course map for the frame currently shown.
function drawFollowFrame() {
  const frame = currentFrame();
  const options = follow.trial?.options || {};
  const image = lineCamera(frame.pose, options);
  const observation = lineObservation(image, { threshold: options.threshold || follow.threshold });
  const output = byId('visionOutput');
  page.showImage(byId('visionInput'), image);
  page.showImage(output, maskImage(observation.mask, image.width, image.height));
  drawLineOverlay(output, observation);
  setText('visionInputNote', formatNumber(frame.time) + copy.follow.inputNoteSuffix);
  setText('visionOutputNote', lineNote(observation));
  drawCourseMap(
    byId('vfMap'),
    { gap: options.gap, frames: follow.trial?.frames, pose: frame.pose, lost: lostMark() },
    { start: 'スタート', goal: 'ゴール' },
  );
}

// The ✕ where the trial lost the line, shown with the last recorded frame.
function lostMark() {
  const trial = follow.trial;
  if (trial?.outcome !== 'lost' || follow.index !== lastFrameIndex()) return null;
  const last = trial.frames[lastFrameIndex()];
  return { pose: last.pose, label: fill(copy.follow.lostMark, { time: formatNumber(last.time) }) };
}

function showFrame() {
  updateFollow();
  drawFollowFrame();
}

function openFollow() {
  setText('visionOutputTitle', copy.follow.outputTitle);
  showFrame();
  page.setStatus(copy.follow.status.initial);
  renderInto('visionReflect', reflection(copy.follow.reflect, copy));
  setText('visionTakeaway', copy.follow.takeaway);
}

function pausePlayback() {
  if (playbackTimer === null) return false;
  clearInterval(playbackTimer);
  playbackTimer = null;
  return true;
}

function pauseVisionBasics() {
  const wasPlaying = pausePlayback();
  if (wasPlaying && page?.chapter === 'follow' && byId('visionMotion'))
    showMotion(followMotion(followModel(), copy, followActions));
}

function playbackTick() {
  follow.index = Math.min(lastFrameIndex(), follow.index + 1);
  showFrame();
  if (follow.index === lastFrameIndex()) pauseVisionBasics();
}

// The previous trial stays on screen until the learner runs again.
function markFollowStale() {
  pausePlayback();
  updateFollow();
  page.setStatus(copy.follow.status.changed);
}

const followActions = {
  run() {
    pausePlayback();
    follow.trial = runLineTrial({
      ...follow,
      gap: follow.scene === 'gap',
      shadow: follow.scene === 'shadow',
    });
    follow.index = lastFrameIndex();
    follow.history.push({
      success: follow.trial.success,
      outcome: follow.trial.outcome,
      seconds: follow.trial.seconds,
      error: follow.trial.meanError,
      gain: follow.gain,
      speed: follow.speed,
      threshold: follow.threshold,
      scene: follow.scene,
    });
    showFrame();
    page.setStatus(
      copy.follow.outcomes[follow.trial.outcome] +
        copy.follow.status.ranSuffix +
        (follow.trial.outcome === 'lost' ? copy.follow.status.lostHint : ''),
    );
    page.revealScene();
  },
  setSetting(key, value) {
    follow[key] = value;
    markFollowStale();
  },
  setScene(value) {
    follow.scene = value;
    markFollowStale();
  },
  seek(index) {
    pausePlayback();
    follow.index = index;
    showFrame();
  },
  rewind() {
    pausePlayback();
    follow.index = 0;
    showFrame();
  },
  togglePlay() {
    if (pausePlayback()) {
      updateFollow();
      return;
    }
    if (follow.index === lastFrameIndex()) follow.index = 0;
    playbackTimer = setInterval(playbackTick, PLAYBACK_PERIOD);
    showFrame();
  },
};

// ---- entry point ------------------------------------------------------------------------------

const OPENERS = {
  capture: openCapture,
  regions: openRegions,
  geometry: openGeometry,
  follow: openFollow,
};

function renderFoundation(chapter, api) {
  pauseVisionBasics();
  page = { chapter, ...api };
  if (DEPTH_CHAPTERS.includes(chapter)) {
    renderDepth(chapter, api);
    return;
  }
  OPENERS[chapter]();
}

export {
  VISION_CHAPTERS,
  VISION_GROUPS,
  FOUNDATION_CONTENT,
  pauseVisionBasics,
  foundationSource,
  renderFoundation,
  pendingVisionOutput,
};
