import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { QUIZZES } from '../js/quiz/data.js';
import { MASTERY_TESTS } from '../js/quiz/mastery-data.js';
import {
  newQuizProgress,
  checkQuizAnswer,
  quizAnswer,
  serializeQuizProgress,
  restoreQuizProgress,
} from '../js/quiz/core.js';
import { gradeMastery } from '../js/quiz/mastery-core.js';
import {
  makeRecording,
  recordingTableCSV,
  serializeRecording,
  parseRecording,
} from '../js/live/recording-core.js';
const root = new URL('../', import.meta.url);
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    return e.isDirectory() ? files(path) : [path];
  });
}

test('current content and JS use symbolic compound units and the chosen approximation sign', () => {
  const remaining = [];
  for (const path of [...files(new URL('content/', root)), ...files(new URL('js/', root))]) {
    const text = fs.readFileSync(path, 'utf8');
    assert(!text.includes('≈'), path.pathname);
    if (text.includes('/秒')) remaining.push(path.pathname.split('/lab/')[1]);
    assert(!/rpm[・·]秒/.test(text), path.pathname);
  }
  // The existing exported table's four Japanese column names are a compatibility contract.
  assert.deepEqual(remaining, ['js/live/recording-core.js']);
  const csvSource = fs.readFileSync(new URL('js/live/recording-core.js', root), 'utf8');
  assert.equal(csvSource.split('/秒').length - 1, 4);
});

test('recording CSV headers and old text in saved JSON remain unchanged', () => {
  const old = makeRecording({
    source: 'live',
    name: '旧い記録',
    recordedAt: '2026-01-01T00:00:00Z',
    config: { wheel_radius: 0.05, wheel_separation: 0.5 },
    topics: {},
    conditions: { label: '前後0.1 m/秒' },
    streams: { drive: [], twist: [], scan: [], odom: [] },
  });
  const restored = parseRecording(serializeRecording(old));
  assert.deepEqual(restored, old);
  const csv = recordingTableCSV(restored);
  for (const column of [
    '指令の速さ（m/秒）',
    '実測の速さ（m/秒）',
    '指令の回転の速さ（rad/秒）',
    '実測の回転の速さ（rad/秒）',
  ])
    assert(csv.includes(column), column);
  assert(csv.includes('前後0.1 m/秒'));
});

test('checkpoint choices containing units grade and restore by index, independent of labels', () => {
  let questions = 0;
  for (const [course, list] of Object.entries(QUIZZES))
    for (const [index, q] of list.entries()) {
      if (!/\/(?:s|秒)/.test(JSON.stringify(q))) continue;
      questions++;
      for (let choice = 0; choice < q.choices.length; choice++) {
        const progress = newQuizProgress();
        const answer = checkQuizAnswer(progress, course, index, choice);
        assert.equal(answer.correct, choice === q.answer, q.id);
        const restored = restoreQuizProgress(serializeQuizProgress(progress));
        assert.equal(quizAnswer(restored, course, index).correct, choice === q.answer, q.id);
      }
    }
  assert(questions > 0);
});

test('mastery questions containing units retain correct and wrong grading', () => {
  let questions = 0;
  for (const [course, list] of Object.entries(MASTERY_TESTS))
    for (const q of list) {
      if (!/\/(?:s|秒)/.test(JSON.stringify(q))) continue;
      questions++;
      const right = {
        value: String(q.answer.value),
        reason: String(q.reason.value),
        note: '旧い説明 1 m/秒',
        noteUnknown: false,
      };
      const correct = gradeMastery(course, { [q.id]: right }).results.find((r) => r.id === q.id);
      assert.equal(correct.judgment, true, q.id);
      assert.equal(correct.reasoning, true, q.id);
      const wrongValue =
        q.answer.type === 'number'
          ? String(q.answer.value + 1000)
          : String((q.answer.value + 1) % q.answer.choices.length);
      const wrong = gradeMastery(course, { [q.id]: { ...right, value: wrongValue } }).results.find(
        (r) => r.id === q.id,
      );
      assert.equal(wrong.judgment, false, q.id);
    }
  assert(questions > 0);
});
