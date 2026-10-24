const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Elapsed = require('../static/elapsed-view.js');

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

test('stopped, failed, hidden/suspended and overdue clocks do not keep advancing', () => {
  const clock = Elapsed.create(4000);
  const sample = { elapsed_ms: 1200, elapsed_sec: 1, started_at: 1 };
  Elapsed.receive(clock, sample, true, 0);
  assert.equal(Elapsed.seconds(clock, 1000), 2);
  Elapsed.clear(clock);
  assert.equal(Elapsed.seconds(clock, 5000), null);
  Elapsed.receive(clock, sample, false, 6000);
  assert.equal(Elapsed.seconds(clock, 7000), null);
  Elapsed.receive(clock, sample, true, 8000);
  assert.equal(Elapsed.seconds(clock, 12001), null);
  Elapsed.receive(clock, { elapsed_sec: 2 }, true, 13000);
  assert.equal(Elapsed.seconds(clock, 13000), 2);
});

test('the app rejects pre-hide and out-of-order responses, and clears both labels on hide', () => {
  let now = 0;
  const els = new Map();
  const document = { hidden: false, readyState: 'loading', addEventListener() {}, getElementById(id) {
    if (!els.has(id)) els.set(id, {textContent: '', value: '', hidden: false, addEventListener() {}, removeAttribute() {}, setAttribute() {}, replaceChildren() {}}); return els.get(id);
  } };
  const context = vm.createContext({ document, performance: { now: () => now }, URL,
    location: { href: 'http://127.0.0.1:8888/' }, AbortController, AbortSignal });
  // Use the page's real dependency order, including modules introduced by independent PRs.
  const index = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
  for (const match of index.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)) {
    const src = match[1].split(/[?#]/)[0];
    if (!src.startsWith('/static/')) continue;
    const file = src.slice('/static/'.length);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static', file), 'utf8'), context, {filename: file});
    if (file === 'app.js') break;
  }
  vm.runInContext(`const first=elapsedTicket('rec');receiveElapsed('rec',{elapsed_ms:100,started_at:1},true,first);`, context);
  assert.equal(els.get('rec-elapsed').textContent, '00:00:00');
  now=1100;vm.runInContext('drawElapsed()',context);
  assert.equal(els.get('rec-elapsed').textContent, '00:00:01');
  vm.runInContext(`const old=elapsedTicket('rec');const latest=elapsedTicket('rec');failElapsed('rec',latest);receiveElapsed('rec',{elapsed_ms:1000},true,old);`, context);
  assert.equal(els.get('rec-elapsed').textContent, '—');
  vm.runInContext(`const beforeHide=elapsedTicket('lab');receiveElapsed('lab',{elapsed_ms:2200},true,beforeHide);`,context);
  document.hidden=true;vm.runInContext('elapsedVisibilityChanged()',context);
  assert.equal(els.get('lab-elapsed').textContent,'—');
  document.hidden=false;
  vm.runInContext(`receiveElapsed('lab',{elapsed_ms:3200},true,beforeHide);drawElapsed();`,context);
  assert.equal(els.get('lab-elapsed').textContent,'—');
});

test('asset version exceeds the integrated app and polling/blink rules remain unchanged', () => {
  const app=fs.readFileSync(path.join(__dirname,'../static/app.js'),'utf8');
  const index=fs.readFileSync(path.join(__dirname,'../static/index.html'),'utf8');
  assert.match(index,/elapsed-view\.js\?v=1/);
  assert(Number(index.match(/app\.js\?v=(\d+)/)[1])>27);
  assert.match(app,/setInterval\(refreshRecStatus, 2000\)/);
  assert.match(app,/setInterval\(refreshLabStatus, 3000\)/);
});
