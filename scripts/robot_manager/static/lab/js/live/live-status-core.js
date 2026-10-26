// Display only: these receive-time limits never grant motion or change a sender's gates.
// Temporary classroom display lease: 2.5 s tolerates one missed 1 s update.
// Robot Manager, stream freshness and all command/safety timeouts stay unchanged.
import { DISPLAY_STALE_MS } from './display-timing.js';
function liveStatusModel(link, received, now, timing = { mode: 'checking' }) {
  const open = link.phase === 'open';
  const fresh = (name) =>
    open && received[name]?.message && now - received[name].at <= DISPLAY_STALE_MS;
  const unavailable = timing.mode === 'unheard' || timing.mode === 'silent';
  const permissionReason = !open
    ? ''
    : timing.mode === 'unheard'
      ? 'estop_unknown'
      : timing.mode === 'silent'
        ? 'estop_stale'
        : ['checking', 'delayed'].includes(timing.mode)
          ? timing.mode
          : '';
  const timingState = ['checking', 'delayed'].includes(timing.mode) ? timing.mode : null;
  const estop =
    !open || !received.estop
      ? 'unknown'
      : !fresh('estop')
        ? 'stale'
        : timingState
          ? timingState
          : received.estop.message.active === true
            ? 'pressed'
            : received.estop.message.active === false
              ? 'released'
              : 'unknown';
  const permission = (name) =>
    unavailable
      ? 'unknown'
      : fresh(name) && timingState
        ? timingState
        : fresh(name) &&
            received[name].at > timing.readyAt &&
            typeof received[name].message.allowed === 'boolean'
          ? received[name].message.allowed
            ? 'on'
            : 'off'
          : 'unknown';
  return {
    estop,
    drive: permission('drive_state'),
    shoot: permission('shoot_state'),
    permissionReason,
  };
}
export { DISPLAY_STALE_MS, liveStatusModel };
