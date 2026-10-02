import { targetById } from './records-core.js';
import { revealElement } from '../core/reveal.js';

// 「○○の教材で開く」 from 記録の一覧: the lessons that can take a recording register a handler
// here (records-core RECORD_TARGETS names them), and the records view opens a recording in one of
// them without knowing the lesson's code. The course page is brought up by the shell
// (series.js listens for `series-experiment`), then the handler hands the recording to the same
// code path as opening a file and scrolls to the chart it changed.

const handlers = new Map();

/**
 * `open(recording, {compare})` shows `recording` in the lesson (with `compare`, next to the one on
 * screen, for targets that can compare) and resolves with whether the lesson took it. The lesson
 * says why not in its own block, where the learner now is.
 */
function registerRecordTarget(id, open) {
  handlers.set(id, open);
}

/** Open the course of target `id` and hand it `recording`; resolves with the handler's answer. */
async function openRecordInLesson(id, recording, { compare = false } = {}) {
  const target = targetById(id);
  const open = handlers.get(id);
  if (!target || !open) return false;
  document.dispatchEvent(
    new CustomEvent('series-experiment', {
      detail: { course: target.course, topic: target.topic ?? null },
    }),
  );
  return open(recording, { compare: compare && Boolean(target.compare) });
}

// After the lesson has redrawn (two frames: the page switch, then the lesson's own update), the
// part `find()` returns is scrolled to (press → see).
function revealAfterRender(find) {
  requestAnimationFrame(() => requestAnimationFrame(() => revealElement(find())));
}

export { registerRecordTarget, openRecordInLesson, revealAfterRender };
