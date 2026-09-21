// Every experiment uses the same three sections, in the same reading order.
// Content is explicitly authored; do not infer sections from sentence position.
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const BRIEF_SECTIONS = [
  { key: 'scene', title: 'この実験の状況', cue: 'reference' },
  { key: 'purpose', title: '目的と比べること', cue: 'learn' },
  { key: 'first', title: '最初に試すこと', cue: 'action' },
];
function lessonBrief(key, content) {
  return `<section class="lesson-brief" data-lesson-brief="${escape(key)}" aria-label="実験の状況・目的・手順">${BRIEF_SECTIONS.map((s) => `<div class="lesson-brief-${s.key}"><h2 data-lesson-cue="${s.cue}">${s.title}</h2>${(Array.isArray(content[s.key]) ? content[s.key] : [content[s.key]]).map((p) => `<p>${escape(p)}</p>`).join('')}</div>`).join('')}</section>`;
}

export { BRIEF_SECTIONS, lessonBrief };
