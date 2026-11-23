import { rpmToSpeed, speedToRpm } from './engine/maths.js';

// REP-103 body frame: axle midpoint at the origin, +x forward, +y left, +z up.
// World poses use +y up and counterclockwise-positive yaw. For the canvas-based world.js
// integration in #274, keep x and negate y and theta (the current simulator uses y down).

const TAU = 2 * Math.PI;

/** QUESTiX LAB model in metres, seconds and radians, with a separate motor ceiling in RPM. */
export const ROBOT_DIMENSIONS = Object.freeze({
  // launcher/config/drive_component.yaml and questix_lab_bridge/config/lab_bridge.yaml
  wheelRadius: 0.05,
  // The 0.5 m wheel separation follows the robot's config. The measured tyre centre gap is
  // 506 mm (475 mm inside, 537 mm outside). The 1.2% difference is within the mounting
  // tolerance (#227 section 5-1).
  wheelSeparation: 0.5,
  // CAD -Y is forward. The LiDAR was confirmed at the rear on the physical robot (2026-11-23).
  // The front edge marked in the LAB top view faces this same direction.
  // questix.dae assembly bounds relative to the axle midpoint.
  // The CAD envelope extends past the outer tyre edges in both the measurements and the CAD
  // model, where the tyres are 39 mm wide.
  footprint: Object.freeze({ front: 0.245, rear: 0.4119, left: 0.32, right: 0.32 }),
  // Centre of the CAD T-mini Plus body bounds. Its offset to the optical scan centre is unverified.
  // z is relative to the axle midpoint, about 0.05 m above the CAD floor. The floor and ROS
  // base_link are separate references.
  lidarBodyCenter: Object.freeze({ x: -0.3215, y: 0, z: 0.06845 }),
  // Provisional lesson speeds, pending the course owner's decision.
  maxLinear: 0.5,
  maxAngular: 1.5,
  // Provisional lesson acceleration limits match the shipped questix_control_config profiles.
  linearAccel: 1.5,
  angularAccel: 1.5,
  motorMaxRpm: 475, // Profile ceiling for verification.
});

export const linearToWheelAngular = (linear, dimensions = ROBOT_DIMENSIONS) =>
  linear / dimensions.wheelRadius;
export const wheelAngularToLinear = (angular, dimensions = ROBOT_DIMENSIONS) =>
  angular * dimensions.wheelRadius;
export const wheelAngularToRpm = (angular) => (angular * 60) / TAU;
export const rpmToWheelAngular = (rpm) => (rpm * TAU) / 60;
export const linearToWheelRpm = (linear, dimensions = ROBOT_DIMENSIONS) =>
  speedToRpm(linear, dimensions.wheelRadius);
export const wheelRpmToLinear = (rpm, dimensions = ROBOT_DIMENSIONS) =>
  rpmToSpeed(rpm, dimensions.wheelRadius);

/** Both wheels are positive when rolling forward. Positive yaw turns left. */
export function twistToWheelAngular(linear, angular, dimensions = ROBOT_DIMENSIONS) {
  const turn = (angular * dimensions.wheelSeparation) / 2;
  return {
    left: linearToWheelAngular(linear - turn, dimensions),
    right: linearToWheelAngular(linear + turn, dimensions),
  };
}

/** Convert left and right wheel rates in rad/s to linear speed and yaw rate. */
export function wheelAngularToTwist(left, right, dimensions = ROBOT_DIMENSIONS) {
  const leftSpeed = wheelAngularToLinear(left, dimensions);
  const rightSpeed = wheelAngularToLinear(right, dimensions);
  return {
    linear: (leftSpeed + rightSpeed) / 2,
    angular: (rightSpeed - leftSpeed) / dimensions.wheelSeparation,
  };
}

/** World corners in order: front-left, rear-left, rear-right, front-right. */
export function footprintCorners({ x, y, theta }, dimensions = ROBOT_DIMENSIONS) {
  const { front, rear, left, right } = dimensions.footprint;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return [
    { x: front, y: left },
    { x: -rear, y: left },
    { x: -rear, y: -right },
    { x: front, y: -right },
  ].map((corner) => ({
    x: x + corner.x * cos - corner.y * sin,
    y: y + corner.x * sin + corner.y * cos,
  }));
}
