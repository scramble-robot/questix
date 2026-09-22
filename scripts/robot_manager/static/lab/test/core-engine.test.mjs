// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// The refactored js/core/engine.js must be numerically identical to the pre-refactor module:
// its floating-point results feed canvas pixels and learning curves that the UI regression
// harness hashes. Every scenario below runs the same seeded sequence through both modules and
// asserts deep equality (typed arrays, NaN and -0 included). The baseline copy is optional so
// the suite still pins behaviour when only the working copy is available.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as candidate from '../js/core/engine.js';

const BASELINE_PATH = '/home/asahi/.cache/questix-lab-cleanup/base/js/core/engine.js';
const baseline = fs.existsSync(BASELINE_PATH) ? await import(BASELINE_PATH) : null;
const TASKS = ['delivery', 'dock'];
const COURSE_NAMES = ['standard', 'open', 'turns'];

function scriptedCommand(step) {
  // A deterministic open-loop drive that turns, reverses and hits walls on every course.
  const phase = Math.floor(step / 40) % 4;
  if (phase === 0) return [0.9, 0.9];
  if (phase === 1) return [0.6, -0.4];
  if (phase === 2) return [-0.7, -0.7];
  return [0.2, 0.95];
}

function driveScenario(engine, task, course, seed, resetOptions = {}) {
  const rewards = { enabled: { clearance: true, moving: true, near: true } };
  const world = new engine.World(task, rewards, { course });
  const log = [];
  log.push(structuredClone(world.reset(seed, resetOptions)));
  log.push(structuredClone(world.observation));
  log.push(structuredClone(world.actual));
  log.push(world.gyroBias);
  for (let step = 0; step < 200; step++) {
    const result = world.step(scriptedCommand(step), { capture: step % 3 === 0 });
    log.push(structuredClone(result));
    log.push(structuredClone(world.observation));
    if (result.done) break;
  }
  log.push(structuredClone(world.snapshot()));
  log.push(world.rng());
  return log;
}

function policyScenario(engine, task, course, options) {
  const world = new engine.World(task, {}, { course, noise: 0.02 });
  const rng = engine.randomGenerator(7);
  const weights = Float64Array.from({ length: engine.PARAMETERS }, () => engine.gaussian(rng));
  const result = engine.rollout(world, weights, 33, options);
  return {
    result: structuredClone(result),
    state: structuredClone(world.state),
    observation: structuredClone(world.observation),
    nextRandom: world.rng(),
  };
}

function trainerScenario(engine, task, startMode) {
  const trainer = new engine.Trainer(task, {}, { course: 'turns' }, 11, { startMode });
  const outputs = [];
  for (let i = 0; i < 6; i++) outputs.push(structuredClone(trainer.iteration()));
  outputs.push(structuredClone(trainer.lastBatch));
  outputs.push(trainer.startRange);
  trainer.setStartMode(startMode === 'near' ? 'varied' : 'near');
  outputs.push(structuredClone(trainer.iteration()));
  outputs.push(trainer.startRange);
  outputs.push(structuredClone(trainer.evaluate({ count: 3, other: true })));
  outputs.push(structuredClone(trainer.evaluate({ count: 2, weights: trainer.weights })));
  outputs.push(Array.from(trainer.weights));
  outputs.push(Array.from(trainer.bestWeights));
  outputs.push(trainer.bestScore);
  outputs.push(structuredClone(trainer.history));
  outputs.push([
    trainer.iterations,
    trainer.episodes,
    trainer.phaseStartIterations,
    trainer.historyStartEpisodes,
    trainer.startMode,
  ]);
  outputs.push(trainer.rng());
  return outputs;
}

function compareWithBaseline(name, scenario) {
  test(name, { skip: baseline ? false : 'baseline module not available' }, () => {
    assert.deepEqual(scenario(candidate), scenario(baseline));
  });
}

test('exports the same names as the baseline', { skip: !baseline }, () => {
  assert.deepEqual(Object.keys(candidate).sort(), Object.keys(baseline).sort());
  assert.deepEqual(candidate.DEFAULT_PHYSICS, baseline.DEFAULT_PHYSICS);
  assert.deepEqual(candidate.DEFAULT_REWARD, baseline.DEFAULT_REWARD);
  assert.deepEqual(candidate.FEATURE_NAMES, baseline.FEATURE_NAMES);
  assert.deepEqual(candidate.COURSES, baseline.COURSES);
  assert.equal(candidate.CONTROL_DT, baseline.CONTROL_DT);
  assert.equal(candidate.PHYSICS_DT, baseline.PHYSICS_DT);
  assert.equal(candidate.SCAN_COUNT, baseline.SCAN_COUNT);
  assert.equal(candidate.FEATURES, baseline.FEATURES);
  assert.equal(candidate.PARAMETERS, baseline.PARAMETERS);
});

compareWithBaseline('helpers: clamp, wrap, rpm conversions, random generator, gaussian', (e) => {
  const rng = e.randomGenerator(5);
  const defaultRng = e.randomGenerator();
  return [
    [e.clamp(2), e.clamp(-2), e.clamp(0.3), e.clamp(5, 0, 3), e.clamp(-1, 0, 3)],
    [e.wrap(4), e.wrap(-4), e.wrap(Math.PI), e.wrap(0)],
    [e.rpmToSpeed(80, 0.065), e.speedToRpm(0.5, 0.065)],
    Array.from({ length: 20 }, () => rng()),
    Array.from({ length: 5 }, () => defaultRng()),
    Array.from({ length: 10 }, () => e.gaussian(rng)),
  ];
});

for (const task of TASKS)
  for (const course of COURSE_NAMES) {
    compareWithBaseline(`World reset/step sequence: ${task} on ${course}`, (e) =>
      driveScenario(e, task, course, 3),
    );
    compareWithBaseline(`World reset/step with varied start: ${task} on ${course}`, (e) =>
      driveScenario(e, task, course, 8, { startRange: 0.6 }),
    );
  }

compareWithBaseline('World reset options: other, initial pose, no randomisation', (e) => [
  driveScenario(e, 'delivery', 'standard', 4, { other: true }),
  driveScenario(e, 'dock', 'turns', 4, { other: true, startRange: 0.3 }),
  driveScenario(e, 'delivery', 'open', 4, { initial: { x: 1.2, y: 1.1, theta: 0.4 } }),
  driveScenario(e, 'dock', 'standard', 4, { randomize: false }),
  driveScenario(e, 'delivery', 'standard', 4, {
    other: true,
    initial: { x: 0.6, y: 2.5, theta: -0.1 },
  }),
]);

compareWithBaseline('World with an unknown course falls back to standard', (e) => {
  const world = new e.World('delivery', {}, { course: 'nowhere' });
  return [world.course, world.walls, world.rects, world.rayRects, world.width, world.height];
});

compareWithBaseline('World reward settings and disabled terms', (e) => {
  const rewards = {
    progress: 40,
    orientation: false,
    threshold: 200,
    enabled: { time: false, careful: false, heading: false, settling: false },
  };
  const world = new e.World('dock', rewards, { course: 'standard', noise: 0 });
  const log = [structuredClone(world.settings)];
  world.reset(2);
  for (let step = 0; step < 120; step++) {
    const result = world.step([0.5, 0.5]);
    log.push(structuredClone(result));
    if (result.done) break;
  }
  return log;
});

compareWithBaseline('World.step after done or emergency returns the idle result', (e) => {
  const world = new e.World('delivery', { threshold: 0.001 }, { course: 'open' });
  world.reset(9);
  const first = structuredClone(world.step([1, 1], { capture: true }));
  const second = structuredClone(world.step([1, 1], { capture: true }));
  world.reset(9);
  world.state.done = true;
  const third = structuredClone(world.step([0.2, 0.2]));
  return [first, second, third];
});

compareWithBaseline('World.observe without a fresh flag fuses the marker measurement', (e) => {
  const world = new e.World('dock', {}, { course: 'standard' });
  world.reset(12, { initial: { x: 3.0, y: 1.6, theta: 0 } });
  const log = [structuredClone(world.observation)];
  world.state.estX += 0.2;
  world.state.estTheta += 0.1;
  log.push(structuredClone(world.observe()));
  log.push(structuredClone(world.observe(true)));
  log.push(structuredClone(world.state));
  return log;
});

compareWithBaseline('World geometry queries: ray, blocked, startBounds, randomStart', (e) => {
  const out = [];
  for (const task of TASKS)
    for (const course of COURSE_NAMES) {
      const world = new e.World(task, {}, { course });
      for (const [x, y, angle] of [
        [0.6, 2.5, 0],
        [0.6, 2.5, Math.PI / 2],
        [2, 1.6, -Math.PI / 2],
        [2, 1.6, Math.PI],
        [1.2, 0.9, 0.3],
        [4.5, 3.0, 2.2],
      ])
        out.push([world.ray(x, y, angle), world.ray(x, y, angle, 1.0), world.ray(x, y, angle, 6)]);
      for (const [x, y] of [
        [0.1, 0.1],
        [1.5, 1.0],
        [1.55, 1.0],
        [2.4, 1.6],
        [4.7, 1.6],
      ])
        out.push([world.blocked(x, y), world.blocked(x, y, 0.12), world.blocked(x, y, 0.5)]);
      for (const range of [0, 0.25, 0.5, 1, 2, -1]) out.push(world.startBounds(range));
      const rng = e.randomGenerator(77);
      out.push(world.randomStart(rng, 1), world.randomStart(rng, 0.4), world.randomStart(rng, 0));
      out.push(rng());
    }
  return out;
});

compareWithBaseline('features() and act() on a sequence of observations', (e) => {
  const out = [];
  const rng = e.randomGenerator(21);
  const weights = Float64Array.from({ length: e.PARAMETERS }, () => e.gaussian(rng) * 2);
  for (const task of TASKS) {
    const world = new e.World(task, {}, { course: 'turns' });
    world.reset(6, { other: true });
    for (let step = 0; step < 60; step++) {
      out.push(e.features(world.observation));
      const command = e.act(weights, world.observation);
      out.push(command);
      if (world.step(command).done) break;
    }
  }
  return out;
});

for (const task of TASKS) {
  compareWithBaseline(`rollout(): ${task}, default options`, (e) =>
    policyScenario(e, task, 'standard', undefined),
  );
  compareWithBaseline(`rollout(): ${task}, capture with varied start`, (e) =>
    policyScenario(e, task, 'turns', { capture: true, startRange: 0.5 }),
  );
  compareWithBaseline(`rollout(): ${task}, other start, no randomisation`, (e) =>
    policyScenario(e, task, 'open', { other: true, randomize: false, capture: true }),
  );
  compareWithBaseline(`rollout(): ${task}, initial pose`, (e) =>
    policyScenario(e, task, 'standard', { initial: { x: 2.0, y: 1.2, theta: 0.2 } }),
  );
}

compareWithBaseline('summarizeEvaluation()', (e) => {
  const results = [
    { success: true, time: 12.5, commandRate: 30 },
    { success: false, time: 35, commandRate: 80 },
    { success: true, time: 9, commandRate: 12.25 },
  ];
  return [
    e.summarizeEvaluation(results),
    e.summarizeEvaluation([]),
    e.summarizeEvaluation(results.filter((r) => !r.success)),
  ];
});

for (const task of TASKS)
  for (const startMode of ['near', 'varied'])
    compareWithBaseline(`Trainer run: ${task}, start mode ${startMode}`, (e) =>
      trainerScenario(e, task, startMode),
    );

test('Trainer defaults and start-range schedule', { skip: !baseline }, () => {
  for (const e of [candidate, baseline]) {
    const trainer = new e.Trainer('delivery');
    assert.equal(trainer.startMode, 'near');
    assert.equal(trainer.startRange, 0);
    assert.equal(trainer.weights.length, e.PARAMETERS);
    assert.equal(trainer.bestScore, -Infinity);
    trainer.setStartMode('near');
    assert.equal(trainer.history, trainer.history);
  }
  const summary = trainerScenario(candidate, 'delivery', 'near');
  assert.deepEqual(summary, trainerScenario(baseline, 'delivery', 'near'));
});
