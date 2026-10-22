import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = (file) => fs.readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8');

test('roller commands and received shot results never invoke Press → see', () => {
  for (const file of ['live/shoot-ui.js', 'launch/ui.js'])
    assert.doesNotMatch(source(file), /core\/reveal\.js|\breveal(?:Element|IfHidden)\s*\(/);
  assert.match(source('launch/view.js'), /after:\s*\(\)\s*=>[\s\S]*?quickEntry/);
  assert.match(source('live/shoot-view.js'), /\$\{buttons\(model, actions\)\}\s*\$\{after\}/);
});

test('a shot field is focused without scrolling only when entirely visible below the header', () => {
  const text = source('launch/ui.js');
  const body = text.slice(
    text.indexOf('function focusRow('),
    text.indexOf('\n/**', text.indexOf('function focusRow(')),
  );
  for (const [top, bottom, visible, expected] of [
    [120, 164, true, 1],
    [50, 94, true, 0],
    [440, 484, true, 0],
    [120, 164, false, 0],
  ]) {
    const focused = [];
    const field = {
      getBoundingClientRect: () => ({ top, bottom, left: 10, right: 150 }),
      getClientRects: () => (visible ? [{}] : []),
      focus: (options) => focused.push(options),
    };
    const focus = vm.runInNewContext(`(${body})`, {
      document: {
        querySelector: (selector) =>
          selector === '.site-header' ? { getBoundingClientRect: () => ({ bottom: 88 }) } : field,
      },
      window: { innerHeight: 450, innerWidth: 640 },
    });
    focus(1);
    assert.equal(focused.length, expected);
    if (expected) assert.equal(focused[0].preventScroll, true);
  }
});
