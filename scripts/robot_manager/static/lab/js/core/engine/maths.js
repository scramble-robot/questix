// Small numeric helpers shared by the simulation core and the course modules.
// Units: metres, seconds, radians and RPM. Angles are wrapped to (-pi, pi].

/** Limits `value` to [low, high]; the default range is the normalised command range [-1, 1]. */
const clamp = (value, low = -1, high = 1) => Math.max(low, Math.min(high, value));

/** Wraps an angle in radians to (-pi, pi] without changing its direction. */
const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

/** Rim speed in m/s of a wheel of `radius` metres turning at `rpm`. */
const rpmToSpeed = (rpm, radius) => (rpm * 2 * Math.PI * radius) / 60;

/** Wheel RPM that gives a rim speed of `speed` m/s for a wheel of `radius` metres. */
const speedToRpm = (speed, radius) => (speed / (2 * Math.PI * radius)) * 60;

/**
 * Seeded pseudo-random generator (Mulberry32) returning uniform numbers in [0, 1).
 * Every lesson consumes it in a fixed order so a seed reproduces the same episode.
 */
function randomGenerator(seed = 42) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample by the Box-Muller transform; consumes two uniform draws. */
function gaussian(rng) {
  return Math.sqrt(-2 * Math.log(Math.max(1e-9, rng()))) * Math.cos(2 * Math.PI * rng());
}

export { clamp, wrap, rpmToSpeed, speedToRpm, randomGenerator, gaussian };
