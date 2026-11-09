import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { wallSpeedDisplay } from '../js/control/live-limits.js';
import { WALL_MAX_SPEED, wallApproach } from '../js/control/live-drive.js';
import { limitCommand } from '../js/live/drive-core.js';
const copy = JSON.parse(
  fs.readFileSync(new URL('../content/control/ui.json', import.meta.url)),
).live;
for (const limit of [0.1, 0.15, 0.2])
  test(`wall speed display matches the existing controller and clamp at limit ${limit}`, () => {
    const display = wallSpeedDisplay({ maximum: WALL_MAX_SPEED, limit, connected: true }, copy);
    const controller = wallApproach({ kp: 8, ki: 0, kd: 0, filter: 0, antiWindup: true }, {});
    const command = controller(0, {
      scan: {
        stamp: 1,
        angle_min: -Math.PI,
        angle_increment: Math.PI / 180,
        ranges: Array(360).fill(1.5),
      },
      age: () => 0,
      drive: { v: 0 },
      limits: { linear: limit, angular: 0.5 },
    });
    assert.equal(display.top, limitCommand(command, { linear: limit, angular: 0.5 }).linear);
    assert(display.note.includes('0.15 m/s'));
    if (limit < 0.15) {
      assert(display.note.includes('0.10 m/s'));
      assert(display.note.includes('この機体の上限'));
    } else assert.equal(display.note, '教材の最高速度は0.15 m/sです。');
  });
test('an unknown or disconnected limit is described as unknown', () => {
  for (const connected of [false, true]) {
    const m = wallSpeedDisplay(
      { maximum: WALL_MAX_SPEED, limit: connected ? undefined : 0.1, connected },
      copy,
    );
    assert.equal(m.top, 0.15);
    assert(m.note.includes('接続後に確認してください'));
  }
});
