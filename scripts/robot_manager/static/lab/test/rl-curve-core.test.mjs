// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// The learning curves of the reinforcement-learning course (js/rl/curve-core.js) and the helpers
// that let the primer draw a spin (js/rl/intro.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { blockMeans, blockPoints, curveLayout, rewardCurveLayout } from '../js/rl/curve-core.js';
import {
  IntroLearner,
  introRandom,
  introRollout,
  introTurns,
  turnsInPlace,
} from '../js/rl/intro.js';

test('block means average whole blocks and drop an unfinished one', () => {
  assert.deepEqual(blockMeans([1, 3, 5, 7, 9], 2), [2, 6]);
  assert.deepEqual(blockPoints([1, 3, 5, 7], 2), [
    { x: 2, y: 2 },
    { x: 4, y: 6 },
  ]);
  assert.deepEqual(blockMeans([1], 50), []);
});

test('the x axis spans the whole run from the first point on, with round ticks', () => {
  const layout = curveLayout({ series: [{ role: 'actual', label: 'a', points: [] }], xMax: 800 });
  assert.equal(layout.xScale.min, 0);
  assert.equal(layout.xScale.max, 800);
  assert.deepEqual(
    layout.xTicks.map((tick) => tick.value),
    [0, 200, 400, 600, 800],
  );
  assert.equal(layout.empty, true);
});

test('the y axis keeps the promised range, so it does not move while the curve grows', () => {
  const early = curveLayout({
    series: [{ role: 'actual', label: 'a', points: [{ x: 50, y: 9 }] }],
    xMax: 800,
    yRange: [0, 35],
  });
  const late = curveLayout({
    series: [
      {
        role: 'actual',
        label: 'a',
        points: [
          { x: 50, y: 9 },
          { x: 800, y: 32 },
        ],
      },
    ],
    xMax: 800,
    yRange: [0, 35],
  });
  assert.deepEqual(early.yScale, late.yScale);
  assert.deepEqual(
    early.yTicks.map((tick) => tick.label),
    ['0', '10', '20', '30', '40'],
  );
  assert.equal(early.yTicks[0].zero, true);
  assert.equal(early.yTicks[0].position, 100); // zero at the bottom of the plot
});

test('a missing value breaks the line, and the end label sits on the last real point', () => {
  const layout = curveLayout({
    series: [
      {
        role: 'actual',
        label: 'a',
        points: [
          { x: 0, y: 0 },
          { x: 50, y: null },
          { x: 100, y: 10 },
          { x: 150, y: null },
        ],
      },
    ],
    xMax: 200,
    yRange: [0, 10],
  });
  const line = layout.lines[0];
  assert.equal((line.path.match(/M/g) || []).length, 2);
  assert.equal(line.end.value, 10);
  assert.equal(line.end.x, 50);
});

test('reward curves average 50 runs per point', () => {
  const rewards = Array.from({ length: 120 }, (_, index) => (index < 50 ? 1 : 3));
  const layout = rewardCurveLayout([{ role: 'actual', label: 'a', rewards }], 800, [0, 35]);
  assert.equal(layout.lines[0].end.value, 3);
  assert.equal((layout.lines[0].path.match(/[ML]/g) || []).length, 2);
});

test('recording the reward of every run does not change what the learner learns', () => {
  const learner = new IntroLearner('approach', introRandom(71), { startMode: 'fixed' });
  learner.train(100);
  assert.equal(learner.episodeRewards.length, 100);
  // The same seed trained without looking at the rewards ends with the same table.
  const again = new IntroLearner('approach', introRandom(71), { startMode: 'fixed' });
  again.train(100);
  assert.deepEqual(again.q, learner.q);
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(mean(learner.episodeRewards.slice(-20)) > mean(learner.episodeRewards.slice(0, 20)));
});

test('a run that only spins is counted in whole turns and shows every turn on the spot', () => {
  const spinner = new IntroLearner('spin', introRandom(71));
  spinner.train(800);
  const run = introRollout(spinner);
  const turns = introTurns(run.trace);
  assert.ok(turns > 3, `expected several turns, got ${turns}`);
  assert.ok(turnsInPlace(run.trace).length > 0);
  const straight = [
    { x: 0, y: 0, theta: 0 },
    { x: 0.16, y: 0, theta: 0 },
    { x: 0.16, y: 0, theta: Math.PI / 2 },
  ];
  assert.equal(introTurns(straight), 0.25);
  assert.deepEqual(turnsInPlace(straight), [straight[2]]);
});
