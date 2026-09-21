import { loadJson } from '../core/content.js';
import { SYSTEM_TOPICS } from './data.js';

// Questions are authored in content/systems-quizzes.json. Each names the topic to revisit; the
// review title and first action come from that topic, so they cannot drift apart.
const authored = await loadJson('content/systems-quizzes.json');

function withReview(course, { topic, ...question }) {
  const source = SYSTEM_TOPICS[course].find((t) => t.id === topic);
  return {
    ...question,
    review: { topic, title: source.label, action: source.first },
    evidence: null,
  };
}
const SYSTEM_QUIZZES = Object.fromEntries(
  Object.entries(authored).map(([course, questions]) => [
    course,
    questions.map((question) => withReview(course, question)),
  ]),
);

export { SYSTEM_QUIZZES };
