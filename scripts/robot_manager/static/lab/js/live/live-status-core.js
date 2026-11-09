// Display only: these receive-time limits never grant motion or change a sender's gates.
const DISPLAY_STALE_MS = 1000;
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
