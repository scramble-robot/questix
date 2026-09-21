import { MASTERY_TESTS } from './mastery-data.js';

const MASTERY_STORAGE_KEY = 'questix-mastery-v1';
function newMasteryProgress() {
  return Object.fromEntries(
    Object.keys(MASTERY_TESTS).map((c) => [
      c,
      { draft: null, first: null, last: null, attempts: 0 },
    ]),
  );
}
function blankMasteryAnswer() {
  return { value: '', reason: '', note: '', noteUnknown: false };
}
function beginMastery(progress, course) {
  if (!MASTERY_TESTS[course]) throw new Error('Unknown course');
  return progress[course].draft ?? (progress[course].draft = { index: 0, answers: {} });
}
function masteryAnswer(progress, course, index) {
  return progress[course].draft?.answers[MASTERY_TESTS[course][index].id] || blankMasteryAnswer();
}
const isChoice = (value, choices) =>
  typeof value === 'string' && /^\d+$/.test(value) && Number(value) < choices.length;
const numericText = (value) => value.normalize('NFKC').trim().replaceAll('−', '-');
const isNumber = (value) =>
  typeof value === 'string' &&
  numericText(value) !== '' &&
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(numericText(value)) &&
  Number.isFinite(Number(numericText(value)));
function masteryMissing(question, answer) {
  const a = answer || blankMasteryAnswer(),
    missing = [];
  if (!(
    a.value === '?' ||
    (question.answer.type === 'number'
      ? isNumber(a.value)
      : isChoice(a.value, question.answer.choices))
  ))
    missing.push('答え');
  if (!(a.reason === '?' || isChoice(a.reason, question.reason.choices))) missing.push('根拠');
  if (question.writing && !a.note?.trim() && !a.noteUnknown) missing.push('自分の説明');
  return missing;
}
function gradeMastery(course, answers) {
  const results = MASTERY_TESTS[course].map((q) => {
    const a = answers?.[q.id] || blankMasteryAnswer();
    const judgment =
      q.answer.type === 'number'
        ? isNumber(a.value) &&
          Math.abs(Number(numericText(a.value)) - q.answer.value) <= q.answer.tolerance + 1e-10
        : isChoice(a.value, q.answer.choices) && Number(a.value) === q.answer.value;
    const reasoning = isChoice(a.reason, q.reason.choices) && Number(a.reason) === q.reason.value;
    return {
      id: q.id,
      judgment,
      reasoning,
      complete: judgment && reasoning,
      written: !!q.writing && !!a.note?.trim() && !a.noteUnknown,
    };
  });
  return {
    results,
    total: results.length,
    judgment: results.filter((r) => r.judgment).length,
    reasoning: results.filter((r) => r.reasoning).length,
    complete: results.filter((r) => r.complete).length,
  };
}
function submitMastery(progress, course, at = new Date().toISOString()) {
  const c = progress[course],
    draft = c?.draft;
  if (!draft) return null; // A repeated submit must not create a second attempt.
  if (MASTERY_TESTS[course].some((q) => masteryMissing(q, draft.answers[q.id]).length))
    throw new Error('Incomplete answers');
  const result = {
    answers: JSON.parse(JSON.stringify(draft.answers)),
    at,
    checks: [false, false, false],
  };
  if (!c.first) c.first = JSON.parse(JSON.stringify(result));
  c.last = result;
  c.draft = null;
  c.attempts++;
  return gradeMastery(course, result.answers);
}
function serializeMastery(progress) {
  return JSON.stringify({ version: 1, courses: progress });
}
function restoreMastery(raw) {
  const clean = newMasteryProgress();
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    return clean;
  }
  if (saved?.version !== 1 || !saved.courses || typeof saved.courses !== 'object') return clean;
  const answers = (course, input) =>
    Object.fromEntries(
      MASTERY_TESTS[course].map((q) => {
        const a = input?.[q.id],
          value = typeof a?.value === 'string' && a.value.length < 80 ? a.value : '',
          reason = typeof a?.reason === 'string' && a.reason.length < 10 ? a.reason : '';
        return [
          q.id,
          {
            value,
            reason,
            note: typeof a?.note === 'string' ? a.note.slice(0, 1500) : '',
            noteUnknown: a?.noteUnknown === true,
          },
        ];
      }),
    );
  const result = (course, input) => {
    if (!input || typeof input !== 'object') return null;
    const a = answers(course, input.answers);
    if (MASTERY_TESTS[course].some((q) => masteryMissing(q, a[q.id]).length)) return null;
    return {
      answers: a,
      at: typeof input.at === 'string' && input.at.length < 50 ? input.at : '',
      checks: [0, 1, 2].map((i) => input.checks?.[i] === true),
    };
  };
  for (const course of Object.keys(clean)) {
    const src = saved.courses[course];
    if (!src || typeof src !== 'object') continue;
    const c = clean[course];
    c.first = result(course, src.first);
    c.last = result(course, src.last);
    if (c.last && !c.first) c.first = JSON.parse(JSON.stringify(c.last));
    if (c.first && !c.last) c.last = JSON.parse(JSON.stringify(c.first));
    c.attempts = c.first
      ? Number.isInteger(src.attempts) && src.attempts >= 1 && src.attempts <= 10000
        ? src.attempts
        : 1
      : 0;
    if (src.draft && typeof src.draft === 'object')
      c.draft = {
        index:
          Number.isInteger(src.draft.index) &&
          src.draft.index >= 0 &&
          src.draft.index < MASTERY_TESTS[course].length
            ? src.draft.index
            : 0,
        answers: answers(course, src.draft.answers),
      };
  }
  return clean;
}

export {
  MASTERY_STORAGE_KEY,
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
