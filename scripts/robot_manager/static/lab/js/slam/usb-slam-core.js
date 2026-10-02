// Local point-to-line ICP uses metres/radians. A rolling normal map bounds computation;
// failed or geometrically ambiguous matches never add evidence to the occupancy grid.
const MAP_SIZE = 640;
const RESOLUTION_METRES = 0.05;
const HASH_CELL_METRES = 0.2;
const VOXEL_METRES = 0.04;
const MATCH_RADIUS_METRES = 0.3;
const MAX_KEYFRAMES = 25;
const MAX_PATH_POINTS = 12000;
const MAX_ICP_ITERATIONS = 12;
const SCAN_POINT_TARGET = 260;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
function solveMatrix(a, b) {
  let m = a.map((r, i) => [...r, b[i]]);
  for (let k = 0; k < 3; k++) {
    let j = k;
    for (let i = k + 1; i < 3; i++) if (Math.abs(m[i][k]) > Math.abs(m[j][k])) j = i;
    [m[j], m[k]] = [m[k], m[j]];
    if (Math.abs(m[k][k]) < 1e-8) return null;
    let v = m[k][k];
    for (let t = k; t < 4; t++) m[k][t] /= v;
    for (let i = 0; i < 3; i++)
      if (i !== k) {
        let f = m[i][k];
        for (let t = k; t < 4; t++) m[i][t] -= f * m[k][t];
      }
  }
  return m.map((r) => r[3]);
}
class BrowserSlam {
  constructor() {
    this.reset();
  }
  reset() {
    this.pose = { x: 0, y: 0, theta: 0 };
    this.frames = [];
    this.path = [];
    this.grid = new Int8Array(MAP_SIZE * MAP_SIZE);
    this.size = MAP_SIZE;
    this.res = RESOLUTION_METRES;
    this.accepted = 0;
    this.rejected = 0;
    this.last = null;
    this.hash = new Map();
  }
  transform(points, p) {
    let c = Math.cos(p.theta);
    let s = Math.sin(p.theta);
    return points.map((q) => ({ x: p.x + c * q.x - s * q.y, y: p.y + s * q.x + c * q.y }));
  }
  normals(points, p) {
    let m = this.transform(points, p);
    let out = [];
    for (let i = 1; i < m.length - 1; i++) {
      let a = m[i - 1];
      let b = m[i + 1];
      let q = m[i];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let l = Math.hypot(dx, dy);
      if (
        l < 0.015 ||
        l > 0.45 ||
        Math.hypot(q.x - a.x, q.y - a.y) > 0.25 ||
        Math.hypot(q.x - b.x, q.y - b.y) > 0.25
      )
        continue;
      out.push({ ...q, nx: -dy / l, ny: dx / l });
    }
    return out;
  }
  rebuild() {
    this.hash.clear();
    const used = new Set();
    for (let f = this.frames.length - 1; f >= 0; f--)
      for (const p of this.frames[f]) {
        let v = Math.floor(p.x / VOXEL_METRES) + ',' + Math.floor(p.y / VOXEL_METRES);
        if (used.has(v)) continue;
        used.add(v);
        let k = Math.floor(p.x / HASH_CELL_METRES) + ',' + Math.floor(p.y / HASH_CELL_METRES);
        if (!this.hash.has(k)) this.hash.set(k, []);
        this.hash.get(k).push(p);
      }
  }
  nearest(x, y) {
    let best = null;
    let d2 = MATCH_RADIUS_METRES ** 2;
    let gx = Math.floor(x / HASH_CELL_METRES);
    let gy = Math.floor(y / HASH_CELL_METRES);
    for (let i = -2; i <= 2; i++)
      for (let j = -2; j <= 2; j++)
        for (const q of this.hash.get(gx + i + ',' + (gy + j)) || []) {
          let d = (q.x - x) ** 2 + (q.y - y) ** 2;
          if (d < d2) {
            d2 = d;
            best = q;
          }
        }
    return best;
  }
  equations(points, p) {
    let a = [
      [0.01, 0, 0],
      [0, 0.01, 0],
      [0, 0, 0.02],
    ];
    let b = [0, 0, 0];
    let count = 0;
    let total = 0;
    let nxx = 0;
    let nyy = 0;
    let nxy = 0;
    let c = Math.cos(p.theta);
    let s = Math.sin(p.theta);
    for (const q of points) {
      let rx = c * q.x - s * q.y;
      let ry = s * q.x + c * q.y;
      let x = p.x + rx;
      let y = p.y + ry;
      let m = this.nearest(x, y);
      if (!m) continue;
      let e = m.nx * (x - m.x) + m.ny * (y - m.y);
      if (Math.abs(e) > 0.18) continue;
      let j = [m.nx, m.ny, -m.nx * ry + m.ny * rx];
      let w = Math.min(1, 0.04 / Math.max(0.001, Math.abs(e)));
      for (let r = 0; r < 3; r++) {
        b[r] -= w * j[r] * e;
        for (let t = 0; t < 3; t++) a[r][t] += w * j[r] * j[t];
      }
      count++;
      total += Math.abs(e);
      nxx += m.nx * m.nx;
      nyy += m.ny * m.ny;
      nxy += m.nx * m.ny;
    }
    return { a, b, count, total, nxx, nyy, nxy };
  }
  match(points) {
    let p = { ...this.pose };
    let quality = 0;
    let weak = true;
    let error = 1;
    let overlap = 0;
    for (let iter = 0; iter < MAX_ICP_ITERATIONS; iter++) {
      const { a, b, count, total, nxx, nyy, nxy } = this.equations(points, p);
      if (count < 35) return { ok: false, pose: this.pose, quality: 0, weak: true };
      weak = (nxx * nyy - nxy * nxy) / Math.max(1, (nxx + nyy) ** 2) < 0.025;
      let step = solveMatrix(a, b);
      if (!step) return { ok: false, pose: this.pose, quality: 0, weak: true };
      p.x += Math.max(-0.1, Math.min(0.1, step[0]));
      p.y += Math.max(-0.1, Math.min(0.1, step[1]));
      p.theta = wrapAngle(p.theta + Math.max(-0.08, Math.min(0.08, step[2])));
      overlap = count / points.length;
      error = total / count;
      quality = overlap * Math.max(0, 1 - error / 0.12);
      if (Math.hypot(...step) < 0.0003) break;
    }
    return {
      ok:
        !weak &&
        quality > 0.48 &&
        error < 0.07 &&
        overlap > 0.55 &&
        Math.hypot(p.x - this.pose.x, p.y - this.pose.y) < 0.3 &&
        Math.abs(wrapAngle(p.theta - this.pose.theta)) < 0.25,
      pose: p,
      quality,
      weak,
    };
  }
  ray(x0, y0, x1, y1) {
    let n = this.size;
    let dx = Math.abs(x1 - x0);
    let dy = -Math.abs(y1 - y0);
    let sx = x0 < x1 ? 1 : -1;
    let sy = y0 < y1 ? 1 : -1;
    let e = dx + dy;
    for (let t = 0; t < 1400; t++) {
      if (x0 < 0 || y0 < 0 || x0 >= n || y0 >= n) return;
      let k = y0 * n + x0;
      if (x0 === x1 && y0 === y1) {
        this.grid[k] = Math.min(20, this.grid[k] + 5);
        return;
      }
      this.grid[k] = Math.max(-20, this.grid[k] - 1);
      let e2 = 2 * e;
      if (e2 >= dy) {
        e += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        e += dx;
        y0 += sy;
      }
    }
  }
  integrate(points) {
    let p = this.pose;
    let n = this.size;
    let r = this.res;
    let x0 = Math.floor(p.x / r + n / 2);
    let y0 = Math.floor(n / 2 - p.y / r);
    for (const q of this.transform(points, p))
      this.ray(x0, y0, Math.floor(q.x / r + n / 2), Math.floor(n / 2 - q.y / r));
  }
  process(scan) {
    let stride = Math.max(1, Math.floor(scan.length / SCAN_POINT_TARGET));
    let points = scan.filter((_, i) => i % stride === 0);
    if (points.length < 60) return { ok: false, reason: 'fewPoints', quality: 0 };
    let result = this.accepted
      ? this.match(points)
      : { ok: true, pose: { ...this.pose }, quality: 1, weak: false };
    if (!result.ok) {
      this.rejected++;
      return { ...result, reason: result.weak ? 'weak' : 'lost' };
    }
    if (Math.max(Math.abs(result.pose.x), Math.abs(result.pose.y)) > 13) {
      return { ok: false, quality: 0, reason: 'bounds' };
    }
    this.pose = result.pose;
    this.accepted++;
    if (this.path.length < MAX_PATH_POINTS) this.path.push({ ...this.pose });
    let key =
      !this.last ||
      this.accepted < 6 ||
      Math.hypot(this.pose.x - this.last.x, this.pose.y - this.last.y) > 0.045 ||
      Math.abs(wrapAngle(this.pose.theta - this.last.theta)) > 0.03;
    if (key) {
      this.integrate(scan);
      this.frames.push(this.normals(points, this.pose));
      if (this.frames.length > MAX_KEYFRAMES) this.frames.shift();
      this.rebuild();
      this.last = { ...this.pose };
    }
    return { ...result, reason: 'mapping' };
  }
}

export { BrowserSlam };
