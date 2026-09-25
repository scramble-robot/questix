import { render, nothing } from '../vendor/lit-html.js';
import { loadJson } from '../core/content.js';
import { LESSONS } from '../shell/lesson-ui.js';
import { lessonProgress } from '../shell/lesson-progress.js';
import { QUIZZES } from './data.js';
import {
  QUIZ_STORAGE_KEY,
  newQuizProgress,
  quizAnswer,
  checkQuizAnswer,
  retryQuizAnswer,
  quizSummary,
  restoreQuizProgress,
  serializeQuizProgress,
} from './core.js';
import { quizEntryCard, quizReviewCard, quizPage } from './view.js';

// Checkpoint quiz of every course: state and behaviour. view.js turns the model into markup,
// core.js keeps the answers and grades them. Sentences live in content/quiz/quiz.json.
// series.js hands in the navigation callbacks through initQuizzes and drives showCourse/show/hide.

const copy = await loadJson('content/quiz/quiz.json');

let shell = null; // { openQuiz, openExperiment, backToCourse, openMastery, masteryStatus }
let progress = newQuizProgress();
let storageAvailable = true;
let course = null; // course whose quiz page is open (or was open last)
let activeCourse = null; // course page currently shown, where the entry and review cards live
let reviewing = null; // { course, index } while the review card guides the learner in an experiment
// Transient page state; a rebuilt page starts without it, as when the page was rewritten wholesale.
let selectedChoice = null; // radio picked but not yet checked
let validation = null;
let busyAlert = null;
let resetPanelOpen = false;

const element = (id) => document.getElementById(id);
const lessonTitle = (id) => LESSONS.find((lesson) => lesson.id === id).title;
const questions = () => QUIZZES[course];
const currentIndex = () => progress[course].index;

function focusElement(id) {
  element(id)?.focus({ preventScroll: true });
}

function restoreProgress() {
  try {
    progress = restoreQuizProgress(localStorage.getItem(QUIZ_STORAGE_KEY));
  } catch {
    storageAvailable = false;
  }
}

function save() {
  try {
    localStorage.setItem(QUIZ_STORAGE_KEY, serializeQuizProgress(progress));
  } catch {
    storageAvailable = false;
  }
}

function pageModel() {
  const index = currentIndex();
  const list = questions();
  const answers = list.map((_, i) => quizAnswer(progress, course, i));
  const answer = answers[index] ?? null;
  const checked = Boolean(answer?.checked);
  return {
    lessonTitle: lessonTitle(course),
    questions: list,
    answers,
    index,
    atSummary: index === list.length,
    question: list[index],
    answer,
    checked,
    selected: checked ? answer.choice : selectedChoice,
    lastQuestion: index === list.length - 1,
    summary: quizSummary(progress, course),
    validation,
    busyAlert,
    resetPanelOpen,
    storageNote: storageAvailable ? copy.storage.available : copy.storage.unavailable,
  };
}

// The summary opens fully once the learner reaches the course's last experiment (or has opened
// them all, or asks to see it early); before that it is a short note, so the big quiz buttons are
// not the first thing a learner scrolling down an early experiment presses.
const peeked = new Set(); // courses whose summary was opened early during this visit

function entryModel() {
  const where = lessonProgress(activeCourse);
  return {
    lessonTitle: lessonTitle(activeCourse),
    summary: quizSummary(progress, activeCourse),
    masteryLabel: shell.masteryStatus(activeCourse),
    ready: !where || where.ready || peeked.has(activeCourse),
    where,
  };
}

function reviewModel() {
  const question = QUIZZES[reviewing.course][reviewing.index];
  return {
    number: reviewing.index + 1,
    total: QUIZZES[reviewing.course].length,
    concept: question.concept,
    action: question.review.action,
  };
}

function updatePage() {
  render(quizPage(pageModel(), copy, actions), element('quizPage'));
}

function rebuildPage() {
  selectedChoice = null;
  validation = null;
  busyAlert = null;
  resetPanelOpen = false;
  updatePage();
}

// The entry card and the review card sit on the course page; both show only for the course
// that is open, and the review card only while a review is in progress for that course.
function updateCourseCards() {
  const entry = element('quizEntry');
  entry.hidden = !activeCourse || !QUIZZES[activeCourse];
  render(entry.hidden ? nothing : quizEntryCard(entryModel(), copy, actions), entry);
  const review = element('quizReview');
  review.hidden = !activeCourse || reviewing?.course !== activeCourse;
  render(review.hidden ? nothing : quizReviewCard(reviewModel(), copy, actions), review);
}

function navigate(index) {
  progress[course].index = index;
  save();
  rebuildPage();
  element('quizPage').scrollIntoView({ block: 'start' });
  focusElement('quizTitle');
}

function answer(choice) {
  checkQuizAnswer(progress, course, currentIndex(), choice);
  save();
  rebuildPage();
  element('quizFeedback').scrollIntoView({ block: 'nearest' });
  focusElement('quizFeedback');
}

function retryAndNavigate(index) {
  retryQuizAnswer(progress, course, index);
  navigate(index);
}

// Opening the experiment does not reset its parameters, run it or grant a correct answer.
function revisit(index) {
  const reviewCourse = course;
  reviewing = { course: reviewCourse, index };
  const opened = shell.openExperiment(reviewCourse, questions()[index].review.topic);
  if (opened === false) {
    reviewing = null;
    shell.openQuiz(reviewCourse);
    busyAlert = copy.busyAlert;
    updatePage();
    return;
  }
  element('quizReview').scrollIntoView({ block: 'start' });
  focusElement('quizReviewTitle');
}

const actions = {
  peekSummary() {
    peeked.add(activeCourse);
    updateCourseCards();
  },
  back: () => shell.backToCourse(course),
  goTo: navigate,
  previous: () => navigate(currentIndex() - 1),
  next: () => navigate(currentIndex() + 1),
  pick(choice) {
    selectedChoice = choice;
  },
  submit(event) {
    event.preventDefault();
    if (pageModel().checked) return;
    if (selectedChoice === null) {
      validation = copy.question.validation;
      updatePage();
      return;
    }
    answer(selectedChoice);
  },
  unsure: () => answer(null),
  retry() {
    retryQuizAnswer(progress, course, currentIndex());
    save();
    rebuildPage();
    focusElement('quizTitle');
  },
  revisit: () => revisit(currentIndex()),
  revisitQuestion: revisit,
  openQuestion(index) {
    if (!quizAnswer(progress, course, index)?.correct) retryQuizAnswer(progress, course, index);
    navigate(index);
  },
  solveRemaining: () => retryAndNavigate(quizSummary(progress, course).remaining[0]),
  finish: () => shell.backToCourse(course),
  openResetPanel() {
    resetPanelOpen = true;
    updatePage();
    focusElement('quizResetCancel');
  },
  closeResetPanel() {
    resetPanelOpen = false;
    updatePage();
    focusElement('quizNewAttempt');
  },
  confirmReset() {
    progress[course] = { index: 0, answers: {} };
    if (reviewing?.course === course) reviewing = null;
    save();
    navigate(0);
  },
  // Entry card
  startQuiz() {
    const summary = quizSummary(progress, activeCourse);
    if (summary.checked === summary.total) progress[activeCourse].index = summary.total;
    shell.openQuiz(activeCourse);
  },
  startMastery: () => shell.openMastery(activeCourse),
  // Review card
  returnToQuestion() {
    const { course: reviewCourse, index } = reviewing;
    retryQuizAnswer(progress, reviewCourse, index);
    progress[reviewCourse].index = index;
    save();
    reviewing = null;
    shell.openQuiz(reviewCourse);
  },
  closeReview() {
    reviewing = null;
    updateCourseCards();
  },
};

function initQuizzes(callbacks) {
  shell = callbacks;
  restoreProgress();
  return {
    // Opens the quiz page of a course; the page is rebuilt so focus and scroll start fresh.
    show(id) {
      course = id;
      activeCourse = null;
      updateCourseCards();
      render(null, element('quizPage'));
      rebuildPage();
      focusElement('quizTitle');
    },
    // Called whenever a course page is shown: refreshes its entry and review cards.
    showCourse(id) {
      activeCourse = id;
      updateCourseCards();
    },
    hide() {
      activeCourse = null;
      reviewing = null;
      updateCourseCards();
    },
  };
}

// A course that moves to another experiment may reach (or leave) its last one.
document.addEventListener('lesson-progress', (event) => {
  if (event.detail.course === activeCourse) updateCourseCards();
});

export { initQuizzes };
