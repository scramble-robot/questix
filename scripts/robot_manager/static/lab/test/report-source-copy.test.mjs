import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
test('smoothing describes a configurable default, never an observed setting', () => {
  const copy = JSON.parse(read('content/live/drive-report.json'));
  assert.match(copy.smoothing, /既定の設定では約\{tau\}秒/);
  assert.match(copy.smoothing, /設定で変わります/);
  const view = read('js/live/drive-report-view.js');
  assert.match(view, /const DEFAULT_MEASURED_SMOOTHING = 0\.15/);
  assert.doesNotMatch(view, /const MEASURED_SMOOTHING/);
  const config = readFileSync(
    new URL('../../../../../launcher/config/drive_component.yaml', import.meta.url),
    'utf8',
  );
  assert.equal(
    Number(view.match(/DEFAULT_MEASURED_SMOOTHING = ([\d.]+)/)[1]),
    Number(config.match(/measured_lpf_tau_sec:\s*([\d.]+)/)[1]),
  );
  const rendered = copy.smoothing.replace('{tau}', '0.15');
  assert.match(rendered, /既定の設定では約0\.15秒/);
  assert.doesNotMatch(rendered, /中で約0\.15秒ぶん/);
});

test('the live wheel chart names browser receive time separately from report message time', () => {
  const live = JSON.parse(read('content/live/robot-state.json'));
  const report = JSON.parse(read('content/live/drive-report.json'));
  assert.ok(JSON.stringify(live).includes('受信時刻（秒、0がいま）'));
  assert.notEqual(report.timeAxis, '受信時刻（秒、0がいま）');
});
