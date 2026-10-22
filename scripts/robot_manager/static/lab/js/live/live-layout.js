import { render } from '../vendor/lit-html.js';

// A live result may grow, but removing a status must not shorten the page at its bottom and
// clamp scrollTop. Remember occupied space before a synchronous redraw, including portalled
// measurement controls. A width change starts a fresh reservation; text is never clipped.
const layouts = new WeakMap();
const regions =
  '[data-live-block], .shoot-host, #robotDrive, #robotMonitor, #robotStatus, #motorBench, #motorBenchTable, #controlLive, #controlGraphs, #launchShots, #launchMeasureLayout, [data-measure-live]';
function keyOf(element) {
  return (
    element.id ||
    element.getAttribute('data-live-block') ||
    element.getAttribute('data-shoot-place') ||
    'measurement-live'
  );
}
function renderLive(value, container) {
  const doc = container?.ownerDocument;
  if (!doc?.querySelectorAll) return render(value, container);
  const width = doc.documentElement.clientWidth;
  let layout = layouts.get(doc);
  if (!layout || layout.width !== width) {
    for (const element of doc.querySelectorAll(regions)) element.style.minHeight = '';
    layout = { width, heights: new Map() };
    layouts.set(doc, layout);
  }
  const reserve = () => {
    for (const element of doc.querySelectorAll(regions)) {
      const key = keyOf(element);
      // Apply the remembered value before reading geometry: a new lit instance must not cause
      // a transient shrink while replacing an old one with the same logical slot.
      const previous = layout.heights.get(key) ?? 0;
      if (previous) element.style.minHeight = `${previous}px`;
      if (!element.getClientRects().length) continue;
      const height = Math.max(previous, element.getBoundingClientRect().height);
      layout.heights.set(key, height);
      element.style.minHeight = `${height}px`;
    }
  };
  reserve();
  render(value, container);
  reserve();
}

export { renderLive };
