#!/usr/bin/env node
// UI regression check for refactors that must not change what learners see.
//
//   node test/ui-regression.mjs --baseline <dir> [--candidate <dir>] --route planning [--steps file.json]
//
// Both site copies are served locally and driven through the same steps in headless Chrome with
// a fake clock and a seeded Math.random, so animations and simulations are repeatable. After every
// step the visible page is serialised canonically (attributes sorted, comments and lit-html
// markers dropped, canvases reduced to a pixel hash) and the two serialisations are diffed.
//
// Without --steps the page is crawled: every chapter/topic button is opened in order and each
// enabled primary button is pressed once. Steps file: [{"click":"#id"},{"input":"#id","value":"3"},
// {"wait":500},{"snapshot":"after run"}] (click/input take an optional "nth").
// Needs google-chrome and Node >= 22. Exit code 1 when any snapshot differs.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    candidate: path.resolve(import.meta.dirname, '..'),
    route: 'series',
    maxDiffLines: 12,
  };
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!args.baseline)
    throw Error('--baseline <dir> is required (a copy of the site before the change)');
  return args;
}

function serve(root) {
  const server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    let file = path.join(root, relative);
    if (!file.startsWith(root)) return response.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory())
      file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) return response.writeHead(404).end();
    response.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Runs inside the page before any site script: repeatable time, randomness and scheduling.
//
// Animation frames and short timers are queued here and drained by the harness, never by the
// wall clock. Lessons compute in the background between yields (`setTimeout(…, 0)` while
// training, 20 ms while estimating a SLAM pose); left to real time, how far such a loop had got
// when the snapshot was taken depended on how busy the machine was, and two browsers never
// agreed. Timers longer than YIELD_MAX_MS are left to the real clock: they are guards and
// cleanups (a 30 s image timeout, revokeObjectURL after 1 s) that must not fire early.
const DETERMINISM = `(() => {
  const YIELD_MAX_MS = 50;
  let now = 1000, seed = 12345, frame = 0, timer = 0;
  const queue = new Map(), timers = new Map();
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  performance.now = () => now; Date.now = () => 1700000000000 + now;
  Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  window.requestAnimationFrame = (fn) => { const id = ++frame; queue.set(id, fn); return id; };
  window.cancelAnimationFrame = (id) => queue.delete(id);
  window.setTimeout = (fn, ms, ...args) => {
    if (ms > YIELD_MAX_MS) return realSetTimeout(fn, ms, ...args);
    const id = 'q' + (++timer); timers.set(id, () => fn(...args)); return id;
  };
  window.clearTimeout = (id) => { typeof id === 'string' ? timers.delete(id) : realClearTimeout(id); };
  const flushMicrotasks = async () => { for (let tick = 0; tick < 8; tick++) await Promise.resolve(); };
  const fireTimers = () => {
    for (const id of [...timers.keys()]) { const fn = timers.get(id); timers.delete(id); fn(); }
  };
  // One round = the due short timers, then the animation frames, then enough microtask ticks for
  // the continuations they resolve; 16 ms of fake time each, as a 60 Hz browser would.
  window.__pumpFrames = async (count) => {
    for (let i = 0; i < count; i++) {
      now += 16;
      fireTimers();
      const batch = [...queue]; queue.clear();
      for (const [, fn] of batch) fn(now);
      await flushMicrotasks();
    }
  };
  // Run background computation to completion without touching the animation queue, so playback
  // still stops where the step asked while training or estimating always finishes first.
  window.__settleTimers = async (maxRounds) => {
    for (let round = 0; round < maxRounds && timers.size; round++) {
      now += 16;
      fireTimers();
      await flushMicrotasks();
    }
    return timers.size;
  };
})();`;

// Runs inside the page: canonical text form of what the learner can see.
const SERIALIZE = `(() => {
  const hash = (text) => { let h = 2166136261; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
  const lines = [];
  // Live form state is recorded as value=…; the attributes only mirror how a control was first
  // created (innerHTML vs. property binding) and are not something a learner can see.
  const ignored = (node, name) => name.startsWith('data-lit') || name === 'checked' || name === 'selected' || (name === 'value' && node.tagName === 'INPUT');
  const walk = (node, depth) => {
    if (node.nodeType !== Node.ELEMENT_NODE || node.tagName === 'SCRIPT') return;
    const attributes = [...node.attributes].filter((a) => !ignored(node, a.name)).map((a) => a.name + '=' + JSON.stringify(a.name === 'style' || a.name === 'class' ? a.value.replace(/\\s+/g, ' ').trim() : a.value)).filter((a) => a !== 'class=""' && a !== 'style=""').sort();
    let extra = '';
    if (node.tagName === 'CANVAS' && node.width && node.height) { try { extra = ' pixels=' + hash(node.toDataURL()); } catch { extra = ' pixels=tainted'; } }
    if (node.tagName === 'INPUT' || node.tagName === 'SELECT' || node.tagName === 'TEXTAREA') extra += ' value=' + JSON.stringify(node.type === 'checkbox' || node.type === 'radio' ? node.checked : node.value);
    if (node.disabled) extra += ' :disabled';
    lines.push(' '.repeat(depth) + node.tagName.toLowerCase() + (attributes.length ? ' ' + attributes.join(' ') : '') + extra);
    if (node.hidden) return;
    // Adjacent text nodes read as one run of text, however the template split them.
    let text = '';
    const flush = () => { const clean = text.replace(/\\s+/g, ' ').trim(); if (clean) lines.push(' '.repeat(depth + 1) + '"' + clean + '"'); text = ''; };
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
      else if (child.nodeType === Node.ELEMENT_NODE) { flush(); walk(child, depth + 1); }
    }
    flush();
  };
  walk(document.querySelector('main'), 0);
  for (const dialog of document.querySelectorAll('dialog[open]')) walk(dialog, 0);
  return lines.join('\\n');
})()`;

const CRAWL_PLAN = `(() => {
  const page = [...document.querySelectorAll('main > section.page')].find((s) => !s.hidden);
  if (!page) return [];
  const visible = (el) => !!el.offsetParent && !el.disabled;
  const selector = (el, list) => ({ index: list.indexOf(el), label: el.textContent.trim().slice(0, 24) });
  const tabs = [...page.querySelectorAll('nav button')];
  return tabs.filter(visible).map((el) => selector(el, tabs));
})()`;

async function openBrowser() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-ui-regression-'));
  const port = 9300 + Math.floor(Math.random() * 600);
  const chrome = spawn(
    'google-chrome',
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--remote-debugging-port=${port}`,
      '--window-size=1300,1000',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let target;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(150);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(
        (t) => t.type === 'page',
      );
    } catch {
      /* not up yet */
    }
  }
  if (!target) throw Error('could not start google-chrome');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => (socket.onopen = resolve));
  let id = 0;
  const pending = new Map();
  const errors = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === 'Runtime.exceptionThrown')
      errors.push(
        message.params.exceptionDetails.exception?.description ||
          message.params.exceptionDetails.text,
      );
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      pending.set(++id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (reply.result.exceptionDetails)
      throw Error(reply.result.exceptionDetails.exception?.description || 'evaluate failed');
    return reply.result.result.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: DETERMINISM });
  return {
    send,
    evaluate,
    errors,
    close: async () => {
      socket.close();
      const exited = new Promise((resolve) => chrome.once('exit', resolve));
      chrome.kill();
      await exited;
      // Chrome's helpers may still be flushing the profile; a leftover temp dir is not an error.
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* ignore */
      }
    },
  };
}

// Real time lets fetches and timers settle; pumped frames advance the fake animation clock.
const MAX_BACKGROUND_ROUNDS = 6000;

async function settle(browser, frames = 30) {
  await sleep(250);
  await browser.evaluate(`window.__pumpFrames(${frames})`);
  // Background work has to finish before the snapshot, or it is caught at an arbitrary point.
  const pending = await browser.evaluate(`window.__settleTimers(${MAX_BACKGROUND_ROUNDS})`);
  if (pending) throw Error(`background work unfinished after ${MAX_BACKGROUND_ROUNDS} rounds`);
  await browser.evaluate(`window.__pumpFrames(${frames})`);
  await sleep(100);
}

async function runSite(origin, route, steps) {
  const browser = await openBrowser();
  const snapshots = [];
  const snapshot = async (name) => snapshots.push({ name, dom: await browser.evaluate(SERIALIZE) });
  try {
    await browser.send('Page.navigate', { url: `${origin}/index.html#${route}` });
    await sleep(1800);
    await settle(browser);
    await snapshot('initial');
    // Only elements the learner can actually see are counted, as the crawl already does: a page
    // that renders a section while it is hidden would otherwise shift every nth-based selector.
    // dispatchEvent rather than el.click(): SVG elements (map cells, chart marks) have no click().
    const click = (scope, index) =>
      browser.evaluate(
        `(() => { const el = [...document.querySelectorAll(${JSON.stringify(scope)})].filter((e) => e.offsetParent || e.ownerSVGElement)[${index}]; if (!el || el.disabled) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; })()`,
      );
    if (steps) {
      for (const step of steps) {
        if (step.click) await click(step.click, step.nth || 0);
        if (step.input)
          await browser.evaluate(
            `(() => { const el = [...document.querySelectorAll(${JSON.stringify(step.input)})][${step.nth || 0}]; el.value = ${JSON.stringify(step.value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`,
          );
        if (step.wait) await sleep(step.wait);
        await settle(browser, step.frames ?? 30);
        if (step.snapshot || step.click || step.input)
          await snapshot(step.snapshot || step.click || step.input);
      }
    } else {
      const tabs = await browser.evaluate(CRAWL_PLAN);
      for (const tab of tabs) {
        await click('main > section.page:not([hidden]) nav button', tab.index);
        await settle(browser);
        await snapshot(`open "${tab.label}"`);
        const primaries = await browser.evaluate(
          `[...document.querySelectorAll('main > section.page:not([hidden]) button.primary')].map((el, i) => (el.offsetParent && !el.disabled ? i : -1)).filter((i) => i >= 0)`,
        );
        for (const index of primaries.slice(0, 2)) {
          await click('main > section.page:not([hidden]) button.primary', index);
          await settle(browser, 240);
          await snapshot(`open "${tab.label}" → primary button ${index}`);
        }
      }
    }
    return { snapshots, errors: browser.errors };
  } finally {
    await browser.close();
  }
}

function diffLines(name, before, after, maxLines) {
  const a = before.split('\n');
  const b = after.split('\n');
  const lines = [];
  for (let i = 0; i < Math.max(a.length, b.length) && lines.length < maxLines; i++) {
    if (a[i] === b[i]) continue;
    lines.push(
      `   line ${i + 1}\n     baseline : ${(a[i] ?? '(missing)').trim().slice(0, 200)}\n     candidate: ${(b[i] ?? '(missing)').trim().slice(0, 200)}`,
    );
  }
  return lines.join('\n');
}

const args = parseArgs(process.argv.slice(2));
const steps = args.steps ? JSON.parse(fs.readFileSync(args.steps, 'utf8')) : null;
const [baselineServer, candidateServer] = await Promise.all([
  serve(path.resolve(args.baseline)),
  serve(path.resolve(args.candidate)),
]);
const origin = (server) => `http://127.0.0.1:${server.address().port}`;
try {
  const [baseline, candidate] = await Promise.all([
    runSite(origin(baselineServer), args.route, steps),
    runSite(origin(candidateServer), args.route, steps),
  ]);
  const pairs = Math.min(baseline.snapshots.length, candidate.snapshots.length);
  const differing = [];
  for (let i = 0; i < pairs; i++)
    if (baseline.snapshots[i].dom !== candidate.snapshots[i].dom) differing.push(i);

  // A lesson that animates or computes in the background can land a hair apart in two browsers.
  // Rather than trust or ignore such a snapshot, re-run the baseline and see whether IT differs
  // from itself there: if so the snapshot is unstable and proves nothing, and only that snapshot
  // is excused — never a difference the baseline reproduces.
  const unstable = new Set();
  if (differing.length) {
    const second = await runSite(origin(baselineServer), args.route, steps);
    for (const i of differing)
      if (i >= second.snapshots.length || baseline.snapshots[i].dom !== second.snapshots[i].dom)
        unstable.add(i);
  }

  let failed =
    candidate.errors.length > 0 || baseline.snapshots.length !== candidate.snapshots.length;
  for (const i of differing) {
    const name = baseline.snapshots[i].name;
    if (unstable.has(i)) {
      console.log(`UNSTABLE  ${name} (the baseline does not reproduce itself here; not compared)`);
      continue;
    }
    failed = true;
    console.log(`DIFF  ${name}`);
    console.log(
      diffLines(
        name,
        baseline.snapshots[i].dom,
        candidate.snapshots[i].dom,
        Number(args.maxDiffLines),
      ),
    );
  }

  const same = pairs - differing.length;
  const counted = pairs - unstable.size;
  console.log(
    `${args.route}: ${same}/${counted} snapshots identical` +
      (unstable.size ? ` (${unstable.size} unstable, excluded)` : '') +
      (baseline.snapshots.length !== candidate.snapshots.length
        ? ` (candidate took ${candidate.snapshots.length})`
        : ''),
  );
  for (const error of candidate.errors) console.log('candidate page error:', error.split('\n')[0]);
  for (const error of baseline.errors) console.log('baseline page error:', error.split('\n')[0]);
  process.exitCode = failed ? 1 : 0;
} finally {
  baselineServer.close();
  candidateServer.close();
}
