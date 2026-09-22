// A small but real Q-learning experiment: a differential-drive robot moves continuously, but it
// only observes the distance to the goal and the goal's bearing from its heading, each cut into
// coarse bins. Used by the reward primer (app.js) and the foundation chapters (foundations.js).
// No DOM here; the module is importable from Node for tests.

const GOAL = { x: 3.9, y: 1.5 }; // metres
const START = { x: 0.8, y: 1.5, theta: -Math.PI / 2 }; // metres, radians (screen y points down)
const STEP_PERIOD = 0.25; // seconds of motion per chosen action
const WHEEL_BASE = 0.32; // metres between the wheels
// Wheel speeds in m/s as [left, right]: forward, turn left, turn right.
const WHEEL_COMMANDS = [
  [0.65, 0.65],
  [-0.256, 0.256],
  [0.256, -0.256],
];
const ARENA = { minX: 0.18, maxX: 4.62, minY: 0.18, maxY: 2.82 }; // metres the robot centre may reach
const ARRIVAL_RADIUS = 0.22; // metres from the goal that count as arrived
const APPROACH_REWARD_PER_METRE = 8;
const ARRIVAL_BONUS = 8;
const DISTANCE_BIN = 0.5; // metres per observation bin
const DISTANCE_BINS = 10;
const BEARING_BINS = 32; // about 11 degrees each
const ACTIONS = WHEEL_COMMANDS.length;
const LEARNING_RATE = 0.22;
const DISCOUNT = 0.95; // weight of the next state's best estimate
const EPISODE_STEPS = 100; // training episodes end after this many actions
const ROLLOUT_STEPS = 80; // evaluation runs end after this many actions (20 seconds)
const EXPLORATION_START = 0.8; // probability of a random action in the first episode
const EXPLORATION_MIN = 0.15;
const EXPLORATION_DECAY_EPISODES = 900;
const RANDOM_START = { x: 0.35, y: 0.35, width: 3.9, height: 2.3 }; // metres
const WHEEL_GAIN_MIN = 0.65; // fraction of the commanded movement when wheels vary
const WHEEL_GAIN_RANGE = 0.5;
const EXAMPLE_MIN_REWARD = 0.2; // the first clearly rewarded step is kept as the learner's example

const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

// Linear congruential generator, so every experiment is repeatable from its seed.
function introRandom(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function introDistance(pose) {
  return Math.hypot(GOAL.x - pose.x, GOAL.y - pose.y);
}

function outsideArena(pose) {
  return pose.x < ARENA.minX || pose.x > ARENA.maxX || pose.y < ARENA.minY || pose.y > ARENA.maxY;
}

function stepReward(rule, pose, next, turned, success) {
  if (rule === 'approach') {
    const approach = introDistance(pose) - introDistance(next);
    return APPROACH_REWARD_PER_METRE * approach + (success ? ARRIVAL_BONUS : 0);
  }
  return Math.abs(turned);
}

// Moves the robot for one step. A wall contact keeps the previous position (the heading still
// changes) and ends the run, as does arriving at the goal.
function introStep(pose, action, rule, physics = {}) {
  const left = WHEEL_COMMANDS[action][0] * (physics.leftGain ?? 1);
  const right = WHEEL_COMMANDS[action][1] * (physics.rightGain ?? 1);
  const v = (left + right) / 2; // m/s
  const w = (left - right) / WHEEL_BASE; // rad/s
  const next = {
    x: pose.x + v * Math.cos(pose.theta) * STEP_PERIOD,
    y: pose.y + v * Math.sin(pose.theta) * STEP_PERIOD,
    theta: wrapAngle(pose.theta + w * STEP_PERIOD),
    left,
    right,
  };
  const hit = outsideArena(next);
  if (hit) {
    next.x = pose.x;
    next.y = pose.y;
  }
  const success = introDistance(next) < ARRIVAL_RADIUS;
  return {
    state: next,
    reward: stepReward(rule, pose, next, w * STEP_PERIOD, success),
    success,
    done: hit || success,
    hit,
  };
}

function bestIndices(values) {
  const best = Math.max(...values);
  return values.map((value, index) => (value === best ? index : -1)).filter((index) => index >= 0);
}

class IntroLearner {
  constructor(rule = 'approach', random = Math.random, options = {}) {
    this.rule = rule;
    this.random = random;
    this.options = options; // { startMode: 'fixed' | 'varied', varyWheels: boolean }
    this.q = Array.from({ length: DISTANCE_BINS * BEARING_BINS }, () => Array(ACTIONS).fill(0));
    this.episodes = 0;
    this.steps = 0;
    this.example = null; // the first clearly rewarded step, shown by the primer
  }

  // Observation index: distance bin × bearing bin.
  state(pose) {
    const bearing = wrapAngle(Math.atan2(GOAL.y - pose.y, GOAL.x - pose.x) - pose.theta);
    const distanceBin = Math.min(DISTANCE_BINS - 1, Math.floor(introDistance(pose) / DISTANCE_BIN));
    const bearingBin = Math.min(
      BEARING_BINS - 1,
      Math.floor(((bearing + Math.PI) / (Math.PI * 2)) * BEARING_BINS),
    );
    return distanceBin * BEARING_BINS + bearingBin;
  }

  // ε-greedy: a random action with probability epsilon, otherwise one of the best-valued
  // actions, ties broken at random. Both branches draw exactly two random numbers.
  choose(pose, epsilon = 0) {
    const ties = bestIndices(this.q[this.state(pose)]);
    const explore = this.random() < epsilon;
    if (explore) return Math.floor(this.random() * ACTIONS);
    return ties[Math.floor(this.random() * ties.length)];
  }

  update(pose, action, outcome) {
    const row = this.q[this.state(pose)];
    const before = row[action];
    const future = outcome.done ? 0 : Math.max(...this.q[this.state(outcome.state)]);
    row[action] += LEARNING_RATE * (outcome.reward + DISCOUNT * future - before);
    this.steps++;
    return { before, after: row[action] };
  }

  startPose() {
    if (this.options.startMode === 'fixed') return { ...START };
    return {
      x: RANDOM_START.x + this.random() * RANDOM_START.width,
      y: RANDOM_START.y + this.random() * RANDOM_START.height,
      theta: this.random() * Math.PI * 2 - Math.PI,
    };
  }

  episodePhysics() {
    if (!this.options.varyWheels) return {};
    return {
      leftGain: WHEEL_GAIN_MIN + this.random() * WHEEL_GAIN_RANGE,
      rightGain: WHEEL_GAIN_MIN + this.random() * WHEEL_GAIN_RANGE,
    };
  }

  runEpisode() {
    let pose = this.startPose();
    const physics = this.episodePhysics();
    const epsilon = Math.max(
      EXPLORATION_MIN,
      EXPLORATION_START - this.episodes / EXPLORATION_DECAY_EPISODES,
    );
    for (let step = 0; step < EPISODE_STEPS; step++) {
      const action = this.choose(pose, epsilon);
      const outcome = introStep(pose, action, this.rule, physics);
      const change = this.update(pose, action, outcome);
      if (!this.example && outcome.reward > EXAMPLE_MIN_REWARD && !outcome.done)
        this.example = { from: { ...pose }, action, ...outcome, ...change };
      pose = outcome.state;
      if (outcome.done) break;
    }
    this.episodes++;
  }

  train(count = 80) {
    for (let episode = 0; episode < count; episode++) this.runEpisode();
  }
}

// Runs the learned policy (or random actions when `model` is null) without updating values.
// Both primer views start from the same position and heading.
function introRollout(model, random = introRandom(41), options = {}) {
  let pose = { ...(options.start || START), left: 0, right: 0 };
  let score = 0;
  let success = false;
  let hit = false;
  const trace = [{ ...pose, time: 0, score: 0 }];
  const savedRandom = model?.random;
  if (model) model.random = random;
  for (let step = 0; step < ROLLOUT_STEPS; step++) {
    const action = model ? model.choose(pose) : Math.floor(random() * ACTIONS);
    const outcome = introStep(pose, action, model?.rule || 'approach', options.physics);
    pose = outcome.state;
    score += outcome.reward;
    trace.push({ ...pose, time: (step + 1) * STEP_PERIOD, score });
    success = outcome.success;
    hit = outcome.hit;
    if (outcome.done) break;
  }
  if (model) model.random = savedRandom;
  return { trace, success, hit, score, time: trace.at(-1).time, distance: introDistance(pose) };
}

export { introRandom, introDistance, introStep, IntroLearner, introRollout };
