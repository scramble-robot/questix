// The learner's motion preference also applies to explicit jump links and dialog navigation.
function scrollBehavior(matchMedia = globalThis.matchMedia) {
  return matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
}

export { scrollBehavior };
