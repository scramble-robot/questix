import { render } from '../vendor/lit-html.js';
import { loadJson } from '../core/content.js';
import { initRLCurriculum } from './foundations.js';
import { IntroLearner, introRandom, introRollout, introDistance } from './intro.js';
import { drawPrimerRun } from './primer-render.js';
import { primerLabels, primerPanels } from './primer-view.js';
import { revealElement } from './reveal.js';

// Reward primer: the first reinforcement-learning experiment a learner meets. The same robot is
// trained twice — once for getting closer to the goal, once for spinning on the spot — so that the
// reward rule itself becomes visible. primer-view.js turns the model into markup,
// primer-render.js draws the two runs, intro.js does the learning. Texts live in
// content/rl/primer.json.
//
// index.html owns the primer's markup (#rlRewardLesson), so this module renders into its
// containers and wires the two buttons and the reward radios that live there. It also starts the
// foundation chapters, which is why js/main.js imports it after them.

const copy = await loadJson('content/rl/primer.json');

const PRIMER_SEED = 71;
const TRAINING_ROUNDS = 10;
const EPISODES_PER_ROUND = 80; // 10 × 80 = the 800 runs the page footnote promises
const TRAINING_PACE = 220; // ms per round, so the 800 runs take about 2 s and the curve can be watched
const REPLAY_SPEED = 2; // times real time
const NARROW_SCREEN = '(max-width: 900px)';
const UNTRAINED_TRAIL = '#91a9b3';
const TRAINED_TRAIL = '#8edec1';

const untrainedRun = introRollout(null); // random actions; the "before" run never changes

const primer = {
  rule: 'approach',
  started: false, // until the learner acts, index.html's own captions are what is on screen
  model: null,
  result: null,
  history: new Map(), // the last run per reward rule, kept for the comparison card
  curves: new Map(), // total reward of every training run per reward rule, for the learning curve
  busy: false,
  playing: false,
  playToken: 0, // invalidates the frames of a replay that has been superseded
};

const el = (id) => document.getElementById(id);
const ruleInputs = () => [...document.querySelectorAll('[name="primerRule"]')];

function buildModel() {
  const example = primer.model?.example;
  return {
    rule: primer.rule,
    busy: primer.busy,
    playing: primer.playing,
    result: primer.result,
    episodes: primer.model?.episodes ?? 0,
    // The one training step shown as evidence of what the reward rewarded.
    example: example && {
      action: example.action,
      reward: example.reward,
      fromDistance: introDistance(example.from),
      toDistance: introDistance(example.state),
    },
    history: [...primer.history].map(([rule, run]) => ({ rule, run })),
    curve: curveModel(),
  };
}

// The rule being trained (or shown) as the learning curve, the other rule's last curve beside it.
function curveModel() {
  const current = primer.curves.get(primer.rule);
  const other = [...primer.curves].find(([rule]) => rule !== primer.rule);
  if (!current && !primer.busy) return null;
  return {
    total: TRAINING_ROUNDS * EPISODES_PER_ROUND,
    current: current && { rule: primer.rule, rewards: [...current] },
    previous: other && { rule: other[0], rewards: [...other[1]] },
  };
}

function renderFigures(time = Infinity) {
  const startLabel = copy.startLabel;
  drawPrimerRun(el('primerBefore'), {
    run: untrainedRun,
    time,
    trail: UNTRAINED_TRAIL,
    startLabel,
  });
  drawPrimerRun(el('primerAfter'), { run: primer.result, time, trail: TRAINED_TRAIL, startLabel });
}

// index.html seeds the captions with their first wording and lit renders after whatever a
// container already holds, so the seeded text is dropped the first time this module takes over.
const takenOver = new WeakSet();

function renderInto(id, value) {
  const element = el(id);
  if (!takenOver.has(element)) {
    takenOver.add(element);
    element.textContent = '';
  }
  render(value, element);
}

function renderLabels(model) {
  const labels = primerLabels(model, copy);
  for (const [id, label] of Object.entries(labels)) renderInto(id, label);
  el('primerLearn').disabled = model.busy;
  el('primerReplay').disabled = !model.result;
  for (const input of ruleInputs()) input.disabled = model.busy;
}

function renderPanels(model) {
  const panels = primerPanels(model, copy);
  for (const [id, panel] of Object.entries(panels)) {
    el(id).hidden = !panel;
    if (panel) renderInto(id, panel);
  }
}

// Captions and cards only take over from index.html once the learner has picked a rule or trained.
function updateLabels() {
  if (!primer.started) return;
  renderLabels(buildModel());
}

function update() {
  renderFigures();
  if (!primer.started) return;
  const model = buildModel();
  renderLabels(model);
  renderPanels(model);
}

// ---------------------------------------------------------------- playback

function playFrames(startedAt, token) {
  const end = Math.max(untrainedRun.time, primer.result.time);
  const frame = (now) => {
    if (token !== primer.playToken) return;
    const time = Math.min(end, ((now - startedAt) / 1000) * REPLAY_SPEED);
    renderFigures(time);
    if (time < end) {
      requestAnimationFrame(frame);
      return;
    }
    primer.playing = false;
    updateLabels();
  };
  requestAnimationFrame(frame);
}

function replayPrimer() {
  if (!primer.result || primer.busy) return;
  primer.playToken++;
  if (primer.playing) {
    primer.playing = false;
    update();
    return;
  }
  primer.playing = true;
  updateLabels();
  playFrames(performance.now(), primer.playToken);
}

// Leaving the chapter, opening the course or a supplement stops the replay where it is.
function stopPrimer() {
  primer.playToken++;
  primer.playing = false;
  updateLabels();
}

// ---------------------------------------------------------------- learning

function chooseRule(rule) {
  primer.rule = rule;
  primer.started = true;
  primer.playToken++;
  primer.playing = false;
  primer.result = null; // the previous run was learned with the other rule
  update();
}

async function learnPrimer() {
  if (primer.busy) return;
  primer.busy = true;
  primer.playToken++;
  primer.playing = false;
  primer.started = true;
  updateLabels();
  primer.model = new IntroLearner(primer.rule, introRandom(PRIMER_SEED));
  primer.result = null;
  primer.curves.set(primer.rule, primer.model.episodeRewards);
  update();
  if (window.matchMedia(NARROW_SCREEN).matches) revealElement(el('primerCurve'));
  for (let round = 0; round < TRAINING_ROUNDS; round++) {
    primer.model.train(EPISODES_PER_ROUND);
    update();
    // Waits a moment between rounds so the learner can watch the reward curve grow; the training
    // itself would finish in a fraction of a second.
    await new Promise((resolve) => setTimeout(resolve, TRAINING_PACE));
  }
  primer.result = introRollout(primer.model);
  primer.history.set(primer.rule, primer.result);
  primer.busy = false;
  update();
  if (window.matchMedia(NARROW_SCREEN).matches)
    revealElement(document.querySelector('.intro-visual'));
}

// ------------------------------------------------------------------ start-up

function openLab(task = 'delivery') {
  document.dispatchEvent(new CustomEvent('open-lab', { detail: { task } }));
}

// These controls belong to index.html, outside this module's templates, so they are wired once.
for (const input of ruleInputs()) input.addEventListener('change', () => chooseRule(input.value));
el('primerLearn').addEventListener('click', learnPrimer);
el('primerReplay').addEventListener('click', replayPrimer);

renderFigures();
for (const event of ['rl-topic-change', 'series-leave', 'open-lab', 'supplement-open'])
  document.addEventListener(event, stopPrimer);
initRLCurriculum(openLab);
