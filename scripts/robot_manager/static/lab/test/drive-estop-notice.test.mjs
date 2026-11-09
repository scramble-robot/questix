import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createStateTracker,
  ingest,
  robotStateModel,
  stripModel,
  STALE_SECONDS,
} from '../js/live/robot-state-core.js';

test('a fresh true drive report has a separate notice without changing the shared badge', () => {
  const tracker = createStateTracker();
  ingest(tracker, 'drive', { v: 0, w: 0, emergency_stop: true }, 100, null);
  for (const estopState of ['released', 'unknown', 'stale', 'pressed']) {
    for (const now of [100, 100 + STALE_SECONDS.drive * 1000, 101 + STALE_SECONDS.drive * 1000]) {
      const model = robotStateModel(tracker, { link: { connected: true }, now, estopState });
      assert.equal(model.estopState, estopState);
      const expected = now <= 100 + STALE_SECONDS.drive * 1000 && estopState !== 'pressed';
      assert.equal(model.driveEstopNotice, expected);
      assert.equal(stripModel(model).driveEstopNotice, expected);
    }
  }
  ingest(tracker, 'drive', { v: 0, w: 0, emergency_stop: false }, 2000, null);
  assert.equal(
    robotStateModel(tracker, { link: { connected: true }, now: 2000, estopState: 'released' })
      .driveEstopNotice,
    false,
  );
  assert.equal(
    robotStateModel(createStateTracker(), { link: { connected: true }, now: 0 }).driveEstopNotice,
    false,
  );
});

test('the card and strip use the same reserved content line, distinct from E-stop badges', () => {
  const view = fs.readFileSync(new URL('../js/live/robot-state-view.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../css/robot-state.css', import.meta.url), 'utf8');
  const copy = JSON.parse(
    fs.readFileSync(new URL('../content/live/robot-state.json', import.meta.url)),
  );
  assert(copy.estop.driveReport.includes('走行の制御'));
  assert.match(view, /driveEstopNotice\(model, text\)/);
  assert.match(view, /driveEstopNotice\(strip, text\)/);
  assert.match(view, /aria-hidden=\$\{!model.driveEstopNotice\}/);
  assert.match(css, /\.rs-drive-estop-notice\[aria-hidden='true'\]\s*\{\s*visibility: hidden;/);
});
