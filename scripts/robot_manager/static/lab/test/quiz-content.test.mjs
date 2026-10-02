// Run with: node --test test/*.test.mjs
//
// Content rules of the checkpoint quizzes and mastery tests (content/quizzes.json,
// content/systems-quizzes.json, content/mastery-tests.json): the correct option must not be
// recognisable by its length, every wrong answer has its own feedback, and every question tells
// the learner what to look at when they go back to the experiment.
import test from 'node:test';
import assert from 'node:assert/strict';

import { QUIZZES } from '../js/quiz/data.js';
import { MASTERY_TESTS } from '../js/quiz/mastery-data.js';

// The correct option may be at most this much longer than the average option, and at most a few
// characters longer than the longest wrong one, so "pick the longest" is no strategy.
const MAX_LENGTH_RATIO = 1.15;
const MAX_LEAD = 4; // characters

function choiceSets() {
  const sets = [];
  for (const [course, questions] of Object.entries(QUIZZES))
    for (const question of questions)
      sets.push({
        name: `${course}/${question.id}`,
        choices: question.choices,
        answer: question.answer,
      });
  for (const [course, questions] of Object.entries(MASTERY_TESTS))
    for (const question of questions)
      for (const part of ['answer', 'reason']) {
        const block = question[part];
        if (!block?.choices) continue;
        sets.push({
          name: `${course}/${question.id}/${part}`,
          choices: block.choices,
          answer: block.value,
        });
      }
  return sets;
}

test('the correct option is not given away by its length', () => {
  const sets = choiceSets();
  assert.ok(sets.length > 100);
  let longest = 0;
  for (const { name, choices, answer } of sets) {
    const lengths = choices.map((choice) => choice.length);
    const mean = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
    const others = lengths.filter((_, index) => index !== answer);
    assert.ok(lengths[answer] <= mean * MAX_LENGTH_RATIO, `${name}: ${lengths}`);
    assert.ok(lengths[answer] <= Math.max(...others) + MAX_LEAD, `${name}: ${lengths}`);
    if (lengths[answer] > Math.max(...others)) longest++;
  }
  // Being the longest is allowed now and then, but must not be the rule.
  assert.ok(longest < sets.length / 3, `${longest} of ${sets.length} answers are the longest`);
});

test('every option of a checkpoint question has its own feedback', () => {
  for (const [course, questions] of Object.entries(QUIZZES))
    for (const question of questions) {
      assert.equal(question.feedback.length, question.choices.length, `${course}/${question.id}`);
      assert.ok(question.answer >= 0 && question.answer < question.choices.length);
    }
});

test('behavior and diagnostics questions say what to watch when revisiting the experiment', () => {
  for (const course of ['behavior', 'diagnostics']) {
    const firstSteps = new Set();
    for (const question of QUIZZES[course]) {
      assert.ok(question.review.action, `${course}/${question.id}`);
      firstSteps.add(question.review.action);
    }
    // One instruction per question, not the topic's first step repeated.
    assert.equal(firstSteps.size, QUIZZES[course].length);
  }
});

test('the reward-loophole rationale does not state the number it asks for', () => {
  const question = MASTERY_TESTS.rl.find((entry) => entry.id === 'reward-loophole');
  const answer = String(question.answer.value);
  for (const choice of question.reason.choices) assert.ok(!choice.includes(answer), choice);
  assert.ok(!question.scene.includes('割引'));
});

test('the rl reward-design mastery question sends the learner to the course page settings', () => {
  const question = MASTERY_TESTS.rl.find((entry) => entry.id === 'improve-success');
  assert.equal(question.review.topic, 'delivery');
  assert.ok(question.review.action.includes('障害物に近づきすぎる'));
  assert.ok(!JSON.stringify(question.evidence).includes('最小間隔'));
});
