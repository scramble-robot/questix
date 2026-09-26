// Simulation core of QUESTiX LAB: a differential-drive robot world, a linear policy and an
// evolutionary trainer. Units: metres, seconds, radians, RPM; map y and heading are
// clockwise-positive. The implementation lives in js/core/engine/; this module is the
// public surface imported by the rl, slam, planning, vision, control and launch courses.
export { clamp, wrap, rpmToSpeed, speedToRpm, randomGenerator, gaussian } from './engine/maths.js';
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
} from './engine/constants.js';
export { World } from './engine/world.js';
export { features, act, rollout, summarizeEvaluation } from './engine/policy.js';
export { Trainer } from './engine/trainer.js';
