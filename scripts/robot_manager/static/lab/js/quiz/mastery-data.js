import { loadJson } from '../core/content.js';
import { QUIZZES } from './data.js';

// New scenarios, independent of the learner's simulation records. Numerical
// assumptions belong to each question; they are not real-hardware settings.
// Each case names the quiz question (`review`) whose experiment the learner should revisit and
// inherits that question's review card, so the two cannot drift apart.
const cases = await loadJson('content/mastery-tests.json');
// A mastery question may send the learner back to the same experiment for a different purpose;
// those questions replace the inherited instruction with their own (a sentence), or send the
// learner to another experiment of the course ({topic, title, action}).
const reviewActions = await loadJson('content/quiz/mastery-review-actions.json');

function reviewFor(course, question) {
  const inherited = QUIZZES[course].find((quiz) => quiz.id === question.review)?.review;
  const override = reviewActions[course]?.[question.id];
  if (!override) return inherited;
  if (typeof override === 'string') return { ...inherited, action: override };
  return { ...inherited, ...override };
}

const MASTERY_TESTS = Object.fromEntries(
  Object.entries(cases).map(([course, questions]) => [
    course,
    questions.map((question) => ({ ...question, review: reviewFor(course, question) })),
  ]),
);

export { MASTERY_TESTS };
