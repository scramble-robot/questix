// UI press provenance only. Sender readiness and all ROS/bridge decisions remain authoritative.
const presses = new Map();
let physicalPending = false;
const heldInputs = new Set();
const targetOf = (event) =>
  event.target.closest?.('[data-live-start-action], [data-live-command-input]');
function begin(event) {
  const target = targetOf(event);
  if (target) presses.set(target, !target.disabled && !event.repeat);
}
document.addEventListener(
  'pointerdown',
  (event) => {
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
  // click/change follows release in the same task. An unrelated keyup must not end a pointer press.
  setTimeout(() => {
    if (heldInputs.size) return;
    presses.clear();
    physicalPending = false;
  }, 0);
}
for (const type of ['pointerup', 'pointercancel', 'keyup'])
  document.addEventListener(type, end, true);
new MutationObserver((records) => {
  for (const { target } of records) if (presses.has(target)) presses.set(target, false);
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['disabled'] });
function freshInteraction(event, action) {
  const target = event.currentTarget;
  const known = presses.get(target);
  const explicit = known === true || (known === undefined && !physicalPending && !event.detail);
  if (target.disabled || !explicit) {
    event.preventDefault();
    return;
  }
  action();
}
export { freshInteraction };
