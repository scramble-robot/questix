const test = require('node:test');
const assert = require('node:assert/strict');
const guide = require('../static/operator-guide.js');
const now = Date.parse('2026-09-23T00:00:00Z');
const profile = { controller: 'uart', values: { drive: { speed: 2 }, shot: { fire: 5 } } };
const snapshot = (nodes) => ({ nodes, captured_at: new Date(now).toISOString() });
const compare = (runtime, draft = profile.values, controller = 'uart') =>
  guide.application(profile, draft, runtime, controller, now);

test('saved, dirty, mismatched-controller and stale snapshots cannot claim applied', () => {
  assert.equal(compare(null).kind, 'unknown');
  assert.equal(compare(null, { drive: { speed: 1 }, shot: { fire: 5 } }).kind, 'pending');
  const complete = snapshot({ drive: { status: 'ok', values: { speed: 2 } }, shot: { status: 'ok', values: { fire: 5 } } });
  assert.equal(compare(complete).kind, 'matched');
  assert.equal(compare(complete, profile.values, 'dualshock').kind, 'unknown');
  assert.equal(compare({ ...complete, captured_at: new Date(now - 31000).toISOString() }).kind, 'unknown');
  assert.equal(compare({ ...complete, captured_at: 'bad' }).kind, 'unknown');
});

test('missing nodes and undeclared parameters are explicitly partial or unknown', () => {
  const partial = compare(snapshot({ drive: { status: 'ok', values: { speed: 2 } } }));
  assert.equal(partial.kind, 'partial');
  assert.match(partial.note, /残り 1 項目は確認できていません/);
  assert.equal(compare(snapshot({ drive: { status: 'ok', values: {} } })).kind, 'unknown');
  assert.equal(compare(snapshot({ drive: { status: 'timeout', values: { speed: 2 } } })).kind, 'unknown');
  assert.equal(compare(snapshot({ drive: { status: 'ok', values: { speed: 1 } } })).kind, 'pending');
});

test('failures point to recovery without claiming a timed-out action was cancelled', () => {
  assert.equal(guide.failure('/api/control-config/uart', 409).panel, 'tuning');
  assert.match(guide.failure('/api/control-config/uart', 409).next, /変更内容を控え/);
  assert.equal(guide.failure('/api/rosbag/start', 507).panel, 'rec');
  assert.match(guide.failure('/api/service/start', 504).next, /操作が続いている可能性/);
  assert.match(guide.failure('/api/service/start', 0).next, /再接続後/);
  assert.equal(guide.failure('/api/launch-config', 403).panel, 'admin');
  assert.equal(guide.failure('/api/control-runtime', 503, 'ROS 環境が見つかりません').panel, 'admin');
});

test('404 details identify the endpoint and do not blame missing files on a version mismatch', () => {
  const missing = guide.failure('/api/control-runtime', 404, 'Not Found');
  assert.match(missing.detail, /\/api\/control-runtime/);
  assert.match(missing.detail, /HTTP 404/);
  assert.equal(missing.panel, 'admin');
  const file = guide.failure('/api/rosbag/bag', 404, 'Not Found');
  assert.doesNotMatch(file.next, /バージョン|更新・再起動/);
  assert.equal(file.panel, 'rec');
});
