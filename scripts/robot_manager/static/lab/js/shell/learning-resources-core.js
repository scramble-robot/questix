// The curated reading list of each course (content/shell/learning-resources.json), as plain data
// for js/shell/learning-resources.js. No DOM, so the list's rules are Node tests
// (test/learning-resources.test.mjs). The list is keyed by course id; an entry for a course the
// site does not have yet (the motor course) simply stays unused until the course exists.

const RESOURCE_KINDS = ['article', 'video', 'book'];
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// '2026-09-22' → '2026年9月22日'.
function japaneseDate(iso) {
  const match = ISO_DATE.exec(iso);
  if (!match) return iso;
  const [, year, month, day] = match;
  return `${Number(year)}年${Number(month)}月${Number(day)}日`;
}

// The site the learner is about to leave for, shown next to the link.
const siteOf = (url) => new URL(url).hostname;

const latest = (dates) => dates.reduce((newest, date) => (date > newest ? date : newest), '');

/**
 * The reading list of one course: null when the course has none, otherwise its resources (each
 * with its `site`), when their content was reviewed and when the links were last checked.
 */
function courseResources(data, courseId) {
  const entry = data.courses[courseId];
  if (!entry || entry.resources.length === 0) return null;
  const resources = entry.resources.map((resource) => ({
    ...resource,
    site: siteOf(resource.url),
  }));
  return {
    courseId,
    resources,
    reviewedOn: entry.reviewedOn,
    checkedOn: latest(resources.map((resource) => resource.checkedOn)),
  };
}

export { RESOURCE_KINDS, japaneseDate, siteOf, courseResources };
