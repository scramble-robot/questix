// Rectified pinhole RGB-D teaching model. Depth is optical-axis Z in metres.
// The rendered depth is ideal geometry, not a claim to run stereo matching.
const DEPTH_CAMERA = {
  width: 320,
  height: 220,
  fx: 240,
  fy: 240,
  cx: 159.5,
  cy: 95.5,
  baseline: 0.075,
  heightM: 0.34,
  min: 0.25,
  max: 5,
};
function stereoProjection(z, { focal = 240, baseline = 0.075, lateral = 0, center = 159.5 } = {}) {
  if (!(z > 0 && focal > 0 && baseline > 0))
    throw Error('正の奥行き・焦点距離・基線長が必要です。');
  const left = center + (focal * (lateral + baseline / 2)) / z,
    right = center + (focal * (lateral - baseline / 2)) / z;
  return { left, right, disparity: left - right, depth: z };
}
function depthFromDisparity(disparity, focal = 240, baseline = 0.075) {
  return disparity > 0 && Number.isFinite(disparity) ? (focal * baseline) / disparity : null;
}
function depthColor(z, min = 0.25, max = 5) {
  if (!Number.isFinite(z) || z <= 0) return [45, 51, 62];
  const t = Math.max(0, Math.min(1, (z - min) / (max - min)));
  return [
    Math.round(242 * (1 - t) + 62 * t),
    Math.round(173 * (1 - t) + 99 * t),
    Math.round(75 * (1 - t) + 189 * t),
  ];
}
function depthImage(frame) {
  const data = new Uint8ClampedArray(frame.width * frame.height * 4);
  for (let i = 0; i < frame.depth.length; i++) {
    data.set(depthColor(frame.depth[i]), i * 4);
    data[i * 4 + 3] = 255;
  }
  return { width: frame.width, height: frame.height, data };
}
function depthPoint(frame, u, v) {
  const z = frame.depth[v * frame.width + u],
    k = frame.intrinsics;
  if (!(z > 0 && Number.isFinite(z))) return null;
  return { x: ((u - k.cx) * z) / k.fx, y: ((v - k.cy) * z) / k.fy, z };
}
function hitBox(o, d, b) {
  let near = 0,
    far = Infinity,
    axis = 2;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-10) {
      if (o[a] < b[a] || o[a] > b[a + 3]) return null;
    } else {
      const n = (b[a] - o[a]) / d[a],
        f = (b[a + 3] - o[a]) / d[a],
        low = Math.min(n, f);
      if (low > near) {
        near = low;
        axis = a;
      }
      far = Math.min(far, Math.max(n, f));
    }
  }
  return far >= near && near > 0 ? { z: near, axis } : null;
}
function rgbdScene({ targetZ = 1.2, cameraX = 0, condition = 'normal' } = {}) {
  const k = DEPTH_CAMERA,
    w = k.width,
    h = k.height,
    rgb = new Uint8ClampedArray(w * h * 4),
    depth = new Float32Array(w * h),
    labels = new Uint8Array(w * h);
  const objects = [
    { b: [-0.4, 0.02, targetZ, -0.02, 0.34, targetZ + 0.32], color: [183, 69, 46], label: 1 },
    { b: [0.22, -0.08, 2.6, 0.85, 0.34, 2.98], color: [183, 69, 46], label: 2 },
    { b: [-0.95, -0.7, 3.4, -0.58, 0.34, 3.65], color: [76, 111, 126], label: 3 },
  ];
  for (let v = 0; v < h; v++)
    for (let u = 0; u < w; u++) {
      const i = v * w + u,
        d = [(u - k.cx) / k.fx, (v - k.cy) / k.fy, 1],
        o = [cameraX, 0, 0];
      let z = 4.5,
        color = [185, 198, 200],
        label = 0,
        axis = 2;
      if (d[1] > 0 && k.heightM / d[1] < z) {
        z = k.heightM / d[1];
        const tile = (Math.floor((cameraX + d[0] * z) * 4) + Math.floor(z * 4)) % 2;
        color = tile ? [108, 129, 133] : [123, 143, 145];
      }
      for (const obj of objects) {
        const hit = hitBox(o, d, obj.b);
        if (hit && hit.z < z) {
          z = hit.z;
          color = obj.color;
          label = obj.label;
          axis = hit.axis;
        }
      }
      const px = cameraX + d[0] * z,
        py = d[1] * z;
      if (label === 1 || label === 2) {
        const obj = objects[label - 1],
          center = (obj.b[0] + obj.b[3]) / 2;
        if (Math.abs(px - center) < 0.022) color = [226, 194, 147];
        if (py > 0.085 && py < 0.17 && Math.abs(px - center) < 0.055) color = [236, 225, 198];
        if (label === 1 && Math.abs(px - center) < 0.022 && Math.abs(py - 0.125) < 0.022)
          color = [27, 55, 68];
        if (condition === 'plain') color = [183, 69, 46];
      }
      const shade = axis === 2 ? 1 : 0.78;
      rgb.set(
        color.map((c) => Math.round(c * shade)),
        i * 4,
      );
      rgb[i * 4 + 3] = 255;
      labels[i] = label;
      const missing =
        (condition === 'holes' && label === 1 && (u * 7 + v * 11) % 17 < 6) ||
        (condition === 'plain' && label === 1) ||
        (condition === 'glass' && label === 1);
      depth[i] = missing ? NaN : z;
    }
  return {
    width: w,
    height: h,
    rgb,
    depth,
    labels,
    intrinsics: { fx: k.fx, fy: k.fy, cx: k.cx, cy: k.cy },
    source: 'simulation',
    condition,
    targetZ,
  };
}
function selectDepthPixels(frame, { useDepth = false, maxDepth = 1.8 } = {}) {
  const data = new Uint8ClampedArray(frame.rgb.length);
  let selected = 0,
    target = 0,
    background = 0,
    unknown = 0;
  for (let i = 0; i < frame.depth.length; i++) {
    const p = i * 4,
      red = frame.rgb[p] - Math.max(frame.rgb[p + 1], frame.rgb[p + 2]) > 45,
      valid = Number.isFinite(frame.depth[i]) && frame.depth[i] > 0;
    const keep = red && (!useDepth || (valid && frame.depth[i] <= maxDepth));
    if (red && !valid) unknown++;
    if (keep) {
      selected++;
      if (frame.labels?.[i] === 1) target++;
      else background++;
    }
    const color = keep ? [frame.rgb[p], frame.rgb[p + 1], frame.rgb[p + 2]] : [30, 44, 53];
    data.set(color, p);
    data[p + 3] = 255;
  }
  return { width: frame.width, height: frame.height, data, selected, target, background, unknown };
}
function depthInBox(frame, box) {
  const left = Math.max(0, Math.floor(box.x)),
    right = Math.min(frame.width, Math.ceil(box.right)),
    top = Math.max(0, Math.floor(box.y)),
    bottom = Math.min(frame.height, Math.ceil(box.bottom)),
    values = [];
  let total = 0;
  // Use the middle half to reduce the background; this is not segmentation.
  const mx = (right - left) * 0.25,
    my = (bottom - top) * 0.25;
  for (let y = Math.ceil(top + my); y < bottom - my; y++)
    for (let x = Math.ceil(left + mx); x < right - mx; x++) {
      total++;
      const z = frame.depth[y * frame.width + x];
      if (Number.isFinite(z) && z > 0) values.push(z);
    }
  values.sort((a, b) => a - b);
  return {
    depth:
      values.length && values.length / total >= 0.5 ? values[Math.floor(values.length / 2)] : null,
    valid: values.length,
    total,
  };
}
function validateRGBD(input) {
  if (input?.format !== 'robo-lab-rgbd-v1' || input.aligned !== true || input.depth_unit !== 'm')
    throw Error('RGBに位置合わせ済み・単位mのQUESTiX LAB RGB-Dログを選んでください。');
  const { width: w, height: h } = input;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2 || w > 640 || h > 480)
    throw Error('画像は幅640・高さ480画素以内にしてください。');
  const n = w * h;
  if (
    !Array.isArray(input.rgb) ||
    input.rgb.length !== n * 3 ||
    input.rgb.some((v) => !Number.isInteger(v) || v < 0 || v > 255) ||
    !Array.isArray(input.depth) ||
    input.depth.length !== n ||
    input.depth.some((v) => v !== null && (!Number.isFinite(v) || v <= 0 || v > 100))
  )
    throw Error('RGBまたは奥行きの画素データが不正です。');
  const k = input.intrinsics;
  if (
    !k ||
    ![k.fx, k.fy, k.cx, k.cy].every(Number.isFinite) ||
    k.fx <= 0 ||
    k.fy <= 0 ||
    k.cx < 0 ||
    k.cx >= w ||
    k.cy < 0 ||
    k.cy >= h
  )
    throw Error('画像サイズに対応する校正値を確認してください。');
  if (
    !Number.isFinite(input.rgb_time) ||
    !Number.isFinite(input.depth_time) ||
    Math.abs(input.rgb_time - input.depth_time) > 0.05
  )
    throw Error('RGBと奥行きの時刻差は50 ms以内にしてください。');
  const rgb = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    rgb.set(input.rgb.slice(i * 3, i * 3 + 3), i * 4);
    rgb[i * 4 + 3] = 255;
  }
  return {
    width: w,
    height: h,
    rgb,
    depth: Float32Array.from(input.depth, (z) => (z === null ? NaN : z)),
    intrinsics: { ...k },
    source: 'hardware',
  };
}
function rgbdLog(frame) {
  const rgb = [];
  for (let i = 0; i < frame.depth.length; i++) rgb.push(...frame.rgb.slice(i * 4, i * 4 + 3));
  return {
    format: 'robo-lab-rgbd-v1',
    width: frame.width,
    height: frame.height,
    aligned: true,
    depth_unit: 'm',
    rgb_time: 0,
    depth_time: 0,
    intrinsics: frame.intrinsics,
    rgb,
    depth: Array.from(frame.depth, (z) => (Number.isFinite(z) && z > 0 ? z : null)),
  };
}

export {
  DEPTH_CAMERA,
  stereoProjection,
  depthFromDisparity,
  depthColor,
  depthImage,
  depthPoint,
  rgbdScene,
  selectDepthPixels,
  depthInBox,
  validateRGBD,
  rgbdLog,
};
