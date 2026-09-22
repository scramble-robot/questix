import { html, nothing, unsafeHTML, live } from '../vendor/lit-html.js';
import { lessonIcon } from '../shell/lesson-icons.js';
import { fillSentence as fill } from '../core/content.js';

// Templates of the checkpoint quiz: the entry card on a course page, the review card that guides
// the learner back to an experiment, and the quiz page itself. Every function is pure and turns
// the model built by ui.js into markup. Sentences come from content/quiz/quiz.json (`copy`).

const CHOICE_LETTERS = 'ABC';

// Replaces `{name}` placeholders in a sentence from the content file.

function statusLabel(answer, copy) {
  if (!answer?.checked) return copy.status.unanswered;
  if (!answer.correct) return copy.status.review;
  return answer.firstCorrect ? copy.status.correct : copy.status.recovered;
}

function startLabel(summary, copy) {
  if (summary.checked === summary.total) return copy.entry.quizResults;
  return summary.checked ? copy.entry.quizContinue : copy.entry.quizStart;
}

function quizEntryCard(model, copy, actions) {
  const summary = model.summary;
  return html`<div>
      <p class="eyebrow">${copy.entry.eyebrow}</p>
      <h2>${unsafeHTML(lessonIcon('reflect'))}${copy.entry.title}</h2>
      <p>${fill(copy.entry.lead, { title: model.lessonTitle })}</p>
    </div>
    <div class="assessment-options">
      <section>
        <h3>${copy.entry.quizTitle} <span>${copy.entry.quizFormat}</span></h3>
        <p>${copy.entry.quizDescription}</p>
        ${
          summary.checked
            ? html`<span class="quiz-entry-progress"
                >${fill(copy.entry.quizProgress, summary)}</span
              >`
            : nothing
        }
        <button id="quizStart" @click=${actions.startQuiz}>${startLabel(summary, copy)} →</button>
      </section>
      <section>
        <h3>${copy.entry.masteryTitle} <span>${copy.entry.masteryFormat}</span></h3>
        <p>${copy.entry.masteryDescription}</p>
        <button id="masteryStart" class="primary" @click=${actions.startMastery}>
          ${model.masteryLabel} →
        </button>
      </section>
    </div>`;
}

function quizReviewCard(model, copy, actions) {
  return html`<div class="quiz-review-copy">
      <p class="eyebrow">${fill(copy.review.eyebrow, model)}</p>
      <h2 id="quizReviewTitle" tabindex="-1">${model.concept}</h2>
      <p>${model.action}</p>
    </div>
    <div class="quiz-review-actions">
      <button class="primary" id="quizReturn" @click=${actions.returnToQuestion}>
        ${copy.review.return}
      </button>
      <button class="quiet" id="quizReviewEnd" @click=${actions.closeReview}>
        ${copy.review.close}
      </button>
    </div>`;
}

function navButtonClass(answer) {
  if (!answer?.checked) return '';
  return answer.correct ? 'is-correct' : 'needs-review';
}

function progressNav(model, copy, actions) {
  const total = model.questions.length;
  return html`<nav class="quiz-progress" aria-label=${copy.page.navLabel}>
    ${model.questions.map((question, i) => {
      const answer = model.answers[i];
      const label = fill(copy.page.navQuestion, {
        number: i + 1,
        concept: question.concept,
        status: statusLabel(answer, copy),
      });
      return html`<button
        data-quiz-index=${i}
        aria-current=${i === model.index ? 'step' : 'false'}
        aria-label=${label}
        class=${navButtonClass(answer)}
        @click=${() => actions.goTo(i)}
      >
        <span>${i + 1}</span><span>${question.concept}</span>${
          answer?.checked ? html`<b aria-hidden="true">${answer.correct ? '✓' : '↺'}</b>` : nothing
        }
      </button>`;
    })}
    <button
      data-quiz-index=${total}
      aria-current=${model.atSummary ? 'step' : 'false'}
      @click=${() => actions.goTo(total)}
    >
      ${copy.page.navSummary}
    </button>
  </nav>`;
}

function evidenceTable(evidence, copy) {
  if (!evidence) return nothing;
  return html`<table class="quiz-evidence">
    <caption>
      ${copy.question.evidenceCaption}
    </caption>
    <thead>
      <tr>
        ${evidence.headers.map((header) => html`<th scope="col">${header}</th>`)}
      </tr>
    </thead>
    <tbody>
      ${evidence.rows.map(
        (row) =>
          html`<tr>
            ${row.map((cell) => html`<td>${cell}</td>`)}
          </tr>`,
      )}
    </tbody>
  </table>`;
}

function choice(text, i, model, actions) {
  const selected = model.selected === i;
  return html`<label class="quiz-choice ${model.checked && selected ? 'is-selected' : ''}">
    <input
      type="radio"
      name="quizChoice"
      value=${i}
      .checked=${live(selected)}
      @change=${() => actions.pick(i)}
    />
    <span><b aria-hidden="true">${CHOICE_LETTERS[i]}</b>${text}</span>
  </label>`;
}

function answerForm(model, copy, actions) {
  const question = model.question;
  return html`<form id="quizForm" class="quiz-answer" @submit=${actions.submit}>
    <fieldset ?disabled=${model.checked}>
      <legend>${question.prompt}</legend>
      <div class="quiz-choices">
        ${question.choices.map((text, i) => choice(text, i, model, actions))}
      </div>
    </fieldset>
    ${
      model.checked
        ? nothing
        : html`<p id="quizValidation" class="quiz-validation" role="alert">${model.validation}</p>
            <div class="quiz-actions">
              <button class="primary" type="submit">${copy.question.check}</button>
              <button type="button" id="quizUnsure" class="quiet" @click=${actions.unsure}>
                ${copy.question.unsure}
              </button>
            </div>`
    }
  </form>`;
}

function feedbackTitle(answer, copy) {
  if (answer.correct)
    return answer.firstCorrect ? copy.feedback.correctFirst : copy.feedback.correctRecovered;
  return answer.choice === null ? copy.feedback.unsure : copy.feedback.wrong;
}

function feedback(model, copy, actions) {
  const answer = model.answer;
  const question = model.question;
  const body = answer.choice === null ? copy.feedback.unsureBody : question.feedback[answer.choice];
  return html`<h3>${feedbackTitle(answer, copy)}</h3>
    <p>${body}</p>
    ${
      answer.correct
        ? nothing
        : html`<div class="quiz-observe">
            <strong>${unsafeHTML(lessonIcon('observe'))}${copy.feedback.observeTitle}</strong>
            <p>${question.review.action}</p>
          </div>`
    }
    <div class="quiz-actions">
      <button id="quizRevisit" class=${answer.correct ? '' : 'primary'} @click=${actions.revisit}>
        ${fill(copy.feedback.revisit, { title: question.review.title })}
      </button>
      ${
        answer.correct
          ? nothing
          : html`<button id="quizRetry" @click=${actions.retry}>${copy.feedback.retry}</button>`
      }
      <button id="quizNext" class=${answer.correct ? 'primary' : 'quiet'} @click=${actions.next}>
        ${model.lastQuestion ? copy.feedback.toSummary : copy.feedback.next}
      </button>
    </div>`;
}

function questionCard(model, copy, actions) {
  const question = model.question;
  const eyebrow = fill(copy.question.eyebrow, {
    number: model.index + 1,
    total: model.questions.length,
    concept: question.concept,
  });
  return html`<section class="card quiz-question">
      <div class="quiz-scenario">
        <p class="eyebrow">${eyebrow}</p>
        <h2>${copy.question.title}</h2>
        <p>${question.scene}</p>
        ${evidenceTable(question.evidence, copy)}
        <small>${copy.question.evidenceNote}</small>
      </div>
      ${answerForm(model, copy, actions)}
      <div
        id="quizFeedback"
        class="quiz-feedback ${model.checked && model.answer.correct ? 'quiz-feedback-correct' : ''}"
        ?hidden=${!model.checked}
        aria-live="polite"
        tabindex="-1"
      >
        ${model.checked ? feedback(model, copy, actions) : nothing}
      </div>
    </section>
    <div class="quiz-bottom">
      <button id="quizPrevious" ?disabled=${model.index === 0} @click=${actions.previous}>
        ${copy.question.previous}
      </button>
      <span>${copy.question.pace}</span>
    </div>`;
}

function resultRow(question, answer, i, copy, actions) {
  const status = fill(copy.summary.resultStatus, {
    number: i + 1,
    status: statusLabel(answer, copy),
  });
  return html`<article>
    <div>
      <p class="quiz-result-status">${status}</p>
      <h3>${question.concept}</h3>
    </div>
    <div class="quiz-actions">
      <button data-quiz-review=${i} @click=${() => actions.revisitQuestion(i)}>
        ${copy.summary.revisit}
      </button>
      <button data-quiz-question=${i} class="quiet" @click=${() => actions.openQuestion(i)}>
        ${answer?.correct ? copy.summary.showAnswer : copy.summary.solve}
      </button>
    </div>
  </article>`;
}

function scoreBoard(summary, copy) {
  return html`<div class="quiz-score">
    <div>
      <strong>${summary.first}<small> / ${summary.total}</small></strong
      ><span>${copy.summary.firstCorrect}</span>
    </div>
    <div><strong>${summary.recovered}</strong><span>${copy.summary.recovered}</span></div>
    <div><strong>${summary.remaining.length}</strong><span>${copy.summary.remaining}</span></div>
  </div>`;
}

function resetPanel(model, copy, actions) {
  return html`<button id="quizNewAttempt" class="quiet" @click=${actions.openResetPanel}>
      ${copy.summary.newAttempt}
    </button>
    <div id="quizResetPanel" class="quiz-reset-panel" ?hidden=${!model.resetPanelOpen}>
      <p>${copy.summary.resetNotice}</p>
      <button id="quizResetConfirm" @click=${actions.confirmReset}>
        ${copy.summary.resetConfirm}
      </button>
      <button id="quizResetCancel" class="quiet" @click=${actions.closeResetPanel}>
        ${copy.summary.resetCancel}
      </button>
    </div>`;
}

function summaryCard(model, copy, actions) {
  const summary = model.summary;
  const unfinished = summary.remaining.length > 0;
  return html`<section class="card quiz-summary">
    <h2>${unfinished ? copy.summary.titleRemaining : copy.summary.titleComplete}</h2>
    ${scoreBoard(summary, copy)}
    <p>${unfinished ? copy.summary.adviceRemaining : copy.summary.adviceComplete}</p>
    <div class="quiz-result-list">
      ${model.questions.map((question, i) =>
        resultRow(question, model.answers[i], i, copy, actions),
      )}
    </div>
    <div class="quiz-actions">
      ${
        unfinished
          ? html`<button id="quizRemaining" class="primary" @click=${actions.solveRemaining}>
              ${copy.summary.solveRemaining}
            </button>`
          : nothing
      }
      <button id="quizFinish" @click=${actions.finish}>${copy.summary.finish}</button>
      ${resetPanel(model, copy, actions)}
    </div>
  </section>`;
}

function quizPage(model, copy, actions) {
  const page = copy.page;
  return html`<div class="quiz-heading">
      <button id="quizBack" class="text-button" @click=${actions.back}>${page.back}</button>
      <p class="eyebrow">${fill(page.eyebrow, { title: model.lessonTitle })}</p>
      <h1 id="quizTitle" tabindex="-1">
        ${model.atSummary ? page.summaryTitle : page.questionTitle}
      </h1>
      <p>${model.atSummary ? page.summaryIntro : page.questionIntro}</p>
    </div>
    ${progressNav(model, copy, actions)}
    <div id="quizContent">
      ${model.busyAlert ? html`<p role="alert">${model.busyAlert}</p>` : nothing}
      ${model.atSummary ? summaryCard(model, copy, actions) : questionCard(model, copy, actions)}
    </div>
    <p class="quiz-storage">${model.storageNote}</p>`;
}

// `fill` is shared with mastery-view.js and mastery-ui.js; it would belong in js/core/ if that
// directory could be changed here.
export { quizEntryCard, quizReviewCard, quizPage };
