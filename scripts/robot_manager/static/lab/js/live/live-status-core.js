// Display only: these receive-time limits never grant motion or change a sender's gates.
// State frames repeat every 1.0 s; allow 0.5 s for delivery jitter, like Manager.
// This also delays the display-only E-stop silence indication to 1.5 s.
const DISPLAY_STALE_MS = 1500;
function liveStatusModel(link, received, now) {
  const open = link.phase === 'open';
  const fresh = (name) =>
    open && received[name]?.message && now - received[name].at <= DISPLAY_STALE_MS;
  const estop =
    !open || !received.estop
      ? 'unknown'
      : !fresh('estop')
        ? 'stale'
        : received.estop.message.active === true
          ? 'pressed'
          : received.estop.message.active === false
            ? 'released'
            : 'unknown';
  const permission = (name) =>
    fresh(name) && typeof received[name].message.allowed === 'boolean'
      ? received[name].message.allowed
        ? 'on'
        : 'off'
      : 'unknown';
  return { estop, drive: permission('drive_state'), shoot: permission('shoot_state') };
}
export { DISPLAY_STALE_MS, liveStatusModel };
