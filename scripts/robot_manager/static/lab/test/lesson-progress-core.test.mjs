// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// The shared footer of every course (js/shell/lesson-progress-core.js): where the learner is and
// when the course's summary opens fully.
import test from 'node:test';
import assert from 'node:assert/strict';

import { progressModel, parseVisited } from '../js/shell/lesson-progress-core.js';

const topics = ['a', 'b', 'c', 'd'].map((id) => ({ id, title: id.toUpperCase() }));

test('the footer knows the experiment on screen and its neighbours', () => {
  const model = progressModel({ topics, current: 'b', visited: ['a'] });
  assert.equal(model.number, 2);
  assert.equal(model.total, 4);
  assert.equal(model.previous.id, 'a');
  assert.equal(model.next.id, 'c');
  assert.equal(model.visitedCount, 2); // the one on screen counts as opened
  assert.deepEqual(
    model.items.map((item) => [item.id, item.current, item.visited]),
    [
      ['a', false, true],
      ['b', true, true],
      ['c', false, false],
      ['d', false, false],
    ],
  );
});

test('the summary opens fully only at the end or once every experiment was opened', () => {
  assert.equal(progressModel({ topics, current: 'a' }).ready, false);
  assert.equal(progressModel({ topics, current: 'c', visited: ['a', 'b'] }).ready, false);
  const last = progressModel({ topics, current: 'd' });
  assert.equal(last.ready, true);
  assert.equal(last.next, null);
  assert.equal(progressModel({ topics, current: 'a', visited: ['b', 'c', 'd'] }).ready, true);
});

test('an unknown current experiment falls back to the first', () => {
  const model = progressModel({ topics, current: 'zz' });
  assert.equal(model.number, 1);
  assert.equal(model.previous, null);
});

test('stored visits are read defensively', () => {
  assert.deepEqual(parseVisited(null), {});
  assert.deepEqual(parseVisited('not json'), {});
  assert.deepEqual(parseVisited('[1,2]'), {});
  assert.deepEqual(parseVisited('{"control":["p",3,"i"],"arm":"x"}'), { control: ['p', 'i'] });
});
