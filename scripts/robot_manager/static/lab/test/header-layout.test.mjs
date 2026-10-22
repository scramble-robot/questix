import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const copy = JSON.parse(read('content/live/link.json'));
const html = (parts, ...values) =>
  parts.reduce(
    (s, part, i) => s + part + (Array.isArray(values[i]) ? values[i].join('') : (values[i] ?? '')),
    '',
  );
const context = { html, fill: (s, values) => s.replace(/\{(\w+)\}/g, (_, key) => values[key]) };
vm.runInNewContext(
  read('js/live/live-status-view.js')
    .replace(/^import .*;\n/gm, '')
    .replace('export { liveStatusLine };', 'globalThis.view = liveStatusLine;'),
  context,
);

test('header tiles reserve every E-stop and permission value, independent of received state', () => {
  for (const estop of ['pressed', 'released', 'unknown', 'stale'])
    for (const drive of ['on', 'off', 'unknown'])
      for (const shoot of ['on', 'off', 'unknown']) {
        const result = context.view({ estop, drive, shoot, stage: 'open' }, copy, true);
        assert.match(result, /data-header-tile=estop/);
        assert.match(result, /data-header-tile=permission/);
        for (const value of Object.values(copy.header.estop))
          assert(result.includes(value.split('：')[1]));
        for (const a of Object.values(copy.header.allowed))
          for (const b of Object.values(copy.header.allowed))
            assert(result.includes(`走行${a} 発射${b}`));
        for (const stage of Object.values(copy.stageShort)) assert(result.includes(stage));
        assert(result.includes(copy.header.estopDescription[estop]));
      }
});

test('connection has one visible location per layout and dialogs retain their status line', () => {
  const css = read('css/navigation.css');
  assert.match(css, /body \.header-actions #robotLinkState\s*\{\s*display: none/);
  const wide = css.slice(css.indexOf('@media (min-width: 915px)'));
  assert.match(wide, /#liveHeaderStatus > \.header-connection\s*\{\s*display: none/);
  assert.match(wide, /body \.header-actions #robotLinkState\s*\{\s*display: inline-grid/);
  assert.match(read('js/live/live-status.js'), /liveStatusLine\(model, copy, true\), header/);
  assert.match(read('js/live/live-status.js'), /\$\{liveStatusLine\(model, copy\)\}/);
  assert.doesNotMatch(read('css/hs-shell.css'), /#robotLinkState::after/);
});

test('wide header is one fixed 109px row with stable reserved columns', () => {
  const css = read('css/navigation.css');
  const wide = css.slice(css.indexOf('@media (min-width: 915px)'));
  assert.match(wide, /height: 109px;\s*min-height: 109px/);
  assert.match(wide, /grid-template-rows: 93px/);
  assert.match(
    wide,
    /grid-template-columns: 140px 96px 132px 176px 82px 70px minmax\(140px, 1fr\)/,
  );
  assert.match(css, /\.header-text-slot > span\s*\{\s*grid-area: 1 \/ 1/);
  assert.match(css, /\.header-text-reserve\s*\{\s*visibility: hidden/);
  assert.match(
    css,
    /#labHeaderStop \.lab-stop\[hidden\]\s*\{\s*display: block !important;\s*visibility: hidden/,
  );
  assert.match(css, /grid-template-rows: 44px 28px/);
});

test('robot accessible name and title retain the entire long name and connection stage', () => {
  const elements = Object.fromEntries(
    ['robotLinkOpen', 'robotLinkName', 'robotLinkState'].map((id) => [
      id,
      {
        dataset: {},
        setAttribute(name, value) {
          this[name] = value;
        },
      },
    ]),
  );
  const scope = {
    $: (id) => elements[id],
    copy,
    robotName: (hello) => hello?.robot?.name ?? '',
    html,
    render: (value, host) => {
      host.content = value;
    },
  };
  const source = read('js/live/live-ui.js').match(
    /function showHeader\(state, stage\) \{[\s\S]*?\n\}/,
  )[0];
  vm.runInNewContext(source + ';globalThis.show = showHeader', scope);
  const name = 'QUESTiX とても長い名前'.repeat(20);
  for (const stage of Object.keys(copy.stage)) {
    scope.show(
      { phase: stage === 'open' ? 'open' : 'connecting', hello: { robot: { name } } },
      stage,
    );
    assert(elements.robotLinkOpen['aria-label'].includes(copy.stage[stage]));
    for (const value of Object.values(copy.stage))
      assert(elements.robotLinkState.content.includes(value));
    if (stage === 'open') {
      assert.equal(elements.robotLinkName.title, name);
      assert(elements.robotLinkOpen['aria-label'].includes(name));
    }
  }
  assert.match(
    read('css/live-link.css'),
    /\.robot-link-name\s*\{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap/s,
  );
});
