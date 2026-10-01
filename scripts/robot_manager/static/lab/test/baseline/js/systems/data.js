import { loadJson } from '../core/content.js';

// Course catalogue, every topic's texts and controls, and the real-robot notes.
const { SYSTEM_COURSES, SYSTEM_TOPICS, SYSTEM_REAL } = await loadJson('content/systems.json');

function systemDefaults(course, id) {
  const t = SYSTEM_TOPICS[course].find((t) => t.id === id);
  return Object.fromEntries(t.controls.map((c) => [c.key, c.value]));
}

export { SYSTEM_COURSES, SYSTEM_TOPICS, systemDefaults, SYSTEM_REAL };
