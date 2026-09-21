import { loadJson } from '../core/content.js';
import { QUIZZES } from './data.js';

// New scenarios, independent of the learner's simulation records. Numerical
// assumptions belong to each question; they are not real-hardware settings.
// Each case names the quiz question (`review`) whose experiment the learner should revisit.
const cases = await loadJson('content/mastery-tests.json');

const MASTERY_TESTS = Object.fromEntries(
  Object.entries(cases).map(([course, questions]) => [
    course,
    questions.map((q) => {
      const review = QUIZZES[course].find((v) => v.id === q.review)?.review;
      return {
        ...q,
        review:
          course === 'rl' && q.id === 'improve-success'
            ? {
                ...review,
                action:
                  '「学習とテスト」で、到着回数と到着までの時間を比べてください。障害物との間隔や報酬の値は、その後の総合実験で条件を変えて確かめます。',
              }
            : review,
      };
    }),
  ]),
);

export { MASTERY_TESTS };
