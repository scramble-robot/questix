import { loadJson } from '../core/content.js';
import { schoolTips } from './school-tips.js';
import { lessonBrief } from './lesson-brief.js';

// Each lesson names its situation, purpose/comparison, first action and figure guide.
const LESSON_GUIDES = await loadJson('content/lesson-guides.json');
function lessonGuide(key, purposeNote = '') {
  const c = LESSON_GUIDES[key];
  return c
    ? lessonBrief(key, purposeNote ? { ...c, purpose: [c.purpose, purposeNote] } : c) +
        schoolTips(key)
    : '';
}
function figureGuide(key) {
  const c = LESSON_GUIDES[key];
  return c ? `<p class="figure-guide"><strong>図の見方</strong>${c.figure}</p>` : '';
}

export { LESSON_GUIDES, lessonGuide, figureGuide };
