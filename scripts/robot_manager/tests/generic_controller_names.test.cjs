const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const labels = require('../static/control-labels.js');
const root = path.join(__dirname, '../static');
const forbidden = /\b(?:DualShock|DUALSHOCK|Switch|SWITCH)\b/;

test('visible Manager strings use generic names while persisted controller values stay stable', () => {
  assert.equal(labels.controllerName('dualshock'), 'ゲームパッド');
  assert.equal(labels.controllerName('uart'), '大会用コントローラー');
  assert.equal(labels.controllerName('web'), 'Web（ブラウザ・スマホ）');
  assert.deepEqual(labels.controllers, ['uart', 'dualshock', 'web']);
  for (const file of fs.readdirSync(root).filter(name => /\.(?:js|html)$/.test(name))) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
    const visible = file.endsWith('.html') ? source : (source.match(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g) || []).join('\n');
    assert.doesNotMatch(visible, forbidden, file);
  }
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.equal((html.match(/value="uart">大会用コントローラー</g) || []).length, 2);
  assert.equal((html.match(/value="dualshock">ゲームパッド</g) || []).length, 2);
  for (const [file, previous] of [['control-labels.js', 4], ['controller-map.js', 13], ['controls.js', 24]]) {
    const version = Number(html.match(new RegExp(file.replaceAll('.', '\\.') + '\\?v=(\\d+)'))[1]);
    assert(version > previous, file + ' must invalidate the home integration version');
  }
});
