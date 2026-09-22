// Differential-drive robot world used by the RL, sensor and control lessons.
//
// Conventions shared with renderer.js and the course modules:
// - units are metres, seconds, radians and RPM;
// - map y grows downwards on the canvas, so headings are clockwise-positive: a positive
//   `omega` turns the robot to the right on screen, a negative bearing is to the robot's left;
// - `state` is a plain object that the RL lab reads and pokes directly (it latches the
//   emergency stop itself), so its field names are part of the public shape;
// - the seeded generator `rng` is consumed in a fixed order; every method below states
//   how many draws it makes so that changing one does not silently reshuffle an episode.
import { clamp, wrap, rpmToSpeed, speedToRpm, randomGenerator, gaussian } from './maths.js';
import {
  CONTROL_DT,
  PHYSICS_DT,
  SCAN_COUNT,
  DEFAULT_PHYSICS,
  DEFAULT_REWARD,
  COURSES,
} from './constants.js';

const ARENA_WIDTH = 4.8; // metres
const ARENA_HEIGHT = 3.2; // metres
/** Thick rectangles just outside the arena so rays and the camera stop at the walls. */
const ARENA_BOUNDARY_RECTS = [
  [-1, -1, 0, 5],
  [ARENA_WIDTH, -1, 6, 5],
  [-1, -1, 6, 0],
  [-1, ARENA_HEIGHT, 6, 5],
];
/** Goal disc per task; `theta` is the docking heading (facing right, along +x). */
const GOALS = {
  delivery: { x: 4.18, y: 0.62, theta: 0, radius: 0.2 },
  dock: { x: 4.05, y: 1.6, theta: 0, radius: 0.12 },
};
const MARKER_OFFSET_X = 0.3; // metres; the fiducial marker sits behind the goal
const MARKER_ID = { delivery: 'D-01', dock: 'C-01' };
const SUBSTEPS_PER_COMMAND = 10;
const EPISODE_TIME_LIMIT = 35; // seconds
const GOAL_HOLD_TIME = 0.5; // seconds the robot must rest inside the goal
const DOCK_ALIGNMENT_TOLERANCE = (8 * Math.PI) / 180; // radians
const STATIONARY_SPEED = 0.01; // m/s
const STATIONARY_YAW_RATE = 0.06; // rad/s
const GRAVITY = 9.81; // m/s²
const ACCELEROMETER_LIMIT = 156.96; // m/s², a ±16 g sensor
const MIN_MOTOR_LAG = 0.015; // seconds; keeps the first-order motor model stable

// Start pose: a narrow band on the left of the room ("near" start), widened by `range`.
const START_X_MIN = 0.55; // metres
const START_X_MAX = 0.77; // metres
const START_X_SPAN = 0.22; // metres; kept as a literal so results stay bit-identical
const NEAR_START_BAND = {
  delivery: { yMin: 2.45, yMax: 2.65, ySpan: 0.2 },
  dock: { yMin: 1.9, yMax: 2.5, ySpan: 0.6 },
};
const NEAR_START_HEADING_SPREAD = 0.7; // radians, total width of the heading spread
const VARIED_START_HEADING_MIN = 0.35; // radians, half-width of the heading spread at range 0
const START_CLEARANCE = 0.12; // metres of extra clearance around a random start
const START_GOAL_DISTANCE = 0.8; // metres; random starts stay this far from the goal
const RANDOM_START_ATTEMPTS = 1000;

// Sensors.
const LIDAR_RANGE = 3.2; // metres
const LIDAR_MIN_RANGE = 0.02; // metres
const SCAN_LEFT_INDEX = 21; // -45°: with clockwise-positive headings the left is negative
const SCAN_RIGHT_INDEX = 3; // +45°
const CAMERA_HALF_FOV = (55 * Math.PI) / 180; // radians
const CAMERA_RANGE = 5; // metres
const CAMERA_MIN_DISTANCE = 0.02; // metres
const CAMERA_DROPOUT = 0.015; // probability a visible marker is missed in one frame
const CAMERA_RANGE_NOISE = 1.5; // relative to the noise scale
const CAMERA_OCCLUSION_MARGIN = 0.01; // metres
const CAMERA_POSITION_GAIN = 0.25; // marker pose fusion gain per observation
const CAMERA_HEADING_GAIN = 0.15;
const GYRO_BIAS_SPREAD = 0.008; // rad/s, total width of the per-episode bias
const GYRO_NOISE = 0.3; // relative to the noise scale
const MAGNETOMETER_NOISE = 0.8; // relative to the noise scale
const ACCELEROMETER_NOISE = 4; // relative to the noise scale
const MAGNETIC_FIELD = 25; // µT horizontal component
const MAGNETIC_FIELD_DOWN = -40; // µT vertical component
const COMPASS_FUSION_GAIN = 0.012; // per physics sub-step
/** Kept as multiply-then-divide: `x * (180 / Math.PI)` rounds differently. */
const toDegrees = (radians) => (radians * 180) / Math.PI;

// A small compliant pitch/roll model; this is not a 3D rigid body solver.
const TILT_PER_ACCELERATION = 0.012; // radians per m/s²
const TILT_LIMIT = 0.08; // radians
const TILT_STIFFNESS = 50; // 1/s²
const TILT_DAMPING = 10; // 1/s

// Reward shaping.
const HEADING_REWARD_FALLOFF = 1.2; // per metre from the goal
const SETTLING_SPEED = 0.2; // m/s
const TURN_PENALTY = 0.025; // per rad/s
const REVERSE_PENALTY = 0.5; // per m/s of backing up
const CLEARANCE_PENALTY_RANGE = 0.4; // metres
const MOVING_SPEED = 0.06; // m/s
const NEAR_GOAL_DISTANCE = 0.6; // metres
const FINAL_DISTANCE_WEIGHT = 0.32;

function nearStartBand(task) {
  if (task === 'delivery') return NEAR_START_BAND.delivery;
  return NEAR_START_BAND.dock;
}

function initialState(pose) {
  return {
    x: pose.x,
    y: pose.y,
    theta: pose.theta,
    left: 0, // left wheel rim speed, m/s
    right: 0,
    targetL: 0, // commanded wheel RPM after the transport delay
    targetR: 0,
    v: 0, // forward speed, m/s
    omega: 0, // yaw rate, rad/s, clockwise-positive
    t: 0, // seconds
    hold: 0, // seconds spent resting inside the goal
    contact: false,
    latched: false, // emergency stop
    peak: 0, // largest measured |a| so far, m/s²
    total: 0, // accumulated reward
    done: false,
    success: false,
    wrongAngle: false,
    collisions: 0,
    ax: 0, // body-frame acceleration, m/s²
    ay: 0,
    estX: pose.x, // dead-reckoned pose (what the policy sees)
    estY: pose.y,
    estTheta: pose.theta,
    roll: 0,
    pitch: 0,
    rollRate: 0,
    pitchRate: 0,
  };
}

class World {
  constructor(task = 'delivery', rewards = {}, physics = {}) {
    this.task = task;
    this.settings = {
      ...DEFAULT_REWARD,
      ...rewards,
      enabled: { ...DEFAULT_REWARD.enabled, ...rewards.enabled },
    };
    this.physics = { ...DEFAULT_PHYSICS, ...physics };
    this.width = ARENA_WIDTH;
    this.height = ARENA_HEIGHT;
    this.goal = { ...(task === 'delivery' ? GOALS.delivery : GOALS.dock) };
    this.marker = { x: this.goal.x + MARKER_OFFSET_X, y: this.goal.y };
    this.course = Object.hasOwn(COURSES, this.physics.course) ? this.physics.course : 'standard';
    this.walls = COURSES[this.course][task].map((wall) => ({ ...wall }));
    this.rects = this.walls.map((wall) => [wall.x, wall.y, wall.x + wall.w, wall.y + wall.h]);
    this.rayRects = [...this.rects, ...ARENA_BOUNDARY_RECTS];
  }

  /**
   * Starts a new episode. Random draws, in order: actual physics (9 when randomising),
   * near start pose (3), optional random start, gyro bias (1), then the first observation.
   */
  reset(
    seed = 1,
    { other = false, startRange = 0, randomize = this.physics.randomize, initial } = {},
  ) {
    this.rng = randomGenerator(seed);
    this.actual = this.sampleActualPhysics(randomize);
    const pose = this.sampleStartPose({ other, startRange, initial });
    this.state = initialState(pose);
    this.queue = [];
    this.gyroBias = (this.rng() - 0.5) * GYRO_BIAS_SPREAD;
    this.camera = null;
    this.cameraCounter = 0;
    this.scanCounter = 0;
    this.observe(true);
    return this.state;
  }

  /** Per-episode variation of the nominal physics (manufacturing spread, floor grip). */
  sampleActualPhysics(randomize) {
    const rng = this.rng;
    const nominal = this.physics;
    const spread = (fraction) => (randomize ? 1 + (rng() * 2 - 1) * fraction : 1);
    return {
      radiusL: nominal.radius * spread(0.025),
      radiusR: nominal.radius * spread(0.025),
      track: nominal.track * spread(0.025),
      lag: nominal.motorLag * spread(0.3),
      latency: nominal.latency * spread(0.5),
      gripL: 1 - nominal.slip * spread(0.7),
      gripR: 1 - nominal.slip * spread(0.7),
      gainL: spread(0.03),
      gainR: spread(0.03),
    };
  }

  /** The near start is always drawn (3 draws) so later draws line up whatever the options. */
  sampleStartPose({ other, startRange, initial }) {
    const rng = this.rng;
    const band = nearStartBand(this.task);
    let x = START_X_MIN + rng() * START_X_SPAN;
    let y = band.yMin + rng() * band.ySpan;
    let theta = (rng() - 0.5) * NEAR_START_HEADING_SPREAD;
    if ((other || startRange > 0) && !initial) {
      const range = other ? 1 : clamp(startRange, 0, 1);
      ({ x, y } = this.randomStart(rng, range));
      const headingHalfWidth =
        VARIED_START_HEADING_MIN + (Math.PI - VARIED_START_HEADING_MIN) * range;
      theta = (rng() * 2 - 1) * headingHalfWidth;
    }
    if (initial) {
      x = initial.x;
      y = initial.y;
      theta = initial.theta;
    }
    return { x, y, theta };
  }

  /** Distance along a ray from (x, y) at `angle` to the nearest wall, capped at `max`. */
  ray(x, y, angle, max = LIDAR_RANGE) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let nearest = max;
    for (const [x0, y0, x1, y1] of this.rayRects) {
      // Slab test: the ray is inside the box between the largest entry and smallest exit.
      let entry = -Infinity;
      let exit = Infinity;
      if (Math.abs(dx) < 1e-9) {
        if (x < x0 || x > x1) continue;
      } else {
        const t0 = (x0 - x) / dx;
        const t1 = (x1 - x) / dx;
        entry = Math.max(entry, Math.min(t0, t1));
        exit = Math.min(exit, Math.max(t0, t1));
      }
      if (Math.abs(dy) < 1e-9) {
        if (y < y0 || y > y1) continue;
      } else {
        const t0 = (y0 - y) / dy;
        const t1 = (y1 - y) / dy;
        entry = Math.max(entry, Math.min(t0, t1));
        exit = Math.min(exit, Math.max(t0, t1));
      }
      if (exit >= Math.max(0, entry) && entry >= 0) nearest = Math.min(nearest, entry);
    }
    return nearest;
  }

  /** Rectangle of allowed start positions: the near band at range 0, the whole room at 1. */
  startBounds(range = 0) {
    const margin = this.physics.bodyRadius + START_CLEARANCE;
    const t = clamp(range, 0, 1);
    const band = nearStartBand(this.task);
    return {
      x0: START_X_MIN + (margin - START_X_MIN) * t,
      x1: START_X_MAX + (this.width - margin - START_X_MAX) * t,
      y0: band.yMin + (margin - band.yMin) * t,
      y1: band.yMax + (this.height - margin - band.yMax) * t,
    };
  }

  /** Rejection-samples a free start position (2 draws per attempt). */
  randomStart(rng = this.rng, range = 1) {
    const bounds = this.startBounds(range);
    for (let attempt = 0; attempt < RANDOM_START_ATTEMPTS; attempt++) {
      const x = bounds.x0 + rng() * (bounds.x1 - bounds.x0);
      const y = bounds.y0 + rng() * (bounds.y1 - bounds.y0);
      const clear = !this.blocked(x, y, START_CLEARANCE);
      if (clear && Math.hypot(x - this.goal.x, y - this.goal.y) > START_GOAL_DISTANCE)
        return { x, y };
    }
    throw new Error('No clear start position found');
  }

  /** True when a chassis centred at (x, y) would overlap a wall or leave the arena. */
  blocked(x, y, clearance = 0) {
    const radius = this.physics.bodyRadius + clearance;
    if (x < radius || x > this.width - radius || y < radius || y > this.height - radius)
      return true;
    for (const [x0, y0, x1, y1] of this.rects) {
      const dx = x - clamp(x, x0, x1);
      const dy = y - clamp(y, y0, y1);
      if (dx * dx + dy * dy < radius * radius) return true;
    }
    return false;
  }

  distanceToGoal() {
    return Math.hypot(this.goal.x - this.state.x, this.goal.y - this.state.y);
  }

  headingErrorToGoal() {
    return Math.abs(wrap(this.state.theta - this.goal.theta));
  }

  /**
   * Builds the sensor observation for the current state. `fresh` skips the marker pose fusion
   * on the first observation of an episode. Draws: IMU (10), scan (48), camera (1 + 6).
   */
  observe(fresh = false) {
    this.imu = this.measureImu();
    const scan = this.measureScan();
    const visible = this.measureMarker();
    // Marker pose is a simulated camera measurement, not a policy access to ground truth.
    if (visible && !fresh) this.fuseMarkerPose();
    const state = this.state;
    this.observation = {
      scan,
      front: scan[0],
      left: scan[SCAN_LEFT_INDEX],
      right: scan[SCAN_RIGHT_INDEX],
      camera: { ...this.camera },
      imu: this.imu,
      odometry: { x: state.estX, y: state.estY, theta: state.estTheta },
      wheelRpm: [
        speedToRpm(state.left, this.physics.radius),
        speedToRpm(state.right, this.physics.radius),
      ],
      goal: { ...this.goal },
      task: this.task,
    };
    return this.observation;
  }

  /** Accelerometer in m/s², gyro in deg/s and magnetometer in µT; the yaw is the dead-reckoned one. */
  measureImu() {
    const state = this.state;
    const rng = this.rng;
    const imuNoise = () => gaussian(rng) * this.physics.noise;
    // The gyro sign is flipped: it reports counter-clockwise-positive like a real IMU.
    const yawRate = -state.omega + this.gyroBias + imuNoise() * GYRO_NOISE;
    const magneticTheta = state.theta + imuNoise() * MAGNETOMETER_NOISE;
    const pitch = state.pitch;
    const roll = state.roll;
    const accel = [
      state.ax + GRAVITY * Math.sin(pitch) + imuNoise() * ACCELEROMETER_NOISE,
      state.ay - GRAVITY * Math.sin(roll) + imuNoise() * ACCELEROMETER_NOISE,
      GRAVITY * Math.cos(pitch) * Math.cos(roll) + imuNoise() * ACCELEROMETER_NOISE,
    ];
    return {
      accel,
      gyro: [toDegrees(state.rollRate), toDegrees(state.pitchRate), toDegrees(yawRate)],
      mag: [
        MAGNETIC_FIELD * Math.cos(magneticTheta),
        MAGNETIC_FIELD * Math.sin(magneticTheta),
        MAGNETIC_FIELD_DOWN,
      ],
      yaw: -state.estTheta,
      pitch: state.pitch,
      roll: state.roll,
    };
  }

  /** One lidar scan; ray i points at heading + i * 360° / SCAN_COUNT (clockwise on screen). */
  measureScan() {
    const state = this.state;
    const noise = this.physics.noise;
    return Array.from({ length: SCAN_COUNT }, (_, i) => {
      const distance = this.ray(state.x, state.y, state.theta + (i * 2 * Math.PI) / SCAN_COUNT);
      const error = gaussian(this.rng) * noise;
      if (distance >= LIDAR_RANGE) return LIDAR_RANGE;
      return clamp(distance + error, LIDAR_MIN_RANGE, LIDAR_RANGE);
    });
  }

  /** Detects the goal marker and stores the (noisy) camera reading; returns visibility. */
  measureMarker() {
    const state = this.state;
    const noise = this.physics.noise;
    const rng = this.rng;
    const dx = this.marker.x - state.x;
    const dy = this.marker.y - state.y;
    const distance = Math.hypot(dx, dy);
    const direction = Math.atan2(dy, dx);
    const bearing = wrap(direction - state.theta);
    const visible =
      Math.abs(bearing) < CAMERA_HALF_FOV &&
      distance < CAMERA_RANGE &&
      this.ray(state.x, state.y, direction, CAMERA_RANGE) >= distance - CAMERA_OCCLUSION_MARGIN &&
      (noise === 0 || rng() > CAMERA_DROPOUT);
    if (visible) {
      this.camera = {
        visible: true,
        id: this.task === 'delivery' ? MARKER_ID.delivery : MARKER_ID.dock,
        distance: Math.max(
          CAMERA_MIN_DISTANCE,
          distance + gaussian(rng) * noise * CAMERA_RANGE_NOISE,
        ),
        bearing: bearing + gaussian(rng) * noise,
        yaw: wrap(-state.theta + gaussian(rng) * noise),
        age: 0,
      };
    } else {
      this.camera = {
        visible: false,
        id: null,
        distance: null,
        bearing: null,
        yaw: null,
        age: (this.camera?.age || 0) + CONTROL_DT,
      };
    }
    return visible;
  }

  /** Pulls the dead-reckoned pose towards the pose implied by the marker measurement. */
  fuseMarkerPose() {
    const state = this.state;
    const camera = this.camera;
    const measuredTheta = -camera.yaw;
    const markerDirection = measuredTheta + camera.bearing;
    const measuredX = this.marker.x - camera.distance * Math.cos(markerDirection);
    const measuredY = this.marker.y - camera.distance * Math.sin(markerDirection);
    state.estX += CAMERA_POSITION_GAIN * (measuredX - state.estX);
    state.estY += CAMERA_POSITION_GAIN * (measuredY - state.estY);
    state.estTheta = wrap(
      state.estTheta + CAMERA_HEADING_GAIN * wrap(measuredTheta - state.estTheta),
    );
  }

  /**
   * Applies one control-period command ([left, right] in [-1, 1]) through ten physics
   * sub-steps, then refreshes the observation and computes the reward pieces.
   */
  step(command, { capture = false } = {}) {
    const state = this.state;
    if (state.done || state.latched) return this.idleStepResult();
    const previousDistance = this.distanceToGoal();
    const previousHeadingError = this.headingErrorToGoal();
    this.enqueueCommand(command);
    let collision = false;
    const impact = { magnitude: 0, ax: 0, ay: 0 };
    const traces = [];
    for (let k = 0; k < SUBSTEPS_PER_COMMAND; k++) {
      const sample = this.substep();
      if (sample.collided) collision = true;
      if (sample.magnitude > impact.magnitude) {
        impact.magnitude = sample.magnitude;
        impact.ax = sample.ax;
        impact.ay = sample.ay;
      }
      if (capture)
        traces.push({
          t: state.t,
          ax: sample.ax,
          ay: sample.ay,
          impact: sample.magnitude,
          emergency: state.latched,
        });
      if (state.done) break;
    }
    const arrival = this.updateArrival();
    if (collision || state.t >= EPISODE_TIME_LIMIT - 1e-9) state.done = true;
    this.observe();
    const pieces = this.rewardPieces({
      previousDistance,
      previousHeadingError,
      ...arrival,
      collision,
    });
    const reward = pieces.reduce((sum, piece) => sum + piece.value, 0);
    state.total += reward;
    return {
      state,
      reward,
      pieces,
      done: state.done,
      success: state.success,
      collision,
      emergency: state.latched,
      impact: impact.magnitude,
      axPeak: impact.ax,
      ayPeak: impact.ay,
      trace: traces,
      wrongAngle: state.wrongAngle,
    };
  }

  idleStepResult() {
    const state = this.state;
    return {
      state,
      reward: 0,
      done: true,
      success: state.success,
      emergency: state.latched,
      trace: [],
    };
  }

  /** Commands reach the motors after the transport delay `actual.latency`. */
  enqueueCommand(command) {
    this.queue.push({
      at: this.state.t + this.actual.latency,
      left: clamp(command[0]) * this.physics.maxRpm,
      right: clamp(command[1]) * this.physics.maxRpm,
    });
  }

  /**
   * One physics sub-step of PHYSICS_DT. Draws: accelerometer (4), gyro (2), compass (2).
   * Returns the measured accelerations for the impact display and whether a new contact began.
   */
  substep() {
    const state = this.state;
    this.applyDueCommands();
    const previousV = state.v;
    this.updateWheelSpeeds();
    const collided = this.moveBody();
    state.ax = (state.v - previousV) / PHYSICS_DT;
    state.ay = -state.v * state.omega; // centripetal, body frame
    const sample = this.measureAcceleration();
    state.peak = Math.max(state.peak, sample.magnitude);
    this.updateTilt();
    this.deadReckon();
    state.t += PHYSICS_DT;
    if (sample.magnitude >= this.settings.threshold) this.latchEmergencyStop();
    // Ten of these run per command, so the reading is extended in place rather than copied.
    sample.collided = collided;
    return sample;
  }

  applyDueCommands() {
    const state = this.state;
    while (this.queue.length && this.queue[0].at <= state.t + 1e-9) {
      const command = this.queue.shift();
      state.targetL = command.left;
      state.targetR = command.right;
    }
  }

  /** First-order motor lag towards the target rim speed, limited by the acceleration cap. */
  updateWheelSpeeds() {
    const state = this.state;
    const actual = this.actual;
    const nominal = this.physics;
    const dt = PHYSICS_DT;
    const desiredL = rpmToSpeed(state.targetL * actual.gainL, actual.radiusL);
    const desiredR = rpmToSpeed(state.targetR * actual.gainR, actual.radiusR);
    const maxDelta = rpmToSpeed(nominal.accelRpm, nominal.radius) * dt;
    const lag = Math.max(MIN_MOTOR_LAG, actual.lag);
    state.left += clamp(((desiredL - state.left) * dt) / lag, -maxDelta, maxDelta);
    state.right += clamp(((desiredR - state.right) * dt) / lag, -maxDelta, maxDelta);
  }

  /**
   * Unicycle kinematics with wheel slip. Moving into a wall stops the robot dead (v, omega and
   * both wheels go to zero). Returns true when this sub-step began a new contact.
   */
  moveBody() {
    const state = this.state;
    const actual = this.actual;
    const dt = PHYSICS_DT;
    const groundL = state.left * actual.gripL;
    const groundR = state.right * actual.gripR;
    let v = (groundL + groundR) / 2;
    // Left faster than right turns clockwise on screen, which is positive omega here.
    let omega = (groundL - groundR) / actual.track;
    const midHeading = state.theta + (omega * dt) / 2;
    const nextX = state.x + Math.cos(midHeading) * v * dt;
    const nextY = state.y + Math.sin(midHeading) * v * dt;
    const contact = this.blocked(nextX, nextY);
    let collided = false;
    if (contact) {
      v = 0;
      omega = 0;
      state.left = 0;
      state.right = 0;
      if (!state.contact) {
        collided = true;
        state.collisions++;
      }
    } else {
      state.x = nextX;
      state.y = nextY;
      state.theta = wrap(state.theta + omega * dt);
    }
    state.contact = contact;
    state.v = v;
    state.omega = omega;
    return collided;
  }

  /** Noisy, saturating accelerometer reading of the body-frame acceleration (2 gaussians). */
  measureAcceleration() {
    const state = this.state;
    const noise = this.physics.noise;
    const ax = clamp(
      state.ax + gaussian(this.rng) * noise * ACCELEROMETER_NOISE,
      -ACCELEROMETER_LIMIT,
      ACCELEROMETER_LIMIT,
    );
    const ay = clamp(
      state.ay + gaussian(this.rng) * noise * ACCELEROMETER_NOISE,
      -ACCELEROMETER_LIMIT,
      ACCELEROMETER_LIMIT,
    );
    return { ax, ay, magnitude: Math.hypot(ax, ay) };
  }

  /** Damped spring towards the tilt caused by acceleration (see the tilt constants). */
  updateTilt() {
    const state = this.state;
    const dt = PHYSICS_DT;
    const targetPitch = clamp(-state.ax * TILT_PER_ACCELERATION, -TILT_LIMIT, TILT_LIMIT);
    const targetRoll = clamp(-state.ay * TILT_PER_ACCELERATION, -TILT_LIMIT, TILT_LIMIT);
    state.pitchRate +=
      (TILT_STIFFNESS * (targetPitch - state.pitch) - TILT_DAMPING * state.pitchRate) * dt;
    state.pitch += state.pitchRate * dt;
    state.rollRate +=
      (TILT_STIFFNESS * (targetRoll - state.roll) - TILT_DAMPING * state.rollRate) * dt;
    state.roll += state.rollRate * dt;
  }

  /** Integrates the gyro (with a compass correction) and the wheel encoders (2 gaussians). */
  deadReckon() {
    const state = this.state;
    const noise = this.physics.noise;
    const dt = PHYSICS_DT;
    const measuredGyro = -state.omega + this.gyroBias + gaussian(this.rng) * noise * GYRO_NOISE;
    state.estTheta = wrap(state.estTheta - measuredGyro * dt);
    const compass = state.theta + gaussian(this.rng) * noise;
    state.estTheta = wrap(state.estTheta + COMPASS_FUSION_GAIN * wrap(compass - state.estTheta));
    const encoderSpeed = (state.left + state.right) / 2;
    state.estX += Math.cos(state.estTheta) * encoderSpeed * dt;
    state.estY += Math.sin(state.estTheta) * encoderSpeed * dt;
  }

  /** The emergency stop cuts power and ends the episode; the RL lab does the same by hand. */
  latchEmergencyStop() {
    const state = this.state;
    state.latched = true;
    state.left = 0;
    state.right = 0;
    state.targetL = 0;
    state.targetR = 0;
    state.v = 0;
    state.omega = 0;
    this.queue = [];
    state.done = true;
  }

  /**
   * Counts the time spent resting inside the goal and ends the episode once it reaches
   * GOAL_HOLD_TIME. Docking also requires the heading unless `settings.orientation` is off.
   */
  updateArrival() {
    const state = this.state;
    const distance = this.distanceToGoal();
    const headingError = this.headingErrorToGoal();
    const stationary =
      Math.abs(state.v) < STATIONARY_SPEED && Math.abs(state.omega) < STATIONARY_YAW_RATE;
    const within = distance < this.goal.radius;
    const aligned = this.task === 'delivery' || headingError < DOCK_ALIGNMENT_TOLERANCE;
    const resting = within && stationary && (aligned || !this.settings.orientation);
    state.hold = resting ? state.hold + CONTROL_DT : 0;
    const rewarded = state.hold >= GOAL_HOLD_TIME;
    if (rewarded) {
      state.done = true;
      state.success = aligned;
      state.wrongAngle = !aligned;
    }
    return { distance, headingError, within, rewarded };
  }

  /** Reward terms of this step, each with the label shown in the RL lab's breakdown. */
  rewardPieces(stepFacts) {
    const { previousDistance, previousHeadingError, distance, headingError } = stepFacts;
    const { within, rewarded, collision } = stepFacts;
    const state = this.state;
    const weights = this.settings;
    const on = weights.enabled;
    const docking = this.task === 'dock' && weights.orientation;
    const progress = on.progress ? (previousDistance - distance) * weights.progress : 0;
    const orientation =
      on.heading && docking
        ? (previousHeadingError - headingError) *
          weights.heading *
          Math.exp(-distance * HEADING_REWARD_FALLOFF)
        : 0;
    const settling =
      on.settling && within
        ? (1 - Math.min(1, Math.abs(state.v) / SETTLING_SPEED)) * CONTROL_DT * weights.settling
        : 0;
    const speedPenalty = on.careful
      ? (Math.abs(state.omega) * TURN_PENALTY * CONTROL_DT +
          Math.max(0, -state.v) * REVERSE_PENALTY * CONTROL_DT) *
        weights.careful
      : 0;
    const pieces = [
      { text: '目標への接近', value: progress },
      { text: '経過時間', value: on.time ? -weights.time * CONTROL_DT : 0 },
      { text: '向き・停止', value: orientation + settling },
      { text: '旋回・後退', value: -speedPenalty },
    ];
    const clearance = Math.max(0, Math.min(...this.observation.scan) - this.physics.bodyRadius);
    if (on.clearance) {
      const proximity = Math.max(0, 1 - clearance / CLEARANCE_PENALTY_RANGE) ** 2;
      pieces.push({ text: '障害物への接近', value: -weights.clearance * CONTROL_DT * proximity });
    }
    if (on.moving && Math.abs(state.v) > MOVING_SPEED)
      pieces.push({ text: '動いている時間', value: weights.moving * CONTROL_DT });
    if (on.near && distance < NEAR_GOAL_DISTANCE)
      pieces.push({ text: '目標の近くにいる時間', value: weights.near * CONTROL_DT });
    if (collision && on.collision) pieces.push({ text: '接触', value: -weights.collision });
    if (rewarded && on.success)
      pieces.push({ text: state.success ? '到着して停止' : '位置と停止', value: weights.success });
    if (state.done && on.progress)
      pieces.push({
        text: '終了時の残り距離',
        value: -distance * weights.progress * FINAL_DISTANCE_WEIGHT,
      });
    if (state.done && on.heading && docking)
      pieces.push({
        text: '終了時の向き',
        value: -headingError * Math.exp(-distance) * weights.heading,
      });
    return pieces;
  }

  snapshot() {
    return { state: { ...this.state }, observation: structuredClone(this.observation) };
  }
}

export { World };
