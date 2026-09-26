import { loadJson } from '../core/content.js';

// Course catalogue, every topic's texts and controls, and the real-robot notes.
const { SYSTEM_COURSES, SYSTEM_TOPICS, SYSTEM_REAL } = await loadJson('content/systems.json');

// The settings a topic starts with, taken from the controls it offers.
function systemDefaults(course, id) {
  const topic = SYSTEM_TOPICS[course].find((entry) => entry.id === id);
  return Object.fromEntries(topic.controls.map((control) => [control.key, control.value]));
}

export { SYSTEM_COURSES, SYSTEM_TOPICS, systemDefaults, SYSTEM_REAL };
