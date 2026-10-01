import { html, nothing, live } from '../vendor/lit-html.js';
import { UNKNOWN } from './mastery-core.js';
import { fillSentence as fill } from '../core/content.js';

// Templates of the mastery test: the review card on a course page and the test page in its three
// states (answering a draft, the results summary, one question's feedback). Every function is
// pure and turns the model built by mastery-ui.js into markup. Sentences come from
// content/quiz/mastery.json (`copy`).

// What the learner chose, in words: a number with its unit, or the chosen option.
function valueLabel(part, value, copy) {
  if (value === UNKNOWN) return copy.unknownChoice;
  if (part.type === 'number') return value + ' ' + part.unit;
  return part.choices[Number(value)] ?? copy.unanswered;
}

function correctLabel(part) {
  if (part.type === 'number') return part.value + ' ' + part.unit;
  return part.choices[part.value];
}

function masteryReviewCard(model, copy, actions) {
  return html`<div class="quiz-review-copy">
      <p class="eyebrow">${fill(copy.review.eyebrow, model)}</p>
      <h2 id="masteryReviewTitle" tabindex="-1">${model.title}</h2>
      <p>${model.action}</p>
    </div>
    <div class="quiz-review-actions">
      <button class="primary" id="masteryReturn" @click=${actions.returnToTest}>
        ${copy.review.return}
      </button>
      <button class="quiet" id="masteryReviewEnd" @click=${actions.closeReview}>
        ${copy.review.close}
      </button>
    </div>`;
}

function evidenceTable(evidence, copy) {
  if (!evidence) return nothing;
  return html`<div class="mastery-table-wrap">
    <table class="quiz-evidence">
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
    </table>
  </div>`;
}

// Radio options of a choice part, plus the "まだ分からない" option stored as '?'.
function choiceOptions(part, name, chosen, copy, onChoose) {
  const values = [...part.choices.map((_, i) => String(i)), UNKNOWN];
  const labels = [...part.choices, copy.unknownChoice];
  return html`<div class="quiz-choices">
    ${values.map(
      (value, i) =>
        html`<label class="quiz-choice">
          <input
            type="radio"
            name=${name}
            value=${value}
            .checked=${live(chosen === value)}
            @change=${() => onChoose(value)}
          />
          <span>${labels[i]}</span>
        </label>`,
    )}
  </div>`;
}

function numberAnswer(model, copy, actions) {
  const unknown = model.answer.value === UNKNOWN;
  return html`<label class="mastery-number"
      >${copy.question.numberLabel}<input
        type="text"
        inputmode="decimal"
        name="masteryValue"
        maxlength="30"
        .value=${live(model.numberBox)}
        ?disabled=${unknown}
        autocomplete="off"
        @input=${(event) => actions.typeNumber(event.target.value)}
      /><span>${model.question.answer.unit}</span></label
    ><label class="mastery-check"
      ><input
        type="checkbox"
        id="masteryUnknown"
        .checked=${live(unknown)}
        @change=${(event) => actions.setNumberUnknown(event.target.checked)}
      />${copy.question.numberUnknown}</label
    >`;
}

function answerPart(model, copy, actions) {
  const part = model.question.answer;
  return html`<fieldset>
    <legend><span class="mastery-part">${copy.question.answerPart}</span>${part.prompt}</legend>
    ${
      part.type === 'choice'
        ? choiceOptions(part, 'masteryValue', model.answer.value, copy, actions.chooseValue)
        : numberAnswer(model, copy, actions)
    }
  </fieldset>`;
}

function reasonPart(model, copy, actions) {
  const part = model.question.reason;
  return html`<fieldset>
    <legend><span class="mastery-part">${copy.question.reasonPart}</span>${part.prompt}</legend>
    ${choiceOptions(part, 'masteryReason', model.answer.reason, copy, actions.chooseReason)}
  </fieldset>`;
}

// lit cannot bind inside a <textarea> (its content is parsed as RCDATA, so a marker comment would
// show up as text), so the written answer is bound through two properties: `defaultValue` is the
// element's content, which follows the draft as the page was built, and `value` is what the
// learner sees and edits.
function writingPart(model, copy, actions) {
  const writing = model.question.writing;
  if (!writing) return nothing;
  const answer = model.answer;
  return html`<fieldset>
    <legend><span class="mastery-part">${copy.question.writingPart}</span>${writing.prompt}</legend>
    <label for="masteryNote" class="helper">${copy.question.noteHelp}</label>
    <textarea
      id="masteryNote"
      rows="5"
      maxlength="1500"
      .defaultValue=${model.noteBox}
      .value=${live(answer.note)}
      ?disabled=${answer.noteUnknown}
      @input=${(event) => actions.typeNote(event.target.value)}
    ></textarea>
    <label class="mastery-check"
      ><input
        id="masteryNoteUnknown"
        type="checkbox"
        .checked=${live(answer.noteUnknown)}
        @change=${(event) => actions.setNoteUnknown(event.target.checked)}
      />${copy.question.noteUnknown}</label
    >
    <p class="helper">${copy.question.noteNotGraded}</p>
  </fieldset>`;
}

function questionNav(model, copy, actions) {
  return html`<nav class="quiz-progress" aria-label=${copy.question.navLabel}>
    ${model.questions.map(
      (question, i) =>
        html`<button
          data-mastery-index=${i}
          aria-current=${i === model.index ? 'step' : 'false'}
          @click=${() => actions.goTo(i)}
        >
          <span>${fill(copy.question.navQuestion, { number: i + 1 })}</span
          ><span>${question.title}</span><b>${model.answeredMarks[i] ? '✓' : ''}</b>
        </button>`,
    )}
  </nav>`;
}

function questionPage(model, copy, actions) {
  const question = model.question;
  const eyebrow = fill(copy.question.eyebrow, {
    number: model.index + 1,
    total: model.questions.length,
  });
  return html`${questionNav(model, copy, actions)}
    <section class="card mastery-question">
      <div class="quiz-scenario">
        <p class="eyebrow">${eyebrow}</p>
        <h2>${question.title}</h2>
        <p>${question.scene}</p>
        ${evidenceTable(question.evidence, copy)}
        <small>${copy.question.evidenceNote}</small>
      </div>
      <form id="masteryForm" class="quiz-answer" @submit=${actions.submit}>
        ${answerPart(model, copy, actions)} ${reasonPart(model, copy, actions)}
        ${writingPart(model, copy, actions)}
        <p id="masteryValidation" class="quiz-validation" role="alert">${model.validation}</p>
        <div class="quiz-actions">
          <button
            class="quiet"
            type="button"
            id="masteryPrevious"
            ?disabled=${model.index === 0}
            @click=${actions.previous}
          >
            ${copy.question.previous}
          </button>
          <button type="submit" class="primary">
            ${model.lastQuestion ? copy.question.submit : copy.question.saveAndNext}
          </button>
        </div>
      </form>
    </section>`;
}

function verdictLabel(result, copy) {
  if (result.complete) return copy.summary.verdictComplete;
  if (result.judgment) return copy.summary.verdictJudgment;
  if (result.reasoning) return copy.summary.verdictReasoning;
  return copy.summary.verdictNeither;
}

function resultRow(question, result, i, copy, actions) {
  const status = fill(copy.summary.resultStatus, {
    number: i + 1,
    verdict: verdictLabel(result, copy),
  });
  return html`<article>
    <div>
      <p class="quiz-result-status">${status}</p>
      <h3>${question.title}</h3>
    </div>
    <div class="quiz-actions">
      <button data-mastery-result=${i} @click=${() => actions.showResult(i)}>
        ${copy.summary.showResult}
      </button>
      <button data-mastery-review=${i} class="quiet" @click=${() => actions.revisit(i)}>
        ${copy.summary.revisit}
      </button>
    </div>
  </article>`;
}

function scoreBoard(model, copy) {
  const grade = model.grade;
  const first = model.firstGrade;
  return html`<div class="quiz-score">
    <div>
      <strong>${grade.judgment}<small> / ${grade.total}</small></strong
      ><span>${copy.summary.judgment}</span>
    </div>
    <div>
      <strong>${grade.reasoning}<small> / ${grade.total}</small></strong
      ><span>${copy.summary.reasoning}</span>
    </div>
    <div>
      <strong>${first.complete}<small> / ${first.total}</small></strong
      ><span>${copy.summary.firstComplete}</span>
    </div>
  </div>`;
}

function noteState(note, copy) {
  if (note.noteUnknown) return copy.summary.noteUnknown;
  return note.note.trim() ? copy.summary.noteWritten : copy.summary.noteEmpty;
}

function writingStatus(model, copy, actions) {
  const checks = fill(copy.summary.checksStatus, { checks: model.checkedCount });
  return html`<div class="mastery-writing-status">
    <h3>${copy.summary.writingTitle}</h3>
    <p>${noteState(model.writtenAnswer, copy)} ${checks}</p>
    <button
      data-mastery-result=${model.writtenIndex}
      @click=${() => actions.showResult(model.writtenIndex)}
    >
      ${copy.summary.compareNote}
    </button>
  </div>`;
}

function summaryPage(model, copy, actions) {
  const grade = model.grade;
  const attempt =
    model.attempts === 1
      ? copy.summary.firstAttempt
      : fill(copy.summary.retryAttempt, { attempts: model.attempts });
  return html`<section class="card quiz-summary">
    <p class="eyebrow">${attempt}</p>
    <h2>${fill(copy.summary.title, grade)}</h2>
    ${scoreBoard(model, copy)}
    <p>${copy.summary.advice}</p>
    <div class="quiz-result-list">
      ${model.questions.map((question, i) =>
        resultRow(question, grade.results[i], i, copy, actions),
      )}
    </div>
    ${writingStatus(model, copy, actions)}
    <div class="quiz-actions">
      <button class="primary" id="masteryRetry" @click=${actions.retry}>
        ${copy.summary.retry}
      </button>
      <button id="masteryExport" @click=${actions.exportResult}>${copy.summary.export}</button>
      <button class="quiet" id="masteryFinish" @click=${actions.finish}>
        ${copy.summary.finish}
      </button>
    </div>
  </section>`;
}

function answerReview(model, copy) {
  const question = model.question;
  const answer = model.answer;
  const result = model.result;
  const verdict = (correct) =>
    correct ? copy.feedback.verdictCorrect : copy.feedback.verdictCheck;
  return html`<dl class="mastery-answer-review">
    <div>
      <dt>${fill(copy.feedback.yourAnswer, { verdict: verdict(result.judgment) })}</dt>
      <dd>${valueLabel(question.answer, answer.value, copy)}</dd>
    </div>
    <div>
      <dt>${copy.feedback.correctAnswer}</dt>
      <dd>${correctLabel(question.answer)}</dd>
    </div>
    <div>
      <dt>${fill(copy.feedback.yourReason, { verdict: verdict(result.reasoning) })}</dt>
      <dd>${valueLabel(question.reason, answer.reason, copy)}</dd>
    </div>
    <div>
      <dt>${copy.feedback.correctReason}</dt>
      <dd>${correctLabel(question.reason)}</dd>
    </div>
  </dl>`;
}

function writtenReview(model, copy, actions) {
  const writing = model.question.writing;
  if (!writing) return nothing;
  const answer = model.answer;
  const submitted = answer.noteUnknown ? copy.feedback.noteUnknown : answer.note;
  const checksLocked = answer.noteUnknown || !answer.note.trim();
  return html`<section class="mastery-written">
    <h3>${copy.feedback.writingTitle}</h3>
    <p>${writing.prompt}</p>
    <h4>${copy.feedback.submittedNote}</h4>
    <p class="mastery-own-note">${submitted}</p>
    <h4>${copy.feedback.modelNote}</h4>
    <p>${writing.model}</p>
    <p class="helper">${copy.feedback.criteriaHelp}</p>
    ${writing.criteria.map(
      (criterion, i) =>
        html`<label class="mastery-check"
          ><input
            type="checkbox"
            data-mastery-check=${i}
            .checked=${live(model.checks[i])}
            ?disabled=${checksLocked}
            @change=${(event) => actions.setCheck(i, event.target.checked)}
          />${criterion}</label
        >`,
    )}
  </section>`;
}

function feedbackPage(model, copy, actions) {
  const question = model.question;
  const eyebrow = fill(copy.feedback.eyebrow, { number: model.index + 1, title: question.title });
  return html`<section class="card mastery-feedback">
    <p class="eyebrow">${eyebrow}</p>
    <h2>${model.result.complete ? copy.feedback.titleComplete : copy.feedback.titleIncomplete}</h2>
    <p>${question.scene}</p>
    ${evidenceTable(question.evidence, copy)} ${answerReview(model, copy)}
    <div class="mastery-explanation">
      <h3>${copy.feedback.explanationTitle}</h3>
      <p>${question.explanation}</p>
    </div>
    ${writtenReview(model, copy, actions)}
    <div class="quiz-observe">
      <strong>${copy.feedback.observeTitle}</strong>
      <p>${question.review.action}</p>
    </div>
    <div class="quiz-actions">
      <button class="primary" id="masteryRevisit" @click=${() => actions.revisit(model.index)}>
        ${fill(copy.feedback.revisit, { title: question.review.title })}
      </button>
      <button id="masteryResults" @click=${actions.showResults}>${copy.feedback.results}</button>
    </div>
  </section>`;
}

function pageTitle(model, copy) {
  if (model.view === 'question') return copy.page.draftTitle;
  return model.view === 'summary' ? copy.page.summaryTitle : copy.page.feedbackTitle;
}

function pageContent(model, copy, actions) {
  if (model.view === 'question') return questionPage(model, copy, actions);
  if (model.view === 'summary') return summaryPage(model, copy, actions);
  return feedbackPage(model, copy, actions);
}

function masteryPage(model, copy, actions) {
  const answering = model.view === 'question';
  return html`<div class="quiz-heading">
      <button id="masteryBack" class="text-button" @click=${actions.back}>${copy.page.back}</button>
      <p class="eyebrow">${fill(copy.page.eyebrow, { title: model.lessonTitle })}</p>
      <h1 id="masteryTitle" tabindex="-1">${pageTitle(model, copy)}</h1>
      <p>${answering ? copy.page.draftIntro : copy.page.resultIntro}</p>
    </div>
    <div id="masteryContent">
      ${model.busyAlert ? html`<p role="alert">${model.busyAlert}</p>` : nothing}
      ${pageContent(model, copy, actions)}
    </div>
    <p class="quiz-storage" id="masteryStorage">${model.storageNote}</p>`;
}

export { valueLabel, masteryReviewCard, masteryPage };
