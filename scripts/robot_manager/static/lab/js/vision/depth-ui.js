import { render } from '../vendor/lit-html.js';
import { loadJson } from '../core/content.js';
import { formatNumber } from '../core/dom.js';
import {
  DEPTH_CAMERA,
  stereoProjection,
  depthFromDisparity,
  rgbdScene,
  depthImage,
  depthPoint,
  selectDepthPixels,
} from '../core/depth-core.js';
import { drawStereoMarker, drawPickedPixel } from './depth-render.js';
import {
  stereoControls,
  stereoDiagram,
  stereoEvidence,
  stereoReflect,
  rgbdControls,
  rgbdEvidence,
  rgbdReflect,
} from './depth-view.js';

// The two depth chapters of the vision course: state and behaviour of "左右の像から測る" (stereo)
// and "RGBと奥行きを使う" (RGB-D). ui.js builds the page skeleton (image pair, status line,
// containers) and basics.js hands this module the chapter through renderDepth(); the templates
// live in depth-view.js, the canvas overlays in depth-render.js and the maths in
// js/core/depth-core.js. Texts live in content/vision/depth.json.

const copy = await loadJson('content/vision/depth.json');

// Chapter id → [page heading, lead sentence], as ui.js expects.
const DEPTH_CONTENT = Object.fromEntries(
  Object.entries(copy.chapters).map(([id, chapter]) => [id, [chapter.title, chapter.lead]]),
);

const TAPE_LATERAL = -0.21; // metres; the taped box sits left of the optical axis
const MARK_HEIGHT = 0.125; // metres; height of the black mark (point A) above the camera axis
const DISTANCE_TOLERANCE = 0.1; // metres; "10 cm以内" counts as a successful measurement
const TARGET_PIXELS = 100; // pixels of the near box that must survive for a clean selection
const DEFAULT_PICK = { u: 118, v: 126 }; // pixel on the near box of the sample scene

// Experiment settings, kept while the learner moves between chapters.
const stereo = { distance: 1.2, shift: 6, history: [], measurement: null };
const settings = { condition: 'normal', useDepth: false, maxDepth: 1.8 };

let imported = null; // RGB-D log the learner opened, instead of the sample scene
let picked = DEFAULT_PICK;
let selection = null; // last run of the RGB-D chapter; null until the learner runs it
let outputShows = 'depth'; // 'depth' or 'selection' — which image the right canvas holds
let sampleFrame = null; // memoised rgbdScene() for the condition it was built with
let sampleCondition = null;
let page = null; // what ui.js handed over: the shared page callbacks

const byId = (id) => document.getElementById(id);
const setText = (id, text) => {
  byId(id).textContent = text;
};
const renderInto = (id, template) => render(template, byId(id));
const pixels = (value) => formatNumber(value, 1);

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

// ---- the RGB-D frame under study ---------------------------------------------------------------

// rgbdScene() ray-traces the whole image, so the sample frame is kept until the condition changes.
function activeFrame() {
  if (imported) return imported;
  if (!sampleFrame || sampleCondition !== settings.condition) {
    sampleFrame = rgbdScene(settings);
    sampleCondition = settings.condition;
  }
  return sampleFrame;
}

function forgetRun() {
  selection = null;
  outputShows = 'depth';
}

function setDepthFrame(frame) {
  imported = frame;
  picked = { u: Math.floor(frame.width / 2), v: Math.floor(frame.height / 2) };
  forgetRun();
}

function clearDepthFrame() {
  imported = null;
  picked = DEFAULT_PICK;
  forgetRun();
}

function getDepthFrame() {
  return imported;
}

// The RGB image ui.js shows as the chapter's source.
function depthSource(chapter) {
  const frame =
    chapter === 'stereo'
      ? rgbdScene({ targetZ: stereo.distance, cameraX: -DEPTH_CAMERA.baseline / 2 })
      : activeFrame();
  return { width: frame.width, height: frame.height, data: frame.rgb };
}

const rgbImage = (frame) => ({ width: frame.width, height: frame.height, data: frame.rgb });

// ---- 左右の像から測る ---------------------------------------------------------------------------

function stereoModel() {
  const projection = stereoProjection(stereo.distance, { lateral: TAPE_LATERAL });
  return {
    distance: stereo.distance,
    shift: stereo.shift,
    disparity: projection.disparity,
    projection,
    history: stereo.history,
    measurement: stereo.measurement,
    focal: DEPTH_CAMERA.fx,
    baseline: DEPTH_CAMERA.baseline,
  };
}

// The two imaging units of the one device, each with point A marked on it.
function drawStereoPair(model) {
  const markY = DEPTH_CAMERA.cy + (DEPTH_CAMERA.fy * MARK_HEIGHT) / model.distance;
  const views = [
    { id: 'visionInput', cameraX: -DEPTH_CAMERA.baseline / 2, x: model.projection.left },
    { id: 'visionOutput', cameraX: DEPTH_CAMERA.baseline / 2, x: model.projection.right },
  ];
  for (const view of views) {
    const canvas = byId(view.id);
    const frame = rgbdScene({ targetZ: model.distance, cameraX: view.cameraX });
    page.showImage(canvas, rgbImage(frame));
    drawStereoMarker(canvas, { x: view.x, y: markY });
  }
  const note = (x) => `模擬画像 · 点Aの横位置 ${pixels(x)} px`;
  setText('visionInputNote', note(model.projection.left));
  setText('visionOutputNote', note(model.projection.right));
}

function updateStereo() {
  const model = stereoModel();
  renderInto('visionControls', stereoControls(model, copy, stereoActions));
  showMotion(stereoDiagram(model, copy));
  showEvidence(stereoEvidence(model, copy));
  drawStereoPair(model);
}

function openStereo() {
  stereo.measurement = null;
  setText('visionInputTitle', copy.stereo.inputTitle);
  setText('visionOutputTitle', copy.stereo.outputTitle);
  updateStereo();
  page.setStatus(copy.stereo.status.initial);
  renderInto('visionReflect', stereoReflect(copy));
  setText('visionTakeaway', copy.stereo.takeaway);
}

const stereoActions = {
  setDistance(value) {
    stereo.distance = value;
    stereo.measurement = null;
    updateStereo();
    page.setStatus(copy.stereo.status.distanceChanged);
  },
  setShift(value) {
    stereo.shift = value;
    stereo.measurement = null;
    updateStereo();
  },
  measure() {
    const depth = depthFromDisparity(stereo.shift);
    const error = Math.abs(depth - stereo.distance);
    stereo.measurement = {
      shift: stereo.shift,
      depth,
      distance: stereo.distance,
      error,
      close: error <= DISTANCE_TOLERANCE,
    };
    stereo.history.push({ distance: stereo.distance, shift: stereo.shift, depth });
    updateStereo();
    page.setStatus(stereo.measurement.close ? copy.stereo.status.close : copy.stereo.status.off);
  },
};

// ---- RGBと奥行きを使う ------------------------------------------------------------------------

function rgbdModel() {
  const frame = activeFrame();
  const start = (picked.v * frame.width + picked.u) * 4;
  return {
    imported: Boolean(imported),
    condition: settings.condition,
    useDepth: settings.useDepth,
    maxDepth: settings.maxDepth,
    picked: {
      u: picked.u,
      v: picked.v,
      rgb: Array.from(frame.rgb.slice(start, start + 3)),
      point: depthPoint(frame, picked.u, picked.v),
    },
    selection,
  };
}

function drawRgbdImages() {
  const frame = activeFrame();
  const input = byId('visionInput');
  page.showImage(input, rgbImage(frame));
  drawPickedPixel(input, picked);
  const output = byId('visionOutput');
  if (outputShows === 'selection') {
    page.showImage(output, selection);
    return;
  }
  page.showImage(output, depthImage(frame));
  drawPickedPixel(output, picked);
}

function updateRgbd() {
  const model = rgbdModel();
  const showingSelection = outputShows === 'selection';
  renderInto('visionControls', rgbdControls(model, copy, rgbdActions));
  showEvidence(rgbdEvidence(model, copy, rgbdActions));
  setText('visionOutputTitle', showingSelection ? copy.rgbd.selectionTitle : copy.rgbd.outputTitle);
  setText('visionOutputNote', showingSelection ? copy.rgbd.selectionNote : copy.rgbd.depthLegend);
  drawRgbdImages();
}

// The image pair belongs to ui.js, so the picking handler is attached to its canvases directly.
function bindPicking() {
  for (const id of ['visionInput', 'visionOutput']) byId(id).onclick = pickPixel;
}

function pickPixel(event) {
  const frame = activeFrame();
  const box = event.currentTarget.getBoundingClientRect();
  const within = (value, limit) => Math.max(0, Math.min(limit - 1, Math.floor(value)));
  picked = {
    u: within(((event.clientX - box.left) / box.width) * frame.width, frame.width),
    v: within(((event.clientY - box.top) / box.height) * frame.height, frame.height),
  };
  // Looking at a pixel puts the depth image back, so RGB and depth stay side by side.
  outputShows = 'depth';
  updateRgbd();
}

function runStatus(result) {
  const status = copy.rgbd.status;
  if (imported) return result.selected + status.importedSuffix;
  if (result.target > TARGET_PIXELS && result.background === 0) return status.targetOnly;
  if (!result.target) return status.noTarget;
  return status.background;
}

function openRgbd() {
  const frame = activeFrame();
  setText('visionInputTitle', copy.rgbd.inputTitle);
  setText('visionSourceName', copy.rgbd.sourceNames[imported ? 'imported' : 'sample']);
  setText('visionInputNote', `${frame.width} × ${frame.height} 画素`);
  updateRgbd();
  bindPicking();
  page.setStatus(copy.rgbd.status.initial);
  renderInto('visionReflect', rgbdReflect(copy));
  setText('visionTakeaway', copy.rgbd.takeaway);
}

const rgbdActions = {
  setUseDepth(checked) {
    settings.useDepth = checked;
    updateRgbd();
    page.setStatus(copy.rgbd.status.useDepthChanged);
  },
  setMaxDepth(value) {
    settings.maxDepth = value;
    updateRgbd();
    page.setStatus(copy.rgbd.status.maxDepthChanged);
  },
  setCondition(value) {
    settings.condition = value;
    forgetRun();
    openRgbd();
  },
  run() {
    selection = { ...selectDepthPixels(activeFrame(), settings), usedDepth: settings.useDepth };
    outputShows = 'selection';
    updateRgbd();
    page.setStatus(runStatus(selection));
  },
  showDepthImage() {
    forgetRun();
    openRgbd();
  },
};

// ---- entry point ------------------------------------------------------------------------------

function renderDepth(chapter, api) {
  page = api;
  if (chapter === 'stereo') openStereo();
  else openRgbd();
}

export { DEPTH_CONTENT, setDepthFrame, clearDepthFrame, getDepthFrame, depthSource, renderDepth };
