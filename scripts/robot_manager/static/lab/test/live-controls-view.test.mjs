// Execute production templates with fake links/models; no browser, bridge, ROS or processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fillSentence as fill } from '../js/core/content.js';
import {
  shootControls,
  powerRange,
  reasonSentence,
  blockerValues,
  refusalSentence,
  LEARNER_BLOCKERS,
} from '../js/live/shoot-core.js';
const html = (strings, ...values) => {
  const show = (value) =>
    Array.isArray(value)
      ? value.map(show).join('')
      : typeof value === 'function' || value == null
        ? ''
        : String(value);
  return strings.reduce(
    (text, part, i) => text + part + (i < values.length ? show(values[i]) : ''),
    '',
  );
};
async function moduleView(file, dependencies = {}) {
  let source = fs.readFileSync(new URL(`../js/live/${file}`, import.meta.url), 'utf8');
  const exported = source.match(/export \{([^]*?)\};/)[1].replace(/(\w+) as (\w+)/g, '$2: $1');
  source = source
    .replace(/^import[^]*?from ['"][^'"]+['"];\n/gm, '')
    .replace(/export \{[^]*?\};/, `return {${exported}};`);
  return vm.runInNewContext(`(async()=>{${source}})()`, {
    html,
    nothing: '',
    fill,
    unsafeHTML: (value) => value,
    runModeBadgeHtml: () => '',
    freshInteraction() {},
    loadJson: async (file) => JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url))),
    ...dependencies,
  });
}
const status = await moduleView('control-status.js');
const drive = await moduleView('drive-view.js', status);
const live = await moduleView('live-view.js', { ...drive, liveStateStrip: () => '' });
const shoot = await moduleView('shoot-view.js', {
  ...status,
  shootControls,
  powerRange,
  reasonSentence,
  blockerValues,
  refusalSentence,
  LEARNER_BLOCKERS,
});
const actions = new Proxy({}, { get: () => () => {} });
for (const code of [
  'no_link',
  'not_allowed',
  'estop_unknown',
  'emergency_stop',
  'no_motion_permission',
]) {
  test(`drive controls and checked confirmation remain present under ${code}`, () => {
    const model = {
      slot: 'test',
      link: { connected: code !== 'no_link', phase: 'open', missing: [] },
      recording: false,
      running: false,
      tail: false,
      seconds: 5,
      file: null,
      drive: {
        blockers: [{ code }],
        ready: false,
        allowed: false,
        confirmed: true,
        program: '',
        report: null,
      },
    };
    const markup = live.liveCaptureControls(model, actions);
    for (const attr of [
      'data-live-record-start',
      'data-live-record-stop',
      'data-drive-start',
      'data-drive-stop',
      'data-drive-confirm',
    ])
      assert(markup.includes(attr));
    assert.match(markup, /data-drive-confirm[^>]*\.checked=true[^>]*\?disabled=true/);
    assert.match(markup, /data-drive-start[^>]*\?disabled=true/);
    if (code !== 'no_link') assert.match(markup, /data-live-record-start[^>]*\?disabled=false/);
  });
  test(`launcher controls and chosen values remain present under ${code}`, () => {
    const ready = {
      blockers: [{ code }],
      allowed: false,
      limits: {
        max_power: 0.8,
        min_fire_power: 0.2,
        tilt_min: 0,
        tilt_max: 120,
        fire_interval_sec: 2,
      },
    };
    const model = {
      ...ready,
      controls: shootControls(ready, { tiltKnown: true }),
      confirmed: true,
      percent: 50,
      tilt: 40,
      launcher: { roller: null, shot: null, heard: { roller: false, shot: false } },
      estopState: 'unknown',
    };
    const markup = shoot.shootBlock(model, { tiltPreview: null }, actions);
    for (const attr of [
      'data-shoot-confirm',
      'data-shoot-power',
      'data-shoot-tilt',
      'data-shoot-spin',
      'data-shoot-own-stop',
      'data-shoot-fire',
    ])
      assert(markup.includes(attr));
    assert.match(markup, /data-shoot-confirm[^>]*\.checked=true[^>]*\?disabled=true/);
    assert.match(markup, /data-shoot-power[^>]*\.value=50[^>]*\?disabled=true/);
    assert(markup.includes('不明（まだ届いていません）'));
    assert(!markup.includes('非常停止：解除されています'));
  });
}
test('unknown and silent launcher E-stop text follows the supplied shared display model', () => {
  const ready = {
    blockers: [],
    allowed: true,
    limits: {
      max_power: 0.8,
      min_fire_power: 0.2,
      tilt_min: 0,
      tilt_max: 120,
      fire_interval_sec: 2,
    },
  };
  for (const state of ['unknown', 'stale']) {
    const markup = shoot.shootBlock(
      {
        ...ready,
        controls: shootControls(ready),
        percent: 50,
        tilt: 40,
        launcher: { roller: null, shot: null, heard: {} },
        estopState: state,
      },
      {},
      actions,
    );
    assert(markup.includes('非常停止：不明'));
    assert(!markup.includes('非常停止：解除されています'));
  }
});
