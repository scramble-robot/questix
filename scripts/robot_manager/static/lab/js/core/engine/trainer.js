// Evolutionary trainer (augmented random search with elite directions) for the linear policy.
// Random draws come from the trainer's own generator; episodes use fixed seeds so the
// learning curve is repeatable for a given trainer seed.
import { clamp, randomGenerator, gaussian } from './maths.js';
import { PARAMETERS } from './constants.js';
import { World } from './world.js';
import { rollout, summarizeEvaluation } from './policy.js';

const DIRECTIONS_PER_ITERATION = 12; // perturbation directions sampled per iteration
const ELITE_DIRECTIONS = 6; // best directions used for the update
const EXPLORATION_NOISE = 0.15; // weight perturbation scale
const LEARNING_RATE = 0.065;
const WEIGHT_LIMIT = 8;
const MIN_RETURN_SPREAD = 1; // reward units; keeps the normalised step bounded
const VALIDATION_INTERVAL = 5; // iterations
const VALIDATION_EPISODES = 5;
const VALIDATION_SEED = 100;
const VALIDATION_SEED_STRIDE = 137;
const EVALUATION_SEED = 90001;
const EVALUATION_SEED_STRIDE = 811;
// Near starts cycle through five fixed episodes; varied starts get a fresh seed per rollout.
const NEAR_SEED = 500;
const NEAR_SEED_CYCLE = 5;
const NEAR_SEED_STRIDE = 997;
const VARIED_SEED = 5000;
// The varied start range widens from 0.2 to the whole room over 100 iterations.
const VARIED_RANGE_START = 0.2;
const VARIED_RANGE_PER_ITERATION = 0.008;

function trainingSeed(varied, iterations, direction) {
  if (varied) return VARIED_SEED + iterations * DIRECTIONS_PER_ITERATION + direction;
  return NEAR_SEED + (iterations % NEAR_SEED_CYCLE) * NEAR_SEED_STRIDE;
}

function countOutcome(batch, result) {
  batch.count++;
  batch.rewardSum += result.totalReward;
  if (result.success) batch.success++;
  else if (result.collision) batch.collision++;
  else batch.unreached++;
}

function standardDeviation(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

class Trainer {
  constructor(task, rewards, physics, seed = 42, { startMode = 'near' } = {}) {
    this.world = new World(task, rewards, physics);
    this.weights = new Float64Array(PARAMETERS);
    this.rng = randomGenerator(seed);
    this.iterations = 0;
    this.episodes = 0;
    this.history = [];
    this.bestScore = -Infinity;
    this.bestWeights = this.weights.slice();
    this.startMode = startMode;
    this.phaseStartIterations = 0;
    this.historyStartEpisodes = 0;
  }

  /** Switching between 'near' and 'varied' starts a new phase from the best weights so far. */
  setStartMode(next) {
    if (next === this.startMode) return;
    this.startMode = next;
    this.weights = this.bestWeights.slice();
    this.bestScore = -Infinity;
    this.history = [];
    this.historyStartEpisodes = this.episodes;
    this.phaseStartIterations = this.iterations;
  }

  get startRange() {
    if (this.startMode !== 'varied') return 0;
    const phaseIterations = this.iterations - this.phaseStartIterations;
    return Math.min(1, VARIED_RANGE_START + phaseIterations * VARIED_RANGE_PER_ITERATION);
  }

  /** One update: sample directions, roll out ±perturbations, step along the elite ones. */
  iteration() {
    const varied = this.startMode === 'varied';
    const startRange = this.startRange;
    const batch = { count: 0, success: 0, collision: 0, unreached: 0, rewardSum: 0 };
    const directions = [];
    for (let n = 0; n < DIRECTIONS_PER_ITERATION; n++) {
      const seed = trainingSeed(varied, this.iterations, n);
      const delta = Float64Array.from({ length: PARAMETERS }, () => gaussian(this.rng));
      const plus = this.weights.map((weight, i) => weight + EXPLORATION_NOISE * delta[i]);
      const minus = this.weights.map((weight, i) => weight - EXPLORATION_NOISE * delta[i]);
      const positive = rollout(this.world, plus, seed, { startRange });
      const negative = rollout(this.world, minus, seed, { startRange });
      countOutcome(batch, positive);
      countOutcome(batch, negative);
      directions.push({ delta, rp: positive.score, rm: negative.score });
      this.episodes += 2;
    }
    this.lastBatch = { ...batch, meanReward: batch.rewardSum / batch.count };
    this.applyUpdate(directions);
    this.iterations++;
    if (this.iterations % VALIDATION_INTERVAL === 0) this.validate(varied);
    return {
      iterations: this.iterations,
      episodes: this.episodes,
      rate: this.history.at(-1)?.rate ?? 0,
    };
  }

  /** Moves the weights along the elite directions, normalised by the spread of their returns. */
  applyUpdate(directions) {
    directions.sort((a, b) => Math.max(b.rp, b.rm) - Math.max(a.rp, a.rm));
    const elite = directions.slice(0, ELITE_DIRECTIONS);
    const returns = elite.flatMap((direction) => [direction.rp, direction.rm]);
    const spread = Math.max(MIN_RETURN_SPREAD, standardDeviation(returns));
    const stepSize = LEARNING_RATE / (ELITE_DIRECTIONS * spread);
    for (let i = 0; i < PARAMETERS; i++) {
      let update = 0;
      for (const direction of elite) update += (direction.rp - direction.rm) * direction.delta[i];
      this.weights[i] = clamp(this.weights[i] + stepSize * update, -WEIGHT_LIMIT, WEIGHT_LIMIT);
    }
  }

  /** Scores the current weights on fixed validation seeds and keeps the best so far. */
  validate(varied) {
    let score = 0;
    const validation = [];
    for (let j = 0; j < VALIDATION_EPISODES; j++) {
      const seed = VALIDATION_SEED + j * VALIDATION_SEED_STRIDE;
      const result = rollout(this.world, this.weights, seed, { other: varied });
      score += result.score;
      validation.push(result);
      this.episodes++;
    }
    score /= VALIDATION_EPISODES;
    if (score > this.bestScore) {
      this.bestScore = score;
      this.bestWeights = this.weights.slice();
    }
    this.history.push({
      episodes: this.episodes,
      score,
      startMode: this.startMode,
      ...summarizeEvaluation(validation),
    });
  }

  evaluate({ other = false, count = 20, weights = this.bestWeights } = {}) {
    const results = [];
    for (let i = 0; i < count; i++) {
      const seed = EVALUATION_SEED + i * EVALUATION_SEED_STRIDE;
      results.push(rollout(this.world, weights, seed, { other }));
    }
    const successes = results.filter((result) => result.success).length;
    return { rate: (successes / count) * 100, results };
  }
}

export { Trainer };
