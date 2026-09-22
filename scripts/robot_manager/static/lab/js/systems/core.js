import { SYSTEM_TOPICS, systemDefaults } from './data.js';
import { armFK, armIK } from '../arm/core.js';
import { loadJson, fillSentence as fill } from '../core/content.js';

// Simulations behind the six "systems" courses. No DOM and no state: every experiment is a pure
// function of its settings, returning the samples, the events, the metrics and the closing
// sentence that ui.js, render.js and narration.js show. Importable from Node and unit-tested in
// test/systems-core.test.mjs. Every status, event, metric label and closing sentence comes from
// content/systems/core.json; the status names double as state identifiers, so render.js reads the
// same `status` section instead of repeating them.

const copy = await loadJson('content/systems/core.json');
const STATUS = copy.status;

const dt = 0.05; // seconds per simulation step
const GRAVITY = 9.81; // m/s²
const EPSILON = 1e-8; // seconds; sample times are multiples of dt with rounding noise

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const rad = (degrees) => (degrees * Math.PI) / 180;
const mean = (values) =>
  values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
const metric = (label, value, unit = '', digits = 2) => ({ label, value, unit, digits });

// One fixed pseudo-random stream per run, so the same settings always give the same measurements.
function seedNoise() {
  let seed = 917;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };
}

// Settings that reach a simulation are always the topic's own controls: anything unknown, of the
// wrong type or out of range falls back to the control's default or its nearest allowed value.
function validateSystemConfig(course, id, input = {}) {
  const topic = SYSTEM_TOPICS[course]?.find((entry) => entry.id === id);
  if (!topic) throw new Error('Unknown experiment');
  const config = systemDefaults(course, id);
  for (const control of topic.controls) {
    const value = input[control.key];
    if (control.type === 'number' && Number.isFinite(Number(value)))
      config[control.key] = clamp(Number(value), control.min, control.max);
    else if (control.type === 'check' && typeof value === 'boolean') config[control.key] = value;
    else if (control.type === 'select' && control.options.some(([option]) => option === value))
      config[control.key] = value;
  }
  return config;
}

// --- camera and arm frames (coordination) ---------------------------------------------------

const FITTED_CAMERA = { cameraX: 40, cameraZ: 30, cameraAngle: 10 }; // mm, mm, degrees
const CALIBRATION_MARKERS = [
  { x: 140, z: 80 },
  { x: 210, z: 130 },
  { x: 130, z: 180 },
];

// A point the camera reports, expressed from the arm's shoulder.
function cameraToBody(point, camera) {
  const angle = rad(camera.cameraAngle);
  return {
    x: camera.cameraX + point.x * Math.cos(angle) - point.z * Math.sin(angle),
    z: camera.cameraZ + point.x * Math.sin(angle) + point.z * Math.cos(angle),
  };
}

// The same point as the camera would measure it.
function bodyToCamera(point, camera = FITTED_CAMERA) {
  const angle = rad(camera.cameraAngle);
  const x = point.x - camera.cameraX;
  const z = point.z - camera.cameraZ;
  return {
    x: x * Math.cos(angle) + z * Math.sin(angle),
    z: -x * Math.sin(angle) + z * Math.cos(angle),
  };
}

function calibrationPairs() {
  return CALIBRATION_MARKERS.map((body) => ({ body, camera: bodyToCamera(body) }));
}

const MIN_MARKER_SPREAD = 1e-9; // mm²; below this the markers are effectively one point

// The camera's mounting position and angle that best explain the measured markers (a planar
// Procrustes fit), plus the RMS distance left over.
function fitCameraTransform(pairs) {
  const finite = (pair) =>
    ['x', 'z'].every((key) => Number.isFinite(pair.camera[key]) && Number.isFinite(pair.body[key]));
  if (pairs.length < 2 || pairs.some((pair) => !finite(pair)))
    throw new Error(copy.calibration.needTwoPairs);
  const cameraCentre = {
    x: mean(pairs.map((pair) => pair.camera.x)),
    z: mean(pairs.map((pair) => pair.camera.z)),
  };
  const bodyCentre = {
    x: mean(pairs.map((pair) => pair.body.x)),
    z: mean(pairs.map((pair) => pair.body.z)),
  };
  let dot = 0;
  let cross = 0;
  let spread = 0;
  for (const pair of pairs) {
    const x = pair.camera.x - cameraCentre.x;
    const z = pair.camera.z - cameraCentre.z;
    const bodyX = pair.body.x - bodyCentre.x;
    const bodyZ = pair.body.z - bodyCentre.z;
    dot += x * bodyX + z * bodyZ;
    cross += x * bodyZ - z * bodyX;
    spread += x * x + z * z;
  }
  if (spread < MIN_MARKER_SPREAD || Math.hypot(dot, cross) < MIN_MARKER_SPREAD)
    throw new Error(copy.calibration.spreadMarkers);
  const angle = Math.atan2(cross, dot);
  const fit = {
    cameraX: bodyCentre.x - cameraCentre.x * Math.cos(angle) + cameraCentre.z * Math.sin(angle),
    cameraZ: bodyCentre.z - cameraCentre.x * Math.sin(angle) - cameraCentre.z * Math.cos(angle),
    cameraAngle: (angle * 180) / Math.PI,
  };
  fit.error = Math.sqrt(
    mean(
      pairs.map((pair) => {
        const placed = cameraToBody(pair.camera, fit);
        return (placed.x - pair.body.x) ** 2 + (placed.z - pair.body.z) ** 2;
      }),
    ),
  );
  return fit;
}

// --- mechanics: force, traction, braking ------------------------------------------------------

const MECHANICS_STEPS = 160;
const MECHANICS_START_X = 0.3; // m
const POWER_OFF_STEP = 60; // step index; the motor is switched off at 3.0 s
const POWER_OFF_TIME = 3; // seconds
const STOP_LINE = 3; // m; the line the braking experiment must not overrun
const MOTOR_FORCE = 16; // N at 100 % with the wheels still
const BACK_EMF = 3; // N per m/s: the faster it rolls, the less the motor pushes
const ROLLING_DRAG = 0.6; // N while moving
const DEFAULT_GRIP = 0.7;
const MAX_BRAKE_FORCE = 7; // N
const SLIP_TO_WHEEL_SPEED = 7; // N of excess drive per m/s of wheel slip
const BRAKE_SUCCESS_MARGIN = 0.2; // m short of the line still counts as a good stop
const SLIP_TOLERANCE = 0.15; // m/s between wheel and body speed before traction is lost

function mechanicsStatus(sample) {
  if (sample.braking) return STATUS.mechanics.braking;
  if (sample.motorPower !== 0) return STATUS.driving;
  return sample.v > 0 ? STATUS.mechanics.coasting : STATUS.stopped;
}

function mechanics(topic, config) {
  const text = copy.mechanics;
  const braking = topic === 'braking';
  const samples = [];
  const events = [];
  let x = MECHANICS_START_X;
  let v = braking ? config.initialSpeed : 0;
  let odom = x;
  let brakeStart = null;
  for (let step = 0; step <= MECHANICS_STEPS; step++) {
    const t = step * dt;
    let force = 0;
    let accel = 0;
    let wheelSpeed = v;
    let brakingNow = false;
    const motorPower = braking ? null : t < POWER_OFF_TIME ? config.power : 0;
    if (braking) {
      if (brakeStart === null && STOP_LINE - x <= config.brakeAt) {
        brakeStart = x;
        events.push({
          t,
          x,
          kind: 'brake',
          label: text.events.brakeLabel,
          text: text.events.brakeText,
        });
      }
      brakingNow = brakeStart !== null;
      force =
        brakingNow && v > 0 ? -Math.min(MAX_BRAKE_FORCE, config.grip * config.mass * GRAVITY) : 0;
      accel = force / config.mass;
    } else {
      const requested = Math.max(0, (MOTOR_FORCE * motorPower) / 100 - BACK_EMF * v);
      const grip = (config.grip ?? DEFAULT_GRIP) * config.mass * GRAVITY;
      const drive = Math.min(requested, grip);
      force = drive - (v > 0 ? ROLLING_DRAG : 0);
      accel = force / config.mass;
      // Force the tyres cannot pass to the floor spins the wheels instead of moving the body.
      wheelSpeed = v + Math.max(0, requested - grip) / SLIP_TO_WHEEL_SPEED;
      if (step === POWER_OFF_STEP)
        events.push({
          t,
          x,
          kind: 'power-off',
          label: text.events.powerOffLabel,
          text: fill(text.events.powerOffText, { power: config.power }),
        });
    }
    const sample = { t, x, v, wheelSpeed, odom, force, accel, motorPower, braking: brakingNow };
    samples.push({ ...sample, status: mechanicsStatus(sample) });
    const nextV = Math.max(0, v + accel * dt);
    x += (v + nextV) * 0.5 * dt;
    odom += (v + nextV) * 0.5 * dt + Math.max(0, wheelSpeed - v) * dt;
    v = nextV;
    if (braking && brakeStart !== null && v === 0) {
      samples.push({
        ...samples.at(-1),
        t: t + dt,
        x,
        v: 0,
        wheelSpeed: 0,
        force: 0,
        accel: 0,
        status: STATUS.stopped,
      });
      break;
    }
  }
  const end = samples.at(-1);
  const remaining = STOP_LINE - end.x;
  const success = braking
    ? remaining >= -1e-6 && remaining <= BRAKE_SUCCESS_MARGIN
    : !samples.some((sample) => sample.wheelSpeed - sample.v > SLIP_TOLERANCE);
  const brakingMetrics = () => [
    metric(text.metrics.remainingToLine, remaining, 'm'),
    metric(text.metrics.distanceAfterBrake, end.x - (brakeStart ?? end.x), 'm'),
    metric(text.metrics.timeToStop, end.t, '秒'),
  ];
  const drivingMetrics = () => [
    metric(text.metrics.speedAtPowerOff, samples[POWER_OFF_STEP].v, 'm/秒'),
    metric(text.metrics.odometryError, end.odom - end.x, 'm'),
    metric(text.metrics.startingAcceleration, samples[0].accel, 'm/秒²'),
  ];
  const outcome = () => {
    if (braking) return success ? text.outcome.brakingSuccess : text.outcome.brakingRetry;
    if (topic === 'force') return text.outcome.force;
    return text.outcome.traction;
  };
  return {
    samples,
    events,
    success,
    metrics: braking ? brakingMetrics() : drivingMetrics(),
    outcome: outcome(),
  };
}

// --- behavior: sequence, blocked, missing -----------------------------------------------------

const BEHAVIOR_STEPS = 320;
const PARCEL_PLACE = { x: 1.3, y: 2 };
const PARCEL_ELSEWHERE = { x: 1.3, y: 0.7 };
const DELIVERY_PLACE = { x: 4.3, y: 2 };
const DETOUR = [
  { x: 3.3, y: 0.85 },
  { x: 4.3, y: 2 },
];
const DETOUR_ENTRY = { x: 1.65, y: 0.85 };
const OBSTACLE_BOX = { x: 2.45, y: 1.4, w: 0.4, h: 1.2 };
const TEMPORARY_OBSTACLE_UNTIL = 9; // seconds
const ARRIVED_WITHIN = 0.09; // m
const CRUISE_SPEED = 0.65; // m/s
const MAX_TURN_RATE = 2.3; // rad/s
const HEADING_GAIN = 3; // rad/s per rad of heading error
const WHEEL_RADIUS = 0.065; // m
const HALF_TRACK = 0.16; // m from the centre to a wheel
const SECONDS_PER_MINUTE = 60;

const TO_PARCEL = STATUS.behavior.toParcel;
const TO_ELSEWHERE = STATUS.behavior.toElsewhere;
const TO_DELIVERY = STATUS.behavior.toDelivery;
const WAITING = STATUS.behavior.waiting;
const DETOURING = STATUS.behavior.detour;
const DELIVERED = STATUS.behavior.delivered;
const ARRIVED_EMPTY = STATUS.behavior.arrivedEmpty;

function behavior(topic, config) {
  const text = copy.behavior;
  const why = text.reasons;
  const samples = [];
  const events = [];
  let x = 0.5;
  let y = 2;
  let theta = 0;
  let v = 0;
  let state = TO_PARCEL;
  let hasParcel = false;
  let waitStart = null;
  let waitTotal = 0;
  let target = { ...PARCEL_PLACE };
  let waypoints = [];
  let done = false;
  let detoured = false;
  // Every change of plan is recorded with the reason the robot had for it.
  const change = (t, next, reason) => {
    if (state === next) return;
    state = next;
    events.push({ t, text: fill(text.stateChange, { state: next, reason }) });
  };
  for (let step = 0; step <= BEHAVIOR_STEPS; step++) {
    const t = step * dt;
    const blocked =
      config.obstacle &&
      config.obstacle !== 'none' &&
      (config.obstacle !== 'temporary' || t < TEMPORARY_OBSTACLE_UNTIL);
    let w = 0;
    if (!done && Math.hypot(target.x - x, target.y - y) < ARRIVED_WITHIN) {
      if (state === TO_PARCEL && topic === 'missing' && config.searchRule !== 'search') {
        change(t, TO_DELIVERY, why.ignoreMissingParcel);
        target = { ...DELIVERY_PLACE };
      } else if (state === TO_PARCEL && topic === 'missing') {
        change(t, TO_ELSEWHERE, why.parcelNotThere);
        target = { ...PARCEL_ELSEWHERE };
      } else if (state === TO_PARCEL || state === TO_ELSEWHERE) {
        hasParcel = true;
        change(t, TO_DELIVERY, why.parcelPickedUp);
        target = { ...DELIVERY_PLACE };
      } else if (waypoints.length) {
        target = waypoints.shift();
      } else {
        done = true;
        change(
          t,
          hasParcel ? DELIVERED : ARRIVED_EMPTY,
          hasParcel ? why.parcelHandedOver : why.pickupNotChecked,
        );
      }
    }
    const danger = blocked && !detoured && x > 1.65 && x < 2.5 && y > 1.2;
    if (danger && !done) {
      if (waitStart === null) {
        waitStart = t;
        change(t, WAITING, why.obstacleAhead);
      }
      waitTotal += dt;
      if (
        topic === 'blocked' &&
        config.blockedRule === 'detour' &&
        t - waitStart >= config.timeout
      ) {
        detoured = true;
        waypoints = DETOUR.map((point) => ({ ...point }));
        target = { ...DETOUR_ENTRY };
        change(t, DETOURING, why.waitTimeExceeded);
      }
    } else if (waitStart !== null && state === WAITING) {
      change(t, TO_DELIVERY, why.passageClear);
      waitStart = null;
    }
    if (!done && (!danger || detoured)) {
      const bearing = Math.atan2(target.y - y, target.x - x);
      const error = Math.atan2(Math.sin(bearing - theta), Math.cos(bearing - theta));
      w = clamp(error * HEADING_GAIN, -MAX_TURN_RATE, MAX_TURN_RATE);
      // Turn first, drive once the goal is ahead.
      v = CRUISE_SPEED * Math.max(0, Math.cos(error));
    } else v = 0;
    // Screen y points down; positive theta is clockwise.
    const toRpm = (speed) => (speed / (WHEEL_RADIUS * 2 * Math.PI)) * SECONDS_PER_MINUTE;
    samples.push({
      t,
      x,
      y,
      theta,
      v,
      w,
      left: toRpm(v + w * HALF_TRACK),
      right: toRpm(v - w * HALF_TRACK),
      status: state,
      hasParcel,
      blocked,
      box: OBSTACLE_BOX,
      waitTotal,
      target: { ...target },
    });
    if (done) break;
    theta += w * dt;
    x += v * Math.cos(theta) * dt;
    y += v * Math.sin(theta) * dt;
  }
  const end = samples.at(-1);
  const success = end.status === DELIVERED;
  const outcome = () => {
    if (success) return text.outcome.delivered;
    if (end.status === ARRIVED_EMPTY) return text.outcome.arrivedEmpty;
    return text.outcome.timedOut;
  };
  return {
    samples,
    events,
    success,
    metrics: [
      metric(text.metrics.elapsed, end.t, '秒'),
      metric(text.metrics.waited, waitTotal, '秒'),
      metric(text.metrics.delivered, success ? 'はい' : 'いいえ'),
    ],
    outcome: outcome(),
  };
}

// --- tracking: velocity, prediction, crossing -------------------------------------------------

const TRACKING_STEPS = 140;
const CROSSING_STEPS = 220;
const TRACKING_LANE_Y = 1.6; // m; QUESTiX watches from here
const CART_TURN_TIME = 4; // seconds; the other robot turns round here in the "turn" scenario
const CART_TURN_STEP = 80; // step index at which the turn is recorded as an event
const CART_SPEED = 0.4; // m/s
const CROSSING_GOAL_X = 4.4; // m
const ROBOT_RADIUS_SUM = 0.36; // m between the two centres when the shells touch
const PREDICTED_CLEARANCE = 0.7; // m; predicted approach that makes QUESTiX wait
const CURRENT_CLEARANCE = 0.47; // m; same rule using only the distance measured now
const CROSSING_ACCEL = 1.2; // m/s²
const CROSSING_MAX_SPEED = 0.6; // m/s
const QUESTIX_REL_SPEED = -0.6; // m/s of QUESTiX along the lane, seen from the other robot

// Where the other robot is at a given time; in the "turn" scenario it reverses at 4 s.
const cartAt = (t, motion) => ({
  x: 2.65,
  y:
    motion === 'turn' && t >= CART_TURN_TIME
      ? 1.55 + CART_SPEED * (t - CART_TURN_TIME)
      : 3.15 - CART_SPEED * t,
});

function trackingStatus(topic, { contact, atGoal, stopping, hasVelocity }) {
  const status = STATUS.tracking;
  if (contact) return STATUS.contact;
  if (topic === 'crossing') {
    if (atGoal) return status.arrived;
    return stopping ? status.waitForOther : status.go;
  }
  return hasVelocity ? status.observing : status.waitingMeasurement;
}

function trackingMetrics(topic, samples, errors, minDistance, end, contact) {
  const text = copy.tracking.metrics;
  if (topic === 'crossing')
    return [
      metric(text.closestGap, Math.max(0, minDistance), 'm'),
      metric(text.elapsed, end.t, '秒'),
      metric(text.contact, contact ? 'あり' : 'なし'),
    ];
  if (topic === 'velocity')
    return [
      metric(
        text.positionError,
        mean(
          samples
            .filter((sample) => sample.t === sample.obs.t)
            .map((sample) => Math.abs(sample.observedPosition - sample.actualPosition)),
        ),
        'm',
      ),
      metric(
        text.velocityError,
        mean(
          samples
            .filter((sample) => sample.velocity !== null)
            .map((sample) => Math.abs(sample.velocity - sample.actualVelocity)),
        ),
        'm/秒',
      ),
    ];
  return [
    metric(text.meanPredictionError, mean(errors), 'm'),
    metric(text.maxPredictionError, Math.max(0, ...errors), 'm'),
  ];
}

function trackingOutcome(topic, config, success, contact) {
  const text = copy.tracking.outcome;
  if (topic === 'crossing') {
    if (success) return text.crossingSuccess;
    if (contact) return text.crossingContact;
    return text.crossingTimedOut;
  }
  if (topic === 'velocity') return config.noise > 0 ? text.velocityNoisy : text.velocityClean;
  return config.motion === 'turn' ? text.predictionTurn : text.predictionStraight;
}

function tracking(topic, config) {
  const samples = [];
  const events = [];
  const noise = seedNoise();
  const predictions = [];
  const errors = [];
  let obs = null;
  let previous = null;
  let velocity = 0;
  let hasVelocity = false;
  let lastMeasure = -Infinity;
  let lastError = null;
  let evaluation = null;
  let x = 0.4;
  let v = 0;
  let minDistance = Infinity;
  let contact = false;
  const interval = config.interval ?? 0.2;
  const horizon = config.horizon ?? 1;
  const smoothing = config.smoothing ?? 1;
  const steps = topic === 'crossing' ? CROSSING_STEPS : TRACKING_STEPS;
  for (let step = 0; step <= steps; step++) {
    const t = step * dt;
    const cart = cartAt(t, config.motion);
    const y = TRACKING_LANE_Y;
    if (t - lastMeasure >= interval - EPSILON) {
      previous = obs;
      obs = { x: cart.x, y: cart.y + noise() * (config.noise ?? 0), t };
      if (previous) {
        const measured = (obs.y - previous.y) / (t - previous.t);
        velocity = hasVelocity ? velocity * (1 - smoothing) + measured * smoothing : measured;
        hasVelocity = true;
      }
      lastMeasure = t;
      if (hasVelocity && topic === 'prediction')
        predictions.push({ madeAt: t, t: t + horizon, y: obs.y + velocity * horizon });
    }
    // A prediction can only be marked right or wrong once its target time has arrived.
    for (const prediction of predictions) {
      if (prediction.checked || t + EPSILON < prediction.t) continue;
      prediction.checked = true;
      const actualY = cartAt(prediction.t, config.motion).y;
      lastError = Math.abs(prediction.y - actualY);
      evaluation = {
        madeAt: prediction.madeAt,
        targetTime: prediction.t,
        predictedY: prediction.y,
        actualY,
        error: lastError,
      };
      errors.push(lastError);
    }
    if (config.motion === 'turn' && step === CART_TURN_STEP)
      events.push({
        t,
        kind: 'turn',
        label: copy.tracking.events.turnLabel,
        text: copy.tracking.events.turnText,
      });
    const predicted =
      hasVelocity && topic !== 'velocity'
        ? { x: obs.x, y: obs.y + velocity * horizon, targetTime: obs.t + horizon }
        : null;
    const relativeX = obs.x - x;
    const relativeY = obs.y + velocity * (t - obs.t) - y;
    let stopping = false;
    if (topic === 'crossing') {
      if (config.rule === 'predict') {
        const closingY = velocity;
        // Time within the horizon at which the two paths are closest.
        const nearest = clamp(
          -(relativeX * QUESTIX_REL_SPEED + relativeY * closingY) /
            (QUESTIX_REL_SPEED * QUESTIX_REL_SPEED + closingY * closingY || 1),
          0,
          horizon,
        );
        stopping =
          Math.hypot(relativeX + QUESTIX_REL_SPEED * nearest, relativeY + closingY * nearest) <
          PREDICTED_CLEARANCE;
      } else stopping = Math.hypot(relativeX, obs.y - y) < CURRENT_CLEARANCE;
      const distance = Math.hypot(cart.x - x, cart.y - y) - ROBOT_RADIUS_SUM;
      minDistance = Math.min(minDistance, distance);
      if (distance <= 0) {
        contact = true;
        stopping = true;
      }
      if (x >= CROSSING_GOAL_X) stopping = true;
      const nextV = clamp(
        v + (stopping ? -CROSSING_ACCEL : CROSSING_ACCEL) * dt,
        0,
        CROSSING_MAX_SPEED,
      );
      x += ((v + nextV) * dt) / 2;
      v = contact ? 0 : nextV;
    }
    const status = trackingStatus(topic, {
      contact,
      atGoal: x >= CROSSING_GOAL_X,
      stopping,
      hasVelocity,
    });
    if (samples.at(-1)?.status !== status) events.push({ t, text: status });
    samples.push({
      t,
      x,
      y,
      theta: 0,
      v,
      cart,
      obs: { ...obs },
      previousObs: previous ? { ...previous } : null,
      velocity: hasVelocity ? velocity : null,
      actualPosition: cart.y,
      observedPosition: obs.y,
      actualVelocity: config.motion === 'turn' && t >= CART_TURN_TIME ? CART_SPEED : -CART_SPEED,
      predicted,
      evaluation: evaluation ? { ...evaluation } : null,
      predictionError: lastError,
      separation: Math.max(0, Math.hypot(cart.x - x, cart.y - y) - ROBOT_RADIUS_SUM),
      status,
    });
    if (contact || (topic === 'crossing' && x >= CROSSING_GOAL_X && v === 0)) break;
  }
  const end = samples.at(-1);
  const success = topic === 'crossing' ? !contact && end.x >= CROSSING_GOAL_X : true;
  return {
    samples,
    events,
    success,
    metrics: trackingMetrics(topic, samples, errors, minDistance, end, contact),
    outcome: trackingOutcome(topic, config, success, contact),
  };
}

// --- coordination: frames, calibrate, feedback ------------------------------------------------

const COORDINATION_STEPS = 120;
const START_ANGLES = [100, -100]; // degrees
const JOINT_RATE = 45; // degrees per second
const REACHED_WITHIN = 8; // mm between the tip and the target
const FIRST_TARGET = { x: 185, z: 145 }; // mm from the shoulder
const MOVED_TARGET = { x: 220, z: 105 }; // mm; the object is moved at 2 s in the feedback topic
const TARGET_MOVES_AT = 2; // seconds

// The reachable solution closest to where the joints already are.
function nearestSolution(estimate, angles) {
  const distance = (solution) =>
    solution.q.reduce((sum, value, joint) => sum + (value - angles[joint]) ** 2, 0);
  return armIK(estimate, true)
    .solutions.filter((solution) => solution.allowed)
    .sort((a, b) => distance(a) - distance(b));
}

function coordination(topic, config) {
  const text = copy.coordination;
  const samples = [];
  const events = [];
  let angles = [...START_ANGLES];
  let estimate = null;
  let lastLook = -Infinity;
  for (let step = 0; step <= COORDINATION_STEPS; step++) {
    const t = step * dt;
    const target = topic === 'feedback' && t >= TARGET_MOVES_AT ? MOVED_TARGET : FIRST_TARGET;
    const reading = bodyToCamera(target);
    const looksAgain =
      topic === 'feedback' &&
      config.lookAgain === 'repeat' &&
      t - lastLook >= config.interval - EPSILON;
    if (!estimate || looksAgain) {
      // Without the transform the camera reading is used as if it were a shoulder coordinate.
      estimate =
        topic === 'frames' && !config.transform
          ? { ...reading }
          : cameraToBody(reading, topic === 'feedback' ? FITTED_CAMERA : config);
      lastLook = t;
      events.push({ t, text: text.events.lookedAgain });
    }
    const solutions = nearestSolution(estimate, angles);
    if (solutions.length)
      angles = angles.map(
        (value, joint) =>
          clamp(solutions[0].q[joint] - value, -JOINT_RATE * dt, JOINT_RATE * dt) + value,
      );
    const pose = armFK(angles);
    samples.push({
      t,
      q: [...angles],
      ...pose,
      target,
      estimate: { ...estimate },
      reading,
      error: Math.hypot(pose.tip.x - target.x, pose.tip.z - target.z),
      lastLook,
      status: solutions.length ? STATUS.coordination.approaching : STATUS.coordination.unreachable,
    });
  }
  const end = samples.at(-1);
  const success = end.error < REACHED_WITHIN;
  return {
    samples,
    events,
    success,
    metrics: [
      metric(text.metrics.tipToTarget, end.error, 'mm', 1),
      metric(
        text.metrics.estimateError,
        Math.hypot(end.estimate.x - end.target.x, end.estimate.z - end.target.z),
        'mm',
        1,
      ),
    ],
    outcome: success ? text.outcome.reached : text.outcome.missed,
  };
}

// --- timing: delay, alignment, queue ----------------------------------------------------------

const TIMING_STEPS = 220;
const WALL_X = 4; // m
const ROBOT_HALF_LENGTH = 0.18; // m from the centre to the front bumper
const STOP_RANGE = 0.6; // m; a range at or below this commands a stop
const TIMING_ACCEL = 1.2; // m/s²
const TIMING_DECEL = 3.2; // m/s²
const TIMING_MAX_SPEED = 0.8; // m/s
const TARGET_GAP = 0.5; // m short of the wall the robot aims to stop
const GOOD_GAP = 0.16; // m; how far from the target gap still counts as a success
const MAP_TOLERANCE = 0.05; // m of map error the alignment topic accepts

function timingStatus({ contact, stop, v, last }) {
  if (contact) return STATUS.contact;
  if (stop) return v ? STATUS.timing.slowing : STATUS.stopped;
  return last ? STATUS.driving : STATUS.timing.waitingFirstData;
}

function timingMetrics(topic, samples, end, maxWallError) {
  const text = copy.timing.metrics;
  const shared = [
    metric(text.wallDistance, end.range, 'm'),
    metric(text.maxAge, Math.max(...samples.map((sample) => sample.age)), '秒'),
  ];
  if (topic === 'alignment') return [...shared, metric(text.maxWallError, maxWallError, 'm')];
  if (topic === 'queue')
    return [
      ...shared,
      metric(text.maxQueue, Math.max(...samples.map((sample) => sample.queue)), '件', 0),
    ];
  return [...shared, metric(text.gapError, Math.abs(end.range - TARGET_GAP), 'm')];
}

function timingOutcome(topic, config, contact, maxWallError) {
  const text = copy.timing.outcome;
  if (topic === 'alignment') return maxWallError < EPSILON ? text.alignedWall : text.misalignedWall;
  if (contact) {
    if (topic !== 'queue') return text.delayContact;
    return config.queue === 'latest' ? text.latestContact : text.queueContact;
  }
  if (topic === 'queue') return text.queueStopped;
  return config.compensate ? text.compensated : text.stopped;
}

function timing(topic, config) {
  const text = copy.timing.events;
  const samples = [];
  const events = [];
  const transit = []; // measured, not yet received
  const queue = []; // received, not yet processed
  let x = 0.35;
  let v = 0;
  let last = null; // the measurement the robot is currently deciding on
  let nextProcess = 0;
  let stop = false;
  let contact = false;
  const latency = config.latency ?? 0;
  const processing = config.processing ?? 20;
  for (let step = 0; step <= TIMING_STEPS; step++) {
    const t = step * dt;
    // Advance from the previous decision to this timestamp before measuring.
    // This keeps the measured position, range and displayed clock on the same instant.
    if (step > 0) {
      const nextV = clamp(
        v + (stop || !last ? -TIMING_DECEL : TIMING_ACCEL) * dt,
        0,
        TIMING_MAX_SPEED,
      );
      const nextX = x + ((v + nextV) * dt) / 2;
      if (nextX >= WALL_X - ROBOT_HALF_LENGTH) {
        contact = true;
        stop = true;
        x = WALL_X - ROBOT_HALF_LENGTH;
        v = 0;
        events.push({ t, kind: 'contact', text: text.contactText });
      } else {
        x = nextX;
        v = nextV;
      }
    }
    transit.push({ stamp: t, receive: t + latency, x, range: WALL_X - x });
    while (transit.length && transit[0].receive <= t + EPSILON) queue.push(transit.shift());
    if (t >= nextProcess - EPSILON) {
      if (queue.length) {
        const takeLatest = topic === 'queue' && config.queue === 'latest';
        last = takeLatest ? queue.at(-1) : queue[0];
        if (takeLatest) queue.length = 0;
        else queue.shift();
      }
      nextProcess += 1 / processing;
    }
    const compensating = config.compensate || topic === 'alignment';
    const usedRange = last ? last.range - (compensating ? x - last.x : 0) : null;
    const mapBaseX = last ? (topic === 'alignment' && config.align === 'stamp' ? last.x : x) : null;
    const wallEstimate = last ? mapBaseX + last.range : null;
    if (last && usedRange <= STOP_RANGE && !stop) {
      stop = true;
      events.push({
        t,
        kind: 'stop-command',
        label: text.stopLabel,
        text: text.stopText,
      });
    }
    samples.push({
      t,
      x,
      v,
      range: WALL_X - x,
      usedRange,
      rawRange: last?.range ?? null,
      measuredX: last?.x ?? null,
      mapBaseX,
      wallEstimate,
      wallError: wallEstimate === null ? null : wallEstimate - WALL_X,
      age: last ? t - last.stamp : 0,
      stamp: last?.stamp ?? null,
      receive: last?.receive ?? null,
      queue: queue.length,
      stop,
      contact,
      status: timingStatus({ contact, stop, v, last }),
    });
    if (contact || (stop && v === 0 && t > 1)) break;
  }
  const end = samples.at(-1);
  const maxWallError = Math.max(...samples.map((sample) => Math.abs(sample.wallError ?? 0)));
  const success =
    topic === 'alignment'
      ? maxWallError < MAP_TOLERANCE
      : !contact && Math.abs(end.range - TARGET_GAP) < GOOD_GAP;
  return {
    samples,
    events,
    success,
    metrics: timingMetrics(topic, samples, end, maxWallError),
    outcome: timingOutcome(topic, config, contact, maxWallError),
  };
}

// --- diagnostics: distance, missing, impact ---------------------------------------------------

const DIAGNOSTICS_STEPS = 200;
const SHELF_X = 3.2; // m; the shelf the depth camera sees
const IMPACT_OBSTACLE_X = 8; // m; far away, so the impact run is never about a collision
const DIAGNOSTICS_WALL_X = 4; // m; what the LiDAR sees over the shelf
const DATA_LOSS_STEP = 30; // step index at which the event is recorded
const DATA_LOSS_TIME = 1.5; // seconds; no new range arrives from here on
const SHOCK_STEP = 40; // step index; the event is played at 2.0 s
const SHOCK_TIME = 2; // seconds
const SHOCK_DURATION = 0.15; // seconds
const BUMP_PEAK = 5.2; // m/s²
const IMPACT_PEAK = 16; // m/s²
const DIAGNOSTICS_ACCEL = 1.2; // m/s²
const DIAGNOSTICS_MAX_SPEED = 0.6; // m/s
const CRUISE_ACCEL_UNTIL = 0.6; // m/s; the robot accelerates up to this speed
const RECORDED_STOP_RANGE = 0.6; // m; the stored range that commands a stop in the missing topic
const IMPACT_RUN_TIME = 4; // seconds

const eventName = (eventType) =>
  eventType === 'bump' ? copy.diagnostics.eventNames.bump : copy.diagnostics.eventNames.impact;

function diagnosticsStatus({ contact, latched, v }) {
  if (contact) return STATUS.contact;
  if (latched) return v ? STATUS.diagnostics.stopSlowing : STATUS.diagnostics.holding;
  return STATUS.driving;
}

// The first condition that matched, or '' while the robot is still free to drive.
function stopReason(topic, config, { lidar, depth, lastRange, age, accel }) {
  const text = copy.diagnostics.stopReasons;
  let reason = '';
  if (topic === 'distance') {
    const used = Math.min(lidar, config.sensorRule === 'both' ? depth : Infinity);
    if (used <= config.stopDistance) reason = text.tooClose;
  }
  if (topic === 'missing') {
    if (config.watchdog && age > config.staleLimit) reason = text.dataStale;
    if (lastRange <= RECORDED_STOP_RANGE) reason = text.recordedTooClose;
  }
  if (topic === 'impact' && Math.abs(accel) >= config.impactLimit) reason = text.imuThreshold;
  return reason;
}

function diagnosticsMetrics(topic, config, samples, end, latched, contact) {
  const text = copy.diagnostics.metrics;
  if (topic === 'impact')
    return [
      metric(text.assumedEvent, eventName(config.eventType)),
      metric(text.stopDecision, latched ? 'あり' : 'なし'),
      metric(
        text.maxAcceleration,
        Math.max(...samples.map((sample) => Math.abs(sample.accel))),
        'm/秒²',
      ),
    ];
  const third =
    topic === 'distance'
      ? metric(
          text.stopCommandTime,
          samples.find((sample) => sample.latched)?.t ?? text.noStopCommand,
          '秒',
        )
      : metric(text.lastDataAge, end.age, '秒');
  return [
    metric(text.stopDecision, latched ? 'あり' : 'なし'),
    metric(text.contact, contact ? 'あり' : 'なし'),
    third,
  ];
}

function impactOutcome(config, latched) {
  const text = copy.diagnostics.outcome;
  if (config.eventType === 'bump') return latched ? text.bumpStopped : text.bumpPassed;
  return latched ? text.impactStopped : text.impactMissed;
}

function contactOutcome(topic, config, latched) {
  const text = copy.diagnostics.outcome;
  if (topic === 'missing') return text.missingContact;
  if (config.sensorRule !== 'lidar') return text.stopTooLate;
  return latched ? text.lidarLatchedContact : text.lidarMissedShelf;
}

function diagnosticsOutcome(topic, config, latched, contact) {
  const text = copy.diagnostics.outcome;
  if (topic === 'impact') return impactOutcome(config, latched);
  if (contact) return contactOutcome(topic, config, latched);
  if (topic === 'missing') return text.missingStopped;
  return text.distanceStopped;
}

function diagnostics(topic, config) {
  const text = copy.diagnostics.events;
  const samples = [];
  const events = [];
  let x = 0.4;
  let v = 0;
  let lastRange = 2.8;
  let lastStamp = 0;
  let latched = false;
  let reason = '';
  let contact = false;
  const obstacle = topic === 'impact' ? IMPACT_OBSTACLE_X : SHELF_X;
  for (let step = 0; step <= DIAGNOSTICS_STEPS; step++) {
    const t = step * dt;
    // The LiDAR beam passes under the shelf and reaches the far wall; the camera sees the shelf.
    const lidar = (topic === 'distance' ? DIAGNOSTICS_WALL_X : obstacle) - x;
    const depth = obstacle - x;
    if (topic === 'missing' && step === DATA_LOSS_STEP)
      events.push({
        t,
        kind: 'data-loss',
        label: text.dataLossLabel,
        text: text.dataLossText,
      });
    if (topic === 'impact' && step === SHOCK_STEP)
      events.push({
        t,
        x,
        kind: 'shock',
        label: eventName(config.eventType),
        text: fill(text.shockText, { event: eventName(config.eventType) }),
      });
    if (topic !== 'missing' || t < DATA_LOSS_TIME) {
      lastRange = lidar;
      lastStamp = t;
    }
    const shock =
      topic === 'impact' && t >= SHOCK_TIME && t < SHOCK_TIME + SHOCK_DURATION
        ? config.eventType === 'impact'
          ? IMPACT_PEAK
          : BUMP_PEAK
        : 0;
    const driving = v < CRUISE_ACCEL_UNTIL && !latched ? DIAGNOSTICS_ACCEL : 0;
    const slowing = latched && v > 0 ? -DIAGNOSTICS_ACCEL : 0;
    const accel = shock || driving || slowing;
    const age = t - lastStamp;
    if (!latched) {
      reason = stopReason(topic, config, { lidar, depth, lastRange, age, accel }) || reason;
      if (reason) {
        latched = true;
        events.push({ t, text: fill(text.latched, { reason }) });
      }
    }
    const nextV = clamp(
      v + (latched ? -DIAGNOSTICS_ACCEL : DIAGNOSTICS_ACCEL) * dt,
      0,
      DIAGNOSTICS_MAX_SPEED,
    );
    x += ((v + nextV) * dt) / 2;
    v = nextV;
    if (x + ROBOT_HALF_LENGTH >= obstacle) {
      contact = true;
      x = obstacle - ROBOT_HALF_LENGTH;
      v = 0;
      events.push({ t, kind: 'contact', text: text.contactText });
    }
    samples.push({
      t,
      x,
      v,
      lidar,
      depth,
      range: lastRange,
      age,
      accel,
      latched,
      reason,
      contact,
      status: diagnosticsStatus({ contact, latched, v }),
    });
    if (contact) break;
    if (topic === 'impact' ? t >= IMPACT_RUN_TIME : latched && v === 0) break;
  }
  const end = samples.at(-1);
  const success =
    topic === 'impact' ? (config.eventType === 'impact' ? latched : !latched) : latched && !contact;
  return {
    samples,
    events,
    success,
    metrics: diagnosticsMetrics(topic, config, samples, end, latched, contact),
    outcome: diagnosticsOutcome(topic, config, latched, contact),
  };
}

// --- entry points ------------------------------------------------------------------------------

const SIMULATIONS = { mechanics, behavior, tracking, coordination, timing, diagnostics };

// A stop that has latched is released by the operator, not by the sensor reading coming back.
function canRestart(latched, causeCleared, operatorRequest) {
  return Boolean(latched && causeCleared && operatorRequest);
}

function simulateSystem(course, topic, input = {}) {
  const config = validateSystemConfig(course, topic, input);
  const run = SIMULATIONS[course](topic, config);
  return { course, topic, config, ...run, duration: run.samples.at(-1).t };
}

// The whole time series, with nested readings flattened to one column each.
function systemCSV(run) {
  const flatten = (value, prefix = '', out = {}) => {
    for (const [key, entry] of Object.entries(value)) {
      const name = prefix ? prefix + '.' + key : key;
      if (entry !== null && typeof entry === 'object') flatten(entry, name, out);
      else out[name] = entry;
    }
    return out;
  };
  const rows = run.samples.map((sample) => flatten(sample));
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (value) =>
    typeof value === 'string' ? '"' + value.replaceAll('"', '""') + '"' : (value ?? '');
  return [
    '# QUESTiX LAB simulation ' + run.course + '/' + run.topic,
    '# config ' + JSON.stringify(run.config),
    '# units: time=s; position=' +
      (run.course === 'coordination' ? 'mm' : 'm') +
      '; velocity=m/s; wheel_rate=rpm; force=N; acceleration=m/s^2; arm_angles=deg; heading=rad',
    keys.join(','),
    ...rows.map((row) => keys.map((key) => cell(row[key])).join(',')),
  ].join('\n');
}

export {
  validateSystemConfig,
  cameraToBody,
  bodyToCamera,
  calibrationPairs,
  fitCameraTransform,
  canRestart,
  simulateSystem,
  systemCSV,
};
