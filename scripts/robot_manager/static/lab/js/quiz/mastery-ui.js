import { render, nothing } from '../vendor/lit-html.js';
import { loadJson } from '../core/content.js';
import { downloadFile } from '../core/dom.js';
import { LESSONS } from '../shell/lesson-ui.js';
import { MASTERY_TESTS } from './mastery-data.js';
import {
  MASTERY_STORAGE_KEY,
  UNKNOWN,
  CRITERIA_COUNT,
  newMasteryProgress,
  beginMastery,
  masteryAnswer,
  masteryMissing,
  gradeMastery,
  submitMastery,
  serializeMastery,
  restoreMastery,
} from './mastery-core.js';
import { valueLabel, masteryReviewCard, masteryPage } from './mastery-view.js';
import { fillSentence as fill } from '../core/content.js';

// Mastery test of every course: state and behaviour. mastery-view.js turns the model into markup,
// mastery-core.js keeps the draft, grades submissions and restores saved attempts. Sentences live
// in content/quiz/mastery.json. series.js hands in the navigation callbacks through initMastery
// and drives showCourse/show/hide.

const copy = await loadJson('content/quiz/mastery.json');

let shell = null; // { openTest, openExperiment, backToCourse }
let progress = newMasteryProgress();
let storageAvailable = true;
let course = null; // course whose test page is open (or was open last)
let activeCourse = null; // course page currently shown, where the review card lives
let resultIndex = null; // question whose feedback is shown after a submission; null = summary
let reviewing = null; // { course, index } while the review card guides the learner in an experiment
// Transient page state; a rebuilt page starts without it, as when the page was rewritten wholesale.
let validation = null;
let busyAlert = null;
let numberBox = ''; // text in the number field; kept while "まだ求められない" is ticked
let noteBox = ''; // the written answer as the page was built; the textarea's default value
let answeredMarks = []; // ticks of the question nav, refreshed when the page is rebuilt

const element = (id) => document.getElementById(id);
const lessonTitle = (id) => LESSONS.find((lesson) => lesson.id === id).title;
const questions = () => MASTERY_TESTS[course];
const record = () => progress[course];
const draftIndex = () => record().draft.index;
const currentQuestion = () => questions()[draftIndex()];
const countChecks = (attempt) => attempt.checks.filter(Boolean).length;

function focusTitle() {
  element('masteryTitle')?.focus({ preventScroll: true });
  element('masteryPage').scrollIntoView({ block: 'start' });
}

function restoreProgress() {
  try {
    progress = restoreMastery(localStorage.getItem(MASTERY_STORAGE_KEY));
  } catch {
    storageAvailable = false;
  }
}

function save() {
  try {
    localStorage.setItem(MASTERY_STORAGE_KEY, serializeMastery(progress));
  } catch {
    storageAvailable = false;
  }
}

function status(id) {
  const saved = progress[id];
  if (saved?.draft) return copy.status.resume;
  return saved?.last ? copy.status.results : copy.status.start;
}

function pageView() {
  if (record().draft) return 'question';
  return resultIndex === null ? 'summary' : 'feedback';
}

function questionModel() {
  const index = draftIndex();
  return {
    view: 'question',
    index,
    question: currentQuestion(),
    answer: masteryAnswer(progress, course, index),
    lastQuestion: index === questions().length - 1,
    numberBox,
    noteBox,
    answeredMarks,
    validation,
  };
}

function summaryModel() {
  const saved = record();
  const list = questions();
  const writtenIndex = list.findIndex((question) => question.writing);
  return {
    view: 'summary',
    attempts: saved.attempts,
    grade: gradeMastery(course, saved.last.answers),
    firstGrade: gradeMastery(course, saved.first.answers),
    writtenIndex,
    writtenAnswer: saved.last.answers[list[writtenIndex].id],
    checkedCount: countChecks(saved.last),
  };
}

function feedbackModel() {
  const saved = record();
  const question = questions()[resultIndex];
  return {
    view: 'feedback',
    index: resultIndex,
    question,
    answer: saved.last.answers[question.id],
    result: gradeMastery(course, saved.last.answers).results[resultIndex],
    checks: saved.last.checks,
  };
}

function pageModel() {
  const views = { question: questionModel, summary: summaryModel, feedback: feedbackModel };
  return {
    ...views[pageView()](),
    lessonTitle: lessonTitle(course),
    questions: questions(),
    busyAlert,
    storageNote: storageAvailable ? copy.storage.available : copy.storage.unavailable,
  };
}

function reviewModel() {
  const question = MASTERY_TESTS[reviewing.course][reviewing.index];
  return {
    number: reviewing.index + 1,
    title: question.title,
    action: question.review.action,
  };
}

function updatePage() {
  render(masteryPage(pageModel(), copy, actions), element('masteryPage'));
}

// Ticks in the question nav and the form fields' initial text follow the saved draft at the time a
// question is opened or submitted, not every keystroke, as the page was only rewritten at those
// moments.
function rebuildPage() {
  validation = null;
  busyAlert = null;
  const draft = record().draft;
  if (draft) {
    answeredMarks = questions().map(
      (question) => masteryMissing(question, draft.answers[question.id]).length === 0,
    );
    const answer = masteryAnswer(progress, course, draft.index);
    numberBox = answer.value === UNKNOWN ? '' : answer.value;
    noteBox = answer.note;
  }
  updatePage();
}

function updateReviewCard() {
  const review = element('masteryReview');
  review.hidden = !activeCourse || reviewing?.course !== activeCourse;
  render(review.hidden ? nothing : masteryReviewCard(reviewModel(), copy, actions), review);
}

function navigate(index) {
  record().draft.index = index;
  save();
  rebuildPage();
  focusTitle();
}

function showPage() {
  save();
  rebuildPage();
  focusTitle();
}

function changeDraftAnswer(changes) {
  const draft = record().draft;
  const question = currentQuestion();
  draft.answers[question.id] = { ...masteryAnswer(progress, course, draft.index), ...changes };
  save();
  updatePage();
}

function submit() {
  const draft = record().draft;
  const index = draft.index;
  const missing = masteryMissing(currentQuestion(), draft.answers[currentQuestion().id]);
  if (missing.length) {
    validation = missing.join('・') + copy.question.missingSuffix;
    updatePage();
    return;
  }
  if (index < questions().length - 1) {
    navigate(index + 1);
    return;
  }
  const pending = questions().findIndex(
    (question) => masteryMissing(question, draft.answers[question.id]).length,
  );
  if (pending >= 0) {
    navigate(pending);
    validation = copy.question.pendingBeforeSubmit;
    updatePage();
    return;
  }
  submitMastery(progress, course);
  resultIndex = null;
  showPage();
}

// Opening the experiment does not reset its parameters, run it or grant a correct answer.
function revisit(index) {
  const reviewCourse = course;
  reviewing = { course: reviewCourse, index };
  const opened = shell.openExperiment(reviewCourse, questions()[index].review.topic);
  if (opened === false) {
    reviewing = null;
    shell.openTest(reviewCourse);
    busyAlert = copy.busyAlert;
    updatePage();
    return;
  }
  element('masteryReview').scrollIntoView({ block: 'start' });
  element('masteryReviewTitle').focus({ preventScroll: true });
}

// Plain-text record of the first attempt and, after a retry, the latest one.
function attemptReport(name, attempt) {
  const grade = gradeMastery(course, attempt.answers);
  const lines = [
    name,
    copy.export.submittedAt + attempt.at,
    copy.export.complete + grade.complete + '/' + grade.total,
  ];
  questions().forEach((question, i) => {
    const answer = attempt.answers[question.id];
    lines.push('', fill(copy.export.question, { number: i + 1, title: question.title }));
    lines.push(copy.export.answer + valueLabel(question.answer, answer.value, copy));
    lines.push(copy.export.reason + valueLabel(question.reason, answer.reason, copy));
    if (!question.writing) return;
    const note = answer.noteUnknown ? copy.export.noteUnknown : answer.note;
    lines.push(copy.export.note + note);
  });
  return lines.join('\n');
}

function exportReport() {
  const saved = record();
  const lines = [
    copy.export.heading,
    lessonTitle(course),
    '',
    attemptReport(copy.export.first, saved.first),
  ];
  if (saved.attempts > 1) {
    const name = fill(copy.export.latest, { attempts: saved.attempts });
    lines.push('', attemptReport(name, saved.last));
  }
  const checks = fill(copy.export.checksLine, {
    checks: countChecks(saved.last),
    total: CRITERIA_COUNT,
  });
  lines.push('', checks, '');
  downloadFile(fill(copy.export.fileName, { course }), lines.join('\n'));
}

const actions = {
  back: () => shell.backToCourse(course),
  goTo: navigate,
  previous: () => navigate(draftIndex() - 1),
  submit(event) {
    event.preventDefault();
    submit();
  },
  chooseValue: (value) => changeDraftAnswer({ value }),
  chooseReason: (reason) => changeDraftAnswer({ reason }),
  typeNumber(text) {
    numberBox = text;
    changeDraftAnswer({ value: text });
  },
  // Unticking restores what was typed before, which stayed visible in the disabled field.
  setNumberUnknown: (unknown) => changeDraftAnswer({ value: unknown ? UNKNOWN : numberBox }),
  typeNote: (note) => changeDraftAnswer({ note }),
  setNoteUnknown: (noteUnknown) => changeDraftAnswer({ noteUnknown }),
  showResult(index) {
    resultIndex = index;
    rebuildPage();
    focusTitle();
  },
  showResults() {
    resultIndex = null;
    rebuildPage();
    focusTitle();
  },
  setCheck(index, checked) {
    record().last.checks[index] = checked;
    save();
    updatePage();
  },
  revisit,
  retry() {
    beginMastery(progress, course);
    resultIndex = null;
    showPage();
  },
  exportResult: exportReport,
  finish: () => shell.backToCourse(course),
  // Review card
  returnToTest() {
    course = reviewing.course;
    resultIndex = reviewing.index;
    reviewing = null;
    shell.openTest(course);
  },
  closeReview() {
    reviewing = null;
    updateReviewCard();
  },
};

function initMastery(callbacks) {
  shell = callbacks;
  restoreProgress();
  return {
    status,
    // Opens the test page of a course; the page is rebuilt so focus and scroll start fresh.
    show(id) {
      if (course !== id) resultIndex = null;
      course = id;
      activeCourse = null;
      updateReviewCard();
      if (!record().draft && !record().last) beginMastery(progress, id);
      render(null, element('masteryPage'));
      rebuildPage();
      focusTitle();
    },
    // Called whenever a course page is shown: refreshes its review card.
    showCourse(id) {
      activeCourse = id;
      updateReviewCard();
    },
    hide() {
      activeCourse = null;
      reviewing = null;
      updateReviewCard();
    },
  };
}

export { initMastery };
