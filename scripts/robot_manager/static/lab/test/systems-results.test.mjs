// What the result cards and figures of the "systems" courses derive from a run (js/systems/core.js):
// metrics limited to what a topic is about, closing sentences that use the run's numbers, the
// one-line comparison with the previous run, grouped events, the stop cause the learner has to
// recognise, and the geometry the crossing rules are drawn with. Run with
// `node --test test/*.test.mjs`.

import assert from 'node:assert/strict';
import { test } from 'node:test';

const core = await import('../js/systems/core.js');
const { simulateSystem, compareRuns, groupEvents, stopCause, crossingForecast } = core;

const labels = (run) => run.metrics.map((metric) => metric.label);

test('every topic keeps the same metric set from run to run (the history table relies on it)', () => {
  const variations = {
    'tracking/crossing': [{ rule: 'current' }, { rule: 'predict' }],
    'coordination/feedback': [{ lookAgain: 'once' }, { lookAgain: 'repeat' }],
    'timing/delay': [{ latency: 0.6 }, { latency: 0 }],
    'mechanics/braking': [{ brakeAt: 0.2 }, { brakeAt: 1.5 }],
  };
  for (const [key, inputs] of Object.entries(variations)) {
    const [course, topic] = key.split('/');
    const sets = inputs.map((input) => labels(simulateSystem(course, topic, input)));
    assert.deepEqual(sets[0], sets[1], key);
  }
});

test('mechanics shows only the numbers its topic is about', () => {
  const force = simulateSystem('mechanics', 'force', {});
  assert.equal(force.metrics.length, 2);
  assert.ok(!labels(force).some((label) => label.includes('車輪')), 'no wheel odometry on force');
  const braking = simulateSystem('mechanics', 'braking', {});
  assert.match(labels(braking)[2], /ブレーキ開始から停止まで/);
  const brake = braking.events.find((event) => event.kind === 'brake');
  assert.ok(Math.abs(braking.metrics[2].value - (braking.duration - brake.t)) < 1e-9);
});

test('the braking sentence gives the overshoot and a brake distance that works', () => {
  const over = simulateSystem('mechanics', 'braking', {});
  const remaining = over.metrics[0].value;
  assert.ok(remaining < 0);
  assert.match(over.outcome, new RegExp(`線を${Math.round(-remaining * 100)} cm越えました`));
  const advice = Number(over.outcome.match(/約([\d.]+) m手前/)[1]);
  const retry = simulateSystem('mechanics', 'braking', { brakeAt: advice });
  assert.equal(retry.success, true, 'following the advice stops within 20 cm of the line');
});

test('compareRuns states F = ma and v² relations with the measured numbers', () => {
  const light = simulateSystem('mechanics', 'force', { mass: 4 });
  const heavy = simulateSystem('mechanics', 'force', { mass: 8 });
  assert.equal(
    compareRuns(heavy, light),
    '質量を4→8 kgにすると、動き始めの加速度は2.00→1.00 m/秒²（0.50倍）になりました。',
  );
  const fast = simulateSystem('mechanics', 'braking', { initialSpeed: 1.2 });
  const slow = simulateSystem('mechanics', 'braking', { initialSpeed: 0.6 });
  assert.match(compareRuns(slow, fast), /（0\.50倍）.*（0\.25倍）/);
  const twoChanges = simulateSystem('mechanics', 'force', { mass: 8, power: 100 });
  assert.equal(compareRuns(twoChanges, light), '', 'nothing to say when two settings changed');
  assert.equal(compareRuns(light, null), '');
  assert.equal(
    compareRuns(simulateSystem('timing', 'delay', {}), simulateSystem('timing', 'delay', {})),
    '',
  );
});

test('the crossing results report where waiting started', () => {
  const predicted = simulateSystem('tracking', 'crossing', { rule: 'predict' });
  const waitStart = predicted.samples.find((sample) => sample.status === '相手を待つ');
  assert.equal(predicted.metrics[1].value, waitStart.separation);
  const current = simulateSystem('tracking', 'crossing', { rule: 'current' });
  assert.equal(current.metrics[1].value, '待たなかった');
  assert.match(current.outcome, /待つ円/);
});

test('crossingForecast predicts the closest approach within the horizon', () => {
  const run = simulateSystem('tracking', 'crossing', { rule: 'predict', horizon: 2 });
  for (const sample of run.samples.filter((entry) => entry.velocity !== null)) {
    const view = crossingForecast(sample, run.config);
    assert.ok(view.forecast.after >= 0 && view.forecast.after <= 2);
    assert.ok(view.forecast.gap >= 0);
    assert.equal(view.forecast.self.y, sample.y, 'QUESTiX keeps its lane');
    assert.ok(view.forecast.self.x >= sample.x, 'and only moves forward');
    assert.equal(view.current.clearance, 0.47);
    assert.equal(view.forecast.clearance, 0.7);
  }
});

test('coordination: one distance metric, a target-move event and per-topic sentences', () => {
  const raw = simulateSystem('coordination', 'frames', { transform: false });
  assert.deepEqual(labels(raw), ['最後の手先と物体の距離']);
  assert.match(raw.outcome, /そのまま「根元からの位置」/);
  const fixed = simulateSystem('coordination', 'frames', { transform: true });
  assert.match(fixed.outcome, /重なり/);
  const feedback = simulateSystem('coordination', 'feedback', { lookAgain: 'repeat' });
  const move = feedback.events.find((event) => event.kind === 'target-move');
  assert.equal(move.t, 2);
  assert.equal(feedback.metrics[1].value, feedback.events.filter((event) => !event.kind).length);
  const once = simulateSystem('coordination', 'feedback', { lookAgain: 'once' });
  assert.notEqual(once.outcome, feedback.outcome);
});

test('groupEvents folds repeats and keeps the rare event between them', () => {
  const run = simulateSystem('coordination', 'feedback', { lookAgain: 'repeat', interval: 0.3 });
  const groups = groupEvents(run.events);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].count, 7);
  assert.ok(Math.abs(groups[0].every - 0.3) < 1e-9);
  assert.equal(groups[1].kind, 'target-move');
  assert.equal(groups[1].count, 1);
  assert.equal(groups[1].every, null);
  assert.equal(
    groups.reduce((sum, group) => sum + group.count, 0),
    run.events.length,
  );
  assert.deepEqual(groupEvents([]), []);
});

test('behaviour sentences are per topic', () => {
  const outcomes = [
    simulateSystem('behavior', 'sequence', { obstacle: 'none' }),
    simulateSystem('behavior', 'sequence', { obstacle: 'permanent' }),
    simulateSystem('behavior', 'blocked', { obstacle: 'permanent', blockedRule: 'detour' }),
    simulateSystem('behavior', 'missing', { searchRule: 'search' }),
    simulateSystem('behavior', 'missing', { searchRule: 'ignore' }),
  ].map((run) => run.outcome);
  assert.equal(new Set(outcomes).size, outcomes.length);
  assert.match(outcomes[1], /制限時間（16秒）/);
  assert.match(outcomes[3], /別の場所を探し/);
});

test('stopCause names the kind of cause and the recorded numbers', () => {
  const bump = simulateSystem('diagnostics', 'impact', { eventType: 'bump', impactLimit: 4 });
  assert.equal(stopCause(bump).id, 'bump');
  assert.match(stopCause(bump).sentence, /5\.2 m\/秒².*4\.0 m\/秒²/);
  const impact = simulateSystem('diagnostics', 'impact', { eventType: 'impact', impactLimit: 8 });
  assert.equal(stopCause(impact).id, 'impact');
  const passed = simulateSystem('diagnostics', 'impact', { eventType: 'bump', impactLimit: 8 });
  assert.equal(stopCause(passed), null, 'nothing latched');
  const stale = simulateSystem('diagnostics', 'missing', { watchdog: true, staleLimit: 0.4 });
  assert.equal(stopCause(stale).id, 'stale');
  const near = simulateSystem('diagnostics', 'distance', { sensorRule: 'both', stopDistance: 0.6 });
  assert.equal(stopCause(near).id, 'near');
  assert.equal(stopCause(simulateSystem('timing', 'delay', {})), null);
});
