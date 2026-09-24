// Axis scales every chart of the material shares, so learners read the same kind of axis in
// every course: round tick values (1, 2, 2.5 or 5 × 10ⁿ), zero on the axis whenever the data
// could be read against it, integer ticks for counts, and one range per run instead of a range
// that grows while the run plays back (a moving axis makes a steady slope look like it changes).
// No DOM: test/chart-scale.test.mjs.

const NICE_FACTORS = [1, 2, 2.5, 5, 10];
const DEFAULT_TICKS = 5; // lines a chart of ~160–260 px height can label without crowding
const DEFAULT_PADDING = 0.08; // share of the span kept free above/below the data

/** The smallest round step (1, 2, 2.5 or 5 × 10ⁿ) that splits `span` into at most `ticks` intervals. */
function niceStep(span, ticks = DEFAULT_TICKS) {
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  const intervals = Math.max(1, ticks);
  const power = 10 ** Math.floor(Math.log10(span / intervals));
  for (const scale of [power, power * 10]) {
    const factor = NICE_FACTORS.find((candidate) => span / (candidate * scale) <= intervals + 1e-9);
    if (factor) return factor * scale;
  }
  return power * 100;
}

/**
 * The axis for `values` (numbers; non-finite ones are ignored):
 * `{min, max, step, ticks}`, where min and max are multiples of step.
 * - `includeZero` (default true): the axis always shows 0, so "above/below zero" can be read.
 * - `integer`: counts — the step is at least 1 and whole.
 * - `min` / `max`: values that must be inside the range (e.g. a target line), even if no sample
 *   reaches them.
 * - `ticks`: about how many labelled lines.
 */
function niceScale(values, options = {}) {
  const {
    includeZero = true,
    integer = false,
    ticks = DEFAULT_TICKS,
    padding = DEFAULT_PADDING,
  } = options;
  const finite = values.filter(Number.isFinite);
  for (const extra of [options.min, options.max]) if (Number.isFinite(extra)) finite.push(extra);
  if (includeZero) finite.push(0);
  let low = finite.length ? Math.min(...finite) : 0;
  let high = finite.length ? Math.max(...finite) : 1;
  if (high === low) {
    high += integer ? 1 : Math.abs(high) * 0.5 || 1;
    if (!includeZero) low -= integer ? 1 : Math.abs(low) * 0.5 || 1;
  }
  const span = high - low;
  // Pad only the sides that are not pinned at zero.
  if (!(includeZero && low === 0)) low -= span * padding;
  if (!(includeZero && high === 0)) high += span * padding;
  let step = niceStep(high - low, ticks);
  if (integer) step = Math.max(1, Math.round(step));
  const min = Math.floor(low / step + 1e-9) * step;
  const max = Math.ceil(high / step - 1e-9) * step;
  const list = [];
  for (let value = min; value <= max + step / 2; value += step) list.push(roundToStep(value, step));
  return { min: roundToStep(min, step), max: roundToStep(max, step), step, ticks: list };
}

// Removes floating-point noise (0.30000000000000004) and turns -0 into 0.
function roundToStep(value, step) {
  const digits = decimalsOf(step);
  const rounded = Number(value.toFixed(digits));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Decimal places a tick label needs for this step (0.25 → 2, 0.5 → 1, 20 → 0). */
function decimalsOf(step) {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const text = String(Number(step.toPrecision(6)));
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** A tick label: as many decimals as the step needs, never "-0". */
function formatTick(value, step) {
  return roundToStep(value, step).toFixed(decimalsOf(step));
}

/** Map a value on the scale to a pixel coordinate between `from` (min) and `to` (max). */
function scaleTo(scale, from, to) {
  const span = scale.max - scale.min || 1;
  return (value) => from + ((value - scale.min) / span) * (to - from);
}

export { niceStep, niceScale, formatTick, decimalsOf, scaleTo };
