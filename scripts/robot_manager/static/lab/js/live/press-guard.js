// UI press provenance only. Sender readiness and all ROS/bridge decisions remain authoritative.
const presses = new Map();
let physicalPending = false;
const heldInputs = new Set();
// A compatibility click may arrive in a later task. Keep its provenance for at most 1 s
// after release (including the historical ~350 ms touch delay), never until another press.
const RELEASE_GRACE_MS = 1000;
const targetOf = (event) =>
  event.target.closest?.('[data-live-start-action], [data-live-command-input]');
function forget(target, press) {
  if (!press || presses.get(target) !== press) return;
  clearTimeout(press.timer);
  presses.delete(target);
}
function begin(event) {
  const target = targetOf(event);
  if (target) {
    forget(target, presses.get(target));
    presses.set(target, {
      valid: !target.disabled && !event.repeat,
      input: event.type === 'pointerdown' ? `pointer:${event.pointerId ?? 0}` : 'key',
      expires: null,
      timer: null,
    });
  }
}
document.addEventListener(
  'pointerdown',
  (event) => {
    for (const [target, press] of presses) forget(target, press);
    heldInputs.add(`pointer:${event.pointerId ?? 0}`);
    physicalPending = true;
    begin(event);
  },
  true,
);
document.addEventListener(
  'keydown',
  (event) => {
    heldInputs.add(`key:${event.code ?? event.key ?? ''}`);
    physicalPending = true;
    begin(event);
  },
  true,
);
function end(event) {
  const id =
    event.type === 'keyup'
      ? `key:${event.code ?? event.key ?? ''}`
      : `pointer:${event.pointerId ?? 0}`;
  heldInputs.delete(id);
  if (event.type !== 'keyup') {
    for (const [target, press] of presses) {
      if (press.input !== id) continue;
      if (event.type === 'pointercancel') forget(target, press);
      else {
        press.expires = performance.now() + RELEASE_GRACE_MS;
        press.timer = setTimeout(() => forget(target, press), RELEASE_GRACE_MS);
      }
    }
  }
  // Keep the keyboard/assistive-click policy. Unrelated key releases do not erase a pointer.
  setTimeout(() => {
    if (heldInputs.size) return;
    for (const [target, press] of presses) if (press.input === 'key') forget(target, press);
    physicalPending = false;
  }, 0);
}
for (const type of ['pointerup', 'pointercancel', 'keyup'])
  document.addEventListener(type, end, true);
function invalidateDisabled(records) {
  for (const { target } of records) {
    const press = presses.get(target);
    if (press) press.valid = false;
  }
}
const disabledObserver = new MutationObserver(invalidateDisabled);
disabledObserver.observe(document.body, {
  subtree: true,
  attributes: true,
  attributeFilter: ['disabled'],
});
function freshInteraction(event, action) {
  // Also catch a disabled -> enabled change made synchronously just before this event.
  invalidateDisabled(disabledObserver.takeRecords());
  const target = event.currentTarget;
  const known = presses.get(target);
  const valid = known?.valid && (known.expires === null || performance.now() < known.expires);
  const explicit = valid || (known === undefined && !physicalPending && !event.detail);
  if (target.disabled || !explicit) {
    event.preventDefault();
    return;
  }
  // One click per pointer press; range input events may precede its final change event.
  if (known?.input.startsWith('pointer:') && event.type === 'click') forget(target, known);
  action();
}
export { freshInteraction };
