import { render } from '../vendor/lit-html.js';
import { loadJson } from '../core/content.js';
import { IntroLearner, introRandom, introRollout } from './intro.js';
import {
  ACTION_LABELS,
  INTRO_START,
  experienceStep,
  robotReading,
  RouteLearner,
  FutureLearner,
  evaluationStarts,
  evaluateLearner,
  newTrainingModel,
} from './foundations-core.js';
import { drawFoundationMap } from './foundations-render.js';
import { fillSentence } from '../core/content.js';
import { groupsNav, topicsNav, lessonGuides, chapterPanels } from './foundations-view.js';

// Reinforcement-learning course, foundation chapters: state and behaviour. foundations-view.js
// turns the model into markup, foundations-render.js draws the arena, foundations-core.js and
// intro.js do the maths. Texts live in content/rl/foundations.json.
//
// Unlike the other courses this page does not own its markup: index.html holds #introPage with
// the containers (#rlGroups, #rlControls, #rlFigure, …) that the chapters render into, so
// `update()` renders one template per container instead of one page template.

const copy = await loadJson('content/rl/foundations.json');

const TOPICS = copy.topics;
const FIRST_TOPIC = 'experience';
const REWARD_TOPIC = 'reward'; // the reward primer; its markup lives in index.html and app.js
const COURSE_GROUP = 3; // the group that hands over to the integrated course page
const EXPERIENCE_SEED = 5;
const MAX_TRACE_POSES = 200;
const AUTO_EXPLORATION = 0.2; // probability of a random action when the robot chooses for itself
const DELIVERY_BATCH = 10; // deliveries per press of "10回配達させる"
const FUTURE_DISCOUNT = 0.9; // weight of the next state's estimate for the look-ahead learner
const FUTURE_BATCH_EPISODES = 30;
const TRAINING_ROUNDS = 10; // 10 × 80 = the 800 episodes the chapter text promises
const EPISODES_PER_ROUND = 80;
const NO_MOVEMENT = 0.0001; // metres below which a step counts as not having moved
const MEAN_TIME_TOLERANCE = 0.1; // seconds a mean run time must grow by to count as slower
// Value table cells shown in the "future" chapter, as [state, action] of FutureLearner.q.
const FUTURE_VALUE_CELLS = [
  [0, 0], // start → carry it nearby
  [0, 1], // start → go out on the delivery
  [1, 0], // walk the corridor
  [2, 0], // hand the parcel over
];
// Containers whose markup is rebuilt from scratch when another chapter opens.
const CHAPTER_PANELS = [
  'rlControls',
  'rlFigure',
  'rlMetrics',
  'rlExplanation',
  'rlExtra',
  'rlQuestion',
];

const newExperienceLearner = () => new IntroLearner('approach', introRandom(EXPERIENCE_SEED));

// One experiment per chapter, kept while the learner moves between chapters.
const experience = {
  learner: newExperienceLearner(),
  pose: null,
  trace: [],
  event: null, // the most recent step, or null before the first one
  notice: null, // message shown instead of the derived status until the next step
};
resetExperiencePose();
const explore = { learner: new RouteLearner(), exploration: 0, batch: [] };
const future = { immediate: new FutureLearner(0), lookAhead: new FutureLearner(FUTURE_DISCOUNT) };
const test = { mode: 'fixed', model: null, result: null, previous: null, index: 0, notice: null };
const transfer = {
  model: null,
  variedWheels: false,
  gain: 0.7, // fraction of the commanded movement the left wheel actually makes
  result: null,
  previous: null,
  notice: null,
};
const evaluation = evaluationStarts(); // the same twenty start poses for every comparison

let topicId = FIRST_TOPIC;
let openCoursePage = null; // handed in by initRLCurriculum
let busy = false; // a model is training; every control is locked until it finishes
let trainingStatus = '';

const el = (id) => document.getElementById(id);
const topicById = (id) => TOPICS.find((topic) => topic.id === id);
const groupOf = (id) => topicById(id).group;

// ------------------------------------------------------------------- chapters

function experienceEvent() {
  const event = experience.event;
  if (!event) return null;
  const before = robotReading(event.from);
  const after = robotReading(event.state);
  return {
    action: event.action,
    actionLabel: ACTION_LABELS[event.action],
    reward: event.reward,
    fromDistance: before.distance,
    toDistance: after.distance,
    movement: movementSentence(before.distance, after.distance),
    rpm: after.rpm,
    values: event.after,
    change: event.change,
  };
}

function movementSentence(before, after) {
  const text = copy.experience;
  const moved = Math.abs(before - after);
  if (moved < NO_MOVEMENT) return text.distanceUnchanged;
  const direction = before > after ? text.closer : text.farther;
  return (moved * 100).toFixed(1) + ' cm' + direction;
}

function experienceChapter() {
  const reading = robotReading(experience.pose);
  return {
    kind: 'experience',
    finished: Boolean(experience.event?.done),
    distance: reading.distance,
    bearing: reading.bearing,
    event: experienceEvent(),
  };
}

function experienceStatus() {
  const text = copy.experience.status;
  if (experience.notice) return experience.notice;
  const event = experience.event;
  if (!event) return text.initial;
  if (!event.done) return text.moved;
  return event.success ? text.arrived : text.contact;
}

const untriedDestinations = () =>
  explore.learner.counts
    .map((count, index) => (count ? null : copy.explore.destinations[index]))
    .filter(Boolean);

function exploreChapter() {
  const learner = explore.learner;
  const tried = learner.history.length > 0;
  return {
    kind: 'explore',
    exploration: explore.exploration,
    values: learner.values,
    counts: learner.counts,
    best: tried ? learner.values.indexOf(Math.max(...learner.values)) : -1,
    deliveries: learner.history.length,
    batch: explore.batch,
    total: learner.history.reduce((sum, delivery) => sum + delivery.reward, 0),
    nextHint: exploreHint(),
  };
}

// Which sentence points at the next thing worth trying, given how the deliveries are chosen.
function exploreHint() {
  const text = copy.explore.next;
  if (!explore.learner.history.length) return text.initial;
  if (explore.exploration === 0) return text.greedy;
  if (explore.exploration === 1) return text.random;
  return untriedDestinations().length ? text.untried : text.allTried;
}

function exploreStatus() {
  const text = copy.explore.status;
  if (!explore.learner.history.length) return text.initial;
  const untried = untriedDestinations();
  if (untried.length) return untried.join('・') + text.untried;
  return text.allTried;
}

function futureChapter() {
  const text = copy.future;
  return {
    kind: 'future',
    trained: future.lookAhead.episodes > 0,
    episodes: future.lookAhead.episodes,
    cards: [
      {
        title: text.immediateTitle,
        gamma: future.immediate.gamma,
        choice: future.immediate.policy(),
      },
      {
        title: text.lookAheadTitle,
        gamma: future.lookAhead.gamma,
        choice: future.lookAhead.policy(),
      },
    ],
    valueRows: FUTURE_VALUE_CELLS.map(([state, action], row) => ({
      label: text.valueRows[row],
      immediate: future.immediate.q[state][action],
      lookAhead: future.lookAhead.q[state][action],
    })),
  };
}

function futureStatus() {
  const text = copy.future.status;
  if (!future.lookAhead.episodes) return text.initial;
  return future.lookAhead.policy() === 'delivery' ? text.delivery : text.near;
}

function testChapter() {
  const model = test.model;
  return {
    kind: 'test',
    mode: test.mode,
    hasModel: Boolean(model),
    trainedModel: model ? { episodes: model.episodes, startMode: model.options.startMode } : null,
    result: test.result,
    previous: test.previous,
    index: test.index,
  };
}

function testStatus() {
  const text = copy.test.status;
  if (test.notice) return test.notice;
  if (!test.result) return test.model ? text.trained : text.initial;
  const previous = test.previous;
  const sameArrivals =
    previous &&
    previous.label !== test.result.label &&
    previous.successes === test.result.successes;
  if (sameArrivals) return text.sameArrivals;
  // How the trained policy does from the start pose the earlier chapters used.
  const familiar = introRollout(test.model);
  return fillSentence(text.familiar, {
    familiar: familiar.success ? text.familiarArrived : text.familiarMissed,
    successes: test.result.successes,
  });
}

function transferChapter() {
  return {
    kind: 'transfer',
    gainPercent: Math.round(transfer.gain * 100),
    hasModel: Boolean(transfer.model),
    variedWheels: transfer.variedWheels,
    result: transfer.result,
    previous: transfer.previous,
  };
}

// True when learning again with varied wheels kept the same number of arrivals but got slower.
function retrainDidNotHelp(result) {
  const previous = transfer.previous;
  if (!previous || previous.gain !== result.gain) return false;
  if (previous.changed.successes !== result.changed.successes) return false;
  return result.changed.meanTime > previous.changed.meanTime + MEAN_TIME_TOLERANCE;
}

function transferStatus() {
  const text = copy.transfer.status;
  if (transfer.notice) return transfer.notice;
  const result = transfer.result;
  if (!result) return transfer.model ? text.trained : text.initial;
  if (retrainDidNotHelp(result)) return text.noImprovement;
  return fillSentence(text.compared, {
    normal: result.normal.successes,
    changed: result.changed.successes,
  });
}

const CHAPTERS = {
  experience: { model: experienceChapter, status: experienceStatus },
  explore: { model: exploreChapter, status: exploreStatus },
  future: { model: futureChapter, status: futureStatus },
  test: { model: testChapter, status: testStatus },
  transfer: { model: transferChapter, status: transferStatus },
};

function buildModel() {
  const group = groupOf(topicId);
  const chapter = CHAPTERS[topicId];
  return {
    topic: topicId,
    group,
    busy,
    onCourse: group === COURSE_GROUP,
    groupTopics: TOPICS.filter((topic) => topic.group === group),
    chapter: chapter ? chapter.model() : null,
    status: chapterStatus(chapter),
  };
}

// While a model trains, every chapter shows how far the training has got instead of its own status.
function chapterStatus(chapter) {
  if (!chapter) return '';
  if (busy) return trainingStatus;
  return chapter.status();
}

// -------------------------------------------------------------- drawing

function drawMap(id, data) {
  const canvas = el(id);
  if (canvas) drawFoundationMap(canvas, data);
}

function drawFigure() {
  if (topicId === 'experience') drawMap('rlRobotMap', { trace: experience.trace });
  else if (topicId === 'test') drawTestFigure();
  else if (topicId === 'transfer') drawTransferFigure();
}

function drawTestFigure() {
  if (!test.result) {
    drawMap('rlRobotMap', { trace: [INTRO_START] });
    return;
  }
  drawMap('rlRobotMap', {
    trace: test.result.runs[test.index].trace,
    runs: test.result.runs,
    selected: test.index,
  });
}

function drawTransferFigure() {
  if (!transfer.result) {
    drawMap('rlRobotMap', { trace: [INTRO_START] });
    return;
  }
  drawMap('rlNormalMap', { trace: transfer.result.normal.runs[0].trace });
  drawMap('rlChangedMap', { trace: transfer.result.changed.runs[0].trace });
}

// -------------------------------------------------------------- rendering

function update() {
  const model = buildModel();
  render(groupsNav(model, copy, actions), el('rlGroups'));
  render(topicsNav(model, actions), el('rlTopics'));
  el('rlBasicsPanel').hidden = model.onCourse;
  el('labPage').hidden = !model.onCourse;
  if (model.onCourse) return;
  renderLesson(model);
}

function renderLesson(model) {
  const guides = lessonGuides(model);
  for (const [id, template] of Object.entries(guides)) render(template, el(id));
  el('rlRewardLesson').hidden = model.topic !== REWARD_TOPIC;
  el('rlFoundationLesson').hidden = model.topic === REWARD_TOPIC;
  el('rlNext').disabled = model.busy;
  render(nextLabel(), el('rlNext'));
  render(topicById(model.topic).summary, el('rlSummary'));
  if (!model.chapter) return;
  renderChapter(model);
}

function renderChapter(model) {
  const panels = chapterPanels(model, copy, actions);
  el('rlQuestion').hidden = !panels.rlQuestion;
  for (const [id, template] of Object.entries(panels)) {
    if (template !== null) render(template, el(id));
  }
  drawFigure();
}

function nextLabel() {
  const next = TOPICS[TOPICS.findIndex((topic) => topic.id === topicId) + 1];
  return next ? '次へ：' + next.label + ' →' : '';
}

function clearNotices() {
  experience.notice = null;
  test.notice = null;
  transfer.notice = null;
}

// A chapter starts with fresh markup, so open <details>, focus and scroll do not carry over from
// the previous one; within a chapter update() patches the panels in place.
function openTopic(id, scroll = false) {
  if (busy) return;
  topicId = id;
  clearNotices();
  document.dispatchEvent(new CustomEvent('rl-topic-change', { detail: { topic: topicId } }));
  for (const panel of CHAPTER_PANELS) render(null, el(panel));
  update();
  if (groupOf(topicId) === COURSE_GROUP) openCoursePage?.(topicId);
  if (scroll) el('rlGroups').scrollIntoView({ block: 'start' });
}

// ---------------------------------------------------------------- training

async function trainModel(startMode, varyWheels, keepModel) {
  if (busy) return;
  trainingStatus = CHAPTERS[topicId].status(); // keep what the learner is reading for now
  busy = true;
  update();
  const model = newTrainingModel(startMode, varyWheels);
  try {
    for (let round = 0; round < TRAINING_ROUNDS; round++) {
      model.train(EPISODES_PER_ROUND);
      trainingStatus = model.episodes + copy.training.progress;
      update();
      // Yields to the browser so the progress message is painted between rounds.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    keepModel(model);
  } finally {
    busy = false;
    update();
  }
}

// ----------------------------------------------------------------- actions

function resetExperiencePose() {
  experience.pose = { ...INTRO_START };
  experience.trace = [experience.pose];
  experience.event = null;
}

function act(action) {
  experience.notice = null;
  experience.event = experienceStep(experience.learner, experience.pose, action);
  experience.pose = experience.event.state;
  experience.trace.push(experience.pose);
  if (experience.trace.length > MAX_TRACE_POSES) experience.trace.shift();
  update();
}

function deliver(count) {
  explore.batch = [];
  for (let delivery = 0; delivery < count; delivery++)
    explore.batch.push(explore.learner.step(explore.exploration));
  update();
}

function learnFuture(episodes) {
  future.immediate.train(episodes);
  future.lookAhead.train(episodes);
  update();
}

const actions = {
  openGroup(group) {
    openTopic(TOPICS.find((topic) => topic.group === group).id);
  },
  openTopic(id) {
    openTopic(id);
  },
  next() {
    const next = TOPICS[TOPICS.findIndex((topic) => topic.id === topicId) + 1];
    if (next) openTopic(next.id, true);
  },

  act,
  actAutomatically() {
    act(experience.learner.choose(experience.pose, AUTO_EXPLORATION));
  },
  restart() {
    resetExperiencePose();
    experience.notice = copy.experience.status.restarted;
    update();
  },
  forget() {
    experience.learner = newExperienceLearner();
    resetExperiencePose();
    experience.notice = null;
    update();
  },

  setExploration(rate) {
    explore.exploration = rate;
    update();
  },
  deliverBatch() {
    deliver(DELIVERY_BATCH);
  },
  deliverOnce() {
    deliver(1);
  },
  resetDestinations() {
    explore.learner = new RouteLearner();
    explore.batch = [];
    update();
  },

  learnFutureBatch() {
    learnFuture(FUTURE_BATCH_EPISODES);
  },
  learnFutureOnce() {
    learnFuture(1);
  },
  resetFuture() {
    future.immediate = new FutureLearner(0);
    future.lookAhead = new FutureLearner(FUTURE_DISCOUNT);
    update();
  },

  setTrainMode(mode) {
    test.mode = mode;
    test.notice = copy.test.status.modeChanged;
    update();
  },
  trainTestModel() {
    test.notice = null;
    // Training always starts from an empty table, so an earlier result becomes the comparison.
    trainModel(test.mode, false, (model) => {
      if (test.result) test.previous = test.result;
      test.model = model;
      test.result = null;
    });
  },
  runTest() {
    test.notice = null;
    const trainedFixed = test.model.options.startMode === 'fixed';
    test.result = {
      ...evaluateLearner(test.model, evaluation),
      label: trainedFixed ? copy.test.trainedFixed : copy.test.trainedVaried,
    };
    test.index = 0;
    update();
  },
  showTrial(index) {
    test.notice = null;
    test.index = index;
    update();
  },

  setWheelGain(percent) {
    transfer.gain = percent / 100;
    transfer.notice = copy.transfer.status.gainChanged;
    update();
  },
  trainTransferModel() {
    transfer.notice = null;
    trainModel('varied', false, (model) => {
      transfer.model = model;
      transfer.variedWheels = false;
      transfer.result = null;
      transfer.previous = null;
    });
  },
  retrainWithVariedWheels() {
    transfer.notice = null;
    trainModel('varied', true, (model) => {
      transfer.previous = transfer.result;
      transfer.model = model;
      transfer.variedWheels = true;
      transfer.result = null;
    });
  },
  runTransferTest() {
    transfer.notice = null;
    const normal = evaluateLearner(transfer.model, evaluation);
    const changed = evaluateLearner(transfer.model, evaluation, {
      leftGain: transfer.gain,
      rightGain: 1,
    });
    transfer.result = {
      normal,
      changed,
      gain: transfer.gain,
      label: transfer.variedWheels ? copy.transfer.trainedVaried : copy.transfer.trainedNormal,
    };
    update();
  },
};

// ------------------------------------------------------------ entry points

function initRLCurriculum(openLab) {
  openCoursePage = openLab;
  // #rlNext and #rlFigure belong to index.html, outside this course's templates, so the button is
  // wired and the figure observed once here instead of from a template.
  el('rlNext').addEventListener('click', actions.next);
  new ResizeObserver(() => drawFigure()).observe(el('rlFigure'));
  document.addEventListener('rl-foundations', () => openTopic(FIRST_TOPIC, true));
  openTopic(FIRST_TOPIC);
}

function reviewRL(id) {
  if (busy || !TOPICS.some((topic) => topic.id === id)) return false;
  el('introPage').hidden = false;
  openTopic(id);
  return true;
}

export { initRLCurriculum, reviewRL };
