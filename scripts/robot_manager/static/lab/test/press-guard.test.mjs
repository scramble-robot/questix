import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function fixture() {
  const events = {},
    timers = new Map();
  let now = 0,
    timerId = 0,
    pendingMutations = [];
  let mutation;
  const context = {
    document: {
      body: {},
      addEventListener: (type, fn) => {
        events[type] = fn;
      },
    },
    MutationObserver: class {
      constructor(fn) {
        mutation = fn;
      }
      observe() {}
      takeRecords() {
        return pendingMutations.splice(0);
      }
    },
    performance: { now: () => now },
    setTimeout: (fn, delay) => {
      timers.set(++timerId, { fn, at: now + delay });
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const source = fs.readFileSync(new URL('../js/live/press-guard.js', import.meta.url), 'utf8');
  vm.runInNewContext(
    source.replace('export { freshInteraction };', 'globalThis.act = freshInteraction;'),
    context,
  );
  const button = {
    disabled: false,
    closest() {
      return this;
    },
  };
  let calls = 0;
  return {
    button,
    events,
    act(detail = 1, type = 'click', target = button) {
      context.act({ currentTarget: target, detail, type, preventDefault() {} }, () => calls++);
    },
    press(type = 'pointerdown', extra = {}) {
      events[type]({ type, target: button, ...extra });
    },
    disable() {
      button.disabled = true;
      mutation([{ target: button }]);
    },
    queueDisabledChange() {
      pendingMutations.push({ target: button });
    },
    advance(ms, runTimers = true) {
      const end = now + ms;
      while (runTimers) {
        const next = [...timers]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    finish() {
      this.advance(1000);
    },
    calls: () => calls,
  };
}
test('an invalid pointer press cannot become a click when the button becomes enabled', () => {
  const f = fixture();
  f.button.disabled = true;
  f.press();
  f.button.disabled = false;
  f.press('pointerup');
  f.act();
  assert.equal(f.calls(), 0);
  f.finish();
  f.press();
  f.press('pointerup');
  f.act();
  assert.equal(f.calls(), 1);
});
test('disabling and re-enabling during a valid held press invalidates it', () => {
  const f = fixture();
  f.press();
  f.disable();
  f.button.disabled = false;
  f.act();
  assert.equal(f.calls(), 0);
});
test('keyboard repeats do not start again; an explicit assistive click still works', () => {
  const f = fixture();
  f.press('keydown', { repeat: true });
  f.act(0);
  assert.equal(f.calls(), 0);
  f.press('keyup');
  f.finish();
  f.act(0);
  assert.equal(f.calls(), 1);
});
test('a command input changing after a disabled press cannot send even when detail is zero', () => {
  const f = fixture();
  f.button.disabled = true;
  f.press();
  f.button.disabled = false;
  f.act(0);
  assert.equal(f.calls(), 0);
});

test('an unrelated key release cannot make a held disabled command input valid', () => {
  const f = fixture();
  f.button.disabled = true;
  f.press();
  f.button.disabled = false;
  f.press('keyup', { key: 'Shift' });
  f.finish();
  f.act(0);
  assert.equal(f.calls(), 0);
});

for (const pointerType of ['touch', 'pen', 'mouse']) {
  for (const delay of [50, 300, 700]) {
    test(`${pointerType}: a click in a later task after ${delay} ms is accepted once`, () => {
      const f = fixture();
      f.press('pointerdown', { pointerType, pointerId: 8 });
      f.press('pointerup', { pointerType, pointerId: 8 });
      f.advance(delay);
      f.act();
      f.act();
      assert.equal(f.calls(), 1);
    });
  }
  for (const delay of [1000, 1100]) {
    test(`${pointerType}: a click at or beyond the release deadline (${delay} ms) is refused`, () => {
      const f = fixture();
      f.press('pointerdown', { pointerType });
      f.press('pointerup', { pointerType });
      f.advance(delay);
      f.act();
      assert.equal(f.calls(), 0);
    });
  }
  test(`${pointerType}: pointer cancellation refuses a delayed click`, () => {
    const f = fixture();
    f.press('pointerdown', { pointerType });
    f.press('pointercancel', { pointerType });
    f.advance(300);
    f.act();
    assert.equal(f.calls(), 0);
  });
  test(`${pointerType}: enabling a held disabled button does not authorize a delayed click`, () => {
    const f = fixture();
    f.button.disabled = true;
    f.press('pointerdown', { pointerType });
    f.button.disabled = false;
    f.press('pointerup', { pointerType });
    f.advance(700);
    f.act();
    assert.equal(f.calls(), 0);
  });
  test(`${pointerType}: disabling during a hold invalidates its delayed click`, () => {
    const f = fixture();
    f.press('pointerdown', { pointerType });
    f.disable();
    f.button.disabled = false;
    f.press('pointerup', { pointerType });
    f.advance(50);
    f.act();
    assert.equal(f.calls(), 0);
  });
}

test('the deadline is checked even when a busy event loop has not run the expiry timer', () => {
  const f = fixture();
  f.press();
  f.press('pointerup');
  f.advance(1001, false);
  f.act();
  assert.equal(f.calls(), 0);
});
test('the grace period starts on release, including after a long hold', () => {
  const f = fixture();
  f.press();
  f.advance(2000);
  f.press('pointerup');
  f.advance(700);
  f.act();
  assert.equal(f.calls(), 1);
});
test('an unrelated keyup does not erase a released pointer awaiting its delayed click', () => {
  const f = fixture();
  f.press();
  f.press('pointerup');
  f.press('keyup', { code: 'Shift' });
  f.advance(700);
  f.act();
  assert.equal(f.calls(), 1);
});
test('a subsequent pointer press anywhere discards the preceding target provenance', () => {
  const f = fixture();
  f.press();
  f.press('pointerup');
  f.advance(100);
  f.press('pointerdown', { target: { closest: () => null } });
  f.act();
  assert.equal(f.calls(), 0);
});
test('an earlier release timer cannot erase a newer press on the same target', () => {
  const f = fixture();
  f.press();
  f.press('pointerup');
  f.advance(700);
  f.press();
  f.press('pointerup');
  f.advance(700);
  f.act();
  assert.equal(f.calls(), 1);
});
test('a different target cannot borrow a released pointer press', () => {
  const f = fixture();
  f.press();
  f.press('pointerup');
  f.advance(300);
  f.act(1, 'click', { disabled: false });
  assert.equal(f.calls(), 0);
});
test('an unrecorded touch-like click is always refused', () => {
  const f = fixture();
  f.act();
  f.act(2);
  assert.equal(f.calls(), 0);
});
test('synchronous disabled mutations are drained before deciding on a click', () => {
  const f = fixture();
  f.press();
  f.press('pointerup');
  f.queueDisabledChange();
  f.act();
  assert.equal(f.calls(), 0);
});
test('range preview inputs do not consume provenance before a delayed change', () => {
  const f = fixture();
  f.press();
  f.act(0, 'input');
  f.act(0, 'input');
  f.press('pointerup');
  f.advance(300);
  f.act(0, 'change');
  assert.equal(f.calls(), 3);
});
test('a disabled change also invalidates a released pointer before a delayed change', () => {
  const f = fixture();
  f.press();
  f.press('pointerup');
  f.disable();
  f.button.disabled = false;
  f.advance(300);
  f.act(0, 'change');
  assert.equal(f.calls(), 0);
});
for (const key of ['Enter', 'Space']) {
  test(`${key} keeps the ordinary keyboard click policy`, () => {
    const f = fixture();
    f.press('keydown', { code: key });
    f.act(0);
    f.press('keyup', { code: key });
    f.finish();
    f.act(0);
    assert.equal(f.calls(), 2);
  });
}
