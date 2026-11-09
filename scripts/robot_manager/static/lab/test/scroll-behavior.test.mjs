// DESIGN.md U-8: a script scroll follows prefers-reduced-motion (CSS cannot stop it).
import test from 'node:test';
import assert from 'node:assert/strict';

import { scrollBehavior } from '../js/core/dom.js';

test('script scrolls are instant when the reader asks for less motion', () => {
  const saved = globalThis.matchMedia;
  try {
    globalThis.matchMedia = (query) => ({ matches: query.includes('reduce') });
    assert.equal(scrollBehavior(), 'auto');
    globalThis.matchMedia = () => ({ matches: false });
    assert.equal(scrollBehavior(), 'smooth');
    delete globalThis.matchMedia;
    assert.equal(scrollBehavior(), 'smooth', 'no matchMedia (Node): the old behaviour');
  } finally {
    globalThis.matchMedia = saved;
  }
});
