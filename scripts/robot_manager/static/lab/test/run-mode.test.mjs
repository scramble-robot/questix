// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// The simulation / robot labels (content/shell/run-modes.json) promise a learner whether an
// experiment needs the robot, so the declarations must agree with each other and with the courses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  RUN_MODES,
  RUN_MODE_COPY,
  courseRunModes,
  topicRunModes,
  runModeStripHtml,
} from '../js/shell/run-mode.js';
import { LESSONS } from '../js/shell/lesson-ui.js';
import { lessonBrief } from '../js/shell/lesson-brief.js';

const readJson = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
const ROBOT_MODES = ['live', 'drive', 'data'];

// Lesson keys the courses build: "<course>-<topic id>".
const topicIds = (path) => Object.keys(readJson(path).topics);
const KNOWN_KEYS = new Set([
  ...topicIds('../content/launch.json').map((id) => 'launch-' + id),
  ...topicIds('../content/arm.json').map((id) => 'arm-' + id),
  ...topicIds('../content/planning.json').map((id) => 'planning-' + id),
  ...Object.keys(readJson('../content/lesson-guides.json')),
  ...LESSONS.map((lesson) => lesson.id),
]);

test('every course has labels, and only known ones', () => {
  for (const lesson of LESSONS) {
    const entry = courseRunModes(lesson.id);
    assert.ok(entry, lesson.id);
    assert.ok(entry.modes.length > 0, lesson.id);
    for (const mode of entry.modes) assert.ok(RUN_MODES[mode], `${lesson.id}: ${mode}`);
    // Every course can be started without the robot.
    assert.ok(entry.modes.includes('sim'), lesson.id);
  }
  assert.deepEqual(
    Object.keys(RUN_MODE_COPY.courses).sort(),
    LESSONS.map((lesson) => lesson.id).sort(),
  );
});

test('a course that uses the robot says what the robot adds', () => {
  for (const lesson of LESSONS) {
    const { modes, real } = courseRunModes(lesson.id);
    const usesRobot = modes.some((mode) => ROBOT_MODES.includes(mode));
    assert.equal(Boolean(real), usesRobot, lesson.id);
  }
});

test('topic labels stay within their course and name real topics', () => {
  for (const entry of RUN_MODE_COPY.topics) {
    assert.ok(entry.note, entry.keys.join());
    for (const key of entry.keys) {
      assert.ok(KNOWN_KEYS.has(key), `unknown lesson key ${key}`);
      const course = courseRunModes(key.split('-')[0]);
      for (const mode of entry.modes)
        assert.ok(course.modes.includes(mode), `${key}: ${mode} not declared for the course`);
    }
  }
});

test('a course that uses the robot has at least one topic that does', () => {
  for (const lesson of LESSONS) {
    const robotModes = courseRunModes(lesson.id).modes.filter((mode) => ROBOT_MODES.includes(mode));
    for (const mode of robotModes) {
      const topic = RUN_MODE_COPY.topics.find(
        (entry) =>
          entry.modes.includes(mode) &&
          entry.keys.some((key) => key === lesson.id || key.startsWith(lesson.id + '-')),
      );
      assert.ok(topic, `${lesson.id}: no topic uses ${mode}`);
    }
  }
});

test('topicRunModes matches exact keys, whole courses and falls back to the simulation', () => {
  assert.deepEqual(topicRunModes('control-p').modes, ['sim', 'live', 'drive']);
  assert.deepEqual(topicRunModes('launch-measure').modes, ['data']);
  assert.deepEqual(topicRunModes('launch-power').modes, ['sim']);
  assert.deepEqual(topicRunModes('lab-setup').modes, ['sim']);
  assert.equal(topicRunModes('controlling-x'), null);
  assert.equal(topicRunModes('test-key'), null);
});

test('the brief of an experiment starts with its labels', () => {
  const content = { scene: 's', purpose: 'p', first: 'f' };
  const html = lessonBrief('control-p', content);
  assert.ok(html.includes('class="run-mode-strip" data-run-mode="sim live drive"'));
  assert.ok(html.indexOf('run-mode-strip') < html.indexOf('lesson-brief-scene'));
  assert.ok(html.includes('data-run-mode-target=".control-live"'));
  assert.ok(!lessonBrief('launch-power', content).includes('data-run-mode-target'));
  assert.equal(runModeStripHtml('test-key'), '');
});
