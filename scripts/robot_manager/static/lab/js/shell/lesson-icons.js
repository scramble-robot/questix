// Small, decorative SVG cues in front of section headings. The visible heading text remains the
// accessible name; the icon only says what kind of section follows (learn, act, observe, …).

const ICON_SIZE = 24; // px, also the viewBox side
const STROKE_WIDTH = 1.7;

const SHAPES = {
  learn:
    '<path d="M8.5 15.5C8.5 13 5.5 12.5 5.5 8.5a6.5 6.5 0 0 1 13 0c0 4-3 4.5-3 7M8.5 16h7M9 19h6M10 22h4M12 1V0"/><path d="M10 12l2 2 2-2M12 14v2"/>',
  action: '<path d="m8 5 12 7-12 7Z"/><path d="M3 5v14"/>',
  observe:
    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  result: '<path d="M3 3v18h18M7 16v-4M12 16V7M17 16V4"/>',
  reflect:
    '<path d="M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-8l-6 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M9.5 8a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 15h.01"/>',
  reference:
    '<path d="M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1ZM12 5v15M5 8h3M5 12h3M16 8h3M16 12h3"/>',
};

function lessonIcon(kind) {
  const shape = SHAPES[kind];
  if (!shape) return '';
  return `<svg class="lesson-cue-icon" viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}" width="${ICON_SIZE}" height="${ICON_SIZE}" fill="none" stroke="currentColor" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${shape}</svg>`;
}

// Which headings get which cue, by the purpose of their section. A heading may also declare its
// cue with data-lesson-cue. Kinds are matched in this order; roles are never guessed from text.
const CUE_SELECTORS = {
  learn:
    '.planning-explanation > h2, .control-explanation > h2, #rlExplanation > h3, .arm-hardware-note > h2, .school-tip-grid > div:first-child > h3',
  action:
    '#basicsControls > h2, #rlControls > h2, #visionControls > h2, .control-guide > h2, .planning-guide > h2, .launch-guide > h2, .arm-guide > h2, #slamSettings > h2',
  observe:
    '.figure-guide > strong, .basics-visual-heading > h2, .sensor-explanation > h3, .sensor-disclosure > span > strong, .school-tip-observe > h3',
  result:
    '#visionEvidence > h2, .control-result-heading h2, .control-graphs > .section-top > h2, #planningResults > .section-top > h2, #planningHistory > .section-top > h2, .launch-data > .section-top > h2, #resultsBoard h2, .slam-comparison > .section-top > h2, #slamProgressGuide > h2, #rlExtra > h3',
  reflect:
    '#basicsQuestion > h2, #rlQuestion > h2, #visionReflect > h2, .control-question > h2, .planning-reflection > h3, .launch-reflection > h2, .arm-reflection > h2, .result-reflection > h3, .next-question',
  reference:
    '.school-tip-label, .supplement-trigger:not(.supplement-tip-trigger) > .supplement-trigger-copy, #supplementTitle',
};
const HEADING_SELECTOR = [...Object.values(CUE_SELECTORS), '[data-lesson-cue]'].join(',');

function cueKind(heading) {
  const declared = heading.getAttribute('data-lesson-cue');
  if (declared) return declared;
  return Object.keys(CUE_SELECTORS).find((kind) => heading.matches(CUE_SELECTORS[kind]));
}

function addCue(heading) {
  if (!heading.textContent.trim()) return;
  const kind = cueKind(heading);
  if (!SHAPES[kind]) return;
  heading.classList.add('lesson-cue');
  heading.setAttribute('data-cue-kind', kind);
  if (!heading.querySelector(':scope > .lesson-cue-icon'))
    heading.insertAdjacentHTML('afterbegin', lessonIcon(kind));
}

// Text changes are reported on the text node; the heading to decorate is its parent.
function elementOf(node) {
  return node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
}

function decorateHeadings(node) {
  const root = elementOf(node);
  const searchable =
    root && (root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_NODE);
  if (!searchable || root.closest?.('svg')) return;
  if (root.matches?.(HEADING_SELECTOR)) addCue(root);
  for (const heading of root.querySelectorAll(HEADING_SELECTOR)) addCue(heading);
}

function changedRoots(records) {
  const roots = new Set();
  for (const record of records) {
    if (record.type === 'characterData') roots.add(record.target);
    else for (const node of record.addedNodes) roots.add(node);
  }
  return roots;
}

function initLessonIcons() {
  if (typeof MutationObserver === 'undefined') return;
  decorateHeadings(document);
  const observer = new MutationObserver((records) =>
    changedRoots(records).forEach(decorateHeadings),
  );
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

export { lessonIcon, initLessonIcons };
