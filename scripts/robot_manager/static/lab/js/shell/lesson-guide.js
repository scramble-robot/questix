import { loadJson } from '../core/content.js';
import { schoolTips } from './school-tips.js';
import { lessonBrief } from './lesson-brief.js';

// Each lesson (`<course>-<topic>` key) names its situation, purpose/comparison, first action and
// figure guide in content/lesson-guides.json. Courses embed the returned HTML strings.

const LESSON_GUIDES = await loadJson('content/lesson-guides.json');
const copy = await loadJson('content/shell/lesson-guide.json');

// A course may append its own note to the purpose section (e.g. the current condition).
function withPurposeNote(guide, purposeNote) {
  if (!purposeNote) return guide;
  return { ...guide, purpose: [guide.purpose, purposeNote] };
}

function lessonGuide(key, purposeNote = '') {
  const guide = LESSON_GUIDES[key];
  if (!guide) return '';
  return lessonBrief(key, withPurposeNote(guide, purposeNote)) + schoolTips(key);
}

function figureGuide(key) {
  const guide = LESSON_GUIDES[key];
  if (!guide) return '';
  return `<p class="figure-guide"><strong>${copy.figureGuideLabel}</strong>${guide.figure}</p>`;
}

export { LESSON_GUIDES, lessonGuide, figureGuide };
