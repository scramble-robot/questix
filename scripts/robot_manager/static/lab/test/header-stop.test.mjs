import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
function fixture() {
  let phase = 'idle';
  const sent = [];
  const context = {
    copy: JSON.parse(read('content/live/stop-control.json')),
    html: (strings, ...values) => ({ strings: [...strings], values }),
    robotState: () => ({ phase }),
    stopDrive: () => sent.push({ type: 'stop' }),
    stopLauncher: () => sent.push({ type: 'roller_stop' }),
    document: { getElementById: () => null },
    onRobot: () => {},
  };
  vm.runInNewContext(
    read('js/live/stop-control.js')
      .replace(/^import .*;\n/gm, '')
      .replace(/^const copy = await .*;\n/m, '')
      .replace(
        'export { labStopButton, stopLabMotion };',
        'globalThis.api = { labStopButton, stopLabMotion };',
      ),
    context,
  );
  return { ...context.api, sent, setPhase: (value) => (phase = value), context };
}

test('shared stop always invokes both existing senders, including while idle or disconnected', () => {
  const f = fixture();
  for (const phase of ['idle', 'open', 'connecting', 'error']) {
    f.setPhase(phase);
    const button = f.labStopButton();
    const click = button.values.find((value) => typeof value === 'function');
    click();
    assert.deepEqual(f.sent.splice(0), [{ type: 'stop' }, { type: 'roller_stop' }]);
  }
  // A failed local drive cleanup must not prevent the independent roller stop.
  f.context.stopDrive = () => {
    throw Error('cleanup failed');
  };
  assert.throws(f.stopLabMotion, /cleanup failed/);
  assert.deepEqual(f.sent, [{ type: 'roller_stop' }]);
});

test('stop reserves its place on first connection and stays visible but disabled after disconnect', () => {
  const f = fixture();
  const attributes = () => {
    const { strings, values } = f.labStopButton();
    return Object.fromEntries(
      strings.flatMap((s, i) => {
        const name = s.match(/\?(hidden|disabled)=$/)?.[1];
        return name ? [[name, values[i]]] : [];
      }),
    );
  };
  assert.deepEqual(attributes(), { hidden: true, disabled: true });
  f.setPhase('open');
  assert.deepEqual(attributes(), { hidden: false, disabled: false });
  f.setPhase('idle');
  assert.deepEqual(attributes(), { hidden: false, disabled: true });
});

test('all modal headings reuse the same stop control and keep status in a separate live region', () => {
  const status = read('js/live/live-status.js');
  assert.match(status, /querySelectorAll\('dialog'\)/);
  assert.match(status, /dialog\.prepend\(host\)/);
  assert.match(status, /live-dialog-stop-row.*\$\{labStopButton\(\)\}/);
  assert.match(status, /class="live-status-line"\s+role="status"/);
  assert.match(read('index.html'), /class="header-actions"><span id="labHeaderStop"/);
  const copy = JSON.parse(read('content/live/stop-control.json'));
  for (const word of ['走行', 'ローラー', 'コントローラー', '非常停止', '仰角', '取り消せません'])
    assert(copy.description.includes(word));
});

test('the bottom stop bar and its reserved padding are removed', () => {
  for (const file of [
    'index.html',
    'css/live.css',
    'js/main.js',
    'js/core/reveal.js',
    'js/live/live-view.js',
  ])
    assert.doesNotMatch(
      read(file),
      /liveStopBar|live-stop-reserved|--live-stop-height|stop-bar\.js/,
    );
  for (const file of ['js/live/stop-bar.js', 'content/live/stop-bar.json'])
    assert(!fs.existsSync(new URL(`../${file}`, import.meta.url)));
});
