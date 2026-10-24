// Press → see (CONTRIBUTING.md, "Figures and charts"): brings the part of the page a learner should
// watch — the figure a run changed, a training board — to the top of the screen. Shared by the
// courses that scroll on their own (rl, arm, vision).
//
// The header remains visible at every width; the target always clears its actual height.

const GAP = 12; // CSS pixels between the header (or the top of the screen) and the target

function revealElement(element) {
  if (!element) return;
  const top = element.getBoundingClientRect().top;
  const header = document.querySelector('.site-header');
  const headerHeight = header ? header.getBoundingClientRect().height : 0;
  window.scrollBy({ top: top - headerHeight - GAP, behavior: 'instant' });
}

/** Like revealElement, but only when part of `element` is off screen or under the header. */
function revealIfHidden(element) {
  if (!element) return;
  const box = element.getBoundingClientRect();
  const header = document.querySelector('.site-header');
  const headerBottom = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
  const bar = document.getElementById('liveStopBar');
  const bottom = bar && !bar.hidden ? bar.getBoundingClientRect().top : window.innerHeight;
  const fits = box.height <= bottom - headerBottom;
  const shown = box.top >= headerBottom && box.bottom <= bottom;
  if (fits && shown) return;
  if (!fits && box.top >= headerBottom && box.top < window.innerHeight / 2) return;
  revealElement(element);
}

export { revealElement, revealIfHidden };
