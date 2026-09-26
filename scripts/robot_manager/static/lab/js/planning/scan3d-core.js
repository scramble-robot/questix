import { ROOM_CELL, ROOM_SIZE, gridRectangles } from './room-core.js';

// A planning map from a 3D scan of the room taken with a phone (Scaniverse, Polycam, 3D Scanner
// App, …). QUESTiX drives on wheels over a flat floor, so what blocks it is anything between just
// above the floor and the top of the robot: the scan is cut over that height range (`band: 'body'`,
// the default). The other band cuts only around the plane the robot's 2D LiDAR scans, which is the
// map the robot itself sees — table legs, not table tops — to compare the two.
// No DOM; covered by test/planning-scan3d.test.mjs.
//
// Formats, read without a library: PLY (ASCII or binary little-endian; vertices, optional faces),
// OBJ (v / f), and GLB (binary glTF, uncompressed meshes). Phone scans come from ARKit / ARCore,
// which measure in metres with a gravity-aligned vertical axis — Y up for glTF and usually for
// OBJ/PLY exports; Z up can be chosen.

const MAX_TRIANGLES = 4_000_000; // beyond this the page would stall; decimate the export instead
const FLOOR_BIN = 0.02; // m, height histogram step when looking for the floor
const FLOOR_SEARCH = 0.6; // m above the lowest part of the scan in which the floor is looked for
const LOW_PERCENTILE = 0.01; // stray points below the floor are ignored below this fraction
const HORIZONTAL = 0.9; // |normal·up| above which a triangle counts as horizontal (floor)
const SLICE_STEP = { lidar: 0.01, body: 0.02 }; // m between cutting planes within a band
const GRID_EPSILON = 1e-4; // cells
const MIN_POINT_HITS = 2; // a point-cloud cell needs this many points (a mesh cell needs one cut)

const scanError = (text) => new Error(text);

// --- reading -----------------------------------------------------------------------------------

const PLY_TYPES = {
  char: ['getInt8', 1],
  int8: ['getInt8', 1],
  uchar: ['getUint8', 1],
  uint8: ['getUint8', 1],
  short: ['getInt16', 2],
  int16: ['getInt16', 2],
  ushort: ['getUint16', 2],
  uint16: ['getUint16', 2],
  int: ['getInt32', 4],
  int32: ['getInt32', 4],
  uint: ['getUint32', 4],
  uint32: ['getUint32', 4],
  float: ['getFloat32', 4],
  float32: ['getFloat32', 4],
  double: ['getFloat64', 8],
  float64: ['getFloat64', 8],
};

function plyHeader(bytes) {
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const end = text.indexOf('end_header');
  if (!text.startsWith('ply') || end < 0) throw scanError('PLYファイルの見出しを読み取れません。');
  const lines = text.slice(0, end).split(/\r?\n/);
  const format = lines.find((line) => line.startsWith('format'))?.split(/\s+/)[1];
  const elements = [];
  for (const line of lines) {
    const words = line.trim().split(/\s+/);
    if (words[0] === 'element')
      elements.push({ name: words[1], count: Number(words[2]), props: [] });
    else if (words[0] === 'property' && words[1] === 'list')
      elements
        .at(-1)
        .props.push({ list: true, countType: words[2], type: words[3], name: words[4] });
    else if (words[0] === 'property')
      elements.at(-1).props.push({ type: words[1], name: words[2] });
  }
  const bodyStart = end + 'end_header'.length + (text[end + 10] === '\r' ? 2 : 1);
  return { format, elements, bodyStart: new TextEncoder().encode(text.slice(0, bodyStart)).length };
}

function readPlyBinary(bytes, header) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = header.bodyStart;
  const read = (type) => {
    const [getter, size] = PLY_TYPES[type] ?? [];
    if (!getter) throw scanError(`PLYの型 ${type} には対応していません。`);
    const value = view[getter](at, true);
    at += size;
    return value;
  };
  const positions = [];
  const faces = [];
  for (const element of header.elements)
    for (let i = 0; i < element.count; i += 1) {
      const values = {};
      for (const prop of element.props) {
        if (!prop.list) values[prop.name] = read(prop.type);
        else
          values[prop.name] = Array.from({ length: read(prop.countType) }, () => read(prop.type));
      }
      if (element.name === 'vertex') positions.push(values.x, values.y, values.z);
      if (element.name === 'face') faces.push(values.vertex_indices ?? values.vertex_index);
    }
  return { positions, faces };
}

function readPlyAscii(bytes, header) {
  const words = new TextDecoder()
    .decode(bytes.subarray(header.bodyStart))
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  let at = 0;
  const positions = [];
  const faces = [];
  for (const element of header.elements)
    for (let i = 0; i < element.count; i += 1) {
      const values = {};
      for (const prop of element.props) {
        if (!prop.list) values[prop.name] = words[at++];
        else values[prop.name] = words.slice(at + 1, at + 1 + words[at]);
        if (prop.list) at += 1 + values[prop.name].length;
      }
      if (element.name === 'vertex') positions.push(values.x, values.y, values.z);
      if (element.name === 'face') faces.push(values.vertex_indices ?? values.vertex_index);
    }
  return { positions, faces };
}

// A polygon becomes a fan of triangles.
function triangulate(faces) {
  const indices = [];
  for (const face of faces)
    for (let i = 1; i + 1 < face.length; i += 1) indices.push(face[0], face[i], face[i + 1]);
  return indices;
}

function readPly(bytes) {
  const header = plyHeader(bytes);
  if (header.format === 'binary_big_endian')
    throw scanError('ビッグエンディアンのPLYには対応していません。');
  const { positions, faces } =
    header.format === 'ascii' ? readPlyAscii(bytes, header) : readPlyBinary(bytes, header);
  return { positions, indices: faces.length ? triangulate(faces) : null };
}

function readObj(bytes) {
  const positions = [];
  const faces = [];
  for (const line of new TextDecoder().decode(bytes).split('\n')) {
    if (line.startsWith('v ')) {
      const [, x, y, z] = line.trim().split(/\s+/);
      positions.push(Number(x), Number(y), Number(z));
    } else if (line.startsWith('f ')) {
      // "f 1/1/1 2/2/2 3/3/3": the first number of each corner is the (1-based, or negative) vertex.
      const corners = line.trim().split(/\s+/).slice(1);
      const count = positions.length / 3;
      faces.push(
        corners.map((corner) => {
          const index = Number(corner.split('/')[0]);
          return index < 0 ? count + index : index - 1;
        }),
      );
    }
  }
  return { positions, indices: faces.length ? triangulate(faces) : null };
}

// --- glTF binary ---

const GL_COMPONENTS = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};
const TYPE_SIZE = { SCALAR: 1, VEC3: 3 };
const UNSUPPORTED_EXTENSIONS = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression'];

function accessorValues(gltf, bin, index) {
  const accessor = gltf.accessors[index];
  const view = gltf.bufferViews[accessor.bufferView];
  const Type = GL_COMPONENTS[accessor.componentType];
  const size = TYPE_SIZE[accessor.type];
  const stride = view.byteStride ? view.byteStride / Type.BYTES_PER_ELEMENT : size;
  const start = bin.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const length = (accessor.count - 1) * stride + size;
  const data = new Type(bin.buffer.slice(start, start + length * Type.BYTES_PER_ELEMENT));
  const values = new Array(accessor.count * size);
  for (let i = 0; i < accessor.count; i += 1)
    for (let k = 0; k < size; k += 1) values[i * size + k] = data[i * stride + k];
  return values;
}

// 4×4 column-major matrices, as glTF stores them.
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let row = 0; row < 4; row += 1)
    for (let column = 0; column < 4; column += 1)
      for (let k = 0; k < 4; k += 1) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  return out;
}

function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y + z * w) * sx,
    2 * (x * z - y * w) * sx,
    0,
    2 * (x * y - z * w) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z + x * w) * sy,
    0,
    2 * (x * z + y * w) * sz,
    2 * (y * z - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

function readGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const used = [...(gltf.extensionsRequired ?? []), ...(gltf.extensionsUsed ?? [])];
  const compressed = UNSUPPORTED_EXTENSIONS.find((name) => used.includes(name));
  if (compressed)
    throw scanError(
      `圧縮されたGLB（${compressed}）は読み込めません。圧縮なしで書き出してください。`,
    );
  const binStart = 20 + jsonLength;
  const bin = bytes.subarray(binStart + 8, binStart + 8 + view.getUint32(binStart, true));
  const positions = [];
  const indices = [];
  const visit = (index, parent) => {
    const node = gltf.nodes[index];
    const matrix = multiply(parent, nodeMatrix(node));
    for (const primitive of gltf.meshes?.[node.mesh]?.primitives ?? []) {
      if ((primitive.mode ?? 4) !== 4) continue; // triangles only
      const local = accessorValues(gltf, bin, primitive.attributes.POSITION);
      const offset = positions.length / 3;
      for (let i = 0; i < local.length; i += 3) {
        const [x, y, z] = [local[i], local[i + 1], local[i + 2]];
        for (let row = 0; row < 3; row += 1)
          positions.push(
            matrix[row] * x + matrix[4 + row] * y + matrix[8 + row] * z + matrix[12 + row],
          );
      }
      const own =
        primitive.indices === undefined
          ? Array.from({ length: local.length / 3 }, (_, i) => i)
          : accessorValues(gltf, bin, primitive.indices);
      for (const value of own) indices.push(offset + value);
    }
    for (const child of node.children ?? []) visit(child, matrix);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  for (const index of scene?.nodes ?? gltf.nodes.map((_, i) => i)) visit(index, identity);
  return { positions, indices };
}

/**
 * The geometry of a scan file: `{positions: Float64Array (x, y, z …), indices: Uint32Array | null}`
 * — indices are triangles, null for a point cloud. Throws an Error meant for the learner.
 */
function readScan(buffer, name = '') {
  const bytes = new Uint8Array(buffer);
  const head = new TextDecoder().decode(bytes.subarray(0, 4));
  let geometry;
  if (head === 'glTF') geometry = readGlb(bytes);
  else if (head.startsWith('ply')) geometry = readPly(bytes);
  else if (/\.obj$/i.test(name) || /^(#|v |o |mtllib)/m.test(head)) geometry = readObj(bytes);
  else throw scanError('PLY・OBJ・GLBのどれかで書き出した3Dスキャンを選んでください。');
  if (!geometry.positions.length) throw scanError('このファイルには3Dの点がありません。');
  if (geometry.indices && geometry.indices.length / 3 > MAX_TRIANGLES)
    throw scanError('三角形が多すぎます。書き出すときに細かさを下げてください。');
  return {
    positions: Float64Array.from(geometry.positions),
    indices: geometry.indices ? Uint32Array.from(geometry.indices) : null,
  };
}

// --- cutting ------------------------------------------------------------------------------------

// Height and the two horizontal coordinates of vertex i, for the chosen vertical axis. The
// horizontal pair is ordered so that looking down on the map is not mirrored: with Y up, x runs
// right and z runs down the screen; with Z up, x runs right and y runs up (so the map uses −y).
function axes(up) {
  if (up === 'z')
    return {
      height: (p, i) => p[i * 3 + 2],
      across: (p, i) => p[i * 3],
      down: (p, i) => -p[i * 3 + 1],
    };
  return {
    height: (p, i) => p[i * 3 + 1],
    across: (p, i) => p[i * 3],
    down: (p, i) => p[i * 3 + 2],
  };
}

function lowHeight(heights) {
  const sorted = Float64Array.from(heights).sort();
  return sorted[Math.floor(sorted.length * LOW_PERCENTILE)];
}

/**
 * Height of the floor: the height, in the lowest FLOOR_SEARCH metres of the scan, holding the most
 * horizontal surface (mesh: area of level triangles; point cloud: number of points).
 */
function floorHeight(geometry, up = 'y') {
  const { positions, indices } = geometry;
  const { height } = axes(up);
  const count = positions.length / 3;
  const heights = Array.from({ length: count }, (_, i) => height(positions, i));
  const low = lowHeight(heights);
  const bins = new Float64Array(Math.ceil(FLOOR_SEARCH / FLOOR_BIN) + 1);
  const add = (value, weight) => {
    const bin = Math.floor((value - low) / FLOOR_BIN);
    if (bin >= 0 && bin < bins.length) bins[bin] += weight;
  };
  if (indices) {
    const up3 = up === 'z' ? 2 : 1;
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
      const edge1 = [0, 1, 2].map((k) => positions[b * 3 + k] - positions[a * 3 + k]);
      const edge2 = [0, 1, 2].map((k) => positions[c * 3 + k] - positions[a * 3 + k]);
      const normal = [
        edge1[1] * edge2[2] - edge1[2] * edge2[1],
        edge1[2] * edge2[0] - edge1[0] * edge2[2],
        edge1[0] * edge2[1] - edge1[1] * edge2[0],
      ];
      const area = Math.hypot(...normal);
      if (!area || Math.abs(normal[up3]) / area < HORIZONTAL) continue;
      add((heights[a] + heights[b] + heights[c]) / 3, area / 2);
    }
  }
  if (!bins.some((weight) => weight > 0)) for (const value of heights) add(value, 1);
  const best = bins.indexOf(Math.max(...bins));
  return low + (best + 0.5) * FLOOR_BIN;
}

// Where each triangle crosses the plane `height = level`: one segment [[across, down], [across,
// down]] per crossing triangle. A corner lying exactly on the plane is shared by two edges, so the
// crossings of a triangle are de-duplicated before they are paired.
function cutMesh(geometry, ax, level, out) {
  const { positions, indices } = geometry;
  for (let t = 0; t < indices.length; t += 3) {
    const corners = [indices[t], indices[t + 1], indices[t + 2]];
    const h = corners.map((i) => ax.height(positions, i) - level);
    if ((h[0] > 0 && h[1] > 0 && h[2] > 0) || (h[0] < 0 && h[1] < 0 && h[2] < 0)) continue;
    const crossings = [];
    for (let k = 0; k < 3; k += 1) {
      const [i, j] = [corners[k], corners[(k + 1) % 3]];
      const [hi, hj] = [h[k], h[(k + 1) % 3]];
      if (hi === hj || hi * hj > 0) continue;
      const f = hi / (hi - hj);
      const point = [
        ax.across(positions, i) + f * (ax.across(positions, j) - ax.across(positions, i)),
        ax.down(positions, i) + f * (ax.down(positions, j) - ax.down(positions, i)),
      ];
      if (!crossings.some((seen) => seen[0] === point[0] && seen[1] === point[1]))
        crossings.push(point);
    }
    if (crossings.length === 2) out.push(crossings);
    else if (crossings.length === 1) out.push([crossings[0], crossings[0]]); // touches at a corner
  }
}

// The heights at which the band is cut: the LiDAR's plane ± thickness, or the robot's whole height.
// `lowest` stays above the floor's own unevenness in the scan (a phone scan's floor is a centimetre
// or two thick); anything lower is taken as something the wheels roll over.
function bandLevels(floor, { band, lidarHeight, thickness, lowest, bodyHeight }) {
  const [from, to, step] =
    band === 'body'
      ? [floor + lowest, floor + bodyHeight, SLICE_STEP.body]
      : [floor + lidarHeight - thickness, floor + lidarHeight + thickness, SLICE_STEP.lidar];
  const levels = [];
  for (let level = from; level <= to + 1e-9; level += step) levels.push(level);
  return { from, to, levels: levels.length ? levels : [(from + to) / 2] };
}

// Mark every grid cell a segment passes through (sampled at half a cell).
function markSegment(hits, grid, a, b) {
  const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (grid.cell / 2)));
  for (let s = 0; s <= steps; s += 1) {
    const x = a[0] + ((b[0] - a[0]) * s) / steps;
    const y = a[1] + ((b[1] - a[1]) * s) / steps;
    const column = Math.floor((x - grid.left) / grid.cell);
    const row = Math.floor((y - grid.top) / grid.cell);
    if (column >= 0 && row >= 0 && column < grid.columns && row < grid.rows)
      hits[row * grid.columns + column] += 1;
  }
}

/**
 * Cut `geometry` into the cells of the room it covers (whole scan, ROOM_CELL grid): returns
 * `{hits, grid}` where `grid = {left, top, columns, rows, cell}` in the scan's horizontal
 * coordinates, plus the band's heights. `options`: `up` ('y' | 'z'), `floor` (from floorHeight),
 * `band` ('body' | 'lidar'), `lowest`, `bodyHeight`, `lidarHeight`, `thickness` in metres.
 */
function sliceScan(geometry, options) {
  const ax = axes(options.up);
  const { positions, indices } = geometry;
  const count = positions.length / 3;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < count; i += 1) {
    left = Math.min(left, ax.across(positions, i));
    right = Math.max(right, ax.across(positions, i));
    top = Math.min(top, ax.down(positions, i));
    bottom = Math.max(bottom, ax.down(positions, i));
  }
  const cell = ROOM_CELL;
  const grid = {
    left,
    top,
    cell,
    // The epsilon keeps a float32 copy of the same scan (5.2000001 m) from gaining a column.
    columns: Math.max(1, Math.ceil((right - left) / cell - GRID_EPSILON)),
    rows: Math.max(1, Math.ceil((bottom - top) / cell - GRID_EPSILON)),
  };
  const hits = new Uint32Array(grid.columns * grid.rows);
  const band = bandLevels(options.floor, options);
  if (indices) {
    for (const level of band.levels) {
      const segments = [];
      cutMesh(geometry, ax, level, segments);
      for (const [a, b] of segments) markSegment(hits, grid, a, b);
    }
  } else {
    for (let i = 0; i < count; i += 1) {
      const h = ax.height(positions, i);
      if (h < band.from || h > band.to) continue;
      const point = [ax.across(positions, i), ax.down(positions, i)];
      markSegment(hits, grid, point, point);
    }
  }
  return { hits, grid, band, mesh: Boolean(indices) };
}

/**
 * The course's 6 m × 4 m planning map out of a slice. The scan is turned a quarter when that fits
 * its long side along the map's width (`rotate`: true / false / 'auto'), and `offset` {x, y} (m from
 * the scan's own corner) chooses which part of a larger room is shown. Returns
 * `{map, extent: {width, height}, offset, maxOffset, rotated}`.
 */
function scanRoom(slice, { start, goal, rotate = 'auto', offset = { x: null, y: null } } = {}) {
  const { hits, grid, mesh } = slice;
  const minHits = mesh ? 1 : MIN_POINT_HITS;
  const tall = grid.rows > grid.columns;
  const rotated = rotate === 'auto' ? tall : Boolean(rotate);
  const extent = rotated
    ? { width: grid.rows * grid.cell, height: grid.columns * grid.cell }
    : { width: grid.columns * grid.cell, height: grid.rows * grid.cell };
  const maxOffset = {
    x: Math.max(0, extent.width - ROOM_SIZE.width),
    y: Math.max(0, extent.height - ROOM_SIZE.height),
  };
  // By default the room is centred in the frame (or the frame on the room, when it is larger).
  const place = (value, max, room, frame) =>
    value === null || value === undefined
      ? max > 0
        ? max / 2
        : -(frame - room) / 2
      : Math.min(max, Math.max(max > 0 ? 0 : -(frame - room) / 2, value));
  const chosen = {
    x: place(offset.x, maxOffset.x, extent.width, ROOM_SIZE.width),
    y: place(offset.y, maxOffset.y, extent.height, ROOM_SIZE.height),
  };
  const columns = Math.round(ROOM_SIZE.width / grid.cell);
  const rows = Math.round(ROOM_SIZE.height / grid.cell);
  const occupied = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row += 1)
    for (let column = 0; column < columns; column += 1) {
      // Cell centre in the (possibly turned) scan, then back to the scan's own grid.
      const u = Math.floor(chosen.x / grid.cell + column + 0.5);
      const v = Math.floor(chosen.y / grid.cell + row + 0.5);
      const [sc, sr] = rotated ? [grid.columns - 1 - v, u] : [u, v];
      if (sc < 0 || sr < 0 || sc >= grid.columns || sr >= grid.rows) continue;
      if (hits[sr * grid.columns + sc] >= minHits) occupied[row * columns + column] = 1;
    }
  return {
    map: {
      ...ROOM_SIZE,
      start: start ?? { x: 0.6, y: 2 },
      goal: goal ?? { x: 5.4, y: 2 },
      obstacles: gridRectangles(occupied, columns, rows, grid.cell),
      measured: true,
    },
    extent,
    offset: chosen,
    maxOffset,
    rotated,
  };
}

export { readScan, floorHeight, sliceScan, scanRoom, bandLevels };
