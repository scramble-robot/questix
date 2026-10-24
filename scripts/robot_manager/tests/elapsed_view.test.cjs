const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Elapsed = require('../static/elapsed-view.js');

function appFixture() {
  let now = 0;
  const els = new Map();
  const document = { hidden: false, readyState: 'loading', addEventListener() {}, getElementById(id) {
    if (!els.has(id)) els.set(id, {textContent: '', value: '', hidden: false, addEventListener() {}, removeAttribute() {}, setAttribute() {}, replaceChildren() {}});
    return els.get(id);
  } };
  const context = vm.createContext({ document, performance: { now: () => now }, URL,
    location: { href: 'http://127.0.0.1:8888/' }, AbortController, AbortSignal });
  const index = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
  for (const match of index.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)) {
    const src = match[1].split(/[?#]/)[0];
    if (!src.startsWith('/static/')) continue;
    const file = src.slice('/static/'.length);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static', file), 'utf8'), context, {filename: file});
    if (file === 'app.js') break;
  }
  const run = code => vm.runInContext(code, context);
  return { document, run, at(value) { now = value; }, value(kind) { return els.get(`${kind}-elapsed`)?.textContent; },
    request(kind) { context.qaKind = kind; return run('elapsedTicket(qaKind)'); },
    receive(kind, ticket, data, running = true) { Object.assign(context, { qaKind: kind, qaTicket: ticket, qaData: data, qaRunning: running }); run('receiveElapsed(qaKind,qaData,qaRunning,qaTicket)'); },
    fail(kind, ticket) { Object.assign(context, {qaKind: kind,qaTicket: ticket}); run('failElapsed(qaKind,qaTicket)'); },
  };
}

test('fractional samples progress once per second with two/three second polling and jitter', () => {
  for (const poll of [2000, 3000]) {
    const clock = Elapsed.create(poll * 2);
    const sequence = [];
    for (let now = 0; now <= 30000; now += 100) {
      if (now % poll === 0) {
        Elapsed.receive(clock, { elapsed_ms: now + 370, elapsed_sec: Math.floor((now + 370) / 1000), started_at: 1 }, true, now + (now % 3) * 10);
      }
      const value = Elapsed.seconds(clock, now);
      if (sequence.at(-1) !== value) sequence.push(value);
    }
    assert.deepEqual(sequence, Array.from({ length: 31 }, (_, i) => i));
  }
});

test('correction cannot move the value backwards; a new session can start at zero', () => {
  const clock = Elapsed.create(4000);
  Elapsed.receive(clock, { elapsed_ms: 12300, started_at: 1 }, true, 0);
  assert.equal(Elapsed.seconds(clock, 800), 13);
  Elapsed.receive(clock, { elapsed_ms: 12950, started_at: 1 }, true, 800);
  assert.equal(Elapsed.seconds(clock, 800), 13);
  assert.equal(Elapsed.seconds(clock, 1900), 14);
  Elapsed.receive(clock, { elapsed_ms: 10, started_at: 2 }, true, 2000);
  assert.equal(Elapsed.seconds(clock, 2000), 0);
});

test('failure and expiry freeze the last displayed second; only a known stop clears it', () => {
  for (const lease of [4000, 6000]) {
    const clock = Elapsed.create(lease);
    Elapsed.receive(clock, {elapsed_ms: 1200,started_at: 1}, true, 0);
    const shown = Elapsed.seconds(clock, lease - 100);
    assert.equal(Elapsed.seconds(clock, lease + 1), shown);
    assert.equal(Elapsed.seconds(clock, lease + 10000), shown);
    Elapsed.receive(clock, {elapsed_ms: shown * 1000 - 100,started_at: 1}, true, 20000);
    assert.equal(Elapsed.seconds(clock, 20000), shown);
    assert.equal(Elapsed.seconds(clock, 21100), shown + 1);
    Elapsed.clear(clock);
    assert.equal(Elapsed.seconds(clock, 25000), shown + 1);
    Elapsed.receive(clock, {}, undefined, 25100);
    assert.equal(Elapsed.seconds(clock, 25200), shown + 1);
    Elapsed.receive(clock, {elapsed_ms: 0}, false, 26000);
    assert.equal(Elapsed.seconds(clock, 27000), null);
  }
});

for (const [kind,poll] of [['rec',2000],['lab',3000]]) for (const delay of [2500,5000]) {
  test(`${kind}: ${delay}ms responses keep advancing with ${poll}ms polling`, () => {
    const f = appFixture();
    const pending = [];
    const sequence = [];
    for (let now = 0; now <= 30000; now += 100) {
      f.at(now);
      if (now % poll === 0) pending.push({due: now + delay,ticket: f.request(kind)});
      for (const item of pending.filter(item => item.due === now)) {
        f.receive(kind,item.ticket,{elapsed_ms: now + 370,started_at: 1});
      }
      f.run('drawElapsed()');
      const value = f.value(kind);
      if (now >= delay) {
        assert.notEqual(value,'—');
        if (sequence.at(-1) !== value) sequence.push(value);
      }
    }
    const numeric = sequence.map(s => s.split(':').reduce((a,n) => a * 60 + Number(n),0));
    assert(numeric.length >= 25);
    assert(numeric.slice(1).every((v,i) => v === numeric[i] + 1));
  });
}

test('applied results reject late responses, but newer pending requests do not starve an answer', () => {
  const f = appFixture();
  const first = f.request('rec');
  const second = f.request('rec');
  f.receive('rec',first,{elapsed_ms: 12200,started_at: 1});
  assert.equal(f.value('rec'),'00:00:12');
  f.receive('rec',second,{elapsed_ms: 14200,started_at: 1});
  f.receive('rec',first,{elapsed_ms: 18000,started_at: 1});
  assert.equal(f.value('rec'),'00:00:14');
  const third = f.request('rec');
  const fourth = f.request('rec');
  f.fail('rec',fourth);
  f.at(1000);f.run('drawElapsed()');
  assert.equal(f.value('rec'),'00:00:14');
  f.receive('rec',third,{elapsed_ms: 16000,started_at: 1});
  assert.equal(f.value('rec'),'00:00:14');
});

test('hide freezes both labels and pre-hide responses cannot resume them', () => {
  const f = appFixture();
  f.receive('rec',f.request('rec'),{elapsed_ms: 12100,started_at: 1});
  f.receive('lab',f.request('lab'),{elapsed_ms: 22200,started_at: 1});
  const pending = f.request('rec');
  f.document.hidden = true;f.run('elapsedVisibilityChanged()');
  f.at(8000);f.run('drawElapsed()');
  assert.equal(f.value('rec'),'00:00:12');
  assert.equal(f.value('lab'),'00:00:22');
  f.document.hidden = false;
  f.receive('rec',pending,{elapsed_ms: 20000,started_at: 1});
  assert.equal(f.value('rec'),'00:00:12');
  f.receive('rec',f.request('rec'),{elapsed_ms: 20100,started_at: 1});
  assert.equal(f.value('rec'),'00:00:20');
  f.fail('rec',f.request('rec'));
  f.at(15000);f.run('drawElapsed()');
  assert.equal(f.value('rec'),'00:00:20');
  f.receive('rec',f.request('rec'),{},false);
  assert.equal(f.value('rec'),'—');
});

test('asset versions exceed the integrated app and polling/blink rules remain unchanged', () => {
  const app=fs.readFileSync(path.join(__dirname,'../static/app.js'),'utf8');
  const index=fs.readFileSync(path.join(__dirname,'../static/index.html'),'utf8');
  assert(Number(index.match(/elapsed-view\.js\?v=(\d+)/)[1])>1);
  assert(Number(index.match(/app\.js\?v=(\d+)/)[1])>28);
  assert.match(app,/setInterval\(refreshRecStatus, 2000\)/);
  assert.match(app,/setInterval\(refreshLabStatus, 3000\)/);
});
