import { loadJson } from '../core/content.js';
import { SYSTEM_COURSES } from '../systems/data.js';

// The course catalogue and the vocabulary shared by every lesson page: course titles, the
// four experiment steps and the sensor tabs. Texts live in content/shell/lessons.json; the
// six "systems" courses bring their own entries from content/systems.json.
// The string-returning helpers are embedded by the course modules in their own markup.

const copy = await loadJson('content/shell/lessons.json');

// Catalogue groups, each with the ids of its courses in reading order.
const LESSON_GROUPS = copy.groups;

const allLessons = [...copy.lessons, ...SYSTEM_COURSES];
const lessonById = (id) => allLessons.find((lesson) => lesson.id === id);

// Courses in catalogue order; the position in this array is the course number learners see.
const LESSONS = LESSON_GROUPS.flatMap((group) => group.ids.map(lessonById));

// Course identity stays the same in the catalogue, navigation and experiment headings.
function lessonLabel(id) {
  const lesson = lessonById(id);
  return `<span>${lesson.title}</span><span class="course-terms">${lesson.summary}</span>`;
}

// [{ key, label }]: set up, run, look at the result, change a condition and compare.
const EXPERIMENT_STEPS = copy.experimentSteps;

// `attribute` is the data attribute the course uses to find the buttons (e.g. data-lab-step).
function experimentSteps(attribute) {
  const buttons = EXPERIMENT_STEPS.map(
    (step, index) =>
      `<button ${attribute}="${step.key}"><span>${index + 1}</span>${step.label}</button>`,
  ).join('');
  return `<nav class="step-nav" aria-label="実験の手順">${buttons}</nav>`;
}

const DEFAULT_SENSOR = 'lidar';

function sensorTabs(attribute) {
  const buttons = copy.sensorTabs
    .map(
      (sensor) =>
        `<button ${attribute}="${sensor.key}" aria-pressed="${sensor.key === DEFAULT_SENSOR}">${sensor.label}</button>`,
    )
    .join('');
  return `<div class="sensor-tabs" role="group" aria-label="センサーを選ぶ">${buttons}</div>`;
}

// { lidar: { name, title }, … }: device name and what each sensor measures.
const SENSOR_COPY = copy.sensorCopy;

export {
  LESSON_GROUPS,
  LESSONS,
  lessonLabel,
  EXPERIMENT_STEPS,
  experimentSteps,
  sensorTabs,
  SENSOR_COPY,
};
