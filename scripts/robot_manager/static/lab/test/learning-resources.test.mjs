// Run with: node --test test/*.test.mjs
//
// The curated reading list of every course (content/shell/learning-resources.json, shown by
// js/shell/learning-resources.js): each entry is complete, links over https to a checked page, and
// belongs to a course that exists (or to the motor course, whose entries wait for that course).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { LESSONS } from '../js/shell/lesson-ui.js';
import {
  RESOURCE_KINDS,
  courseResources,
  japaneseDate,
  siteOf,
} from '../js/shell/learning-resources-core.js';

const data = JSON.parse(
  await readFile(new URL('../content/shell/learning-resources.json', import.meta.url), 'utf8'),
);

const REQUIRED_TEXT = ['title', 'publisher', 'level', 'description', 'start'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Lists waiting for a course that is not on the site yet.
const PENDING_COURSES = ['motor'];
const courseIds = LESSONS.map((lesson) => lesson.id);

const entries = () =>
  Object.entries(data.courses).flatMap(([course, entry]) =>
    entry.resources.map((resource) => ({ course, resource })),
  );

test('every list belongs to a course of the site, or to the motor course', () => {
  for (const course of Object.keys(data.courses))
    assert.ok(
      courseIds.includes(course) || PENDING_COURSES.includes(course),
      `unknown course ${course}`,
    );
});

test('every course of the site has a reading list', () => {
  for (const course of courseIds) assert.ok(courseResources(data, course), course);
  assert.equal(courseResources(data, 'series'), null, 'the catalogue has none');
});

test('every resource has its texts, a known kind and an https url', () => {
  for (const { course, resource } of entries()) {
    const where = `${course}: ${resource.title}`;
    for (const field of REQUIRED_TEXT)
      assert.ok(typeof resource[field] === 'string' && resource[field].trim(), `${where} ${field}`);
    assert.ok(RESOURCE_KINDS.includes(resource.kind), `${where} kind ${resource.kind}`);
    assert.ok(data.copy.kinds[resource.kind], `${where}: no label for ${resource.kind}`);
    const url = new URL(resource.url);
    assert.equal(url.protocol, 'https:', where);
    assert.ok(url.hostname.includes('.'), where);
  }
});

test('every url was checked, and the list says when', () => {
  assert.match(data.checkedOn, ISO_DATE);
  for (const { course, resource } of entries()) {
    const where = `${course}: ${resource.url}`;
    assert.match(resource.checkedOn, ISO_DATE, where);
    assert.ok(resource.checkedOn <= data.checkedOn, where);
    assert.match(resource.checkResult, /^(HEAD|GET) [23]\d\d\b/, where);
  }
  for (const [course, entry] of Object.entries(data.courses))
    assert.match(entry.reviewedOn, ISO_DATE, course);
});

test('a course does not list the same page twice', () => {
  for (const [course, entry] of Object.entries(data.courses)) {
    const urls = entry.resources.map((resource) => resource.url);
    assert.equal(new Set(urls).size, urls.length, course);
  }
});

test('the card data: the site of each link and the dates in Japanese', () => {
  const control = courseResources(data, 'control');
  assert.equal(control.resources[0].site, 'jp.mathworks.com');
  assert.equal(control.reviewedOn, '2026-09-22');
  assert.equal(control.checkedOn, data.checkedOn);
  assert.equal(japaneseDate('2026-09-05'), '2026年9月5日');
  assert.equal(siteOf('https://www.try-it.jp/chapters-2190/'), 'www.try-it.jp');
});

test('the sentences of the card are in the content file', () => {
  for (const key of ['summary', 'count', 'action', 'intro', 'caption', 'start', 'newTab'])
    assert.ok(data.copy[key], key);
  assert.ok(data.copy.count.includes('{count}') && data.copy.caption.includes('{course}'));
});
