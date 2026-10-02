import { contentUrl } from './content.js';

// The QUESTiX robot as every figure shows it (DOM-free part: canvas drawing and placement; the lit SVG
// helpers are in questix-art.js, which re-exports this module): views rendered from the robot's assembly CAD
// (assets/questix/*.webp, see assets/vendor/NOTICE.md). Canvas figures draw the decoded images;
// SVG figures reference the same files. Top views face +x (right) at heading 0 and carry a short
// light-blue bar on the front edge, a diagram cue for "front" rather than a part of the robot.
// The images are decoded once at start-up (top-level await) so drawing stays synchronous; outside
// a browser (Node tests) nothing is loaded and the canvas helpers draw nothing.

// bounds: the robot inside the image as fractions [left, top, right, bottom] (the renders keep a
// small margin). outlet: the disc outlet on the side view, used by the launch course.
const VIEWS = {
  top: {
    file: 'assets/questix/top.webp',
    size: [768, 749],
    bounds: [0.0078, 0.008, 0.9922, 0.992],
  },
  side: {
    file: 'assets/questix/side.webp',
    size: [768, 766],
    bounds: [0.0078, 0.0078, 0.9922, 0.9922],
    outlet: { x: 0.9922, y: 0.6548 },
  },
  // The chassis alone (no mast, launcher or sensors) and the same with a wheel on a bench.
  base: {
    file: 'assets/questix/baseSide.webp',
    size: [1100, 190],
    bounds: [0.0055, 0.0316, 0.9945, 0.9684],
  },
  bench: {
    file: 'assets/questix/wheelBench.webp',
    size: [1100, 190],
    bounds: [0.0055, 0.0316, 0.9945, 0.9684],
  },
  isometric: { file: 'assets/questix/isometric.webp', size: [1000, 992], bounds: [0, 0, 1, 1] },
};
const FRONT_CUE_OUTER = '#112d38';
const FRONT_CUE_INNER = '#a0dfff';

const IN_BROWSER = typeof window !== 'undefined' && typeof Image !== 'undefined';

async function decode(url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

const urls = Object.fromEntries(
  Object.entries(VIEWS).map(([name, view]) => [name, contentUrl(view.file)]),
);
const images = IN_BROWSER
  ? Object.fromEntries(
      await Promise.all(
        Object.keys(VIEWS).map(async (name) => [name, await decode(urls[name]).catch(() => null)]),
      ),
    )
  : {};

/** URL of a view's image, for <img> and SVG <image> elements. */
const questixImageUrl = (name) => urls[name];

function frontCue(context, size) {
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(size * 0.48, -size * 0.12);
  context.lineTo(size * 0.48, size * 0.12);
  context.strokeStyle = FRONT_CUE_OUTER;
  context.lineWidth = Math.max(3, size * 0.08);
  context.stroke();
  context.strokeStyle = FRONT_CUE_INNER;
  context.lineWidth = Math.max(2, size * 0.05);
  context.stroke();
}

/**
 * Top view centred on (x, y), turned by `theta` (radians, 0 = facing +x), `size` pixels across.
 * A faint light halo keeps the dark chassis visible on the dark floor of the scenes.
 */
function drawQuestixTop(context, x, y, theta = 0, size = 60) {
  const image = images.top;
  if (!image) return;
  const [left, top, right, bottom] = VIEWS.top.bounds;
  context.save();
  context.translate(x, y);
  context.rotate(theta);
  context.shadowColor = 'rgba(214, 238, 244, 0.45)';
  context.shadowBlur = Math.max(4, size * 0.1);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    image,
    left * image.naturalWidth,
    top * image.naturalHeight,
    (right - left) * image.naturalWidth,
    (bottom - top) * image.naturalHeight,
    -size / 2,
    -size / 2,
    size,
    size,
  );
  context.shadowBlur = 0;
  frontCue(context, size);
  context.restore();
}

/**
 * Where a side view lands: `width` pixels between the robot's front and rear, centred on `x`, its
 * wheels on `bottom`. Returns the image rectangle and, for the full side view, the disc outlet.
 */
function questixSideLayout(x, bottom, width, view = 'side') {
  const { bounds, outlet, size } = VIEWS[view];
  const imageWidth = width / (bounds[2] - bounds[0]);
  const imageHeight = (imageWidth * size[1]) / size[0];
  const left = x - ((bounds[0] + bounds[2]) / 2) * imageWidth;
  const top = bottom - bounds[3] * imageHeight;
  return {
    x: left,
    y: top,
    width: imageWidth,
    height: imageHeight,
    top: top + bounds[1] * imageHeight,
    outlet: outlet && { x: left + outlet.x * imageWidth, y: top + outlet.y * imageHeight },
  };
}

/** Side view (front to the right): 'side' the whole robot, 'base' the chassis, 'bench' on a stand. */
function drawQuestixSide(context, x, bottom, width, view = 'side') {
  const image = images[view];
  if (!image) return;
  const place = questixSideLayout(x, bottom, width, view);
  context.save();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, place.x, place.y, place.width, place.height);
  context.restore();
}

export {
  VIEWS as QUESTIX_VIEWS,
  FRONT_CUE_OUTER,
  FRONT_CUE_INNER,
  questixImageUrl,
  drawQuestixTop,
  drawQuestixSide,
  questixSideLayout,
};
