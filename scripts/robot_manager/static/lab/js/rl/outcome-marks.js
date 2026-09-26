// The marks of a run's outcome, shared by every map of the reinforcement-learning course so the
// same shape always means the same thing: ● arrived, × contact, △ timed out (or another stop).
// The list of runs next to a map uses the same three symbols (OUTCOME_SYMBOLS).

const OUTCOME_SYMBOLS = { arrived: '●', contact: '×', timeout: '△' };
const MIN_TEXT = 12; // CSS pixels, the smallest text a figure may show (--figure-text-min)
const CROSS_WIDTH = 0.45; // stroke width of × as a share of the mark size
const TRIANGLE_WIDTH = 0.3; // stroke width of △ as a share of the mark size

/**
 * Font size in drawing units for a label meant to be `size` units on a full-size canvas, raised so
 * it is never below 12 CSS pixels once the canvas is scaled down (`unitsPerPixel` > 1).
 */
function sceneFontSize(size, unitsPerPixel) {
  return Math.round(Math.max(size, MIN_TEXT * unitsPerPixel));
}

/** Draws one outcome mark centred on `point`; `size` is half its width in drawing units. */
function drawOutcomeMark(context, point, outcome, size, colour) {
  context.save();
  context.fillStyle = colour;
  context.strokeStyle = colour;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.setLineDash([]);
  context.beginPath();
  if (outcome === 'arrived') {
    context.arc(point.x, point.y, size, 0, Math.PI * 2);
    context.fill();
  } else if (outcome === 'contact') {
    context.lineWidth = size * CROSS_WIDTH;
    context.moveTo(point.x - size, point.y - size);
    context.lineTo(point.x + size, point.y + size);
    context.moveTo(point.x + size, point.y - size);
    context.lineTo(point.x - size, point.y + size);
    context.stroke();
  } else {
    context.lineWidth = size * TRIANGLE_WIDTH;
    context.moveTo(point.x, point.y - size);
    context.lineTo(point.x + size, point.y + size * 0.8);
    context.lineTo(point.x - size, point.y + size * 0.8);
    context.closePath();
    context.stroke();
  }
  context.restore();
}

export { OUTCOME_SYMBOLS, sceneFontSize, drawOutcomeMark };
