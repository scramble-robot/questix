import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMeasurementCSV,
  measurementFileProblem,
  measurementPlotAxes,
  shortFileName,
  clockTime,
  recordingSourceLabel,
} from '../js/systems/measurement-core.js';
import { fillSentence } from '../js/core/content.js';

test('a measurement CSV is not reported as a file problem', () => {
  assert.equal(measurementFileProblem('x,y,test\n20,28,0\n40,52,1\n'), null);
  assert.equal(measurementFileProblem('﻿# 2班\n20,28\n'), null);
  assert.equal(parseMeasurementCSV('x,y,test\n20,28,0\n40,52,1\n').length, 2);
  assert.deepEqual(parseMeasurementCSV('x, y\n20,28\n'), [{ x: 20, y: 28, test: false }]);
});

test("the site's own recording CSV is recognised, with or without the BOM", () => {
  const header =
    'time_s,stream,stamp_s,v_mps,w_radps,left_rpm,right_rpm,left_current_a,right_current_a';
  assert.equal(measurementFileProblem(`﻿${header}\n0.000,twist,999.0,,,,,,\n`), 'recording');
  assert.equal(measurementFileProblem(`${header}\r\n`), 'recording');
  // A comment line before the header (conditions) does not hide it.
  assert.equal(measurementFileProblem(`# 0.20 m/s\n${header}\n`), 'recording');
});

test('a table with more than three columns is named as such', () => {
  assert.equal(measurementFileProblem('時間（秒）,指令,実測,距離\n0,0,0,0\n'), 'wide');
});

test('JSON and binary files are recognised before they are parsed as CSV', () => {
  assert.equal(measurementFileProblem('{"format":"questix-lab-recording"}'), 'json');
  assert.equal(measurementFileProblem('﻿  [1, 2]'), 'json');
  assert.equal(measurementFileProblem('�MCAP0\r\n\u0001\u0000\u0000\u0000'), 'binary');
});

test('plot axes have round ticks covering every point, zero included', () => {
  const rows = [
    { x: 28.6, y: 28.2 },
    { x: 0, y: 0.3 },
    { x: 57.2, y: 56.9 },
  ];
  const axes = measurementPlotAxes(rows, 0, 352);
  assert.equal(axes.narrow, true);
  assert.equal(axes.width, 352);
  for (const scale of [axes.x, axes.y]) {
    assert.ok(scale.ticks.includes(0));
    assert.ok(scale.min <= 0 && scale.max >= 57.2);
  }
  // Values land inside the plot box.
  for (const row of rows) {
    assert.ok(axes.toX(row.x) >= axes.box.left && axes.toX(row.x) <= axes.box.right);
    assert.ok(axes.toY(row.y) >= axes.box.top && axes.toY(row.y) <= axes.box.bottom);
  }
});

test('plot axes follow the width: more ticks on a wide screen, a minimum when unmeasured', () => {
  const rows = [
    { x: 0, y: 0 },
    { x: 100, y: 103 },
  ];
  const narrow = measurementPlotAxes(rows, 0, 352);
  const wide = measurementPlotAxes(rows, 0, 790);
  assert.equal(wide.narrow, false);
  assert.ok(wide.height > narrow.height);
  assert.ok(wide.x.ticks.length >= narrow.x.ticks.length);
  assert.ok(measurementPlotAxes(rows, 0, 0).width >= 280);
});

test('the calibration correction moves the y axis with the points', () => {
  const rows = [{ x: 10, y: 50 }];
  assert.ok(measurementPlotAxes(rows, 30, 600).y.max >= 80);
});

test('file names are shortened for the table: no prefix, the stamp as a time', () => {
  assert.equal(
    shortFileName('QUESTiX-LAB-control-speed-20260925-101500.json'),
    'control-speed 10:15:00',
  );
  assert.equal(shortFileName('班2の記録.csv'), '班2の記録');
  const long = shortFileName('QUESTiX-LAB-control-speed-questix01-0.20mps-20260925-105610.json');
  assert.ok(long.length <= 24);
  assert.ok(long.endsWith('10:56:10'));
  assert.ok(long.includes('…'));
});

test('clock time is HH:MM:SS, empty when unreadable', () => {
  const date = new Date(2026, 8, 25, 9, 5, 7);
  assert.equal(clockTime(date.toISOString()), '09:05:07');
  assert.equal(clockTime('not a date'), '');
  assert.equal(clockTime(undefined), '');
});

test('a recording is named by its group, then its file, then 実機 and the time', () => {
  const texts = { group: '{group} {time}', live: '実機 {time}' };
  const recordedAt = new Date(2026, 8, 25, 10, 51, 2).toISOString();
  const label = (recording) => recordingSourceLabel(recording, texts, fillSentence);
  assert.equal(label({ recordedAt, group: '2班', name: 'a.json' }), '2班 10:51:02');
  assert.equal(
    label({ recordedAt, group: '  ', name: 'QUESTiX-LAB-x-20260925-105102.json' }),
    'x 10:51:02',
  );
  assert.equal(label({ recordedAt, name: '' }), '実機 10:51:02');
  // Older files and odd values fall back without throwing.
  assert.equal(label({ name: '' }), '実機');
  assert.equal(label({ group: 3, name: 'b.json' }), 'b');
});
