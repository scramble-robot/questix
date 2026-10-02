// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// The driving-run history (js/live/drive-history.js): entries stored by an older version still
// get every field the report reads, and new entries fill in the optional ones.
import test from 'node:test';
import assert from 'node:assert/strict';

// Node has no localStorage; give the module one that already holds an entry of the first release.
const oldEntry = {
  id: 4,
  at: '2026-09-20T01:02:03.000Z',
  slot: 'bench',
  lesson: '動作テスト（前）',
  program: '',
  ended: '',
  reason: 'stopped',
  report: { series: { command: [], measured: [], path: [], front: [] }, summary: { seconds: 2 } },
};
const STORE_KEY = 'questix-lab-drive-runs';
const stored = new Map([[STORE_KEY, JSON.stringify([oldEntry])]]);
globalThis.localStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, value),
};

const {
  driveRuns,
  driveRun,
  addDriveRun,
  driveRunsFor,
  driveRunRecording,
  hasRecording,
  RUN_DEFAULTS,
} = await import('../js/live/drive-history.js');

test('entries stored before the new fields get their defaults', () => {
  const [run] = driveRuns();
  assert.equal(run.id, 4);
  assert.equal(run.conditions, '');
  assert.equal(run.robot, '');
  assert.deepEqual(run.references, {});
  assert.equal(run.cut, false);
  assert.equal(run.reason, 'stopped');
});

test('a new entry keeps what it was given, defaults the rest and is stored without recording', () => {
  const recording = {
    recordedAt: '2026-09-25T01:00:00.000Z',
    streams: { twist: [{ stamp: 0, linear: 0.2, angular: 0 }], drive: [], odom: [] },
  };
  const run = addDriveRun({
    slot: 'control-speed',
    lesson: '速さの指令',
    conditions: '0.2 m/s',
    program: undefined,
    references: { front: [{ value: 0.5, label: '目標 0.50 m' }] },
    recording,
  });
  assert.equal(run.id, 5);
  assert.equal(run.conditions, '0.2 m/s');
  assert.equal(run.program, RUN_DEFAULTS.program);
  assert.equal(run.robot, '');
  assert.equal(run.cut, false);
  assert.equal(run.at, recording.recordedAt);
  assert.equal(driveRuns()[0], run);
  const kept = JSON.parse(stored.get(STORE_KEY));
  assert.equal(kept.length, 2);
  assert.equal(kept[0].recording, undefined);
  assert.equal(kept[0].references.front[0].value, 0.5);
});

test('a lesson lists its runs with short names; without IndexedDB a recording stays in memory', async () => {
  const recordedAt = new Date(2026, 8, 25, 10, 51, 2).toISOString();
  const recording = {
    recordedAt,
    streams: { twist: [{ stamp: 0, linear: 0.2, angular: 0 }], drive: [], odom: [] },
  };
  const run = addDriveRun({
    slot: 'control-distance',
    lesson: '壁の前で止める',
    conditions: 'P 2.2・I 0・D 0.6',
    group: '3班',
    reason: 'controller',
    recording,
  });
  const [listed] = driveRunsFor('control-distance');
  assert.equal(listed.id, run.id);
  assert.equal(listed.label, '3班 P 2.2・I 0・D 0.6 10:51:02');
  assert.equal(listed.ok, false);
  assert.equal(listed.status, 'stopped');
  assert.equal(listed.kept, true);
  assert.equal(hasRecording(run), true);
  assert.equal(await driveRunRecording(run.id), recording);
  assert.deepEqual(driveRunsFor('nothing-here'), []);
  // The first release's entry has no recording anywhere.
  assert.equal(hasRecording(driveRun(4)), false);
  assert.equal(await driveRunRecording(4), null);
});
