const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
const panel = html.slice(html.indexOf('id="panel-control"'), html.indexOf('id="panel-tuning"'));
const cards = [...panel.matchAll(/^    <section\b[\s\S]*?^    <\/section>/gm)].map(match => match[0]);

test('control cards follow the operator workflow after the shared notices', () => {
  assert(html.indexOf('class="notification-region"') < html.indexOf('id="panel-control"'));
  assert.deepEqual(cards.map(card => card.match(/<h2[^>]*>(.*?)<\/h2>/)[1]), [
    'ロボットの状態', '起動前の確認', '次回起動のモード', 'ロボット制御の起動・停止',
    '先生の操作許可（教材モード）', 'ブラウザ・スマホのコントローラー',
  ]);
});

test('nine status tiles replace the one-shot diagnostic controls', () => {
  const current = cards[0];
  assert.equal((current.match(/<dt>/g) || []).length, 9);
  for (const id of ['status-heading', 'st-drive-permission', 'st-launcher-permission']) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
    assert(current.includes(`id="${id}"`));
  }
  assert.doesNotMatch(html, /motion-state/);
  assert.match(current, /走行の許可（ロボット側）/);
  assert.match(current, /発射機構の許可（ロボット側）/);
});

test('the moved permission card retains both three-way choices, neutral warning and E-stop', () => {
  const permission = cards[4];
  assert.equal((permission.match(/type="radio"/g) || []).length, 6);
  assert.match(permission, /コントローラーから手を離してください/);
  assert.match(permission, /id="permission-estop-state"/);
  assert.equal((permission.match(/class="permission-choice"/g) || []).length, 2);
});
