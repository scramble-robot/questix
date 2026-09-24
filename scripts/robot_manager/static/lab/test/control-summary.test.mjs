// Run with: node --test test/*.test.mjs
//
// The words and numbers the feedback-control course shows under a finished run
// (js/control/summary.js): the settled speed of the first stage, the sentence with the run's own
// numbers, the numbered topic places, and no "-0" anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTROL_TOPICS, controlDefaults, simulateControl } from '../js/control/core.js';
import {
  formatValue,
  settledSpeed,
  speedGap,
  runSummary,
  topicPlace,
  isSimpleTopic,
} from '../js/control/summary.js';

const copy = JSON.parse(fs.readFileSync(new URL('../content/control/ui.json', import.meta.url)));
const text = copy.summary;
const run = (id, config = {}) => simulateControl(id, { ...controlDefaults(id), ...config });

test('formatValue never shows a negative zero', () => {
  assert.equal(formatValue(-0.04, 1), '0.0');
  assert.equal(formatValue(-0.4, 0), '0');
  assert.equal(formatValue(-0, 2), '0.00');
  assert.equal(formatValue(-1.25, 1), '-1.3');
  assert.equal(formatValue(12.345), '12.3');
});

test('the first topic says the settled speed and how far it is from the target', () => {
  const slow = run('output', { power: 30 });
  assert.equal(Math.round(settledSpeed(slow)), 30);
  assert.equal(speedGap(slow, text), '目標60 rpmまであと30 rpm');
  assert.equal(
    runSummary(slow, 'output', text),
    '車輪は30 rpmで落ち着きました（目標60 rpmまであと30 rpm）。',
  );
  const fast = run('output', { power: 80 });
  assert.equal(speedGap(fast, text), '目標60 rpmより20 rpm速い');
  assert.equal(speedGap(run('output', { power: 60 }), text), '目標どおり');
});

test('from the P topic on, the sentence names the overshoot and the settling time', () => {
  const p = run('p');
  assert.equal(isSimpleTopic('p'), false);
  const sentence = runSummary(p, 'p', text);
  assert.match(sentence, /^最後の2秒の平均は26 rpmで、目標60 rpmまであと34 rpmです。/);
  assert.match(sentence, /目標を越えることはなく/);
  assert.match(sentence, /落ち着きませんでした。$/);
  const i = run('i', { ki: 3 });
  assert.match(
    runSummary(i, 'i', text),
    /負荷が変わった5秒から[\d.]+秒で目標±3 rpmに戻りました。$/,
  );
  assert.doesNotMatch(runSummary(i, 'i', text), /\{|undefined|-0/);
});

test('a distance run is described in centimetres from the wall', () => {
  const d = run('d');
  const sentence = runSummary(d, 'd', text);
  assert.match(
    sentence,
    /^いちばん近づいたのは壁から\d+ cmで、止まる位置（50 cm）を\d+ cm越えました。/,
  );
  assert.doesNotMatch(sentence, /\{|undefined| m[^/]/);
  const gentle = run('d', { kd: 1.5 });
  assert.match(runSummary(gentle, 'd', text), /越えませんでした|越えました/);
});

test('topics are numbered by stage and position', () => {
  assert.deepEqual(topicPlace(CONTROL_TOPICS, 'output'), {
    stage: 1,
    position: 1,
    count: 4,
    label: '1-1',
  });
  assert.equal(topicPlace(CONTROL_TOPICS, 'd').label, '2-3');
  assert.equal(topicPlace(CONTROL_TOPICS, 'challenge').label, '4-1');
  // Every placeholder of the navigation line is filled.
  const place = topicPlace(CONTROL_TOPICS, 'i');
  const line = copy.nav.place.replace(/\{(\w+)\}/g, (match, key) => place[key]);
  assert.equal(line, '段階2 · 3実験のうち2つ目');
});
