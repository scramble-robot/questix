// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAUNCH_SPEC,
  LAUNCH_TARGETS,
  LAUNCH_TOPICS,
  LAUNCH_TOLERANCE,
  launchHit,
  launchRangeAxis,
  launchCSV,
  launchEstimate,
  launchExperiment,
  launchForces,
  launchGroups,
  launchParseCSV,
  launchSpeed,
} from '../js/launch/core.js';

const FLOOR = LAUNCH_SPEC.thickness / 2; // the disc's lower face touches down, not its centre

test('the course constants stay in the order the lessons follow', () => {
  assert.deepEqual(
    LAUNCH_TOPICS.map((topic) => topic.id),
    ['power', 'forces', 'target', 'measure'],
  );
  assert.deepEqual(LAUNCH_TARGETS, [1.2, 1.5, 1.8]);
  assert.equal(Object.isFrozen(LAUNCH_SPEC), true);
});

test('launchSpeed has a dead zone and reaches 8 m/s at full output', () => {
  assert.equal(launchSpeed(0), 0);
  assert.equal(launchSpeed(10), 0, 'the roller does not grip below the dead zone');
  assert.ok(launchSpeed(10.5) > 0);
  assert.equal(launchSpeed(100), 8);
  assert.ok(Math.abs(launchSpeed(55) - 4.43827788827138) < 1e-12);
  for (let power = 11; power <= 100; power++)
    assert.ok(launchSpeed(power) > launchSpeed(power - 1), 'more output is never slower');
});

test('launchSpeed rejects outputs outside 0-100 %', () => {
  for (const power of [-1, 101, NaN, Infinity, '40', undefined])
    assert.throws(() => launchSpeed(power), /出力は0〜100%/);
});

test('launchForces with no air leaves only weight', () => {
  const forces = launchForces(8, 0, false);
  assert.deepEqual(forces, {
    fx: 0,
    fz: -LAUNCH_SPEC.mass * LAUNCH_SPEC.gravity,
    dragX: 0,
    dragZ: 0,
    liftX: 0,
    liftZ: 0,
    weight: LAUNCH_SPEC.mass * LAUNCH_SPEC.gravity,
    drag: 0,
    lift: 0,
    alpha: 0,
  });
  assert.deepEqual(launchForces(0, 0, true), forces, 'a disc at rest feels no air either');
});

test('launchForces opposes the flight direction and lifts a descending disc', () => {
  const level = launchForces(8, 0);
  assert.equal(Math.abs(level.alpha), 0, 'flying level means no angle of attack');
  assert.ok(level.dragX < 0 && level.dragZ === 0, 'drag points back along the flight path');
  assert.equal(Math.abs(level.lift), 0);
  assert.ok(Math.abs(level.drag - 0.17588897621506244) < 1e-15);

  const descending = launchForces(8, -2); // falling while flying forward
  assert.ok(descending.alpha > 0, 'the horizontal disc meets the airflow at a positive angle');
  assert.ok(descending.liftZ > 0, 'lift then slows the fall, as the forces topic teaches');
  assert.ok(descending.drag > level.drag, 'and costs extra drag');

  const backwards = launchForces(-8, 0);
  assert.ok(backwards.dragX > 0, 'drag follows the velocity, whichever way it points');
});

test('launchForces keeps the angle of attack within a quarter turn', () => {
  const straightDown = launchForces(1e-6, -8);
  assert.ok(straightDown.alpha <= Math.PI / 2 + 1e-12);
  assert.ok(Math.abs(straightDown.lift / straightDown.drag) < 5, 'coefficients stay clamped');
});

test('launchExperiment flies until the disc touches the floor', () => {
  const run = launchExperiment({ power: 60 });
  assert.equal(run.status, 'landed');
  assert.deepEqual(run.config, { power: 60, air: true, variation: false, seed: 1 });
  assert.equal(run.samples[0].x, 0);
  assert.equal(run.samples[0].z, LAUNCH_SPEC.height);
  assert.equal(run.samples.at(-1).z, FLOOR);
  assert.equal(run.samples.at(-1).x, run.range);
  assert.equal(run.samples.at(-1).t, run.time);
  assert.equal(run.speed, launchSpeed(60));
  assert.ok(Math.abs(run.range - 1.1629813633816837) < 1e-12);
  assert.ok(Math.abs(run.time - 0.26207959539665776) < 1e-12);
  assert.equal(run.samples.length, 67);
  for (let i = 1; i < run.samples.length; i++)
    assert.ok(run.samples[i].t > run.samples[i - 1].t, 'samples advance in time');
});

test('launchExperiment: air carries the disc further than gravity alone', () => {
  const withAir = launchExperiment({ power: 60 });
  const vacuum = launchExperiment({ power: 60, air: false });
  assert.equal(vacuum.speed, withAir.speed, 'both leave the muzzle at the same speed');
  assert.ok(vacuum.range < withAir.range, 'lift stretches the flight in this model');
  assert.ok(vacuum.time < withAir.time);
  assert.equal(vacuum.samples.at(-1).lift, 0);
});

test('launchExperiment: more output reaches further', () => {
  let previous = 0;
  for (const power of [20, 40, 60, 80, 100]) {
    const run = launchExperiment({ power });
    assert.ok(run.range > previous);
    previous = run.range;
  }
});

test('launchExperiment reports a disc that never leaves the launcher', () => {
  const run = launchExperiment({ power: 5 });
  assert.equal(run.status, 'not-released');
  assert.equal(run.range, 0);
  assert.equal(run.time, 0);
  assert.equal(run.speed, 0);
  assert.equal(run.samples.length, 1);
  assert.equal(run.samples[0].z, LAUNCH_SPEC.height);
});

test('launchExperiment varies the release speed only when asked, and repeatably', () => {
  const plain = launchExperiment({ power: 60 });
  const same = launchExperiment({ power: 60 });
  assert.equal(plain.range, same.range, 'without variation the run is deterministic');

  const seeded = launchExperiment({ power: 60, variation: true, seed: 104 });
  const again = launchExperiment({ power: 60, variation: true, seed: 104 });
  assert.equal(seeded.speed, again.speed, 'the same seed replays the same launch');
  assert.notEqual(seeded.speed, launchExperiment({ power: 60, variation: true, seed: 105 }).speed);
  const spread = Math.abs(seeded.speed - launchSpeed(60)) / launchSpeed(60);
  assert.ok(spread > 0 && spread <= 0.04, 'release speed stays within ±4 %');
});

test('launchExperiment defaults to 40 % with air and no variation', () => {
  assert.deepEqual(launchExperiment().config, {
    power: 40,
    air: true,
    variation: false,
    seed: 1,
  });
  assert.equal(launchExperiment().range, launchExperiment({ power: 40 }).range);
});

test('launchGroups averages each output setting and sorts by output', () => {
  const groups = launchGroups([
    { power: 60, range: 2 },
    { power: 40, range: 1 },
    { power: 40, range: 1.2 },
  ]);
  assert.deepEqual(groups, [
    { power: 40, mean: 1.1, min: 1, max: 1.2, count: 2 },
    { power: 60, mean: 2, min: 2, max: 2, count: 1 },
  ]);
  assert.deepEqual(launchGroups([]), []);
});

test('launchGroups rejects values a learner cannot have measured', () => {
  for (const row of [
    { power: -1, range: 1 },
    { power: 101, range: 1 },
    { power: 40, range: -1 },
    { power: 40, range: 31 },
    { power: NaN, range: 1 },
    { power: 40, range: 'x' },
  ])
    assert.throws(() => launchGroups([row]), /出力0〜100%、飛距離0〜30 m/);
});

test('launchEstimate interpolates between the two bracketing records', () => {
  const rows = [
    { power: 40, range: 1 },
    { power: 60, range: 2 },
  ];
  const estimate = launchEstimate(rows, 1.5);
  assert.equal(estimate.ok, true);
  assert.equal(estimate.power, 50);
  assert.equal(estimate.low.power, 40);
  assert.equal(estimate.high.power, 60);
  assert.equal(estimate.groups.length, 2);
  assert.equal(launchEstimate(rows, 1).power, 40, 'a target on a record returns that output');
  assert.equal(launchEstimate(rows, 2).power, 60);
});

test('launchEstimate refuses to guess, and says why', () => {
  const rows = [
    { power: 40, range: 1 },
    { power: 60, range: 2 },
  ];
  assert.match(launchEstimate(rows, 0).message, /0より大きく/);
  assert.match(launchEstimate(rows, 31).message, /0より大きく/);
  assert.match(launchEstimate(rows, NaN).message, /0より大きく/);
  assert.match(launchEstimate([{ power: 40, range: 1 }], 1).message, /2種類以上の記録/);
  assert.match(launchEstimate(rows, 2.5).message, /はさむ測定値がありません/, 'no extrapolation');
  assert.match(launchEstimate(rows, 0.5).message, /はさむ測定値がありません/);
  const flat = [
    { power: 40, range: 2 },
    { power: 60, range: 1 },
  ];
  assert.match(launchEstimate(flat, 1.5).message, /増えていない区間/);
  for (const result of [launchEstimate(rows, 0), launchEstimate(flat, 1.5)]) {
    assert.equal(result.ok, false);
    assert.equal(result.groups.length, 2, 'the table is still shown while the guess is refused');
  }
});

test('launchParseCSV reads a spreadsheet export', () => {
  assert.deepEqual(launchParseCSV('output_pct,range_m\n40,1.2\n60,2'), [
    { power: 40, range: 1.2 },
    { power: 60, range: 2 },
  ]);
  assert.deepEqual(
    launchParseCSV('﻿ output_pct , range_m \r\n 40 , 1.2 \r\n\r\n'),
    [{ power: 40, range: 1.2 }],
    'byte-order mark, CRLF, padding and blank lines are tolerated',
  );
  assert.deepEqual(launchParseCSV('range_m,output_pct\n1.2,40'), [{ power: 40, range: 1.2 }]);
  assert.deepEqual(launchParseCSV('source,output_pct,range_m\nmeasured,40,1.2'), [
    { power: 40, range: 1.2 },
  ]);
});

test('launchParseCSV rejects files that are not real measurements', () => {
  assert.throws(() => launchParseCSV('a,b\n1,2'), /output_pct,range_m の列名/);
  assert.throws(() => launchParseCSV('output_pct,range_m'), /1〜300行/);
  const tooMany = Array.from({ length: 301 }, () => '40,1').join('\n');
  assert.throws(() => launchParseCSV('output_pct,range_m\n' + tooMany), /1〜300行/);
  assert.throws(() => launchParseCSV('output_pct,range_m\n40'), /2行目に出力と飛距離/);
  assert.throws(() => launchParseCSV('output_pct,range_m\n40,1\n60,'), /3行目に出力と飛距離/);
  assert.throws(() => launchParseCSV('output_pct,range_m\n40,abc'), /2行目は数値だけ/);
  assert.throws(() => launchParseCSV('output_pct,range_m\n-40,1'), /2行目は数値だけ/);
  assert.throws(() => launchParseCSV('output_pct,range_m\n40,31'), /出力0〜100%、飛距離0〜30 m/);
  assert.throws(
    () => launchParseCSV('source,output_pct,range_m\nsimulation,40,1.2'),
    /模擬データは実機の測定として読み込めません/,
  );
  assert.throws(() => launchParseCSV('x'.repeat(100001)), /100 KB以下/);
  assert.throws(() => launchParseCSV(null), /100 KB以下/);
});

test('launchCSV writes a labelled file that launchParseCSV reads back', () => {
  const rows = [{ power: 40, range: 1.23456789 }];
  assert.equal(launchCSV(rows, 'simulation'), '﻿source,output_pct,range_m\nsimulation,40,1.2346');
  assert.equal(launchCSV([]), '﻿source,output_pct,range_m\n');
  const measured = launchCSV(rows);
  assert.match(measured, /\nmeasured,40,1\.2346$/, 'measurements are the default source');
  assert.deepEqual(launchParseCSV(measured), [{ power: 40, range: 1.2346 }]);
  assert.throws(() => launchParseCSV(launchCSV(rows, 'simulation')), /模擬データ/);
});

test('a hit is within ±15 cm of the target, and only when there is a target', () => {
  assert.equal(LAUNCH_TOLERANCE, 0.15);
  assert.equal(launchHit(1.35, 1.2), true, 'the edge of the band counts');
  assert.equal(launchHit(1.05, 1.2), true);
  assert.equal(launchHit(1.36, 1.2), false);
  assert.equal(launchHit(1.2, null), false);
  assert.equal(launchHit(1.2, undefined), false);
});

test('the record chart reads in half metres and holds every record and the whole band', () => {
  const empty = launchRangeAxis([]);
  assert.equal(empty.step, 0.5);
  assert.equal(empty.max, 2.5);
  assert.deepEqual(empty.ticks, [0, 0.5, 1, 1.5, 2, 2.5]);
  const far = launchRangeAxis([{ power: 100, range: 3.11 }], 2.5);
  assert.equal(far.max, 3.5);
  assert.ok(far.ticks.every((tick) => Number.isInteger(tick * 2)));
  // The band of a far target is never cut by the top of the chart.
  assert.ok(launchRangeAxis([], 2.9).max >= 2.9 + LAUNCH_TOLERANCE);
});

// Cross-check against the pre-cleanup copy of this module when one is available next to the working
// copy (the refactor was meant to change no behaviour at all). Skipped anywhere else.
test('the cleanup changed no results', async (t) => {
  const baselineUrl = new URL('../../../base/js/launch/core.js', import.meta.url);
  let baseline;
  try {
    baseline = await import(baselineUrl.href);
  } catch {
    t.skip('no baseline copy next to the working copy');
    return;
  }
  for (let power = 0; power <= 100; power += 5) {
    for (const air of [true, false]) {
      const expected = baseline.launchExperiment({ power, air, variation: true, seed: 104 });
      const actual = launchExperiment({ power, air, variation: true, seed: 104 });
      assert.deepEqual(actual, expected, `launchExperiment power=${power} air=${air}`);
    }
    assert.equal(launchSpeed(power), baseline.launchSpeed(power));
  }
  for (let vz = -8; vz <= 8; vz += 0.5)
    assert.deepEqual(launchForces(6, vz), baseline.launchForces(6, vz));
  const rows = [
    { power: 30, range: 0.7 },
    { power: 30, range: 0.8 },
    { power: 50, range: 1.25 },
    { power: 70, range: 2 },
  ];
  assert.deepEqual(launchGroups(rows), baseline.launchGroups(rows));
  assert.deepEqual(launchEstimate(rows, 1.6), baseline.launchEstimate(rows, 1.6));
  assert.deepEqual(launchEstimate(rows, 9), baseline.launchEstimate(rows, 9));
  assert.equal(launchCSV(rows, 'example'), baseline.launchCSV(rows, 'example'));
  assert.deepEqual(
    launchParseCSV('output_pct,range_m\n40,1.2'),
    baseline.launchParseCSV('output_pct,range_m\n40,1.2'),
  );
});
