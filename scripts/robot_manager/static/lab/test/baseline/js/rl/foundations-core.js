import { IntroLearner, introRandom, introRollout, introStep, introDistance } from './intro.js';

const ACTION_LABELS = ['前に進む', '左へ回る', '右へ回る'];
const INTRO_START = { x: 0.8, y: 1.5, theta: -Math.PI / 2 };
// Intro coordinates have screen y down; a faster right wheel turns counterclockwise.
function experienceStep(model, p, action) {
  const before = [...model.q[model.state(p)]],
    outcome = introStep(p, action, model.rule),
    change = model.update(p, action, outcome);
  return {
    from: { ...p },
    action,
    before,
    after: [...model.q[model.state(p)]],
    ...outcome,
    change,
  };
}
function robotReading(p) {
  return {
    distance: introDistance(p),
    bearing: Math.atan2(
      Math.sin(Math.atan2(1.5 - p.y, 3.9 - p.x) - p.theta),
      Math.cos(Math.atan2(1.5 - p.y, 3.9 - p.x) - p.theta),
    ),
    rpm: [p.left || 0, p.right || 0].map((v) => (v / (2 * Math.PI * 0.065)) * 60),
  };
}

// One-step bandit: each delivery ends immediately. Unknown options start with value zero.
class RouteLearner {
  constructor(seed = 37) {
    this.rng = introRandom(seed);
    this.outcomeRng = introRandom(seed + 400);
    this.values = [0, 0, 0];
    this.counts = [0, 0, 0];
    this.history = [];
  }
  step(epsilon = 0.3) {
    const exploring = this.rng() < epsilon,
      action = exploring
        ? Math.floor(this.rng() * 3)
        : this.values.indexOf(Math.max(...this.values));
    const reward = action === 0 ? 1 : action === 1 ? (this.outcomeRng() < 0.75 ? 4 : 0) : 2;
    const before = this.values[action];
    this.counts[action]++;
    this.values[action] += (reward - before) / this.counts[action];
    const event = { action, reward, exploring, before, after: this.values[action] };
    this.history.push(event);
    return event;
  }
}

// Three decision states, with delivery segments as macro actions; no supplied action values.
class FutureLearner {
  constructor(gamma = 0.9, seed = 53) {
    this.gamma = gamma;
    this.rng = introRandom(seed);
    this.q = [[0, 0], [0], [0]];
    this.episodes = 0;
    this.last = [];
  }
  train(count = 10) {
    for (let n = 0; n < count; n++) {
      let state = 0;
      this.last = [];
      while (state < 3) {
        const row = this.q[state],
          action =
            row.length === 1
              ? 0
              : this.rng() < 0.35
                ? Math.floor(this.rng() * 2)
                : row.indexOf(Math.max(...row));
        const terminal = (state === 0 && action === 0) || state === 2,
          reward = state === 0 && action === 0 ? 1 : state === 2 ? 8 : 0,
          next = state + 1,
          before = row[action];
        row[action] +=
          0.4 * (reward + (terminal ? 0 : this.gamma * Math.max(...this.q[next])) - before);
        this.last.push({ state, action, reward, before, after: row[action] });
        state = terminal ? 3 : next;
      }
      this.episodes++;
    }
  }
  policy() {
    return this.q[0][1] > this.q[0][0] ? 'delivery' : 'near';
  }
}

function evaluationStarts(seed = 90321) {
  const rng = introRandom(seed),
    out = [];
  while (out.length < 20) {
    const p = { x: 0.4 + rng() * 3.9, y: 0.4 + rng() * 2.2, theta: rng() * 2 * Math.PI - Math.PI };
    if (introDistance(p) > 0.7) out.push(p);
  }
  return out;
}
function evaluateLearner(model, starts = evaluationStarts(), physics = {}) {
  const runs = starts.map((start, i) =>
      introRollout(model, introRandom(1000 + i), { start, physics }),
    ),
    successes = runs.filter((r) => r.success);
  return {
    runs,
    successes: successes.length,
    contacts: runs.filter((r) => r.hit).length,
    meanTime: successes.length
      ? successes.reduce((s, r) => s + r.time, 0) / successes.length
      : null,
  };
}
function newTrainingModel(startMode = 'fixed', varyWheels = false) {
  return new IntroLearner('approach', introRandom(71), { startMode, varyWheels });
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
