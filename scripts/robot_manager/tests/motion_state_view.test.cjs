const test = require('node:test');
const assert = require('node:assert/strict');
const MotionStateView = require('../static/motion-state-view.js');

const state = (permission = {}, estop = {}) => ({
  emergency_stop: { active: false, source: 'operation_manager', reason: 'released', ...estop },
  motion_permission: {
    mode: 'lesson', drive_allowed: true, launcher_allowed: true, drive_blockers: [],
    launcher_blockers: [], ...permission,
  },
});

test('everything open says so, with the running mode', () => {
  const view = MotionStateView.describe(state());
  assert.equal(view.estop.tone, 'ok');
  assert.equal(view.drive.tone, 'ok');
  assert.equal(view.launcher.tone, 'ok');
  assert.match(view.summary, /^教材用の構成で動いています。非常停止も走行許可も動ける状態です/);
});

test('the teacher and the referee are named in plain words', () => {
  const lesson = MotionStateView.describe(state({ drive_allowed: false, drive_blockers: ['teacher:off'] }));
  assert.equal(lesson.drive.tone, 'error');
  assert.match(lesson.drive.text, /^先生の操作許可が OFF です/);
  assert.equal(lesson.launcher.tone, 'ok');
  const match = MotionStateView.describe(state({
    mode: 'competition', drive_allowed: false, launcher_allowed: false,
    drive_blockers: ['referee:off'], launcher_blockers: ['referee:off'],
  }));
  assert.match(match.drive.text, /AutoReferee が止めています/);
  assert.match(match.summary, /^大会用の構成/);
  // A vote this page does not know yet is still shown.
  assert.equal(MotionStateView.blockerText('obstacle:off'), 'obstacleが止めています');
});

test('a pressed or unknown E-stop and missing topics are never shown as fine', () => {
  const pressed = MotionStateView.describe(state({}, { active: true, reason: 'pin 5 is true, expected false; ' }));
  assert.equal(pressed.estop.tone, 'error');
  assert.match(pressed.estop.text, /pin 5 is true/);
  const nothing = MotionStateView.describe({ emergency_stop: null, motion_permission: null });
  assert.equal(nothing.estop.tone, 'warn');
  assert.equal(nothing.drive.tone, 'warn');
  assert.match(nothing.summary, /^止めている理由があります/);
  const noGpio = MotionStateView.estop(state({}, { reason: 'released (no GPIO safety path)' }));
  assert.equal(noGpio.tone, 'warn');
});
