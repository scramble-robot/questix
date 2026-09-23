import { loadJson } from '../core/content.js';
import { escapeHtml } from './html-escape.js';

// What an experiment runs on: the in-browser simulation ('sim'), the connected robot ('live'), or
// values measured on the robot and typed in or opened as a file ('data'). One vocabulary, shown on
// the catalogue cards, in the course switcher, at the top of every experiment and on the blocks
// that take robot data, so a learner can tell before starting whether the robot is needed.
// Which course and topic uses which mode is declared in content/shell/run-modes.json.

const copy = await loadJson('content/shell/run-modes.json');

const RUN_MODES = copy.modes;
const RUN_MODE_ORDER = Object.keys(RUN_MODES);

const courseRunModes = (courseId) => copy.courses[courseId] ?? null;

// A topic entry matches its exact lesson key ("launch-measure") or every topic of a course
// ("control" matches "control-p"). Lesson keys of unknown courses have no entry at all.
const matches = (entryKey, lessonKey) =>
  lessonKey === entryKey || lessonKey.startsWith(entryKey + '-');

function topicRunModes(lessonKey) {
  const course = lessonKey.split('-')[0];
  const entry = copy.topics.find((topic) => topic.keys.some((key) => matches(key, lessonKey)));
  if (entry) return entry;
  // The reinforcement-learning lab pages use "lab-…" keys.
  if (courseRunModes(course) || course === 'lab') return copy.defaultTopic;
  return null;
}

function runModeBadgeHtml(mode) {
  const text = RUN_MODES[mode];
  return `<span class="run-mode run-mode-${mode}" title="${escapeHtml(text.description)}">${escapeHtml(text.label)}</span>`;
}

// The first row of a lesson brief. The jump button scrolls to the block that takes robot data;
// it is a button, not a link, because the hash is the router's (a "#…" link would change page).
function runModeStripHtml(lessonKey) {
  const entry = topicRunModes(lessonKey);
  if (!entry) return '';
  const badges = entry.modes.map(runModeBadgeHtml).join('');
  const jump = entry.target
    ? `<button type="button" class="run-mode-jump" data-run-mode-target="${escapeHtml(entry.target)}">${escapeHtml(copy.jump)}</button>`
    : '';
  return (
    `<div class="run-mode-strip" data-run-mode="${entry.modes.join(' ')}">` +
    `<span class="run-mode-strip-label">${escapeHtml(copy.stripLabel)}</span>` +
    `<span class="run-mode-badges">${badges}</span>` +
    `<p>${escapeHtml(entry.note)}</p>${jump}</div>`
  );
}

const GAP_BELOW_HEADER = 16; // px between the sticky header and the block scrolled to

// Delegated once for every brief: scroll to the named block of the page the button is on (every
// course page keeps its own copy of the blocks, so the lookup stays inside that page). The header
// stays on screen (sticky), so the block goes just below it.
function scrollToRunModeTarget(event) {
  const button = event.target.closest?.('[data-run-mode-target]');
  if (!button) return;
  const page = button.closest('.page') ?? document;
  const target = page.querySelector(button.dataset.runModeTarget);
  if (!target) return;
  const header = document.querySelector('.site-header');
  const top = target.getBoundingClientRect().top + window.scrollY;
  window.scrollTo({
    top: top - (header?.offsetHeight ?? 0) - GAP_BELOW_HEADER,
    behavior: 'smooth',
  });
  if (target.matches('button, input, [tabindex]')) target.focus({ preventScroll: true });
}

if (typeof document !== 'undefined') document.addEventListener('click', scrollToRunModeTarget);

export {
  RUN_MODES,
  RUN_MODE_ORDER,
  copy as RUN_MODE_COPY,
  courseRunModes,
  topicRunModes,
  runModeBadgeHtml,
  runModeStripHtml,
};
