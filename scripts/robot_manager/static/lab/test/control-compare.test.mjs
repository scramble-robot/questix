// Run with: node --test test/*.test.mjs
//
// Comparing real runs in the feedback-control course (js/control/compare.js): what a recording is
// called (from the optional fields the live layer writes), the rows of the comparison table and the
// one sentence built from the numbers of the last two real runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  clockTime,
  comparedName,
  runLabel,
  runLabelParts,
  compareLetter,
  labelPoint,
  commandRpm,
  comparisonRows,
  conclusionSentence,
  comparisonConclusion,
  lastTwoRuns,
} from '../js/control/compare.js';

const copy = JSON.parse(fs.readFileSync(new URL('../content/control/ui.json', import.meta.url)));
const text = copy.live;
// Local wall-clock times, so the tests do not depend on the machine's time zone.
const at = (hours, minutes, seconds) =>
  new Date(2026, 8, 25, hours, minutes, seconds).toISOString();

test('a recording is named by its settings, its time to the second, its group and robot', () => {
  const recording = {
    recordedAt: at(10, 51, 2),
    conditions: { speed: 0.2, label: '0.2 m/s' },
    group: '3班',
    robot: { name: 'questix-03', domain: 3 },
  };
  assert.equal(runLabel(recording, text), '0.2 m/s 10:51:02（3班・questix-03）');
  assert.deepEqual(runLabelParts(recording, text), {
    settings: '0.2 m/s',
    known: true,
    time: '10:51:02',
    group: '3班',
    robot: 'questix-03',
  });
});

test('an older file without the new fields reads 設定：不明, and a missing time is left out', () => {
  assert.equal(runLabel({ recordedAt: at(9, 5, 7) }, text), '設定：不明 09:05:07');
  assert.equal(runLabel({ recordedAt: 'not a date' }, text), '設定：不明');
  assert.equal(runLabel({}, text), '設定：不明');
  assert.equal(runLabel({ group: '  ', robot: {} }, text), '設定：不明');
  assert.equal(clockTime(undefined), '');
});

test('compared runs are lettered A, B … and keep going after Z', () => {
  assert.deepEqual([0, 1, 2].map(compareLetter), ['A', 'B', 'C']);
  assert.equal(compareLetter(25), 'Z');
  assert.equal(compareLetter(26), 'AA');
});

// A speed recording as liveControlRun makes it: 1 s at `command` rpm, then stopped.
function speedRun(command, rise = 0.3) {
  const samples = [];
  for (let time = 0; time <= 3; time += 0.1) {
    const target = time < 1.5 ? command : 0;
    const measured = time < 1.5 ? command * (1 - Math.exp(-time / rise)) : 0;
    samples.push({ time: Number(time.toFixed(1)), target, measured });
  }
  return { samples };
}

// A wall recording: the distance falls from 1.5 m to `stop` with time constant `tau`, then holds.
function wallRun({ stop = 0.5, dip = 0, tau = 1 } = {}) {
  const samples = [];
  for (let time = 0; time <= 12; time += 0.2) {
    const approach = stop + (1.5 - stop) * Math.exp(-time / tau);
    const measured = approach - dip * Math.exp(-((time - 3) ** 2));
    samples.push({ time: Number(time.toFixed(1)), measured, target: NaN });
  }
  return { samples };
}

test('a speed recording is labelled where its first command ends, and says what it commanded', () => {
  const run = speedRun(19);
  assert.deepEqual(labelPoint(run, false).time, 1.4);
  assert.equal(commandRpm(run, false), 19);
  assert.equal(commandRpm(wallRun(), true), null);
  assert.equal(labelPoint(wallRun(), true).time, 12);
});

const entry = (run, recording, extra = {}) => ({
  run,
  parts: runLabelParts(recording, text),
  conditions: recording.conditions ?? null,
  recordedAt: recording.recordedAt ?? null,
  ...extra,
});

test('the table names the recording on screen by its time and the others by their letter', () => {
  const rows = comparisonRows({
    simulation: {
      samples: wallRun().samples.map((sample) => ({ ...sample, actual: sample.measured })),
      target: 0.5,
      settings: 'P 2.2 / I 0 / D 0',
      stale: true,
    },
    current: entry(wallRun(), {
      recordedAt: at(10, 52, 40),
      conditions: { kp: 2.2, ki: 0, kd: 0.6, stop: 0.5, label: 'P 2.2・I 0・D 0.6' },
    }),
    compared: [
      {
        ...entry(wallRun({ dip: 0.1 }), { recordedAt: at(10, 30, 0) }),
        source: 'file',
        file: 'QUESTiX-LAB-control-distance-20260925-103000.json',
        letter: 'A',
      },
    ],
    distance: true,
    stopDistance: 0.5,
    text,
  });
  assert.deepEqual(
    rows.map((row) => [row.name, row.settings, row.stale]),
    [
      ['シミュレーション', 'P 2.2 / I 0 / D 0', true],
      ['実機 10:52:40', 'P 2.2・I 0・D 0.6', false],
      ['A', '設定：不明・10:30:00', false],
    ],
  );
  assert.equal(rows[2].file, 'QUESTiX-LAB-control-distance-20260925-103000.json');
  assert.ok(rows[2].metrics.overshoot > 0.05, 'the dip past 50 cm counts as overshoot');
});

test('an earlier run of this page is named as the help text calls it, a file by its letter', () => {
  const rows = comparisonRows({
    simulation: null,
    current: entry(wallRun(), { recordedAt: at(10, 52, 40) }),
    compared: [
      { ...entry(wallRun(), { recordedAt: at(10, 40, 0) }), source: 'past', letter: 'A' },
      { ...entry(wallRun(), { recordedAt: at(10, 30, 0) }), source: 'file', letter: 'B' },
    ],
    distance: true,
    stopDistance: 0.5,
    text,
  });
  assert.deepEqual(
    rows.map((row) => row.name),
    ['実機 10:52:40', 'A（前の走行）', 'B'],
  );
  // The help text under the chart and next to 重ねる uses the same words.
  assert.ok(text.compareNote.includes('A（前の走行）'));
  assert.ok(copy.charts.liveNote.includes('A（前の走行）'));
  assert.equal(comparedName({ source: 'past', letter: 'C' }, text), 'C（前の走行）');
});

const row = (name, conditions, metrics, extra = {}) => ({
  name,
  conditions,
  metrics,
  ...extra,
});

test('one changed gain: the sentence names it and how the numbers moved', () => {
  const before = row(
    'A',
    { kp: 2.2, ki: 0, kd: 0, label: 'P 2.2・I 0・D 0' },
    {
      settling: 7.9,
      overshoot: 0,
    },
  );
  const after = row(
    '実機 10:52:40',
    { kp: 2.2, ki: 0, kd: 0.6, label: 'P 2.2・I 0・D 0.6' },
    {
      settling: 8.3,
      overshoot: 0.001,
    },
  );
  assert.equal(
    conclusionSentence(before, after, { distance: true, text }),
    'Dを0→0.6にすると、止まるまで7.9→8.3秒、行き過ぎは0 cmのままでした。',
  );
});

test('the speed sentence uses m/s, rpm and says when a run did not settle', () => {
  const before = row('A', { speed: 0.1, label: '0.1 m/s' }, { settling: null, overshoot: 0.4 });
  const after = row('B', { speed: 0.2, label: '0.2 m/s' }, { settling: 0.8, overshoot: 1.26 });
  assert.equal(
    conclusionSentence(before, after, { distance: false, text }),
    '速さを0.1→0.2 m/sにすると、落ち着くまで：落ち着かず→0.8秒、行き過ぎ0.4→1.3 rpmでした。',
  );
  const neither = row('C', { speed: 0.2 }, { settling: null, overshoot: 1.26 });
  assert.equal(
    conclusionSentence({ ...before, metrics: { settling: null, overshoot: 1.26 } }, neither, {
      distance: false,
      text,
    }),
    '速さを0.1→0.2 m/sにすると、どちらも時間内には落ち着かず、行き過ぎは1.3 rpmのままでした。',
  );
});

test('several changes, the same settings and unknown settings each get their own lead', () => {
  const metrics = { settling: 5, overshoot: 0.02 };
  const p2 = { kp: 2, ki: 0, kd: 0, label: 'P 2・I 0・D 0' };
  const p3 = { kp: 3, ki: 0, kd: 0.5, label: 'P 3・I 0・D 0.5' };
  const options = { distance: true, text };
  assert.match(
    conclusionSentence(row('A', p2, metrics), row('B', p3, metrics), options),
    /^設定を「P 2・I 0・D 0」から「P 3・I 0・D 0.5」に変えると、止まるまでは5\.0秒のまま、行き過ぎは2 cmのままでした。$/,
  );
  assert.match(
    conclusionSentence(row('A', p2, metrics), row('B', { ...p2 }, metrics), options),
    /^同じ設定（P 2・I 0・D 0）でもう一度走らせると、/,
  );
  // Another group's file with the same settings is compared, not "run again".
  assert.match(
    conclusionSentence(
      row('実機 10:15:00', p2, metrics, { source: 'live' }),
      row('A', { ...p2 }, metrics, { source: 'file' }),
      options,
    ),
    /^同じ設定（P 2・I 0・D 0）の実機 10:15:00とAを比べると、/,
  );
  assert.match(
    conclusionSentence(row('A', null, metrics), row('実機 10:52:40', p2, metrics), options),
    /^Aと実機 10:52:40を比べると、/,
  );
});

test('the sentence compares the recording on screen with the run before it', () => {
  const metrics = { settling: 5, overshoot: 0 };
  const rows = [
    { id: 'sim', name: 'シミュレーション', metrics },
    row('実機 10:52:40', null, metrics, { id: 'live', source: 'live', recordedAt: at(10, 52, 40) }),
    row('A', null, metrics, { id: 'A', source: 'file', recordedAt: at(10, 10, 0) }),
    row('B', null, metrics, { id: 'B', source: 'past', recordedAt: at(10, 40, 0) }),
    row('C', null, metrics, { id: 'C', source: 'past', recordedAt: at(10, 45, 0) }),
  ];
  assert.deepEqual(
    lastTwoRuns(rows).map((entry) => entry.name),
    ['C', '実機 10:52:40'],
  );
  // Without an earlier run of this page: the newest file, in time order.
  const later = row('D', null, metrics, { id: 'D', source: 'file', recordedAt: at(11, 0, 0) });
  assert.deepEqual(
    lastTwoRuns([rows[1], rows[2], later]).map((entry) => entry.name),
    ['実機 10:52:40', 'D'],
  );
  assert.equal(lastTwoRuns(rows.slice(0, 2)), null);
  assert.equal(comparisonConclusion(rows.slice(0, 2), { distance: true, text }), '');
  assert.match(comparisonConclusion(rows, { distance: true, text }), /^Cと実機 10:52:40を比べると/);
});
