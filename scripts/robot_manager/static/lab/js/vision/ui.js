import { render } from '../vendor/lit-html.js';
import { loadJson, loadText } from '../core/content.js';
import { downloadFile } from '../core/dom.js';
import { validateRGBD, depthInBox } from '../core/depth-core.js';
import { setDepthFrame, getDepthFrame, clearDepthFrame } from './depth-ui.js';
import {
  detectionTags,
  imageOperation,
  imageFeatures,
  trainImageClassifier,
  classifyImage,
  detectMarkers,
} from './core.js';
import { makeVisionImage, visionTestSet } from './images.js';
import { latestRobot, robotState } from '../live/robot-link.js';
import {
  FACE_SAMPLE_URL,
  FACE_SAMPLE_NAME,
  FACE_SCORE,
  loadFaceDetector,
  faceDetectorReady,
  detectFaces as detectFaceCandidates,
  selectFaces,
} from './face.js';
import { VISION_ROS_GUIDE, VISION_ROS_SCRIPT, VISION_RGBD_SCRIPT } from './ros.js';
import {
  VISION_CHAPTERS,
  VISION_GROUPS,
  FOUNDATION_CONTENT,
  foundationSource,
  renderFoundation,
  pauseVisionBasics,
} from './basics.js';
import {
  paintImage,
  imageDataUrl,
  markerImage,
  markerSvg,
  paintMarkerReading,
  paintFaceBoxes,
} from './render.js';
import { visionPage } from './view.js';
import { fillSentence as fill } from '../core/content.js';

// Vision course: state and behaviour. view.js turns the model into markup, render.js paints the
// canvases, core.js / images.js / face.js do the image maths. Sentences live in
// content/vision/ui.json.
//
// Six of the ten chapters (撮り方・まとまり・RGBだけで距離・左右・RGB-D・ライン) belong to
// basics.js and depth-ui.js, which fill #visionControls, #visionEvidence, #visionReflect,
// #visionTakeaway, #visionMotion and the figure captions imperatively. This module builds the page
// around them and hands them `showImage` / `setStatus` / `replaceSample`. Every model value inside
// the elements they own stays constant until the page is rebuilt, so lit never overwrites what
// those modules wrote; only the status line is shared, and there both write the same sentence.

const copy = await loadJson('content/vision/ui.json');
const referencesHtml = await loadText('content/vision/ui-references.html');

const FIRST_CHAPTER = 'capture';
const MAX_SAMPLES = 40; // labelled images the learner may keep
const MAX_IMAGE_BYTES = 12_000_000;
const MAX_RGBD_BYTES = 16_000_000;
const MAX_IMAGE_PIXELS = 24_000_000;
const LONGEST_EDGE = 960; // px an opened photo is scaled down to
const IMAGE_TIMEOUT = 30_000; // ms before an image that never loads is given up on
const PROBE_RADIUS = 4; // pixels shown either side of the probed one
const TAGGED_FACES = 30; // candidates that get a number drawn on the image
const DARK_LIGHT = 0.55; // brightness factor of the "照明を暗くする" scene
const CAMERA_REQUEST = { width: 640, height: 480 };
const SCENE_ONLY_CHAPTERS = ['geometry', 'follow', 'stereo']; // no image source to choose
const RGBD_CHAPTERS = ['depth', 'face']; // the only chapters that can open an RGB-D log
// Switching into or out of one of these always starts from the teaching image again.
const DEPTH_LINKED_CHAPTERS = ['geometry', 'follow', 'stereo', 'depth'];

const state = {
  chapter: FIRST_CHAPTER,
  started: false,
  source: null,
  sourceName: copy.sourceNames.initial,
  external: false, // the image came from the learner or the robot, not from the course
  sourceVersion: 0, // bumped on every source change; cancels image loads started for an older one
  reviewingTest: false,
  outputTitle: '',
  takeaway: '',
  reflect: null,
  probe: null,
  threshold: 60, // shared by 画素を調べる and ARマーカーを読む, as in the original page
  condition: 'normal',
  candidate: 0, // which of the four teaching objects the next sample image shows
  messages: { status: '', inputNote: '', outputNote: '', pending: null },
  pixels: { mode: 'red', applied: null },
  learn: {
    samples: [],
    nextId: 1,
    featureMode: 'color',
    classifier: null,
    testResults: null,
    history: [],
  },
  marker: { id: 0, turn: 0, tilt: 0, cover: false, reading: null },
  face: { busy: false, threshold: FACE_SCORE.initial, candidates: null },
  camera: { stream: null, request: 0 },
};

// Sentences with several numbers in them are kept whole in the content file and filled here;
// sentences with one value use a before/after pair, as elsewhere in the course.
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const page = () => document.getElementById('visionPage');
const inputCanvas = () => document.getElementById('visionInput');
const outputCanvas = () => document.getElementById('visionOutput');
const isFoundation = (chapter) => Boolean(FOUNDATION_CONTENT[chapter]);
const chapterAt = (index) => VISION_CHAPTERS[index];
const chapterIndex = (id) => VISION_CHAPTERS.findIndex(([key]) => key === id);
const groupOf = (id) => VISION_CHAPTERS[chapterIndex(id)][2];
const cloneImage = (image) => ({
  width: image.width,
  height: image.height,
  data: new Uint8ClampedArray(image.data),
});
const imageSize = (image) => `${image.width} × ${image.height}${copy.frame.pixelCount}`;

// The card under every experiment: a question, a paragraph, and one or more hints behind a
// summary — inline for the short hints, in the reference dialog for the longer notes.
function reflectCard(section, { title = section.title, dialog = false } = {}) {
  return {
    title,
    text: section.text,
    hintTitle: section.hintTitle,
    hints: section.hints || [section.hint],
    dialog,
  };
}

// ---- the model -------------------------------------------------------------------------------

function chapterTitle(id) {
  const foundation = FOUNDATION_CONTENT[id];
  return foundation ? foundation[0] : copy[id].title;
}

function nextLabel() {
  if (state.chapter === 'face') return copy.frame.quizButton;
  const next = chapterAt(chapterIndex(state.chapter) + 1);
  return copy.frame.nextPrefix + next[1] + copy.frame.nextSuffix;
}

// Candidates above the learner's score limit, with the numbered tags and depth readings that the
// image overlay and the list of candidates both need.
function faceDetection() {
  const source = state.source;
  const boxes = selectFaces(state.face.candidates, state.face.threshold);
  const tagged = boxes.slice(0, TAGGED_FACES);
  const tags = detectionTags(tagged, source.width, source.height);
  const frame = getDepthFrame();
  const hasDepth = Boolean(frame) && source.data === frame.rgb;
  return {
    image: source,
    boxes,
    tagged,
    tags,
    hasDepth,
    candidates: tagged.map((box) => ({
      score: box.score,
      depthLabel: hasDepth ? depthLabel(depthInBox(frame, box)) : '',
    })),
  };
}

function depthLabel(measurement) {
  const text = copy.face.evidence;
  if (!measurement) return '';
  if (measurement.depth === null) return text.depthUnknown;
  return text.depthPrefix + measurement.depth.toFixed(2) + text.depthSuffix;
}

function buildModel() {
  const chapter = state.chapter;
  const group = groupOf(chapter);
  return {
    chapter,
    title: chapterTitle(chapter),
    groups: VISION_GROUPS,
    group,
    groupChapters: VISION_CHAPTERS.filter((entry) => entry[2] === group).map(([id, label]) => ({
      id,
      label,
    })),
    sourceName: state.sourceName,
    external: state.external,
    sceneOnly: SCENE_ONLY_CHAPTERS.includes(chapter),
    rgbdAllowed: RGBD_CHAPTERS.includes(chapter),
    cameraOpen: Boolean(state.camera.stream),
    stream: state.camera.stream,
    threshold: state.threshold,
    outputTitle: state.outputTitle,
    takeaway: state.takeaway,
    reflect: state.reflect,
    nextLabel: nextLabel(),
    messages: state.messages,
    probe: state.probe,
    pixels: { mode: state.pixels.mode, condition: state.condition },
    learning: {
      samples: state.learn.samples,
      featureMode: state.learn.featureMode,
      trained: Boolean(state.learn.classifier),
      testResults: state.learn.testResults,
      history: state.learn.history,
      reviewing: state.reviewingTest,
    },
    marker: state.marker,
    face: {
      ready: faceDetectorReady(),
      busy: state.face.busy,
      threshold: state.face.threshold,
      detection: state.face.candidates ? faceDetection() : null,
    },
  };
}

function update() {
  render(visionPage(buildModel(), copy, referencesHtml, actions), page());
}

function setStatus(text) {
  state.messages.status = text;
  update();
}

// ---- the image the chapter works on ------------------------------------------------------------

function teachingImage() {
  const chapter = state.chapter;
  if (isFoundation(chapter)) return foundationSource(chapter);
  if (chapter === 'marker') return markerImage(state.marker);
  const learning = chapter === 'learn';
  return makeVisionImage({
    kind: learning ? state.candidate % 2 : 0,
    color: teachingColor(),
    light: state.condition === 'dark' ? DARK_LIGHT : 1,
    variant: state.candidate,
    clutter: chapter === 'pixels' && state.condition === 'clutter',
  });
}

function teachingColor() {
  if (state.chapter === 'learn') return state.candidate < 2 ? 'red' : 'blue';
  return state.condition === 'blue' ? 'blue' : 'red';
}

function useTeachingImage() {
  state.external = false;
  state.sourceName =
    state.chapter === 'regions' ? copy.sourceNames.regionsSample : copy.sourceNames.sample;
  state.source = teachingImage();
  invalidate();
}

// Everything computed from the previous image is void; the status line starts empty again.
function invalidate() {
  state.reviewingTest = false;
  state.sourceVersion++;
  state.pixels.applied = null;
  state.marker.reading = null;
  state.face.candidates = null;
  state.messages.status = '';
}

// ---- building the page -------------------------------------------------------------------------

// The output canvas keeps the last picture the learner asked for, even while the pending note
// covers it, so painting happens exactly where the experiment produces a new picture — never as a
// side effect of an unrelated update().
function paintSource() {
  paintImage(inputCanvas(), state.source);
  paintImage(outputCanvas(), state.source);
}

// A chapter page is built from scratch, as learners expect when they open another experiment:
// details, focus and scroll start fresh and the foundation modules get an empty page to fill.
function rebuild() {
  stopCamera();
  pauseVisionBasics();
  state.outputTitle = '';
  state.takeaway = '';
  state.reflect = null;
  state.probe = null;
  state.messages.inputNote = imageSize(state.source);
  state.messages.outputNote = '';
  state.messages.pending = null;
  render(null, page());
  update();
  paintSource();
  if (isFoundation(state.chapter)) renderFoundation(state.chapter, foundationApi());
  else refreshChapter();
}

function refreshChapter() {
  if (state.chapter === 'pixels') refreshPixels();
  else if (state.chapter === 'learn') refreshLearning();
  else if (state.chapter === 'marker') refreshMarker();
  else refreshFace();
}

function openChapter(id) {
  const previous = state.chapter;
  state.chapter = id;
  stopCamera();
  pauseVisionBasics();
  const keepImage =
    !state.reviewingTest &&
    state.external &&
    !DEPTH_LINKED_CHAPTERS.includes(id) &&
    !DEPTH_LINKED_CHAPTERS.includes(previous);
  if (keepImage) invalidate();
  else useTeachingImage();
  rebuild();
}

// basics.js and depth-ui.js draw their chapters themselves; this is the whole contract between
// them and this module.
function foundationApi() {
  return {
    source: state.source,
    external: state.external,
    showImage,
    setStatus,
    replaceSample() {
      useTeachingImage();
      rebuild();
    },
  };
}

// Their canvases are outside the model, so showing an image there also reveals the output canvas.
function showImage(canvas, image) {
  if (canvas.id === 'visionOutput') {
    document.getElementById('visionPending').hidden = true;
    canvas.hidden = false;
  }
  paintImage(canvas, image);
}

// ---- 画素を調べる --------------------------------------------------------------------------------

function refreshPixels() {
  state.outputTitle = copy.pixels.outputTitle;
  state.reflect = reflectCard(copy.pixels.reflect);
  state.takeaway = copy.pixels.takeaway;
  if (state.pixels.applied) paintImage(outputCanvas(), state.pixels.applied.image);
  else {
    state.messages.pending = copy.pixels.pending;
    state.messages.outputNote = copy.pixels.notes.idle;
    state.messages.status = copy.pixels.status.initial;
  }
  setProbe(Math.floor(state.source.width / 2), Math.floor(state.source.height / 2));
  update();
}

function setProbe(x, y) {
  const source = state.source;
  const start = (y * source.width + x) * 4;
  const rgb = Array.from(source.data.slice(start, start + 3));
  const cells = [];
  for (let row = y - PROBE_RADIUS; row <= y + PROBE_RADIUS; row++)
    for (let column = x - PROBE_RADIUS; column <= x + PROBE_RADIUS; column++) {
      const index =
        (clamp(row, 0, source.height - 1) * source.width + clamp(column, 0, source.width - 1)) * 4;
      cells.push({
        rgb: [source.data[index], source.data[index + 1], source.data[index + 2]],
        selected: column === x && row === y,
      });
    }
  state.probe = {
    cells,
    text: fill(copy.pixels.probe, { x, y, red: rgb[0], green: rgb[1], blue: rgb[2] }),
  };
}

function appliedNote(mode, threshold) {
  const notes = copy.pixels.notes;
  if (mode === 'red') return notes.red + threshold;
  if (mode === 'binary') return notes.binary + threshold;
  return notes[mode];
}

function appliedStatus(mode, result) {
  const status = copy.pixels.status;
  if (mode !== 'red') return status.otherModes;
  return fill(status.selected, {
    total: state.source.width * state.source.height,
    selected: result.selected,
  });
}

// ---- 画像と正解で学ぶ ----------------------------------------------------------------------------

function refreshLearning() {
  const learn = state.learn;
  if (!learn.classifier) state.messages.pending = copy.learn.pending;
  state.outputTitle = copy.learn.outputTitle;
  state.messages.outputNote = learn.classifier
    ? copy.learn.notes.trained
    : copy.learn.notes.untrained;
  state.reflect = reflectCard(copy.learn.reflect, {
    title: learn.testResults ? copy.learn.reflect.titleTested : copy.learn.reflect.titleUntested,
  });
  state.takeaway = copy.learn.takeaway;
  if (learn.classifier) showPrediction();
  else
    state.messages.status =
      copy.learn.status.reviewBefore + learn.samples.length + copy.learn.status.reviewAfter;
  update();
}

// Shows which labelled image the classifier found closest to the current one.
function showPrediction() {
  const learn = state.learn;
  if (!learn.classifier) return;
  const prediction = classifyImage(learn.classifier, state.source);
  const nearest = learn.samples.find((sample) => sample.id === prediction.neighbors[0]?.id);
  paintImage(outputCanvas(), nearest?.image || state.source);
  state.messages.pending = null;
  state.messages.outputNote =
    prediction.label === null
      ? copy.learn.notes.undecided
      : copy.learn.notes.verdict + copy.labels[prediction.label];
  state.messages.status = prediction.neighbors.length
    ? copy.learn.status.nearestBefore +
      copy.labels[prediction.neighbors[0].label] +
      copy.learn.status.nearestAfter
    : prediction.reason;
}

function rememberSample(label, image) {
  const learn = state.learn;
  learn.samples.push({ id: learn.nextId++, label, image, thumbnail: imageDataUrl(image) });
}

function forgetClassifier() {
  state.learn.classifier = null;
  state.learn.testResults = null;
}

function useImage(image, name) {
  state.source = image;
  state.sourceName = name;
  state.external = true;
  invalidate();
}

// ---- ARマーカーを読む ----------------------------------------------------------------------------

function refreshMarker() {
  state.outputTitle = copy.marker.outputTitle;
  state.reflect = reflectCard(copy.marker.reflect, { dialog: true });
  state.takeaway = copy.marker.takeaway;
  state.messages.pending = copy.marker.pending.initial;
  state.messages.status = copy.marker.status.initial;
  update();
}

// Re-draws the teaching marker after a change that only the image depends on (tilt), leaving the
// previous reading on the output canvas until the learner reads the pattern again.
function redrawMarker() {
  useTeachingImage();
  paintImage(inputCanvas(), state.source);
  state.messages.pending = copy.marker.pending.tilted;
  state.messages.outputNote = copy.marker.notes.idle;
  state.messages.status = copy.marker.status.tilted;
  update();
}

function markerNote(detection) {
  const notes = copy.marker.notes;
  if (!detection || detection.id === null || detection.id === undefined) return notes.undecided;
  return notes.idPrefix + detection.id + notes.errorsBefore + detection.errors + notes.errorsAfter;
}

// ---- 顔を見つける --------------------------------------------------------------------------------

function refreshFace() {
  state.outputTitle = copy.face.outputTitle;
  state.reflect = reflectCard(copy.face.reflect, { dialog: true });
  state.takeaway = copy.face.takeaway;
  showDetection();
  if (!state.face.candidates) {
    state.messages.pending = copy.face.pending.initial;
    state.messages.status = state.messages.status || copy.face.status.initial;
  }
  update();
}

function showDetection() {
  if (!state.face.candidates) {
    state.messages.outputNote = copy.face.notes.idle;
    state.messages.pending = copy.face.pending.noResult;
    return;
  }
  const detection = faceDetection();
  paintFaceBoxes(outputCanvas(), detection);
  state.messages.pending = null;
  state.messages.outputNote = detectionNote(detection);
}

function detectionNote(detection) {
  const notes = copy.face.notes;
  const overflow = detection.boxes.length > TAGGED_FACES ? notes.topOnly : '';
  const clipped = detection.tags.some((tag) => !tag) ? notes.overflow : '';
  return (
    detection.boxes.length + notes.candidatesSuffix + state.face.threshold + overflow + clipped
  );
}

// ---- image sources ------------------------------------------------------------------------------

// Decodes a URL into the source image, scaled down to a size the experiments can compute on.
// A source change started before the learner moved on is dropped when it finally arrives.
function readImage(url, name, revoke) {
  const requestChapter = state.chapter;
  const requestVersion = state.sourceVersion;
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (!revoke) image.crossOrigin = 'anonymous';
    const release = () => {
      if (revoke) URL.revokeObjectURL(url);
    };
    const timer = setTimeout(() => {
      image.src = '';
      release();
      reject(Error(copy.errors.imageTimeout));
    }, IMAGE_TIMEOUT);
    image.onload = () => {
      clearTimeout(timer);
      try {
        if (requestChapter !== state.chapter || requestVersion !== state.sourceVersion) {
          resolve();
          return;
        }
        clearDepthFrame();
        if (image.width * image.height > MAX_IMAGE_PIXELS)
          throw Error(copy.errors.imageTooManyPixels);
        useImage(scaleToCanvas(image), name);
        rebuild();
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        release();
      }
    };
    image.onerror = () => {
      clearTimeout(timer);
      release();
      reject(Error(copy.errors.imageUnreadable));
    };
    image.src = url;
  });
}

// White background first: a transparent PNG would otherwise arrive as black pixels.
function scaleToCanvas(image) {
  const scale = Math.min(1, LONGEST_EDGE / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = 'white';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

// Takes the newest frame relayed from the robot (live link); it then follows the same path as an
// opened file.
function useRobotCamera() {
  const frame = latestRobot('camera');
  if (!frame) {
    setStatus(
      robotState().phase === 'open' ? copy.errors.robotNoFrame : copy.errors.robotNotConnected,
    );
    return;
  }
  stopCamera();
  readImage(URL.createObjectURL(frame), copy.sourceNames.robotCamera, true).catch((error) =>
    setStatus(error.message),
  );
}

function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus(copy.errors.cameraUnavailable);
    return;
  }
  const version = state.sourceVersion;
  const request = ++state.camera.request;
  navigator.mediaDevices
    .getUserMedia({ video: CAMERA_REQUEST, audio: false })
    .then((stream) => {
      const wanted =
        request === state.camera.request && !page().hidden && version === state.sourceVersion;
      if (!wanted) {
        stopTracks(stream);
        return;
      }
      stopCamera();
      state.camera.stream = stream;
      update();
    })
    .catch(() => setStatus(copy.errors.cameraDenied));
}

const stopTracks = (stream) => stream.getTracks().forEach((track) => track.stop());

function stopCamera() {
  state.camera.request++;
  if (!state.camera.stream) return;
  stopTracks(state.camera.stream);
  state.camera.stream = null;
}

function captureFrame() {
  clearDepthFrame();
  const video = document.getElementById('visionVideo');
  if (!video.videoWidth) {
    setStatus(copy.errors.cameraWaiting);
    return;
  }
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, LONGEST_EDGE / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  stopCamera();
  useImage(context.getImageData(0, 0, canvas.width, canvas.height), copy.sourceNames.webcam);
  rebuild();
}

async function loadImageFile(file) {
  if (file.size > MAX_IMAGE_BYTES) throw Error(copy.errors.imageTooLarge);
  await readImage(URL.createObjectURL(file), file.name, true);
}

async function loadRgbdFile(file) {
  const requestChapter = state.chapter;
  const version = state.sourceVersion;
  if (file.size > MAX_RGBD_BYTES) throw Error(copy.errors.rgbdTooLarge);
  const frame = validateRGBD(JSON.parse(await file.text()));
  if (state.chapter !== requestChapter || state.sourceVersion !== version) return;
  setDepthFrame(frame);
  useImage({ width: frame.width, height: frame.height, data: frame.rgb }, copy.sourceNames.rgbdLog);
  rebuild();
}

// ---- what the learner can do --------------------------------------------------------------------

const actions = {
  openChapter,
  openGroup(index) {
    openChapter(VISION_CHAPTERS.find((entry) => entry[2] === index)[0]);
  },
  next() {
    if (state.chapter === 'face') {
      document.dispatchEvent(new CustomEvent('quiz-open', { detail: 'vision' }));
      return;
    }
    openChapter(chapterAt(chapterIndex(state.chapter) + 1)[0]);
    document.getElementById('visionRoot').scrollIntoView({ block: 'start' });
  },

  restoreSample() {
    clearDepthFrame();
    useTeachingImage();
    rebuild();
  },
  async openImageFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
      await loadImageFile(file);
    } catch (error) {
      setStatus(error.message);
    }
  },
  async openRgbdFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
      await loadRgbdFile(file);
    } catch (error) {
      setStatus(error.message);
    }
  },
  startCamera,
  useRobotCamera,
  captureFrame,
  stopCamera() {
    stopCamera();
    update();
  },
  probePixel(event) {
    if (state.chapter !== 'pixels') return;
    const box = event.currentTarget.getBoundingClientRect();
    const source = state.source;
    setProbe(
      Math.min(
        source.width - 1,
        Math.floor(((event.clientX - box.left) / box.width) * source.width),
      ),
      Math.min(
        source.height - 1,
        Math.floor(((event.clientY - box.top) / box.height) * source.height),
      ),
    );
    update();
  },

  // 画素を調べる
  setMode(mode) {
    state.pixels.mode = mode;
    state.pixels.applied = null;
    refreshPixels();
  },
  setThreshold(value) {
    state.threshold = value;
    if (state.chapter === 'pixels') state.messages.status = copy.pixels.status.changed;
    update();
  },
  process() {
    const mode = state.pixels.mode;
    const threshold = state.threshold;
    const result = imageOperation(state.source, mode, threshold);
    state.pixels.applied = { image: result };
    paintImage(outputCanvas(), result);
    state.messages.pending = null;
    state.messages.outputNote = appliedNote(mode, threshold);
    state.messages.status = appliedStatus(mode, result);
    update();
  },
  setCondition(condition) {
    state.condition = condition;
    useTeachingImage();
    rebuild();
  },

  // 画像と正解で学ぶ
  addSample(label) {
    const learn = state.learn;
    if (learn.samples.length >= MAX_SAMPLES) {
      setStatus(copy.learn.status.tooManySamples);
      return;
    }
    if (!imageFeatures(state.source).valid) {
      setStatus(copy.learn.status.noObject);
      return;
    }
    rememberSample(label, cloneImage(state.source));
    forgetClassifier();
    refreshLearning();
    setStatus(copy.learn.status.registered);
  },
  removeSample(id) {
    state.learn.samples = state.learn.samples.filter((sample) => sample.id !== id);
    forgetClassifier();
    refreshLearning();
    setStatus(copy.learn.status.removed);
  },
  newCandidate() {
    state.candidate = (state.candidate + 1) % 4;
    state.condition = 'normal';
    useTeachingImage();
    rebuild();
  },
  setFeatures(mode) {
    state.learn.featureMode = mode;
    forgetClassifier();
    refreshLearning();
    setStatus(copy.learn.status.featuresChanged);
  },
  train() {
    const learn = state.learn;
    try {
      learn.classifier = trainImageClassifier(learn.samples, learn.featureMode);
      refreshLearning();
      showPrediction();
      setStatus(copy.learn.status.trained);
    } catch (error) {
      setStatus(error.message);
    }
  },
  test() {
    const learn = state.learn;
    learn.testResults = visionTestSet().map((item) => ({
      ...item,
      thumbnail: imageDataUrl(item.image),
      prediction: classifyImage(learn.classifier, item.image),
    }));
    const correct = learn.testResults.filter(
      (result) => result.label === result.prediction.label,
    ).length;
    learn.history.push({ correct, count: learn.samples.length, mode: learn.featureMode });
    refreshLearning();
    setStatus(copy.learn.status.testedBefore + correct + copy.learn.status.testedAfter);
  },
  showSample(id) {
    const sample = state.learn.samples.find((entry) => entry.id === id);
    useImage(cloneImage(sample.image), copy.sourceNames.trainingImage);
    rebuild();
    showPrediction();
    update();
  },
  showTest(index) {
    const result = state.learn.testResults[index];
    const nearest = result.prediction.neighbors[0];
    const notes = copy.learn.notes;
    const verdict = copy.labels[result.prediction.label] || notes.noVerdict;
    useImage(cloneImage(result.image), copy.sourceNames.testImage + result.condition);
    state.reviewingTest = true;
    rebuild();
    state.messages.inputNote =
      notes.testInput + (index + 1) + notes.testAnswer + copy.labels[result.label];
    state.messages.outputNote = notes.testOutput + verdict;
    state.messages.status =
      fill(copy.learn.status.testReview, {
        number: index + 1,
        condition: result.condition,
        answer: copy.labels[result.label],
        verdict,
      }) +
      (nearest
        ? copy.learn.status.testNeighborBefore +
          copy.labels[nearest.label] +
          copy.learn.status.testNeighborAfter
        : '') +
      copy.learn.status.testNotUsed;
    update();
    document.querySelector('.vision-scene').scrollIntoView({ block: 'start' });
  },
  saveDataset() {
    const dataset = {
      format: 'robo-lab-image-labels-v1',
      labels: copy.labels,
      samples: state.learn.samples.map((sample) => ({
        label: copy.labels[sample.label],
        image: sample.thumbnail,
      })),
    };
    downloadFile(
      'QUESTiX-LAB-画像とラベル.json',
      JSON.stringify(dataset, null, 2),
      'application/json',
    );
  },

  // ARマーカーを読む
  setMarkerId(id) {
    state.marker.id = id;
    useTeachingImage();
    rebuild();
  },
  rotateMarker() {
    state.marker.turn = (state.marker.turn + 1) % 4;
    useTeachingImage();
    rebuild();
  },
  setCover(cover) {
    state.marker.cover = cover;
    useTeachingImage();
    rebuild();
  },
  setTilt(tilt) {
    state.marker.tilt = tilt;
    redrawMarker();
  },
  readMarker() {
    const threshold = state.threshold;
    const detection = detectMarkers(state.source, threshold)[0] || null;
    const reading = {
      detection,
      binary: imageOperation(state.source, 'binary', threshold),
    };
    state.marker.reading = reading;
    paintMarkerReading(outputCanvas(), reading);
    state.messages.pending = null;
    state.messages.outputNote = markerNote(detection);
    state.messages.status =
      detection && detection.id !== null && detection.id !== undefined
        ? copy.marker.status.decoded
        : copy.marker.status.unreadable;
    update();
  },
  saveMarkerSvg() {
    downloadFile(
      'ArUco-4x4-ID' + state.marker.id + '.svg',
      markerSvg(state.marker.id),
      'image/svg+xml',
    );
  },

  // 顔を見つける
  async loadDetector() {
    const face = state.face;
    if (face.busy) return;
    face.busy = true;
    refreshFace();
    setStatus(copy.face.status.preparing);
    try {
      await loadFaceDetector((text) => {
        state.messages.status = text;
        if (state.chapter === 'face') update();
      });
      state.messages.status = copy.face.status.ready;
    } catch (error) {
      state.messages.status = copy.face.status.loadFailed + error.message;
    } finally {
      face.busy = false;
      if (state.chapter === 'face') refreshFace();
    }
  },
  async loadSamplePhoto() {
    try {
      setStatus(copy.face.status.loadingPhoto);
      await readImage(FACE_SAMPLE_URL, FACE_SAMPLE_NAME, false);
    } catch (error) {
      setStatus(error.message + copy.face.status.photoFailedHint);
    }
  },
  detectFaces() {
    const face = state.face;
    if (face.busy) return;
    try {
      face.candidates = detectFaceCandidates(cloneImage(state.source));
      state.messages.status = copy.face.status.detected;
    } catch (error) {
      face.candidates = null;
      state.messages.status = copy.face.status.detectFailed + error.message;
    }
    refreshFace();
  },
  setScore(threshold) {
    state.face.threshold = threshold;
    showDetection();
    update();
  },

  // ロボットのRGB-Dカメラで確かめる
  saveCameraScript() {
    downloadFile('robo_lab_camera_capture.py', VISION_ROS_SCRIPT, 'text/x-python');
  },
  saveRgbdScript() {
    downloadFile('robo_lab_rgbd_capture.py', VISION_RGBD_SCRIPT, 'text/x-python');
  },
  saveGuide() {
    downloadFile('QUESTiX-LAB-画像処理-実機手順.md', VISION_ROS_GUIDE, 'text/markdown');
  },
};

// ---- entry points --------------------------------------------------------------------------------

function leaveVision() {
  stopCamera();
  pauseVisionBasics();
  if (state.started) update();
}

function initVision() {
  document.addEventListener('series-leave', leaveVision);
  document.addEventListener('supplement-open', pauseVisionBasics);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) leaveVision();
  });
}

function activateVision() {
  if (!state.started) {
    state.started = true;
    for (let label = 0; label < 2; label++)
      for (let variant = 0; variant < 2; variant++)
        rememberSample(
          label,
          makeVisionImage({ kind: label, color: label ? 'blue' : 'red', variant }),
        );
    useTeachingImage();
  }
  rebuild();
}

function reviewVision(id) {
  if (chapterIndex(id) < 0) return false;
  openChapter(id);
  return true;
}

export { initVision, activateVision, reviewVision };
