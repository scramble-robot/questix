import { unpack_cascade, run_cascade, cluster_detections } from '../vendor/pico.js';

// Face detection runs entirely in the browser with files served next to this page:
// pico.js and its "facefinder" cascade (both MIT, see assets/vendor/NOTICE.md).
// Nothing is requested until the learner presses the load button, and no image leaves the device.
const FACE_CASCADE_URL = 'assets/vendor/facefinder.bin';
// NASA portrait of astronaut Eileen Collins (public domain), the scikit-image "astronaut" test image.
const FACE_SAMPLE_URL = 'assets/vision/face-sample.jpg';
const FACE_SAMPLE_NAME = 'NASAの宇宙飛行士の写真（パブリックドメイン）';
const FACE_SCORE = { min: 0, max: 40, step: 1, initial: 5 };

// The unpacked cascade, and the load in flight, so pressing the button twice fetches once.
let classify = null;
let loading = null;

function loadFaceDetector(onProgress = () => {}) {
  if (classify) return Promise.resolve(classify);
  if (loading) return loading;
  loading = (async () => {
    onProgress('顔検出器を読み込み中…');
    const response = await fetch(FACE_CASCADE_URL);
    if (!response.ok) throw Error('顔検出器のファイルを取得できませんでした。');
    classify = unpack_cascade(new Int8Array(await response.arrayBuffer()));
    return classify;
  })().finally(() => (loading = null));
  return loading;
}
function faceDetectorReady() {
  return !!classify;
}
function grayPlane(image) {
  const gray = new Uint8Array(image.width * image.height);
  for (let i = 0; i < gray.length; i++)
    gray[i] = (2 * image.data[i * 4] + 7 * image.data[i * 4 + 1] + image.data[i * 4 + 2]) / 10;
  return gray;
}
// How the cascade is swept over the image: it looks for faces from 6% of the shorter side up to
// the whole of it, growing the window 10% at a time and stepping it by a tenth of its size.
const SEARCH = { shiftfactor: 0.1, smallestShare: 0.06, smallestSize: 20, scalefactor: 1.1 };
const CLUSTER_OVERLAP = 0.2; // candidates overlapping this much are merged into one

// Returns every clustered candidate, best first; the UI applies the learner's score threshold.
function detectFaces(image) {
  if (!classify) throw Error('先に顔検出器を読み込んでください。');
  const size = Math.min(image.width, image.height);
  const plane = {
    pixels: grayPlane(image),
    nrows: image.height,
    ncols: image.width,
    ldim: image.width,
  };
  const found = run_cascade(plane, classify, {
    shiftfactor: SEARCH.shiftfactor,
    minsize: Math.max(SEARCH.smallestSize, Math.round(size * SEARCH.smallestShare)),
    maxsize: size,
    scalefactor: SEARCH.scalefactor,
  });
  // pico reports a detection as its centre row/column and the side of a square window.
  return cluster_detections(found, CLUSTER_OVERLAP)
    .map(([row, column, scale, score]) => ({
      x: Math.max(0, column - scale / 2),
      y: Math.max(0, row - scale / 2),
      right: Math.min(image.width, column + scale / 2),
      bottom: Math.min(image.height, row + scale / 2),
      score,
    }))
    .sort((a, b) => b.score - a.score);
}

// Candidates the learner's score limit keeps, empty boxes dropped.
function selectFaces(candidates, threshold) {
  return candidates.filter(
    (box) => box.score >= threshold && box.right > box.x && box.bottom > box.y,
  );
}

export {
  FACE_SAMPLE_URL,
  FACE_SAMPLE_NAME,
  FACE_SCORE,
  loadFaceDetector,
  faceDetectorReady,
  detectFaces,
  selectFaces,
};
