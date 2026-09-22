// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// The shell's string-returning helpers are embedded by every course module, so their output is
// pinned against the pre-cleanup modules when a baseline copy of the site is available
// (LAB_BASELINE=<dir>). Without a baseline the tests still
// check the structure of the strings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { lessonBrief, BRIEF_SECTIONS } from '../js/shell/lesson-brief.js';
import { lessonGuide, figureGuide, LESSON_GUIDES } from '../js/shell/lesson-guide.js';
import { lessonIcon } from '../js/shell/lesson-icons.js';
import {
  LESSONS,
  LESSON_GROUPS,
  lessonLabel,
  EXPERIMENT_STEPS,
  experimentSteps,
  sensorTabs,
  SENSOR_COPY,
} from '../js/shell/lesson-ui.js';
import { schoolTips, SCHOOL_TIPS, SCHOOL_GRADES } from '../js/shell/school-tips.js';
import { seriesCover } from '../js/shell/series-covers.js';

const BASELINE = process.env.LAB_BASELINE;
const baselineModule = async (name) => {
  const file = path.join(BASELINE, 'js/shell', name);
  return fs.existsSync(file) ? import(file) : null;
};

const GUIDE_KEYS = ['vision-stereo', 'slam-lidar-match', 'rl-reward', 'lab-manual', 'rl-test'];
const TIP_KEYS = [
  'arm-joints',
  'control-p',
  'planning-margin',
  'launch-power',
  'mechanics-force',
  'behavior-sequence',
];
const BRIEF_CONTENT = {
  scene: 'A & B <scene>',
  purpose: ['first "purpose"', "second 'purpose'"],
  first: 'try it',
};

test('lessonBrief renders the three sections in reading order', () => {
  const html = lessonBrief('test-key', BRIEF_CONTENT);
  assert.ok(html.startsWith('<section class="lesson-brief" data-lesson-brief="test-key"'));
  assert.deepEqual(
    BRIEF_SECTIONS.map((section) => section.key),
    ['scene', 'purpose', 'first'],
  );
  assert.ok(html.includes('<p>A &amp; B &lt;scene&gt;</p>'), 'text is escaped');
  assert.equal((html.match(/<p>/g) || []).length, 4, 'array fields become one <p> each');
});

test('lessonGuide and figureGuide are empty for unknown keys', () => {
  assert.equal(lessonGuide('no-such-key'), '');
  assert.equal(figureGuide('no-such-key'), '');
});

test('lessonGuide appends the purpose note and the school tip', () => {
  const html = lessonGuide('rl-reward', 'NOTE');
  assert.ok(html.includes('<p>NOTE</p>'));
  assert.ok(html.includes('data-school-tip="rl-reward"'));
  assert.ok(figureGuide('rl-reward').includes(LESSON_GUIDES['rl-reward'].figure));
});

test('lessonIcon knows the six cue kinds', () => {
  for (const kind of ['learn', 'action', 'observe', 'result', 'reflect', 'reference'])
    assert.ok(lessonIcon(kind).startsWith('<svg class="lesson-cue-icon"'));
  assert.equal(lessonIcon('unknown'), '');
});

test('the catalogue lists 13 courses in group order', () => {
  assert.equal(LESSONS.length, 13);
  assert.deepEqual(
    LESSONS.map((lesson) => lesson.id),
    LESSON_GROUPS.flatMap((group) => group.ids),
  );
  assert.equal(EXPERIMENT_STEPS.length, 4);
  assert.deepEqual(Object.keys(SENSOR_COPY), ['lidar', 'camera', 'imu', 'wheels']);
  assert.ok(lessonLabel('rl').includes('course-terms'));
});

test('schoolTips returns a help-dialog details block', () => {
  assert.equal(schoolTips('no-such-key'), '');
  for (const key of TIP_KEYS)
    assert.ok(
      schoolTips(key).startsWith(`<details data-help-dialog class="school-tip" data-school-tip="`),
      key,
    );
  assert.ok(SCHOOL_TIPS['mechanics-force'], 'systems topics are merged into SCHOOL_TIPS');
  assert.ok(SCHOOL_GRADES.length > 0);
});

test('seriesCover draws every course and rejects unknown ids', () => {
  for (const lesson of LESSONS)
    assert.ok(seriesCover(lesson.id, lesson.canvas).startsWith(`<svg id="${lesson.canvas}"`));
  assert.throws(() => seriesCover('nope'));
});

test(
  'string helpers match the baseline modules',
  { skip: !BASELINE || !fs.existsSync(BASELINE) },
  async () => {
    const [brief, guide, icons, ui, tips, covers] = await Promise.all(
      [
        'lesson-brief.js',
        'lesson-guide.js',
        'lesson-icons.js',
        'lesson-ui.js',
        'school-tips.js',
        'series-covers.js',
      ].map(baselineModule),
    );
    assert.equal(
      lessonBrief('test-key', BRIEF_CONTENT),
      brief.lessonBrief('test-key', BRIEF_CONTENT),
    );
    for (const key of GUIDE_KEYS) {
      assert.equal(lessonGuide(key), guide.lessonGuide(key), key);
      assert.equal(lessonGuide(key, 'NOTE'), guide.lessonGuide(key, 'NOTE'), key);
      assert.equal(figureGuide(key), guide.figureGuide(key), key);
    }
    for (const kind of ['learn', 'action', 'observe', 'result', 'reflect', 'reference', 'x'])
      assert.equal(lessonIcon(kind), icons.lessonIcon(kind), kind);
    assert.deepEqual(LESSONS, ui.LESSONS);
    assert.deepEqual(LESSON_GROUPS, ui.LESSON_GROUPS);
    assert.deepEqual(EXPERIMENT_STEPS, ui.EXPERIMENT_STEPS);
    assert.deepEqual(SENSOR_COPY, ui.SENSOR_COPY);
    for (const lesson of LESSONS) {
      assert.equal(lessonLabel(lesson.id), ui.lessonLabel(lesson.id), lesson.id);
      assert.equal(seriesCover(lesson.id), covers.seriesCover(lesson.id), lesson.id);
      assert.equal(
        seriesCover(lesson.id, lesson.canvas),
        covers.seriesCover(lesson.id, lesson.canvas),
      );
    }
    assert.equal(experimentSteps('data-lab-step'), ui.experimentSteps('data-lab-step'));
    assert.equal(sensorTabs('data-sensor'), ui.sensorTabs('data-sensor'));
    assert.deepEqual(Object.keys(SCHOOL_TIPS), Object.keys(tips.SCHOOL_TIPS));
    for (const key of Object.keys(SCHOOL_TIPS))
      assert.equal(schoolTips(key), tips.schoolTips(key), key);
    assert.deepEqual(SCHOOL_GRADES, tips.SCHOOL_GRADES);
  },
);
