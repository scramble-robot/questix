import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = (file) => fs.readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8');

test('automatic live modules never import the simulator reveal helper', () => {
  // record-targets is explicit navigation from the learner's record picker, not a command or
  // incoming-status handler. The other live modules share no Press → see entry point.
  const live = new URL('../js/live/', import.meta.url);
  for (const file of fs
    .readdirSync(live)
    .filter((name) => name.endsWith('.js') && name !== 'record-targets.js'))
    assert.doesNotMatch(
      source(`live/${file}`),
      /core\/reveal\.js|\breveal(?:Element|IfHidden|LiveRun)\s*\(/,
      file,
    );
  assert.doesNotMatch(
    source('systems/measurement-lab.js'),
    /core\/reveal\.js|\breveal(?:Element|IfHidden|LiveRun)\s*\(/,
  );
});

test('mixed simulator/robot courses reserve reveal calls for explicit navigation', () => {
  const motor = source('motor/ui.js');
  const benchActions = motor.slice(
    motor.indexOf('const benchActions ='),
    motor.indexOf('function buildModel('),
  );
  assert.doesNotMatch(benchActions, /startDriveCapture\s*\(/);
  assert.match(benchActions, /showResults:\s*\(\)\s*=>\s*revealIfHidden/);
  const control = source('control/ui.js');
  const apply = control.slice(
    control.indexOf('function applyRecording('),
    control.indexOf('// A new real run'),
  );
  assert.doesNotMatch(apply, /reveal|showCharts/);
  // Only the explicit file/record comparison path may request chart navigation.
  assert.equal([...control.matchAll(/revealPending = true/g)].length, 1);
  assert.match(
    control.slice(
      control.indexOf('async function addComparisons('),
      control.indexOf('const fileSource'),
    ),
    /revealPending = true/,
  );
});

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
