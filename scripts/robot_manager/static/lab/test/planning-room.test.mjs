// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ROOM_CELL, ROOM_SIZE, scanPoints, measuredRoom } from '../js/planning/room-core.js';
import { planRoute, planningExperiment, planningDefaults } from '../js/planning/core.js';
import { readRosbag, BAG_DEFAULT_CONFIG } from '../js/live/rosbag-core.js';
import { makeRecording, pairByStamp } from '../js/live/recording-core.js';

const BEAMS = 360;

// A scan taken at `pose` inside a 5 m × 3 m room whose walls are x = -1…4, y = -1.5…1.5 (odometry
// frame), with a 0.4 m square box centred at (1.5, -0.6). The LiDAR sits at the centre (mount 0).
function roomScan(pose, stamp) {
  const box = { x0: 1.3, x1: 1.7, y0: -0.8, y1: -0.4 };
  const walls = { x0: -1, x1: 4, y0: -1.5, y1: 1.5 };
  const ranges = [];
  for (let i = 0; i < BEAMS; i += 1) {
    const angle = -Math.PI + (i * 2 * Math.PI) / BEAMS + pose.theta;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let nearest = Infinity;
    for (const [bound, along] of [
      [walls.x0, 'x'],
      [walls.x1, 'x'],
      [walls.y0, 'y'],
      [walls.y1, 'y'],
    ]) {
      const t = along === 'x' ? (bound - pose.x) / dx : (bound - pose.y) / dy;
      if (t > 0) nearest = Math.min(nearest, t);
    }
    // The box, as four segments.
    for (const [x, y0, y1] of [
      [box.x0, box.y0, box.y1],
      [box.x1, box.y0, box.y1],
    ]) {
      const t = (x - pose.x) / dx;
      const y = pose.y + t * dy;
      if (t > 0 && y >= y0 && y <= y1) nearest = Math.min(nearest, t);
    }
    for (const [y, x0, x1] of [
      [box.y0, box.x0, box.x1],
      [box.y1, box.x0, box.x1],
    ]) {
      const t = (y - pose.y) / dy;
      const x = pose.x + t * dx;
      if (t > 0 && x >= x0 && x <= x1) nearest = Math.min(nearest, t);
    }
    ranges.push(Number(nearest.toFixed(3)));
  }
  return {
    stamp,
    angle_min: -Math.PI,
    angle_increment: (2 * Math.PI) / BEAMS,
    range_max: 12,
    ranges,
    mount: { x: 0, y: 0, yaw: 0 },
  };
}

function drive() {
  const samples = [];
  for (let i = 0; i <= 30; i += 1) {
    const pose = { x: i * 0.1, y: 0, theta: 0 };
    samples.push({ scan: roomScan(pose, i * 0.2), odom: { ...pose, stamp: i * 0.2, v: 0.5 } });
  }
  return samples;
}

test('scan points are placed with the odometry pose and the LiDAR mount', () => {
  const scan = { angle_min: 0, angle_increment: Math.PI / 2, ranges: [1, null, 2, 9] };
  const points = scanPoints({ ...scan, mount: { x: 0.2, y: 0, yaw: 0 } }, { x: 1, y: 1, theta: 0 });
  assert.deepEqual(
    points.map((point) => [Number(point.x.toFixed(6)), Number(point.y.toFixed(6))]),
    [
      [2.2, 1],
      [-0.8, 1],
    ], // the null beam is skipped, the 9 m one is beyond the placing range
  );
  const turned = scanPoints(
    { ...scan, mount: { x: 0, y: 0, yaw: 0 } },
    { x: 0, y: 0, theta: Math.PI / 2 },
  );
  assert.ok(Math.abs(turned[0].x) < 1e-9 && Math.abs(turned[0].y - 1) < 1e-9);
});

test('a measured room has its walls and the box, and the driven path stays free', () => {
  const room = measuredRoom(drive());
  assert.equal(room.scans, 31);
  assert.equal(room.tooLarge, false);
  const { map } = room;
  assert.deepEqual([map.width, map.height], [ROOM_SIZE.width, ROOM_SIZE.height]);
  // Driven from x = 0 to 3 along y = 0: centred in the 6 m frame, y flipped (left is up).
  assert.deepEqual(map.start, { x: 1.5, y: 2 });
  assert.deepEqual(map.goal, { x: 4.5, y: 2 });
  const occupiedAt = (x, y) =>
    map.obstacles.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  // The box's near side (odometry y = -0.4) is 0.4 m below the path on screen; only its outline
  // is measured, the LiDAR cannot see inside it.
  assert.ok(occupiedAt(3.05, 2.45), 'the near side of the box');
  assert.ok(occupiedAt(0.5 + 0.05, 2), 'the wall behind the start (odometry x = -1)');
  assert.ok(!occupiedAt(3.0, 2), 'the driven path');
  assert.ok(map.obstacles.every((r) => r.h === ROOM_CELL && r.measured));
});

test('the planner finds a way around the measured box, and the course runs on the measured map', () => {
  const { map } = measuredRoom(drive());
  const plan = planRoute(map, { margin: 0.05 });
  assert.equal(plan.reason, '');
  assert.ok(plan.path.length >= 2);
  const run = planningExperiment({ ...planningDefaults('room'), margin: 0.05 }, map);
  assert.equal(run.status, 'success');
  assert.equal(run.map, map);
});

test('too few scans are not a map', () => {
  assert.equal(measuredRoom(drive().slice(0, 2)), null);
  assert.equal(measuredRoom([{ scan: roomScan({ x: 0, y: 0, theta: 0 }, 0), odom: null }]), null);
});

test('a rosbag becomes a room map, using the LiDAR mount from /tf_static', () => {
  const file = fs.readFileSync(new URL('./fixtures/drive-approach.mcap', import.meta.url));
  const bag = readRosbag(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  const recording = makeRecording({
    source: 'rosbag',
    name: 'drive-approach.mcap',
    recordedAt: new Date(bag.start * 1000).toISOString(),
    config: BAG_DEFAULT_CONFIG,
    topics: bag.topics,
    streams: bag.streams,
  });
  const samples = pairByStamp(recording, 'scan', ['odom'], 0.2).filter((sample) => sample.odom);
  const room = measuredRoom(samples);
  assert.equal(room.scans, 20);
  // The wall is 1.5 m ahead of the LiDAR, which sits 0.2 m ahead of the start: x = 1.7 in odometry.
  // The drive covers 0 … 0.5 m, so the frame starts at 0.25 - 3 = -2.75 and the wall is at 4.45 m.
  const wall = room.map.obstacles.filter((r) => r.x <= 4.45 && r.x + r.w >= 4.4);
  assert.ok(wall.length > 5, 'the wall ahead is on the map');
});
