import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('the motor bench report keeps one full-width column, including desktop media rules', () => {
  const css = fs.readFileSync(new URL('../css/motor.css', import.meta.url), 'utf8');
  const clean = css.replace(/\/\*[^]*?\*\//g, '');
  const rules = [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selectors]) =>
    selectors.split(',').some((selector) => selector.trim() === '.motor-bench-layout'),
  );
  assert(rules.length > 0, 'the layout rule must exist');
  assert(rules.some(([, , declarations]) => /display:\s*grid\s*;/.test(declarations)));
  const columns = rules.flatMap(([, , declarations]) =>
    [...declarations.matchAll(/grid-template-columns:\s*([^;]+);/g)].map((match) =>
      match[1].trim(),
    ),
  );
  assert(columns.length > 0, 'the column count must be explicit');
  // Check every matching declaration, including any future >=900px override.
  assert.deepEqual([...new Set(columns)], ['minmax(0, 1fr)']);
  for (const [, , declarations] of rules) {
    assert(!/grid(?:-template)?\s*:|grid-template-areas\s*:/.test(declarations));
  }
});
