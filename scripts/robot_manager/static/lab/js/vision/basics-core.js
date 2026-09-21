import { floorSceneImage } from './scene.js';

// Small, deterministic image experiments. Detection always operates on pixels.
function blankImage(width = 320, height = 220, rgb = [222, 226, 228]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...rgb, 255], i * 4);
  return { width, height, data };
}
function cameraEffects(image, { exposure = 1, blur = 0, width = image.width } = {}) {
  const w = Math.max(16, Math.min(image.width, Math.round(width))),
    h = Math.max(1, Math.round((image.height * w) / image.width)),
    out = blankImage(w, h);
  // Area averaging avoids inventing detail when reducing resolution.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * image.width) / w),
        x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / w)),
        y0 = Math.floor((y * image.height) / h),
        y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / h));
      let sums = [0, 0, 0],
        n = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const k = (yy * image.width + xx) * 4;
          for (let c = 0; c < 3; c++) sums[c] += Math.min(255, image.data[k + c] * exposure);
          n++;
        }
      for (let c = 0; c < 3; c++) out.data[(y * w + x) * 4 + c] = sums[c] / n;
    }
  const r = Math.round((blur * w) / image.width);
  if (r) {
    const original = new Uint8ClampedArray(out.data);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let d = -r; d <= r; d++)
            sum += original[(y * w + Math.max(0, Math.min(w - 1, x + d))) * 4 + c];
          out.data[(y * w + x) * 4 + c] = sum / (r * 2 + 1);
        }
  }
  return out;
}
function brightnessHistogram(image) {
  const bins = Array(32).fill(0);
  for (let i = 0; i < image.data.length; i += 4) {
    const v = 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2];
    bins[Math.min(31, Math.floor(v / 8))]++;
  }
  return bins;
}
function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min;
  let h = 0;
  if (d) h = 60 * (max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return { h: (h + 360) % 360, s: max ? d / max : 0, v: max };
}
function colorMask(image, { method = 'hsv', hue = 8, tolerance = 22, roi = 0 } = {}) {
  const mask = new Uint8Array(image.width * image.height);
  for (let y = Math.floor(image.height * roi); y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const i = y * image.width + x,
        k = i * 4,
        r = image.data[k],
        g = image.data[k + 1],
        b = image.data[k + 2];
      if (method === 'rgb') mask[i] = r - Math.max(g, b) > 60 && r > 60 ? 1 : 0;
      else {
        const v = rgbToHsv(r, g, b),
          d = Math.abs(v.h - hue);
        mask[i] = Math.min(d, 360 - d) <= tolerance && v.s > 0.35 && v.v > 0.12 ? 1 : 0;
      }
    }
  return mask;
}
function morphology(mask, w, h, operation = 'none', radius = 1) {
  const pass = (src, dilate) => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 1;
        outer: for (let dy = -radius; dy <= radius; dy++)
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx,
              yy = y + dy,
              hit = xx >= 0 && xx < w && yy >= 0 && yy < h ? src[yy * w + xx] : 0;
            if (dilate && hit) {
              v = 1;
              break outer;
            }
            if (!dilate && !hit) {
              v = 0;
              break outer;
            }
          }
        out[y * w + x] = v;
      }
    return out;
  };
  if (operation === 'open') return pass(pass(mask, false), true);
  if (operation === 'close') return pass(pass(mask, true), false);
  if (operation === 'both')
    return morphology(morphology(mask, w, h, 'open', radius), w, h, 'close', radius);
  return new Uint8Array(mask);
}
function maskImage(mask, width, height) {
  const out = blankImage(width, height, [0, 0, 0]);
  for (let i = 0; i < mask.length; i++)
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = mask[i] * 255;
  return out;
}
function connectedRegions(mask, w, h, minArea = 1) {
  const seen = new Uint8Array(mask.length),
    queue = new Int32Array(mask.length),
    regions = [];
  for (let i = 0; i < mask.length; i++) {
    if (seen[i] || !mask[i]) continue;
    let head = 0,
      tail = 1,
      area = 0,
      sx = 0,
      sy = 0,
      x0 = w,
      x1 = 0,
      y0 = h,
      y1 = 0;
    queue[0] = i;
    seen[i] = 1;
    while (head < tail) {
      const k = queue[head++],
        x = k % w,
        y = Math.floor(k / w);
      area++;
      sx += x;
      sy += y;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      for (const n of [
        x > 0 ? k - 1 : -1,
        x + 1 < w ? k + 1 : -1,
        y > 0 ? k - w : -1,
        y + 1 < h ? k + w : -1,
      ])
        if (n >= 0 && !seen[n] && mask[n]) {
          seen[n] = 1;
          queue[tail++] = n;
        }
    }
    if (area >= minArea)
      regions.push({
        area,
        cx: sx / area,
        cy: sy / area,
        x: x0,
        y: y0,
        w: x1 - x0 + 1,
        h: y1 - y0 + 1,
      });
  }
  return regions.sort((a, b) => b.area - a.area);
}
function regionScene(scene = 'noise') {
  if (scene !== 'close') {
    const image = floorSceneImage(),
      { width: w, data } = image;
    // Human-authored evaluation boxes for the two floor mats, never input to the detector.
    const targets = [
      { x: 16, y: 127, w: 122, h: 62 },
      { x: 197, y: 132, w: 101, h: 60 },
    ];
    const rect = (x, y, rgb, size = 2) => {
      for (let dy = 0; dy < size; dy++)
        for (let dx = 0; dx < size; dx++) data.set([...rgb, 255], ((y + dy) * w + x + dx) * 4);
    };
    if (scene === 'noise' || scene === 'dark') {
      for (let n = 0; n < 36; n++) rect(8 + ((n * 79) % 300), 8 + ((n * 47) % 204), [212, 45, 35]);
      for (const [x, y] of [
        [90, 143],
        [99, 154],
        [113, 167],
        [220, 151],
        [233, 161],
        [249, 178],
      ])
        rect(x, y, [210, 212, 210], 3);
    }
    if (scene === 'dark') for (let i = 0; i < data.length; i++) if (i % 4 !== 3) data[i] *= 0.3;
    return { image, targets };
  }
  // Synthetic close-object fixture retained for algorithm regression checks only.
  const image = blankImage(),
    { width: w, height: h, data } = image,
    targets =
      scene === 'close'
        ? [
            { x: 80, y: 105, w: 65, h: 65 },
            { x: 148, y: 105, w: 65, h: 65 },
          ]
        : [
            { x: 57, y: 100, w: 63, h: 76 },
            { x: 203, y: 120, w: 55, h: 62 },
          ];
  const rect = (r, rgb) => {
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) data.set([...rgb, 255], (y * w + x) * 4);
  };
  targets.forEach((r) => rect(r, [212, 66, 45]));
  rect({ x: 220, y: 24, w: 56, h: 34 }, [212, 66, 45]);
  if (scene === 'noise' || scene === 'dark') {
    for (let n = 0; n < 54; n++) {
      const x = 6 + ((n * 79) % 302),
        y = 6 + ((n * 47) % 206);
      rect({ x, y, w: 2, h: 2 }, [212, 66, 45]);
    }
    targets.forEach((r) => {
      for (let n = 0; n < 9; n++)
        rect(
          { x: r.x + 8 + (n % 3) * 16, y: r.y + 9 + Math.floor(n / 3) * 17, w: 3, h: 3 },
          [222, 226, 228],
        );
    });
  }
  if (scene === 'dark') for (let i = 0; i < data.length; i++) if (i % 4 !== 3) data[i] *= 0.35;
  return { image, targets };
}
function evaluateRegions(regions, targets) {
  const used = new Set();
  let found = 0;
  for (const r of regions) {
    const i = targets.findIndex((t, j) => {
      const overlap =
        Math.max(0, Math.min(r.x + r.w, t.x + t.w) - Math.max(r.x, t.x)) *
        Math.max(0, Math.min(r.y + r.h, t.y + t.h) - Math.max(r.y, t.y));
      return !used.has(j) && overlap / (r.w * r.h + t.w * t.h - overlap) > 0.65;
    });
    if (i >= 0) {
      used.add(i);
      found++;
    }
  }
  return { found, missed: targets.length - found, falsePositive: regions.length - found };
}
function projectedTarget({ distance = 1, width = 0.2, lateral = 0, focal = 250 } = {}) {
  const image = blankImage(),
    cx = 160 + (focal * lateral) / distance,
    cy = 110,
    size = (focal * width) / distance;
  for (let y = 0; y < 220; y++)
    for (let x = 0; x < 320; x++)
      if (Math.abs(x + 0.5 - cx) < size / 2 && Math.abs(y + 0.5 - cy) < size / 2)
        image.data.set([212, 66, 45, 255], (y * 320 + x) * 4);
  return { image, cx, cy, size };
}
function cameraGeometry(region, { focal = 250, knownWidth = 0.2, imageWidth = 320 } = {}) {
  return {
    angle: (Math.atan((region.cx - (imageWidth - 1) / 2) / focal) * 180) / Math.PI,
    depth: (focal * knownWidth) / region.w,
  };
}
function linePath(x) {
  return 0.36 * Math.sin(x * 1.6);
}
function lineCamera(pose, { gap = false, shadow = false } = {}) {
  const w = 120,
    h = 90,
    f = 95,
    pitch = Math.PI / 4,
    height = 0.25,
    image = blankImage(w, h),
    co = Math.cos(pose.theta),
    si = Math.sin(pose.theta),
    cp = Math.cos(pitch),
    sp = Math.sin(pitch);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ry = (y + 0.5 - h / 2) / f,
        down = sp + ry * cp,
        forward = cp - ry * sp;
      if (down <= 0 || forward <= 0) continue;
      const t = height / down,
        d = t * forward,
        l = (-t * (x + 0.5 - w / 2)) / f,
        wx = pose.x + co * d - si * l,
        wy = pose.y + si * d + co * l;
      const on =
          wx >= 0 &&
          wx < 5 &&
          Math.abs(wy - linePath(wx)) < 0.035 &&
          !(gap && wx > 1.9 && wx < 2.4),
        v = on ? 30 : shadow && wx > 1 && wx < 1.6 ? 112 : 225;
      image.data.set([v, v, v, 255], (y * w + x) * 4);
    }
  return image;
}
function lineObservation(image, { threshold = 90 } = {}) {
  const w = image.width,
    h = image.height,
    mask = new Uint8Array(w * h);
  let count = 0,
    sx = 0;
  for (let y = Math.floor(h * 0.62); y < Math.floor(h * 0.84); y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (image.data[i * 4] < threshold) {
        mask[i] = 1;
        sx += x;
        count++;
      }
    }
  const fraction = count / (w * (Math.floor(h * 0.84) - Math.floor(h * 0.62))),
    valid = count >= 8 && fraction < 0.55;
  return {
    mask,
    count,
    valid,
    cx: valid ? sx / count : null,
    error: valid ? (sx / count - (w - 1) / 2) / (w / 2) : null,
  };
}
function followCommand(observation, { speed = 0.35, gain = 2 } = {}) {
  if (!observation.valid) return { left: 0, right: 0, omega: 0 };
  const omega = -gain * observation.error,
    left = speed - (omega * 0.32) / 2,
    right = speed + (omega * 0.32) / 2,
    scale = Math.max(1, Math.abs(left) / 0.8, Math.abs(right) / 0.8);
  return { left: left / scale, right: right / scale, omega: omega / scale };
}
function runLineTrial({
  speed = 0.35,
  gain = 2,
  threshold = 90,
  gap = false,
  shadow = false,
} = {}) {
  const pose = { x: 0, y: 0, theta: 0 },
    frames = [],
    dt = 0.1;
  let reason = '時間内に到着せず',
    errorSum = 0;
  for (let n = 0; n < 400; n++) {
    const image = lineCamera(pose, { gap, shadow }),
      observation = lineObservation(image, { threshold }),
      command =
        pose.x >= 4.5
          ? { left: 0, right: 0, omega: 0 }
          : followCommand(observation, { speed, gain });
    frames.push({
      pose: { ...pose },
      observation: {
        valid: observation.valid,
        cx: observation.cx,
        error: observation.error,
        count: observation.count,
      },
      command,
      time: n * dt,
    });
    errorSum += Math.abs(pose.y - linePath(pose.x));
    if (pose.x >= 4.5) {
      reason = 'ゴールに到着';
      break;
    }
    if (!observation.valid) {
      reason = 'ラインを見失って停止';
      break;
    }
    const v = (command.left + command.right) / 2,
      mid = pose.theta + (command.omega * dt) / 2;
    pose.x += Math.cos(mid) * v * dt;
    pose.y += Math.sin(mid) * v * dt;
    pose.theta += command.omega * dt;
  }
  return {
    frames,
    reason,
    success: reason === 'ゴールに到着',
    meanError: errorSum / frames.length,
    seconds: frames.at(-1).time,
    options: { speed, gain, threshold, gap, shadow },
  };
}

export {
  blankImage,
  cameraEffects,
  brightnessHistogram,
  rgbToHsv,
  colorMask,
  morphology,
  maskImage,
  connectedRegions,
  regionScene,
  evaluateRegions,
  projectedTarget,
  cameraGeometry,
  linePath,
  lineCamera,
  lineObservation,
  followCommand,
  runLineTrial,
};
