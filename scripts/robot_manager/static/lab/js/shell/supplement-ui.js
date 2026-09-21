// Explicitly marked reference material opens in one native, accessible dialog.
// Experiment controls, legends, short hints and results remain inline details.
function initSupplements() {
  const dialog = document.getElementById('supplementDialog');
  if (!dialog || typeof MutationObserver === 'undefined') return;
  const body = document.getElementById('supplementBody'),
    title = document.getElementById('supplementTitle'),
    label = document.getElementById('supplementLabel');
  const close = document.getElementById('supplementClose'),
    back = document.getElementById('supplementBack');
  const enhanced = new WeakMap();
  let active = null,
    backdropStart = false;
  function dismiss(restoreFocus = true) {
    if (!active) return;
    const previous = active;
    active = null;
    if (dialog.open) dialog.close();
    // Move the original nodes back, preserving listeners, canvases and current data.
    previous.source.append(...body.childNodes);
    document.body.classList.remove('supplement-is-open');
    document.dispatchEvent(new CustomEvent('supplement-close'));
    if (restoreFocus && previous.button.isConnected) previous.button.focus({ preventScroll: true });
  }
  function open(source, button, summary) {
    if (active) dismiss(false);
    document.dispatchEvent(new CustomEvent('supplement-open'));
    if (!source.isConnected) return;
    active = { source, button };
    title.textContent =
      summary.querySelector('.school-tip-topic')?.textContent || summary.textContent.trim();
    label.textContent = source.hasAttribute('data-school-tip')
      ? summary.querySelector('.school-tip-label')?.textContent || 'Tips · 学校の数学・物理'
      : '補足の解説';
    body.replaceChildren(...[...source.childNodes].filter((node) => node !== summary));
    dialog.classList.toggle('supplement-school', source.hasAttribute('data-school-tip'));
    document.body.classList.add('supplement-is-open');
    dialog.showModal();
    body.scrollTop = 0;
    title.focus({ preventScroll: true });
  }
  function enhance(root) {
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    const candidates = [
      ...(root.matches?.('details[data-help-dialog]') ? [root] : []),
      ...root.querySelectorAll('details[data-help-dialog]'),
    ];
    for (const source of candidates) {
      if (enhanced.has(source) || !source.isConnected) continue;
      const summary = source.querySelector(':scope > summary');
      if (!summary) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className =
        'supplement-trigger' +
        (source.hasAttribute('data-school-tip') ? ' supplement-tip-trigger' : '');
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-controls', 'supplementDialog');
      button.innerHTML =
        '<span class="supplement-trigger-copy">' +
        summary.innerHTML +
        '</span><span class="supplement-trigger-action" aria-hidden="true">解説を開く<svg viewBox="0 0 20 20" width="18" height="18" fill="none"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 8h14M13 6h1"/></svg></span>';
      button.onclick = () => open(source, button, summary);
      source.before(button);
      source.hidden = true;
      source.open = false;
      enhanced.set(source, button);
    }
  }
  close.onclick = () => dismiss();
  back.onclick = () => dismiss();
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
    if (event.key !== 'Tab') return;
    const targets = [
      ...dialog.querySelectorAll(
        'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
      ),
    ].filter((node) => node.getClientRects().length);
    const first = targets[0],
      last = targets.at(-1),
      current = document.activeElement;
    if (event.shiftKey && (current === first || !targets.includes(current))) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  dialog.addEventListener('keyup', (event) => event.stopPropagation());
  const outside = (event) => {
    const r = dialog.getBoundingClientRect();
    return (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    );
  };
  dialog.addEventListener('pointerdown', (event) => {
    backdropStart = event.target === dialog && outside(event);
  });
  dialog.addEventListener('click', (event) => {
    if (backdropStart && event.target === dialog && outside(event)) dismiss();
    backdropStart = false;
  });
  body.addEventListener('click', (event) => {
    if (event.target.closest('a[href^="#"]')) dismiss(false);
  });
  for (const event of ['series-leave', 'open-lab', 'rl-foundations'])
    document.addEventListener(event, () => dismiss(false));
  enhance(document);
  new MutationObserver((records) => {
    if (active && !active.source.isConnected) dismiss(false);
    for (const record of records) for (const node of record.addedNodes) enhance(node);
  }).observe(document.body, { childList: true, subtree: true });
}

export { initSupplements };
