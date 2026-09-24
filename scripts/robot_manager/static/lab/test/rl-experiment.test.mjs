// Run with: node --test test/*.test.mjs
//
// Pins the DOM-free part of the reinforcement-learning lab. Where the baseline copy of the site is
// available, the rewritten module is compared against it directly, so moving the reward table and
// the result names into content/rl/lab-experiment.json cannot have changed a single character.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clone,
  initialConfig,
  newSeeds,
  resultName,
  activeRewards,
  statistics,
  describeChange,
  Experiment,
  REWARDS,
  CHECKPOINT_LABELS,
  TEST_PLACES,
} from '../js/rl/experiment.js';

// The pre-refactor modules are kept in test/baseline/ (see its README), so this runs in CI too.
const BASELINE = new URL('./baseline/js/rl/experiment.js', import.meta.url).href;
const baseline = await import(BASELINE).catch(() => null);

const outcome = (over) => ({
  success: false,
  collision: false,
  emergency: false,
  wrongAngle: false,
  time: 10,
  reward: 0,
  commandRate: 20,
  ...over,
});
const batch = (arrivals, contacts) =>
  Array.from({ length: TEST_PLACES }, (unused, index) => {
    if (index < arrivals) return outcome({ success: true });
    return outcome({ collision: index < arrivals + contacts });
  });

test('the reward table is exactly the one the original shipped', { skip: !baseline }, () => {
  assert.deepEqual(REWARDS, baseline.REWARDS);
});

test('only the docking mission adds its own reward', () => {
  const dockOnly = REWARDS.filter((reward) => reward.dock).map((reward) => reward.key);
  assert.deepEqual(dockOnly, ['heading']);
  for (const reward of REWARDS) {
    assert.ok(reward.max > 0 && reward.step > 0, `${reward.key} needs a usable range`);
    assert.ok(['＋', '−'].includes(reward.sign), `${reward.key} needs a sign`);
  }
});

test('a result is named after its first matching outcome', () => {
  const names = [
    [outcome({ success: true }), '到着'],
    [outcome({ collision: true }), '接触'],
    [outcome({ emergency: true }), '衝撃で停止'],
    [outcome({ wrongAngle: true }), '向きが合わない'],
    [outcome({}), '時間切れ'],
  ];
  for (const [result, name] of names) assert.equal(resultName(result), name);
  // Arrival wins over every other flag, so a success is never reported as a contact.
  assert.equal(resultName(outcome({ success: true, collision: true })), '到着');
});

test('result names match the original', { skip: !baseline }, () => {
  const cases = [
    outcome({ success: true }),
    outcome({ collision: true }),
    outcome({ emergency: true }),
    outcome({ wrongAngle: true }),
    outcome({}),
    outcome({ collision: true, emergency: true }),
  ];
  for (const result of cases) assert.equal(resultName(result), baseline.resultName(result));
});

test('the mission is cleared with 16 arrivals and at most 2 contacts', () => {
  assert.equal(statistics(batch(16, 2)).cleared, true);
  assert.equal(statistics(batch(15, 2)).cleared, false);
  assert.equal(statistics(batch(16, 3)).cleared, false);
  assert.equal(statistics(batch(20, 0)).cleared, true);
  // A partial batch is never "cleared", however well it started.
  assert.equal(statistics(batch(20, 0).slice(0, 19)).cleared, false);
});

test('statistics count contacts and arrivals like the original', { skip: !baseline }, () => {
  for (const [arrivals, contacts] of [
    [16, 2],
    [15, 5],
    [20, 0],
    [0, 20],
  ])
    assert.deepEqual(
      statistics(batch(arrivals, contacts)),
      baseline.statistics(batch(arrivals, contacts)),
    );
});

test('the default settings start near, with the chosen course in the physics', () => {
  const config = initialConfig('dock', 'turns');
  assert.equal(config.task, 'dock');
  assert.equal(config.course, 'turns');
  assert.equal(config.startMode, 'near');
  assert.equal(config.physics.course, 'turns');
});

test('a change is described reward by reward', () => {
  const before = initialConfig();
  const after = clone(before);
  assert.equal(describeChange(before, after), '同じ条件で最初から再学習');

  after.startMode = 'varied';
  assert.equal(describeChange(before, after), '学習の開始位置を広げる');

  after.rewards.enabled.clearance = !before.rewards.enabled.clearance;
  const enabling = before.rewards.enabled.clearance ? 'を無効にする' : 'を有効にする';
  assert.equal(
    describeChange(before, after),
    '学習の開始位置を広げる / 障害物に近づきすぎる' + enabling,
  );

  const valued = clone(before);
  valued.rewards.progress = before.rewards.progress + 5;
  assert.equal(
    describeChange(before, valued),
    `目標へ近づく：${before.rewards.progress} → ${valued.rewards.progress}`,
  );
});

test('a disabled reward hides its value change', () => {
  const before = initialConfig();
  before.rewards.enabled.moving = false;
  const after = clone(before);
  after.rewards.moving = before.rewards.moving + 3;
  assert.equal(describeChange(before, after), '同じ条件で最初から再学習');
});

test('seeds are a full batch of distinct start conditions', () => {
  const seeds = newSeeds();
  assert.equal(seeds.length, TEST_PLACES);
  assert.equal(new Set(seeds).size, TEST_PLACES);
  assert.equal(newSeeds(3).length, 3);
});

test('a revision keeps the run it is compared against', () => {
  const experiment = new Experiment();
  assert.equal(experiment.change, '最初の設定');
  assert.equal(experiment.revision, 1);

  experiment.run = { config: initialConfig(), results: batch(16, 2), seeds: newSeeds() };
  experiment.prepareRevision('時間の減点：1点/秒', '早くなるはず');
  assert.equal(experiment.revision, 2);
  assert.equal(experiment.note, '早くなるはず');
  assert.deepEqual(experiment.previous.results, experiment.run.results);

  // Preparing twice before training counts as one revision, not two.
  experiment.prepareRevision('報酬を自分で調整');
  assert.equal(experiment.revision, 2);
  assert.equal(experiment.note, '');
});

test('an unfinished batch is not worth keeping as a revision', () => {
  const experiment = new Experiment();
  experiment.run = {
    config: initialConfig(),
    results: batch(16, 2).slice(0, 5),
    seeds: newSeeds(),
  };
  experiment.prepareRevision('時間の減点：1点/秒');
  assert.equal(experiment.previous, null);
});

test('a finished experiment is logged once', () => {
  const experiment = new Experiment();
  experiment.run = {
    revision: 3,
    config: initialConfig(),
    results: batch(18, 1),
    seeds: newSeeds(),
  };
  experiment.record();
  experiment.record();
  assert.equal(experiment.records.length, 1);
  assert.equal(experiment.records[0].revision, 3);
});

test('a fresh test batch drops the comparison and every earlier result', () => {
  const experiment = new Experiment();
  const seeds = newSeeds();
  experiment.run = { config: initialConfig(), results: batch(18, 1), seeds };
  experiment.previous = clone(experiment.run);
  experiment.freshTest();
  assert.equal(experiment.previous, null);
  assert.deepEqual(experiment.run.results, []);
  assert.notDeepEqual(experiment.run.seeds, seeds);
});

test('testing before training is refused', () => {
  assert.throws(() => new Experiment().testOne(0), /Train before testing/);
});

test('the three trajectories are labelled before, midway and after', () => {
  assert.deepEqual(CHECKPOINT_LABELS, ['学習前', '途中', '学習後']);
});

test('the reward summary lists every reward the next training uses, and only those', () => {
  const config = initialConfig('delivery');
  const names = activeRewards(config.rewards, 'delivery').map((reward) => reward.key);
  assert.deepEqual(names, ['success', 'progress', 'collision', 'time', 'careful', 'settling']);
  // The docking heading reward is on by default but only exists in the docking mission.
  assert.ok(activeRewards(config.rewards, 'dock').some((reward) => reward.key === 'heading'));
  config.rewards.enabled.time = false;
  config.rewards.enabled.clearance = true;
  const changed = activeRewards(config.rewards, 'delivery').map((reward) => reward.key);
  assert.ok(!changed.includes('time'));
  assert.ok(changed.includes('clearance'));
});
