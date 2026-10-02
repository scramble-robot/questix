const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TrialView = require('../static/trial-view.js');

const trialPy = fs.readFileSync(path.join(__dirname, '..', 'trial.py'), 'utf8');

test('the form has exactly the fields trial.py accepts', () => {
  const block = trialPy.match(/METADATA_FIELDS = \(([^)]*)\)/)[1];
  const fields = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(TrialView.FIELDS.map((f) => f.key).sort(), [...fields].sort());
  assert.equal(new Set(TrialView.FIELDS.map((f) => f.key)).size, fields.length);
});

test('the limits repeat trial.py', () => {
  assert.ok(trialPy.includes(`_ID_RE = re.compile(r"${TrialView.ID_PATTERN}")`));
  assert.ok(trialPy.includes(`_SHORT_ID_RE = re.compile(r"${TrialView.SHORT_ID_PATTERN}")`));
  assert.ok(trialPy.includes(`_LABEL_MAX = ${TrialView.LABEL_MAX}\n`));
  assert.ok(trialPy.includes(`_FLOOR_MAX = ${TrialView.FLOOR_MAX}\n`));
  assert.ok(trialPy.includes(`_MEMO_MAX = ${TrialView.MEMO_MAX}\n`));
  assert.ok(trialPy.includes(`_PAYLOAD_MAX_KG = ${TrialView.PAYLOAD_MAX_KG}.0\n`));
  assert.ok(trialPy.includes(`_BATTERY_MAX_V = ${TrialView.BATTERY_MAX_V}.0\n`));
});

test('no field for a name, student number, e-mail or school', () => {
  for (const field of TrialView.FIELDS) {
    assert.doesNotMatch(field.key, /name|student|mail|school/);
  }
});

test('empty fields are left out, numbers are sent as numbers', () => {
  const { body, errors } = TrialView.metadata({
    trial_id: '  ', team_id: ' teamA ', condition_label: 'max_speed 1.5', payload_kg: '1.25',
    battery_voltage: '', memo: '速く曲がると滑る',
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(body, {
    team_id: 'teamA', condition_label: 'max_speed 1.5', payload_kg: 1.25, memo: '速く曲がると滑る',
  });
  assert.deepEqual(TrialView.metadata({}), { body: {}, errors: [] });
});

test('values trial.py refuses are refused before sending', () => {
  const refused = (values) => TrialView.metadata(values).errors.length;
  assert.equal(refused({ trial_id: 'a'.repeat(64) }), 0);
  assert.equal(refused({ trial_id: 'a'.repeat(65) }), 1);
  assert.equal(refused({ trial_id: 'trial 1' }), 1);
  assert.equal(refused({ team_id: 'a'.repeat(33) }), 1);
  assert.equal(refused({ robot_id: '1号機' }), 1);
  assert.equal(refused({ floor: '体'.repeat(32) }), 0);
  assert.equal(refused({ floor: '体'.repeat(33) }), 1);
  assert.equal(refused({ condition_label: 'a\u0007b' }), 1);
  assert.equal(refused({ condition_label: 'a\tb' }), 0);
  assert.equal(refused({ memo: 'a\tb' }), 1);
  assert.equal(refused({ memo: '😀'.repeat(500) }), 0); // code points, like Python's len()
  assert.equal(refused({ memo: 'x'.repeat(501) }), 1);
  assert.equal(refused({ payload_kg: '500' }), 0);
  assert.equal(refused({ payload_kg: '500.1' }), 1);
  assert.equal(refused({ battery_voltage: '-1' }), 1);
  assert.equal(refused({ battery_voltage: 'abc' }), 1);
  // Every refused field is reported, and nothing refused is in the body.
  const both = TrialView.metadata({ trial_id: 'bad id', battery_voltage: '200', floor: 'ok' });
  assert.equal(both.errors.length, 2);
  assert.deepEqual(both.body, { floor: 'ok' });
});

test('idle without any trial: no evidence box', () => {
  const view = TrialView.status({ recording: false, mode: null, trial: null, last_trial: null });
  assert.equal(view.mode, '—');
  assert.deepEqual(view.rows, []);
});

test('a generic recording says so and shows no trial', () => {
  const view = TrialView.status({
    recording: true, mode: 'generic', trial: null,
    last_trial: { trial_id: 'old', integrity_status: 'ok', finalizing: false },
  });
  assert.equal(view.mode, '通常の記録');
  assert.deepEqual(view.rows, []);
});

test('a running evidence recording shows its identity and start warnings', () => {
  const view = TrialView.status({
    recording: true, mode: 'classroom',
    trial: { trial_id: 't1', team_id: 'teamA', condition_label: 'baseline', warnings: ['w'] },
    last_trial: null,
  });
  assert.equal(view.mode, '証拠付き記録');
  assert.equal(view.badge.state, 'recording');
  assert.deepEqual(view.rows, [['試行ID / 班 / 条件', 't1 / teamA / baseline']]);
  assert.deepEqual(view.warnings, ['w']);
});

const last = (overrides = {}) => ({
  recording: false, mode: null, trial: null,
  last_trial: {
    trial_id: 't1', team_id: null, condition_label: null, bag_name: 'robot1_20261003_101500',
    stop_reason: 'user_stopped', finalize: 'clean', integrity_status: 'ok',
    evidence_dir: '/var/lib/questix/rosbags/robot1_20261003_101500', warnings: [],
    finalizing: false, ...overrides,
  },
});

test('the last trial: verdict, bag, why it stopped and where the evidence is', () => {
  const view = TrialView.status(last());
  assert.equal(view.heading, '前回の証拠付き記録');
  assert.equal(view.badge.state, 'ok');
  assert.deepEqual(view.rows, [
    ['試行ID / 班 / 条件', 't1'],
    ['記録名', 'robot1_20261003_101500'],
    ['止まった理由', '停止ボタン'],
    ['証拠の場所', '/var/lib/questix/rosbags/robot1_20261003_101500'],
  ]);
});

test('while finalizing: pending, and no evidence path yet (it is still the staging dir)', () => {
  const view = TrialView.status(last({ finalizing: true, integrity_status: 'pending' }));
  assert.equal(view.badge.state, 'pending');
  assert.ok(!view.rows.some(([label]) => label === '証拠の場所'));
});

test('warning and failed verdicts, unknown stop reasons shown as they are', () => {
  assert.equal(TrialView.status(last({ integrity_status: 'warning', warnings: ['x'] })).badge.state, 'warning');
  assert.equal(TrialView.status(last({ integrity_status: 'failed' })).badge.state, 'failed');
  assert.equal(TrialView.status(last({ integrity_status: 'other' })).badge.state, 'warning');
  const rows = TrialView.status(last({ stop_reason: 'something_new' })).rows;
  assert.deepEqual(rows[2], ['止まった理由', 'something_new']);
});

test('every stop reason the recorder reports has a label', () => {
  const recorderPy = fs.readFileSync(path.join(__dirname, '..', 'recorder.py'), 'utf8');
  for (const reason of ['user_stopped', 'auto_stopped_low_disk', 'shutdown']) {
    assert.ok(recorderPy.includes(`"${reason}"`), reason);
    assert.ok(TrialView.STOP_REASON[reason], reason);
  }
  for (const reason of ['max_duration', 'process_exited']) {
    assert.ok(trialPy.includes(`"${reason}"`), reason);
    assert.ok(TrialView.STOP_REASON[reason], reason);
  }
});

test('start button and toast', () => {
  assert.equal(TrialView.startLabel(true), '証拠付きで記録開始');
  assert.equal(TrialView.startLabel(false), '記録開始');
  assert.match(TrialView.startedText({ mode: 'classroom', trial_id: 't1', bag_name: 'b' }), /証拠付き記録.*t1.*b/);
  assert.match(TrialView.startedText({ mode: 'generic', bag_name: 'b' }), /記録を開始しました: b/);
});
