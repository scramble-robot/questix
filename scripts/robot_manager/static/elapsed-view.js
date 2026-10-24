/* QUESTiX Robot Manager: display-only elapsed time. No polling or control decisions here. */
const ElapsedView = (() => {
  function create(maxSilenceMs) {
    return { maxSilenceMs, elapsedMs: null, at: 0, lastSecond: null, session: null };
  }
  function clear(clock, reset = false) {
    clock.elapsedMs = null;
    if (reset) { clock.lastSecond = null; clock.session = null; }
  }
  function receive(clock, data, running, now) {
    if (running !== true) { clear(clock, running === false); return; }
    // Fractional milliseconds avoid repeatedly rounding a received integer second down.
    const elapsed = Number.isFinite(data.elapsed_ms) ? data.elapsed_ms : data.elapsed_sec * 1000;
    if (!Number.isFinite(elapsed) || elapsed < 0) { clear(clock); return; }
    const session = data.started_at ?? null;
    if (clock.session !== session) { clock.lastSecond = null; clock.session = session; }
    clock.elapsedMs = elapsed;
    clock.at = now;
  }
  function seconds(clock, now) {
    // Failure/silence freezes the last value that was actually painted, never an inferred one.
    if (clock.elapsedMs !== null && now - clock.at > clock.maxSilenceMs) clear(clock);
    if (clock.elapsedMs === null) return clock.lastSecond;
    const estimated = Math.floor((clock.elapsedMs + Math.max(0, now - clock.at)) / 1000);
    // A delayed sample may adjust phase, but must never turn the displayed clock backwards.
    clock.lastSecond = Math.max(clock.lastSecond ?? 0, estimated);
    return clock.lastSecond;
  }
  return { create, clear, receive, seconds };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ElapsedView;
