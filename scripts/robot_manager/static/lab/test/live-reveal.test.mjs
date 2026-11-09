import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function fixture() {
  const scrolls = [];
  const header = { getBoundingClientRect: () => ({ height: 88, bottom: 88 }) };
  const context = {
    document: { querySelector: () => header },
    window: {
      innerHeight: 450,
      matchMedia: () => ({ matches: true }),
      scrollBy: (value) => scrolls.push(value),
    },
  };
  const source = fs.readFileSync(new URL('../js/core/reveal.js', import.meta.url), 'utf8');
  vm.runInNewContext(
    source.replace(
      'export { revealElement, revealIfHidden };',
      'globalThis.api = { revealElement, revealIfHidden };',
    ),
    context,
  );
  const element = (top, height) => ({
    getBoundingClientRect: () => ({ top, height, bottom: top + height }),
  });
  return { ...context.api, scrolls, element };
}
test('a narrow screen reveal still clears the always-visible header', () => {
  const f = fixture();
  f.revealElement(f.element(300, 40));
  assert.equal(f.scrolls[0].top, 200);
});
test('a control below the viewport is brought above the header', () => {
  const f = fixture();
  f.revealIfHidden(f.element(430, 40));
  assert.equal(f.scrolls.length, 1);
});
test('a visible control between header and viewport bottom does not move', () => {
  const f = fixture();
  f.revealIfHidden(f.element(120, 40));
  assert.equal(f.scrolls.length, 0);
});
