import { IntroLearner, introRandom, introRollout, introStep, introDistance } from './intro.js';

// Maths of the foundation chapters: the one-step experience, the destination bandit, the
// delayed-reward learner and the fixed evaluation set. No DOM; importable from Node.

const ACTION_LABELS = ['前に進む', '左へ回る', '右へ回る'];
const INTRO_START = { x: 0.8, y: 1.5, theta: -Math.PI / 2 }; // metres, radians
const GOAL = { x: 3.9, y: 1.5 }; // metres, same goal as intro.js
const WHEEL_RADIUS = 0.065; // metres
const SECONDS_PER_MINUTE = 60;

// Destination bandit (chapter "explore"): A always pays 1, B pays 4 with probability 0.75 and
// otherwise 0, C always pays 2. The learner never sees these rules, only the rewards.
const DESTINATIONS = 3;
const REWARD_A = 1;
const REWARD_B = 4;
const REWARD_B_PROBABILITY = 0.75;
const REWARD_C = 2;

// Delayed-reward job (chapter "future"): state 0 chooses between the quick job (1 point, done)
// and the delivery; states 1 and 2 are the delivery segments, the last one pays 8.
const QUICK_JOB_REWARD = 1;
const DELIVERY_REWARD = 8;
const DELIVERY_STATES = 3;
const FUTURE_LEARNING_RATE = 0.4;
const FUTURE_EXPLORATION = 0.35;

const EVALUATION_RUNS = 20;
const EVALUATION_MIN_DISTANCE = 0.7; // metres: starts closer to the goal than this are skipped
const EVALUATION_START = { x: 0.4, y: 0.4, width: 3.9, height: 2.2 }; // metres
const EVALUATION_SEED = 90321;
const EVALUATION_RUN_SEED = 1000;
const TRAINING_SEED = 71;

const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
const bestIndex = (values) => values.indexOf(Math.max(...values));

// One learner step with the value row recorded before and after, for the one-step experiment.
// Intro coordinates have screen y down; a faster right wheel turns counterclockwise.
function experienceStep(model, pose, action) {
  const before = [...model.q[model.state(pose)]];
  const outcome = introStep(pose, action, model.rule);
  const change = model.update(pose, action, outcome);
  return {
    from: { ...pose },
    action,
    before,
    after: [...model.q[model.state(pose)]],
    ...outcome,
    change,
  };
}

const wheelRpm = (metresPerSecond) =>
  (metresPerSecond / (2 * Math.PI * WHEEL_RADIUS)) * SECONDS_PER_MINUTE;

// What the robot observes: goal distance, goal bearing from the heading, and wheel speeds.
function robotReading(pose) {
  const goalDirection = Math.atan2(GOAL.y - pose.y, GOAL.x - pose.x);
  return {
    distance: introDistance(pose),
    bearing: wrapAngle(goalDirection - pose.theta),
    rpm: [pose.left || 0, pose.right || 0].map(wheelRpm),
  };
}

// One-step bandit: each delivery ends immediately. Unknown options start with value zero.
class RouteLearner {
  constructor(seed = 37) {
    this.rng = introRandom(seed);
    this.outcomeRng = introRandom(seed + 400);
    this.values = Array(DESTINATIONS).fill(0); // mean reward so far per destination
    this.counts = Array(DESTINATIONS).fill(0);
    this.history = [];
  }

  reward(action) {
    if (action === 0) return REWARD_A;
    if (action === 1) return this.outcomeRng() < REWARD_B_PROBABILITY ? REWARD_B : 0;
    return REWARD_C;
  }

  step(epsilon = 0.3) {
    const exploring = this.rng() < epsilon;
    const action = exploring ? Math.floor(this.rng() * DESTINATIONS) : bestIndex(this.values);
    const reward = this.reward(action);
    const before = this.values[action];
    this.counts[action]++;
    this.values[action] += (reward - before) / this.counts[action];
    const event = { action, reward, exploring, before, after: this.values[action] };
    this.history.push(event);
    return event;
  }
}

// Three decision states with delivery segments as macro actions; no supplied action values.
class FutureLearner {
  constructor(gamma = 0.9, seed = 53) {
    this.gamma = gamma; // 0 learns from the immediate reward only
    this.rng = introRandom(seed);
    this.q = [[0, 0], [0], [0]]; // state 0: [quick job, delivery]; states 1, 2: [continue]
    this.episodes = 0;
    this.last = []; // updates of the most recent episode
  }

  chooseAction(row) {
    if (row.length === 1) return 0;
    if (this.rng() < FUTURE_EXPLORATION) return Math.floor(this.rng() * 2);
    return bestIndex(row);
  }

  runEpisode() {
    let state = 0;
    this.last = [];
    while (state < DELIVERY_STATES) {
      const row = this.q[state];
      const action = this.chooseAction(row);
      const quickJob = state === 0 && action === 0;
      const delivered = state === DELIVERY_STATES - 1;
      const terminal = quickJob || delivered;
      let reward = 0;
      if (quickJob) reward = QUICK_JOB_REWARD;
      if (delivered) reward = DELIVERY_REWARD;
      const next = state + 1;
      const future = terminal ? 0 : this.gamma * Math.max(...this.q[next]);
      const before = row[action];
      row[action] += FUTURE_LEARNING_RATE * (reward + future - before);
      this.last.push({ state, action, reward, before, after: row[action] });
      state = terminal ? DELIVERY_STATES : next;
    }
    this.episodes++;
  }

  train(count = 10) {
    for (let episode = 0; episode < count; episode++) this.runEpisode();
  }

  policy() {
    return this.q[0][1] > this.q[0][0] ? 'delivery' : 'near';
  }
}

// Twenty fixed start poses, none too close to the goal, shared by the test and transfer chapters.
function evaluationStarts(seed = EVALUATION_SEED) {
  const rng = introRandom(seed);
  const starts = [];
  while (starts.length < EVALUATION_RUNS) {
    const pose = {
      x: EVALUATION_START.x + rng() * EVALUATION_START.width,
      y: EVALUATION_START.y + rng() * EVALUATION_START.height,
      theta: rng() * 2 * Math.PI - Math.PI,
    };
    if (introDistance(pose) > EVALUATION_MIN_DISTANCE) starts.push(pose);
  }
  return starts;
}

function evaluateLearner(model, starts = evaluationStarts(), physics = {}) {
  const runs = starts.map((start, index) =>
    introRollout(model, introRandom(EVALUATION_RUN_SEED + index), { start, physics }),
  );
  const successes = runs.filter((run) => run.success);
  const totalTime = successes.reduce((sum, run) => sum + run.time, 0);
  return {
    runs,
    successes: successes.length,
    contacts: runs.filter((run) => run.hit).length,
    meanTime: successes.length ? totalTime / successes.length : null,
  };
}

function newTrainingModel(startMode = 'fixed', varyWheels = false) {
  return new IntroLearner('approach', introRandom(TRAINING_SEED), { startMode, varyWheels });
}

export {
  ACTION_LABELS,
  INTRO_START,
  experienceStep,
  robotReading,
  RouteLearner,
  FutureLearner,
  evaluationStarts,
  evaluateLearner,
  newTrainingModel,
};
