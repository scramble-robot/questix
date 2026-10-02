// Run with: node --test scripts/robot_manager/static/lab/test/*.test.mjs
//
// A phone scan of a room, made up here as a mesh: a 5 m × 3 m floor, 2.5 m walls, and a table
// whose top is 0.7 m high on four thin legs. Y is up, as ARKit and glTF have it. The same mesh is
// written as OBJ, binary and ASCII PLY, and GLB, and must give the same map.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readScan, floorHeight, sliceScan, scanRoom } from '../js/planning/scan3d-core.js';
import { planRoute } from '../js/planning/core.js';

const ROOM = { x: 5, z: 3, height: 2.5 };
// Not a whole number of 10 cm cells: the scan's grid starts at the wall's outer face, so a 10 cm
// wall would put its inner face exactly on a cell boundary.
const WALL = 0.12;
const TABLE = { x0: 2, x1: 3.2, z0: 0.6, z1: 1.2, top: 0.7, leg: 0.05 };

// An axis-aligned box as 12 triangles (8 corners), appended to `mesh`.
function box(mesh, [x0, y0, z0], [x1, y1, z1]) {
  const base = mesh.positions.length / 3;
  for (const y of [y0, y1])
    for (const z of [z0, z1]) for (const x of [x0, x1]) mesh.positions.push(x, y, z);
  const quads = [
    [0, 1, 3, 2],
    [4, 6, 7, 5],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 2, 6, 4],
    [1, 5, 7, 3],
  ];
  for (const [a, b, c, d] of quads) mesh.faces.push([a, b, c, d].map((i) => base + i));
}

function roomMesh() {
  const mesh = { positions: [], faces: [] };
  const wall = WALL;
  box(mesh, [0, -0.02, 0], [ROOM.x, 0, ROOM.z]); // floor slab, top at y = 0
  box(mesh, [0, 0, -wall], [ROOM.x, ROOM.height, 0]);
  box(mesh, [0, 0, ROOM.z], [ROOM.x, ROOM.height, ROOM.z + wall]);
  box(mesh, [-wall, 0, 0], [0, ROOM.height, ROOM.z]);
  box(mesh, [ROOM.x, 0, 0], [ROOM.x + wall, ROOM.height, ROOM.z]);
  box(mesh, [TABLE.x0, TABLE.top - 0.03, TABLE.z0], [TABLE.x1, TABLE.top, TABLE.z1]);
  for (const x of [TABLE.x0, TABLE.x1 - TABLE.leg])
    for (const z of [TABLE.z0, TABLE.z1 - TABLE.leg])
      box(mesh, [x, 0, z], [x + TABLE.leg, TABLE.top - 0.03, z + TABLE.leg]);
  // Off the 10 cm grid, as a real scan is: surfaces exactly on cell boundaries would land in either
  // neighbour depending on float rounding. Everything below is measured relative to the scan.
  for (let i = 0; i < mesh.positions.length; i += 3) {
    mesh.positions[i] += 0.037;
    mesh.positions[i + 2] += 0.023;
  }
  return mesh;
}

const encode = (text) => new TextEncoder().encode(text).buffer;

function toObj(mesh) {
  const lines = ['# made-up room', 'o room'];
  for (let i = 0; i < mesh.positions.length; i += 3)
    lines.push(`v ${mesh.positions[i]} ${mesh.positions[i + 1]} ${mesh.positions[i + 2]}`);
  for (const face of mesh.faces) lines.push('f ' + face.map((i) => `${i + 1}/1/1`).join(' '));
  return encode(lines.join('\n'));
}

function toPlyBinary(mesh) {
  const count = mesh.positions.length / 3;
  const header = encode(
    [
      'ply',
      'format binary_little_endian 1.0',
      `element vertex ${count}`,
      'property float x',
      'property float y',
      'property float z',
      'property uchar red',
      `element face ${mesh.faces.length}`,
      'property list uchar int vertex_indices',
      'end_header',
      '',
    ].join('\n'),
  );
  const body = new DataView(new ArrayBuffer(count * 13 + mesh.faces.length * 17));
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    for (let k = 0; k < 3; k += 1) body.setFloat32((at += 4) - 4, mesh.positions[i * 3 + k], true);
    body.setUint8(at++, 200);
  }
  for (const face of mesh.faces) {
    body.setUint8(at++, 4);
    for (const index of face) body.setInt32((at += 4) - 4, index, true);
  }
  const file = new Uint8Array(header.byteLength + body.byteLength);
  file.set(new Uint8Array(header));
  file.set(new Uint8Array(body.buffer), header.byteLength);
  return file.buffer;
}

// A point cloud (ASCII PLY, no faces): points spread over every face of the mesh.
function toPlyPoints(mesh) {
  const points = [];
  const p = mesh.positions;
  for (const face of mesh.faces) {
    const [a, b, , d] = face;
    for (let s = 0; s <= 1; s += 0.02)
      for (let t = 0; t <= 1; t += 0.02) {
        const point = [0, 1, 2].map(
          (k) =>
            p[a * 3 + k] + s * (p[b * 3 + k] - p[a * 3 + k]) + t * (p[d * 3 + k] - p[a * 3 + k]),
        );
        points.push(point.map((value) => value.toFixed(4)).join(' '));
      }
  }
  const header = ['ply', 'format ascii 1.0', `element vertex ${points.length}`];
  header.push('property float x', 'property float y', 'property float z', 'end_header');
  return encode([...header, ...points].join('\n') + '\n');
}

// A GLB with the room in a node moved by +1 m in x (so node transforms are applied).
function toGlb(mesh) {
  const positions = Float32Array.from(mesh.positions.map((v, i) => (i % 3 === 0 ? v - 1 : v)));
  const indices = Uint32Array.from(mesh.faces.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]));
  const bin = new Uint8Array(positions.byteLength + indices.byteLength);
  bin.set(new Uint8Array(positions.buffer));
  bin.set(new Uint8Array(indices.buffer), positions.byteLength);
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [1, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR' },
    ],
  };
  let json = new TextEncoder().encode(JSON.stringify(gltf));
  const padded = new Uint8Array(Math.ceil(json.length / 4) * 4).fill(0x20);
  padded.set(json);
  json = padded;
  const file = new Uint8Array(12 + 8 + json.length + 8 + bin.length);
  const view = new DataView(file.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, file.length, true);
  view.setUint32(12, json.length, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  file.set(json, 20);
  view.setUint32(20 + json.length, bin.length, true);
  view.setUint32(24 + json.length, 0x004e4942, true); // "BIN\0"
  file.set(bin, 28 + json.length);
  return file.buffer;
}

const LIDAR = { band: 'lidar', lidarHeight: 0.15, thickness: 0.03, lowest: 0.03, bodyHeight: 0.8 };

function mapOf(buffer, name, options = {}) {
  const geometry = readScan(buffer, name);
  const floor = floorHeight(geometry, 'y');
  return { floor, room: scanRoom(sliceScan(geometry, { up: 'y', floor, ...LIDAR, ...options })) };
}

// Is a planning-map cell within `near` metres of the scan point (x, z) occupied? The scan's grid
// starts at the outer face of the walls (-WALL), and the room is centred in the 6 m × 4 m frame.
// Surfaces lie exactly on cell boundaries here, so a point is checked with a little room.
function occupiedAt(room, x, z, near = 0.05) {
  const px = x + WALL - room.offset.x;
  const py = z + WALL - room.offset.y;
  return room.map.obstacles.some(
    (r) => px >= r.x - near && px < r.x + r.w + near && py >= r.y - near && py < r.y + r.h + near,
  );
}

// The occupied cells of a map, and how much two such sets overlap (1 = identical).
function cells(room) {
  const set = new Set();
  for (const r of room.map.obstacles)
    for (let x = r.x; x < r.x + r.w - 1e-6; x += 0.1)
      set.add(`${Math.round(x * 10)},${Math.round(r.y * 10)}`);
  return set;
}
const overlap = (a, b) => [...a].filter((cell) => b.has(cell)).length / new Set([...a, ...b]).size;

test('OBJ: the floor is found and the LiDAR plane shows walls and table legs, not the top', () => {
  const { floor, room } = mapOf(toObj(roomMesh()), 'room.obj');
  assert.ok(Math.abs(floor) <= 0.02, `floor at ${floor}`);
  assert.equal(room.rotated, false);
  assert.ok(occupiedAt(room, TABLE.x0 + 0.02, TABLE.z0 + 0.02), 'a table leg');
  assert.ok(
    !occupiedAt(room, (TABLE.x0 + TABLE.x1) / 2, (TABLE.z0 + TABLE.z1) / 2),
    'under the table',
  );
  assert.ok(occupiedAt(room, ROOM.x / 2, -0.05), 'a wall');
  assert.ok(!occupiedAt(room, 1, 2), 'open floor');
});

test('the body band also shows what the LiDAR misses: the table top', () => {
  const { room } = mapOf(toObj(roomMesh()), 'room.obj', { band: 'body' });
  // The top is cut along its edges, which is what blocks the robot.
  assert.ok(occupiedAt(room, (TABLE.x0 + TABLE.x1) / 2, TABLE.z0 + 0.02), 'the table edge');
});

test('binary PLY, an ASCII PLY point cloud and GLB give the same kind of map', () => {
  // PLY and GLB store float32, so a surface on a cell boundary may land in the neighbouring cell.
  const obj = cells(mapOf(toObj(roomMesh()), 'room.obj').room);
  const ply = cells(mapOf(toPlyBinary(roomMesh()), 'room.ply').room);
  const glb = cells(mapOf(toGlb(roomMesh()), 'room.glb').room); // node +1 m cancels positions -1 m
  assert.ok(overlap(obj, ply) > 0.9, `PLY overlap ${overlap(obj, ply)}`);
  assert.ok(overlap(obj, glb) > 0.9, `GLB overlap ${overlap(obj, glb)}`);
  const cloud = mapOf(toPlyPoints(roomMesh()), 'room.ply').room;
  assert.ok(occupiedAt(cloud, TABLE.x0 + 0.02, TABLE.z0 + 0.02), 'a table leg in the point cloud');
  assert.ok(!occupiedAt(cloud, 1, 2), 'open floor in the point cloud');
});

test('a room longer than it is wide is turned, and a larger room can be moved in the frame', () => {
  const mesh = roomMesh();
  // Swap x and z: now 3 m wide and 5 m deep.
  for (let i = 0; i < mesh.positions.length; i += 3)
    [mesh.positions[i], mesh.positions[i + 2]] = [mesh.positions[i + 2], mesh.positions[i]];
  const geometry = readScan(toObj(mesh), 'deep.obj');
  const slice = sliceScan(geometry, { up: 'y', floor: 0, ...LIDAR });
  assert.equal(scanRoom(slice).rotated, true);
  assert.equal(scanRoom(slice, { rotate: false }).rotated, false);
  const big = roomMesh();
  for (let i = 0; i < big.positions.length; i += 1) big.positions[i] *= 2; // 10 m × 6 m
  const wide = sliceScan(readScan(toObj(big), 'big.obj'), {
    up: 'y',
    floor: 0,
    ...LIDAR,
    lidarHeight: 0.3,
  });
  const room = scanRoom(wide, { offset: { x: 0, y: 0 } });
  assert.deepEqual(room.offset, { x: 0, y: 0 });
  assert.ok(room.maxOffset.x > 3.9 && room.maxOffset.y > 1.9);
  assert.equal(scanRoom(wide, { offset: { x: 99, y: -5 } }).offset.x, room.maxOffset.x);
});

test('the planner routes on the scanned room, around the table legs', () => {
  const { room } = mapOf(toObj(roomMesh()), 'room.obj');
  const plan = planRoute({ ...room.map, start: { x: 1, y: 1.5 }, goal: { x: 5, y: 1.5 } });
  assert.equal(plan.reason, '');
});

test('other files and compressed GLB are refused', () => {
  assert.throws(() => readScan(encode('hello'), 'notes.txt'), /PLY・OBJ・GLB/);
  const glb = new Uint8Array(toGlb(roomMesh()));
  const text = new TextDecoder().decode(
    glb.subarray(20, 20 + new DataView(glb.buffer).getUint32(12, true)),
  );
  const withDraco = text.replace(
    '"asset"',
    '"extensionsRequired":["KHR_draco_mesh_compression"],"asset"',
  );
  assert.throws(() => readScan(toGlbJson(glb, withDraco), 'x.glb'), /圧縮/);
});

// The same GLB with its JSON chunk replaced.
function toGlbJson(glb, text) {
  const view = new DataView(glb.buffer);
  const jsonLength = view.getUint32(12, true);
  let json = new TextEncoder().encode(text);
  const padded = new Uint8Array(Math.ceil(json.length / 4) * 4).fill(0x20);
  padded.set(json);
  json = padded;
  const rest = glb.subarray(20 + jsonLength);
  const file = new Uint8Array(20 + json.length + rest.length);
  file.set(glb.subarray(0, 20));
  new DataView(file.buffer).setUint32(12, json.length, true);
  new DataView(file.buffer).setUint32(8, file.length, true);
  file.set(json, 20);
  file.set(rest, 20 + json.length);
  return file.buffer;
}

test('the floor band runs from just above the floor to the top of the robot', () => {
  // A 40 cm robot fits under the 70 cm table: only the legs block it.
  const low = mapOf(toObj(roomMesh()), 'room.obj', { band: 'body', bodyHeight: 0.4 }).room;
  assert.ok(occupiedAt(low, TABLE.x0 + 0.02, TABLE.z0 + 0.02), 'a table leg');
  assert.ok(!occupiedAt(low, (TABLE.x0 + TABLE.x1) / 2, TABLE.z0, 0.02), 'under the table edge');
  // Raising the lower limit above a 5 cm step makes it something the wheels roll over.
  const mesh = roomMesh();
  const stepMesh = { positions: [...mesh.positions], faces: [...mesh.faces] };
  const before = stepMesh.positions.length / 3;
  const step = { positions: [], faces: [] };
  const [x0, z0] = [1.037, 2.023];
  for (const y of [0, 0.05])
    for (const z of [z0, z0 + 0.3]) for (const x of [x0, x0 + 0.3]) step.positions.push(x, y, z);
  for (const quad of [
    [0, 1, 3, 2],
    [4, 6, 7, 5],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 2, 6, 4],
    [1, 5, 7, 3],
  ])
    stepMesh.faces.push(quad.map((i) => before + i));
  stepMesh.positions.push(...step.positions);
  const map = (lowest) =>
    mapOf(toObj(stepMesh), 'step.obj', { band: 'body', bodyHeight: 0.4, lowest }).room;
  assert.ok(
    occupiedAt(map(0.03), 1.0, 2.15),
    'a 5 cm step (its side) blocks when the band starts at 3 cm',
  );
  assert.ok(!occupiedAt(map(0.08), 1.0, 2.15, 0.02), 'and is rolled over from 8 cm');
});
