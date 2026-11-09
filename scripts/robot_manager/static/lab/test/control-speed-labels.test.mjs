// Run the production formatting and label-building code with a fake link, without opening it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { STEP_SPEEDS, STEP_HOLD, speedStep } from '../js/control/live-drive.js';
import { forwardRpm } from '../js/live/capture-core.js';
import { fillSentence as fill } from '../js/core/content.js';

const copy = JSON.parse(fs.readFileSync(new URL('../content/control/ui.json', import.meta.url)));
const source = fs.readFileSync(new URL('../js/control/ui.js', import.meta.url), 'utf8');
const start = source.indexOf('let liveStepSpeed =');
const end = source.indexOf('const wallMessages =', start);
assert(start >= 0 && end > start);
const context = { STEP_SPEEDS, STEP_HOLD, speedStep, forwardRpm, fill, copy, liveLink: () => ({}) };
vm.runInNewContext(
  source.slice(start, end) +
    '\nglobalThis.labels = { speedText, stepSpeedOptions, speedDrive, select: (speed) => { liveStepSpeed = speed; } };',
  context,
);
const { labels } = context;
const expected = ['0.05', '0.10', '0.15'];

test('the actual speedText preserves all three step speeds', () => {
  assert.deepEqual(STEP_SPEEDS.map(labels.speedText), expected);
});

test('the actual option template shows the speed and keeps its numeric value', () => {
  const options = Array.from(labels.stepSpeedOptions());
  assert.deepEqual(
    options.map((option) => option.speed),
    STEP_SPEEDS,
  );
  assert.deepEqual(
    options.map((option) => option.label),
    expected.map((speed, index) =>
      fill(copy.live.driveSpeedOption, {
        speed,
        rpm: forwardRpm(STEP_SPEEDS[index], { wheel_radius: 0.05 }).toFixed(0),
      }),
    ),
  );
  assert.equal(new Set(options.map((option) => option.label)).size, 3);
});

test('the actual run and recording labels retain the selected speed', () => {
  for (const [index, speed] of STEP_SPEEDS.entries()) {
    labels.select(speed);
    assert.equal(
      labels.speedDrive.program(),
      fill(copy.live.driveSpeedProgram, { speed: expected[index], hold: STEP_HOLD }),
    );
    const conditions = labels.speedDrive.conditions();
    assert.equal(conditions.speed, speed);
    assert.equal(conditions.label, `${expected[index]} m/s`);
    assert.equal(String(conditions), conditions.label);
  }
});
