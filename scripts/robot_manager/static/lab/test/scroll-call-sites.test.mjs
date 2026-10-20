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
