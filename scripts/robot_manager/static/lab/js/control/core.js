import { loadJson } from '../core/content.js';

// Feedback-control course: maths and simulation. No DOM, importable from Node.
// Educational, deterministic one-dimensional model. This is not a hardware controller.
// Every learner-facing sentence of a topic lives in content/control/topics.json.

const topicContent = await loadJson('content/control/topics.json');

const CONTROL_GROUPS = topicContent.groups;
const CONTROL_TOPICS = topicContent.topics;

const DURATION = 16; // seconds of simulated experiment
const SIM_STEP = 0.01; // seconds between physics steps
const CONTROL_PERIOD = 0.05; // seconds between controller updates (every 5th physics step)
const LAST_SAMPLE = Math.round(DURATION / CONTROL_PERIOD); // index of a run's last sample
const WHEEL_RADIUS = 0.065; // metres
const FULL_SPEED_RPM = 80; // wheel speed a 100 % command asks for in distance mode
const MAX_SPEED = (2 * Math.PI * WHEEL_RADIUS * FULL_SPEED_RPM) / 60; // metres per second
const START_DISTANCE = 1.6; // metres from the wall at the start of a distance run
const STOP_DISTANCE = 0.5; // metres: the target gap to the wall
const COLLISION_DISTANCE = 0.12; // metres: the run is abandoned this close to the wall
const RAMP_SECONDS = 3; // seconds the 'ramp' reference profile takes to reach the target
const DRAG_START = 5; // seconds: when the extra load appears in the 'drag' case
const BLOCK_WINDOW = { from: 3, to: 7 }; // seconds the wheel cannot turn in the 'limits' topic
const TAIL_SECONDS = 2; // seconds at the end averaged into the final error
const SETTLING_LIMIT = 10; // seconds allowed to settle in the challenge
const CHALLENGE_LIMITS = { overshoot: 0.1, finalError: 0.05 }; // metres

// Ranges of every numeric setting, with the same order the sliders use.
const SETTING_RANGES = [
  ['kp', 0, 8],
  ['ki', 0, 6],
  ['kd', 0, 3],
  ['filter', 0, 0.6],
  ['power', 0, 100],
  ['targetRPM', 20, 80],
  ['ffGain', 0, 2],
];
const SCENARIOS = ['standard', 'heavy', 'noisy'];
const LOAD_CASES = ['nominal', 'drag', 'mismatch'];
const STRATEGIES = ['feedforward', 'feedback', 'both'];
const PROFILES = ['step', 'ramp'];

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const findTopic = (id) => CONTROL_TOPICS.find((topic) => topic.id === id);

function controlDefaults(id) {
  const topic = findTopic(id);
  if (!topic) throw new Error('Unknown control lesson');
  return {
    kp: 1.2,
    ki: 0,
    kd: 0,
    feedback: true,
    power: 60, // per cent of the motor's maximum command
    targetRPM: 60,
    ffGain: 1, // per cent of command per rpm of target
    loadCase: 'drag',
    strategy: 'both',
    profile: 'step',
    filter: 0.12, // seconds
    antiWindup: true,
    scenario: 'standard',
    ...topic.defaults,
  };
}

function normalizeControlConfig(id, input = {}) {
  const config = { ...controlDefaults(id), ...input };
  for (const [key, min, max] of SETTING_RANGES) {
    config[key] = Number(config[key]);
    if (!Number.isFinite(config[key])) throw new Error('設定値は数値にしてください');
    config[key] = clamp(config[key], min, max);
  }
  config.feedback = !!config.feedback;
  config.antiWindup = !!config.antiWindup;
  if (!SCENARIOS.includes(config.scenario)) throw new Error('Unknown scenario');
  if (
    !LOAD_CASES.includes(config.loadCase) ||
    !STRATEGIES.includes(config.strategy) ||
    !PROFILES.includes(config.profile)
  )
    throw new Error('Unknown control condition');
  return config;
}

// Derivative on measurement avoids a kick when the target changes. Conditional
// integration suspends accumulation that would drive an already saturated output further.
function pidStep(
  state,
  { error, measurement, kp, ki, kd, dt, filter = 0, antiWindup = true, limit = 1, feedforward = 0 },
) {
  const slope = state.previous === undefined ? 0 : (measurement - state.previous) / dt;
  state.previous = measurement;
  const alpha = filter > 0 ? dt / (filter + dt) : 1;
  state.derivative = (state.derivative || 0) + alpha * (slope - (state.derivative || 0));
  const p = kp * error;
  const d = -kd * state.derivative;
  let integral = (state.integral || 0) + ki * error * dt;
  const raw = feedforward + p + integral + d;
  if (antiWindup && ((raw > limit && error > 0) || (raw < -limit && error < 0)))
    integral = state.integral || 0;
  state.integral = integral;
  return { p, i: integral, d, command: clamp(feedforward + p + integral + d, -limit, limit) };
}

// One step of the P / I / D worked example the learner drives by hand (see concepts.js).
// `measured` is an rpm for P and I and a distance in metres for D; `accumulated` is the
// correction I has built up so far, in per cent.
function controlConceptStep(kind, measured, accumulated = 0) {
  const distance = kind === 'd';
  const error = distance ? 0 : (60 - measured) / 100;
  const memory = { integral: accumulated / 100, previous: distance ? -1 : measured / 100 };
  const parts = pidStep(memory, {
    error,
    measurement: distance ? -measured : measured / 100,
    kp: kind === 'p' ? 1.2 : 0,
    ki: kind === 'i' ? 1 : 0,
    kd: kind === 'd' ? 1 : 0,
    dt: 1,
    filter: 0,
    antiWindup: false,
  });
  return {
    error: distance ? measured - 1 : 60 - measured,
    correction: parts[kind] * 100,
    command: parts.command * 100,
  };
}

// Which of the four ways of deciding the command a topic uses with this configuration.
function controlMethod(id, config) {
  if (id === 'output' || (id === 'feedback' && !config.feedback)) return 'fixed';
  if (id === 'feedforward') return 'feedforward';
  if (id === 'combined') return config.strategy;
  if (id === 'reference') return 'both';
  return 'feedback';
}

// Which load the wheel meets; only two topics let the learner choose it.
function controlLoad(id, config) {
  if (id === 'output' || id === 'reference') return 'nominal';
  if (id === 'feedforward' || id === 'combined') return config.loadCase;
  return 'drag';
}

// Repeatable "measurement noise": two sine waves, not Math.random, so a rerun of the same
// configuration produces the same graph.
const noiseAt = (time) => Math.sin(time * 71) * 0.6 + Math.sin(time * 113 + 0.7) * 0.4;

function simulateControl(id, input = {}) {
  const topic = findTopic(id);
  const config = normalizeControlConfig(id, input);
  const distance = topic.mode === 'distance';
  const target = distance ? STOP_DISTANCE : config.targetRPM;
  const method = controlMethod(id, config);
  const loadCase = controlLoad(id, config);
  const noisy = id === 'noise' || (id === 'challenge' && config.scenario === 'noisy');
  const steps = Math.round(DURATION / SIM_STEP);
  const dt = SIM_STEP;

  let value = distance ? START_DISTANCE : 0; // metres to the wall, or wheel rpm
  let velocity = 0; // metres per second
  let drive = 0; // first-order motor state, 1 = full command
  let command = 0; // -1 … 1
  let measurement = value;
  let parts = { p: 0, i: 0, d: 0 };
  let collision = false;
  // Two extra stages of the measured value model the roughly 0.1 s sensor delay.
  let delayed = value;
  let prior = value;
  const pid = {};
  const samples = [];

  for (let n = 0; n <= steps; n++) {
    const time = n * dt;
    const reference =
      id === 'reference' && config.profile === 'ramp'
        ? target * Math.min(1, time / RAMP_SECONDS)
        : target;
    const blocked = id === 'limits' && time >= BLOCK_WINDOW.from && time < BLOCK_WINDOW.to;
    if (n % 5 === 0) {
      measurement = delayed + (noisy ? noiseAt(time) * (distance ? 0.012 : 1.2) : 0);
      delayed = prior;
      prior = value;
      const ff =
        method === 'feedforward' || method === 'both' ? (config.ffGain * reference) / 100 : 0;
      if (method === 'fixed') {
        command = config.power / 100;
        parts = { p: 0, i: 0, d: 0 };
      } else if (method === 'feedforward') {
        command = clamp(ff, -1, 1);
        parts = { p: 0, i: 0, d: 0 };
      } else {
        parts = pidStep(pid, {
          // Distance counts down towards the wall, so its error and measurement are mirrored
          // to keep "a positive command drives forward" true in both modes.
          error: distance ? measurement - reference : (reference - measurement) / 100,
          measurement: distance ? -measurement : measurement / 100,
          kp: config.kp,
          ki: config.ki,
          kd: config.kd,
          dt: CONTROL_PERIOD,
          filter: config.filter,
          antiWindup: config.antiWindup,
          feedforward: ff,
        });
        command = parts.command;
      }
      if (collision) command = 0;
      samples.push({
        time,
        target: reference,
        ff: ff * 100,
        correction: (parts.p + parts.i + parts.d) * 100,
        measured: measurement,
        actual: value,
        command: command * 100,
        rpm: distance ? (velocity / MAX_SPEED) * FULL_SPEED_RPM : value,
        p: parts.p * 100,
        i: parts.i * 100,
        d: parts.d * 100,
        blocked,
        collision,
      });
    }
    if (n === steps) break;
    if (distance) {
      // A loaded robot accelerates more slowly; the time constant is in seconds.
      const lag = config.scenario === 'heavy' && id === 'challenge' ? 1.05 : 0.7;
      velocity += ((MAX_SPEED * command - velocity) * dt) / lag;
      value -= velocity * dt;
      if (value <= COLLISION_DISTANCE) {
        value = COLLISION_DISTANCE;
        velocity = 0;
        collision = true;
      }
    } else {
      drive += ((command - drive) * dt) / 0.12; // motor time constant, seconds
      const load = id === 'limits' || loadCase !== 'drag' ? 0 : time >= DRAG_START ? 15 : 0;
      const gain = loadCase === 'mismatch' ? 80 : 100; // rpm at full command
      value += ((gain * drive - value - load * Math.tanh(value / 2)) * dt) / 0.35;
      if (blocked) value = 0;
      velocity = value;
    }
  }

  const result = {
    id,
    mode: topic.mode,
    config,
    target,
    method,
    loadCase,
    samples,
    duration: DURATION,
    collision,
  };
  result.metrics = controlMetrics(result);
  return result;
}

// Settling is measured backwards from the end, so a value that only touches the band and
// leaves again does not count as settled.
function settlingTime(samples, { target, distance, after, tolerance, duration }) {
  let settling = null;
  for (let i = samples.length - 1; i >= 0; i--) {
    const sample = samples[i];
    if (
      sample.time < after ||
      Math.abs(sample.actual - target) > tolerance ||
      (distance && Math.abs(sample.rpm) > 3)
    )
      break;
    settling = sample.time - after;
  }
  if (settling !== null && duration - after - settling < 1) return null;
  return settling;
}

function controlMetrics(result) {
  const { samples, target, mode, id, duration } = result;
  const distance = mode === 'distance';
  // Speed runs with a load are judged from the moment the load changes.
  const after = distance || result.loadCase !== 'drag' ? 0 : id === 'limits' ? 7 : 5;
  const tolerance = distance ? 0.05 : 3; // metres or rpm
  const tail = samples.filter((sample) => sample.time >= duration - TAIL_SECONDS);
  const finalError = mean(tail.map((sample) => Math.abs(sample.actual - target)));
  const overshoot = Math.max(
    0,
    ...samples.map((sample) => (distance ? target - sample.actual : sample.actual - target)),
  );
  const settling = settlingTime(samples, { target, distance, after, tolerance, duration });
  const eligible = samples.filter((sample) => sample.time >= after);
  const chatter = mean(
    eligible.slice(1).map((sample, i) => Math.abs(sample.command - eligible[i].command)),
  );
  const passed =
    distance &&
    !result.collision &&
    settling !== null &&
    settling <= SETTLING_LIMIT &&
    overshoot <= CHALLENGE_LIMITS.overshoot &&
    finalError <= CHALLENGE_LIMITS.finalError;
  const peakAcceleration = Math.max(
    ...samples
      .slice(1)
      .map((sample, i) => Math.abs(sample.rpm - samples[i].rpm) / (sample.time - samples[i].time)),
  );
  return { finalError, overshoot, settling, chatter, passed, after, tolerance, peakAcceleration };
}

const CSV_SAMPLE_KEYS = [
  'time',
  'target',
  'measured',
  'actual',
  'command',
  'rpm',
  'p',
  'i',
  'd',
  'ff',
  'correction',
];

function controlCSVHeader(mode) {
  const unit = mode === 'distance' ? 'm' : 'rpm';
  return [
    'time_s',
    `target_${unit}`,
    `measured_${unit}`,
    `actual_${unit}`,
    'command_percent',
    'wheel_rpm',
    'p_percent',
    'i_percent',
    'd_percent',
    'feedforward_percent',
    'feedback_percent',
    'lesson',
    'scenario',
    'kp',
    'ki',
    'kd',
    'filter_s',
    'anti_windup',
    'feedback',
    'fixed_power_percent',
    'target_rpm',
    'ff_gain',
    'load_case',
    'strategy',
    'reference_profile',
  ].join(',');
}

// Every row repeats the configuration so a spreadsheet of several runs stays self-describing.
// The BOM keeps Japanese headers readable in Excel.
function controlCSV(result) {
  const config = result.config;
  const metadata = [
    result.id,
    config.scenario,
    config.kp,
    config.ki,
    config.kd,
    config.filter,
    config.antiWindup,
    config.feedback,
    config.power,
    config.targetRPM,
    config.ffGain,
    result.loadCase,
    result.method,
    config.profile,
  ].join(',');
  const rows = result.samples.map(
    (sample) => CSV_SAMPLE_KEYS.map((key) => sample[key].toFixed(4)).join(',') + ',' + metadata,
  );
  return '﻿' + controlCSVHeader(result.mode) + '\r\n' + rows.join('\r\n');
}

// The table of "command in, steady rpm out" the feedforward topic quotes: simulated runs at a
// fixed command, averaged over the last two seconds once the wheel has settled.
function controlCalibration() {
  return [20, 40, 60].map((power) => {
    const run = simulateControl('output', { power });
    const settled = run.samples.filter((sample) => sample.time >= DURATION - TAIL_SECONDS);
    return { power, rpm: mean(settled.map((sample) => sample.measured)) };
  });
}

export {
  CONTROL_GROUPS,
  CONTROL_TOPICS,
  DURATION,
  CONTROL_PERIOD,
  LAST_SAMPLE,
  BLOCK_WINDOW,
  DRAG_START,
  STOP_DISTANCE,
  START_DISTANCE,
  FULL_SPEED_RPM,
  controlDefaults,
  normalizeControlConfig,
  pidStep,
  controlConceptStep,
  controlMethod,
  controlLoad,
  simulateControl,
  controlMetrics,
  controlCSV,
  controlCalibration,
};
