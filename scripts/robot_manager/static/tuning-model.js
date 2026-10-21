/* QUESTiX tuning calculations. All stored values stay in ROS units; no DOM or rounding. */
const TuningModel = (() => {
  const axes = {
    linear: { speed: "longitudinal_input_ratio", accel: "max_linear_accel", unit: "m/s" },
    angular: { speed: "angular_input_ratio", accel: "max_angular_accel", unit: "rad/s" },
  };
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const positive = (value) => finite(value) && value > 0;

  function wheelLimit(values, geometry, kind) {
    const rpm = values?.drive_component?.max_motor_rpm;
    if (!positive(rpm) || !positive(geometry?.wheel_radius)
        || !positive(geometry?.wheel_separation)) return null;
    const wheel = rpm * 2 * Math.PI * geometry.wheel_radius / 60;
    // A pure turn has equal and opposite wheel speeds: w = (v_right - v_left) / track.
    return kind === "angular" ? 2 * wheel / geometry.wheel_separation : wheel;
  }

  function motion(values, geometry, kind) {
    const axis = axes[kind];
    const raw = values?.joy_controller?.[axis.speed];
    const accel = values?.drive_component?.[axis.accel];
    const limit = wheelLimit(values, geometry, kind);
    if (!finite(raw) || !finite(accel) || accel < 0 || limit === null) return null;
    const configured = Math.abs(raw);
    const speed = Math.min(configured, limit);
    const time = speed > 0 && accel > 0 ? speed / accel : null;
    return { configured, speed, limit, accel, time, inverted: raw < 0,
      limited: configured > limit, unlimited: accel === 0,
      stop: time === null ? null : speed * time / 2 };
  }

  function acceleration(speed, time) {
    return positive(speed) && positive(time) ? speed / time : null;
  }

  function retime(previous, next) {
    // At zero speed or with a disabled limiter there is no finite time to preserve.
    if (!previous || !next || previous.time === null || next.speed === 0) return next?.accel ?? null;
    return acceleration(next.speed, previous.time);
  }

  function presetTime(defaults, geometry, kind, factor) {
    const baseline = motion(defaults, geometry, kind);
    return baseline?.time !== null && baseline?.time !== undefined && positive(factor)
      ? baseline.time / factor : null;
  }

  function number(value) {
    if (!finite(value)) return "";
    const rounded = Number(value.toFixed(2));
    return value !== 0 && rounded === 0 ? Number(value.toPrecision(3)) : rounded;
  }

  function speedText(value, kind) {
    if (!finite(value)) return "未確認";
    const magnitude = Math.abs(value);
    return `${number(magnitude)} ${axes[kind].unit}`
      + (kind === "angular" ? `（${Math.round(magnitude * 180 / Math.PI)}°/s）` : "")
      + (value < 0 ? "（方向反転）" : "");
  }

  return { axes, finite, wheelLimit, motion, acceleration, retime, presetTime, number, speedText };
})();

if (typeof module !== "undefined") module.exports = TuningModel;
