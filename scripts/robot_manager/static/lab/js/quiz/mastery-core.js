import { MASTERY_TESTS } from './mastery-data.js';
import { savedCourses, forStorage, copyOfRecord } from './storage.js';

// Mastery test: the draft the learner is filling in, the attempts that were submitted, and how a
// submission is graded. No DOM — mastery-ui.js owns the page.
//
// Every question is answered in two parts that are counted apart: the answer itself (a choice or a
// number) and the reason for it. A learner can reach the right number from the wrong idea, and the
// results page uses the two counts to send them back to the matching experiment. The last question
// also asks for a written answer, which is never graded automatically.

const MASTERY_STORAGE_KEY = 'questix-mastery-v1';
const UNKNOWN = '?'; // stored value of "まだ分からない" / "まだ求められない"
const CRITERIA_COUNT = 3; // self-check items the learner ticks under the written answer
const TOLERANCE_SLACK = 1e-10; // so a value exactly on a question's tolerance still counts
// Lengths a saved record may have. They mirror the form's own limits; anything longer was not
// typed into this page.
const MAX_VALUE_LENGTH = 80;
const MAX_REASON_LENGTH = 10;
const MAX_NOTE_LENGTH = 1500; // the textarea's maxlength
const MAX_TIMESTAMP_LENGTH = 50;
const MAX_SAVED_ATTEMPTS = 10000;

function newMasteryProgress() {
  const courses = Object.keys(MASTERY_TESTS).map((course) => [
    course,
    { draft: null, first: null, last: null, attempts: 0 },
  ]);
  return Object.fromEntries(courses);
}

function blankMasteryAnswer() {
  return { value: '', reason: '', note: '', noteUnknown: false };
}

const newChecks = () => Array.from({ length: CRITERIA_COUNT }, () => false);

// Returns the open draft, opening one if the learner has not started yet.
function beginMastery(progress, course) {
  if (!MASTERY_TESTS[course]) throw new Error('Unknown course');
  const record = progress[course];
  if (!record.draft) record.draft = { index: 0, answers: {} };
  return record.draft;
}

function masteryAnswer(progress, course, index) {
  const question = MASTERY_TESTS[course][index];
  return progress[course].draft?.answers[question.id] || blankMasteryAnswer();
}

const isChoiceIndex = (value, choices) =>
  typeof value === 'string' && /^\d+$/.test(value) && Number(value) < choices.length;

// Learners type on a Japanese keyboard: full-width digits and the minus sign U+2212 are normal.
const numericText = (value) => value.normalize('NFKC').trim().replaceAll('−', '-');
// Plain decimals only. A learner writes 0.05, not 5e-2, and "50%" or "やく50" must be asked about
// rather than silently read as 50.
const PLAIN_DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function isNumberText(value) {
  if (typeof value !== 'string') return false;
  const text = numericText(value);
  if (text === '' || !PLAIN_DECIMAL.test(text)) return false;
  return Number.isFinite(Number(text));
}

// A part is answered once it holds a usable value or the learner marked it as not yet known.
function isAnswered(part, value) {
  if (value === UNKNOWN) return true;
  if (part.type === 'number') return isNumberText(value);
  return isChoiceIndex(value, part.choices);
}

// The parts of a question the learner still has to fill in, in the order they appear on the page;
// an empty list means the question may be submitted. mastery-ui.js joins them into the message
// under the form.
function masteryMissing(question, answer) {
  const given = answer || blankMasteryAnswer();
  const missing = [];
  if (!isAnswered(question.answer, given.value)) missing.push('答え');
  if (!isAnswered(question.reason, given.reason)) missing.push('根拠');
  if (question.writing && !given.note?.trim() && !given.noteUnknown) missing.push('自分の説明');
  return missing;
}

function isCorrect(part, value) {
  if (part.type !== 'number')
    return isChoiceIndex(value, part.choices) && Number(value) === part.value;
  if (!isNumberText(value)) return false;
  return Math.abs(Number(numericText(value)) - part.value) <= part.tolerance + TOLERANCE_SLACK;
}

function gradeQuestion(question, answer) {
  const given = answer || blankMasteryAnswer();
  const judgment = isCorrect(question.answer, given.value);
  const reasoning = isCorrect(question.reason, given.reason);
  return {
    id: question.id,
    judgment,
    reasoning,
    complete: judgment && reasoning,
    // Only says that something was written, not whether it is any good: the learner judges the
    // written answer themselves against the example and the self-check items.
    written: Boolean(question.writing) && Boolean(given.note?.trim()) && !given.noteUnknown,
  };
}

function gradeMastery(course, answers) {
  const results = MASTERY_TESTS[course].map((question) =>
    gradeQuestion(question, answers?.[question.id]),
  );
  return {
    results,
    total: results.length,
    judgment: results.filter((result) => result.judgment).length,
    reasoning: results.filter((result) => result.reasoning).length,
    complete: results.filter((result) => result.complete).length,
  };
}

const anyMissing = (course, answers) =>
  MASTERY_TESTS[course].some((question) => masteryMissing(question, answers[question.id]).length);

// Files the open draft as an attempt and returns its grade. The first attempt is kept for good, so
// the results page can still show how the learner did before any retry.
function submitMastery(progress, course, at = new Date().toISOString()) {
  const record = progress[course];
  const draft = record?.draft;
  if (!draft) return null; // A repeated submit must not create a second attempt.
  if (anyMissing(course, draft.answers)) throw new Error('Incomplete answers');
  const attempt = { answers: copyOfRecord(draft.answers), at, checks: newChecks() };
  if (!record.first) record.first = copyOfRecord(attempt);
  record.last = attempt;
  record.draft = null;
  record.attempts++;
  return gradeMastery(course, attempt.answers);
}

const serializeMastery = (progress) => forStorage(progress);

const savedText = (value, maxLength) =>
  typeof value === 'string' && value.length < maxLength ? value : '';

function restoredAnswers(course, saved) {
  const entries = MASTERY_TESTS[course].map((question) => {
    const answer = saved?.[question.id];
    return [
      question.id,
      {
        value: savedText(answer?.value, MAX_VALUE_LENGTH),
        reason: savedText(answer?.reason, MAX_REASON_LENGTH),
        note: typeof answer?.note === 'string' ? answer.note.slice(0, MAX_NOTE_LENGTH) : '',
        noteUnknown: answer?.noteUnknown === true,
      },
    ];
  });
  return Object.fromEntries(entries);
}

// A submitted attempt is only shown again if it would still pass the submit check; a record left
// over from an earlier set of questions is dropped rather than half-shown.
function restoredAttempt(course, saved) {
  if (!saved || typeof saved !== 'object') return null;
  const answers = restoredAnswers(course, saved.answers);
  if (anyMissing(course, answers)) return null;
  return {
    answers,
    at: savedText(saved.at, MAX_TIMESTAMP_LENGTH),
    checks: Array.from({ length: CRITERIA_COUNT }, (_, i) => saved.checks?.[i] === true),
  };
}

function restoredDraft(course, saved) {
  if (!saved || typeof saved !== 'object') return null;
  const index = saved.index;
  const known = Number.isInteger(index) && index >= 0 && index < MASTERY_TESTS[course].length;
  return { index: known ? index : 0, answers: restoredAnswers(course, saved.answers) };
}

function restoredAttemptCount(saved, hasAttempt) {
  if (!hasAttempt) return 0;
  if (Number.isInteger(saved) && saved >= 1 && saved <= MAX_SAVED_ATTEMPTS) return saved;
  return 1;
}

// Ignore malformed or old records; loading a local HTML must also work when storage is blocked.
function restoreMastery(raw) {
  const clean = newMasteryProgress();
  const courses = savedCourses(raw);
  if (!courses) return clean;
  for (const course of Object.keys(clean)) {
    const saved = courses[course];
    if (!saved || typeof saved !== 'object') continue;
    const record = clean[course];
    record.first = restoredAttempt(course, saved.first);
    record.last = restoredAttempt(course, saved.last);
    // Only one of the two attempts survived: show it as both, so the results page always has the
    // pair it compares.
    if (record.last && !record.first) record.first = copyOfRecord(record.last);
    if (record.first && !record.last) record.last = copyOfRecord(record.first);
    record.attempts = restoredAttemptCount(saved.attempts, Boolean(record.first));
    record.draft = restoredDraft(course, saved.draft);
  }
  return clean;
}

export {
  MASTERY_STORAGE_KEY,
  UNKNOWN,
  CRITERIA_COUNT,
  newMasteryProgress,
  blankMasteryAnswer,
  beginMastery,
  masteryAnswer,
  masteryMissing,
  gradeMastery,
  submitMastery,
  serializeMastery,
  restoreMastery,
};
