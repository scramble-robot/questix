import { html, nothing, render } from '../vendor/lit-html.js';
import { loadJson, fillSentence } from '../core/content.js';
import { LESSONS } from './lesson-ui.js';
import { courseResources, japaneseDate } from './learning-resources-core.js';

// もっと詳しく学ぶ: a card under every course page (`#referencesEntry` in index.html) whose
// supplement dialog lists curated Japanese reading for that course — articles, lesson videos and
// books on other sites. The list, its wording and the dates it was checked live in
// content/shell/learning-resources.json; the shell (series.js) shows the card for the open course
// and hides it on the catalogue, the tests and 記録の一覧. Nothing here talks to the robot.

const data = await loadJson('content/shell/learning-resources.json');
const copy = data.copy;

const lessonTitle = (courseId) => LESSONS.find((lesson) => lesson.id === courseId)?.title;

function resourceItem(resource) {
  return html`<article class="reference-item">
    <div class="reference-meta">
      <span>${copy.kinds[resource.kind]}</span><span>${resource.level}</span>
    </div>
    <h3>
      <a href=${resource.url} target="_blank" rel="noopener noreferrer"
        >${resource.title}<span class="reference-external" aria-hidden="true">↗</span
        ><span class="sr-only">${copy.newTab}</span></a
      >
    </h3>
    <p class="reference-publisher">${resource.publisher}</p>
    <p class="reference-site">${copy.external} · ${resource.site}</p>
    <p>${resource.description}</p>
    <p class="reference-start"><strong>${copy.start}</strong>${resource.start}</p>
    ${resource.kind === 'book' ? html`<p class="reference-book-note">${copy.bookNote}</p>` : nothing}
  </article>`;
}

function datedLine(label, iso) {
  return html`<p>${label}<time datetime=${iso}>${japaneseDate(iso)}</time></p>`;
}

function policy(list) {
  return html`<details class="reference-policy">
    <summary>${copy.policyTitle}</summary>
    ${copy.policy.map((paragraph) => html`<p>${paragraph}</p>`)}
    ${datedLine(copy.reviewedOn, list.reviewedOn)} ${datedLine(copy.checkedOn, list.checkedOn)}
  </details>`;
}

// The details opens in the shared supplement dialog (shell/supplement-ui.js), which puts a
// button with the summary in its place; data-help-action names that button's action.
function resourcesCard(list, title) {
  return html`<details data-help-dialog data-help-action=${copy.action}>
      <summary>
        ${copy.summary}
        <span class="reference-count"
          >${fillSentence(copy.count, { count: list.resources.length })}</span
        >
      </summary>
      <div class="reference-reading">
        <p class="reference-course">${title}</p>
        <p class="reference-intro">${copy.intro}</p>
        <div class="reference-list">${list.resources.map(resourceItem)}</div>
        ${policy(list)}
        <p class="reference-network">${copy.network}</p>
      </div>
    </details>
    <p class="reference-caption">${fillSentence(copy.caption, { course: title })}</p>`;
}

/**
 * Shows the reading list of `courseId` under its page, or hides the card (null, the catalogue,
 * a course without a list).
 */
function showLearningResources(courseId) {
  const host = document.getElementById('referencesEntry');
  if (!host) return;
  const list = courseId ? courseResources(data, courseId) : null;
  const title = courseId ? lessonTitle(courseId) : null;
  // Rendered from scratch each time: the supplement button copies the summary (with its count)
  // when it is created, so a card left over from another course would keep that course's count.
  render(nothing, host);
  host.hidden = !list || !title;
  if (!host.hidden) render(resourcesCard(list, title), host);
}

export { showLearningResources };
