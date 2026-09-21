import { QUIZZES } from './data.js';

const QUIZ_STORAGE_KEY = 'questix-understanding-v1';
function newQuizProgress() {
  return Object.fromEntries(Object.keys(QUIZZES).map((id) => [id, { index: 0, answers: {} }]));
}
function quizAnswer(progress, course, index) {
  return progress[course].answers[QUIZZES[course][index].id] || null;
}
function checkQuizAnswer(progress, course, index, choice) {
  const question = QUIZZES[course]?.[index];
  if (
    !question ||
    !(
      choice === null ||
      (Number.isInteger(choice) && choice >= 0 && choice < question.choices.length)
    )
  )
    throw new Error('Invalid quiz answer');
  const previous = quizAnswer(progress, course, index);
  if (previous?.checked) return previous;
  const correct = choice === question.answer;
  const answer = {
    choice,
    checked: true,
    correct,
    firstCorrect: previous?.firstCorrect ?? correct,
    attempts: (previous?.attempts || 0) + 1,
  };
  progress[course].answers[question.id] = answer;
  return answer;
}
function retryQuizAnswer(progress, course, index) {
  const answer = quizAnswer(progress, course, index);
  if (answer) {
    answer.checked = false;
    answer.choice = null;
    answer.correct = false;
  }
}
function quizSummary(progress, course) {
  const answers = QUIZZES[course].map((_, i) => quizAnswer(progress, course, i));
  return {
    total: answers.length,
    checked: answers.filter((a) => a?.checked).length,
    first: answers.filter((a) => a?.firstCorrect).length,
    recovered: answers.filter((a) => a?.checked && a.correct && !a.firstCorrect).length,
    remaining: answers.flatMap((a, i) => (!a?.checked || !a.correct ? [i] : [])),
  };
}
// Ignore malformed or old records; loading a local HTML must also work when storage is blocked.
function restoreQuizProgress(raw) {
  const clean = newQuizProgress();
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    return clean;
  }
  if (saved?.version !== 1 || !saved.courses || typeof saved.courses !== 'object') return clean;
  for (const [course, questions] of Object.entries(QUIZZES)) {
    const source = saved.courses[course];
    if (!source) continue;
    if (Number.isInteger(source.index) && source.index >= 0 && source.index <= questions.length)
      clean[course].index = source.index;
    for (const question of questions) {
      const a = source.answers?.[question.id];
      if (
        !a ||
        typeof a.checked !== 'boolean' ||
        typeof a.firstCorrect !== 'boolean' ||
        !Number.isInteger(a.attempts) ||
        a.attempts < 1 ||
        a.attempts > 100000
      )
        continue;
      if (!(
        a.choice === null ||
        (Number.isInteger(a.choice) && a.choice >= 0 && a.choice < question.choices.length)
      ))
        continue;
      clean[course].answers[question.id] = {
        choice: a.checked ? a.choice : null,
        checked: a.checked,
        firstCorrect: a.firstCorrect,
        correct: a.checked && a.choice === question.answer,
        attempts: a.attempts,
      };
    }
  }
  return clean;
}
function serializeQuizProgress(progress) {
  return JSON.stringify({ version: 1, courses: progress });
}

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
