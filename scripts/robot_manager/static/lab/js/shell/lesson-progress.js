import { html, nothing, render } from '../vendor/lit-html.js';
import { fillSentence as fill, loadJson } from '../core/content.js';
import { revealElement } from '../core/reveal.js';
import { progressModel, parseVisited } from './lesson-progress-core.js';

// One footer under every course (#lessonFooter): where the learner is among the course's
// experiments, a numbered list to jump to any of them, and previous / next. Courses report their
// experiments with reportLessonProgress each time they show one; nothing else about a course is
// known here. The summary card (quiz/ui.js) asks lessonReady() so it opens fully only at the end.
// Visited experiments are remembered per browser (localStorage, optional).

const copy = await loadJson('content/shell/lesson-progress.json');
const STORAGE_KEY = 'questix-lab.lesson-visited';

const courses = new Map(); // course → { topics, current, open }
let visited = readVisited();
let shownCourse = null;

function readVisited() {
  try {
    return parseVisited(localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

function saveVisited() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(visited));
  } catch {
    // Without storage the footer still works for this visit.
  }
}

const footer = () => document.getElementById('lessonFooter');

function modelOf(course) {
  const entry = courses.get(course);
  if (!entry || !entry.topics.length) return null;
  return progressModel({ ...entry, visited: visited[course] ?? [] });
}

function openTopic(course, id) {
  courses.get(course)?.open(id);
  // The course re-renders the chosen experiment; bring its top on screen.
  revealElement(document.querySelector('main > .page:not([hidden])'));
}

function toSummary() {
  const summary = document.getElementById('quizEntry');
  if (summary && !summary.hidden) revealElement(summary);
}

function stepButton(course, item) {
  const state = item.current ? copy.currentMark : item.visited ? copy.visitedMark : '';
  return html`<li>
    <button
      class=${[
        'lesson-footer-step',
        item.current ? 'is-current' : '',
        item.visited ? 'is-visited' : '',
      ].join(' ')}
      aria-current=${item.current ? 'step' : nothing}
      @click=${() => openTopic(course, item.id)}
    >
      <span class="lesson-footer-number" aria-hidden="true"
        >${item.visited && !item.current ? '✓' : item.number}</span
      >
      <span class="lesson-footer-title">${item.title}</span>
      ${state ? html`<span class="sr-only">（${state}）</span>` : nothing}
    </button>
  </li>`;
}

function footerView(course, model) {
  return html`<nav aria-label=${copy.label}>
    <div class="lesson-footer-head">
      <p class="eyebrow">${copy.label} · ${fill(copy.position, model)}</p>
      <p class="lesson-footer-visited">
        ${fill(copy.visited, { visited: model.visitedCount, total: model.total })}
      </p>
    </div>
    <ol class="lesson-footer-steps" aria-label=${copy.stepsLabel}>
      ${model.items.map((item) => stepButton(course, item))}
    </ol>
    ${model.last ? html`<p class="lesson-footer-note">${copy.summaryNote}</p>` : nothing}
    <div class="lesson-footer-actions">
      ${
        model.previous
          ? html`<button
              class="lesson-footer-previous"
              @click=${() => openTopic(course, model.previous.id)}
            >
              ← ${copy.previous}<span>${model.previous.title}</span>
            </button>`
          : nothing
      }
      ${
        model.next
          ? html`<button
              class="primary lesson-footer-next"
              @click=${() => openTopic(course, model.next.id)}
            >
              ${copy.next}<span>${model.next.title}</span> →
            </button>`
          : html`<button class="primary lesson-footer-next" @click=${toSummary}>
              ${copy.toSummary} ↓
            </button>`
      }
    </div>
  </nav>`;
}

function renderFooter() {
  const element = footer();
  if (!element) return;
  const model = shownCourse ? modelOf(shownCourse) : null;
  element.hidden = !model;
  render(model ? footerView(shownCourse, model) : nothing, element);
}

/**
 * Called by a course whenever it shows an experiment: `topics` [{ id, title }] in teaching order,
 * `current` the id on screen, `open(id)` shows another one.
 */
function reportLessonProgress(course, { topics, current, open }) {
  const before = courses.get(course);
  courses.set(course, { topics, current, open });
  // Courses report from their update(), which may run many times per experiment (playback):
  // only a change of experiment redraws the footer and the summary.
  const same =
    before?.current === current &&
    before.topics.length === topics.length &&
    before.topics.every((topic, index) => topic.id === topics[index].id);
  if (same) return;
  const seen = new Set(visited[course] ?? []);
  if (!seen.has(current)) {
    seen.add(current);
    visited = { ...visited, [course]: [...seen] };
    saveVisited();
  }
  if (course === shownCourse) renderFooter();
  document.dispatchEvent(new CustomEvent('lesson-progress', { detail: { course } }));
}

/** The shell tells which course page is on screen (null: catalogue, quiz or records). */
function showLessonFooter(course) {
  shownCourse = course;
  renderFooter();
}

/** Where the learner is in a course, for the summary card; null before the course reported. */
function lessonProgress(course) {
  return modelOf(course);
}

export { reportLessonProgress, showLessonFooter, lessonProgress };
