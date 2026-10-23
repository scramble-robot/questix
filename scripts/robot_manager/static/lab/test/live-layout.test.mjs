import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture() {
  let nodes = [];
  const events = new Map();
  const doc = {
    documentElement: { clientWidth: 800 },
    querySelectorAll: () => nodes,
    addEventListener: (name, fn) => events.set(name, fn),
  };
  let scope = { children: [] };
  const node = (height, id = 'robotDrive') => ({
    id,
    localName: 'div',
    parentElement: scope,
    naturalHeight: height,
    ownerDocument: doc,
    style: { minHeight: '' },
    closest() {
      return this.parentElement;
    },
    getClientRects: () => [{}],
    getBoundingClientRect() {
      return { height: Math.max(this.naturalHeight, parseFloat(this.style.minHeight) || 0) };
    },
  });
  let element = node(100);
  nodes = scope.children = [element];
  const context = { render: (draw) => draw() };
  const source = fs.readFileSync(new URL('../js/live/live-layout.js', import.meta.url), 'utf8');
  vm.runInNewContext(
    source
      .replace(/^import .*;\n/gm, '')
      .replace(
        'export { renderLive, resetLiveLayout };',
        'globalThis.api = { renderLive, resetLiveLayout };',
      ),
    context,
  );
  return {
    doc,
    node,
    render: (draw, preserve = true) => context.api.renderLive(draw, element, { preserve }),
    reset: () => context.api.resetLiveLayout(doc),
    leave: () => events.get('series-leave')(),
    disclose: () => events.get('click')({ target: { closest: () => ({}) } }),
    height: () => element.getBoundingClientRect().height,
    shrink: (height) => (element.naturalHeight = height),
    replace: (height) => {
      element = node(height);
      nodes = scope.children = [element];
    },
    otherPage: (height) => {
      scope = { children: [] };
      element = node(height);
      nodes = scope.children = [element];
    },
    anonymousSibling: (height) => {
      element.id = '';
      const sibling = node(height, '');
      nodes = scope.children = [element, sibling];
      return sibling;
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

test('deleting rows with a learner redraw restores natural height for the next state sequence', () => {
  const f = fixture();
  f.render(() => f.shrink(30));
  f.render(() => f.shrink(20), false);
  assert.equal(f.height(), 20);
  f.render(() => f.shrink(10));
  assert.equal(f.height(), 20);
});

test('a nested launcher redraw cannot retain an old table during a learner redraw', () => {
  const f = fixture();
  f.render(() => f.shrink(30));
  f.render(() => f.render(() => f.shrink(20)), false);
  assert.equal(f.height(), 20);
});

test('leaving a course clears its heights before returning to the same course', () => {
  const f = fixture();
  f.render(() => f.shrink(30));
  f.leave();
  f.render(() => f.shrink(20));
  assert.equal(f.height(), 30);
});

test('identical region names on another page never borrow previous heights', () => {
  const f = fixture();
  f.render(() => f.shrink(170));
  f.otherPage(20);
  f.render(() => f.shrink(10));
  assert.equal(f.height(), 20);
});

test('multiple unnamed measurement fields keep independent reservations', () => {
  const f = fixture();
  const sibling = f.anonymousSibling(20);
  f.render(() => {
    f.shrink(30);
    sibling.naturalHeight = 10;
  });
  assert.equal(f.height(), 100);
  assert.equal(sibling.getBoundingClientRect().height, 20);
});

test('retry/reconnection reset drops minima before another state sequence', () => {
  const f = fixture();
  f.render(() => f.shrink(30));
  f.reset();
  assert.equal(f.height(), 30);
  f.render(() => f.shrink(20));
  assert.equal(f.height(), 30);
});

test('a learner collapsing a native details section releases its occupied height', () => {
  const f = fixture();
  f.render(() => f.shrink(30));
  f.disclose();
  assert.equal(f.height(), 30);
});

test('disconnect keeps the robot monitor and its stream rows with an explicit offline label', () => {
  const source = fs.readFileSync(new URL('../js/live/live-ui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\$\('robotMonitor'\)\.hidden = !open/);
  assert.match(source, /\$\('robotMonitor'\)\.hidden = !monitorHello/);
  assert.match(source, /streamRows\(\{ \.\.\.state, hello: monitorHello \}, open\)/);
  // A different rate label must not change table-column widths and wrap a topic above the pad.
  assert.match(
    source,
    /live-text-reserve" aria-hidden="true"\s*>\$\{copy\.monitor\.streamMissing\}/,
  );
  assert.match(
    source,
    /live-text-reserve" aria-hidden="true"\s*>\s*\$\{copy\.monitor\.disconnectedRate\}/,
  );
  assert.match(source, /\['estopPressed', 'estopReleased', 'estopUnknown', 'estopStale'\]\.map/);
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
