// Educational, uncalibrated horizontal-disc model. No hardware commands.
const LAUNCH_SPEC = Object.freeze({
  diameter: 0.18,
  thickness: 0.02,
  mass: 0.018,
  height: 0.45,
  gravity: 9.81,
  density: 1.2,
  dt: 0.004,
});
const LAUNCH_TOPICS = [
  { id: 'power', title: '出力と飛距離を調べる' },
  { id: 'forces', title: '飛行中の力を考える' },
  { id: 'target', title: 'データから的を狙う' },
  { id: 'measure', title: '実機の測定で確かめる' },
];
const LAUNCH_TARGETS = [1.2, 1.8, 2.5];
function launchSpeed(power) {
  if (!Number.isFinite(power) || power < 0 || power > 100)
    throw new Error('出力は0〜100%で入力してください。');
  // Dead zone and loaded speed are assumptions, not a measured motor curve.
  return power <= 10 ? 0 : 8 * Math.pow((power - 10) / 90, 0.85);
}
function launchForces(vx, vz, air = true) {
  const s = LAUNCH_SPEC,
    v = Math.hypot(vx, vz),
    weight = s.mass * s.gravity;
  if (!air || v < 1e-8)
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
  // Disc plane is held horizontal. Angle of attack is relative to the flight velocity.
  const alpha = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, -Math.atan2(vz, vx)));
  const cl = Math.max(-0.9, Math.min(0.9, 1.4 * alpha)),
    cd = 0.18 + 1.3 * alpha * alpha;
  const q = 0.5 * s.density * v * v * Math.PI * (s.diameter / 2) ** 2;
  const drag = q * cd,
    lift = q * cl,
    dragX = (-drag * vx) / v,
    dragZ = (-drag * vz) / v,
    liftX = (-lift * vz) / v,
    liftZ = (lift * vx) / v;
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
function launchExperiment({ power = 40, air = true, variation = false, seed = 1 } = {}) {
  const spec = LAUNCH_SPEC,
    nominal = launchSpeed(power);
  // Seeded variation models release-speed variability only, not lateral motion.
  let rng = seed >>> 0;
  const random = () => {
    rng += 0x6d2b79f5;
    let t = rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const v0 = nominal * (variation ? 1 + (random() - 0.5) * 0.08 : 1),
    config = { power, air, variation, seed };
  if (v0 === 0)
    return {
      config,
      samples: [{ t: 0, x: 0, z: spec.height, vx: 0, vz: 0, ...launchForces(0, 0, false) }],
      range: 0,
      time: 0,
      speed: 0,
      status: 'not-released',
    };
  let x = 0,
    z = spec.height,
    vx = v0,
    vz = 0,
    t = 0;
  const samples = [{ t, x, z, vx, vz, ...launchForces(vx, vz, air) }];
  // Midpoint integration; interpolate first contact of the lower disc face with the floor.
  for (let i = 0; i < 5000; i++) {
    const a = launchForces(vx, vz, air),
      mx = vx + ((a.fx / spec.mass) * spec.dt) / 2,
      mz = vz + ((a.fz / spec.mass) * spec.dt) / 2;
    const b = launchForces(mx, mz, air),
      next = {
        t: t + spec.dt,
        x: x + mx * spec.dt,
        z: z + mz * spec.dt,
        vx: vx + (b.fx / spec.mass) * spec.dt,
        vz: vz + (b.fz / spec.mass) * spec.dt,
      };
    if (next.z <= spec.thickness / 2) {
      const ratio = (z - spec.thickness / 2) / (z - next.z);
      const last = {
        t: t + spec.dt * ratio,
        x: x + (next.x - x) * ratio,
        z: spec.thickness / 2,
        vx: vx + (next.vx - vx) * ratio,
        vz: vz + (next.vz - vz) * ratio,
      };
      samples.push({ ...last, ...launchForces(last.vx, last.vz, air) });
      return { config, samples, range: last.x, time: last.t, speed: v0, status: 'landed' };
    }
    ({ t, x, z, vx, vz } = next);
    samples.push({ ...next, ...launchForces(vx, vz, air) });
  }
  throw new Error('計算が終了しませんでした。');
}
function launchGroups(rows) {
  const map = new Map();
  for (const row of rows) {
    if (
      !Number.isFinite(row.power) ||
      !Number.isFinite(row.range) ||
      row.power < 0 ||
      row.power > 100 ||
      row.range < 0 ||
      row.range > 30
    )
      throw new Error('出力0〜100%、飛距離0〜30 mの数値を入力してください。');
    if (!map.has(row.power)) map.set(row.power, []);
    map.get(row.power).push(row.range);
  }
  return [...map]
    .sort((a, b) => a[0] - b[0])
    .map(([power, values]) => ({
      power,
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
    }));
}
function launchEstimate(rows, target) {
  const groups = launchGroups(rows);
  if (!Number.isFinite(target) || target <= 0 || target > 30)
    return { ok: false, message: '狙う距離は0より大きく、30 m以下で入力してください。', groups };
  if (groups.length < 2)
    return {
      ok: false,
      message:
        '異なる出力で2種類以上の記録が必要です。まず小さい出力と大きい出力で測ってください。',
      groups,
    };
  if (groups.some((g, i) => i && g.mean <= groups[i - 1].mean))
    return {
      ok: false,
      message:
        '出力を増やしても平均の飛距離が増えていない区間があります。同じ出力でもう数枚測り、条件が変わっていないか確かめてください。',
      groups,
    };
  if (target < groups[0].mean || target > groups.at(-1).mean)
    return {
      ok: false,
      message: '狙う距離をはさむ測定値がありません。測定した範囲の外には予測を延ばしません。',
      groups,
    };
  const i = Math.max(
      1,
      groups.findIndex((g) => g.mean >= target),
    ),
    low = groups[i - 1],
    high = groups[i];
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
function launchParseCSV(text) {
  if (typeof text !== 'string' || text.length > 100000)
    throw new Error('CSVは100 KB以下にしてください。');
  const lines = text
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const header = (lines.shift() || '').split(',').map((v) => v.trim());
  const p = header.indexOf('output_pct'),
    r = header.indexOf('range_m'),
    s = header.indexOf('source');
  if (p < 0 || r < 0) throw new Error('1行目に output_pct,range_m の列名が必要です。');
  if (!lines.length || lines.length > 300) throw new Error('測定値を1〜300行で入力してください。');
  const rows = lines.map((line, i) => {
    const cells = line.split(',').map((v) => v.trim());
    if (cells.length !== header.length || !cells[p] || !cells[r])
      throw new Error(i + 2 + '行目に出力と飛距離がありません。');
    if (s >= 0 && cells[s] !== 'measured')
      throw new Error('模擬データは実機の測定として読み込めません。');
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(cells[p]) || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(cells[r]))
      throw new Error(i + 2 + '行目は数値だけで入力してください。');
    return { power: Number(cells[p]), range: Number(cells[r]) };
  });
  launchGroups(rows);
  return rows;
}
function launchCSV(rows, source = 'measured') {
  return (
    '\uFEFFsource,output_pct,range_m\n' +
    rows.map((r) => [source, r.power, r.range.toFixed(4)].join(',')).join('\n')
  );
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
