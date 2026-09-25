// Where a learner is inside a course: the course's experiments in teaching order, the one on
// screen and the ones already opened. Every course reports this (shell/lesson-progress.js), so one
// footer can move between experiments the same way everywhere, and the course's summary (quiz and
// mastery test) opens fully only once the learner has reached the end. No DOM:
// test/lesson-progress-core.test.mjs.

/**
 * The footer's model for one course. `topics` = [{ id, title }] in teaching order, `current` the id
 * on screen, `visited` the ids opened so far (a Set or an array).
 * `ready` is true on the last experiment or once every experiment has been opened: the summary
 * then opens fully instead of as a short note.
 */
function progressModel({ topics, current, visited = [] }) {
  const seen = new Set(visited);
  seen.add(current);
  const index = Math.max(
    0,
    topics.findIndex((topic) => topic.id === current),
  );
  const items = topics.map((topic, position) => ({
    ...topic,
    number: position + 1,
    current: position === index,
    visited: seen.has(topic.id),
  }));
  const visitedCount = items.filter((item) => item.visited).length;
  const last = index === topics.length - 1;
  return {
    items,
    index,
    number: index + 1,
    total: topics.length,
    current: items[index],
    previous: index > 0 ? items[index - 1] : null,
    next: last ? null : items[index + 1],
    visitedCount,
    last,
    ready: last || visitedCount === topics.length,
  };
}

/** Reads the stored visited ids of every course; bad or missing data gives an empty record. */
function parseVisited(text) {
  try {
    const data = JSON.parse(text ?? '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const clean = {};
    for (const [course, ids] of Object.entries(data))
      if (Array.isArray(ids)) clean[course] = ids.filter((id) => typeof id === 'string');
    return clean;
  } catch {
    return {};
  }
}

export { progressModel, parseVisited };
