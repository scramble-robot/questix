import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sites = [
  ['live/live-ui.js', 'function jumpTo(', 1],
  ['shell/run-mode.js', 'function scrollToRunModeTarget(', 1],
  ['systems/measurement-lab.js', 'function scrollToPart(', 1],
  ['systems/ui.js', 'function showRestart(', 1],
  ['systems/ui.js', 'function createActions(', 1],
  ['systems/ui.js', 'function reviewSystem(', 1],
];
for (const [file, start, count] of sites) {
  test(`${file}: ${start} uses the shared scroll preference`, () => {
    const source = fs.readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8');
    assert.match(
      source,
      /import \{[^}]*\bscrollBehavior\b[^}]*\} from ['"]\.\.\/core\/dom\.js['"]/,
    );
    const index = source.indexOf(start);
    assert(index >= 0, 'the call-site function exists');
    const end = source.indexOf('\n}', index);
    assert(end > index);
    const body = source.slice(index, end);
    const calls = [
      ...body.matchAll(/\.scroll(?:IntoView|To)\(\{[^}]*behavior:\s*([^,}]+)[^}]*\}/g),
    ];
    assert.equal(calls.length, count);
    for (const call of calls) assert.equal(call[1].trim(), 'scrollBehavior()');
  });
}

function labSources() {
  const root = new URL('../js/', import.meta.url);
  return fs
    .readdirSync(root, { recursive: true })
    .filter((file) => file.endsWith('.js') && !file.startsWith('vendor/'))
    .map((file) => [file, fs.readFileSync(new URL(file, root), 'utf8')]);
}

test('the whole LAB has one scroll preference definition, in core/dom.js', () => {
  const definitions = labSources().flatMap(([file, source]) =>
    [
      ...source.matchAll(/\bfunction\s+scrollBehavior\b|\b(?:const|let|var)\s+scrollBehavior\s*=/g),
    ].map(() => file),
  );
  assert.deepEqual(definitions, ['core/dom.js']);
});

test('no LAB script requests smooth scrolling without the preference helper', () => {
  for (const [file, source] of labSources()) {
    assert.doesNotMatch(source, /\bbehavior:\s*['"]smooth['"]/, file);
  }
});

test('a LAB module never imports the scroll preference under the same name twice', () => {
  for (const [file, source] of labSources()) {
    const bindings = [...source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g)]
      .flatMap((match) => match[1].split(','))
      .map((name) =>
        name
          .trim()
          .split(/\s+as\s+/)
          .at(-1),
      )
      .filter((name) => name === 'scrollBehavior');
    assert(bindings.length <= 1, `${file}: duplicate scrollBehavior import`);
  }
});
