// Run with: node --test test/*.test.mjs
//
// Pins the public functions of js/quiz/core.js (checkpoint quiz) and js/quiz/mastery-core.js
// (mastery test): what they store, how they grade and what they accept back from localStorage.
// Set LAB_BASELINE=<a copy of the site from before the rewrite> to additionally replay the same
// scenario through that copy's modules and diff every result, which is how the rewrite was checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as quiz from '../js/quiz/core.js';
import * as mastery from '../js/quiz/mastery-core.js';
import { QUIZZES } from '../js/quiz/data.js';
import { MASTERY_TESTS } from '../js/quiz/mastery-data.js';

const COURSE = 'control'; // 6 checkpoint questions, 3 mastery questions (number, choice, choice+writing)
const SUBMITTED_AT = '2026-01-02T03:04:05.000Z'; // submitMastery defaults to now, so tests pass a fixed stamp
const questionId = (index) => QUIZZES[COURSE][index].id;
const correctChoice = (index) => QUIZZES[COURSE][index].answer;
const wrongChoice = (index) => (correctChoice(index) + 1) % QUIZZES[COURSE][index].choices.length;

test('a checkpoint answer records the first attempt, and a retry cannot rewrite it', () => {
  const progress = quiz.newQuizProgress();
  assert.deepEqual(Object.keys(progress).sort(), Object.keys(QUIZZES).sort());
  assert.deepEqual(progress[COURSE], { index: 0, answers: {} });
  assert.equal(quiz.quizAnswer(progress, COURSE, 0), null);

  const missed = quiz.checkQuizAnswer(progress, COURSE, 0, wrongChoice(0));
  assert.deepEqual(missed, {
    choice: wrongChoice(0),
    checked: true,
    correct: false,
    firstCorrect: false,
    attempts: 1,
  });
  // A second check of a question that is still open is ignored: the feedback stays put.
  assert.equal(quiz.checkQuizAnswer(progress, COURSE, 0, correctChoice(0)), missed);

  quiz.retryQuizAnswer(progress, COURSE, 0);
  assert.deepEqual(quiz.quizAnswer(progress, COURSE, 0), {
    choice: null,
    checked: false,
    correct: false,
    firstCorrect: false,
    attempts: 1,
  });

  const recovered = quiz.checkQuizAnswer(progress, COURSE, 0, correctChoice(0));
  assert.equal(recovered.correct, true);
  assert.equal(recovered.firstCorrect, false, 'the first attempt stays recorded as missed');
  assert.equal(recovered.attempts, 2);
});

test('"まだ分からない" is stored as a checked answer with no choice', () => {
  const progress = quiz.newQuizProgress();
  const unsure = quiz.checkQuizAnswer(progress, COURSE, 1, null);
  assert.deepEqual(unsure, {
    choice: null,
    checked: true,
    correct: false,
    firstCorrect: false,
    attempts: 1,
  });
});

test('an impossible choice is rejected rather than stored', () => {
  const progress = quiz.newQuizProgress();
  const outOfRange = QUIZZES[COURSE][0].choices.length;
  assert.throws(() => quiz.checkQuizAnswer(progress, COURSE, 0, outOfRange), /Invalid quiz answer/);
  assert.throws(() => quiz.checkQuizAnswer(progress, COURSE, 0, 1.5), /Invalid quiz answer/);
  assert.throws(() => quiz.checkQuizAnswer(progress, COURSE, 0, '1'), /Invalid quiz answer/);
  assert.throws(() => quiz.checkQuizAnswer(progress, COURSE, 99, 0), /Invalid quiz answer/);
  assert.deepEqual(progress[COURSE].answers, {});
});

test('the summary counts first-time and recovered answers apart', () => {
  const progress = quiz.newQuizProgress();
  quiz.checkQuizAnswer(progress, COURSE, 0, correctChoice(0));
  quiz.checkQuizAnswer(progress, COURSE, 1, wrongChoice(1));
  quiz.retryQuizAnswer(progress, COURSE, 1);
  quiz.checkQuizAnswer(progress, COURSE, 1, correctChoice(1));
  quiz.checkQuizAnswer(progress, COURSE, 2, wrongChoice(2));

  const summary = quiz.quizSummary(progress, COURSE);
  assert.equal(summary.total, QUIZZES[COURSE].length);
  assert.equal(summary.checked, 3);
  assert.equal(summary.first, 1);
  assert.equal(summary.recovered, 1);
  assert.deepEqual(summary.remaining, [2, 3, 4, 5], 'a missed answer stays on the list');
});

test('saved checkpoint answers come back, and anything unexpected is dropped', () => {
  const progress = quiz.newQuizProgress();
  quiz.checkQuizAnswer(progress, COURSE, 0, wrongChoice(0));
  quiz.retryQuizAnswer(progress, COURSE, 0);
  quiz.checkQuizAnswer(progress, COURSE, 0, correctChoice(0));
  progress[COURSE].index = 3;

  const restored = quiz.restoreQuizProgress(quiz.serializeQuizProgress(progress));
  assert.deepEqual(restored[COURSE], progress[COURSE]);

  for (const raw of [
    null,
    'not json',
    JSON.stringify({ version: 2, courses: progress }),
    JSON.stringify({ version: 1 }),
  ])
    assert.deepEqual(quiz.restoreQuizProgress(raw), quiz.newQuizProgress(), `rejects ${raw}`);

  const tampered = {
    version: 1,
    courses: {
      [COURSE]: {
        index: 99, // beyond the summary page
        answers: {
          [questionId(0)]: { choice: 0, checked: true, firstCorrect: true, attempts: 0 },
          [questionId(1)]: { choice: 99, checked: true, firstCorrect: true, attempts: 1 },
          [questionId(2)]: {
            choice: correctChoice(2),
            checked: 'yes',
            firstCorrect: true,
            attempts: 1,
          },
          // "correct" is recomputed from the choice, never trusted from storage.
          [questionId(3)]: {
            choice: wrongChoice(3),
            checked: true,
            correct: true,
            firstCorrect: true,
            attempts: 2,
          },
        },
      },
      nosuchcourse: { index: 1, answers: {} },
    },
  };
  const cleaned = quiz.restoreQuizProgress(JSON.stringify(tampered));
  assert.equal(cleaned[COURSE].index, 0);
  assert.deepEqual(Object.keys(cleaned[COURSE].answers), [questionId(3)]);
  assert.deepEqual(cleaned[COURSE].answers[questionId(3)], {
    choice: wrongChoice(3),
    checked: true,
    firstCorrect: true,
    correct: false,
    attempts: 2,
  });
  assert.equal('nosuchcourse' in cleaned, false);
});

// --- mastery test ------------------------------------------------------------------------------

const [numberQuestion, choiceQuestion, writingQuestion] = MASTERY_TESTS[COURSE];

function correctDraft() {
  return {
    [numberQuestion.id]: {
      value: String(numberQuestion.answer.value),
      reason: String(numberQuestion.reason.value),
      note: '',
      noteUnknown: false,
    },
    [choiceQuestion.id]: {
      value: String(choiceQuestion.answer.value),
      reason: String(choiceQuestion.reason.value),
      note: '',
      noteUnknown: false,
    },
    [writingQuestion.id]: {
      value: String(writingQuestion.answer.value),
      reason: String(writingQuestion.reason.value),
      note: '条件をそろえてから比べる。',
      noteUnknown: false,
    },
  };
}

test('a mastery draft starts empty and is only created once', () => {
  const progress = mastery.newMasteryProgress();
  assert.deepEqual(progress[COURSE], { draft: null, first: null, last: null, attempts: 0 });
  assert.deepEqual(mastery.blankMasteryAnswer(), {
    value: '',
    reason: '',
    note: '',
    noteUnknown: false,
  });

  const draft = mastery.beginMastery(progress, COURSE);
  assert.deepEqual(draft, { index: 0, answers: {} });
  draft.index = 2;
  assert.equal(mastery.beginMastery(progress, COURSE), draft, 'an open draft is kept');
  assert.deepEqual(mastery.masteryAnswer(progress, COURSE, 0), mastery.blankMasteryAnswer());
  assert.throws(() => mastery.beginMastery(progress, 'nosuchcourse'), /Unknown course/);
});

test('a question is complete once its parts are answered or marked unknown', () => {
  const blank = mastery.blankMasteryAnswer();
  assert.deepEqual(mastery.masteryMissing(numberQuestion, blank), ['答え', '根拠']);
  assert.deepEqual(mastery.masteryMissing(writingQuestion, undefined), [
    '答え',
    '根拠',
    '自分の説明',
  ]);
  assert.deepEqual(
    mastery.masteryMissing(writingQuestion, {
      value: '?',
      reason: '?',
      note: '  ',
      noteUnknown: true,
    }),
    [],
    '"まだ分からない" counts as an answer',
  );
  assert.deepEqual(
    mastery.masteryMissing(choiceQuestion, {
      value: String(choiceQuestion.answer.choices.length),
      reason: '0',
    }),
    ['答え'],
    'a choice beyond the list is not an answer',
  );
});

test('numbers are read the way a learner types them', () => {
  const answered = (value) => ({ value, reason: '0', note: '', noteUnknown: false });
  const accepts = (value) => mastery.masteryMissing(numberQuestion, answered(value)).length === 0;
  assert.equal(accepts('50'), true);
  assert.equal(accepts(' 50 '), true);
  assert.equal(accepts('５０'), true, 'full-width digits');
  assert.equal(accepts('−3'), true, 'the minus sign U+2212, as typed on a Japanese keyboard');
  assert.equal(accepts('.5'), true);
  assert.equal(accepts('5.'), true);
  assert.equal(accepts(''), false);
  assert.equal(accepts('50%'), false);
  assert.equal(accepts('5e1'), false);
  assert.equal(accepts('やく50'), false);
});

test('grading keeps the answer and the reason apart, within the stated tolerance', () => {
  const draft = correctDraft();
  const graded = mastery.gradeMastery(COURSE, draft);
  assert.equal(graded.total, 3);
  assert.equal(graded.judgment, 3);
  assert.equal(graded.reasoning, 3);
  assert.equal(graded.complete, 3);
  assert.deepEqual(graded.results[2], {
    id: writingQuestion.id,
    judgment: true,
    reasoning: true,
    complete: true,
    written: true,
  });

  const tolerance = numberQuestion.answer.tolerance;
  const nudge = (delta) => {
    const answers = correctDraft();
    answers[numberQuestion.id].value = String(numberQuestion.answer.value + delta);
    return mastery.gradeMastery(COURSE, answers).results[0].judgment;
  };
  assert.equal(nudge(tolerance), true);
  assert.equal(nudge(tolerance * 2), false);

  const unknown = correctDraft();
  unknown[choiceQuestion.id].reason = '?';
  unknown[writingQuestion.id].noteUnknown = true;
  const partial = mastery.gradeMastery(COURSE, unknown);
  assert.equal(partial.judgment, 3);
  assert.equal(partial.reasoning, 2);
  assert.equal(partial.complete, 2);
  assert.equal(partial.results[2].written, false, '"まだ説明できない" is not a written answer');

  const nothingAnswered = mastery.gradeMastery(COURSE, undefined);
  assert.equal(nothingAnswered.complete, 0);
});

test('submitting closes the draft, keeps the first attempt and counts the retries', () => {
  const progress = mastery.newMasteryProgress();
  const draft = mastery.beginMastery(progress, COURSE);
  draft.answers = correctDraft();
  draft.answers[choiceQuestion.id].value = String((choiceQuestion.answer.value + 1) % 3);

  const graded = mastery.submitMastery(progress, COURSE, SUBMITTED_AT);
  assert.equal(graded.complete, 2);
  const saved = progress[COURSE];
  assert.equal(saved.draft, null);
  assert.equal(saved.attempts, 1);
  assert.equal(saved.last.at, SUBMITTED_AT);
  assert.deepEqual(saved.last.checks, [false, false, false]);
  assert.deepEqual(saved.first.answers, saved.last.answers);
  assert.notEqual(saved.first, saved.last, 'the two attempts are separate copies');
  assert.equal(mastery.submitMastery(progress, COURSE, SUBMITTED_AT), null, 'no second attempt');

  mastery.beginMastery(progress, COURSE);
  progress[COURSE].draft.answers = correctDraft();
  const retry = mastery.submitMastery(progress, COURSE, SUBMITTED_AT);
  assert.equal(retry.complete, 3);
  assert.equal(progress[COURSE].attempts, 2);
  assert.equal(
    mastery.gradeMastery(COURSE, progress[COURSE].first.answers).complete,
    2,
    'the first attempt is untouched by the retry',
  );

  mastery.beginMastery(progress, COURSE);
  assert.throws(() => mastery.submitMastery(progress, COURSE, SUBMITTED_AT), /Incomplete answers/);
});

test('saved mastery attempts come back, and half-finished ones are dropped', () => {
  const progress = mastery.newMasteryProgress();
  mastery.beginMastery(progress, COURSE).answers = correctDraft();
  mastery.submitMastery(progress, COURSE, SUBMITTED_AT);
  mastery.beginMastery(progress, COURSE);
  progress[COURSE].draft.index = 2;
  progress[COURSE].draft.answers = correctDraft();
  progress[COURSE].last.checks[1] = true;

  const restored = mastery.restoreMastery(mastery.serializeMastery(progress));
  assert.deepEqual(restored[COURSE], progress[COURSE]);

  for (const raw of [null, '{', JSON.stringify({ version: 2, courses: {} })])
    assert.deepEqual(mastery.restoreMastery(raw), mastery.newMasteryProgress(), `rejects ${raw}`);

  // An attempt that no longer passes the completeness check is dropped; when only one of the two
  // attempts survives, the other is filled in from it so the results page always has both.
  const brokenLast = JSON.parse(mastery.serializeMastery(progress));
  brokenLast.courses[COURSE].last.answers[numberQuestion.id].value = 'ひらがな';
  brokenLast.courses[COURSE].attempts = 7;
  const filled = mastery.restoreMastery(JSON.stringify(brokenLast));
  assert.deepEqual(filled[COURSE].last, filled[COURSE].first);
  assert.notEqual(filled[COURSE].last, filled[COURSE].first, 'separate copies');
  assert.equal(filled[COURSE].attempts, 7);

  const brokenBoth = JSON.parse(mastery.serializeMastery(progress));
  for (const attempt of ['first', 'last'])
    brokenBoth.courses[COURSE][attempt].answers[numberQuestion.id].value = 'ひらがな';
  const cleaned = mastery.restoreMastery(JSON.stringify(brokenBoth));
  assert.equal(cleaned[COURSE].first, null);
  assert.equal(cleaned[COURSE].last, null);
  assert.equal(cleaned[COURSE].attempts, 0);
  assert.equal(cleaned[COURSE].draft.index, 2, 'the open draft survives');

  const overlong = JSON.parse(mastery.serializeMastery(progress));
  const draftAnswer = overlong.courses[COURSE].draft.answers[writingQuestion.id];
  draftAnswer.note = 'あ'.repeat(2000);
  draftAnswer.reason = '0123456789012';
  const trimmed = mastery.restoreMastery(JSON.stringify(overlong));
  assert.equal(trimmed[COURSE].draft.answers[writingQuestion.id].note.length, 1500);
  assert.equal(trimmed[COURSE].draft.answers[writingQuestion.id].reason, '');
});

// --- same answers, same results as before the rewrite -------------------------------------------

// A single scripted session through every exported function, as plain data, so the whole surface
// can be diffed against the modules it was rewritten from.
function transcript(quizCore, masteryCore) {
  const out = { keys: [quizCore.QUIZ_STORAGE_KEY, masteryCore.MASTERY_STORAGE_KEY] };

  const progress = quizCore.newQuizProgress();
  out.blankProgress = progress;
  out.checks = [];
  for (let index = 0; index < QUIZZES[COURSE].length; index++) {
    const choice =
      index % 3 === 0 ? correctChoice(index) : index % 3 === 1 ? null : wrongChoice(index);
    out.checks.push(quizCore.checkQuizAnswer(progress, COURSE, index, choice));
  }
  quizCore.retryQuizAnswer(progress, COURSE, 2);
  out.afterRetry = quizCore.quizAnswer(progress, COURSE, 2);
  out.checks.push(quizCore.checkQuizAnswer(progress, COURSE, 2, correctChoice(2)));
  out.summary = quizCore.quizSummary(progress, COURSE);
  out.serialized = quizCore.serializeQuizProgress(progress);
  out.restored = quizCore.restoreQuizProgress(out.serialized);
  out.restoredJunk = quizCore.restoreQuizProgress(
    '{"version":1,"courses":{"control":{"index":2}}}',
  );

  const mastered = masteryCore.newMasteryProgress();
  out.blankMastery = mastered;
  masteryCore.beginMastery(mastered, COURSE).answers = correctDraft();
  out.missing = MASTERY_TESTS[COURSE].map((question) =>
    masteryCore.masteryMissing(question, masteryCore.blankMasteryAnswer()),
  );
  out.numberForms = ['50', ' 50 ', '５０', '−3', '.5', '5.', '5e1', '50%', ''].map(
    (value) => masteryCore.masteryMissing(numberQuestion, { value, reason: '0' }).length,
  );
  out.firstGrade = masteryCore.submitMastery(mastered, COURSE, SUBMITTED_AT);
  out.repeatSubmit = masteryCore.submitMastery(mastered, COURSE, SUBMITTED_AT);
  masteryCore.beginMastery(mastered, COURSE);
  mastered[COURSE].draft.answers = correctDraft();
  mastered[COURSE].draft.answers[numberQuestion.id].value = '?';
  mastered[COURSE].draft.answers[writingQuestion.id] = {
    value: '?',
    reason: '?',
    note: '',
    noteUnknown: true,
  };
  out.retryGrade = masteryCore.submitMastery(mastered, COURSE, SUBMITTED_AT);
  out.progressAfter = mastered[COURSE];
  out.masterySerialized = masteryCore.serializeMastery(mastered);
  out.masteryRestored = masteryCore.restoreMastery(out.masterySerialized);
  out.masteryAnswers = MASTERY_TESTS[COURSE].map((_, index) =>
    masteryCore.masteryAnswer(out.masteryRestored, COURSE, index),
  );
  return out;
}

const baselineRoot = process.env.LAB_BASELINE;
const baselineModule = (file) => pathToFileURL(path.join(baselineRoot, 'js/quiz', file)).href;

test(
  'every exported function answers as it did before the rewrite',
  { skip: baselineRoot ? false : 'set LAB_BASELINE to a copy of the site before the rewrite' },
  async () => {
    assert.ok(
      fs.existsSync(path.join(baselineRoot, 'js/quiz/core.js')),
      'LAB_BASELINE has no site',
    );
    const before = {
      quiz: await import(baselineModule('core.js')),
      mastery: await import(baselineModule('mastery-core.js')),
    };
    assert.deepEqual(transcript(quiz, mastery), transcript(before.quiz, before.mastery));
  },
);
