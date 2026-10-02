// Press → see (CONTRIBUTING.md, "Figures and charts"): brings the part of the page a learner should
// watch — the figure a run changed, a training board — to the top of the screen. Shared by the
// courses that scroll on their own (rl, arm, vision).
//
// The site header is sticky. On a phone it tucks itself away while the page scrolls down and comes
// back on the first scroll up (shell/series.js, css/navigation.css), so the page-wide
// scroll-padding cannot be right for both directions: scrolling up (or on a wider screen, where the
// header always stays) its height is left free; scrolling down on a phone only a small gap is kept.

const GAP = 12; // CSS pixels between the header (or the top of the screen) and the target
const TUCKING_HEADER = '(max-width: 600px)'; // mirrors the media query in css/navigation.css

function revealElement(element) {
  if (!element) return;
  const top = element.getBoundingClientRect().top;
  const header = document.querySelector('.site-header');
  const headerStays = top < 0 || !window.matchMedia(TUCKING_HEADER).matches;
  const headerHeight = headerStays && header ? header.getBoundingClientRect().height : 0;
  window.scrollBy({ top: top - headerHeight - GAP, behavior: 'instant' });
}

/** Like revealElement, but only when part of `element` is off screen or under the header. */
function revealIfHidden(element) {
  if (!element) return;
  const box = element.getBoundingClientRect();
  const header = document.querySelector('.site-header');
  const headerBottom = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
  const fits = box.height <= window.innerHeight - headerBottom;
  const shown = box.top >= headerBottom && box.bottom <= window.innerHeight;
  if (fits && shown) return;
  if (!fits && box.top >= headerBottom && box.top < window.innerHeight / 2) return;
  revealElement(element);
}

export { revealElement, revealIfHidden };
