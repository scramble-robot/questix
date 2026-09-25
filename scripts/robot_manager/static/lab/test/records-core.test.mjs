// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// Records kept on the robot (js/live/records-core.js): where the bridge's API is, what the learner
// is told when a request fails or takes too long, how the lists are cleaned and filtered, which
// lessons can open an entry, and the time window of a rosbag. `fetch` is a fake.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  recordsBaseUrl,
  recordsClient,
  recordsCopy,
  normalizeEntry,
  normalizeBag,
  bagWindow,
  defaultBagWindow,
  filterEntries,
  filterChoices,
  targetsFor,
  outcomeWord,
  outcomeKind,
  localEntry,
  runsNotOnRobot,
  onlyOnThisDevice,
  newestFirst,
  describeEntry,
  lessonKey,
  megabytes,
  BAG_MAX_SECONDS,
  LIST_TIMEOUT_MS,
} from '../js/live/records-core.js';
import { makeRecording, serializeRecording } from '../js/live/recording-core.js';

const RECORDING = makeRecording({
  source: 'live',
  name: '',
  recordedAt: '2026-09-25T01:30:00Z',
  config: { wheel_radius: 0.1, wheel_separation: 0.5 },
  topics: { drive: '/drive_status' },
  streams: {
    drive: [{ type: 'drive', stamp: 1, v: 0, w: 0 }],
    twist: [{ type: 'twist', stamp: 1, linear: 0, angular: 0 }],
  },
  lesson: 'control-speed',
});

const entry = (fields) =>
  normalizeEntry({
    id: 'r1',
    source: 'lab',
    lesson: 'control-speed',
    label: '0.20 m/s',
    group: '3班',
    robot: 'questix-03',
    recordedAt: '2026-09-25T01:30:00Z',
    seconds: 6.2,
    outcome: { reason: 'done', label: '予定どおり走り終えた' },
    bytes: 120000,
    ...fields,
  });

// A fetch that answers `routes[path]` = {status, body} and records what was asked.
function fakeFetch(routes) {
  const asked = [];
  const fetchImpl = async (url, { signal } = {}) => {
    asked.push(url);
    const path = new URL(url).pathname + new URL(url).search;
    const route = routes[path] ?? routes[new URL(url).pathname];
    if (route === 'hang')
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
    if (route === 'down') throw new TypeError('Failed to fetch');
    const { status = 200, body } = route ?? { status: 404, body: '' };
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
  return { fetchImpl, asked };
}

test('the API is on the WebSocket host and port, or the page itself when the bridge served it', () => {
  assert.equal(recordsBaseUrl('ws://10.42.0.1:8897', null), 'http://10.42.0.1:8897');
  assert.equal(recordsBaseUrl('wss://robot.local:8897', null), 'https://robot.local:8897');
  // Robot Manager's /lab on another port still asks the bridge.
  const manager = { host: '10.42.0.1:8888', protocol: 'http:', origin: 'http://10.42.0.1:8888' };
  assert.equal(recordsBaseUrl('ws://10.42.0.1:8897', manager), 'http://10.42.0.1:8897');
  const bridge = { host: '10.42.0.1:8897', protocol: 'http:', origin: 'http://10.42.0.1:8897' };
  assert.equal(recordsBaseUrl('ws://10.42.0.1:8897', bridge), 'http://10.42.0.1:8897');
  assert.equal(recordsBaseUrl('', null), '');
  assert.equal(recordsBaseUrl('http://10.42.0.1:8897', null), '');
});

test('the list is cleaned: bad ids are dropped, unknown fields fall back', async () => {
  const { fetchImpl, asked } = fakeFetch({
    '/api/records': {
      body: {
        records: [
          { id: 'ok-1', source: 'auto', label: 'コントローラーで走行', seconds: 12 },
          { id: '../etc/passwd', source: 'lab' },
          { id: 'ok-2', source: 'strange', robot: { name: 'questix-03', domain: 3 } },
        ],
        quota: { used_bytes: 1048576, limit_bytes: 524288000 },
        save: true,
      },
    },
  });
  const list = await recordsClient('http://robot:8897', { fetchImpl }).list();
  assert.deepEqual(asked, ['http://robot:8897/api/records']);
  assert.deepEqual(
    list.records.map((item) => item.id),
    ['ok-1', 'ok-2'],
  );
  assert.equal(list.records[1].source, 'lab');
  assert.equal(list.records[1].robot, 'questix-03');
  assert.equal(list.records[0].lesson, null);
  assert.deepEqual(list.quota, { used: 1048576, limit: 524288000 });
  assert.equal(list.save, true);
});

test('a record comes back as a recording; a missing one says it is gone', async () => {
  const { fetchImpl } = fakeFetch({
    '/api/records/r1': { body: serializeRecording(RECORDING) },
  });
  const client = recordsClient('http://robot:8897', { fetchImpl });
  const recording = await client.recording('r1');
  assert.equal(recording.lesson, 'control-speed');
  assert.equal(recording.streams.drive.length, 1);
  await assert.rejects(client.recording('r2'), { message: recordsCopy.errors.gone });
  await assert.rejects(client.recording('../x'), { message: recordsCopy.errors.badId });
});

test("the bridge's own error sentence is shown; other failures get the learner's words", async () => {
  const { fetchImpl } = fakeFetch({
    '/api/rosbags/bag%201/recording?start=0&seconds=10': {
      status: 500,
      body: { error: 'この録画は読み取れませんでした。' },
    },
    '/api/records': { status: 404, body: 'Not Found' },
    '/api/rosbags': 'down',
  });
  const client = recordsClient('http://robot:8897', { fetchImpl });
  await assert.rejects(client.convert('bag 1', { start: 0, seconds: 10 }), {
    message: 'この録画は読み取れませんでした。',
  });
  await assert.rejects(client.list(), { message: recordsCopy.errors.oldBridge });
  await assert.rejects(client.bags(), { message: recordsCopy.errors.network });
});

test('no answer within the time limit is reported in seconds; a cancel is a cancel', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { fetchImpl } = fakeFetch({ '/api/records': 'hang' });
    const client = recordsClient('http://robot:8897', { fetchImpl });
    const listed = client.list();
    mock.timers.tick(LIST_TIMEOUT_MS);
    await assert.rejects(listed, { message: /8秒たっても返事がありませんでした/ });
    const cancel = new AbortController();
    const cancelled = client.list(cancel.signal);
    cancel.abort();
    await assert.rejects(cancelled, { message: recordsCopy.errors.cancelled });
  } finally {
    mock.timers.reset();
  }
});

test('rosbags: names that could leave the directory are dropped, streams read from topics', () => {
  assert.equal(normalizeBag({ name: '../secret' }), null);
  assert.equal(normalizeBag({ name: '.hidden' }), null);
  const bag = normalizeBag({
    name: 'rosbag2_2026_09_25-10_30_00',
    seconds: 612.4,
    topics: ['/drive_status', '/robot1/odom', '/camera/image_raw', 7],
    usable: true,
  });
  assert.deepEqual(bag.streams, ['drive', 'odom']);
  assert.deepEqual(bag.topics, ['/drive_status', '/robot1/odom', '/camera/image_raw']);
});

test("a bag's time window stays inside the bag and within the conversion limit", () => {
  const bag = normalizeBag({ name: 'b', seconds: 120 });
  assert.deepEqual(defaultBagWindow(bag), { start: 0, seconds: 120 });
  assert.deepEqual(defaultBagWindow(normalizeBag({ name: 'b', seconds: 900 })), {
    start: 0,
    seconds: BAG_MAX_SECONDS,
  });
  assert.deepEqual(bagWindow(bag, '100', '60'), { start: 100, seconds: 20 });
  assert.deepEqual(bagWindow(bag, 500, 30), { start: 119, seconds: 1 });
  assert.match(bagWindow(bag, 0, 301).error, /300秒まで/);
  assert.equal(bagWindow(bag, -1, 10).error, recordsCopy.bag.badNumber);
  assert.equal(bagWindow(bag, 'abc', 10).error, recordsCopy.bag.badNumber);
});

test('filters: lesson, group, only my group, and controller drives on or off', () => {
  const entries = [
    entry({ id: 'a' }),
    entry({ id: 'b', group: '1班', lesson: 'control-distance' }),
    entry({ id: 'c', source: 'auto', lesson: 'free-drive', group: null }),
    entry({ id: 'd', source: 'rosbag-cache', lesson: null, group: null }),
  ];
  const ids = (list) => list.map((item) => item.id);
  assert.deepEqual(ids(filterEntries(entries, {})), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(filterEntries(entries, { controller: false })), ['a', 'b', 'd']);
  assert.deepEqual(ids(filterEntries(entries, { lesson: 'free-drive' })), ['c']);
  assert.deepEqual(ids(filterEntries(entries, { lesson: 'rosbag' })), ['d']);
  assert.deepEqual(ids(filterEntries(entries, { group: '1班' })), ['b']);
  assert.deepEqual(ids(filterEntries(entries, { mine: true }, '3班')), ['a']);
  // Without a group typed on this device, "only mine" shows nothing rather than everything.
  assert.deepEqual(ids(filterEntries(entries, { mine: true }, '')), []);
  assert.deepEqual(filterChoices(entries), {
    lessons: ['control-speed', 'control-distance', 'free-drive', 'rosbag'],
    groups: ['1班', '3班'],
  });
});

test('a lesson record opens in its lesson; free drives, bags and unknown ones where they fit', () => {
  const ids = (list) => list.map((target) => target.id);
  assert.deepEqual(ids(targetsFor(entry({}))), ['control-speed']);
  assert.deepEqual(ids(targetsFor(entry({ lesson: 'measurement-slam' }))), ['measurement-slam']);
  const free = entry({ source: 'auto', lesson: 'free-drive' });
  assert.deepEqual(ids(targetsFor(free)), [
    'control-speed',
    'control-distance',
    'measurement-control',
    'measurement-slam',
    'slam',
    'planning-room',
    'motor-bench',
  ]);
  // A bag with only the wheels and the command: the lessons that need the LiDAR are left out.
  const bag = entry({ source: 'rosbag-cache', lesson: null });
  assert.deepEqual(ids(targetsFor(bag, ['drive', 'twist'])), [
    'control-speed',
    'measurement-control',
    'motor-bench',
  ]);
  assert.equal(lessonKey(entry({ lesson: 'something-new' })), 'unknown');
  assert.ok(targetsFor(entry({ lesson: 'something-new' })).length > 0);
  // A lesson that takes no recording (e.g. the bench test's own lesson) opens anywhere it fits.
  assert.ok(targetsFor(entry({ lesson: 'bench' })).some((target) => target.id === 'slam'));
});

test('the outcome word says who drove and how it ended', () => {
  const status = recordsCopy.outcomes;
  assert.equal(outcomeWord(entry({})), '予定どおり走り終えた');
  assert.equal(outcomeKind(entry({})), 'ok');
  assert.equal(outcomeWord(entry({ outcome: null })), status.recorded);
  assert.equal(outcomeKind(entry({ outcome: null })), 'none');
  assert.equal(outcomeWord(entry({ source: 'auto' })), status.controller);
  assert.equal(outcomeWord(entry({ source: 'rosbag-cache' })), status.rosbag);
  assert.equal(outcomeKind(entry({ outcome: { reason: 'emergency_stop' } })), 'problem');
  assert.equal(outcomeKind(entry({ outcome: { reason: 'controller' } })), 'stopped');
});

test('a run of this browser reads like a robot entry', () => {
  const run = {
    id: 4,
    slot: 'bench',
    at: '2026-09-25T01:30:00Z',
    group: '',
    robot: 'questix-03',
    reason: 'recorded',
    report: { summary: { seconds: 3.25 } },
  };
  const local = localEntry(run);
  assert.equal(local.source, 'local');
  assert.equal(local.group, null);
  assert.equal(local.seconds, 3.25);
  const described = describeEntry(local);
  assert.equal(described.label, recordsCopy.lessons.bench);
  assert.equal(described.outcome, recordsCopy.outcomes.recorded);
  assert.equal(described.outcomeKind, 'none');
});

test('記録の一覧 lists each run once: this device only adds what the robot does not hold', () => {
  const runs = [
    { id: 1, robotId: 'r-1' }, // kept on the robot
    { id: 2, robotId: '' }, // saving failed or was off
    { id: 3, robotId: 'r-gone' }, // kept, then removed from the robot
    { id: 4, source: 'file' }, // a file opened here
  ];
  const robot = new Set(['r-1', 'r-2']);
  assert.deepEqual(
    runsNotOnRobot(runs, robot).map((run) => run.id),
    [2, 3, 4],
  );
  assert.deepEqual(
    runs.filter((run) => onlyOnThisDevice(run, robot)).map((run) => run.id),
    [2, 3, 4],
  );
  // Offline (the robot's list unknown): every run of this device, and only the ones never kept
  // on a robot carry 「この端末だけ」.
  assert.equal(runsNotOnRobot(runs, null).length, 4);
  assert.deepEqual(
    runs.filter((run) => onlyOnThisDevice(run, null)).map((run) => run.id),
    [2, 4],
  );
});

test('the merged list is newest first, undated entries last', () => {
  const item = (id, recordedAt) => ({ id, entry: { recordedAt } });
  const sorted = newestFirst([
    item('old', '2026-09-25T01:00:00Z'),
    item('none', ''),
    item('new', '2026-09-26T01:00:00Z'),
  ]);
  assert.deepEqual(
    sorted.map((entry) => entry.id),
    ['new', 'old', 'none'],
  );
});

test('sizes are written in megabytes, never as 0.0 for a small file', () => {
  assert.equal(megabytes(0), '0');
  assert.equal(megabytes(2000), '0.1');
  assert.equal(megabytes(5 * 1024 * 1024), '5.0');
});
