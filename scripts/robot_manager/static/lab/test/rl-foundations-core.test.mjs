// Pins the DOM-free reinforcement-learning maths (intro.js, foundations-core.js) to the
// behaviour of the modules before the cleanup: same random streams, same values, same traces.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The pre-refactor modules are kept in test/baseline/ (see its README), so this runs in CI too.
const BASE = new URL('./baseline/js/rl/', import.meta.url).href;
const current = {
  intro: await import('../js/rl/intro.js'),
  core: await import('../js/rl/foundations-core.js'),
};
const baseline = {
  intro: await import(BASE + 'intro.js'),
  core: await import(BASE + 'foundations-core.js'),
};

const POSE = { x: 1.2, y: 0.9, theta: 0.4 };
const stripFunctions = (value) => JSON.parse(JSON.stringify(value));

test('introRandom reproduces the same stream for a seed', () => {
  const ours = current.intro.introRandom(71);
  const theirs = baseline.intro.introRandom(71);
  for (let i = 0; i < 50; i++) assert.equal(ours(), theirs());
  const first = current.intro.introRandom(3)();
  assert.ok(first >= 0 && first < 1);
});

test('introDistance measures to the goal at (3.9, 1.5)', () => {
  assert.equal(current.intro.introDistance({ x: 3.9, y: 1.5 }), 0);
  assert.equal(current.intro.introDistance(POSE), baseline.intro.introDistance(POSE));
});

test('introStep matches the baseline for every action, rule and wheel gain', () => {
  const physics = [{}, { leftGain: 0.7 }, { leftGain: 0.8, rightGain: 1.1 }];
  for (const rule of ['approach', 'spin'])
    for (const action of [0, 1, 2])
      for (const gains of physics)
        assert.deepEqual(
          current.intro.introStep(POSE, action, rule, gains),
          baseline.intro.introStep(POSE, action, rule, gains),
        );
});

test('introStep ends a run at a wall without moving the robot', () => {
  const nearWall = { x: 0.2, y: 1.5, theta: Math.PI };
  const outcome = current.intro.introStep(nearWall, 0, 'approach');
  assert.equal(outcome.hit, true);
  assert.equal(outcome.done, true);
  assert.equal(outcome.state.x, nearWall.x);
  assert.equal(outcome.reward, 0);
});

test('introStep pays the arrival bonus on top of the approach reward', () => {
  const nearGoal = { x: 3.6, y: 1.5, theta: 0 };
  const outcome = current.intro.introStep(nearGoal, 0, 'approach');
  assert.equal(outcome.success, true);
  assert.ok(outcome.reward > 8);
});

test('IntroLearner trains to the same values and example as the baseline', () => {
  for (const options of [{}, { startMode: 'fixed' }, { startMode: 'varied', varyWheels: true }])
    for (const rule of ['approach', 'spin']) {
      const ours = new current.intro.IntroLearner(rule, current.intro.introRandom(5), options);
      const theirs = new baseline.intro.IntroLearner(rule, baseline.intro.introRandom(5), options);
      ours.train(120);
      theirs.train(120);
      assert.deepEqual(ours.q, theirs.q);
      assert.equal(ours.episodes, theirs.episodes);
      assert.equal(ours.steps, theirs.steps);
      assert.deepEqual(ours.example, theirs.example);
      assert.equal(ours.state(POSE), theirs.state(POSE));
      assert.equal(ours.choose(POSE, 0.2), theirs.choose(POSE, 0.2));
    }
});

test('introRollout of a trained and of no model matches the baseline', () => {
  assert.deepEqual(current.intro.introRollout(null), baseline.intro.introRollout(null));
  const ours = new current.intro.IntroLearner('approach', current.intro.introRandom(71));
  const theirs = new baseline.intro.IntroLearner('approach', baseline.intro.introRandom(71));
  ours.train(300);
  theirs.train(300);
  const start = { x: 2.5, y: 2.0, theta: 1.0 };
  const physics = { leftGain: 0.7, rightGain: 1 };
  assert.deepEqual(
    current.intro.introRollout(ours, current.intro.introRandom(9), { start, physics }),
    baseline.intro.introRollout(theirs, baseline.intro.introRandom(9), { start, physics }),
  );
  // Evaluation must not touch the learner's own random stream.
  assert.equal(ours.random(), theirs.random());
});

test('experienceStep and robotReading match the baseline', () => {
  const ours = new current.intro.IntroLearner('approach', current.intro.introRandom(5));
  const theirs = new baseline.intro.IntroLearner('approach', baseline.intro.introRandom(5));
  let ourPose = { ...current.core.INTRO_START };
  let theirPose = { ...baseline.core.INTRO_START };
  for (const action of [2, 0, 0, 1, 0]) {
    const ourEvent = current.core.experienceStep(ours, ourPose, action);
    const theirEvent = baseline.core.experienceStep(theirs, theirPose, action);
    assert.deepEqual(ourEvent, theirEvent);
    ourPose = ourEvent.state;
    theirPose = theirEvent.state;
    assert.deepEqual(current.core.robotReading(ourPose), baseline.core.robotReading(theirPose));
  }
  const reading = current.core.robotReading(current.core.INTRO_START);
  assert.ok(reading.bearing > 0, 'the goal is to the right of the start heading');
  assert.deepEqual(reading.rpm, [0, 0]);
});

test('RouteLearner averages rewards like the baseline', () => {
  const ours = new current.core.RouteLearner();
  const theirs = new baseline.core.RouteLearner();
  for (const epsilon of [0, 0, 0.3, 0.3, 1, 1, 0.3, 0])
    for (let i = 0; i < 10; i++) assert.deepEqual(ours.step(epsilon), theirs.step(epsilon));
  assert.deepEqual(ours.values, theirs.values);
  assert.deepEqual(ours.counts, theirs.counts);
  assert.equal(ours.history.length, 80);
});

test('FutureLearner learns the same values and policy as the baseline', () => {
  for (const gamma of [0, 0.9]) {
    const ours = new current.core.FutureLearner(gamma);
    const theirs = new baseline.core.FutureLearner(gamma);
    ours.train(1);
    theirs.train(1);
    assert.deepEqual(ours.last, theirs.last);
    ours.train(60);
    theirs.train(60);
    assert.deepEqual(ours.q, theirs.q);
    assert.equal(ours.policy(), theirs.policy());
  }
  const lookAhead = new current.core.FutureLearner(0.9);
  lookAhead.train(200);
  assert.equal(lookAhead.policy(), 'delivery');
  assert.ok(Math.abs(lookAhead.q[0][1] - 8 * 0.9 ** 2) < 0.2);
});

test('evaluation starts and results match the baseline', () => {
  const ourStarts = current.core.evaluationStarts();
  assert.deepEqual(ourStarts, baseline.core.evaluationStarts());
  assert.equal(ourStarts.length, 20);
  for (const startMode of ['fixed', 'varied']) {
    const ours = current.core.newTrainingModel(startMode, startMode === 'varied');
    const theirs = baseline.core.newTrainingModel(startMode, startMode === 'varied');
    ours.train(200);
    theirs.train(200);
    const physics = { leftGain: 0.5, rightGain: 1 };
    assert.deepEqual(
      stripFunctions(current.core.evaluateLearner(ours, ourStarts, physics)),
      stripFunctions(baseline.core.evaluateLearner(theirs, ourStarts, physics)),
    );
    assert.deepEqual(
      stripFunctions(current.core.evaluateLearner(ours)),
      stripFunctions(baseline.core.evaluateLearner(theirs)),
    );
  }
});
