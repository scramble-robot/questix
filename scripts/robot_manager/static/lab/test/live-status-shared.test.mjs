import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { liveStatusModel, DISPLAY_STALE_MS } from '../js/live/live-status-core.js';
import {
  createStateTracker,
  ingest,
  robotStateModel,
  stripModel,
} from '../js/live/robot-state-core.js';

const read = (name) => fs.readFileSync(new URL(`../js/live/${name}.js`, import.meta.url), 'utf8');

test('all display consumers read the header snapshot without another receive-time decision', async () => {
  let now = 0;
  let calculations = 0;
  let header;
  const handlers = new Map();
  const source = read('live-status')
    .replace(/^import[\s\S]*?from '[^']+';\n/gm, '')
    .replace("const copy = await loadJson('content/live/link.json');", 'const copy = {};')
    .replace(/export \{[^}]+\};/, 'return { liveStatus, onLiveStatus, drawStatuses };');
  const deps = {
    robotState: () => ({ phase: 'open' }),
    linkStage: () => 'open',
    liveStatusModel: (...args) => {
      calculations++;
      return liveStatusModel(...args);
    },
    performance: { now: () => now },
    onRobot: (type, fn) => handlers.set(type, fn),
    liveStatusLine: (model) => model,
    render: (model) => {
      header = model;
    },
    document: {
      body: {},
      getElementById: () => ({ setAttribute() {} }),
      querySelectorAll: () => [],
    },
    MutationObserver: class {
      observe() {}
    },
    setInterval() {},
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const api = await new AsyncFunction('deps', `const {${Object.keys(deps)}}=deps;\n${source}`)(
    deps,
  );
  const seen = [];
  api.onLiveStatus((model) => seen.push(model));
  handlers.get('estop')({ active: false });
  const released = api.liveStatus();
  assert.equal(released.estop, 'released');
  assert.strictEqual(released, header);
  assert.strictEqual(released, seen.at(-1));
  const count = calculations;
  now = DISPLAY_STALE_MS + 1;
  for (let consumer = 0; consumer < 6; consumer++) assert.strictEqual(api.liveStatus(), released);
  assert.equal(calculations, count, 'consumer reads do not recalculate expiry');
  api.drawStatuses();
  assert.equal(api.liveStatus().estop, 'stale');
  assert.strictEqual(api.liveStatus(), header);
  assert.strictEqual(api.liveStatus(), seen.at(-1));
  handlers.get('estop')({ active: true });
  assert.equal(api.liveStatus().estop, 'pressed');
  assert.strictEqual(api.liveStatus(), header);
});

test('state card and compact strip retain the supplied display state at every drawing time', () => {
  const tracker = createStateTracker();
  ingest(tracker, 'drive', { v: 0, w: 0, emergency_stop: true }, 0, null);
  ingest(tracker, 'estop', { active: true }, 0, null);
  for (const estopState of ['pressed', 'released', 'unknown', 'stale'])
    for (const now of [0, 1499, 1501, 100000]) {
      const model = robotStateModel(tracker, { link: { connected: true }, now, estopState });
      assert.equal(model.estopState, estopState);
      assert.equal(
        model.estop,
        estopState === 'pressed' ? true : estopState === 'released' ? false : null,
      );
      assert.equal(
        stripModel(model).estop,
        ['unknown', 'stale'].includes(estopState) ? 'unknown' : estopState,
      );
    }
});

test('all current E-stop display adapters subscribe to the shared model', () => {
  for (const name of ['shoot-ui', 'live-ui', 'robot-state']) {
    const source = read(name);
    assert.match(source, /onLiveStatus\(/, name);
    assert(!source.includes('liveStatusModel('), name);
  }
  assert.match(read('shoot-ui'), /estopState: liveStatus\(\)\.estop/);
  assert.match(read('robot-state'), /estopState: liveStatus\(\)\.estop/);
  assert.match(read('live-ui'), /words\[liveStatus\(\)\.estop\]/);
  assert(!read('robot-state').match(/const STREAMS = [^;]*'estop'/));
  assert(!read('robot-state-core').includes('drive.emergency_stop'));
});
