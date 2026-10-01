import { markerBits, rotateBits, quadTransform } from './core.js';

// Canvas drawing for the vision course page: images handed over as { width, height, data },
// the synthetic marker scene, and the overlays (marker frame, face boxes with numbered tags).
// Nothing here keeps state; ui.js decides what to draw.

const MARKER_SCENE = { width: 320, height: 220 };
const MARKER_BACKGROUND = '#e8eceb';
const MARKER_BLACK = '#101010';
const MARKER_WHITE = '#fafafa';
const MARKER_COVER = { x: 118, y: 65, width: 60, height: 80, color: '#777' };
const MARKER_GRID = 6; // cells per side including the black border
const MARKER_FRAME_COLORS = { decoded: '#35ab83', undecided: '#d77e40' };
const MARKER_FRAME_WIDTH_RATIO = 150; // frame line width = image width / ratio (minimum 2 px)
const FACE_BOX_COLOR = '#f0c86a';
const FACE_TAG_BACKGROUND = '#173b37';
const FACE_TAG_TEXT = 'white';
const FACE_SCALE_WIDTH = 420; // px of image width at which overlays draw at scale 1
const FACE_MIN_SCALE = 0.25;
const FACE_TAG_FONT_SIZE = 14; // px at scale 1
const FACE_TAG_BASELINE = 16; // px below the tag top at scale 1

function paintImage(canvas, image) {
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
}

function imageDataUrl(image) {
  const canvas = document.createElement('canvas');
  paintImage(canvas, image);
  return canvas.toDataURL('image/png');
}

function tracePolygon(context, points) {
  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.closePath();
}

// A 4×4 ArUco marker drawn in perspective: `tilt` pulls the top corners inwards (px),
// `turn` rotates the pattern by 90° steps, `cover` hides part of it with a grey patch.
function markerImage({ id, turn, tilt, cover }) {
  const canvas = document.createElement('canvas');
  canvas.width = MARKER_SCENE.width;
  canvas.height = MARKER_SCENE.height;
  const context = canvas.getContext('2d');
  context.fillStyle = MARKER_BACKGROUND;
  context.fillRect(0, 0, MARKER_SCENE.width, MARKER_SCENE.height);
  const quad = [
    { x: 88 + tilt, y: 28 },
    { x: 240 - tilt, y: 40 },
    { x: 246, y: 196 },
    { x: 72, y: 187 },
  ];
  const toScene = quadTransform(quad);
  let bits = markerBits(id);
  for (let step = 0; step < turn; step++) bits = rotateBits(bits);
  context.fillStyle = MARKER_BLACK;
  tracePolygon(context, quad);
  context.fill();
  const paintCell = (column, row) => {
    const corners = [
      [column, row],
      [column + 1, row],
      [column + 1, row + 1],
      [column, row + 1],
    ].map(([u, v]) => toScene(u / MARKER_GRID, v / MARKER_GRID));
    context.fillStyle = MARKER_WHITE;
    tracePolygon(context, corners);
    context.fill();
  };
  for (let row = 1; row < MARKER_GRID - 1; row++)
    for (let column = 1; column < MARKER_GRID - 1; column++)
      if (bits[(row - 1) * 4 + column - 1]) paintCell(column, row);
  if (cover) {
    context.fillStyle = MARKER_COVER.color;
    context.fillRect(MARKER_COVER.x, MARKER_COVER.y, MARKER_COVER.width, MARKER_COVER.height);
  }
  return context.getImageData(0, 0, MARKER_SCENE.width, MARKER_SCENE.height);
}

// Printable marker: 8×8 cells, white margin, black border, 80 mm square.
function markerSvg(id) {
  const cells = markerBits(id)
    .map((bit, index) => {
      if (!bit) return '';
      const x = 2 + (index % 4);
      const y = 2 + Math.floor(index / 4);
      return `<rect x="${x}" y="${y}" width="1" height="1" fill="white"/>`;
    })
    .join('');
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="80mm" height="80mm" viewBox="0 0 8 8">' +
    '<rect width="8" height="8" fill="white"/><rect x="1" y="1" width="6" height="6" fill="black"/>' +
    cells +
    '</svg>'
  );
}

// Binary image with the detected marker outline (green when an ID was decoded).
function paintMarkerReading(canvas, { binary, detection }) {
  paintImage(canvas, binary);
  if (!detection) return;
  const context = canvas.getContext('2d');
  context.strokeStyle =
    detection.id === null ? MARKER_FRAME_COLORS.undecided : MARKER_FRAME_COLORS.decoded;
  context.lineWidth = Math.max(2, binary.width / MARKER_FRAME_WIDTH_RATIO);
  tracePolygon(context, detection.quad);
  context.stroke();
}

// Source image with every candidate box; the first `tags.length` boxes get a numbered tag
// joined to the box corner by a thin line (tags may be null when nothing fits).
function paintFaceBoxes(canvas, { image, boxes, tagged, tags }) {
  paintImage(canvas, image);
  const context = canvas.getContext('2d');
  const scale = Math.max(FACE_MIN_SCALE, image.width / FACE_SCALE_WIDTH);
  context.lineWidth = 2 * scale;
  for (const box of boxes) {
    context.strokeStyle = FACE_BOX_COLOR;
    context.strokeRect(box.x, box.y, box.right - box.x, box.bottom - box.y);
  }
  tags.forEach((tag, index) => {
    if (!tag) return;
    const box = tagged[index];
    context.strokeStyle = FACE_BOX_COLOR;
    context.lineWidth = scale;
    context.beginPath();
    context.moveTo(tag.x + tag.w / 2, tag.y + tag.h / 2);
    context.lineTo(box.x, box.y);
    context.stroke();
  });
  for (const tag of tags) {
    if (!tag) continue;
    context.fillStyle = FACE_TAG_BACKGROUND;
    context.fillRect(tag.x, tag.y, tag.w, tag.h);
    context.fillStyle = FACE_TAG_TEXT;
    context.font = FACE_TAG_FONT_SIZE * tag.scale + 'px system-ui';
    context.textAlign = 'center';
    context.fillText(String(tag.number), tag.x + tag.w / 2, tag.y + FACE_TAG_BASELINE * tag.scale);
  }
  context.textAlign = 'left';
}

export { paintImage, imageDataUrl, markerImage, markerSvg, paintMarkerReading, paintFaceBoxes };
