// Motor course: maths only. No DOM, no window — importable from Node and unit-tested in
// test/motor-core.test.mjs.
//
// Educational models that make one relation visible each (a turning field, load and current,
// gearing, KV, a servo holding an angle). They are not fitted to the products named in the
// course: product ratings (MOTOR_HARDWARE) are reference data the learner reads, never model
// parameters. Learner-facing sentences are in content/motor.json.

// Topics in reading order; `group` is the step of the course they belong to (MOTOR_GROUPS in the
// content file).
const MOTOR_TOPICS = [
  { id: 'field', group: 0 },
  { id: 'load', group: 0 },
  { id: 'transmission', group: 0 },
  { id: 'esc', group: 1 },
  { id: 'servo', group: 1 },
  { id: 'choose', group: 1 },
  { id: 'real', group: 2 },
];
// Topics with a 6-second experiment that is played back.
const PLAYED_TOPICS = ['field', 'load', 'esc', 'servo'];

// Nominal ratings of the parts on QUESTiX, as the course quotes them (checked 2026-09-24).
const MOTOR_HARDWARE = Object.freeze({
  drive: {
    model: 'DDT M0602C_112',
    voltage: 18, // V
    ratedRpm: 200,
    ratedTorque: 0.55, // N·m
    ratedCurrent: 1.45, // A
    source: 'https://www.switch-science.com/products/7647',
  },
  roller: { model: 'C4250', kv: 560 }, // rpm per volt, from the parts list of the robot
  esc: {
    model: 'T-MOTOR AIR 40A 6S',
    maxCells: 6,
    current: 40, // A
    source: 'https://store.tmotor.com/jp/product/air-40a-6s-esc.html',
  },
  servo: {
    model: 'FEETECH SM-2924-C012',
    ratedTorque: 0.588399, // N·m (6 kgf·cm at 24 V)
    stallTorque: 1.96133, // N·m (20 kgf·cm at 24 V)
    source: 'https://www.feetechrc.com/559926.html',
  },
});

const RUN_SECONDS = 6;
const LOAD_TIME = 3; // seconds: when the load (or the push on the servo) starts
const STEP = 0.002; // seconds per integration step
const SAMPLE_EVERY = 10; // integration steps per stored sample (every 0.02 s)
const RPM_PER_RAD_PER_SECOND = 60 / (2 * Math.PI);
const DEGREES_PER_RADIAN = 180 / Math.PI;

// Load topic: the target the learner tunes the power for, after the load has been added.
const LOAD_TARGET = Object.freeze({ rpm: 600, tolerance: 60 });
const LOAD_MAX_VOLTS = 8; // V at 100 % power in the model
const LOAD_MAX_CURRENT = 3; // A: a teaching limit, not a product's protection setting
const COIL_RESISTANCE = 2; // Ω, for the I²R heating

// Transmission topic: one motor operating point, a 5 cm wheel and the goal to reach.
const GEAR_RATIOS = [1, 3, 6];
const GEAR_MOTOR_RPM = 600;
const GEAR_MOTOR_TORQUE = 0.1; // N·m
const GEAR_EFFICIENCY = 0.85; // the gear pair loses 15 %
const WHEEL_RADIUS = 0.05; // m
const GEAR_TARGET = Object.freeze({ force: 5, speed: 0.8 }); // N, m/s
const PINION_TEETH = 12;

// ESC topic: the illustrative lag and the speed lost under the roller's load.
const ESC_KV = MOTOR_HARDWARE.roller.kv;
const ESC_LAG = 0.7; // s
const ESC_LOAD_DROP = 0.18; // share of the speed lost once the disc load is on
const LIPO_CELL_VOLTS = 3.7;

// Servo topic.
const SERVO_MIN = 30; // degrees
const SERVO_MAX = 120;
const SERVO_PUSH = 0.12; // N·m pushing clockwise from 3 s on

// Which job each instruction suits, in the choose topic.
const CHOICE_ANSWERS = Object.freeze({ drive: 'speed', roller: 'drive', feeder: 'angle' });
const REAL_PARTS = ['drive', 'roller', 'feeder'];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Settings a topic starts with; the learner changes them in the guide. */
function motorDefaults() {
  return {
    mode: 'fixed', // field: 'fixed' | 'rotate'
    direction: 1, // field: 1 counter-clockwise, -1 clockwise
    power: 60, // load: percent
    load: 0.08, // load: N·m added at 3 s
    ratio: 1, // transmission
    voltage: 14.8, // esc: V
    throttle: 50, // esc: percent
    loaded: true, // esc: the roller's load comes on at 3 s
    target: 90, // servo: degrees
    feedback: true, // servo: keep correcting after arriving
    part: 'drive', // real
  };
}

/** Wheel side of the transmission topic for a reduction `ratio` (1, 3 or 6). */
function transmissionValues(ratio = 1) {
  const used = GEAR_RATIOS.includes(Number(ratio)) ? Number(ratio) : 1;
  const efficiency = used === 1 ? 1 : GEAR_EFFICIENCY;
  const rpm = GEAR_MOTOR_RPM / used;
  const torque = GEAR_MOTOR_TORQUE * used * efficiency; // N·m at the wheel
  const force = torque / WHEEL_RADIUS; // N pushing on the floor
  const speed = rpm * 2 * Math.PI * (WHEEL_RADIUS / 60); // m/s
  const power = (torque * rpm) / RPM_PER_RAD_PER_SECOND; // W
  return {
    ratio: used,
    efficiency,
    rpm,
    torque,
    force,
    speed,
    power,
    teeth: PINION_TEETH * used,
    forceOk: force >= GEAR_TARGET.force - 1e-9,
    speedOk: speed >= GEAR_TARGET.speed - 1e-9,
  };
}

/** No-load speed estimate: KV (rpm per volt) × volts. */
const kvSpeed = (kv, voltage) => kv * voltage;

/** Number of LiPo cells in series for a nominal pack voltage (14.8 V → 4). */
const lipoCells = (voltage) => Math.round(voltage / LIPO_CELL_VOLTS);

/** `{drive, roller, feeder}` → whether each chosen instruction suits that job. */
function evaluateMotorChoices(values = {}) {
  return Object.fromEntries(
    Object.entries(CHOICE_ANSWERS).map(([key, answer]) => [key, values[key] === answer]),
  );
}

// One integration step per topic. `state` = { angle, omega, integral } (rad, rad/s, rad·s).
function stepField(config, state, time) {
  const field = config.mode === 'fixed' ? Math.PI / 2 : config.direction * time * 1.3;
  const torque = 0.08 * Math.sin(field - state.angle);
  state.omega += ((torque - 0.04 * state.omega) / 0.012) * (time ? STEP : 0);
  state.angle += state.omega * (time ? STEP : 0);
  return { field, torque };
}

function stepLoad(config, state, time) {
  const voltage = (LOAD_MAX_VOLTS * clamp(config.power, 0, 100)) / 100;
  const load = time >= LOAD_TIME ? clamp(config.load, 0, 0.15) : 0;
  // Turning, the motor makes a voltage against the supply (back-EMF), so a slower motor draws more.
  const current = clamp((voltage - 0.06 * state.omega) / COIL_RESISTANCE, 0, LOAD_MAX_CURRENT);
  const torque = 0.06 * current;
  state.omega = Math.max(
    0,
    state.omega + ((torque - load - 0.00025 * state.omega) / 0.0015) * STEP,
  );
  state.angle += state.omega * (time ? STEP : 0);
  return { current, torque, load };
}

// Illustrative lag and load drop, NOT a measured C4250 curve or an AIR 40A current limit.
function stepEsc(config, state, time) {
  const reference = (kvSpeed(ESC_KV, config.voltage) * clamp(config.throttle, 0, 100)) / 100;
  const load = config.loaded && time >= LOAD_TIME ? ESC_LOAD_DROP : 0;
  const target = (reference * (1 - load)) / RPM_PER_RAD_PER_SECOND;
  state.omega += ((target - state.omega) * STEP) / ESC_LAG;
  state.angle += state.omega * (time ? STEP : 0);
  return { reference, load };
}

function stepServo(config, state, time) {
  const reference = clamp(config.target, SERVO_MIN, SERVO_MAX);
  const load = time >= LOAD_TIME ? SERVO_PUSH : 0;
  const error = reference / DEGREES_PER_RADIAN - state.angle;
  state.integral = clamp(state.integral + error * STEP, -0.5, 0.5);
  const holding = config.feedback || time < LOAD_TIME;
  const torque = holding
    ? clamp(2 * error + 1.4 * state.integral - 0.2 * state.omega, -0.5, 0.5)
    : 0;
  const dt = time ? STEP : 0;
  state.omega += ((torque - load - 0.09 * state.omega) / 0.025) * dt;
  state.angle += state.omega * dt;
  // The feed arm has end stops at 0° and 180°.
  if (state.angle < 0) {
    state.angle = 0;
    state.omega = Math.max(0, state.omega);
  }
  if (state.angle > Math.PI) {
    state.angle = Math.PI;
    state.omega = Math.min(0, state.omega);
  }
  return { reference, load, torque, current: Math.abs(torque) / 0.4 };
}

const STEPPERS = { field: stepField, load: stepLoad, esc: stepEsc, servo: stepServo };

/**
 * A 6-second run of a played topic: `{id, config, samples, duration}`, one sample every 0.02 s
 * with time (s), angle (rad), degrees, rpm, current (A), heating (W), torque (N·m), load,
 * field (rad, field topic) and reference (the servo's target in degrees, the ESC's KV estimate
 * in rpm).
 */
function simulateMotor(id, config = {}) {
  const stepper = STEPPERS[id];
  if (!stepper) throw new Error(`No experiment to run in topic ${id}`);
  const settings = { ...motorDefaults(), ...config };
  const state = { angle: 0, omega: 0, integral: 0 };
  const samples = [];
  const steps = Math.round(RUN_SECONDS / STEP);
  for (let k = 0; k <= steps; k++) {
    const time = k * STEP;
    const out = stepper(settings, state, time);
    if (k % SAMPLE_EVERY) continue;
    const current = out.current ?? 0;
    samples.push({
      time: Number(time.toFixed(3)),
      angle: state.angle,
      degrees: state.angle * DEGREES_PER_RADIAN,
      rpm: state.omega * RPM_PER_RAD_PER_SECOND,
      current,
      heating: current * current * COIL_RESISTANCE,
      torque: out.torque ?? 0,
      load: out.load ?? 0,
      field: out.field ?? 0,
      reference: out.reference ?? 0,
    });
  }
  return { id, config: settings, samples, duration: RUN_SECONDS };
}

// The sample just before the load comes on, and the last one.
const beforeLoad = (run) => run.samples.filter((sample) => sample.time < LOAD_TIME).at(-1);

/** The numbers a result sentence quotes for a finished run. */
function motorRunSummary(run) {
  const last = run.samples.at(-1);
  const before = beforeLoad(run);
  if (run.id === 'field')
    return {
      mode: run.config.mode,
      finalDegrees: last.degrees,
      turns: Math.abs(last.degrees) / 360,
    };
  if (run.id === 'load')
    return {
      beforeRpm: before.rpm,
      afterRpm: last.rpm,
      beforeCurrent: before.current,
      afterCurrent: last.current,
      afterHeating: last.heating,
      inTarget: Math.abs(last.rpm - LOAD_TARGET.rpm) <= LOAD_TARGET.tolerance,
    };
  if (run.id === 'esc')
    return {
      loaded: run.config.loaded,
      estimate: last.reference,
      beforeRpm: before.rpm,
      afterRpm: last.rpm,
      dropPercent: before.rpm > 0 ? (1 - last.rpm / before.rpm) * 100 : 0,
    };
  const after = run.samples.filter((sample) => sample.time >= LOAD_TIME);
  const deviation = Math.max(...after.map((sample) => Math.abs(sample.reference - sample.degrees)));
  return {
    feedback: run.config.feedback,
    target: last.reference,
    beforeDegrees: before.degrees,
    maxDeviation: deviation,
    finalDegrees: last.degrees,
    finalError: Math.abs(last.reference - last.degrees),
    holdingTorque: Math.abs(last.torque),
  };
}

const COIL_ON = 0.1; // share of full current below which a coil is drawn as off
const poleOf = (value) => (value > 0 ? 'S' : 'N');

/**
 * The four coils of the field figure at 0°, 90°, 180° and 270°: how strongly each is driven
 * (0–1) and which pole it shows towards the rotor (null while off). The coil the field points at is an S pole, so
 * it pulls the magnet's N end.
 */
function coilStates(field, powered) {
  return [0, 90, 180, 270].map((degrees) => {
    const value = powered ? Math.cos(field - degrees / DEGREES_PER_RADIAN) : 0;
    const strength = Math.abs(value);
    const on = strength > COIL_ON;
    return { degrees, strength, on, pole: on ? poleOf(value) : null };
  });
}

/** Poles at the ends of the close-up coil for a current of 1, -1 or 0 (off → null). */
function coilPoles(current) {
  if (!current) return null;
  return current > 0 ? { left: 'S', right: 'N' } : { left: 'N', right: 'S' };
}

export {
  MOTOR_TOPICS,
  PLAYED_TOPICS,
  MOTOR_HARDWARE,
  RUN_SECONDS,
  LOAD_TIME,
  LOAD_TARGET,
  GEAR_RATIOS,
  GEAR_MOTOR_RPM,
  GEAR_TARGET,
  PINION_TEETH,
  ESC_KV,
  SERVO_MIN,
  SERVO_MAX,
  REAL_PARTS,
  motorDefaults,
  transmissionValues,
  kvSpeed,
  lipoCells,
  evaluateMotorChoices,
  simulateMotor,
  motorRunSummary,
  coilStates,
  coilPoles,
};
