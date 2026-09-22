// Rectified pinhole RGB-D teaching model. Depth is optical-axis Z in metres.
// The rendered depth is ideal geometry, not a claim to run stereo matching.
//
// Image conventions: pixel (u, v) has u to the right and v downwards, index v * width + u.
// Camera frame: x right, y down, z forward (optical axis); the floor is at y = heightM.
// Depth maps are Float32Array with NaN for missing pixels; logs use null instead.

/** Simulated camera: 320x220 pixels, focal length 240 px, 75 mm stereo baseline, 0.34 m high. */
const DEPTH_CAMERA = {
  width: 320,
  height: 220,
  fx: 240,
  fy: 240,
  cx: 159.5,
  cy: 95.5,
  baseline: 0.075, // metres
  heightM: 0.34, // metres above the floor
  min: 0.25, // metres, nearest depth of the colour scale
  max: 5, // metres, farthest depth of the colour scale
};

const INVALID_DEPTH_COLOR = [45, 51, 62];
const NEAR_DEPTH_COLOR = [242, 173, 75];
const FAR_DEPTH_COLOR = [62, 99, 189];
const UNSELECTED_COLOR = [30, 44, 53];
const RGB_CHANNELS = 3;
const RGBA_CHANNELS = 4;
const OPAQUE = 255;

// Scene of rgbdScene(): a cardboard box (the target), a second box and a far dark cabinet.
// Boxes are axis-aligned [xMin, yMin, zMin, xMax, yMax, zMax] in camera metres.
const TARGET_LABEL = 1;
const BOX_COLOR = [183, 69, 46];
const CABINET_COLOR = [76, 111, 126];
const WALL_COLOR = [185, 198, 200];
const WALL_DEPTH = 4.5; // metres
const FLOOR_TILE_LIGHT = [123, 143, 145];
const FLOOR_TILE_DARK = [108, 129, 133];
const FLOOR_TILES_PER_METRE = 4;
const TAPE_COLOR = [226, 194, 147];
const LABEL_COLOR = [236, 225, 198];
const LOGO_COLOR = [27, 55, 68];
const TAPE_HALF_WIDTH = 0.022; // metres
const LABEL_HALF_WIDTH = 0.055; // metres
const LABEL_Y_MIN = 0.085; // metres below the optical axis
const LABEL_Y_MAX = 0.17;
const LOGO_Y = 0.125;
const LOGO_HALF_SIZE = 0.022;
const SIDE_FACE_SHADE = 0.78; // faces not facing the camera are darker
const FRONT_FACE_AXIS = 2; // hitBox() axis index of a z-facing face
const RED_DOMINANCE = 45; // red minus max(green, blue) for a pixel to count as "red"

// Limits for uploaded RGB-D logs.
const LOG_FORMAT = 'robo-lab-rgbd-v1';
const MAX_LOG_WIDTH = 640; // pixels
const MAX_LOG_HEIGHT = 480;
const MAX_LOG_DEPTH = 100; // metres
const MAX_TIME_OFFSET = 0.05; // seconds between the RGB and depth stamps

function stereoProjection(z, { focal = 240, baseline = 0.075, lateral = 0, center = 159.5 } = {}) {
  if (!(z > 0 && focal > 0 && baseline > 0))
    throw Error('正の奥行き・焦点距離・基線長が必要です。');
  // Each camera sits baseline / 2 either side of the optical centre of the stereo pair.
  const left = center + (focal * (lateral + baseline / 2)) / z;
  const right = center + (focal * (lateral - baseline / 2)) / z;
  return { left, right, disparity: left - right, depth: z };
}

function depthFromDisparity(disparity, focal = 240, baseline = 0.075) {
  if (disparity > 0 && Number.isFinite(disparity)) return (focal * baseline) / disparity;
  return null;
}

/** Warm (near) to cool (far) colour scale; invalid depths get a neutral grey. */
function depthColor(z, min = 0.25, max = 5) {
  if (!Number.isFinite(z) || z <= 0) return INVALID_DEPTH_COLOR;
  const t = Math.max(0, Math.min(1, (z - min) / (max - min)));
  return NEAR_DEPTH_COLOR.map((near, channel) =>
    Math.round(near * (1 - t) + FAR_DEPTH_COLOR[channel] * t),
  );
}

function depthImage(frame) {
  const data = new Uint8ClampedArray(frame.width * frame.height * RGBA_CHANNELS);
  for (let i = 0; i < frame.depth.length; i++) {
    data.set(depthColor(frame.depth[i]), i * RGBA_CHANNELS);
    data[i * RGBA_CHANNELS + 3] = OPAQUE;
  }
  return { width: frame.width, height: frame.height, data };
}

/** Back-projects pixel (u, v) to camera coordinates in metres, or null without depth. */
function depthPoint(frame, u, v) {
  const z = frame.depth[v * frame.width + u];
  const intrinsics = frame.intrinsics;
  if (!(z > 0 && Number.isFinite(z))) return null;
  return {
    x: ((u - intrinsics.cx) * z) / intrinsics.fx,
    y: ((v - intrinsics.cy) * z) / intrinsics.fy,
    z,
  };
}

/**
 * Ray/box slab test. Returns the distance along the ray (in units of the ray's z, since
 * rays have direction[2] = 1) and the axis of the face that was hit, or null when missed.
 */
function hitBox(origin, direction, box) {
  let near = 0;
  let far = Infinity;
  let axis = FRONT_FACE_AXIS;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(direction[a]) < 1e-10) {
      if (origin[a] < box[a] || origin[a] > box[a + 3]) return null;
    } else {
      const toMin = (box[a] - origin[a]) / direction[a];
      const toMax = (box[a + 3] - origin[a]) / direction[a];
      const entry = Math.min(toMin, toMax);
      if (entry > near) {
        near = entry;
        axis = a;
      }
      far = Math.min(far, Math.max(toMin, toMax));
    }
  }
  return far >= near && near > 0 ? { z: near, axis } : null;
}

function sceneObjects(targetZ) {
  return [
    {
      box: [-0.4, 0.02, targetZ, -0.02, 0.34, targetZ + 0.32],
      color: BOX_COLOR,
      label: TARGET_LABEL,
    },
    { box: [0.22, -0.08, 2.6, 0.85, 0.34, 2.98], color: BOX_COLOR, label: 2 },
    { box: [-0.95, -0.7, 3.4, -0.58, 0.34, 3.65], color: CABINET_COLOR, label: 3 },
  ];
}

/** Nearest surface along the pixel ray: wall, then floor, then the boxes. */
function castSceneRay(direction, cameraX, objects) {
  const camera = DEPTH_CAMERA;
  const origin = [cameraX, 0, 0];
  const hit = { z: WALL_DEPTH, color: WALL_COLOR, label: 0, axis: FRONT_FACE_AXIS };
  if (direction[1] > 0 && camera.heightM / direction[1] < hit.z) {
    hit.z = camera.heightM / direction[1];
    const tile =
      (Math.floor((cameraX + direction[0] * hit.z) * FLOOR_TILES_PER_METRE) +
        Math.floor(hit.z * FLOOR_TILES_PER_METRE)) %
      2;
    // `tile` is 0 or ±1 (the sum may be negative), so test truthiness, not equality with 1.
    hit.color = tile ? FLOOR_TILE_DARK : FLOOR_TILE_LIGHT;
  }
  for (const object of objects) {
    const boxHit = hitBox(origin, direction, object.box);
    if (boxHit && boxHit.z < hit.z) {
      hit.z = boxHit.z;
      hit.color = object.color;
      hit.label = object.label;
      hit.axis = boxHit.axis;
    }
  }
  return hit;
}

/** Tape, a shipping label and (on the target) a logo, painted by position on the box front. */
function boxSurfaceColor(hit, object, px, py, condition) {
  const center = (object.box[0] + object.box[3]) / 2;
  let color = hit.color;
  if (Math.abs(px - center) < TAPE_HALF_WIDTH) color = TAPE_COLOR;
  if (py > LABEL_Y_MIN && py < LABEL_Y_MAX && Math.abs(px - center) < LABEL_HALF_WIDTH)
    color = LABEL_COLOR;
  const onLogo = Math.abs(px - center) < TAPE_HALF_WIDTH && Math.abs(py - LOGO_Y) < LOGO_HALF_SIZE;
  if (hit.label === TARGET_LABEL && onLogo) color = LOGO_COLOR;
  if (condition === 'plain') color = BOX_COLOR;
  return color;
}

/** Depth failures of the lesson conditions: sparse holes, a textureless box or a glass one. */
function depthMissing(condition, label, u, v) {
  if (label !== TARGET_LABEL) return false;
  if (condition === 'holes') return (u * 7 + v * 11) % 17 < 6;
  return condition === 'plain' || condition === 'glass';
}

function rgbdScene({ targetZ = 1.2, cameraX = 0, condition = 'normal' } = {}) {
  const camera = DEPTH_CAMERA;
  const width = camera.width;
  const height = camera.height;
  const rgb = new Uint8ClampedArray(width * height * RGBA_CHANNELS);
  const depth = new Float32Array(width * height);
  const labels = new Uint8Array(width * height);
  const objects = sceneObjects(targetZ);
  for (let v = 0; v < height; v++)
    for (let u = 0; u < width; u++) {
      const i = v * width + u;
      const direction = [(u - camera.cx) / camera.fx, (v - camera.cy) / camera.fy, 1];
      const hit = castSceneRay(direction, cameraX, objects);
      const px = cameraX + direction[0] * hit.z;
      const py = direction[1] * hit.z;
      let color = hit.color;
      if (hit.label === 1 || hit.label === 2)
        color = boxSurfaceColor(hit, objects[hit.label - 1], px, py, condition);
      const shade = hit.axis === FRONT_FACE_AXIS ? 1 : SIDE_FACE_SHADE;
      rgb.set(
        color.map((channel) => Math.round(channel * shade)),
        i * RGBA_CHANNELS,
      );
      rgb[i * RGBA_CHANNELS + 3] = OPAQUE;
      labels[i] = hit.label;
      depth[i] = depthMissing(condition, hit.label, u, v) ? NaN : hit.z;
    }
  return {
    width,
    height,
    rgb,
    depth,
    labels,
    intrinsics: { fx: camera.fx, fy: camera.fy, cx: camera.cx, cy: camera.cy },
    source: 'simulation',
    condition,
    targetZ,
  };
}

/** Colour threshold ("red" pixels), optionally gated by depth; counts target vs background. */
function selectDepthPixels(frame, { useDepth = false, maxDepth = 1.8 } = {}) {
  const data = new Uint8ClampedArray(frame.rgb.length);
  let selected = 0;
  let target = 0;
  let background = 0;
  let unknown = 0;
  for (let i = 0; i < frame.depth.length; i++) {
    const p = i * RGBA_CHANNELS;
    const red = frame.rgb[p] - Math.max(frame.rgb[p + 1], frame.rgb[p + 2]) > RED_DOMINANCE;
    const valid = Number.isFinite(frame.depth[i]) && frame.depth[i] > 0;
    const keep = red && (!useDepth || (valid && frame.depth[i] <= maxDepth));
    if (red && !valid) unknown++;
    if (keep) {
      selected++;
      if (frame.labels?.[i] === TARGET_LABEL) target++;
      else background++;
    }
    const color = keep ? [frame.rgb[p], frame.rgb[p + 1], frame.rgb[p + 2]] : UNSELECTED_COLOR;
    data.set(color, p);
    data[p + 3] = OPAQUE;
  }
  return { width: frame.width, height: frame.height, data, selected, target, background, unknown };
}

/** Median depth of the middle half of a box, or null when fewer than half the pixels have depth. */
function depthInBox(frame, box) {
  const left = Math.max(0, Math.floor(box.x));
  const right = Math.min(frame.width, Math.ceil(box.right));
  const top = Math.max(0, Math.floor(box.y));
  const bottom = Math.min(frame.height, Math.ceil(box.bottom));
  const values = [];
  let total = 0;
  // Use the middle half to reduce the background; this is not segmentation.
  const marginX = (right - left) * 0.25;
  const marginY = (bottom - top) * 0.25;
  for (let y = Math.ceil(top + marginY); y < bottom - marginY; y++)
    for (let x = Math.ceil(left + marginX); x < right - marginX; x++) {
      total++;
      const z = frame.depth[y * frame.width + x];
      if (Number.isFinite(z) && z > 0) values.push(z);
    }
  values.sort((a, b) => a - b);
  const enough = values.length && values.length / total >= 0.5;
  return {
    depth: enough ? values[Math.floor(values.length / 2)] : null,
    valid: values.length,
    total,
  };
}

function checkLogHeader(input) {
  if (input?.format !== LOG_FORMAT || input.aligned !== true || input.depth_unit !== 'm')
    throw Error('RGBに位置合わせ済み・単位mのQUESTiX LAB RGB-Dログを選んでください。');
}

function checkLogSize(width, height) {
  const validWidth = Number.isInteger(width) && width >= 2 && width <= MAX_LOG_WIDTH;
  const validHeight = Number.isInteger(height) && height >= 2 && height <= MAX_LOG_HEIGHT;
  if (!validWidth || !validHeight) throw Error('画像は幅640・高さ480画素以内にしてください。');
}

function isByte(value) {
  return Number.isInteger(value) && value >= 0 && value <= 255;
}

function isLogDepth(value) {
  return value === null || (Number.isFinite(value) && value > 0 && value <= MAX_LOG_DEPTH);
}

function checkLogPixels(input, pixelCount) {
  const validRgb =
    Array.isArray(input.rgb) &&
    input.rgb.length === pixelCount * RGB_CHANNELS &&
    input.rgb.every(isByte);
  const validDepth =
    Array.isArray(input.depth) &&
    input.depth.length === pixelCount &&
    input.depth.every(isLogDepth);
  if (!validRgb || !validDepth) throw Error('RGBまたは奥行きの画素データが不正です。');
}

function checkLogIntrinsics(intrinsics, width, height) {
  const finite =
    intrinsics &&
    [intrinsics.fx, intrinsics.fy, intrinsics.cx, intrinsics.cy].every(Number.isFinite);
  const principalPointInside =
    finite &&
    intrinsics.cx >= 0 &&
    intrinsics.cx < width &&
    intrinsics.cy >= 0 &&
    intrinsics.cy < height;
  if (!finite || intrinsics.fx <= 0 || intrinsics.fy <= 0 || !principalPointInside)
    throw Error('画像サイズに対応する校正値を確認してください。');
}

function checkLogTimestamps(input) {
  if (
    !Number.isFinite(input.rgb_time) ||
    !Number.isFinite(input.depth_time) ||
    Math.abs(input.rgb_time - input.depth_time) > MAX_TIME_OFFSET
  )
    throw Error('RGBと奥行きの時刻差は50 ms以内にしてください。');
}

/** Checks an uploaded RGB-D log and converts it to the frame shape used by rgbdScene(). */
function validateRGBD(input) {
  checkLogHeader(input);
  const { width, height } = input;
  checkLogSize(width, height);
  const pixelCount = width * height;
  checkLogPixels(input, pixelCount);
  checkLogIntrinsics(input.intrinsics, width, height);
  checkLogTimestamps(input);
  const rgb = new Uint8ClampedArray(pixelCount * RGBA_CHANNELS);
  for (let i = 0; i < pixelCount; i++) {
    rgb.set(input.rgb.slice(i * RGB_CHANNELS, i * RGB_CHANNELS + RGB_CHANNELS), i * RGBA_CHANNELS);
    rgb[i * RGBA_CHANNELS + 3] = OPAQUE;
  }
  return {
    width,
    height,
    rgb,
    depth: Float32Array.from(input.depth, (z) => (z === null ? NaN : z)),
    intrinsics: { ...input.intrinsics },
    source: 'hardware',
  };
}

/** Inverse of validateRGBD(): a plain-JSON log with RGB triplets and null for missing depth. */
function rgbdLog(frame) {
  const rgb = [];
  for (let i = 0; i < frame.depth.length; i++)
    rgb.push(...frame.rgb.slice(i * RGBA_CHANNELS, i * RGBA_CHANNELS + RGB_CHANNELS));
  return {
    format: LOG_FORMAT,
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
