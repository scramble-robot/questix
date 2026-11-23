import { loadJson, loadText, fillSentence } from './content.js';

// Presentation only. Do not feed formatted values back to physics, commands, grading or recording.
// Angular accelerations use the same scale.
const DEGREES_PER_RADIAN = 180 / Math.PI;
const RPM_PER_RADIAN_PER_SECOND = 60 / (2 * Math.PI);
const toDegrees = (radians) => radians * DEGREES_PER_RADIAN;
const toRadians = (degrees) => degrees / DEGREES_PER_RADIAN;
const toRpm = (rate) => rate * RPM_PER_RADIAN_PER_SECOND;
const fromRpm = (rpm) => rpm / RPM_PER_RADIAN_PER_SECOND;
const fixed = (value, digits = 2) => {
  const text = Number(value).toFixed(digits);
  return Number(text) === 0 ? (0).toFixed(digits) : text;
};
const signedFixed = (value, digits, signed) => {
  const text = fixed(value, digits);
  return signed && Number(text) > 0 ? `+${text}` : text;
};
// Preserve the controller lesson's existing precision rule.
function degreesText(value) {
  const degrees = toDegrees(value);
  if (!Number.isFinite(degrees)) return '—';
  return Math.abs(degrees) >= 10 ? fixed(degrees, 0) : fixed(degrees, 1);
}
function wrapHeading(radians) {
  const wrapped = Math.atan2(Math.sin(radians), Math.cos(radians));
  return Object.is(wrapped, -0) ? 0 : wrapped;
}
function angleParts(radians, digits = 0, signed = false) {
  const degrees = Number(fixed(toDegrees(radians), digits));
  const displayedRadians = toRadians(degrees);
  return {
    degrees: signedFixed(degrees, digits, signed),
    pi: signedFixed(degrees / 180, 2, signed),
    rad: signedFixed(displayedRadians, 2, signed),
  };
}
const unitWords = await loadJson('content/angle-units.json');
function formatChange(radians, { short = false, digits = 0, signed = false } = {}) {
  if (!Number.isFinite(radians)) return '—';
  return fillSentence(
    short ? unitWords.headingShort : unitWords.headingLong,
    angleParts(radians, digits, signed),
  );
}
const formatHeading = (radians, options) => formatChange(wrapHeading(radians), options);
const formatTurnRate = (rate, { signed = false } = {}) =>
  Number.isFinite(rate)
    ? fillSentence(unitWords.turnRate, {
        rate: signedFixed(rate, 2, signed),
        degrees: signedFixed(toDegrees(rate), 0, signed),
      })
    : '—';
const formatWheelRate = (rate) =>
  Number.isFinite(rate)
    ? fillSentence(unitWords.wheelRate, { rate: fixed(rate, 1), rpm: fixed(toRpm(rate), 0) })
    : '—';
const formatWheelChange = (rpm) =>
  Number.isFinite(rpm)
    ? fillSentence(unitWords.wheelChange, { rate: fixed(fromRpm(rpm), 1), rpm: fixed(rpm, 1) })
    : '—';
const formatMotorRate = (rpm, digits = 0) =>
  Number.isFinite(rpm)
    ? fillSentence(unitWords.motorRate, { rpm: fixed(rpm, digits), rate: fixed(fromRpm(rpm), 1) })
    : '—';
// Explicit content references; ordinary {value} placeholders remain for the view to fill.
function withAngleUnits(value) {
  if (typeof value === 'string')
    return value.replace(/\{@(\w+)\}/g, (_, key) => {
      if (!(key in unitWords)) throw Error(`Unknown angle unit text: ${key}`);
      return unitWords[key];
    });
  if (Array.isArray(value)) return value.map(withAngleUnits);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withAngleUnits(item)]),
    );
  return value;
}
const loadAngleJson = async (path) => withAngleUnits(await loadJson(path));
const loadAngleText = async (path) => withAngleUnits(await loadText(path));
export {
  DEGREES_PER_RADIAN,
  RPM_PER_RADIAN_PER_SECOND,
  toDegrees,
  toRadians,
  toRpm,
  fromRpm,
  fixed,
  degreesText,
  wrapHeading,
  angleParts,
  formatHeading,
  formatChange,
  formatTurnRate,
  formatWheelRate,
  formatWheelChange,
  formatMotorRate,
  unitWords,
  withAngleUnits,
  loadAngleJson,
  loadAngleText,
};
