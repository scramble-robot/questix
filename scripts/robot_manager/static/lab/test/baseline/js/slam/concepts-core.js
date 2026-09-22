// Introductory experiments. Each estimator takes measurements, not reference poses.
function pointInWorld(point, pose) {
  const c = Math.cos(pose.theta),
    s = Math.sin(pose.theta);
  return { x: pose.x + c * point.x - s * point.y, y: pose.y + s * point.x + c * point.y };
}
function pointInRobot(point, pose) {
  const x = point.x - pose.x,
    y = point.y - pose.y,
    c = Math.cos(pose.theta),
    s = Math.sin(pose.theta);
  return { x: c * x + s * y, y: -s * x + c * y };
}
function roomSegments(scene) {
  const edges = [
    [0, 0, scene.width, 0],
    [scene.width, 0, scene.width, scene.height],
    [scene.width, scene.height, 0, scene.height],
    [0, scene.height, 0, 0],
  ];
  for (const r of scene.obstacles || []) {
    const x = r.x,
      y = r.y,
      X = x + r.w,
      Y = y + r.h;
    edges.push([x, y, X, y], [X, y, X, Y], [X, Y, x, Y], [x, Y, x, y]);
  }
  return edges;
}
function measureRoom(scene, pose, count = 120, rangeMax = 6) {
  const segments = roomSegments(scene);
  return Array.from({ length: count }, (_, i) => {
    const a = (i * Math.PI * 2) / count,
      dx = Math.cos(pose.theta + a),
      dy = Math.sin(pose.theta + a);
    let range = rangeMax,
      hit = false;
    for (const [x, y, X, Y] of segments) {
      const sx = X - x,
        sy = Y - y,
        den = dx * sy - dy * sx;
      if (Math.abs(den) < 1e-9) continue;
      const qx = x - pose.x,
        qy = y - pose.y,
        t = (qx * sy - qy * sx) / den,
        u = (qx * dy - qy * dx) / den;
      if (t > 1e-6 && t < range && u >= -1e-9 && u <= 1 + 1e-9) {
        range = t;
        hit = true;
      }
    }
    return { a, range, hit };
  });
}
const MAPPING_ROOM = { width: 4.8, height: 3.2, obstacles: [{ x: 2, y: 1, w: 0.6, h: 1.2 }] };
const MAPPING_POSES = [
  { x: 0.7, y: 0.7, theta: 0 },
  { x: 4.1, y: 0.7, theta: Math.PI / 2 },
  { x: 4.1, y: 2.6, theta: Math.PI },
  { x: 0.7, y: 2.6, theta: -Math.PI / 2 },
];
function occupancyFromScans(frames, { width = 4.8, height = 3.2, resolution = 0.1 } = {}) {
  const w = Math.ceil(width / resolution),
    h = Math.ceil(height / resolution),
    score = new Float64Array(w * h),
    seen = new Uint8Array(w * h),
    index = (x, y) =>
      Math.max(0, Math.min(h - 1, Math.floor(y / resolution))) * w +
      Math.max(0, Math.min(w - 1, Math.floor(x / resolution)));
  for (const frame of frames) {
    const free = new Set(),
      occupied = new Set();
    for (const ray of frame.scan) {
      const a = frame.pose.theta + ray.a,
        dx = Math.cos(a),
        dy = Math.sin(a),
        end = index(frame.pose.x + ray.range * dx, frame.pose.y + ray.range * dy);
      for (let d = 0; d < ray.range; d += resolution / 4) {
        const k = index(frame.pose.x + d * dx, frame.pose.y + d * dy);
        if (!ray.hit || k !== end) free.add(k);
      }
      if (ray.hit) occupied.add(end);
    }
    // One vote per cell per scan; a measured surface overrides traversing rays.
    for (const i of free)
      if (!occupied.has(i)) {
        seen[i] = 1;
        score[i] = Math.max(-4, score[i] - 0.7);
      }
    for (const i of occupied) {
      seen[i] = 1;
      score[i] = Math.min(4, score[i] + 1.2);
    }
  }
  const cells = Array.from(seen, (v, i) =>
    !v ? 'unknown' : score[i] > 0.4 ? 'occupied' : score[i] < -0.3 ? 'free' : 'uncertain',
  );
  return {
    w,
    h,
    resolution,
    cells,
    known: cells.filter((c) => c === 'occupied' || c === 'free').length,
    total: cells.length,
  };
}
function localizationRoom(feature = false) {
  return {
    width: 8,
    height: 2.4,
    obstacles: feature ? [{ x: 4.6, y: 0.15, w: 0.35, h: 0.7 }] : [],
  };
}
function rangeMismatch(observed, predicted) {
  return Math.sqrt(
    observed.reduce((sum, r, i) => sum + (r.range - predicted[i].range) ** 2, 0) / observed.length,
  );
}
function localizeOnKnownMap(observed, scene, { y = 1.2, theta = 0, rangeMax = 2 } = {}) {
  const candidates = Array.from({ length: 67 }, (_, i) => {
      const x = 0.7 + i * 0.1;
      return {
        x,
        error: rangeMismatch(
          observed,
          measureRoom(scene, { x, y, theta }, observed.length, rangeMax),
        ),
      };
    }),
    best = Math.min(...candidates.map((c) => c.error)),
    plausible = candidates.filter((c) => c.error < best + 0.018);
  return { candidates, best, plausible };
}
function solveLinear(matrix, b) {
  const a = matrix.map((r, i) => [...r, b[i]]),
    n = b.length;
  for (let k = 0; k < n; k++) {
    let pivot = k;
    for (let j = k + 1; j < n; j++) if (Math.abs(a[j][k]) > Math.abs(a[pivot][k])) pivot = j;
    [a[k], a[pivot]] = [a[pivot], a[k]];
    if (Math.abs(a[k][k]) < 1e-12) throw Error('位置を固定する基準が必要です');
    const d = a[k][k];
    for (let j = k; j <= n; j++) a[k][j] /= d;
    for (let i = 0; i < n; i++)
      if (i !== k) {
        const f = a[i][k];
        for (let j = k; j <= n; j++) a[i][j] -= f * a[k][j];
      }
  }
  return a.map((r) => r[n]);
}
function poseGraphOptimize(count, edges) {
  // Translation-only weighted least squares. Heading is assumed known.
  const n = count - 1,
    matrix = Array.from({ length: n }, () => Array(n).fill(0)),
    bx = Array(n).fill(0),
    by = Array(n).fill(0);
  for (const e of edges) {
    const terms = [
        [e.from, -1],
        [e.to, 1],
      ].filter(([id]) => id > 0),
      w = e.weight || 1;
    for (const [id, s] of terms) {
      for (const [jd, t] of terms) matrix[id - 1][jd - 1] += w * s * t;
      bx[id - 1] += w * s * e.dx;
      by[id - 1] += w * s * e.dy;
    }
  }
  const x = solveLinear(matrix, bx),
    y = solveLinear(matrix, by);
  return [{ x: 0, y: 0 }, ...x.map((v, i) => ({ x: v, y: y[i] }))];
}
function loopFixture() {
  const reference = [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
    [3, 1],
    [3, 2],
    [2, 2],
    [1, 2],
    [0, 2],
    [0, 1],
    [0, 0],
  ].map(([x, y]) => ({ x: x * 0.8, y: y * 0.8 }));
  const edges = reference.slice(1).map((p, i) => ({
      from: i,
      to: i + 1,
      dx: p.x - reference[i].x + 0.04,
      dy: p.y - reference[i].y + 0.025,
      weight: 1,
    })),
    before = [{ x: 0, y: 0 }];
  for (const e of edges) before.push({ x: before.at(-1).x + e.dx, y: before.at(-1).y + e.dy });
  const scans = reference.map((p) =>
    measureRoom(MAPPING_ROOM, { x: p.x + 0.8, y: p.y + 0.8, theta: 0 }, 60, 5),
  );
  return { edges, before, scans };
}
function closeLoop(fixture, matchNode = 0, weight = 30) {
  const last = fixture.before.length - 1,
    link = { from: matchNode, to: last, dx: 0, dy: 0, weight },
    after = poseGraphOptimize(last + 1, [...fixture.edges, link]);
  const moveResidual = Math.sqrt(
    fixture.edges.reduce(
      (s, e) =>
        s +
        (after[e.to].x - after[e.from].x - e.dx) ** 2 +
        (after[e.to].y - after[e.from].y - e.dy) ** 2,
      0,
    ) / fixture.edges.length,
  );
  return {
    after,
    moveResidual,
    gap: Math.hypot(after[last].x - after[matchNode].x, after[last].y - after[matchNode].y),
  };
}

export {
  pointInWorld,
  pointInRobot,
  roomSegments,
  measureRoom,
  MAPPING_ROOM,
  MAPPING_POSES,
  occupancyFromScans,
  localizationRoom,
  rangeMismatch,
  localizeOnKnownMap,
  poseGraphOptimize,
  loopFixture,
  closeLoop,
};
