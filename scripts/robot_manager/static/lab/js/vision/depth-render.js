// Canvas overlays of the stereo and RGB-D chapters. Every function draws from plain data handed in
// by depth-ui.js on top of an image that ui.js has already put on the canvas.

const MARKER_LABEL = 'A'; // the one point the learner matches between the two imaging units
const MARKER_RADIUS = 6; // pixels
const MARKER_LABEL_OFFSET = { x: 8, y: -8 }; // pixels from the marker centre
const IMAGE_HEIGHT = 220; // pixels; height of the stereo images the epipolar line spans
const POINT_RADIUS = 5; // pixels of the circle marking the pixel the learner picked

// Vertical line through the projected point A, a circle on it and its label.
function drawStereoMarker(canvas, { x, y }) {
  const context = canvas.getContext('2d');
  context.strokeStyle = '#fbec9a';
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(x, 0);
  context.lineTo(x, IMAGE_HEIGHT);
  context.stroke();
  context.beginPath();
  context.arc(x, y, MARKER_RADIUS, 0, Math.PI * 2);
  context.stroke();
  context.fillStyle = '#fff';
  context.font = '14px system-ui';
  context.fillText(MARKER_LABEL, x + MARKER_LABEL_OFFSET.x, y + MARKER_LABEL_OFFSET.y);
}

// The pixel whose RGB and depth are listed below the images, marked on both canvases.
function drawPickedPixel(canvas, { u, v }) {
  const context = canvas.getContext('2d');
  context.strokeStyle = '#fff';
  context.lineWidth = 1.5;
  context.beginPath();
  context.arc(u, v, POINT_RADIUS, 0, Math.PI * 2);
  context.stroke();
}

export { drawStereoMarker, drawPickedPixel };
