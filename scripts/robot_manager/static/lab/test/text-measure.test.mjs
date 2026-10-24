// These source checks run in CI without a browser. Rendered line-end measurements are separate.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

test('LAB styles never force a break inside ordinary words, identifiers or URLs', async () => {
  const root = new URL('../', import.meta.url);
  const styles = (await readdir(root, { recursive: true })).filter((file) => file.endsWith('.css'));
  assert(styles.length > 0, 'the stylesheet scan must cover the site');
  for (const file of styles) {
    const source = (await readFile(new URL(file, root), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(source, /\bword-break\s*:\s*break-all\b/i, file);
  }
});

for (const [file, selectors] of [
  ['hs-shell.css', ['.lesson-quickstart p', '.lesson-brief .run-mode-strip p']],
  ['experiment.css', ['.lesson-brief p', '.lesson-brief .lesson-brief-scene p']],
  ['base.css', ['.page-footnote']],
  ['curriculum.css', ['.basics-footer p']],
  ['quiz.css', ['.quiz-feedback > p']],
]) {
  test(`${file}: introductory and footnote paragraphs have no fixed text-only width cap`, async () => {
    const source = (await readFile(new URL(`../css/${file}`, import.meta.url), 'utf8')).replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    // Scan every declaration block, including overrides inside media queries and selector lists.
    const rules = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    for (const [_, names, declarations] of rules) {
      if (!names.split(',').some((name) => selectors.includes(name.trim()))) continue;
      assert.doesNotMatch(
        declarations,
        /\bdisplay\s*:\s*none\b/,
        `${names}: text must remain visible`,
      );
      const caps = [...declarations.matchAll(/(?:^|;)\s*max-width\s*:\s*([^;]+)/g)];
      for (const [, cap] of caps)
        assert.doesNotMatch(cap, /\d(?:\.\d+)?(?:ch|px|em|rem)\b/, `${names}: ${cap}`);
    }
    assert(source.includes(selectors[0]), 'the base selector must remain covered by this test');
  });
}
