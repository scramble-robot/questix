// Disc-launcher course: maths only. No DOM, no window — importable from Node and unit-tested in
// test/launch-core.test.mjs.
//
// Educational, uncalibrated horizontal-disc model. No hardware commands. Only the disc's diameter
// and thickness come from the real part; every other figure is a teaching assumption, which the
// learner is told about in content/launch.json.

const LAUNCH_SPEC = Object.freeze({
  diameter: 0.18, // metres
  thickness: 0.02, // metres
  mass: 0.018, // kilograms
  height: 0.45, // metres: centre of the disc at the moment of release
  gravity: 9.81, // metres per second squared
  density: 1.2, // kilograms per cubic metre (air)
  dt: 0.004, // seconds per integration step
});
const LAUNCH_TOPICS = [
  { id: 'power', title: '出力と飛距離を調べる' },
  { id: 'forces', title: '飛行中の力を考える' },
  { id: 'target', title: 'データから的を狙う' },
  { id: 'measure', title: '実機の測定で確かめる' },
];
const LAUNCH_TARGETS = [1.2, 1.8, 2.5]; // metres from the muzzle

// Assumed output → release-speed curve. Not a measured motor curve: below the dead zone the roller
// never pushes the disc out, and the exponent only bends the curve towards the slower end.
const RELEASE_DEAD_ZONE = 10; // percent of output
const MAX_POWER = 100; // percent of output
const MAX_RELEASE_SPEED = 8; // metres per second at full output
const RELEASE_CURVE_EXPONENT = 0.85;

// Aerodynamics of a disc held flat. The coefficients are linear/quadratic stand-ins for a real
// polar curve; alpha is the angle of attack in radians.
const LIFT_SLOPE = 1.4; // lift coefficient per radian
const MAX_LIFT_COEFFICIENT = 0.9;
const PARASITE_DRAG_COEFFICIENT = 0.18; // drag coefficient at alpha = 0
const INDUCED_DRAG_FACTOR = 1.3; // extra drag coefficient per radian squared
const STILL_SPEED = 1e-8; // metres per second: below this the flight direction is undefined

const RELEASE_SPEED_SPREAD = 0.08; // ±4 % of release speed when variation is on
const MAX_STEPS = 5000; // 20 s of flight at LAUNCH_SPEC.dt; reaching it means the model is wrong

const MAX_RANGE = 30; // metres: longest flight distance a learner may record
const MAX_CSV_CHARS = 100000; // 100 KB of measurement CSV
const MAX_CSV_ROWS = 300;
const UNSIGNED_DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function launchSpeed(power) {
  if (!Number.isFinite(power) || power < 0 || power > MAX_POWER)
    throw new Error('出力は0〜100%で入力してください。');
  if (power <= RELEASE_DEAD_ZONE) return 0;
  const abovePedestal = (power - RELEASE_DEAD_ZONE) / (MAX_POWER - RELEASE_DEAD_ZONE);
  return MAX_RELEASE_SPEED * Math.pow(abovePedestal, RELEASE_CURVE_EXPONENT);
}

// Gravity alone: used before release and whenever the air is switched off.
function weightOnly(weight) {
  return {
    fx: 0,
    fz: -weight,
    dragX: 0,
    dragZ: 0,
    liftX: 0,
    liftZ: 0,
    weight,
    drag: 0,
    lift: 0,
    alpha: 0,
  };
}

// Newtons acting on the disc at velocity (vx, vz), split up so that render.js can draw each one.
function launchForces(vx, vz, air = true) {
  const spec = LAUNCH_SPEC;
  const speed = Math.hypot(vx, vz);
  const weight = spec.mass * spec.gravity;
  if (!air || speed < STILL_SPEED) return weightOnly(weight);
  // Disc plane is held horizontal. Angle of attack is relative to the flight velocity.
  const alpha = clamp(-Math.atan2(vz, vx), -Math.PI / 2, Math.PI / 2);
  const liftCoefficient = clamp(LIFT_SLOPE * alpha, -MAX_LIFT_COEFFICIENT, MAX_LIFT_COEFFICIENT);
  const dragCoefficient = PARASITE_DRAG_COEFFICIENT + INDUCED_DRAG_FACTOR * alpha * alpha;
  // 0.5 * rho * v^2 * A: the force, in newtons, that the coefficients scale.
  const pressureForce = 0.5 * spec.density * speed * speed * Math.PI * (spec.diameter / 2) ** 2;
  const drag = pressureForce * dragCoefficient;
  const lift = pressureForce * liftCoefficient;
  // Drag opposes the velocity; lift is perpendicular to it (the velocity turned a quarter turn).
  const dragX = (-drag * vx) / speed;
  const dragZ = (-drag * vz) / speed;
  const liftX = (-lift * vz) / speed;
  const liftZ = (lift * vx) / speed;
  return {
    fx: dragX + liftX,
    fz: dragZ + liftZ - weight,
    dragX,
    dragZ,
    liftX,
    liftZ,
    weight,
    drag,
    lift,
    alpha,
  };
}

// mulberry32: a small seeded generator, so that a topic replays identically for every learner.
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sampleAt = (state, air) => ({ ...state, ...launchForces(state.vx, state.vz, air) });

// One midpoint (RK2) step of the flight. Positions in metres, velocities in metres per second.
function nextState(state, air) {
  const spec = LAUNCH_SPEC;
  const start = launchForces(state.vx, state.vz, air);
  const midVx = state.vx + ((start.fx / spec.mass) * spec.dt) / 2;
  const midVz = state.vz + ((start.fz / spec.mass) * spec.dt) / 2;
  const mid = launchForces(midVx, midVz, air);
  return {
    t: state.t + spec.dt,
    x: state.x + midVx * spec.dt,
    z: state.z + midVz * spec.dt,
    vx: state.vx + (mid.fx / spec.mass) * spec.dt,
    vz: state.vz + (mid.fz / spec.mass) * spec.dt,
  };
}

// The step that crosses the floor is cut at the crossing, so that the range is the first contact of
// the lower disc face rather than the end of a whole time step.
function touchdown(state, beyond) {
  const floor = LAUNCH_SPEC.thickness / 2;
  const ratio = (state.z - floor) / (state.z - beyond.z);
  return {
    t: state.t + LAUNCH_SPEC.dt * ratio,
    x: state.x + (beyond.x - state.x) * ratio,
    z: floor,
    vx: state.vx + (beyond.vx - state.vx) * ratio,
    vz: state.vz + (beyond.vz - state.vz) * ratio,
  };
}

function releaseSpeed(power, variation, seed) {
  const nominal = launchSpeed(power);
  if (!variation) return nominal;
  // Seeded variation models release-speed variability only, not lateral motion.
  const random = seededRandom(seed);
  return nominal * (1 + (random() - 0.5) * RELEASE_SPEED_SPREAD);
}

function unreleasedRun(config) {
  const start = { t: 0, x: 0, z: LAUNCH_SPEC.height, vx: 0, vz: 0 };
  return {
    config,
    samples: [sampleAt(start, false)],
    range: 0,
    time: 0,
    speed: 0,
    status: 'not-released',
  };
}

function launchExperiment({ power = 40, air = true, variation = false, seed = 1 } = {}) {
  const config = { power, air, variation, seed };
  const speed = releaseSpeed(power, variation, seed);
  if (speed === 0) return unreleasedRun(config);
  let state = { t: 0, x: 0, z: LAUNCH_SPEC.height, vx: speed, vz: 0 };
  const samples = [sampleAt(state, air)];
  for (let step = 0; step < MAX_STEPS; step++) {
    const candidate = nextState(state, air);
    if (candidate.z <= LAUNCH_SPEC.thickness / 2) {
      const landing = touchdown(state, candidate);
      samples.push(sampleAt(landing, air));
      return { config, samples, range: landing.x, time: landing.t, speed, status: 'landed' };
    }
    state = candidate;
    samples.push(sampleAt(state, air));
  }
  throw new Error('計算が終了しませんでした。');
}

// Recorded launches collapsed to one row per output setting, in ascending order of output.
function launchGroups(rows) {
  const rangesByPower = new Map();
  for (const row of rows) {
    if (
      !Number.isFinite(row.power) ||
      !Number.isFinite(row.range) ||
      row.power < 0 ||
      row.power > MAX_POWER ||
      row.range < 0 ||
      row.range > MAX_RANGE
    )
      throw new Error('出力0〜100%、飛距離0〜30 mの数値を入力してください。');
    if (!rangesByPower.has(row.power)) rangesByPower.set(row.power, []);
    rangesByPower.get(row.power).push(row.range);
  }
  return [...rangesByPower]
    .sort(([a], [b]) => a - b)
    .map(([power, ranges]) => ({
      power,
      mean: ranges.reduce((sum, range) => sum + range, 0) / ranges.length,
      min: Math.min(...ranges),
      max: Math.max(...ranges),
      count: ranges.length,
    }));
}

// Why the records cannot answer "which output reaches `target`?" — null when they can.
function estimateObstacle(groups, target) {
  if (!Number.isFinite(target) || target <= 0 || target > MAX_RANGE)
    return '狙う距離は0より大きく、30 m以下で入力してください。';
  if (groups.length < 2)
    return '異なる出力で2種類以上の記録が必要です。まず小さい出力と大きい出力で測ってください。';
  if (groups.some((group, index) => index && group.mean <= groups[index - 1].mean))
    return '出力を増やしても平均の飛距離が増えていない区間があります。同じ出力でもう数枚測り、条件が変わっていないか確かめてください。';
  if (target < groups[0].mean || target > groups.at(-1).mean)
    return '狙う距離をはさむ測定値がありません。測定した範囲の外には予測を延ばしません。';
  return null;
}

// Linear interpolation between the two measured outputs that bracket `target`. It never
// extrapolates: a target outside the measured range is refused above.
function launchEstimate(rows, target) {
  const groups = launchGroups(rows);
  const obstacle = estimateObstacle(groups, target);
  if (obstacle) return { ok: false, message: obstacle, groups };
  const upperIndex = Math.max(
    1,
    groups.findIndex((group) => group.mean >= target),
  );
  const low = groups[upperIndex - 1];
  const high = groups[upperIndex];
  const power =
    low.power + ((high.power - low.power) * (target - low.mean)) / (high.mean - low.mean);
  return {
    ok: true,
    power,
    low,
    high,
    groups,
    message: '両側の測定値の間から求めた候補です。次の1枚で届くか確かめてください。',
  };
}

function parseMeasurementRow(cells, columnCount, columns, lineNumber) {
  if (cells.length !== columnCount || !cells[columns.power] || !cells[columns.range])
    throw new Error(lineNumber + '行目に出力と飛距離がありません。');
  // Rows exported from the simulator carry another source; they must not pose as measurements.
  if (columns.source >= 0 && cells[columns.source] !== 'measured')
    throw new Error('模擬データは実機の測定として読み込めません。');
  if (!UNSIGNED_DECIMAL.test(cells[columns.power]) || !UNSIGNED_DECIMAL.test(cells[columns.range]))
    throw new Error(lineNumber + '行目は数値だけで入力してください。');
  return { power: Number(cells[columns.power]), range: Number(cells[columns.range]) };
}

function launchParseCSV(text) {
  if (typeof text !== 'string' || text.length > MAX_CSV_CHARS)
    throw new Error('CSVは100 KB以下にしてください。');
  const lines = text
    .replace(/^﻿/, '') // spreadsheets prepend a byte-order mark
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const header = (lines.shift() || '').split(',').map((cell) => cell.trim());
  const columns = {
    power: header.indexOf('output_pct'),
    range: header.indexOf('range_m'),
    source: header.indexOf('source'),
  };
  if (columns.power < 0 || columns.range < 0)
    throw new Error('1行目に output_pct,range_m の列名が必要です。');
  if (!lines.length || lines.length > MAX_CSV_ROWS)
    throw new Error('測定値を1〜300行で入力してください。');
  const rows = lines.map((line, index) => {
    const cells = line.split(',').map((cell) => cell.trim());
    // +2: the header line plus counting from 1, so the number matches the learner's spreadsheet.
    return parseMeasurementRow(cells, header.length, columns, index + 2);
  });
  launchGroups(rows); // reuses the range checks, and their learner-facing message
  return rows;
}

const CSV_HEADER = '﻿source,output_pct,range_m\n'; // BOM so spreadsheets read UTF-8
const RANGE_DECIMALS = 4; // sub-millimetre: past anything a learner can measure, but lossless here

function launchCSV(rows, source = 'measured') {
  const body = rows
    .map((row) => [source, row.power, row.range.toFixed(RANGE_DECIMALS)].join(','))
    .join('\n');
  return CSV_HEADER + body;
}

export {
  LAUNCH_SPEC,
  LAUNCH_TOPICS,
  LAUNCH_TARGETS,
  launchSpeed,
  launchForces,
  launchExperiment,
  launchGroups,
  launchEstimate,
  launchParseCSV,
  launchCSV,
};
