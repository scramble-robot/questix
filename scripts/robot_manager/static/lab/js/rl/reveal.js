// Press → see: brings the part of the page a learner should watch to the top of the screen.
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

export { revealElement };
