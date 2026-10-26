import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PLAN_SPEEDS,
  PLAN_TIMES,
  PLAN_RADIUS,
  PLAN_ACCELERATION,
  RPM_TO_RADIANS,
  perRadianGain,
  speedToRPM,
  rpmToSpeed,
  minimumTime,
  formatSpeed,
  angularSpeedText,
  accelerationTime,
  simulationPlan,
} from '../js/control/simulation-plan.js';
import { simulateControl, CONTROL_TOPICS } from '../js/control/core.js';
globalThis.document ??= {
  createComment: () => ({}),
  createTreeWalker: () => ({}),
  createElement: () => ({}),
  importNode: () => ({}),
};
const { planCard } = await import('../js/control/plan-view.js');
const copy = JSON.parse(fs.readFileSync(new URL('../content/control/ui.json', import.meta.url)));
const close = (a, b) => assert(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
function flatten(x) {
  if (x === null || x === undefined || typeof x === 'symbol') return '';
  if (Array.isArray(x)) return x.map(flatten).join('');
  if (x.strings) return x.strings.reduce((s, t, i) => s + t + flatten(x.values[i]), '');
  return String(x);
}
test('every selected speed fits even the 80 rpm mismatch plant', () => {
  assert.equal(PLAN_RADIUS, 0.05);
  assert.equal(PLAN_ACCELERATION, 1.5);
  for (const speed of PLAN_SPEEDS) {
    const rpm = speedToRPM(speed);
    assert(rpm > 0 && rpm < 80);
    assert(rpm + 15 < 100);
    close(rpmToSpeed(rpm), speed);
  }
  assert.deepEqual(PLAN_SPEEDS.map(formatSpeed), ['0.40', '0.20', '0.15', '0.10', '0.05']);
});
test('wheel units and acceleration use the selected unrounded values', () => {
  close(speedToRPM(0.1), 60 / Math.PI);
  close(speedToRPM(0.1) * RPM_TO_RADIANS, 2);
  close(minimumTime(0.15), 0.1);
  assert.equal(angularSpeedText(60), '6.28 rad/s（約 60.0 rpm）');
  assert.equal(angularSpeedText(-0.00001), '0.00 rad/s（約 0.0 rpm）');
  for (const v of PLAN_SPEEDS) {
    close(accelerationTime(v, 'minimum'), v / 1.5);
    assert.throws(() => accelerationTime(v, 0.001));
    for (const t of PLAN_TIMES) assert(accelerationTime(v, t) >= minimumTime(v));
  }
});
test('slope and area are the velocity/time formula and triangle plus rectangle', () => {
  for (const v of PLAN_SPEEDS)
    for (const t of [...PLAN_TIMES, minimumTime(v)]) {
      const p = simulationPlan(v, t);
      close(p.acceleration, v / t);
      close(p.triangle, (v * t) / 2);
      close(p.rectangle, v * 5);
      close(p.distance, p.triangle + p.rectangle);
      const r = simulateControl('reference', { targetSpeed: v, accelerationSeconds: t });
      close(r.config.targetRPM, speedToRPM(v));
      for (const s of r.samples)
        close(s.target * PLAN_RADIUS * RPM_TO_RADIANS, v * Math.min(1, s.time / t));
    }
});
test('legacy models, gains, criteria and all default trajectories remain unchanged', () => {
  const baseline = JSON.parse(
    fs.readFileSync(new URL('./fixtures/control-model-baseline.json', import.meta.url)),
  );
  assert.equal(baseline.length, CONTROL_TOPICS.length);
  for (const b of baseline) {
    const r = simulateControl(b.id);
    assert.deepEqual(r.config, b.config);
    assert.equal(r.collision, b.collision);
    for (const [k, v] of Object.entries(b.metrics)) {
      if (typeof v === 'number') close(r.metrics[k], v);
      else assert.equal(r.metrics[k], v);
    }
    const actual = r.samples.filter((_, i) => i % 20 === 0);
    assert.equal(actual.length, b.samples.length);
    actual.forEach((s, i) => {
      for (const [k, v] of Object.entries(s)) {
        if (typeof v === 'number') close(v, b.samples[i][k]);
        else assert.equal(v, b.samples[i][k]);
      }
    });
  }
});
test('the plan puts all numbers outside the plot and output lessons do not ask for a speed target', () => {
  const model = {
    distance: false,
    topicId: 'reference',
    simulationReady: true,
    chartWidth: 600,
    config: { targetSpeed: 0.1, accelerationSeconds: 1 },
  };
  const markup = flatten(planCard(model, copy));
  const plot = markup.match(/<g data-plan-plot>([\s\S]*?)<\/g>/)[1];
  assert(!plot.includes('<text'));
  assert(markup.includes('0.10 m/s'));
  assert(markup.includes('0.550 m'));
  assert(markup.includes('2.0 rad/s'));
  assert.equal(flatten(planCard({ ...model, topicId: 'output' }, copy)), '');
});
test('simulation choices do not enter the real speed program or senders', () => {
  const ui = fs.readFileSync(new URL('../js/control/ui.js', import.meta.url), 'utf8');
  const drive = ui.slice(ui.indexOf('const speedDrive ='), ui.indexOf('const wallMessages'));
  assert(drive.includes('speedStep(liveStepSpeed)'));
  assert(!drive.includes('targetSpeed'));
  assert(!drive.includes('accelerationSeconds'));
  for (const path of [
    '../js/control/live-drive.js',
    '../js/live/drive-link.js',
    '../js/live/shoot-link.js',
    '../js/live/robot-link.js',
  ])
    assert(!fs.readFileSync(new URL(path, import.meta.url), 'utf8').includes('simulation-plan'));
});

test('the displayed FF product converts both wheel speed and coefficient together', () => {
  for (const speed of PLAN_SPEEDS)
    for (const gain of [0, 0.5, 1, 2])
      close((speed / PLAN_RADIUS) * perRadianGain(gain), speedToRPM(speed) * gain);
  const view = fs.readFileSync(new URL('../js/control/view.js', import.meta.url), 'utf8');
  assert(!view.includes('1 rpmあたり'));
  assert.match(view, /1 rad\/sあたり[\s\S]*?perRadianGain\(result.config.ffGain\)/);
});
