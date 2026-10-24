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
for (const limits of [
  null,
  { linear: null, angular: null },
  { linear: null, angular: 0.5 },
  { linear: 0.2, angular: null },
  { linear: '0.2', angular: 0.5 },
  { linear: NaN, angular: Infinity },
  { linear: 0.2, angular: 0.5 },
  { linear: 0, angular: 0 },
]) {
  test(`drive limits render missing values without inventing zero: ${JSON.stringify(limits)}`, () => {
    const state = { blockers: [{ code: 'no_drive_node' }], confirmed: false, limits };
    const markup = drive.driveControls({ slot: 'limits', running: false }, state, actions);
    const text = markup.match(/class="drive-limits-value">([^]*?)<\/span>/)[1];
    if (Number.isFinite(limits?.linear) && Number.isFinite(limits?.angular)) {
      assert(text.includes(limits.linear.toFixed(2)));
      assert(text.includes(limits.angular.toFixed(2)));
      assert(!text.includes('未受信'));
    } else assert.match(text, /上限：未受信/);
    assert.match(markup, /class="drive-limits-reserve" aria-hidden="true"/);
    assert.match(markup, /data-drive-start[^>]*\?disabled=true/);
  });
}

test('bench slider leaves an unreceived wheel limit unknown', () => {
  const source = fs.readFileSync(new URL('../js/live/drive-ui.js', import.meta.url), 'utf8');
  const body = source.slice(
    source.indexOf('function speedSlider('),
    source.indexOf('\nfunction benchPanel('),
  );
  const slider = vm.runInNewContext(`(${body})`, {
    html,
    bench: { linear: 0.1, angular: 0.5, held: null },
    BENCH_MIN: { linear: 0.06, angular: 0.3 },
    BENCH_STEP: { linear: 0.02, angular: 0.1 },
    limitOf: (model, key) => model.limits[key],
    hardBlocked: () => true,
  });
  for (const value of [null, undefined, NaN, Infinity, '0.2', 0.2]) {
    const markup = slider({ limits: { linear: value } }, 'linear', '速さ');
    assert.match(
      markup,
      Number.isFinite(value) ? /<output\s*>\s*0\.10\s*m\/s/ : /<output\s*>\s*—\s*m\/s/,
    );
    assert.match(markup, /\?disabled=true/);
  }
});

test('motor program uses the unknown-limit copy until a finite speed arrives', () => {
  const source = fs.readFileSync(new URL('../js/motor/ui.js', import.meta.url), 'utf8');
  const body = source
    .slice(source.indexOf('const benchDrive ='))
    .match(/program\(\) \{([^]*?)\n  \},\n  placement:/)[1];
  for (const linear of [null, undefined, NaN, Infinity, '0.2', 0.2]) {
    const program = vm.runInNewContext(`(function(){${body}})`, {
      benchLimits: () => ({ linear }),
      copy: { bench: { programUnknown: '上限：未受信', program: '{linear}' } },
      stepsText: () => '',
      BENCH_HOLD: 1,
      benchSteps: () => [],
      programSeconds: () => 3,
      rpmOf: () => '',
      fill,
    });
    assert.equal(program(), Number.isFinite(linear) ? '0.20' : '上限：未受信');
  }
});
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
test("the launcher's own stop names its visible text and is neutral while disabled", () => {
  const copy = JSON.parse(fs.readFileSync(new URL('../content/live/shoot.json', import.meta.url)));
  // Label in Name (WCAG 2.5.3): the spoken name must contain the visible text.
  assert(copy.spinStopLabel.includes(copy.spinStop));
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
  const markup = shoot.shootBlock(
    {
      ...ready,
      controls: shootControls(ready),
      spinning: false,
      percent: 50,
      tilt: 40,
      launcher: { roller: null, shot: null, heard: {} },
      estopState: 'released',
    },
    {},
    actions,
  );
  assert.match(
    markup,
    new RegExp(`data-shoot-own-stop[^>]*aria-label=${copy.spinStopLabel}[^>]*\\?disabled=true`),
  );
  // Red is for a stop that can be pressed; a disabled stop looks like the other disabled buttons.
  // The rule is shared by the drive panel's stop, the launcher's own stop and the shared header/dialog stop control.
  const css = fs.readFileSync(new URL('../css/live.css', import.meta.url), 'utf8');
  const rule = css.match(/\.drive-stop:disabled,\s*\.lab-stop:disabled \{([^}]*)\}/);
  assert(rule, 'disabled stop rule');
  assert.match(rule[1], /background: white;/);
  assert.match(rule[1], /color: var\(--muted\);/);
});
test('the drive panel stop shows one stop mark, drawn by the stylesheet', () => {
  const css = fs.readFileSync(new URL('../css/live.css', import.meta.url), 'utf8');
  assert.match(css, /\.drive-stop::before,\s*\.lab-stop::before \{\s*content: '■';/);
  const model = {
    slot: 'test',
    link: { connected: true, phase: 'open', missing: [] },
    recording: false,
    running: false,
    tail: false,
    seconds: 5,
    file: null,
    drive: { blockers: [], ready: true, allowed: true, confirmed: true, program: '', report: null },
  };
  const markup = live.liveCaptureControls(model, actions);
  const stop = markup.match(/data-drive-stop[^>]*>([^<]*)<\/button>/);
  assert(stop, 'drive stop button');
  assert(!stop[1].includes('■'), stop[1]);
  assert(stop[1].includes(drive.driveCopy.stop));
});
test('drive start labels wrap only between phrases', () => {
  // `.drive-start` uses `word-break: keep-all`: a line may break only at a space or a zero-width
  // space, so a label longer than five characters needs one between its phrases.
  const read = (file) =>
    JSON.parse(fs.readFileSync(new URL(`../content/${file}`, import.meta.url)));
  const labels = [
    read('live/drive.json').start,
    read('control/ui.json').live.driveWallStart,
    read('motor.json').bench.start,
    read('systems/measurement-lab.json').messages.driveDistanceStart,
  ];
  for (const label of labels) {
    const visible = label.replace(/\u200b/g, '');
    if (visible.length > 5) assert.match(label, /[ \u200b]/, label);
    assert.doesNotMatch(label, /\u200b\u200b|^\u200b|\u200b$/, label);
  }
});
