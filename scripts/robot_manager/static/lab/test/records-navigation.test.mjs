import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const copy = JSON.parse(read('content/shell/series.json'));
const html = (strings, ...values) => ({ strings: [...strings], values });
const text = (value) =>
  Array.isArray(value)
    ? value.map(text).join('')
    : value?.strings
      ? value.strings.map((s, i) => s + text(value.values[i])).join('')
      : typeof value === 'function' || value == null
        ? ''
        : String(value);

function navigation(course, handler) {
  const context = {
    html,
    nothing: '',
    unsafeHTML: (value) => value,
    seriesCover: () => '',
    runModeBadgeHtml: () => '',
  };
  vm.runInNewContext(
    read('js/shell/series-view.js')
      .replace(/^import .*;\n/gm, '')
      .replace('export { courseNavigation, seriesPage };', 'globalThis.view = courseNavigation;'),
    context,
  );
  return context.view(
    {
      course,
      copy,
      groups: [
        {
          title: '教材',
          lessons: [
            {
              id: 'motor',
              nav: 'motorNav',
              number: 1,
              title: 'モーター',
              summary: '教材の説明',
              runModes: { modes: ['sim'] },
            },
          ],
        },
      ],
    },
    { followCourseLink() {}, followRecordsLink: handler },
  );
}

test('records is the final, separate link, with its description from content and selected frame', () => {
  for (const course of ['series', 'motor', 'records']) {
    const markup = text(navigation(course, () => {}));
    assert.match(markup, /class="course-nav-records"\s+href="#records"/);
    assert.match(
      markup.slice(markup.indexOf('course-nav-records')),
      new RegExp(`aria-current=${course === 'records' ? 'page' : 'false'}\\s`),
    );
    assert(markup.includes(copy.header.recordsTitle));
    assert(markup.includes(copy.header.recordsDescription));
    assert(markup.indexOf('course-nav-records') > markup.lastIndexOf('</section>'));
  }
  const css = read('css/navigation.css');
  assert.match(
    css,
    /\.series-nav a\[aria-current='page'\],\s*body .*\.course-nav-records\[aria-current='page'\]/,
  );
  assert.match(css, /a\.course-nav-records\s*\{[^}]*flex-direction: row/s);
});

test('the real records click action closes the list and uses the existing records route', () => {
  const source = read('js/shell/series.js');
  for (const start of ['series', 'motor', 'records']) {
    const switcher = { open: true },
      page = { hidden: true };
    const context = {
      course: start,
      RECORDS: 'records',
      CATALOGUE: 'series',
      RECORDS_PAGE: 'recordsPage',
      catalogueReturn: {},
      assessment: null,
      modified: (e) => e.ctrlKey || e.metaKey || e.shiftKey || e.altKey,
      $: (id) => (id === 'courseSwitcher' ? switcher : page),
      leaveCurrentPage() {},
      showMeasurementLab() {},
      showLearningResources() {},
      showLessonFooter() {},
      quizzes: { hide() {} },
      mastery: { hide() {} },
      update() {},
      activated: 0,
      activateRecords() {
        context.activated++;
      },
      hash: start === 'records' ? '#records' : '#' + start,
      pushHash(value) {
        context.hash = value;
      },
      window: { scrollTo() {} },
    };
    vm.runInNewContext(
      source.match(/function showRecords\(updateHash = true\) \{[\s\S]*?\n\}/)[0] +
        '\n' +
        source.slice(source.indexOf('const actions = {'), source.indexOf('// --- Start-up')) +
        '\nglobalThis.action = actions.followRecordsLink;',
      context,
    );
    const template = navigation(start, context.action);
    assert(template.values.includes(context.action), 'the link must bind the tested action');
    let prevented = false;
    context.action({
      preventDefault() {
        prevented = true;
      },
    });
    assert(prevented);
    assert.equal(switcher.open, false);
    assert.equal(context.course, 'records');
    assert.equal(context.hash, '#records');
    assert.equal(context.activated, start === 'records' ? 0 : 1);
    if (start !== 'records') assert.equal(page.hidden, false);
    switcher.open = true;
    context.action({
      ctrlKey: true,
      preventDefault() {
        assert.fail('modified link stays native');
      },
    });
    assert.equal(switcher.open, true);
  }
});
