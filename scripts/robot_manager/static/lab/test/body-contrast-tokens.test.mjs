import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const tokens = Object.fromEntries(
  [
    ...readFileSync(new URL('../css/tokens.css', import.meta.url), 'utf8').matchAll(
      /(--[\w-]+):\s*([^;]+);/g,
    ),
  ].map((m) => [m[1], m[2].trim()]),
);
const resolve = (s) => (s.startsWith('var(') ? resolve(tokens[s.slice(4, -1)]) : s);
function lum(s) {
  s = resolve(s);
  return [1, 3, 5]
    .map((i) => parseInt(s.slice(i, i + 2), 16) / 255)
    .reduce(
      (sum, c, i) =>
        sum +
        (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i],
      0,
    );
}
function contrast(a, b) {
  const [lo, hi] = [lum(a), lum(b)].sort((a, b) => a - b);
  return (hi + 0.05) / (lo + 0.05);
}
test('body muted and role text tokens work on the actual light surfaces', () => {
  for (const name of [
    '--muted',
    '--role-actual-text',
    '--role-measured-text',
    '--role-target-text',
    '--role-previous-text',
  ])
    for (const bg of ['#ffffff', '#f3f5f4', '#e8f2ee', '#edf5f2', '#fbfdfc'])
      assert.ok(contrast(tokens[name], bg) >= 4.5, `${name} on ${bg}`);
  assert.equal(tokens['--disabled-ink-muted'], '#667975');
});
