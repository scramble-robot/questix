// Layout rules of the "systems" figures that do not need a browser: the time axis of a narrow
// phone chart, and the break points in the state diagram's names (CONTRIBUTING.md, "Figures and
// charts"). Run with `node --test test/*.test.mjs`.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// lit-html looks up `document` when it is loaded; these tests only use pure helpers.
globalThis.document ??= {
  createComment: () => ({}),
  createTreeWalker: () => ({}),
  createElement: () => ({}),
  importNode: () => ({}),
};
const { timeScale } = await import('../js/systems/render.js');
const copy = JSON.parse(
  await readFile(new URL('../content/systems/render.json', import.meta.url), 'utf8'),
);

test('a time axis shows at least three round seconds inside the run, even on a phone', () => {
  for (const width of [240, 262, 300, 420, 660])
    for (const duration of [2, 4.6, 5.3, 6, 8, 12.5, 20]) {
      const axis = timeScale(duration, width);
      const where = `${duration} s on ${width} px`;
      assert.ok(axis.ticks.length >= 3, `${where}: ${axis.ticks}`);
      assert.equal(axis.ticks[0], 0, where);
      assert.ok(axis.ticks.at(-1) <= duration + 1e-9, where);
      assert.equal(axis.max, duration, `${where}: the axis ends where the run ends`);
      // Labels stay apart: at least 28 px between two ticks ("12.5" is about 29 px wide at 12 px).
      assert.ok((axis.step / duration) * width >= 28, `${where}: step ${axis.step}`);
    }
});

test('an 8 s run on a phone chart is labelled every 2 s, not only at 0 and 5', () => {
  assert.deepEqual(timeScale(8, 242).ticks, [0, 2, 4, 6, 8]);
});

test('state names and conditions wrap only between words', () => {
  // With `word-break: keep-all` a line may break only at a space or a zero-width space, so every
  // name longer than five characters needs one of them between its phrases.
  const names = [
    ...Object.values(copy.states.names),
    ...Object.values(copy.states.conditions),
    copy.states.unused,
  ];
  for (const name of names) {
    const visible = name.replace(/​/g, '');
    if (visible.length > 5) assert.match(name, /[ ​]/, name);
    assert.doesNotMatch(name, /​​|^​|​$/, name);
  }
});
