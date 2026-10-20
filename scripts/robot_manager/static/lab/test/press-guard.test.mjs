import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function fixture() {
  const events = {},
    timers = [];
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
    },
    setTimeout: (fn) => timers.push(fn),
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
    act(detail = 1) {
      context.act({ currentTarget: button, detail, preventDefault() {} }, () => calls++);
    },
    press(type = 'pointerdown', extra = {}) {
      events[type]({ type, target: button, ...extra });
    },
    disable() {
      button.disabled = true;
      mutation([{ target: button }]);
    },
    finish() {
      for (const fn of timers.splice(0)) fn();
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
