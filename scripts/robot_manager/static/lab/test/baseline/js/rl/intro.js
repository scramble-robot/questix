// A real Q-learning experiment with continuous motion and simplified observations.
const GOAL = { x: 3.9, y: 1.5 },
  START = { x: 0.8, y: 1.5, theta: -Math.PI / 2 },
  DT = 0.25;
const COMMANDS = [
  [0.65, 0.65],
  [-0.256, 0.256],
  [0.256, -0.256],
];
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
function introRandom(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}
function introDistance(p) {
  return Math.hypot(GOAL.x - p.x, GOAL.y - p.y);
}
function introStep(p, action, rule, physics = {}) {
  const left = COMMANDS[action][0] * (physics.leftGain ?? 1),
    right = COMMANDS[action][1] * (physics.rightGain ?? 1),
    v = (left + right) / 2,
    w = (left - right) / 0.32;
  const next = {
    x: p.x + v * Math.cos(p.theta) * DT,
    y: p.y + v * Math.sin(p.theta) * DT,
    theta: wrap(p.theta + w * DT),
    left,
    right,
  };
  const hit = next.x < 0.18 || next.x > 4.62 || next.y < 0.18 || next.y > 2.82;
  if (hit) {
    next.x = p.x;
    next.y = p.y;
  }
  const success = introDistance(next) < 0.22;
  const reward =
    rule === 'approach'
      ? 8 * (introDistance(p) - introDistance(next)) + (success ? 8 : 0)
      : Math.abs(w * DT);
  return { state: next, reward, success, done: hit || success, hit };
}
class IntroLearner {
  constructor(rule = 'approach', random = Math.random, options = {}) {
    this.rule = rule;
    this.random = random;
    this.options = options;
    this.q = Array.from({ length: 32 * 10 }, () => [0, 0, 0]);
    this.episodes = 0;
    this.steps = 0;
    this.example = null;
  }
  state(p) {
    const angle = wrap(Math.atan2(GOAL.y - p.y, GOAL.x - p.x) - p.theta);
    return (
      Math.min(9, Math.floor(introDistance(p) / 0.5)) * 32 +
      Math.min(31, Math.floor(((angle + Math.PI) / (Math.PI * 2)) * 32))
    );
  }
  choose(p, epsilon = 0) {
    const values = this.q[this.state(p)],
      best = Math.max(...values),
      ties = values.map((v, i) => (v === best ? i : -1)).filter((i) => i >= 0);
    return this.random() < epsilon
      ? Math.floor(this.random() * 3)
      : ties[Math.floor(this.random() * ties.length)];
  }
  update(p, action, outcome) {
    const row = this.q[this.state(p)],
      before = row[action],
      future = outcome.done ? 0 : Math.max(...this.q[this.state(outcome.state)]);
    row[action] += 0.22 * (outcome.reward + 0.95 * future - before);
    this.steps++;
    return { before, after: row[action] };
  }
  train(count = 80) {
    for (let n = 0; n < count; n++) {
      let p =
        this.options.startMode === 'fixed'
          ? { ...START }
          : {
              x: 0.35 + this.random() * 3.9,
              y: 0.35 + this.random() * 2.3,
              theta: this.random() * Math.PI * 2 - Math.PI,
            };
      const physics = this.options.varyWheels
        ? { leftGain: 0.65 + this.random() * 0.5, rightGain: 0.65 + this.random() * 0.5 }
        : {};
      const epsilon = Math.max(0.15, 0.8 - this.episodes / 900);
      for (let t = 0; t < 100; t++) {
        const action = this.choose(p, epsilon),
          outcome = introStep(p, action, this.rule, physics),
          change = this.update(p, action, outcome);
        if (!this.example && outcome.reward > 0.2 && !outcome.done)
          this.example = { from: { ...p }, action, ...outcome, ...change };
        p = outcome.state;
        if (outcome.done) break;
      }
      this.episodes++;
    }
  }
}
function introRollout(model, random = introRandom(41), options = {}) {
  let p = { ...(options.start || START), left: 0, right: 0 },
    score = 0,
    success = false,
    hit = false;
  const trace = [{ ...p, time: 0, score: 0 }];
  // Evaluation never updates values. Both views start at the same position and heading.
  const saved = model?.random;
  if (model) model.random = random;
  for (let i = 0; i < 80; i++) {
    const action = model ? model.choose(p) : Math.floor(random() * 3),
      out = introStep(p, action, model?.rule || 'approach', options.physics);
    p = out.state;
    score += out.reward;
    trace.push({ ...p, time: (i + 1) * DT, score });
    success = out.success;
    hit = out.hit;
    if (out.done) break;
  }
  if (model) model.random = saved;
  return { trace, success, hit, score, time: trace.at(-1).time, distance: introDistance(p) };
}

export { introRandom, introDistance, introStep, IntroLearner, introRollout };
