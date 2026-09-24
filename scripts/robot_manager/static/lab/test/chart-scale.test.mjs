// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// The shared axis scale (js/core/chart-scale.js) and colour roles (js/core/palette.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { niceStep, niceScale, formatTick, decimalsOf, scaleTo } from '../js/core/chart-scale.js';
import { roleStyle, CHART_ROLE_COLORS, SCENE_ROLE_COLORS } from '../js/core/palette.js';

test('steps are 1, 2, 2.5 or 5 times a power of ten', () => {
  assert.equal(niceStep(2.2), 0.5);
  assert.equal(niceStep(1.3), 0.5);
  assert.equal(niceStep(10, 5), 2);
  assert.equal(niceStep(122.7 + 54.1), 50);
  assert.equal(niceStep(0.9, 5), 0.2);
  assert.equal(niceStep(0), 1);
});

test('the axis includes zero and ends on round values', () => {
  const scale = niceScale([0.3, 1.1, 2.2]);
  assert.equal(scale.min, 0);
  assert.equal(scale.max, 2.5);
  assert.deepEqual(scale.ticks, [0, 0.5, 1, 1.5, 2, 2.5]);
});

test('a negative speed gets a zero line inside the range', () => {
  const scale = niceScale([-0.4, -0.35, -0.1]);
  assert.ok(scale.min <= -0.4);
  assert.equal(scale.max, 0);
  assert.ok(scale.ticks.includes(0));
  assert.ok(
    scale.ticks.every((tick) => Math.abs(tick / scale.step - Math.round(tick / scale.step)) < 1e-9),
  );
});

test('counts get whole ticks', () => {
  const scale = niceScale([0, 12, 36, 71], { integer: true });
  assert.ok(scale.ticks.every(Number.isInteger));
  assert.ok(scale.max >= 71);
});

test('extra values such as a target line are kept inside the range', () => {
  const scale = niceScale([0.1, 0.2], { max: 1.2 });
  assert.ok(scale.max >= 1.2);
});

test('without zero the range hugs the data', () => {
  const scale = niceScale([48, 52, 50], { includeZero: false });
  assert.ok(scale.min > 40 && scale.max < 60, JSON.stringify(scale));
});

test('tick labels have the decimals the step needs and never read -0', () => {
  assert.equal(decimalsOf(0.25), 2);
  assert.equal(decimalsOf(20), 0);
  assert.equal(formatTick(0.30000000000000004, 0.1), '0.3');
  assert.equal(formatTick(-0, 0.5), '0.0');
  assert.equal(formatTick(-1e-12, 1), '0');
});

test('scaleTo maps the range onto pixels', () => {
  const y = scaleTo({ min: 0, max: 2 }, 200, 0);
  assert.equal(y(0), 200);
  assert.equal(y(1), 100);
});

test('every role has a colour on both surfaces and a line style', () => {
  for (const role of ['actual', 'measured', 'target', 'plan', 'previous', 'event', 'danger']) {
    assert.ok(CHART_ROLE_COLORS[role] && SCENE_ROLE_COLORS[role], role);
    assert.ok(roleStyle(role).width > 0);
  }
  assert.equal(roleStyle('target').dash, '8 5');
  assert.equal(roleStyle('measured', 'scene').color, SCENE_ROLE_COLORS.measured);
});

test('the CSS tokens carry the same colours as palette.js', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../css/tokens.css', import.meta.url), 'utf8');
  for (const [role, color] of Object.entries(CHART_ROLE_COLORS)) {
    if (['grid', 'axis'].includes(role)) continue;
    assert.ok(css.includes(`--role-${role}: ${color};`), role);
  }
  for (const [role, color] of Object.entries(SCENE_ROLE_COLORS)) {
    if (['grid', 'axis'].includes(role)) continue;
    assert.ok(css.includes(`--scene-role-${role}: ${color};`), role);
  }
});
