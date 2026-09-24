import { loadJson } from '../core/content.js';
import { escapeHtml } from './html-escape.js';
import { runModeStripHtml } from './run-mode.js';

// Every experiment opens with the same three sections, in the same reading order: the situation,
// the purpose (what to compare) and the first thing to try. Sections are authored explicitly in
// content/lesson-guides.json (or by the course); nothing is inferred from sentence position.
// Above them, one row says what the experiment runs on: the simulation, the connected robot, or
// values measured on it (run-mode.js).
// On a phone the situation and the purpose are cut to two lines each, with a button that opens
// them in full, so 最初に試すこと — the first thing to do — is on the first screen.
// The result is an HTML string because course modules embed it in their own markup.

const copy = await loadJson('content/shell/lesson-brief.json');

// [{ key, title, cue }]: `key` names the content field, `cue` the lesson icon of the heading.
const BRIEF_SECTIONS = copy.sections;

const paragraphs = (text) => (Array.isArray(text) ? text : [text]);

function briefSection(section, content) {
  const body = paragraphs(content[section.key])
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join('');
  const heading = `<h2 data-lesson-cue="${section.cue}">${section.title}</h2>`;
  return `<div class="lesson-brief-${section.key}">${heading}${body}</div>`;
}

// Placed after the purpose, before 最初に試すこと; shown on phones only (css/hs-shell.css).
const moreButton = () =>
  `<button type="button" class="lesson-brief-more" data-brief-more aria-expanded="false">${escapeHtml(copy.more)}</button>`;

function lessonBrief(key, content) {
  const sections =
    runModeStripHtml(key) +
    BRIEF_SECTIONS.map(
      (section) => (section.key === 'first' ? moreButton() : '') + briefSection(section, content),
    ).join('');
  return `<section class="lesson-brief" data-lesson-brief="${escapeHtml(key)}" aria-label="${copy.ariaLabel}">${sections}</section>`;
}

// Delegated once for every brief, like run-mode.js's jump button.
function toggleBrief(event) {
  const button = event.target.closest?.('[data-brief-more]');
  if (!button) return;
  const brief = button.closest('.lesson-brief');
  const open = !brief.classList.contains('is-open');
  brief.classList.toggle('is-open', open);
  button.setAttribute('aria-expanded', String(open));
  button.textContent = open ? copy.less : copy.more;
}

if (typeof document !== 'undefined') document.addEventListener('click', toggleBrief);

export { BRIEF_SECTIONS, lessonBrief };
