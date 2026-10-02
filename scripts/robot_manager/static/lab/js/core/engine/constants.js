// Public constants of the simulation core. Units: metres, seconds, radians, RPM.
// Map y grows downwards on the canvas, so headings are clockwise-positive.

/** Period of one policy command, in seconds (10 Hz control loop). */
const CONTROL_DT = 0.1;
/** Period of one physics sub-step, in seconds (10 sub-steps per command). */
const PHYSICS_DT = 0.01;
/** Lidar rays per scan, evenly spaced over 360 degrees starting straight ahead. */
const SCAN_COUNT = 24;

/** Nominal robot parameters; `reset()` perturbs them per episode when `randomize` is set. */
const DEFAULT_PHYSICS = {
  radius: 0.065, // wheel radius, metres
  track: 0.32, // wheel separation, metres
  bodyRadius: 0.18, // collision radius of the chassis, metres
  maxRpm: 80, // wheel speed at a full command
  accelRpm: 180, // wheel acceleration limit, RPM per second
  motorLag: 0.14, // first-order motor time constant, seconds
  latency: 0.06, // command transport delay, seconds
  slip: 0.035, // fraction of wheel speed lost to slip
  noise: 0.01, // sensor noise scale (metres for the lidar; scaled for IMU and camera)
  randomize: true,
};

/** Reward weights and the terms switched on by default. `threshold` is the emergency-stop |a| in m/s². */
const DEFAULT_REWARD = {
  success: 100,
  collision: 30,
  time: 1,
  progress: 25,
  heading: 5,
  settling: 0.3,
  careful: 1,
  clearance: 4,
  moving: 8,
  near: 8,
  orientation: true,
  threshold: 12,
  enabled: {
    success: true,
    collision: true,
    time: true,
    progress: true,
    heading: true,
    settling: true,
    careful: true,
    clearance: false,
    moving: false,
    near: false,
  },
};

/** Policy inputs, in the order produced by `features()`; exported policies rely on this order. */
const FEATURE_NAMES = [
  'goal_forward',
  'goal_left',
  'bearing_sin',
  'bearing_turn_cost',
  'distance',
  'dock_heading',
  'velocity',
  'yaw_rate',
  'front_obstacle',
  'left_front_obstacle',
  'right_front_obstacle',
  'left_obstacle',
  'right_obstacle',
  'rear_obstacle',
  'forward_alignment',
  'dock_lateral',
];
const FEATURES = FEATURE_NAMES.length;
/** The linear policy has one weight per feature for speed and one per feature for turning. */
const PARAMETERS = FEATURES * 2;

/** Obstacle layouts per course and task; rectangles are {x, y, w, h} in metres from the top-left. */
const COURSES = {
  standard: {
    name: '基本配置',
    delivery: [
      { x: 1.4, y: 0.7, w: 0.35, h: 1.15 },
      { x: 2.85, y: 1.45, w: 0.35, h: 1.05 },
    ],
    dock: [
      { x: 3.45, y: 0.65, w: 1, h: 0.22 },
      { x: 3.45, y: 2.35, w: 1, h: 0.22 },
    ],
  },
  open: { name: '広い通路', delivery: [{ x: 2.2, y: 1.15, w: 0.45, h: 1 }], dock: [] },
  turns: {
    name: '曲がり道',
    delivery: [
      { x: 1.4, y: 0.7, w: 0.35, h: 1.15 },
      { x: 2.85, y: 1.45, w: 0.35, h: 1.05 },
      { x: 2.05, y: 2.55, w: 1.2, h: 0.25 },
    ],
    dock: [
      { x: 3.45, y: 0.65, w: 1, h: 0.22 },
      { x: 3.45, y: 2.35, w: 1, h: 0.22 },
      { x: 1.7, y: 0.35, w: 0.35, h: 1 },
      { x: 2.5, y: 2.15, w: 0.6, h: 0.3 },
    ],
  },
};

export {
  CONTROL_DT,
  PHYSICS_DT,
  SCAN_COUNT,
  DEFAULT_PHYSICS,
  DEFAULT_REWARD,
  FEATURE_NAMES,
  FEATURES,
  PARAMETERS,
  COURSES,
};
