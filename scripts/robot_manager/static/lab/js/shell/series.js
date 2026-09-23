import { render, unsafeHTML } from '../vendor/lit-html.js';
import { loadJson, loadText } from '../core/content.js';
import { SYSTEM_COURSES } from '../systems/data.js';
import { initSystems, activateSystem, reviewSystem } from '../systems/ui.js';
import { showMeasurementLab } from '../systems/measurement-lab.js';
import { LESSONS, LESSON_GROUPS, lessonLabel } from './lesson-ui.js';
import { SCHOOL_GRADES } from './school-tips.js';
import { initSupplements } from './supplement-ui.js';
import { initLessonIcons } from './lesson-icons.js';
import { initSlam, pauseSlam, reviewSlam } from '../slam/ui.js';
import { HARDWARE } from '../slam/hardware.js';
import { initVision, activateVision, reviewVision } from '../vision/ui.js';
import { initControl, activateControl, reviewControl } from '../control/ui.js';
import { initPlanning, activatePlanning, reviewPlanning } from '../planning/ui.js';
import { initLaunch, activateLaunch, reviewLaunch } from '../launch/ui.js';
import { initArm, activateArm, reviewArm } from '../arm/ui.js';
import { reviewRL } from '../rl/foundations.js';
import { initQuizzes } from '../quiz/ui.js';
import { initMastery } from '../quiz/mastery-ui.js';
import { courseNavigation, seriesPage } from './series-view.js';
import { courseRunModes, RUN_MODE_COPY } from './run-mode.js';

// Application shell: which page is shown (catalogue, a course, a quiz or a mastery test), the
// header course switcher, the hash routes and the catalogue page itself. series-view.js turns the
// model into markup; the courses own their pages and expose init/activate/review entry points.

const copy = await loadJson('content/shell/series.json');
const curriculumSourceHtml = (await loadText('content/shell/school-curriculum-source.html')).trim();

const CATALOGUE = 'series'; // the route of the catalogue page
const CATALOGUE_PAGE = 'seriesPage';
const GROUP_ANCHOR_PREFIX = '#course-group-'; // in-page links on the catalogue, not routes
const ASSESSMENTS = {
  quiz: { hashPrefix: '#quiz-', page: 'quizPage', title: copy.header.quizTitle },
  mastery: { hashPrefix: '#mastery-', page: 'masteryPage', title: copy.header.masteryTitle },
};

const $ = (id) => document.getElementById(id);
const siteHeader = document.querySelector('.site-header');
const CARD_GAP_BELOW_HEADER = 16; // px
const lessonById = (id) => LESSONS.find((lesson) => lesson.id === id);
const pageIds = [
  CATALOGUE_PAGE,
  ...LESSONS.flatMap((lesson) => lesson.pages),
  'quizPage',
  'masteryPage',
];

// --- State ---------------------------------------------------------------------------------------

let course = null; // CATALOGUE or a course id; null until the first route
let assessment = null; // 'quiz' | 'mastery' while a test page is shown instead of the course
let selectedGrade = SCHOOL_GRADES[0].id; // tab of the school-subject overview
// Section a course was left on, so that returning to it continues where the learner was.
const lastPages = new Map(LESSONS.map((lesson) => [lesson.id, lesson.pages[0]]));
// Where the catalogue was scrolled when a course was opened from it: { course, scrollY }.
let catalogueReturn = null;

initSupplements();
initLessonIcons();
render(unsafeHTML(lessonLabel('rl')), $('rlCourseLabel'));
$('currentCourseTitle').replaceChildren(); // index.html holds the caption until lit renders it

// --- Model -----------------------------------------------------------------------------------

const catalogueGroups = LESSON_GROUPS.map((group) => ({
  ...group,
  lessons: group.ids.map((id) => ({
    ...lessonById(id),
    number: LESSONS.indexOf(lessonById(id)) + 1,
    runModes: courseRunModes(id),
  })),
}));
const courseTitles = Object.fromEntries(LESSONS.map((lesson) => [lesson.id, lesson.title]));

function model() {
  return {
    copy,
    course,
    lessons: LESSONS,
    groups: catalogueGroups,
    runModeCopy: RUN_MODE_COPY,
    overview: {
      grades: SCHOOL_GRADES,
      selectedGrade,
      courseTitles,
      sourceHtml: curriculumSourceHtml,
    },
  };
}

function headerCaption() {
  return lessonById(course)?.title || copy.header.chooseCourse;
}

function documentTitle() {
  const courseTitle = lessonById(course)?.title || copy.header.catalogueTitle;
  const prefix = assessment ? `${ASSESSMENTS[assessment].title}｜` : '';
  return `${prefix}${courseTitle}｜${copy.siteName}`;
}

function update() {
  const current = model();
  render(courseNavigation(current, actions), $('lessonNav'));
  render(headerCaption(), $('currentCourseTitle'));
  render(seriesPage(current, actions), $(CATALOGUE_PAGE));
  $('seriesHome').hidden = course === CATALOGUE;
  $('courseSwitcher').open = false;
  document.title = documentTitle();
}

// --- Page switching ------------------------------------------------------------------------------

const visiblePage = (lesson) => lesson.pages.find((id) => !$(id).hidden);

// Remembers where the current course was left, tells the courses to pause and hides every page.
function leaveCurrentPage() {
  const previous = lessonById(course);
  if (previous) lastPages.set(previous.id, visiblePage(previous) || lastPages.get(previous.id));
  document.dispatchEvent(new CustomEvent('series-leave'));
  pauseSlam();
  for (const id of pageIds) $(id).hidden = true;
}

// Every page change is a history entry, so the browser's back button (or the phone's back gesture)
// returns to the catalogue instead of leaving the site.
// The pages scroll themselves (scrollAfterShowing); the browser's own restoration would fight it.
history.scrollRestoration = 'manual';
function pushHash(hash) {
  if (location.hash !== hash) history.pushState(null, '', hash);
}

// Back on the catalogue, the learner sees the cards they were choosing from: the position they
// left it at, or the card of the course they come from when that course was opened elsewhere.
function scrollCatalogue(previous) {
  if (catalogueReturn && catalogueReturn.course === previous) {
    window.scrollTo({ top: catalogueReturn.scrollY });
    return;
  }
  const button = $(lessonById(previous)?.button);
  if (!button) {
    window.scrollTo({ top: 0 });
    return;
  }
  // The header stays on screen (sticky), so the card goes just below it.
  const cardTop = button.closest('.series-course').getBoundingClientRect().top + window.scrollY;
  window.scrollTo({ top: cardTop - siteHeader.offsetHeight - CARD_GAP_BELOW_HEADER });
}

function scrollAfterShowing(name, previous) {
  if (name === CATALOGUE) scrollCatalogue(previous);
  else window.scrollTo({ top: 0 });
}

const activators = {
  vision: activateVision,
  control: activateControl,
  planning: activatePlanning,
  launch: activateLaunch,
  arm: activateArm,
};

function show(name, updateHash = true) {
  if (name === course && !assessment) return;
  const previous = course;
  if (previous === CATALOGUE) catalogueReturn = { course: name, scrollY: window.scrollY };
  leaveCurrentPage();
  assessment = null;
  $(lastPages.get(name) || CATALOGUE_PAGE).hidden = false;
  activators[name]?.();
  activateSystem(name);
  showMeasurementLab(name);
  course = name;
  update();
  quizzes.showCourse(name);
  mastery.showCourse(name);
  if (updateHash) pushHash('#' + name);
  scrollAfterShowing(name, previous);
}

function showAssessment(kind, name, updateHash) {
  if (!lessonById(name)) return;
  if (course === CATALOGUE) catalogueReturn = { course: name, scrollY: window.scrollY };
  leaveCurrentPage();
  showMeasurementLab(null);
  if (kind === 'quiz') mastery.hide();
  else quizzes.hide();
  assessment = kind;
  course = name;
  update();
  $(ASSESSMENTS[kind].page).hidden = false;
  if (kind === 'quiz') quizzes.show(name);
  else mastery.show(name);
  if (updateHash) pushHash(ASSESSMENTS[kind].hashPrefix + name);
  window.scrollTo({ top: 0 });
}

const showQuiz = (name, updateHash = true) => showAssessment('quiz', name, updateHash);
const showMastery = (name, updateHash = true) => showAssessment('mastery', name, updateHash);

// --- Opening an experiment from a review, a test or the school overview ----------------------

const reviewLessons = {
  ...Object.fromEntries(
    SYSTEM_COURSES.map((system) => [system.id, (topic) => reviewSystem(system.id, topic)]),
  ),
  control: reviewControl,
  launch: reviewLaunch,
  arm: reviewArm,
  vision: reviewVision,
  slam: reviewSlam,
  planning: reviewPlanning,
  rl: reviewRL,
};

function openExperiment(name, topic) {
  show(name);
  const opened = reviewLessons[name](topic);
  // The RL review opens the foundations page; next time the course starts there again.
  if (name === 'rl') lastPages.set('rl', 'introPage');
  return opened;
}

// --- Actions ---------------------------------------------------------------------------------------

const modified = (event) => event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;

// Keyboard order of the grade tabs (WAI-ARIA tabs pattern); null for other keys.
function nextGradeIndex(key, index, count) {
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index + count - 1) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

const actions = {
  openCourse: (id) => show(id),
  followCourseLink(event, id) {
    if (modified(event)) return; // let the browser open a new tab/window
    event.preventDefault();
    show(id);
  },
  selectGrade(id) {
    selectedGrade = id;
    update();
  },
  moveBetweenGrades(event, id) {
    const index = SCHOOL_GRADES.findIndex((grade) => grade.id === id);
    const next = nextGradeIndex(event.key, index, SCHOOL_GRADES.length);
    if (next === null) return;
    event.preventDefault();
    actions.selectGrade(SCHOOL_GRADES[next].id);
    $(`school-tab-${SCHOOL_GRADES[next].id}`).focus();
  },
  followExperimentLink(event, experiment) {
    if (modified(event) || event.button !== 0) return;
    event.preventDefault();
    openExperiment(experiment.course, experiment.topic);
  },
};

// --- Start-up ------------------------------------------------------------------------------------

initSlam(HARDWARE);
initVision();
initControl();
initPlanning();
initLaunch();
initArm();
initSystems();
const mastery = initMastery({
  openTest: showMastery,
  backToCourse: show,
  openExperiment,
});
const quizzes = initQuizzes({
  openQuiz: showQuiz,
  backToCourse: show,
  openExperiment,
  openMastery: showMastery,
  masteryStatus: mastery.status,
});

$('seriesHome').onclick = () => show(CATALOGUE);
document.querySelector('.brand').onclick = (event) => {
  event.preventDefault();
  show(CATALOGUE);
};
document.addEventListener('series-open', (event) => show(event.detail));
document.addEventListener('quiz-open', (event) => showQuiz(event.detail));

// The course switcher closes on any click or tap outside it and on Escape.
function closeSwitcherOutside(event) {
  const switcher = $('courseSwitcher');
  if (switcher.open && !switcher.contains(event.target)) switcher.open = false;
}
document.addEventListener('pointerdown', closeSwitcherOutside);
document.addEventListener('click', closeSwitcherOutside);
document.addEventListener('keydown', (event) => {
  const switcher = $('courseSwitcher');
  if (event.key !== 'Escape' || !switcher.open) return;
  switcher.open = false;
  switcher.querySelector('summary').focus();
});

// On a phone the header scrolls away with the page and slides back in as soon as the learner
// scrolls up, so the catalogue button and the switcher are one small swipe away from anywhere.
const HEADER_TUCK_QUERY = window.matchMedia('(max-width: 600px)');
const HEADER_SCROLL_THRESHOLD = 6; // px of scrolling in one direction before the header reacts
let lastScrollY = window.scrollY;

function tuckHeaderOnScroll() {
  const scrollY = window.scrollY;
  const delta = scrollY - lastScrollY;
  if (Math.abs(delta) < HEADER_SCROLL_THRESHOLD) return;
  const tucked =
    HEADER_TUCK_QUERY.matches &&
    delta > 0 &&
    scrollY > siteHeader.offsetHeight &&
    !$('courseSwitcher').open;
  siteHeader.classList.toggle('is-tucked', tucked);
  lastScrollY = scrollY;
}
window.addEventListener('scroll', tuckHeaderOnScroll, { passive: true });
siteHeader.addEventListener('focusin', () => siteHeader.classList.remove('is-tucked'));

// --- Hash routes: #<course>, #quiz-<course>, #mastery-<course>; anything else is the catalogue.

function assessmentRoute(hash) {
  for (const [kind, { hashPrefix }] of Object.entries(ASSESSMENTS)) {
    const lesson = LESSONS.find((candidate) => hashPrefix + candidate.id === hash);
    if (lesson) return { kind, id: lesson.id };
  }
  return null;
}

function route() {
  const hash = location.hash;
  if (hash.startsWith(GROUP_ANCHOR_PREFIX)) {
    // A group heading of the catalogue; going back to it from a course shows the catalogue again.
    if (course !== CATALOGUE) show(CATALOGUE, false);
    document.querySelector(hash)?.scrollIntoView();
    return;
  }
  const test = assessmentRoute(hash);
  if (test) {
    showAssessment(test.kind, test.id, false);
    return;
  }
  show(LESSONS.find((lesson) => '#' + lesson.id === hash)?.id || CATALOGUE, false);
}
window.addEventListener('hashchange', route);
route();
