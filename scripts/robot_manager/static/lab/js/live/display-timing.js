// Display only. Never use this estimate to send, confirm, grant or reject a command.
// Compare clock increments only: neither clock's absolute time is trusted.
const DISPLAY_STALE_MS = 1500;
const TIMING_WINDOW_MS = 30000;
const TIMING_CONFIRM_MS = 1000;
const CLOCK_STEP_MARGIN_MS = 250;
const TIMING_CONFIRM_SAMPLES = 3;

function createDisplayTiming() {
  return { mode: 'checking', samples: [], last: null, candidate: null, readyAt: Infinity };
}
function begin(timing, stamp, now) {
  Object.assign(timing, createDisplayTiming(), {
    origin: { stamp, at: now },
    last: { stamp, at: now },
    samples: [{ at: now, offset: 0 }],
    baseline: 0,
    baselineAt: now,
    candidate: { stamp, at: now, count: 1 },
    delay: 0,
  });
}
function observeDisplayTiming(timing, message, now) {
  const stamp = message?.bridge_stamp;
  if (typeof stamp !== 'number' || !Number.isFinite(stamp)) {
    Object.assign(timing, createDisplayTiming());
    return;
  }
  if (!timing.last) {
    begin(timing, stamp, now);
    return;
  }
  const elapsed = now - timing.last.at;
  const advance = (stamp - timing.last.stamp) * 1000;
  // Repeated/frozen clocks cannot establish freshness. A forward step larger than
  // elapsed + 250 ms isn't ordinary scheduling jitter; rebuild without releasing.
  if (advance <= 0 || elapsed < 0 || advance > elapsed + CLOCK_STEP_MARGIN_MS) {
    begin(timing, stamp, now);
    return;
  }
  timing.last = { stamp, at: now };
  const offset = now - timing.origin.at - (stamp - timing.origin.stamp) * 1000;
  timing.delay = Math.max(0, offset - timing.baseline);
  if (elapsed > DISPLAY_STALE_MS || timing.delay > DISPLAY_STALE_MS) {
    timing.mode = 'delayed';
    timing.candidate = null;
    timing.readyAt = Infinity;
  }
  // Freeze the last good baseline across gaps/delay: expiring it after a 60 s
  // outage would promote the first queued old frame to the new zero-delay baseline.
  // It can move down (less delay), but ages out only during continuous good input.
  if (offset <= timing.baseline) {
    timing.baseline = offset;
    timing.baselineAt = now;
  }
  timing.delay = Math.max(0, offset - timing.baseline);
  if (timing.mode === 'ready') {
    timing.samples = timing.samples.filter((sample) => now - sample.at <= TIMING_WINDOW_MS);
    timing.samples.push({ at: now, offset });
    const minimum = timing.samples.reduce((a, b) => (a.offset <= b.offset ? a : b));
    timing.baseline = minimum.offset;
    timing.baselineAt = minimum.at;
  } else {
    const limit = timing.mode === 'delayed' ? DISPLAY_STALE_MS / 2 : DISPLAY_STALE_MS;
    if (timing.delay > limit) timing.candidate = null;
    else {
      const candidate = timing.candidate;
      // Bursts or stretched replay that progress unlike local time cannot confirm a new clock.
      if (
        !candidate ||
        Math.abs((stamp - candidate.stamp) * 1000 - (now - candidate.at)) > CLOCK_STEP_MARGIN_MS
      )
        timing.candidate = { stamp, at: now, count: 1 };
      else {
        candidate.count++;
        if (now - candidate.at >= TIMING_CONFIRM_MS && candidate.count >= TIMING_CONFIRM_SAMPLES) {
          timing.mode = 'ready';
          timing.readyAt = now;
          timing.samples = [
            { at: timing.baselineAt, offset: timing.baseline },
            { at: now, offset },
          ];
          timing.candidate = null;
        }
      }
    }
  }
}
function displayTimingModel(timing, now) {
  if (!timing.last || now - timing.last.at > DISPLAY_STALE_MS) {
    return { mode: 'checking', readyAt: Infinity };
  }
  return { mode: timing.mode, readyAt: timing.readyAt };
}
export {
  DISPLAY_STALE_MS,
  TIMING_WINDOW_MS,
  TIMING_CONFIRM_MS,
  CLOCK_STEP_MARGIN_MS,
  createDisplayTiming,
  observeDisplayTiming,
  displayTimingModel,
};
