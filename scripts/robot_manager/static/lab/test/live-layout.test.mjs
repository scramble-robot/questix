import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture() {
  let nodes = [];
  const doc = { documentElement: { clientWidth: 800 }, querySelectorAll: () => nodes };
  const node = (height) => ({
    id: 'robotDrive',
    naturalHeight: height,
    ownerDocument: doc,
    style: { minHeight: '' },
    getClientRects: () => [{}],
    getBoundingClientRect() {
      return { height: Math.max(this.naturalHeight, parseFloat(this.style.minHeight) || 0) };
    },
  });
  let element = node(100);
  nodes = [element];
  const context = { render: (draw) => draw() };
  const source = fs.readFileSync(new URL('../js/live/live-layout.js', import.meta.url), 'utf8');
  vm.runInNewContext(
    source
      .replace(/^import .*;\n/gm, '')
      .replace('export { renderLive };', 'globalThis.renderLive = renderLive;'),
    context,
  );
  return {
    doc,
    node,
    render: (draw) => context.renderLive(draw, element),
    height: () => element.getBoundingClientRect().height,
    shrink: (height) => (element.naturalHeight = height),
    replace: (height) => {
      element = node(height);
      nodes = [element];
    },
  };
}

test('removing a live status cannot shrink its already occupied area, including replacement nodes', () => {
  const f = fixture();
  f.render(() => f.shrink(30));
  assert.equal(f.height(), 100);
  f.render(() => f.shrink(170));
  assert.equal(f.height(), 170);
  f.render(() => f.replace(20));
  assert.equal(f.height(), 170);
});

test('a deliberate width change permits fresh layout rather than retaining an obsolete height', () => {
  const f = fixture();
  f.render(() => f.shrink(30));
  f.doc.documentElement.clientWidth = 410;
  f.render(() => f.shrink(50));
  assert.equal(f.height(), 50);
});

test('disconnect keeps the robot monitor and its stream rows with an explicit offline label', () => {
  const source = fs.readFileSync(new URL('../js/live/live-ui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\$\('robotMonitor'\)\.hidden = !open/);
  assert.match(source, /\$\('robotMonitor'\)\.hidden = !monitorHello/);
  assert.match(source, /streamRows\(\{ \.\.\.state, hello: monitorHello \}, open\)/);
  const copy = JSON.parse(fs.readFileSync(new URL('../content/live/link.json', import.meta.url)));
  assert.match(copy.monitor.disconnected, /未接続/);
});

test('measurement lab controls precede the table and graph that a recording replaces', () => {
  const source = fs.readFileSync(
    new URL('../js/systems/measurement-view.js', import.meta.url),
    'utf8',
  );
  const panel = source.slice(source.indexOf('function measurementPanel('));
  const controls = panel.indexOf('${liveCapture(model, copy, actions)}');
  assert(controls >= 0);
  assert(controls < panel.indexOf('data-measure-plot'));
  assert(controls < panel.indexOf('${measurementTable('));
});
