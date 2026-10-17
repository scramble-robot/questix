// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// Esc stops this page's own drive run and launcher session (DESIGN.md S-2). The supplement dialog
// (js/shell/supplement-ui.js) stops key propagation so reading keys never reach the robot, so the
// links must listen in the capture phase: a bubbling listener on document never hears an Esc
// pressed inside that dialog, and the dialog would close while the run kept going.
import test from 'node:test';
import assert from 'node:assert/strict';
// Evaluated before the stubs below, so content.js keeps reading files the Node way.
import '../js/core/content.js';

const listeners = [];
const target = (name) => ({
  addEventListener(type, handler, options) {
    listeners.push({ name, type, handler, options });
  },
  removeEventListener() {},
});
globalThis.document ??= { ...target('document'), hidden: false };
// The links watch pagehide on window; the stub is set after content.js decided it is not a browser.
globalThis.window ??= target('window');

const captured = (type) =>
  listeners.filter(
    (entry) =>
      entry.name === 'document' &&
      entry.type === type &&
      (entry.options === true || entry.options?.capture === true),
  );

test('drive-link and shoot-link hear Esc in the capture phase', async () => {
  const before = listeners.length;
  await import('../js/live/drive-link.js');
  assert.equal(
    captured('keydown').length,
    1,
    'drive-link registers one capturing keydown listener',
  );
  await import('../js/live/shoot-link.js');
  assert.equal(captured('keydown').length, 2, 'shoot-link registers its own capturing listener');
  assert.ok(listeners.length > before);
  // With nothing running, Esc is a no-op (it must not throw while a dialog closes).
  for (const entry of captured('keydown')) entry.handler({ key: 'Escape' });
});

test('no bubbling document keydown listener is left for Esc in the links', () => {
  const bubbling = listeners.filter(
    (entry) =>
      entry.name === 'document' &&
      entry.type === 'keydown' &&
      !(entry.options === true || entry.options?.capture === true),
  );
  assert.equal(bubbling.length, 0);
});
