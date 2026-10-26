// Teaching plan only. These values never feed the real drive program or its permissions.
// The existing speed plant (100 rpm, or 80 rpm in mismatch) and distance plant stay unchanged.
const PLAN_RADIUS = 0.05; // m: the real wheel radius, used only to express a speed target
const PLAN_ACCELERATION = 1.5; // m/s²: the reference ramp's fastest option
const PLAN_SPEEDS = [0.4, 0.2, 0.15, 0.1, 0.05];
const PLAN_TIMES = [0.5, 1, 2, 3];
const PLAN_HOLD = 5; // s: area shown covers acceleration + this constant-speed interval
const RPM_TO_RADIANS = (2 * Math.PI) / 60;
const rpmToRadians = (rpm) => rpm * RPM_TO_RADIANS;
const perRadianGain = (perRPM) => perRPM / RPM_TO_RADIANS;
const speedToRPM = (speed) => speed / PLAN_RADIUS / RPM_TO_RADIANS;
const rpmToSpeed = (rpm) => rpmToRadians(rpm) * PLAN_RADIUS;
const minimumTime = (speed) => speed / PLAN_ACCELERATION;
const formatSpeed = (speed) => Number(speed).toFixed(2);
const formatTime = (time) => (time < 0.5 ? time.toFixed(3) : time.toFixed(1));
const fixed = (value, digits) => {
  const text = Number(value).toFixed(digits);
  return Number(text) === 0 ? (0).toFixed(digits) : text;
};
const angularSpeedText = (rpm, digits = 2) =>
  `${fixed(rpmToRadians(rpm), digits)} rad/s（約 ${fixed(rpm, 1)} rpm）`;
const needsPlan = (topic) => topic.mode === 'speed' && topic.id !== 'output';
function accelerationTime(speed, choice) {
  if (!PLAN_SPEEDS.includes(speed)) throw new Error('Select a simulation speed');
  const time = choice === 'minimum' ? minimumTime(speed) : Number(choice);
  if (
    !Number.isFinite(time) ||
    time < minimumTime(speed) ||
    (choice !== 'minimum' && !PLAN_TIMES.includes(time))
  )
    throw new Error('Select a reachable acceleration time');
  return time;
}
function simulationPlan(speed, time) {
  if (!Number.isFinite(speed) || !Number.isFinite(time) || speed <= 0 || time < minimumTime(speed))
    throw new Error('Invalid simulation plan');
  return {
    speed,
    time,
    rpm: speedToRPM(speed),
    angular: speed / PLAN_RADIUS,
    acceleration: speed / time,
    hold: PLAN_HOLD,
    end: time + PLAN_HOLD,
    triangle: (speed * time) / 2,
    rectangle: speed * PLAN_HOLD,
    distance: (speed * time) / 2 + speed * PLAN_HOLD,
  };
}
export {
  PLAN_RADIUS,
  PLAN_ACCELERATION,
  PLAN_SPEEDS,
  PLAN_TIMES,
  PLAN_HOLD,
  RPM_TO_RADIANS,
  rpmToRadians,
  perRadianGain,
  speedToRPM,
  rpmToSpeed,
  minimumTime,
  formatSpeed,
  formatTime,
  angularSpeedText,
  needsPlan,
  accelerationTime,
  simulationPlan,
};
