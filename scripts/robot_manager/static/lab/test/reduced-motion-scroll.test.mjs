import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { scrollBehavior } from '../js/core/scroll.js';

test('explicit scrolling respects reduced motion and otherwise stays smooth', () => {
  for (const reduced of [false, true]) {
    assert.equal(
      scrollBehavior((query) => {
        assert.equal(query, '(prefers-reduced-motion: reduce)');
        return { matches: reduced };
      }),
      reduced ? 'instant' : 'smooth',
    );
  }
});

test('no LAB caller bypasses the shared reduced-motion scrolling policy', () => {
  const root = new URL('../js/', import.meta.url);
  for (const entry of readdirSync(root, { recursive: true })) {
    if (!entry.endsWith('.js') || entry.startsWith('vendor/')) continue;
    const source = readFileSync(new URL(entry, root), 'utf8');
    assert.doesNotMatch(source, /behavior:\s*['"]smooth['"]/, entry);
  }
  for (const entry of [
    'shell/run-mode.js',
    'systems/measurement-lab.js',
    'systems/ui.js',
    'live/live-ui.js',
  ]) {
    const source = readFileSync(new URL(entry, root), 'utf8');
    assert.match(source, /import \{ scrollBehavior \} from '\.\.\/core\/scroll\.js'/, entry);
    assert.match(source, /behavior: scrollBehavior\(\)/, entry);
  }
});
