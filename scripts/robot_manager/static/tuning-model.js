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
    const limit = kind === "angular" ? 2 * wheel / geometry.wheel_separation : wheel;
    return positive(limit) ? limit : null;
  }

  function motion(values, geometry, kind) {
    const axis = axes[kind];
    const raw = values?.joy_controller?.[axis.speed];
    const accel = values?.drive_component?.[axis.accel];
    const limit = wheelLimit(values, geometry, kind);
    if (!finite(raw) || !finite(accel) || accel < 0 || limit === null) return null;
    const configured = Math.abs(raw);
    const speed = Math.min(configured, limit);
    const duration = speed > 0 && accel > 0 ? speed / accel : null;
    const time = finite(duration) ? duration : null;
    const internalTime = accel > 0 ? configured / accel : null;
    const coastTime = accel > 0 ? (configured - speed) / accel : null;
    const stopTime = time === null || !finite(coastTime) ? null : coastTime + time;
    const stop = stopTime === null ? null : speed * coastTime + speed * time / 2;
    return { configured, speed, limit, accel, time, inverted: raw < 0,
      internalTime: finite(internalTime) ? internalTime : null,
      coastTime: finite(coastTime) ? coastTime : null,
      stopTime: finite(stopTime) ? stopTime : null,
      limited: configured > limit, unlimited: accel === 0,
      stop: finite(stop) ? stop : null };
  }

  function acceleration(speed, time) {
    const value = positive(speed) && positive(time) ? speed / time : null;
    return positive(value) ? value : null;
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

  function minimumTime(speed, maximumAccel) {
    if (!positive(speed) || !positive(maximumAccel)) return null;
    const minimum = speed / maximumAccel;
    if (!positive(minimum)) return null;
    const unit = minimum >= 0.01 ? 0.01 : 10 ** (Math.floor(Math.log10(minimum)) - 2);
    if (!positive(unit)) return null;
    let result = Number((Math.ceil(minimum / unit) * unit).toPrecision(15));
    // Round upward at the displayed precision, including binary division's boundary error.
    if (result < minimum || speed / result > maximumAccel) result = Number((result + unit).toPrecision(15));
    return result;
  }

  function magnitude(value) {
    const displayed = number(Math.abs(value));
    return Number.isInteger(displayed) ? displayed.toFixed(1) : String(displayed);
  }

  function speedWarning(key, value, maximum, saved = false) {
    const [label, unit] = key === "angular_input_ratio" ? ["旋回の速さ", "rad/s"]
      : key === "lateral_input_ratio" ? ["左右の速さ", "m/s"] : ["走行速度", "m/s"];
    return `${saved ? "保存済みの" : ""}${label} ${magnitude(value)} ${unit}${value < 0 ? "（方向の反転あり）" : ""}は、保存できる範囲の外です。`
      + `大きさを ${maximum.toFixed(1)} ${unit} 以下にしてください（方向の反転は保存済みのまま）。`;
  }

  function limitedText(state, kind) {
    if (!state?.limited || state.stop === null || state.stopTime === null || state.coastTime === null) return "";
    const movement = kind === "angular" ? "回り" : "進み";
    const quantity = kind === "angular" ? `${Math.round(state.stop * 180 / Math.PI)}°回ります`
      : `${number(state.stop)} m進みます`;
    return "最大まで倒し続けて、内部の値が設定の速さに届いた場合、"
      + `スティックを戻しても約 ${number(state.coastTime)} s は全速のまま${movement}、`
      + `止まるまでに約 ${number(state.stopTime)} s、約 ${quantity}。短く倒した場合は、ここまで続きません。`;
  }

  function speedText(value, kind) {
    if (!finite(value)) return "未確認";
    const magnitude = Math.abs(value);
    return `${number(magnitude)} ${axes[kind].unit}`
      + (kind === "angular" ? `（${Math.round(magnitude * 180 / Math.PI)}°/s）` : "")
      + (value < 0 ? "（方向反転）" : "");
  }

  function summary(state, kind) {
    if (!state) return "車輪寸法・速度・加速度が未確認または入力中のため、目安は算出できません。";
    if (state.speed === 0) return `${kind === "angular" ? "旋回" : "走行"}なし。速さが0のため加速時間は算出できません。`;
    if (state.unlimited) return "加速度の制限なし。加速時間と止まるまでの量は算出しません。";
    if (state.time === null || state.stop === null) return "加速時間・停止量が大きすぎるため、目安は表示できません。";
    const quantity = kind === "angular" ? `${Math.round(state.stop * 180 / Math.PI)}°回ります`
      : `${number(state.stop)} m進みます`;
    return `最高速度の目安 ${speedText(state.speed, kind)}、加速時間 ${number(state.time)} s。`
      + (state.limited ? limitedText(state, kind) : `全速からスティックを戻すと、止まるまでに約 ${quantity}。`);
  }

  return { axes, finite, wheelLimit, motion, acceleration, retime, presetTime, number,
    minimumTime, speedWarning, speedText, summary, limitedText };
})();

if (typeof module !== "undefined") module.exports = TuningModel;
