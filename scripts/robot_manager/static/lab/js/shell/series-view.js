import { html, nothing, unsafeHTML } from '../vendor/lit-html.js';
import { seriesCover } from './series-covers.js';
import { RUN_MODE_ORDER, runModeBadgeHtml } from './run-mode.js';

// Templates of the application shell: the course switcher in the header and the catalogue page
// (course groups, the school-subject overview and the robot description). Every function is pure:
// it turns the model built by series.js into markup. Sentences come from content/shell/series.json
// (`copy`); only short labels live here.

const COURSE_NUMBER_DIGITS = 2; // "01 / 13"

// --- Header: course switcher -------------------------------------------------------------------

// A course title may break onto two lines in the narrow switcher (content/shell/series.json).
function navigationTitle(lesson, copy) {
  const lines = copy.navigationTitleLines[lesson.id] || [lesson.title];
  return lines.map((line, index) => (index === 0 ? line : html`<br />${line}`));
}

// Only courses that can use the robot are marked, so the switcher stays short.
function navigationRunModes(lesson) {
  const modes = lesson.runModes.modes.filter((mode) => mode !== 'sim');
  if (!modes.length) return nothing;
  return html`<span class="run-mode-badges"
    >${modes.map((mode) => unsafeHTML(runModeBadgeHtml(mode)))}</span
  >`;
}

// Each entry repeats a small copy of the catalogue cover, so a course can be recognised from inside
// another one by the same picture the learner chose it by.
function courseLink(lesson, model, actions) {
  const current = model.course === lesson.id ? 'page' : 'false';
  return html`<a
    id=${lesson.nav}
    href="#${lesson.id}"
    aria-current=${current}
    @click=${(event) => actions.followCourseLink(event, lesson.id)}
    ><span class="course-nav-cover"
      >${unsafeHTML(seriesCover(lesson.id, undefined, { decorative: true }))}</span
    ><strong
      ><b class="course-nav-number" aria-hidden="true">${lesson.number}</b>${navigationTitle(
        lesson,
        model.copy,
      )}</strong
    ><span>${lesson.summary}</span>${navigationRunModes(lesson)}</a
  >`;
}

// Grouped like the catalogue page, so both lists read in the same order under the same headings.
function courseNavigation(model, actions) {
  return model.groups.map(
    (group) =>
      html`<section class="course-nav-group">
        <h2>${group.title}</h2>
        <div class="course-nav-links">
          ${group.lessons.map((lesson) => courseLink(lesson, model, actions))}
        </div>
      </section>`,
  );
}

// --- Catalogue page ----------------------------------------------------------------------------

// The first course is where a newcomer starts, so it gets a button right under the heading
// instead of a sentence asking the learner to scroll to card 01.
function catalogueHeading(model, actions) {
  const copy = model.copy;
  const [firstLine, secondLine] = copy.heading.lead;
  const first = model.lessons[0];
  return html`<div class="series-heading">
    <p class="eyebrow">${copy.heading.eyebrow}</p>
    <h1>${copy.heading.title}</h1>
    <p>${firstLine}<br />${secondLine}</p>
    <div class="series-start">
      <button class="primary" data-series-start @click=${() => actions.openCourse(first.id)}>
        ${copy.heading.start} <span class="series-start-title">${first.title} →</span>
      </button>
      <a class="series-start-list" href="#course-group-0">${copy.heading.list}</a>
    </div>
  </div>`;
}

function groupIndex(groups) {
  return html`<div class="series-group-index">
    ${groups.map((group, index) => html`<a href="#course-group-${index}">${group.title} ↓</a>`)}
  </div>`;
}

// What the course runs on, above its description, and what the robot adds when it can be used.
function cardRunModes(lesson) {
  const { modes, real } = lesson.runModes;
  return html`<div class="series-run-modes" data-run-mode=${modes.join(' ')}>
    <span class="run-mode-badges">${modes.map((mode) => unsafeHTML(runModeBadgeHtml(mode)))}</span>
    ${real ? html`<p>${real}</p>` : nothing}
  </div>`;
}

// The labels explained once, after the courses: folded, because a newcomer without a robot does
// not need them to start.
function runModeLegend(copy) {
  return html`<details class="series-run-legend">
    <summary><h2>${copy.legend.title}</h2></summary>
    <p>${copy.legend.lead}</p>
    <dl>
      ${RUN_MODE_ORDER.map(
        (mode) =>
          html`<div>
            <dt>${unsafeHTML(runModeBadgeHtml(mode))}</dt>
            <dd>${copy.modes[mode].description}</dd>
          </div>`,
      )}
    </dl>
  </details>`;
}

function courseCard(lesson, model, actions) {
  const number = String(lesson.number).padStart(COURSE_NUMBER_DIGITS, '0');
  return html`<article class="card series-course">
    <div class="series-cover ${lesson.id}-cover">
      ${unsafeHTML(seriesCover(lesson.id, lesson.canvas))}<span>${lesson.summary}</span>
    </div>
    <div class="series-course-body">
      <p class="series-order">${number} <span>/ ${model.lessons.length}</span></p>
      <h3>${lesson.title}</h3>
      <p>${lesson.description}</p>
      <div class="series-tags">${lesson.tags.map((tag) => html`<span>${tag}</span>`)}</div>
      ${cardRunModes(lesson)}
      <button
        class="primary full"
        id=${lesson.button}
        aria-label="「${lesson.title}」の教材を開く"
        @click=${() => actions.openCourse(lesson.id)}
      >
        ${model.copy.openCourse}
      </button>
    </div>
  </article>`;
}

function courseGroup(group, index, model, actions) {
  return html`<section class="series-group" id="course-group-${index}">
    <h2>${group.title}</h2>
    <p>${group.description}</p>
    <div class="series-courses">
      ${group.lessons.map((lesson) => courseCard(lesson, model, actions))}
    </div>
  </section>`;
}

// --- School-subject overview (grade tabs inside a help dialog) ---------------------------------

const isHighSchool = (grade) => grade.id.startsWith('h');

function gradeTab(grade, model, actions) {
  const selected = grade.id === model.overview.selectedGrade;
  const estimate = isHighSchool(grade)
    ? html`<small>${model.copy.overview.estimateMark}</small>`
    : nothing;
  return html`<button
    type="button"
    role="tab"
    id="school-tab-${grade.id}"
    data-school-grade=${grade.id}
    aria-controls="school-panel-${grade.id}"
    aria-selected=${String(selected)}
    tabindex=${selected ? 0 : -1}
    aria-label=${grade.title}
    @click=${() => actions.selectGrade(grade.id)}
    @keydown=${(event) => actions.moveBetweenGrades(event, grade.id)}
  >
    ${grade.label}${estimate}
  </button>`;
}

function experimentLink(experiment, model, actions) {
  const { openExperimentPrefix, materialPrefix } = model.copy.overview;
  const courseTitle = model.overview.courseTitles[experiment.course] || experiment.course;
  return html`<a
    href="#${experiment.course}"
    data-school-course=${experiment.course}
    data-school-experiment=${experiment.topic}
    aria-label="${openExperimentPrefix}${experiment.label}${materialPrefix}${courseTitle}"
    @click=${(event) => actions.followExperimentLink(event, experiment)}
    >${experiment.label}<span aria-hidden="true"> →</span></a
  >`;
}

function subjectItem(item, model, actions) {
  return html`<div>
    <dt><span class="school-subject-name">${item.subject}</span>${item.title}</dt>
    <dd>
      <p>${item.use}</p>
      <div class="school-experiment-links">
        ${item.experiments.map((experiment) => experimentLink(experiment, model, actions))}
      </div>
    </dd>
  </div>`;
}

function gradePanel(grade, model, actions) {
  const [subjectColumn, useColumn] = model.copy.overview.columns;
  return html`<section
    class="school-grade-panel"
    id="school-panel-${grade.id}"
    data-school-panel=${grade.id}
    role="tabpanel"
    tabindex="0"
    aria-labelledby="school-tab-${grade.id}"
    ?hidden=${grade.id !== model.overview.selectedGrade}
  >
    <h2>${grade.title}</h2>
    <p>${grade.note}</p>
    <div class="school-column-head" aria-hidden="true">
      <span>${subjectColumn}</span><span>${useColumn}</span>
    </div>
    <dl class="school-subjects">${grade.items.map((item) => subjectItem(item, model, actions))}</dl>
  </section>`;
}

// `details[data-help-dialog]` is what supplement-ui.js turns into a "解説を開く" button + dialog;
// the grade tabs keep working there because their listeners are bound on the elements.
function schoolOverview(model, actions) {
  const copy = model.copy.overview;
  return html`<details
    data-help-dialog
    class="school-tip school-tip-overview"
    data-school-tip="series"
  >
    <summary>
      <span class="school-tip-label">${copy.label}</span>
      <span class="school-tip-topic">${copy.topic}</span>
    </summary>
    <div class="school-tip-body school-overview">
      <p>${copy.intro}</p>
      <p class="school-grade-note">${copy.gradeNote}</p>
      <div class="school-grade-tabs" role="tablist" aria-label=${copy.tabsAriaLabel}>
        ${model.overview.grades.map((grade) => gradeTab(grade, model, actions))}
      </div>
      ${model.overview.grades.map((grade) => gradePanel(grade, model, actions))}
      ${unsafeHTML(model.overview.sourceHtml)}
    </div>
  </details>`;
}

// --- The robot used in every experiment ---------------------------------------------------------

// Ends with the way to 記録の一覧: what was measured on the robot, by this or any other device.
function robotSection(copy, actions) {
  return html`<section class="series-robot card">
    <div>
      <p class="eyebrow">${copy.robot.eyebrow}</p>
      <h2>${copy.robot.title}</h2>
      <p>${copy.robot.lead}</p>
      <p class="series-records">
        ${copy.robot.recordsLead}
        <button class="quiet" data-series-records @click=${actions.openRecords}>
          ${copy.robot.records}
        </button>
      </p>
    </div>
    <dl>
      ${copy.robot.sensors.map(
        (sensor) =>
          html`<div>
            <dt>${sensor.name}</dt>
            <dd>${sensor.description}</dd>
          </div>`,
      )}
    </dl>
  </section>`;
}

// Reading order for a newcomer: what this is and where to start, the robot the experiments are
// about, the courses; the label legend and the school-subject overview for those who look further.
function seriesPage(model, actions) {
  const copy = model.copy;
  return html`${catalogueHeading(model, actions)}${robotSection(copy, actions)}${groupIndex(
    model.groups,
  )}${model.groups.map((group, index) =>
    courseGroup(group, index, model, actions),
  )}${runModeLegend(model.runModeCopy)}${schoolOverview(model, actions)}${copy.footnotes.map(
    (note) => html`<p class="page-footnote">${note}</p>`,
  )}`;
}

export { courseNavigation, seriesPage };
