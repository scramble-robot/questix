import { QUIZZES } from './data.js';
import { savedCourses, forStorage } from './storage.js';

// Checkpoint quiz: the learner's answers and how they are counted. No DOM — ui.js owns the page.
// Answers are filed under the question's id rather than its position, so a saved attempt survives
// a question being added or reordered in content/quizzes.json.

const QUIZ_STORAGE_KEY = 'questix-understanding-v1';
const MAX_SAVED_ATTEMPTS = 100000; // a larger attempt count in storage is treated as corrupt

function newQuizProgress() {
  const courses = Object.keys(QUIZZES).map((course) => [course, { index: 0, answers: {} }]);
  return Object.fromEntries(courses);
}

function quizAnswer(progress, course, index) {
  return progress[course].answers[QUIZZES[course][index].id] || null;
}

const isChoiceOf = (choice, question) =>
  Number.isInteger(choice) && choice >= 0 && choice < question.choices.length;

// Files an answer and returns it. `choice` is the index the learner picked, or null for
// "まだ分からない", which counts as answered but never as correct.
function checkQuizAnswer(progress, course, index, choice) {
  const question = QUIZZES[course]?.[index];
  if (!question || !(choice === null || isChoiceOf(choice, question)))
    throw new Error('Invalid quiz answer');
  const previous = quizAnswer(progress, course, index);
  if (previous?.checked) return previous; // checking an answered question again changes nothing
  const correct = choice === question.answer;
  const answer = {
    choice,
    checked: true,
    correct,
    // How the learner did the very first time, kept for good: the summary tells a first-time
    // answer from one that took a retry.
    firstCorrect: previous?.firstCorrect ?? correct,
    attempts: (previous?.attempts || 0) + 1,
  };
  progress[course].answers[question.id] = answer;
  return answer;
}

// Reopens a question for another try, leaving the record of the first attempt in place.
function retryQuizAnswer(progress, course, index) {
  const answer = quizAnswer(progress, course, index);
  if (!answer) return;
  answer.checked = false;
  answer.choice = null;
  answer.correct = false;
}

const isRecovered = (answer) => Boolean(answer?.checked && answer.correct && !answer.firstCorrect);
const isUnfinished = (answer) => !answer?.checked || !answer.correct;

function quizSummary(progress, course) {
  const answers = QUIZZES[course].map((_, index) => quizAnswer(progress, course, index));
  return {
    total: answers.length,
    checked: answers.filter((answer) => answer?.checked).length,
    first: answers.filter((answer) => answer?.firstCorrect).length,
    recovered: answers.filter(isRecovered).length,
    remaining: answers.flatMap((answer, index) => (isUnfinished(answer) ? [index] : [])),
  };
}

// One saved answer, rebuilt field by field, or null when it does not fit the question any more.
function restoredAnswer(question, saved) {
  if (!saved) return null;
  if (typeof saved.checked !== 'boolean' || typeof saved.firstCorrect !== 'boolean') return null;
  if (!Number.isInteger(saved.attempts)) return null;
  if (saved.attempts < 1 || saved.attempts > MAX_SAVED_ATTEMPTS) return null;
  if (!(saved.choice === null || isChoiceOf(saved.choice, question))) return null;
  return {
    choice: saved.checked ? saved.choice : null,
    checked: saved.checked,
    firstCorrect: saved.firstCorrect,
    // Worked out again rather than read back, so an edited record cannot turn a wrong choice
    // into a correct one.
    correct: saved.checked && saved.choice === question.answer,
    attempts: saved.attempts,
  };
}

// Ignore malformed or old records; loading a local HTML must also work when storage is blocked.
function restoreQuizProgress(raw) {
  const clean = newQuizProgress();
  const courses = savedCourses(raw);
  if (!courses) return clean;
  for (const [course, questions] of Object.entries(QUIZZES)) {
    const saved = courses[course];
    if (!saved) continue;
    // The index may be questions.length as well: the summary sits one past the last question.
    const index = saved.index;
    if (Number.isInteger(index) && index >= 0 && index <= questions.length)
      clean[course].index = index;
    for (const question of questions) {
      const answer = restoredAnswer(question, saved.answers?.[question.id]);
      if (answer) clean[course].answers[question.id] = answer;
    }
  }
  return clean;
}

const serializeQuizProgress = (progress) => forStorage(progress);

export {
  QUIZ_STORAGE_KEY,
  newQuizProgress,
  quizAnswer,
  checkQuizAnswer,
  retryQuizAnswer,
  quizSummary,
  restoreQuizProgress,
  serializeQuizProgress,
};
