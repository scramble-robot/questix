const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const NetworkView = require('../static/network-view.js');

const ap = (overrides = {}) => ({
  configured: true, active: true, state: 'up', ssid: 'QUESTiX-3F2A', password: 'Abc23456defg',
  band: 'bg', channel: '6', country: 'JP', address: '10.42.0.1', prefix: '24', clients: 3,
  upstream: { summary: 'none', wired: false, default_route: false }, admin_available: true,
  job: { state: 'idle' }, ...overrides,
});

test('AP not configured yet: start creates it, nothing to stop', () => {
  const view = NetworkView.summary({ configured: false, admin_available: true, job: { state: 'idle' } });
  assert.equal(view.state, 'unconfigured');
  assert.equal(view.label, '未設定');
  assert.equal(view.canStart, true);
  assert.equal(view.canStop, false);
  assert.equal(view.canRegenerate, false);
  assert.deepEqual(NetworkView.facts({ configured: false }), []);
});

test('stopped: start allowed, stop not', () => {
  const view = NetworkView.summary(ap({ active: false, state: 'down', clients: null }));
  assert.equal(view.state, 'stopped');
  assert.equal(view.label, '停止中');
  assert.equal(view.canStart, true);
  assert.equal(view.canStop, false);
  assert.match(view.text, /保存済みの Wi-Fi/);
  assert.equal(NetworkView.clientsText(ap({ active: false })), '—');
});

test('running: facts carry SSID, IP, band, channel, clients and upstream', () => {
  const data = ap();
  const view = NetworkView.summary(data);
  assert.equal(view.state, 'running');
  assert.equal(view.label, '稼働中');
  assert.equal(view.canStart, false);
  assert.equal(view.canStop, true);
  assert.deepEqual(Object.fromEntries(NetworkView.facts(data)), {
    'SSID（Wi-Fi の名前）': 'QUESTiX-3F2A',
    'ロボットの IP': '10.42.0.1',
    '周波数帯': '2.4 GHz',
    'チャンネル': '6',
    '接続中の端末': '3 台',
    '外へのネットワーク': 'なし（生徒の端末はロボットにだけつながります）',
  });
  assert.equal(NetworkView.clientsText(ap({ clients: null })), '不明');
});

test('applying: every button waits', () => {
  const view = NetworkView.summary(ap({ job: { state: 'running', action: 'start' } }));
  assert.equal(view.state, 'applying');
  assert.equal(view.label, '切り替え中…');
  assert.deepEqual([view.canStart, view.canStop, view.canSave, view.canRegenerate],
    [false, false, false, false]);
});

test('error: the helper message is shown, the state stays readable', () => {
  const view = NetworkView.summary(ap({ active: false, job: { state: 'failed', message: 'QUESTiX Local を開始できませんでした（設定は保存済みです）。' } }));
  assert.equal(view.state, 'stopped');
  assert.equal(view.tone, 'error');
  assert.match(view.notice, /開始できませんでした/);
});

test('success notice includes what happened to QUESTiX LAB', () => {
  const view = NetworkView.summary(ap({ job: { state: 'succeeded', message: 'QUESTiX Local を開始しました。', lab_message: '教材の配信を開始しました。' } }));
  assert.equal(view.tone, 'ok');
  assert.equal(view.notice, 'QUESTiX Local を開始しました。 教材の配信を開始しました。');
});

test('success notice says where the browser controller opens (CONTROLLER_TYPE=web)', () => {
  const view = NetworkView.summary(ap({ job: { state: 'succeeded', message: 'QUESTiX Local を開始しました。',
    lab_message: '大会モードのため、教材は配信しません。',
    controller_message: 'ブラウザのコントローラーは http://10.42.0.1:8899/ で開けます（ロボット制御の起動中）。' } }));
  assert.equal(view.notice, 'QUESTiX Local を開始しました。 大会モードのため、教材は配信しません。 ' +
    'ブラウザのコントローラーは http://10.42.0.1:8899/ で開けます（ロボット制御の起動中）。');
});

test('helper not installed: nothing can be pressed and the fix is named', () => {
  const view = NetworkView.summary(ap({ admin_available: false }));
  assert.equal(view.canStart || view.canStop || view.canSave, false);
  assert.match(view.notice, /update-robot-manager\.sh/);
});

test('upstream: none, wired only, default route', () => {
  assert.match(NetworkView.upstreamText({ summary: 'none' }), /^なし/);
  assert.match(NetworkView.upstreamText({ summary: 'wired' }), /^有線LANあり/);
  assert.match(NetworkView.upstreamText({ summary: 'default_route' }), /^あり/);
  assert.equal(NetworkView.upstreamText(undefined), '不明');
});

test('password is masked until shown', () => {
  assert.equal(NetworkView.passwordText(ap(), false), NetworkView.MASK);
  assert.equal(NetworkView.passwordText(ap(), true), 'Abc23456defg');
  assert.ok(!NetworkView.summary(ap()).text.includes('Abc23456defg'));
});

test('config body carries only what changed', () => {
  const same = { ssid: 'QUESTiX-3F2A', password: '', band: 'bg', channel: '6', addressMode: 'auto', address: '' };
  assert.ok(NetworkView.configChanges(same, ap()).error);
  assert.deepEqual(NetworkView.configChanges({ ...same, ssid: 'QUESTiX Room 3' }, ap()).body, { ssid: 'QUESTiX Room 3' });
  assert.deepEqual(NetworkView.configChanges({ ...same, band: 'a', channel: 'auto' }, ap()).body, { band: 'a', channel: 'auto' });
  assert.deepEqual(NetworkView.configChanges({ ...same, channel: '11' }, ap()).body, { channel: 11 });
  assert.deepEqual(NetworkView.configChanges({ ...same, password: 'n3w-Pass!' }, ap()).body, { password: 'n3w-Pass!' });
  assert.deepEqual(NetworkView.configChanges({ ...same, addressMode: 'manual', address: '10.50.0.1/24' }, ap()).body, { address: '10.50.0.1/24' });
});

test('config errors are caught before the request', () => {
  const same = { ssid: 'QUESTiX-3F2A', password: '', band: 'bg', channel: '6', addressMode: 'auto', address: '' };
  for (const form of [
    { ...same, ssid: ' leading' }, { ...same, ssid: 'x' }, { ...same, ssid: 'a;b' },
    { ...same, password: 'short' }, { ...same, password: 'has space1' }, { ...same, password: 'back\\slash1' },
    { ...same, channel: '36' }, { ...same, band: 'a', channel: '6' },
    { ...same, addressMode: 'manual', address: '10.42.0.1' },
  ]) {
    assert.ok(NetworkView.configChanges(form, ap()).error, JSON.stringify(form));
  }
});

test('limits are the same as the root helper', () => {
  const helper = fs.readFileSync(path.join(__dirname, '..', 'network_admin.py'), 'utf8');
  assert.ok(helper.includes(`SSID_PATTERN = r"${NetworkView.SSID_PATTERN}"`));
  assert.ok(helper.includes(`PASSWORD_PATTERN = r"${NetworkView.PASSWORD_PATTERN.replace(/\\\\/g, '\\')}"`));
  assert.ok(helper.includes('CHANNELS = {"bg": (1, 6, 11), "a": (36, 40, 44, 48)}'));
  assert.deepEqual(NetworkView.CHANNELS, { bg: [1, 6, 11], a: [36, 40, 44, 48] });
});

test('confirm texts warn about dropped Wi-Fi connections', () => {
  assert.match(NetworkView.confirmText('start', ap()), /SSH/);
  assert.match(NetworkView.confirmText('stop', ap()), /保存済みの Wi-Fi/);
  assert.match(NetworkView.confirmText('save', ap({ active: false })), /次に開始したとき/);
});
