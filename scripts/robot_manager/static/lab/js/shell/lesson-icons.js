// Small, decorative SVG cues. The visible heading remains the accessible name.
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
  return SHAPES[kind]
    ? `<svg class="lesson-cue-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${SHAPES[kind]}</svg>`
    : '';
}
// Roles are assigned by the purpose of each section, never by guessing its text.
const RULES = [
  [
    'learn',
    '.planning-explanation > h2, .control-explanation > h2, #rlExplanation > h3, .arm-hardware-note > h2, .school-tip-grid > div:first-child > h3',
  ],
  [
    'action',
    '#basicsControls > h2, #rlControls > h2, #visionControls > h2, .control-guide > h2, .planning-guide > h2, .launch-guide > h2, .arm-guide > h2, #slamSettings > h2',
  ],
  [
    'observe',
    '.figure-guide > strong, .basics-visual-heading > h2, .sensor-explanation > h3, .sensor-disclosure > span > strong, .school-tip-observe > h3',
  ],
  [
    'result',
    '#visionEvidence > h2, .control-result-heading h2, .control-graphs > .section-top > h2, #planningResults > .section-top > h2, #planningHistory > .section-top > h2, .launch-data > .section-top > h2, #resultsBoard h2, .slam-comparison > .section-top > h2, #slamProgressGuide > h2, #rlExtra > h3',
  ],
  [
    'reflect',
    '#basicsQuestion > h2, #rlQuestion > h2, #visionReflect > h2, .control-question > h2, .planning-reflection > h3, .launch-reflection > h2, .arm-reflection > h2, .result-reflection > h3, .next-question',
  ],
  [
    'reference',
    '.school-tip-label, .supplement-trigger:not(.supplement-tip-trigger) > .supplement-trigger-copy, #supplementTitle',
  ],
];
function initLessonIcons() {
  if (typeof MutationObserver === 'undefined') return;
  const selector = RULES.map((r) => r[1]).join(',') + ', [data-lesson-cue]';
  function enhance(root) {
    if (root.nodeType === 3) root = root.parentElement;
    if (!root || ![1, 9].includes(root.nodeType) || root.closest?.('svg')) return;
    const headings = [
      ...(root.matches?.(selector) ? [root] : []),
      ...root.querySelectorAll(selector),
    ];
    for (const h of headings) {
      if (!h.textContent.trim()) continue;
      const kind = h.getAttribute('data-lesson-cue') || RULES.find(([, s]) => h.matches(s))?.[0];
      if (!SHAPES[kind]) continue;
      h.classList.add('lesson-cue');
      h.setAttribute('data-cue-kind', kind);
      if (!h.querySelector(':scope > .lesson-cue-icon'))
        h.insertAdjacentHTML('afterbegin', lessonIcon(kind));
    }
  }
  enhance(document);
  new MutationObserver((records) => {
    const roots = new Set();
    for (const r of records) {
      if (r.type === 'characterData') roots.add(r.target);
      else for (const n of r.addedNodes) roots.add(n);
    }
    roots.forEach(enhance);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}

export { lessonIcon, initLessonIcons };
