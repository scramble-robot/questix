import { fillSentence as fill } from '../core/content.js';

// What a finished run of the feedback-control course means, in words and numbers the learner can
// check on the chart. No DOM: test/control-summary.test.mjs. The sentences come from
// content/control/ui.json (`summary`), handed in as `text`.

const TAIL_SECONDS = 2; // seconds at the end of a run averaged into the settled value
const SAME_SPEED = 0.5; // rpm: a gap this small reads as "on target"
const NO_OVERSHOOT = { speed: 0.5, distance: 0.005 }; // rpm / metres counted as "did not overshoot"
const CENTIMETRES = 100; // per metre

// The first stage's topics show one simple number (the settled speed); the P topic onwards adds
// the error, overshoot and settling time the tuning is about.
const SIMPLE_TOPICS = ['output', 'feedforward', 'feedback', 'combined'];

const isSimpleTopic = (topicId) => SIMPLE_TOPICS.includes(topicId);

/** `value.toFixed(digits)`, but never "-0" or "-0.0" (a rounding of a tiny negative number). */
function formatValue(value, digits = 1) {
  const text = Number(value).toFixed(digits);
  return Number(text) === 0 ? (0).toFixed(digits) : text;
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

/** The wheel speed a run ends at: the mean of its last two seconds (rpm). */
function settledSpeed(run) {
  const end = run.samples.at(-1).time;
  return mean(
    run.samples
      .filter((sample) => sample.time >= end - TAIL_SECONDS)
      .map((sample) => sample.actual),
  );
}

/** "あと30 rpm" / "5 rpm速い" / "目標どおり": how far the settled speed is from the target. */
function speedGap(run, text) {
  const gap = run.target - settledSpeed(run);
  if (Math.abs(gap) < SAME_SPEED) return text.onTarget;
  const rpm = formatValue(Math.abs(gap), 0);
  return fill(gap > 0 ? text.slower : text.faster, { rpm, target: run.target });
}

// The closest the robot came to the wall during a distance run (metres).
const closestDistance = (run) => Math.min(...run.samples.map((sample) => sample.actual));

function speedSentence(run, text) {
  const { overshoot, settling, after } = run.metrics;
  const values = {
    speed: formatValue(settledSpeed(run), 0),
    gap: speedGap(run, text),
    overshoot: formatValue(overshoot, 1),
    settling: settling === null ? '' : formatValue(settling, 1),
    after,
  };
  const peak = overshoot < NO_OVERSHOOT.speed ? text.speedNoOvershoot : text.speedOvershoot;
  const settle = () => {
    if (settling === null) return text.speedNotSettled;
    return after ? text.speedSettledAfter : text.speedSettled;
  };
  return fill(text.speedError + peak + settle(), values);
}

function distanceSentence(run, text) {
  const { overshoot, settling } = run.metrics;
  const values = {
    closest: formatValue(closestDistance(run) * CENTIMETRES, 0),
    overshoot: formatValue(overshoot * CENTIMETRES, 0),
    settling: settling === null ? '' : formatValue(settling, 1),
  };
  const passed =
    overshoot < NO_OVERSHOOT.distance ? text.distanceNoOvershoot : text.distanceOvershoot;
  const settle = settling === null ? text.distanceNotSettled : text.distanceSettled;
  return fill(text.distanceClosest + passed + settle, values);
}

/**
 * One sentence that says what the run shows, with its own numbers: the settled speed for the
 * first stage, the error / overshoot / settling time from the P topic on, the closest approach
 * for the distance topics. `text` is `copy.summary` of content/control/ui.json.
 */
function runSummary(run, topicId, text) {
  if (run.mode === 'distance') return distanceSentence(run, text);
  if (isSimpleTopic(topicId))
    return fill(text.simple, {
      speed: formatValue(settledSpeed(run), 0),
      gap: speedGap(run, text),
    });
  return speedSentence(run, text);
}

/**
 * Where a topic sits in the course: its stage (1-based), its number inside the stage and how many
 * topics the stage has, e.g. { stage: 1, position: 1, count: 4, label: '1-1' }.
 */
function topicPlace(topics, topicId) {
  const topic = topics.find((entry) => entry.id === topicId);
  const siblings = topics.filter((entry) => entry.group === topic.group);
  const position = siblings.indexOf(topic) + 1;
  const stage = topic.group + 1;
  return { stage, position, count: siblings.length, label: `${stage}-${position}` };
}

export {
  SIMPLE_TOPICS,
  isSimpleTopic,
  formatValue,
  settledSpeed,
  speedGap,
  closestDistance,
  runSummary,
  topicPlace,
};
