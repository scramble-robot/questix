import { fillSentence as fill } from '../core/content.js';

// Display only. The controller and drive-link still calculate and clamp every command.
function wallSpeedDisplay({ maximum, limit, connected }, copy) {
  const requested = maximum.toFixed(2);
  if (!connected || !Number.isFinite(limit))
    return { top: maximum, note: fill(copy.driveWallUnknown, { requested }) };
  const top = Math.min(maximum, limit);
  return {
    top,
    note: fill(top < maximum ? copy.driveWallLimited : copy.driveWallMaximum, {
      requested,
      effective: top.toFixed(2),
    }),
  };
}

export { wallSpeedDisplay };
