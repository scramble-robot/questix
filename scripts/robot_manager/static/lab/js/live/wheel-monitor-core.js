// Monitor display only. Report and recording calculations retain their own authority.
import { wheelAuthority } from './capture-core.js';
import { wheelRpm } from './slam-recorder.js';

export function wheelMonitorSample(drive, config, twist) {
  const none = { left: NaN, right: NaN };
  const direct = wheelAuthority(drive);
  let raw, filtered, target;
  if (direct) {
    raw = direct.raw ?? none;
    filtered = direct.filtered ?? none;
    target = direct.target ?? none;
  } else {
    if (!config || !Number.isFinite(drive.v) || !Number.isFinite(drive.w)) return null;
    raw = wheelRpm(drive, config);
    filtered = none; // Older bridges have no independent raw/filtered pair.
    target =
      twist &&
      drive.stamp - twist.stamp < 1 &&
      Number.isFinite(twist.linear) &&
      Number.isFinite(twist.angular)
        ? wheelRpm({ v: twist.linear, w: twist.angular }, config)
        : none;
  }
  return {
    left: raw.left,
    right: raw.right,
    filteredLeft: filtered.left,
    filteredRight: filtered.right,
    targetLeft: target.left,
    targetRight: target.right,
  };
}
