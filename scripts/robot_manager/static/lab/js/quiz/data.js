import { loadJson } from '../core/content.js';
import { SYSTEM_QUIZZES } from '../systems/quiz.js';

// Scenario-based checks. All examples are hypothetical, not the learner's run data.
// Each choice includes its own causal feedback and a concrete experiment to revisit.
const QUIZZES = { ...SYSTEM_QUIZZES, ...(await loadJson('content/quizzes.json')) };

export { QUIZZES };
