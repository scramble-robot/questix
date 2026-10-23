// Like html-chart.test.mjs, read the pure lit template values without a DOM renderer.
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.document ??= {
  createComment: () => ({}),
  createTreeWalker: () => ({}),
  createElement: () => ({}),
  importNode: () => ({}),
};
const {
  driveReportView,
  reportCopy: copy,
  REPORT_METRICS,
} = await import('../js/live/drive-report-view.js');
const { driveReport } = await import('../js/live/drive-report-core.js');

function templates(value, marker, found = []) {
  if (Array.isArray(value)) value.forEach((item) => templates(item, marker, found));
  else if (value && Array.isArray(value.strings) && Array.isArray(value.values)) {
    if (value.strings.join('').includes(marker)) found.push(value);
    value.values.forEach((item) => templates(item, marker, found));
  }
  return found;
}

function plain(value) {
  if (Array.isArray(value)) return value.map(plain).join('');
  if (value?.strings) return value.values.map(plain).join('');
  return typeof value === 'string' ? value : '';
}

function summaryRows(summary, options) {
  const report = driveReport({ config: {}, streams: {} });
  const run = {
    id: 1,
    at: '2026-10-22T00:00:00Z',
    lesson: 'test',
    reason: 'recorded',
    report: { ...report, summary: { ...report.summary, ...summary } },
  };
  return templates(driveReportView(run, options), '<dt>').map((row) => row.values.map(plain));
}

for (const [reason, expected] of [
  ['noMotion', '動かす指令はありませんでした'],
  ['noZero', '速さ0の指令の前に記録が終わりました'],
  ['notStill', '記録の終わりまでに止まりきっていません'],
]) {
  test(`the full and compact report explain ${reason} in the stop row`, () => {
    const summary = { stop: null, stopReason: reason };
    for (const compact of [false, true]) {
      const rows = summaryRows(summary, { compact });
      assert.deepEqual(
        rows.find(([term]) => term === copy.stop),
        [copy.stop, expected],
      );
      assert.deepEqual(
        rows.map(([term]) => term),
        [
          copy.duration,
          copy.distance,
          copy.ended,
          ...(!compact ? [copy.turn] : []),
          copy.maxSpeed,
          ...(!compact ? [copy.maxTurnRate] : []),
          copy.stop,
        ],
      );
    }
    // A lesson may choose its own metrics and order, including a no-motion stop row.
    assert.deepEqual(summaryRows(summary, { compact: true, metrics: ['stop', 'distance'] }), [
      [copy.stop, expected],
      [copy.distance, '0.0 cm'],
    ]);
  });
}

test('legacy summaries only infer no motion from an explicitly null drive time', () => {
  for (const [driveSeconds, expected] of [
    [null, '動かす指令はありませんでした'],
    [2, '記録からは求められません'],
    [undefined, '記録からは求められません'],
  ]) {
    const rows = summaryRows({ stop: null, stopReason: undefined, driveSeconds });
    assert.deepEqual(
      rows.find(([term]) => term === copy.stop),
      [copy.stop, expected],
    );
  }
});

test('a measured stopping time keeps its numeric wording, including in legacy summaries', () => {
  for (const stopReason of [null, undefined]) {
    const rows = summaryRows({ stop: { at: 1, delay: 0.25, distance: 0.03 }, stopReason });
    assert.deepEqual(
      rows.find(([term]) => term === copy.stop),
      [copy.stop, '0.25秒・3.0 cm'],
    );
  }
  assert.deepEqual(REPORT_METRICS, [
    'driveTime',
    'duration',
    'distance',
    'ended',
    'turn',
    'maxSpeed',
    'maxTurnRate',
    'stop',
    'closest',
  ]);
});
