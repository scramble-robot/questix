import { render } from '../vendor/lit-html.js';

// Reservations belong to a page/dialog and one sequence of received-state redraws.
// Learner redraws render at their natural height, including nested launcher renders.
const layouts = new WeakMap();
const regions =
  '[data-live-block], .shoot-host, #robotDrive, #robotMonitor, #robotStatus, #motorBench, #motorBenchTable, #controlLive, #controlGraphs, #launchShots, #launchMeasureLayout, [data-measure-live]';

function layoutOf(doc) {
  let layout = layouts.get(doc);
  if (!layout) {
    layout = { scopes: new WeakMap(), width: doc.documentElement.clientWidth, learnerRender: 0 };
    layouts.set(doc, layout);
    doc.addEventListener?.('series-leave', () => resetLiveLayout(doc));
    // Native disclosures do not call a lesson's update(). Release before the learner's toggle,
    // rather than treating a later received status as the cause of the content shrinking.
    doc.addEventListener?.('click', (event) => {
      if (event.target?.closest?.('summary')) resetLiveLayout(doc);
    });
  }
  return layout;
}

function resetLiveLayout(doc = document) {
  for (const element of doc.querySelectorAll(regions)) element.style.minHeight = '';
  const layout = layoutOf(doc);
  layout.scopes = new WeakMap();
  layout.width = doc.documentElement.clientWidth;
}

// A DOM path distinguishes unnamed fields as well as repeated data attributes. Scope identity
// prevents an identical path/name in another page or dialog from borrowing its height.
function regionKey(element, scope) {
  const path = [];
  for (let node = element; node && node !== scope; node = node.parentElement) {
    path.unshift(
      node.id
        ? `#${node.id}`
        : `${node.localName}:${Array.from(node.parentElement.children).indexOf(node)}`,
    );
  }
  return path.join('/');
}

function renderLive(value, container, { preserve = false } = {}) {
  const doc = container?.ownerDocument;
  if (!doc?.querySelectorAll) return render(value, container);
  const layout = layoutOf(doc);
  if (layout.width !== doc.documentElement.clientWidth) resetLiveLayout(doc);
  if (layout.learnerRender) return render(value, container);
  if (!preserve) {
    resetLiveLayout(doc);
    layout.learnerRender++;
    try {
      return render(value, container);
    } finally {
      layout.learnerRender--;
    }
  }
  const reserve = () => {
    for (const element of doc.querySelectorAll(regions)) {
      if (!element.getClientRects().length) continue;
      const scope = element.closest('.page, dialog') ?? doc.body;
      let heights = layout.scopes.get(scope);
      if (!heights) layout.scopes.set(scope, (heights = new Map()));
      const key = regionKey(element, scope);
      const previous = heights.get(key) ?? 0;
      // Set a replacement node's minimum before reading geometry, to avoid scrollTop clamping.
      if (previous) element.style.minHeight = `${previous}px`;
      const height = Math.max(previous, element.getBoundingClientRect().height);
      heights.set(key, height);
      element.style.minHeight = `${height}px`;
    }
  };
  reserve();
  render(value, container);
  reserve();
}

export { renderLive, resetLiveLayout };
