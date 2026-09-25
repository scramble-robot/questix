import { loadJson } from '../core/content.js';

// Explicitly marked reference material — `details[data-help-dialog]` — opens in the one shared,
// native dialog of index.html instead of unfolding in place. The details itself is hidden and a
// trigger button takes its place; while the dialog is open the details' own child nodes are MOVED
// into it and moved back on close. They are moved, never copied, so listeners, canvases and the
// current data survive and the courses can keep rendering into them.
// Experiment controls, legends, short hints and results stay inline details.

const copy = await loadJson('content/shell/supplement.json');

const HELP_DIALOG_SELECTOR = 'details[data-help-dialog]';
const SCHOOL_TIP_ATTRIBUTE = 'data-school-tip';
const HELP_ACTION_ATTRIBUTE = 'data-help-action';

// Decorative "this opens in a window" glyph of the trigger button.
const OPEN_ICON_SVG =
  '<svg viewBox="0 0 20 20" width="18" height="18" fill="none"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 8h14M13 6h1"/></svg>';

// A nested <details> (e.g. the reading list's 資料を選んだ基準) is reached through its summary.
const FOCUSABLE_SELECTOR =
  'button:not(:disabled),a[href],summary,input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]';

// Leaving a course, opening the measurement lab or the RL foundations closes the dialog.
const DISMISS_EVENTS = ['series-leave', 'open-lab', 'rl-foundations'];

const ELEMENT_NODE = 1;
const DOCUMENT_NODE = 9;

const isSchoolTip = (source) => source.hasAttribute(SCHOOL_TIP_ATTRIBUTE);

// The trigger repeats the summary, so whatever the summary shows (labels, lesson cue icons) is
// what the learner sees on the button.
function triggerCaption(summary) {
  const caption = document.createElement('span');
  caption.className = 'supplement-trigger-copy';
  caption.append(...[...summary.childNodes].map((node) => node.cloneNode(true)));
  return caption;
}

// The action word of the button: 開く, or what the details names in data-help-action (資料を見る).
function triggerAction(source) {
  const action = document.createElement('span');
  action.className = 'supplement-trigger-action';
  action.setAttribute('aria-hidden', 'true');
  action.append(source.getAttribute(HELP_ACTION_ATTRIBUTE) || copy.openAction);
  action.insertAdjacentHTML('beforeend', OPEN_ICON_SVG);
  return action;
}

function createTrigger(source, summary) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = isSchoolTip(source)
    ? 'supplement-trigger supplement-tip-trigger'
    : 'supplement-trigger';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-controls', 'supplementDialog');
  button.append(triggerCaption(summary), triggerAction(source));
  return button;
}

// The mutated node itself may be the details, so it is checked as well as its descendants.
function helpDialogsIn(root) {
  const self = root.matches?.(HELP_DIALOG_SELECTOR) ? [root] : [];
  return [...self, ...root.querySelectorAll(HELP_DIALOG_SELECTOR)];
}

function dialogTitle(summary) {
  const topic = summary.querySelector('.school-tip-topic')?.textContent;
  return topic || summary.textContent.trim();
}

function dialogLabel(source, summary) {
  if (!isSchoolTip(source)) return copy.label.supplement;
  return summary.querySelector('.school-tip-label')?.textContent || copy.label.schoolTip;
}

function visibleFocusable(dialog) {
  const candidates = [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)];
  return candidates.filter((node) => node.getClientRects().length);
}

// A modal <dialog> covers the viewport for hit-testing, so a click on the backdrop is reported on
// the dialog element itself; only the pointer coordinates tell the two apart.
function isOnBackdrop(dialog, event) {
  if (event.target !== dialog) return false;
  const box = dialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right) return true;
  return event.clientY < box.top || event.clientY > box.bottom;
}

function initSupplements() {
  const dialog = document.getElementById('supplementDialog');
  if (!dialog || typeof MutationObserver === 'undefined') return;
  const body = document.getElementById('supplementBody');
  const title = document.getElementById('supplementTitle');
  const label = document.getElementById('supplementLabel');
  const closeButton = document.getElementById('supplementClose');
  const backButton = document.getElementById('supplementBack');

  const triggers = new WeakMap(); // details -> the button that replaced it
  let shown = null; // { source, button } while the dialog holds a details' children
  let pressStartedOnBackdrop = false;

  function dismiss(restoreFocus = true) {
    if (!shown) return;
    const previous = shown;
    shown = null;
    if (dialog.open) dialog.close();
    previous.source.append(...body.childNodes);
    document.body.classList.remove('supplement-is-open');
    document.dispatchEvent(new CustomEvent('supplement-close'));
    if (restoreFocus && previous.button.isConnected) previous.button.focus({ preventScroll: true });
  }

  function show(source, button, summary) {
    if (shown) dismiss(false);
    // Courses pause their animations on this event, before the nodes are taken out of the page.
    document.dispatchEvent(new CustomEvent('supplement-open'));
    if (!source.isConnected) return; // a listener may have re-rendered the page away
    shown = { source, button };
    title.textContent = dialogTitle(summary);
    label.textContent = dialogLabel(source, summary);
    body.replaceChildren(...[...source.childNodes].filter((node) => node !== summary));
    dialog.classList.toggle('supplement-school', isSchoolTip(source));
    document.body.classList.add('supplement-is-open');
    dialog.showModal();
    body.scrollTop = 0;
    title.focus({ preventScroll: true });
  }

  function enhance(root) {
    if (root.nodeType !== ELEMENT_NODE && root.nodeType !== DOCUMENT_NODE) return;
    for (const source of helpDialogsIn(root)) {
      if (triggers.has(source) || !source.isConnected) continue;
      const summary = source.querySelector(':scope > summary');
      if (!summary) continue;
      const button = createTrigger(source, summary);
      button.addEventListener('click', () => show(source, button, summary));
      source.before(button);
      source.hidden = true;
      source.open = false;
      triggers.set(source, button);
    }
  }

  // Focus stays inside the dialog: Tab past the last control wraps to the first and back.
  function keepFocusInDialog(event) {
    const targets = visibleFocusable(dialog);
    const first = targets[0];
    const last = targets.at(-1);
    const current = document.activeElement;
    const leavingStart = event.shiftKey && (current === first || !targets.includes(current));
    const leavingEnd = !event.shiftKey && current === last;
    if (!leavingStart && !leavingEnd) return;
    event.preventDefault();
    const wrapTo = leavingStart ? last : first;
    wrapTo?.focus();
  }

  closeButton.addEventListener('click', () => dismiss());
  backButton.addEventListener('click', () => dismiss());

  // Escape and the platform's own close both go through dismiss, so the nodes always move back.
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dismiss();
  });
  dialog.addEventListener('close', () => {
    if (!dialog.open) dismiss();
  });

  dialog.addEventListener('keydown', (event) => {
    // Reading/navigation keys must not reach the robot's document-level drive keys.
    event.stopPropagation();
    if (event.key === 'Tab') keepFocusInDialog(event);
  });
  dialog.addEventListener('keyup', (event) => event.stopPropagation());

  // Closing on the backdrop needs press and release on it, so a drag out of the dialog is not one.
  dialog.addEventListener('pointerdown', (event) => {
    pressStartedOnBackdrop = isOnBackdrop(dialog, event);
  });
  dialog.addEventListener('click', (event) => {
    if (pressStartedOnBackdrop && isOnBackdrop(dialog, event)) dismiss();
    pressStartedOnBackdrop = false;
  });

  // An in-page link inside the dialog navigates the page behind it, so focus stays on the target.
  body.addEventListener('click', (event) => {
    if (event.target.closest('a[href^="#"]')) dismiss(false);
  });
  for (const name of DISMISS_EVENTS) document.addEventListener(name, () => dismiss(false));

  enhance(document);
  const observer = new MutationObserver((records) => {
    // A course may re-render its page while the details' children are in the dialog.
    if (shown && !shown.source.isConnected) dismiss(false);
    for (const record of records) for (const node of record.addedNodes) enhance(node);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

export { initSupplements };
