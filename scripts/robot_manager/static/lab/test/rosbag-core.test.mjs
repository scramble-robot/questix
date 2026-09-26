// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// The bag reader against a bag written by rosbag2 itself (test/fixtures/make-rosbag-fixture.py),
// so the MCAP layout, the embedded message definitions and the CDR alignment are the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  readMcap,
  parseRos2msg,
  readRosbag,
  scanPayload,
  BAG_DEFAULT_CONFIG,
} from '../js/live/rosbag-core.js';
import { makeRecording, driveRows, wallRows, drivesOf } from '../js/live/recording-core.js';
import { liveControlRun, liveDistanceRun } from '../js/live/capture-core.js';

const fixture = new URL('./fixtures/drive-approach.mcap', import.meta.url);
const expected = JSON.parse(
  fs.readFileSync(new URL('./fixtures/drive-approach.expected.json', import.meta.url), 'utf8'),
);
const bytes = () => {
  const file = fs.readFileSync(fixture);
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
};
const near = (actual, wanted, tolerance, what) =>
  assert.ok(Math.abs(actual - wanted) <= tolerance, `${what}: ${actual} is not ${wanted}`);

test('every message of the bag is found, including the ones inside chunks', () => {
  const { channels, messages } = readMcap(bytes());
  assert.equal(channels.size, 7);
  const total = Object.values(expected.counts).reduce((sum, count) => sum + count, 0);
  // + one /cmd_vel per /target_twist, the single /chatter and the single /tf_static message
  assert.equal(messages.length, total + expected.counts.twist + 2);
});

test('the lesson streams come from the right topics, and /cmd_vel is not taken as the command', () => {
  const bag = readRosbag(bytes());
  assert.deepEqual(bag.topics, {
    drive: '/drive_status',
    twist: '/target_twist',
    odom: '/odom',
    scan: '/scan',
  });
  for (const [stream, count] of Object.entries(expected.counts))
    assert.equal(bag.streams[stream].length, count, stream);
  near(bag.start, expected.start, 1e-6, 'start');
});

test('messages decode to the values that were written, in the live link shape', () => {
  const { streams } = readRosbag(bytes());
  const moving = streams.drive.find((drive) => drive.v > 0);
  assert.equal(moving.left.rpm, expected.rpm);
  assert.equal(moving.right.rpm, -expected.rpm); // mirrored on the wire, as on the robot
  near(moving.left.current_amp, 0.25, 1e-3, 'current');
  assert.equal(moving.emergency_stop, false);
  near(moving.stamp - expected.start, expected.moveFrom, 1e-6, 'first moving stamp');
  const command = streams.twist.find((twist) => twist.linear > 0);
  near(command.linear, expected.speed, 1e-9, 'command');
  const last = streams.odom[streams.odom.length - 1];
  near(last.x, expected.travelled, 1e-4, 'odom x');
  assert.equal(last.theta, 0);
});

test('scans are decimated like the bridge does, and unmeasured beams are null', () => {
  const scan = readRosbag(bytes()).streams.scan[0];
  assert.equal(scan.ranges.length, expected.beams / 2);
  assert.equal(scan.frame, 'laser_frame');
  const ahead = scan.ranges[Math.round(-scan.angle_min / scan.angle_increment)];
  near(ahead, expected.wall, 1e-3, 'range straight ahead');
  assert.equal(scan.ranges[0], null); // behind the robot: inf in the bag
  // Where the LiDAR sits comes from /tf_static, as the bridge takes it from TF.
  assert.deepEqual(scan.mount, expected.mount);
});

test('the lessons read the same numbers from a bag as from a live recording', () => {
  const bag = readRosbag(bytes());
  const recording = makeRecording({
    source: 'rosbag',
    name: 'drive-approach.mcap',
    recordedAt: new Date(bag.start * 1000).toISOString(),
    config: BAG_DEFAULT_CONFIG,
    topics: bag.topics,
    streams: bag.streams,
  });
  const run = liveControlRun(driveRows(recording).rows, 16);
  near(run.samples[0].time, 0, 1e-9, 'step at t = 0');
  near(run.samples[0].target, (expected.speed / (2 * Math.PI * 0.1)) * 60, 1e-6, 'target rpm');
  const approach = liveDistanceRun(wallRows(recording), 16);
  assert.equal(approach.approached, true);
  near(approach.samples[0].measured, expected.wall, 0.01, 'approach starts at the wall distance');
  const drives = drivesOf(recording);
  assert.equal(drives.length, 1);
  near(drives[0].distance, expected.travelled, 1e-3, 'odometry distance');
});

test('files that are not an uncompressed MCAP bag with lesson topics are refused', () => {
  assert.throws(() => readRosbag(new TextEncoder().encode('{"format":1}').buffer), /MCAP/);
  assert.throws(() => readMcap(mcapWithChunk('zstd')), /圧縮/);
  assert.throws(() => readRosbag(mcapWithChunk('')), /トピック/);
});

test('ros2msg definitions: constants, defaults, bounded and fixed arrays', () => {
  const definition = parseRos2msg(
    'pkg/msg/Top',
    [
      'uint8 MODE_A=1',
      'int32 count 5 # default',
      'string<=8 short',
      'float64[3] fixed',
      'Inner[] inners',
      'int16[<=4] bounded',
      '================================================================================',
      'MSG: pkg/Inner',
      'bool flag',
    ].join('\n'),
  );
  assert.equal(definition.top, 'pkg/Top');
  assert.deepEqual(definition.types.get('pkg/Top'), [
    { name: 'count', type: 'int32' },
    { name: 'short', type: 'string' },
    { name: 'fixed', type: 'float64', length: 3 },
    { name: 'inners', type: 'pkg/Inner', length: -1 },
    { name: 'bounded', type: 'int16', length: -1 },
  ]);
  assert.deepEqual(definition.types.get('pkg/Inner'), [{ name: 'flag', type: 'bool' }]);
});

test('scanPayload keeps the angle step uniform when decimating', () => {
  const msg = {
    header: { stamp: { sec: 1, nanosec: 5e8 }, frame_id: 'laser' },
    angle_min: -1,
    angle_increment: 0.01,
    range_min: 0.1,
    range_max: 5,
    ranges: Array.from({ length: 10 }, (_, i) => (i === 2 ? 9 : 1 + i / 10)),
  };
  const scan = scanPayload(msg, 4);
  assert.equal(scan.angle_increment, 0.03);
  assert.deepEqual(scan.ranges, [1, 1.3, 1.6, 1.9]);
  assert.equal(scan.stamp, 1.5);
});

// A minimal MCAP file: magic, one chunk record with the given compression and no content.
function mcapWithChunk(compression) {
  const name = new TextEncoder().encode(compression);
  const body = new DataView(new ArrayBuffer(8 * 3 + 4 + 4 + name.length + 8));
  let at = 24 + 4;
  body.setUint32(at, name.length, true);
  new Uint8Array(body.buffer).set(name, at + 4);
  at += 4 + name.length;
  body.setBigUint64(at, 0n, true);
  const file = new Uint8Array(8 + 1 + 8 + body.byteLength);
  file.set([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a]);
  const view = new DataView(file.buffer);
  view.setUint8(8, 0x06);
  view.setBigUint64(9, BigInt(body.byteLength), true);
  file.set(new Uint8Array(body.buffer), 17);
  return file.buffer;
}

test('the SLAM course opens a rosbag as a sensor log that passes its own validation', async () => {
  const { slamLogFromFile } = await import('../js/live/slam-recorder.js');
  const { validateSlamLog } = await import('../js/slam/engine.js');
  const file = new File([fs.readFileSync(fixture)], 'drive-approach.mcap');
  const converted = await slamLogFromFile(file);
  assert.equal(converted.moved, true);
  assert.equal(converted.assumedConfig, true); // no robot connected in Node
  assert.equal(converted.log.config.radius, BAG_DEFAULT_CONFIG.wheel_radius);
  const parsed = validateSlamLog(converted.log);
  assert.equal(parsed.frames.length, expected.counts.scan - 1); // the first scan only fixes t = 0
  // Any other JSON is left to the lesson's own reader.
  assert.equal(
    await slamLogFromFile(new File(['{"format":"robo-lab-sensors-v1"}'], 'log.json')),
    null,
  );
});
