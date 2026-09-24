import {
  World,
  Trainer,
  rollout,
  DEFAULT_REWARD,
  DEFAULT_PHYSICS,
  summarizeEvaluation,
} from '../core/engine.js';
import { loadJson } from '../core/content.js';

// Reinforcement-learning lab, maths only: one Experiment owns the settings a learner chose, the
// policy trained from them, the fixed test batch that follows and the log of earlier revisions.
// No DOM and no window here, so the whole file can be exercised from Node (test/rl-experiment.
// test.mjs). Learner-facing wording lives in content/rl/lab-experiment.json.

const copy = await loadJson('content/rl/lab-experiment.json');

const TEST_PLACES = 20; // start positions in one test batch
const CLEARED_ARRIVALS = 16; // arrivals out of TEST_PLACES needed to clear the mission
const CLEARED_CONTACTS = 2; // contacts still allowed while clearing it
const TRAINING_ITERATIONS = 160; // policy updates in one experiment
const EPISODES_PER_ITERATION = 25; // 24 drives comparing policies, plus one check drive
// Every experiment is the same length, so two settings can be compared run for run.
const TOTAL_EPISODES = TRAINING_ITERATIONS * EPISODES_PER_ITERATION;
const CHECKPOINT_AFTER = [79, 159]; // iteration indices whose policy is kept for replay
const CHECKPOINT_SEED = 100; // identical start for every checkpoint replay, so the three compare
const TRAINER_SEED = 42;

// The three trajectories shown side by side; also the `label` stored on each checkpoint.
const CHECKPOINT_LABELS = copy.checkpointLabels;
const REWARDS = copy.rewards;

const clone = (value) => structuredClone(value);

function initialConfig(task = 'delivery', course = 'standard') {
  return {
    task,
    course,
    startMode: 'near',
    rewards: clone(DEFAULT_REWARD),
    physics: { ...DEFAULT_PHYSICS, course },
  };
}

function newSeeds(count = TEST_PLACES) {
  return [...crypto.getRandomValues(new Uint32Array(count))];
}

function evaluate(config, weights, seed, { random = true } = {}) {
  return rollout(new World(config.task, config.rewards, config.physics), weights, seed, {
    other: random,
    capture: true,
  });
}

/** The rewards a training run with these settings uses, in the editor's order. */
function activeRewards(rewards, task) {
  return REWARDS.filter(
    (reward) => rewards.enabled[reward.key] && (!reward.dock || task === 'dock'),
  );
}

function resultName(result) {
  const names = copy.resultNames;
  if (result.success) return names.success;
  if (result.collision) return names.collision;
  if (result.emergency) return names.emergency;
  if (result.wrongAngle) return names.wrongAngle;
  return names.timeout;
}

function statistics(results) {
  const summary = summarizeEvaluation(results);
  const contacts = results.filter((result) => result.collision).length;
  return {
    ...summary,
    contacts,
    cleared:
      results.length === TEST_PLACES &&
      summary.successCount >= CLEARED_ARRIVALS &&
      contacts <= CLEARED_CONTACTS,
  };
}

// Sentence describing what the learner changed since the settings the previous run was trained
// with, so the results board can say what the comparison is about.
function describeChange(before, after) {
  const changes = [];
  if (before.startMode !== after.startMode)
    changes.push(
      copy.changes.startModePrefix +
        (after.startMode === 'varied' ? copy.changes.startModeVaried : copy.changes.startModeNear),
    );
  for (const reward of REWARDS) {
    const wasEnabled = before.rewards.enabled[reward.key];
    const isEnabled = after.rewards.enabled[reward.key];
    if (wasEnabled !== isEnabled)
      changes.push(reward.name + (isEnabled ? copy.changes.enable : copy.changes.disable));
    else if (isEnabled && before.rewards[reward.key] !== after.rewards[reward.key])
      changes.push(
        reward.name +
          '：' +
          before.rewards[reward.key] +
          copy.changes.valueArrow +
          after.rewards[reward.key],
      );
  }
  return changes.join(copy.changes.separator) || copy.changes.sameConditions;
}

// A run owns immutable settings and policy snapshots. Draft edits never change a replay.
class Experiment {
  constructor(task = 'delivery', course = 'standard') {
    this.draft = initialConfig(task, course);
    this.run = null;
    this.previous = null;
    this.records = [];
    this.revision = 1;
    this.change = copy.changes.initial;
    this.note = '';
    this.pendingRevision = false;
    this.reflection = { choice: '', note: '' };
  }

  prepareRevision(change, note = '') {
    if (this.run?.results.length === TEST_PLACES) this.previous = clone(this.run);
    this.change = change;
    this.note = note;
    if (!this.pendingRevision) this.revision++;
    this.pendingRevision = true;
  }

  async train(onProgress = () => {}, isCancelled = () => false) {
    if (this.run && !this.pendingRevision) this.prepareRevision(copy.changes.retrain);
    // The comparison is against the settings the learner last *tested*, not the last draft.
    if (this.run)
      this.change = describeChange(this.previous?.config || this.run.config, this.draft);
    const config = clone(this.draft);
    const trainer = new Trainer(config.task, config.rewards, config.physics, TRAINER_SEED, {
      startMode: config.startMode,
    });
    const checkpoints = [
      {
        label: CHECKPOINT_LABELS[0],
        episodes: 0,
        result: evaluate(config, trainer.weights, CHECKPOINT_SEED, { random: false }),
      },
    ];
    for (let iteration = 0; iteration < TRAINING_ITERATIONS; iteration++) {
      if (isCancelled()) return null;
      trainer.iteration();
      const checkpoint = CHECKPOINT_AFTER.indexOf(iteration);
      if (checkpoint >= 0)
        checkpoints.push({
          label: CHECKPOINT_LABELS[checkpoint + 1],
          episodes: trainer.episodes,
          result: evaluate(config, trainer.bestWeights, CHECKPOINT_SEED, { random: false }),
        });
      onProgress({
        episodes: trainer.episodes,
        iterations: trainer.iterations,
        history: clone(trainer.history),
        checkpoints,
      });
      // Yields to the browser so the progress bar and graph can paint between updates.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const run = {
      config,
      weights: trainer.bestWeights.slice(),
      episodes: trainer.episodes,
      history: clone(trainer.history),
      checkpoints,
      // A revision reuses the previous start positions, so the two runs can be compared directly.
      seeds: this.previous ? [...this.previous.seeds] : newSeeds(),
      results: [],
      revision: this.revision,
      change: this.change,
      note: this.note,
    };
    this.run = run;
    this.pendingRevision = false;
    this.reflection = { choice: '', note: '' };
    return run;
  }

  testOne(index) {
    const run = this.run;
    if (!run) throw new Error('Train before testing');
    const result = evaluate(run.config, run.weights, run.seeds[index]);
    run.results[index] = result;
    return result;
  }

  record() {
    if (this.run?.results.length !== TEST_PLACES) return;
    if (!this.records.some((record) => record.revision === this.run.revision))
      this.records.push(clone(this.run));
  }

  freshTest() {
    this.previous = null;
    this.run = { ...this.run, seeds: newSeeds(), results: [] };
  }
}

export {
  clone,
  initialConfig,
  newSeeds,
  evaluate,
  resultName,
  activeRewards,
  statistics,
  describeChange,
  Experiment,
  REWARDS,
  CHECKPOINT_LABELS,
  CLEARED_ARRIVALS,
  TEST_PLACES,
  TRAINING_ITERATIONS,
  TOTAL_EPISODES,
};
