// UI press provenance only. Sender readiness and all ROS/bridge decisions remain authoritative.
const presses = new Map();
let pointerInProgress = false;
const targetOf = (event) =>
  event.target.closest?.('[data-live-start-action], [data-live-command-input]');
function begin(event) {
  const target = targetOf(event);
  if (target) presses.set(target, !target.disabled && !event.repeat);
}
document.addEventListener(
  'pointerdown',
  (event) => {
    pointerInProgress = true;
    begin(event);
  },
  true,
);
document.addEventListener('keydown', begin, true);
function end() {
  // click/change follows pointerup/keyup in the same task. Keep invalid presses through it.
  setTimeout(() => {
    presses.clear();
    pointerInProgress = false;
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
  const explicit = known === true || (known === undefined && !pointerInProgress && !event.detail);
  if (target.disabled || !explicit) {
    event.preventDefault();
    return;
  }
  action();
}
export { freshInteraction };
