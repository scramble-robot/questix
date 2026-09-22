// All decisions in this module use pixels/features, never scene object labels.
function grayPixels(image) {
  const out = new Uint8ClampedArray(image.width * image.height);
  for (let i = 0; i < out.length; i++)
    out[i] =
      0.299 * image.data[i * 4] + 0.587 * image.data[i * 4 + 1] + 0.114 * image.data[i * 4 + 2];
  return out;
}
function imageOperation(image, mode, threshold = 110) {
  const { width: w, height: h } = image,
    out = new Uint8ClampedArray(image.data.length),
    gray = grayPixels(image);
  let selected = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x,
        k = i * 4,
        r = image.data[k],
        g = image.data[k + 1],
        b = image.data[k + 2];
      let v;
      if (mode === 'gray') v = gray[i];
      else if (mode === 'binary') v = gray[i] >= threshold ? 255 : 0;
      else if (mode === 'red') {
        v = r - Math.max(g, b) > threshold && r > 60 ? 255 : 0;
        if (v) selected++;
      } else if (mode === 'edge') {
        const at = (xx, yy) =>
          gray[Math.max(0, Math.min(h - 1, yy)) * w + Math.max(0, Math.min(w - 1, xx))];
        const dx =
            -at(x - 1, y - 1) +
            at(x + 1, y - 1) -
            2 * at(x - 1, y) +
            2 * at(x + 1, y) -
            at(x - 1, y + 1) +
            at(x + 1, y + 1),
          dy =
            -at(x - 1, y - 1) -
            2 * at(x, y - 1) -
            at(x + 1, y - 1) +
            at(x - 1, y + 1) +
            2 * at(x, y + 1) +
            at(x + 1, y + 1);
        v = Math.hypot(dx, dy) > threshold * 3 ? 255 : 0;
      } else {
        out[k] = r;
        out[k + 1] = g;
        out[k + 2] = b;
        out[k + 3] = 255;
        continue;
      }
      out[k] = out[k + 1] = out[k + 2] = v;
      out[k + 3] = 255;
    }
  return { width: w, height: h, data: out, selected };
}
function imageFeatures(image) {
  const { width: w, height: h, data } = image;
  let count = 0,
    r = 0,
    g = 0,
    b = 0,
    x0 = w,
    y0 = h,
    x1 = 0,
    y1 = 0;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4],
      v = data[i * 4 + 1],
      c = data[i * 4 + 2],
      hi = Math.max(a, v, c),
      lo = Math.min(a, v, c);
    if (hi - lo > 28 && hi > 45) {
      const x = i % w,
        y = Math.floor(i / w);
      mask[i] = 1;
      count++;
      r += a;
      g += v;
      b += c;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  if (count < 12) return { valid: false, values: [0, 0, 0, 0, 0], bbox: null };
  const sum = r + g + b,
    fill = count / ((x1 - x0 + 1) * (y1 - y0 + 1));
  return {
    valid: true,
    values: [r / sum, g / sum, b / sum, fill, (x1 - x0 + 1) / (y1 - y0 + 1)],
    bbox: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
    count,
  };
}
function trainImageClassifier(samples, mode = 'color') {
  if (!samples.some((s) => s.label === 0) || !samples.some((s) => s.label === 1))
    throw Error('荷箱とボールの両方の画像を登録してください。');
  const examples = samples
    .map((s) => ({ label: s.label, features: imageFeatures(s.image), id: s.id }))
    .filter((s) => s.features.valid);
  if (!examples.some((s) => s.label === 0) || !examples.some((s) => s.label === 1))
    throw Error('色のある物体を大きく写した画像を、両方の種類に登録してください。');
  return { mode, examples };
}
function classifyImage(model, image) {
  const f = imageFeatures(image);
  if (!f.valid)
    return { label: null, neighbors: [], reason: '色のある物体の特徴を取り出せませんでした。' };
  const weights =
    model.mode === 'shape'
      ? [0, 0, 0, 30, 1]
      : model.mode === 'both'
        ? [1, 1, 1, 12, 1]
        : [1, 1, 1, 0, 0];
  const neighbors = model.examples
    .map((s) => ({
      id: s.id,
      label: s.label,
      distance: Math.sqrt(
        f.values.reduce((a, v, i) => a + weights[i] * (v - s.features.values[i]) ** 2, 0),
      ),
    }))
    .sort((a, b) => a.distance - b.distance);
  // One-nearest-neighbour is an actual supervised classifier: labelled examples
  // are the learned model. No hard-coded shape-to-label mapping is used.
  return { label: neighbors[0].label, neighbors: neighbors.slice(0, 3), features: f };
}
// First four codewords in OpenCV DICT_4X4_50 (row-major, 1 = white).
// Source: OpenCV predefined_dictionaries.hpp, Apache-2.0; see notices in README.
const ARUCO_CODES = [0xb532, 0x0f9a, 0x332d, 0x9946];
function markerBits(id) {
  return Array.from({ length: 16 }, (_, i) => (ARUCO_CODES[id] >> (15 - i)) & 1);
}
function rotateBits(bits) {
  return Array.from({ length: 16 }, (_, i) => bits[(3 - (i % 4)) * 4 + Math.floor(i / 4)]);
}
function decodeMarker(bits) {
  let best = { id: null, errors: 17, rotation: 0 },
    current = [...bits];
  for (let rotation = 0; rotation < 4; rotation++) {
    ARUCO_CODES.forEach((_, id) => {
      const errors = markerBits(id).reduce((n, v, i) => n + (v !== current[i]), 0);
      if (errors < best.errors) best = { id, errors, rotation };
    });
    current = rotateBits(current);
  }
  return { ...best, id: best.errors <= 1 ? best.id : null };
}
function solve(matrix) {
  for (let i = 0; i < 8; i++) {
    let row = i;
    for (let j = i + 1; j < 8; j++) if (Math.abs(matrix[j][i]) > Math.abs(matrix[row][i])) row = j;
    [matrix[i], matrix[row]] = [matrix[row], matrix[i]];
    const d = matrix[i][i];
    if (Math.abs(d) < 1e-10) return null;
    for (let k = i; k < 9; k++) matrix[i][k] /= d;
    for (let j = 0; j < 8; j++)
      if (j !== i) {
        const v = matrix[j][i];
        for (let k = i; k < 9; k++) matrix[j][k] -= v * matrix[i][k];
      }
  }
  return matrix.map((r) => r[8]);
}
function quadTransform(quad) {
  const rows = [];
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].forEach(([u, v], i) => {
    const { x, y } = quad[i];
    rows.push([u, v, 1, 0, 0, 0, -x * u, -x * v, x], [0, 0, 0, u, v, 1, -y * u, -y * v, y]);
  });
  const a = solve(rows);
  if (!a) return null;
  return (u, v) => ({
    x: (a[0] * u + a[1] * v + a[2]) / (a[6] * u + a[7] * v + 1),
    y: (a[3] * u + a[4] * v + a[5]) / (a[6] * u + a[7] * v + 1),
  });
}
function detectMarkers(image, threshold = 110) {
  const w = image.width,
    h = image.height,
    gray = grayPixels(image),
    seen = new Uint8Array(w * h),
    results = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || gray[start] >= threshold) continue;
    let head = 0;
    const queue = [start];
    seen[start] = 1;
    let tl = null,
      tr = null,
      br = null,
      bl = null;
    while (head < queue.length) {
      const i = queue[head++],
        x = i % w,
        y = Math.floor(i / w),
        p = { x, y };
      if (!tl || x + y < tl.x + tl.y) tl = p;
      if (!br || x + y > br.x + br.y) br = p;
      if (!tr || x - y > tr.x - tr.y) tr = p;
      if (!bl || x - y < bl.x - bl.y) bl = p;
      for (const j of [
        x ? i - 1 : -1,
        x < w - 1 ? i + 1 : -1,
        y ? i - w : -1,
        y < h - 1 ? i + w : -1,
      ])
        if (j >= 0 && !seen[j] && gray[j] < threshold) {
          seen[j] = 1;
          queue.push(j);
        }
    }
    if (queue.length < 70 || queue.length > w * h * 0.7) continue;
    const quad = [tl, tr, br, bl],
      edge = (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
      sizes = quad.map((p, i) => edge(p, quad[(i + 1) % 4]));
    if (Math.min(...sizes) < 20 || Math.max(...sizes) / Math.min(...sizes) > 3) continue;
    const map = quadTransform(quad);
    if (!map) continue;
    const grid = [];
    for (let y = 0; y < 6; y++)
      for (let x = 0; x < 6; x++) {
        let sum = 0;
        for (const dy of [-0.12, 0, 0.12])
          for (const dx of [-0.12, 0, 0.12]) {
            const p = map((x + 0.5 + dx) / 6, (y + 0.5 + dy) / 6),
              px = Math.max(0, Math.min(w - 1, Math.round(p.x))),
              py = Math.max(0, Math.min(h - 1, Math.round(p.y)));
            sum += gray[py * w + px];
          }
        grid.push(sum / 9 >= threshold ? 1 : 0);
      }
    if (grid.some((v, i) => (i < 6 || i >= 30 || i % 6 === 0 || i % 6 === 5) && v)) continue;
    const bits = [];
    for (let y = 1; y < 5; y++) for (let x = 1; x < 5; x++) bits.push(grid[y * 6 + x]);
    results.push({ ...decodeMarker(bits), bits, quad });
  }
  return results.sort((a, b) => a.errors - b.errors);
}

// Place compact numbered tags near detections without clipping or covering another tag.
function detectionTags(boxes, width, height) {
  const scale = Math.min(Math.max(0.25, width / 420), height / 24),
    w = Math.min(width, 30 * scale),
    h = Math.min(height, 22 * scale),
    gap = 2 * scale,
    placed = [];
  return boxes.map((b, i) => {
    const x = Math.max(0, Math.min(width - w, b.x)),
      y = Math.max(0, Math.min(height - h, b.y - h)),
      candidates = [{ x, y }];
    for (let gy = 0; gy <= height - h; gy += h + gap)
      for (let gx = 0; gx <= width - w; gx += w + gap) candidates.push({ x: gx, y: gy });
    candidates.sort((a, c) => (a.x - x) ** 2 + (a.y - y) ** 2 - ((c.x - x) ** 2 + (c.y - y) ** 2));
    const pos = candidates.find((a) =>
      placed.every(
        (r) =>
          a.x + w + gap <= r.x ||
          a.x >= r.x + r.w + gap ||
          a.y + h + gap <= r.y ||
          a.y >= r.y + r.h + gap,
      ),
    );
    if (!pos) return null;
    const tag = { ...pos, w, h, scale, number: i + 1 };
    placed.push(tag);
    return tag;
  });
}

export {
  grayPixels,
  imageOperation,
  imageFeatures,
  trainImageClassifier,
  classifyImage,
  ARUCO_CODES,
  markerBits,
  rotateBits,
  decodeMarker,
  quadTransform,
  detectMarkers,
  detectionTags,
};
