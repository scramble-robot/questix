import { loadJson } from '../core/content.js';
import { escapeHtml } from './html-escape.js';
import { runModeStripHtml } from './run-mode.js';

// Every experiment opens with the same three sections, in the same reading order: the situation,
// the purpose (what to compare) and the first thing to try. Sections are authored explicitly in
// content/lesson-guides.json (or by the course); nothing is inferred from sentence position.
// Above them, one row says what the experiment runs on: the simulation, the connected robot, or
// values measured on it (run-mode.js).
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

function lessonBrief(key, content) {
  const sections =
    runModeStripHtml(key) +
    BRIEF_SECTIONS.map((section) => briefSection(section, content)).join('');
  return `<section class="lesson-brief" data-lesson-brief="${escapeHtml(key)}" aria-label="${copy.ariaLabel}">${sections}</section>`;
}

export { BRIEF_SECTIONS, lessonBrief };
