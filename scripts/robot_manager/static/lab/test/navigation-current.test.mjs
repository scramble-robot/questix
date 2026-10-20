// Call the actual pure navigation renderers. The html tag serialises their templates;
// event handlers are not invoked and no browser, bridge or robot is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { CONTROL_GROUPS, CONTROL_TOPICS } from '../js/control/core.js';
import { PLAN_TOPICS } from '../js/planning/core.js';
import { LAUNCH_TOPICS } from '../js/launch/core.js';

const html = (strings, ...values) =>
  strings.reduce((text, part, index) => {
    const value = values[index];
    const show = (item) =>
      Array.isArray(item)
        ? item.map(show).join('')
        : typeof item === 'function' || item == null
          ? ''
          : String(item);
    return text + part + (index < values.length ? show(value) : '');
  }, '');
function renderer(file, name, dependencies = {}) {
  const source = fs.readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8');
  const body = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))?.[0];
  assert(body, `${file}: ${name} exists`);
  return vm.runInNewContext(`(${body})`, { html, nothing: '', ...dependencies });
}
const actions = new Proxy({}, { get: () => () => {} });
function check(render, models, attribute, selected) {
  const active = [];
  for (const [index, model] of models.entries()) {
    const markup = render(model);
    const buttons = [...markup.matchAll(/<button\b([^>]+)>/g)].map((match) => match[1]);
    assert(buttons.length > 1);
    const current = buttons.filter((attrs) => /aria-current=(?:"true"|true)(?:\s|$)/.test(attrs));
    assert.equal(current.length, 1, `state ${index}: one current item per navigation`);
    const id = current[0].match(new RegExp(`${attribute}=(?:"([^" ]+)"|([^\\s>]+))`));
    assert(id);
    active.push(id[1] ?? id[2]);
    assert.equal(active.at(-1), String(selected[index]));
    for (const attrs of buttons) {
      const value = attrs.match(/aria-current=("[^" ]+"|[^\s>]+)/)?.[1];
      assert(['true', 'false', '"true"', '"false"'].includes(value));
    }
  }
  assert.equal(new Set(active).size, models.length, 'the current item moves with the selection');
}
const topics = [
  { id: 'first', title: 'First', label: 'First' },
  { id: 'second', title: 'Second', label: 'Second' },
];
const model = {
  group: 0,
  topic: 'first',
  chapter: 'first',
  groups: ['A', 'B'],
  groupTopics: topics,
  groupChapters: topics,
  busy: false,
};
for (const [file, groupName, topicName, groupAttribute, topicAttribute] of [
  ['slam/basics-view.js', 'groupNav', 'topicNav', 'data-slam-basics-group', 'data-basics-topic'],
  ['vision/view.js', 'groupNav', 'chapterNav', 'data-vision-group', 'data-vision-chapter'],
  ['rl/foundations-view.js', 'groupsNav', 'topicsNav', 'data-rl-group', 'data-rl-topic'],
]) {
  test(`${file}: group current item moves`, () => {
    const fn = renderer(file, groupName);
    check(
      (m) => (file.startsWith('rl/') ? fn(m, { groups: model.groups }, actions) : fn(m, actions)),
      [model, { ...model, group: 1 }],
      groupAttribute,
      [0, 1],
    );
  });
  test(`${file}: topic current item moves`, () => {
    const fn = renderer(file, topicName);
    check(
      (m) => fn(m, actions),
      [model, { ...model, topic: 'second', chapter: 'second' }],
      topicAttribute,
      ['first', 'second'],
    );
  });
}
test('control: group current item moves', () => {
  const fn = renderer('control/view.js', 'groupNav', { CONTROL_GROUPS });
  check(
    (m) => fn(m, actions),
    [{ topic: { group: 0 } }, { topic: { group: 1 } }],
    'data-control-group',
    [0, 1],
  );
});
test('control: topic current item moves', () => {
  const fn = renderer('control/view.js', 'topicNav', { CONTROL_TOPICS });
  const siblings = CONTROL_TOPICS.filter((topic) => topic.group === CONTROL_TOPICS[0].group);
  const models = siblings.map((topic) => ({ topic, topicId: topic.id, doneTopics: [] }));
  check(
    (m) => fn(m, { nav: { done: 'done' } }, actions),
    models,
    'data-control-topic',
    siblings.map((topic) => topic.id),
  );
});
for (const [file, name, constant, entries, attr] of [
  ['planning/view.js', 'topicNav', 'PLAN_TOPICS', PLAN_TOPICS, 'data-planning-topic'],
  ['launch/view.js', 'topicNav', 'LAUNCH_TOPICS', LAUNCH_TOPICS, 'data-launch-topic'],
]) {
  test(`${file}: topic current item moves`, () => {
    const fn = renderer(file, name, { [constant]: entries });
    check(
      (m) => fn(m, actions),
      entries.map((topic) => ({ topic: topic.id })),
      attr,
      entries.map((topic) => topic.id),
    );
  });
}
test('motor: topic current item moves', () => {
  const fn = renderer('motor/view.js', 'topicNav');
  const copy = {
    page: { topicNavLabel: 'Topics' },
    topics: Object.fromEntries(topics.map((topic) => [topic.id, topic])),
  };
  const base = { ...model, groupTopics: topics.map((topic) => topic.id) };
  check((m) => fn(m, copy, actions), [base, { ...base, topic: 'second' }], 'data-motor-topic', [
    'first',
    'second',
  ]);
});
test('SLAM: all four mode tabs have one current item as the selection moves', () => {
  const fn = renderer('slam/view.js', 'pageHeading', {
    lessonLabel: () => 'SLAM',
    unsafeHTML: (text) => text,
    heading: () => 'Heading',
  });
  const models = [
    { view: 'basics' },
    { view: 'experiment', real: false },
    { view: 'experiment', real: true },
    { view: 'usb' },
  ];
  check((m) => fn(m, { usbTab: 'USB' }, actions), models, 'id', [
    'slamBasicsTab',
    'slamSimTab',
    'slamRealTab',
    'slamUsbTab',
  ]);
});
