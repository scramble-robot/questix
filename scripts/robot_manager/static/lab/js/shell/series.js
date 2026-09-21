import { seriesCover } from './series-covers.js';
import { SYSTEM_COURSES } from '../systems/data.js';
import { initSystems, activateSystem, reviewSystem } from '../systems/ui.js';
import { showMeasurementLab } from '../systems/measurement-lab.js';
import { LESSONS, LESSON_GROUPS, lessonLabel } from './lesson-ui.js';
import { schoolOverview, initSchoolOverview } from './school-tips.js';
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

initSupplements();
initLessonIcons();
const $ = (id) => document.getElementById(id);
const pages = ['seriesPage', ...LESSONS.flatMap((l) => l.pages), 'quizPage', 'masteryPage'];
$('rlCourseLabel').innerHTML = lessonLabel('rl');
$('lessonNav').innerHTML = LESSONS.map(
  (l, i) =>
    '<a id="' +
    l.nav +
    '" href="#' +
    l.id +
    '"><strong><b class="course-nav-number" aria-hidden="true">' +
    (i + 1) +
    '</b>' +
    (l.id === 'planning' ? '道を選んで<br>目的地へ進む' : l.title) +
    '</strong><span>' +
    l.summary +
    '</span></a>',
).join('');
$('seriesPage').innerHTML =
  `<div class="series-heading"><p class="eyebrow">QUESTiX LAB · 移動ロボットの実験室</p><h1>ロボットの技術を、実験で学ぶ</h1><p>画面のロボットを動かし、測ったデータから仕組みを調べる教材です。専門用語や式は、使う場面で説明します。初めてなら1から順に、気になる内容があればその教材から始められます。<br>各実験の「最初に試すこと」に沿って一度動かし、予想と違った所を探してください。条件を一つだけ変えてもう一度試すと、何が動きに影響したかを比べられます。</p></div>
<div class="series-group-index">${LESSON_GROUPS.map((g, i) => '<a href="#course-group-' + i + '">' + g.title + ' ↓</a>').join('')}</div>
${LESSON_GROUPS.map(
  (group, gi) =>
    '<section class="series-group" id="course-group-' +
    gi +
    '"><h2>' +
    group.title +
    '</h2><p>' +
    group.description +
    '</p><div class="series-courses">' +
    group.ids
      .map((id) => {
        const l = LESSONS.find((v) => v.id === id),
          i = LESSONS.indexOf(l);
        return (
          '<article class="card series-course"><div class="series-cover ' +
          l.id +
          '-cover">' +
          seriesCover(l.id, l.canvas) +
          '<span>' +
          l.summary +
          '</span></div><div class="series-course-body"><p class="series-order">' +
          String(i + 1).padStart(2, '0') +
          ' <span>/ ' +
          LESSONS.length +
          '</span></p><h3>' +
          l.title +
          '</h3><p>' +
          l.description +
          '</p><div class="series-tags">' +
          l.tags.map((t) => '<span>' + t + '</span>').join('') +
          '</div><button class="primary full" id="' +
          l.button +
          '" aria-label="「' +
          l.title +
          '」の教材を開く">この教材を開く →</button></div></article>'
        );
      })
      .join('') +
    '</div></section>',
).join('')}
${schoolOverview(LESSONS)}
<section class="series-robot card"><div><p class="eyebrow">実験で使うロボット · QUESTiX</p><h2>左右の車輪で走り、4種類のセンサーで測る</h2><p>モーターは電気で回転を生み、車輪を動かします。左右を同じ速さで回すと直進し、回る速さに差を付けると曲がります。センサーは、動いた結果や周囲の様子を数値や画像で受け取る装置です。</p></div><dl><div><dt>車輪の回転数センサー</dt><dd>車輪がどれだけ回ったか、どれくらいの速さで回っているかを測ります。1分間に60回転する速さが60 rpmです。</dd></div><div><dt>9軸IMU</dt><dd>速さの変化、回る速さ、磁場をそれぞれ3方向で測ります。衝撃に気づいたり、機体の向きや傾きを推定したりする情報になります。</dd></div><div><dt>2D LiDAR（ライダー）</dt><dd>レーザーの光を周囲へ向け、物までの距離を測ります。同じ高さで測った点を並べると、壁や棚の配置を調べられます。</dd></div><div><dt>RGB-Dカメラ 1台</dt><dd>普通の写真のような色の画像と、画像の各点に対応する奥行きを取得します。「何が見えるか」と「どれくらい手前にあるか」を調べられます。</dd></div></dl></section><p class="page-footnote">RGB-Dカメラは、色を記録するRGBと奥行きを表すD（Depth）の両方を扱うカメラです。この教材では、左右2か所から撮った画像の違いで奥行きを求める装置を1台搭載した構成を使います。</p><p class="page-footnote">SO-ARM101は、物をつかむために取り付けるオプションのアームです。肩やひじに相当する関節をモーターで回し、手先を動かします。</p><p class="page-footnote">画面の実験は、ロボットの動きを計算で再現するシミュレーションです。実物を動かす命令は送りません。実機で測った記録（ログ）を読み込んで比べられる教材もあります。実験記録は教材を切り替えても残りますが、ページを再読み込みすると消えます。</p>`;
initSlam(HARDWARE);
initVision();
initControl();
initPlanning();
initLaunch();
initArm();
initSystems();
let currentSeries = null,
  quizCourse = null;
const reviewLessons = {
  ...Object.fromEntries(SYSTEM_COURSES.map((c) => [c.id, (topic) => reviewSystem(c.id, topic)])),
  control: reviewControl,
  launch: reviewLaunch,
  arm: reviewArm,
  vision: reviewVision,
  slam: reviewSlam,
  planning: reviewPlanning,
  rl: reviewRL,
};
const openReviewExperiment = (course, topic) => {
  show(course);
  const opened = reviewLessons[course](topic);
  if (course === 'rl') lastPages.set('rl', 'introPage');
  return opened;
};
const mastery = initMastery({
  openTest: showMastery,
  backToCourse: show,
  openExperiment: openReviewExperiment,
});
const quizzes = initQuizzes({
  openQuiz: showQuiz,
  backToCourse: show,
  openExperiment: openReviewExperiment,
  openMastery: showMastery,
  masteryStatus: mastery.status,
});
const lastPages = new Map(LESSONS.map((l) => [l.id, l.pages[0]]));
initSchoolOverview($('seriesPage'), (course, topic) => {
  show(course);
  reviewLessons[course](topic);
  if (course === 'rl') lastPages.set('rl', 'introPage');
});
function updateNavigation(name) {
  $('courseSwitcher').open = false;
  $('currentCourseTitle').textContent =
    LESSONS.find((l) => l.id === name)?.title || '13科目から選ぶ';
  currentSeries = name;
  document.title =
    (LESSONS.find((l) => l.id === name)?.title || 'ロボットの技術を学ぶ実験室') + '｜QUESTiX LAB';
  $('seriesHome').hidden = name === 'series';
  for (const lesson of LESSONS)
    $(lesson.nav).setAttribute('aria-current', name === lesson.id ? 'page' : 'false');
}
function show(name, hash = true) {
  if (name === currentSeries && !quizCourse) return;
  const previous = LESSONS.find((l) => l.id === currentSeries);
  if (previous)
    lastPages.set(
      previous.id,
      previous.pages.find((id) => !$(id).hidden) || lastPages.get(previous.id),
    );
  document.dispatchEvent(new CustomEvent('series-leave'));
  pauseSlam();
  quizCourse = null;
  for (const id of pages) $(id).hidden = true;
  $(lastPages.get(name) || 'seriesPage').hidden = false;
  if (name === 'vision') activateVision();
  if (name === 'control') activateControl();
  if (name === 'planning') activatePlanning();
  if (name === 'launch') activateLaunch();
  if (name === 'arm') activateArm();
  activateSystem(name);
  showMeasurementLab(name);
  updateNavigation(name);
  quizzes.showCourse(name);
  mastery.showCourse(name);
  if (hash && location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  window.scrollTo({ top: 0 });
}
function showQuiz(name, hash = true) {
  if (!LESSONS.some((l) => l.id === name)) return;
  const previous = LESSONS.find((l) => l.id === currentSeries);
  if (previous)
    lastPages.set(
      previous.id,
      previous.pages.find((id) => !$(id).hidden) || lastPages.get(previous.id),
    );
  document.dispatchEvent(new CustomEvent('series-leave'));
  pauseSlam();
  for (const id of pages) $(id).hidden = true;
  showMeasurementLab(null);
  mastery.hide();
  quizCourse = name;
  updateNavigation(name);
  $('quizPage').hidden = false;
  quizzes.show(name);
  document.title = '小テスト｜' + LESSONS.find((l) => l.id === name).title + '｜QUESTiX LAB';
  if (hash) history.replaceState(null, '', '#quiz-' + name);
  window.scrollTo({ top: 0 });
}
function showMastery(name, hash = true) {
  if (!LESSONS.some((l) => l.id === name)) return;
  const previous = LESSONS.find((l) => l.id === currentSeries);
  if (previous)
    lastPages.set(
      previous.id,
      previous.pages.find((id) => !$(id).hidden) || lastPages.get(previous.id),
    );
  document.dispatchEvent(new CustomEvent('series-leave'));
  pauseSlam();
  for (const id of pages) $(id).hidden = true;
  showMeasurementLab(null);
  quizzes.hide();
  quizCourse = name;
  updateNavigation(name);
  $('masteryPage').hidden = false;
  mastery.show(name);
  document.title = '実力テスト｜' + LESSONS.find((l) => l.id === name).title + '｜QUESTiX LAB';
  if (hash) history.replaceState(null, '', '#mastery-' + name);
  window.scrollTo({ top: 0 });
}
for (const lesson of LESSONS) {
  $(lesson.nav).onclick = (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    $('courseSwitcher').open = false;
    show(lesson.id);
  };
  $(lesson.button).onclick = () => show(lesson.id);
}
$('seriesHome').onclick = () => show('series');
document.querySelector('.brand').onclick = (e) => {
  e.preventDefault();
  show('series');
};
document.addEventListener('series-open', (e) => show(e.detail));
document.addEventListener('quiz-open', (e) => showQuiz(e.detail));
function route() {
  if (location.hash.startsWith('#course-group-')) return;
  const test = LESSONS.find((l) => '#mastery-' + l.id === location.hash);
  if (test) {
    showMastery(test.id, false);
    return;
  }
  const quiz = LESSONS.find((l) => '#quiz-' + l.id === location.hash);
  if (quiz) showQuiz(quiz.id, false);
  else show(LESSONS.find((l) => '#' + l.id === location.hash)?.id || 'series', false);
}
document.addEventListener('pointerdown', (e) => {
  const menu = $('courseSwitcher');
  if (menu.open && !menu.contains(e.target)) menu.open = false;
});
document.addEventListener('click', (e) => {
  const menu = $('courseSwitcher');
  if (menu.open && !menu.contains(e.target)) menu.open = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('courseSwitcher').open) {
    $('courseSwitcher').open = false;
    $('courseSwitcher').querySelector('summary').focus();
  }
});
window.addEventListener('hashchange', route);
route();
