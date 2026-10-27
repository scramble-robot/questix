import { fillSentence as fill } from '../core/content.js';

// Presentation only: keep rad/s as the parameter's value. Compute degrees from the unrounded
// value, with the same precision rule as Robot Manager's tuningFormulaDegrees (#259).
const fixed = (value, digits = 2) => {
  const number = Number(value);
  const rounded = Math.abs(number) < 0.5 * 10 ** -digits ? 0 : number;
  return rounded.toFixed(digits);
};
const signed = (value, digits = 2) => (Number(value) > 0 ? '+' : '') + fixed(value, digits);
function degreesText(value) {
  const degrees = (value * 180) / Math.PI;
  if (!Number.isFinite(degrees)) return '—';
  if (Math.abs(degrees) >= 10) return String(Math.round(degrees));
  const text = degrees.toFixed(1);
  return Number(text) === 0 ? '0.0' : text;
}
const angularParts = (value, sign = false) => ({
  value: sign ? signed(value) : fixed(value),
  degrees: degreesText(value),
});
function rowValue(row, copy) {
  if (row.value === null) return copy.apply.verify;
  if (row.node === 'joy_controller' && row.param === 'angular_input_ratio')
    return fill(copy.sim.angular, angularParts(row.value));
  return typeof row.value === 'number' && !Number.isInteger(row.value)
    ? fixed(row.value)
    : String(row.value);
}
function rowNote(row, copy) {
  return row.note ? fill(copy.apply.notes[row.note], row) : '';
}
function tableText(rows, copy) {
  const lines = [
    [...copy.apply.columns, copy.apply.noteColumn].join('\t'),
    ...rows.map((row) => [row.node, row.param, rowValue(row, copy), rowNote(row, copy)].join('\t')),
  ];
  return lines.join('\n') + '\n';
}
export { fixed, signed, degreesText, angularParts, rowValue, rowNote, tableText };
