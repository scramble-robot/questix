const test = require('node:test');
const assert = require('node:assert/strict');
const StatusView = require('../static/status-view.js');

const bridge = (drive = {}, shoot = {}, extra = {}) => ({
  read_only: drive.allowed === false, robot: { name: 'questix-3', domain: 7 }, clients: 4, max_clients: 24,
  drive_state: { allowed: true, blockers: [], owner: null, active: false, ...drive },
  shoot_state: { allowed: true, blockers: [], owner: null, active: false, ...shoot },
  ...extra,
});
const lab = (overrides = {}) => ({
  running: true, external: false, competition: false, drive_allowed: true, shoot_allowed: true,
  bridge: bridge(), ...overrides,
});

test('headline follows permission and blockers, never "can fire" above a blocker', () => {
  const memory = StatusView.createBlockerMemory();
  const data = lab({ bridge: bridge({}, { blockers: [{ code: 'emergency_stop', parts: ['topic'] }] }) });
  const shoot = StatusView.capability('shoot', data, 'active', memory, 0);
  assert.equal(shoot.headline, '許可済み・いまは発射できません（非常停止ボタンが押されています）');
  assert.equal(shoot.tone, 'warn');
  const drive = StatusView.capability('drive', data, 'active', memory, 0);
  assert.equal(drive.headline, '許可済み・生徒が教材から走らせられます');
  assert.equal(drive.tone, 'driving');
});

test('a missing twist_arbiter right after a bridge restart is shown only once it lasts', () => {
  const memory = StatusView.createBlockerMemory();
  const data = lab({ bridge: bridge({ blockers: [{ code: 'no_drive_node' }] }) });
  let view = StatusView.capability('drive', data, 'active', memory, 1000);
  assert.equal(view.headline, '許可済み・ロボットの状態を確認しています…');
  assert.deepEqual(view.reasons, []);
  view = StatusView.capability('drive', data, 'active', memory, 1000 + StatusView.SETTLE_MS);
  assert.match(view.headline, /^許可済み・いまは走行できません（ロボット制御が練習用の構成で動いていないか/);
  assert.match(view.reasons[0].detail, /twist_arbiter.*ROS_DOMAIN_ID 7/);
  assert.doesNotMatch(view.reasons[0].text, /twist_arbiter|ROS_DOMAIN_ID/); // jargon only in details
  // It went away and comes back: the wait starts again.
  StatusView.capability('drive', lab(), 'active', memory, 20000);
  view = StatusView.capability('drive', data, 'active', memory, 21000);
  assert.deepEqual(view.reasons, []);
});

test('a stopped robot service is named as the reason', () => {
  const memory = StatusView.createBlockerMemory();
  const data = lab({ bridge: bridge({}, { blockers: [{ code: 'no_launcher', parts: ['roller', 'shot'] }] }) });
  const view = StatusView.capability('shoot', data, 'inactive', memory, 0); // no wait: it is stopped
  assert.match(view.headline, /ロボット制御が止まっています/);
  assert.match(view.reasons[0].detail, /esc_motor_control・shot_component/);
});

test('competition mode disables the switches with the reason', () => {
  const view = StatusView.capability('drive', lab({ competition: true, running: false, bridge: null,
    drive_allowed: false }), 'active', StatusView.createBlockerMemory(), 0);
  assert.equal(view.headline, '大会モードのため使えません');
  assert.equal(view.toggleDisabled, true);
  assert.match(view.toggleNote, /練習モードに戻すと、先生が選んでいた設定に戻ります/);
});

test('forbidden, stale and running states', () => {
  const memory = StatusView.createBlockerMemory();
  assert.equal(StatusView.capability('drive', lab({ drive_allowed: false, bridge: bridge({ allowed: false }) }),
    'active', memory, 0).headline, '禁止しています（教材からは走らせられません）');
  assert.match(StatusView.capability('drive', lab({ drive_allowed: false }), 'active', memory, 0).headline,
    /^禁止に切り替えましたが/);
  const running = StatusView.capability('drive', lab({ bridge: bridge({ active: true, owner: 3 }) }), 'active', memory, 0);
  assert.equal(running.headline, '許可済み・生徒の端末 #3 が走行中');
  assert.equal(StatusView.capability('drive', lab({ running: false, bridge: null }), 'active', memory, 0).headline,
    '許可済み・教材の配信が止まっています');
});

test('status strip: running vs next mode, E-stop, who drives', () => {
  const status = { mode: 'competition', running_mode: 'practice', service: 'active', robot_name: 'host' };
  const rows = StatusView.overview(status,
    lab({ bridge: bridge({ active: true, owner: 5, blockers: [] }, {}) }), 'UART / Switch');
  assert.equal(rows.robot.text, 'questix-3'); // what the lab pages show
  assert.equal(rows.mode.text, '練習の構成で動作中・次回の起動は大会');
  assert.equal(rows.mode.tone, 'warn');
  assert.equal(rows.estop.text, '解除されています');
  assert.equal(rows.lab.text, '配信中・接続中の端末 4 台');
  assert.equal(rows.permissions.text, '走行: 許可・発射: 許可');
  assert.equal(rows.driver.text, '生徒の端末 #5（教材から走行中）');
  const pressed = StatusView.overview(status,
    lab({ bridge: bridge({ blockers: [{ code: 'emergency_stop' }] }) }), 'UART / Switch');
  assert.equal(pressed.estop.text, '押されています');
  const stopped = StatusView.overview({ mode: 'practice', service: 'inactive', robot_name: 'host' }, null, null);
  assert.equal(stopped.robot.text, 'host');
  assert.match(stopped.mode.text, /「起動」を押したときだけ/);
  assert.match(stopped.driver.text, /だれも動かせません/);
  assert.match(stopped.estop.text, /分かりません/);
  const forbidden = StatusView.overview({ mode: 'practice', service: 'active', running_mode: 'practice' },
    lab({ drive_allowed: false, shoot_allowed: false, bridge: bridge({ allowed: false }, { allowed: false }) }), 'Web');
  assert.match(forbidden.estop.text, /^分かりません/);
  assert.equal(forbidden.driver.text, 'コントローラー（Web）・教材からは動かしていません');
});

test('header mode summary', () => {
  assert.equal(StatusView.modeSummary({ mode: 'practice', service: 'inactive' }), '次回起動: 練習');
  assert.equal(StatusView.modeSummary({ mode: 'competition', service: 'active', running_mode: 'practice' }),
    '動作中: 練習 / 次回: 大会');
  assert.equal(StatusView.modeSummary({ mode: 'practice', service: 'active', running_mode: 'practice' }), '動作中: 練習');
});

test('browser controller URL: access point, then LAN, then the page', () => {
  const ap = { configured: true, active: true, controller_url: 'http://10.42.0.1:8899/' };
  assert.equal(StatusView.controllerUrl(ap, ['http://192.168.1.11:8897/'], 'x'), 'http://10.42.0.1:8899/');
  assert.equal(StatusView.controllerUrl({ ...ap, active: false }, ['http://192.168.1.11:8897/'], 'x'),
    'http://192.168.1.11:8899/');
  assert.equal(StatusView.controllerUrl(null, [], 'http://robot.local:8899/'), 'http://robot.local:8899/');
});

test('going back to practice says what the lessons are set to', () => {
  assert.equal(StatusView.labRestoredText({ restored: true, autostart: true, drive: false, shoot: true }),
    '教材は大会モードの前の設定に戻しました（配信の自動開始: オン・教材からの走行: 禁止・発射: 許可）');
  assert.match(StatusView.labRestoredText({ restored: false, autostart: true, drive: true, shoot: true }),
    /^教材の設定をオンにしました/);
  assert.equal(StatusView.labRestoredText(null), '');
});

test('the E-stop row uses the bridge report even when pages may not move the robot', () => {
  const lab = (emergencyStop) => ({ bridge: { read_only: true, shoot_state: { allowed: false },
    drive_state: { allowed: false, blockers: [] }, emergency_stop: emergencyStop } });
  assert.equal(StatusView.estop(lab(true), 'active').text, '押されています');
  assert.equal(StatusView.estop(lab(false), 'active').text, '解除されています');
  // No report yet (or an older bridge): unknown rather than a guess.
  assert.match(StatusView.estop(lab(null), 'active').text, /^分かりません/);
});
