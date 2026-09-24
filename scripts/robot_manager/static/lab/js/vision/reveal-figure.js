// Press → see (CONTRIBUTING.md, "Figures and charts"): after a run, bring the figure it changed
// back on screen, just below the site header when that header will be showing. Used by the arm,
// vision and SLAM courses; it belongs in js/core/dom.js once that module takes shared scrolling.

const HEADER_TUCKS = '(max-width: 600px)'; // series.js tucks the header while scrolling down
const GAP = 8; // px left above the figure

/** Scrolls so `element` starts at the top of what the learner can see. */
function revealFigure(element) {
  if (!element) return;
  const header = document.querySelector('.site-header');
  const top = element.getBoundingClientRect().top + window.scrollY;
  const scrollingUp = top - GAP < window.scrollY;
  const sticky = header && ['sticky', 'fixed'].includes(getComputedStyle(header).position);
  // Scrolling down on a phone tucks the header away; anywhere else a sticky header stays.
  const headerShows = sticky && (scrollingUp || !globalThis.matchMedia?.(HEADER_TUCKS).matches);
  const offset = headerShows ? header.offsetHeight + GAP : GAP;
  window.scrollTo({ top: Math.max(0, top - offset), behavior: 'instant' });
}

export { revealFigure };
