import { loadJson } from '../core/content.js';
import { revealElement, revealIfHidden } from '../core/reveal.js';
import { escapeHtml } from './html-escape.js';
import { runModeStripHtml } from './run-mode.js';

// Every experiment opens the same way, in the same reading order, on a phone and on a Chromebook:
// 1. a card 「最初に試すこと」 with the first thing to do and a button that starts it (or brings the
//    part to use on screen), right under the course's heading and navigation, so the first action
//    is on the first screen of every course;
// 2. the brief: one row saying what the experiment runs on (the simulation, the connected robot, or
//    values measured on it, run-mode.js), then the situation and the purpose (what to compare).
// Sections are authored explicitly in content/lesson-guides.json (or by the course); nothing is
// inferred from sentence position. On a phone the situation and the purpose are cut to two lines
// each, with a button that opens them in full.
// The result is an HTML string because course modules embed it in their own markup; the start
// button is handled by one delegated listener (startFirstStep).

const copy = await loadJson('content/shell/lesson-brief.json');

// [{ key, title, cue }]: `key` names the content field, `cue` the lesson icon of the heading.
const BRIEF_SECTIONS = copy.sections;
const FIRST_SECTION = BRIEF_SECTIONS.find((section) => section.key === 'first');
// The start button of a course that names none: the page's first main button after the card.
const AUTO_TARGET = 'auto';
const AUTO_SELECTOR = 'button.primary';

const paragraphs = (text) => (Array.isArray(text) ? text : [text]);
const bodyHtml = (text) =>
  paragraphs(text)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join('');

function briefSection(section, content) {
  const heading = `<h2 data-lesson-cue="${section.cue}">${section.title}</h2>`;
  return `<div class="lesson-brief-${section.key}">${heading}${bodyHtml(content[section.key])}</div>`;
}

// Placed after the purpose; shown on phones only (css/hs-shell.css).
const moreButton = () =>
  `<button type="button" class="lesson-brief-more" data-brief-more aria-expanded="false">${escapeHtml(copy.more)}</button>`;

/**
 * The start of the card: `{label, target, press}` — `target` a selector inside the course page (or
 * 'auto': its first main button after the card), `press` whether the button presses the target
 * (a simulation's start) or only brings it on screen and focuses it (a block on the real robot,
 * where the learner confirms the safety check first).
 */
function startOf(start) {
  return {
    label: start?.label ?? copy.quickStart.go,
    target: start?.target ?? AUTO_TARGET,
    press: Boolean(start?.press),
  };
}

function quickStartCard(key, content, start) {
  const { label, target, press } = startOf(start);
  const button =
    `<button type="button" class="primary" data-quick-start="${escapeHtml(target)}"` +
    `${press ? ' data-quick-press' : ''}>${escapeHtml(label)}</button>`;
  return (
    `<section class="lesson-quickstart" data-quick-start-card="${escapeHtml(key)}" aria-label="${escapeHtml(FIRST_SECTION.title)}">` +
    `<h2 data-lesson-cue="${FIRST_SECTION.cue}">${FIRST_SECTION.title}</h2>` +
    `${bodyHtml(content.first)}<div class="lesson-quickstart-actions">${button}</div></section>`
  );
}

/**
 * `options.start`: the card's button (see startOf); `options.first: false` for a course that shows
 * its own 「最初に試すこと」 card (the systems courses) — the brief then leaves the section out.
 */
function lessonBrief(key, content, options = {}) {
  const ownCard = options.first === false;
  const card = !ownCard && content.first ? quickStartCard(key, content, options.start) : '';
  const sections = BRIEF_SECTIONS.filter((section) => section.key !== 'first')
    .map((section) => briefSection(section, content))
    .join('');
  const brief = `<section class="lesson-brief" data-lesson-brief="${escapeHtml(key)}" aria-label="${copy.ariaLabel}">${runModeStripHtml(key)}${sections}${moreButton()}</section>`;
  return card + brief;
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

const shown = (element) => element.offsetParent !== null || element.getClientRects().length > 0;

// The part the card's button starts, looked up inside the page the button is on (every course page
// keeps its own copy of its blocks).
function firstStepTarget(button) {
  const page = button.closest('.page') ?? document;
  const selector = button.dataset.quickStart;
  if (selector !== AUTO_TARGET) return page.querySelector(selector);
  const card = button.closest('.lesson-quickstart');
  const main = [...page.querySelectorAll(AUTO_SELECTOR)].find(
    (candidate) =>
      shown(candidate) &&
      !candidate.closest('.lesson-quickstart, .lesson-brief') &&
      Boolean(card.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING),
  );
  return main ?? blockAfterBrief(card, page);
}

const SKIPPED_AFTER_BRIEF = '.lesson-brief, .supplement-trigger, details[data-help-dialog]';

// A page without a main button (a figure to look at first): the first part after the brief, also
// when the course wraps the card and the brief in an element of its own.
function blockAfterBrief(card, page) {
  for (let from = card; from && from !== page; from = from.parentElement) {
    for (let element = from.nextElementSibling; element; element = element.nextElementSibling)
      if (!element.matches(SKIPPED_AFTER_BRIEF) && shown(element)) return element;
  }
  return null;
}

// Press → see: a simulation's start is pressed (the course then shows what it does, as its own
// button would); anything else — a disabled button, a block on the real robot — is brought on
// screen and focused, so the learner's next press is the right one.
function startFirstStep(event) {
  const button = event.target.closest?.('[data-quick-start]');
  if (!button) return;
  const target = firstStepTarget(button);
  if (!target) return;
  const pressable = target.matches('button') && !target.disabled;
  if (pressable && button.hasAttribute('data-quick-press')) {
    const before = window.scrollY;
    target.click();
    // A course that does not bring its result on screen itself: at least the part it started.
    requestAnimationFrame(() => {
      if (window.scrollY === before && target.isConnected)
        revealIfHidden(target.closest('.card, section') ?? target);
    });
    return;
  }
  revealElement(target);
  const focusable = target.matches('button, input, select, summary, [tabindex]')
    ? target
    : target.querySelector('button:not(:disabled), input, select, summary');
  focusable?.focus({ preventScroll: true });
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', toggleBrief);
  document.addEventListener('click', startFirstStep);
}

export { BRIEF_SECTIONS, lessonBrief };
