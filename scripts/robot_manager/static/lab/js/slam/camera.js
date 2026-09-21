import { depthColor } from '../core/depth-core.js';

// Display-only RGB-D model. The SLAM estimator never receives this geometry.
// World: x/y on the floor, z up; positive yaw/bearing is left, image x is right.
const SLAM_CAMERA = {
  fov: Math.PI / 2,
  height: 0.24,
  forward: 0.12,
  wallHeight: 1.1,
  markerSize: 0.32,
};
function slamSceneRects(scene) {
  const { width: w, height: h, walls = [] } = scene;
  return [
    [-1, -1, 0, h + 1],
    [w, -1, w + 1, h + 1],
    [-1, -1, w + 1, 0],
    [-1, h, w + 1, h + 1],
    ...walls.map((b) => [b.x, b.y, b.x + b.w, b.y + b.h]),
  ];
}
function hitRect(p, angle, rect) {
  const dx = Math.cos(angle),
    dy = Math.sin(angle);
  let near = -Infinity,
    far = Infinity,
    side = 0;
  for (const [axis, v, d, lo, hi] of [
    [0, p.x, dx, rect[0], rect[2]],
    [1, p.y, dy, rect[1], rect[3]],
  ]) {
    if (Math.abs(d) < 1e-10) {
      if (v < lo || v > hi) return null;
    } else {
      const t0 = (lo - v) / d,
        t1 = (hi - v) / d,
        entry = Math.min(t0, t1);
      if (entry > near) {
        near = entry;
        side = axis;
      }
      far = Math.min(far, Math.max(t0, t1));
    }
  }
  return far >= Math.max(near, 0) && near >= 0 ? { distance: near, side } : null;
}
function cameraRay(rects, p, angle) {
  let best = null;
  rects.forEach((r, i) => {
    const hit = hitRect(p, angle, r);
    if (hit && (!best || hit.distance < best.distance)) best = { ...hit, shelf: i >= 4 };
  });
  return best;
}
function cameraView(pose, width = 800, height = 320) {
  const { forward, fov } = SLAM_CAMERA;
  return {
    x: pose.x + forward * Math.cos(pose.theta),
    y: pose.y + forward * Math.sin(pose.theta),
    theta: pose.theta,
    width,
    height,
    focal: width / (2 * Math.tan(fov / 2)),
    horizon: height * 0.42,
  };
}
function cameraProject(view, point) {
  const dx = point.x - view.x,
    dy = point.y - view.y,
    depth = dx * Math.cos(view.theta) + dy * Math.sin(view.theta),
    left = -dx * Math.sin(view.theta) + dy * Math.cos(view.theta);
  if (depth <= 0.015) return null;
  return {
    x: view.width / 2 - (view.focal * left) / depth,
    y: view.horizon - (view.focal * ((point.z || 0) - SLAM_CAMERA.height)) / depth,
    depth,
  };
}
function cameraGroundPoint(view, x, y) {
  if (y <= view.horizon) return null;
  const depth = (SLAM_CAMERA.height * view.focal) / (y - view.horizon),
    right = (x - view.width / 2) / view.focal;
  return {
    x: view.x + depth * (Math.cos(view.theta) + right * Math.sin(view.theta)),
    y: view.y + depth * (Math.sin(view.theta) - right * Math.cos(view.theta)),
    depth,
  };
}
function slamCameraObservation(scene, pose) {
  const view = cameraView(pose),
    marker = scene.start,
    dx = marker.x - view.x,
    dy = marker.y - view.y,
    angle = Math.atan2(dy, dx),
    distance = Math.hypot(dx, dy),
    bearing = Math.atan2(Math.sin(angle - pose.theta), Math.cos(angle - pose.theta));
  const projected = cameraProject(view, { ...marker, z: 0 }),
    hit = cameraRay(slamSceneRects(scene), view, angle);
  const visible =
    !!projected &&
    projected.x >= 0 &&
    projected.x <= view.width &&
    projected.y >= 0 &&
    projected.y <= view.height &&
    (!hit || hit.distance >= distance - 0.01);
  return { visible, marker: 'START', bearing, distance };
}
function slamDepthAt(scene, pose, x, y, width = 800, height = 320) {
  const view = cameraView(pose, width, height),
    offset = Math.atan((x - width / 2) / view.focal),
    hit = cameraRay(slamSceneRects(scene), view, view.theta - offset);
  if (hit) {
    const z = hit.distance * Math.cos(offset),
      top = view.horizon - ((SLAM_CAMERA.wallHeight - SLAM_CAMERA.height) * view.focal) / z,
      bottom = view.horizon + (SLAM_CAMERA.height * view.focal) / z;
    if (y >= top && y <= bottom) return z >= 0.25 && z <= 5 ? z : null;
  }
  const ground = cameraGroundPoint(view, x, y);
  return ground && ground.depth >= 0.25 && ground.depth <= 5 ? ground.depth : null;
}
function drawSlamCamera(c, log, index, width = 800, height = 320, mode = 'rgb') {
  c.save();
  c.fillStyle = '#edf3f5';
  c.fillRect(0, 0, width, height);
  if (log.source !== 'simulation' || !log.scene || !log.reference?.[index]) {
    c.fillStyle = '#46636e';
    c.textAlign = 'center';
    c.font = '21px system-ui';
    c.fillText('画像は記録されていません', width / 2, height / 2 - 8);
    c.font = '15px system-ui';
    c.fillText('このログには、カメラの画像データが含まれていません。', width / 2, height / 2 + 24);
    c.restore();
    return;
  }
  const scene = log.scene,
    ref = log.reference[index],
    pose = { x: scene.start.x + ref.x, y: scene.start.y + ref.y, theta: ref.theta },
    view = cameraView(pose, width, height),
    rects = slamSceneRects(scene);
  if (mode === 'depth') {
    for (let y = 0; y < height; y += 5)
      for (let x = 0; x < width; x += 5) {
        const z = slamDepthAt(scene, pose, x + 2.5, y + 2.5, width, height);
        c.fillStyle = 'rgb(' + depthColor(z).join(',') + ')';
        c.fillRect(x, y, 6, 6);
      }
    c.fillStyle = '#102b35e8';
    c.fillRect(12, 12, 560, 32);
    c.fillStyle = '#e6eff3';
    c.font = '15px system-ui';
    c.textAlign = 'left';
    c.fillText('デプス（模擬）· 橙：近い / 青：遠い / 灰：範囲外・不明', 24, 34);
    c.restore();
    return;
  }
  c.fillStyle = '#59717c';
  c.fillRect(0, 0, width, view.horizon);
  c.fillStyle = '#3e545c';
  c.fillRect(0, view.horizon, width, height - view.horizon);
  // Project the floor in world coordinates, including the physical start marker.
  // This gives translation/rotation cues without inventing a recorded image.
  const cell = 3,
    half = SLAM_CAMERA.markerSize / 2;
  for (let y = Math.ceil(view.horizon) + 1; y < height; y += cell)
    for (let x = 0; x < width; x += cell) {
      const p = cameraGroundPoint(view, x + cell / 2, y + cell / 2),
        gx = ((p.x % 0.5) + 0.5) % 0.5,
        gy = ((p.y % 0.5) + 0.5) % 0.5;
      const grid = gx < 0.014 || gy < 0.014,
        alternate = (Math.floor(p.x / 0.5) + Math.floor(p.y / 0.5)) % 2 === 0;
      const shade = grid ? 76 : alternate ? 66 : 62;
      c.fillStyle = `rgb(${shade},${shade + 17},${shade + 20})`;
      const mx = (p.x - scene.start.x + half) / SLAM_CAMERA.markerSize,
        my = (p.y - scene.start.y + half) / SLAM_CAMERA.markerSize;
      if (mx >= 0 && mx < 1 && my >= 0 && my < 1) {
        const u = Math.floor(mx * 7),
          v = Math.floor(my * 7),
          border = u === 0 || v === 0 || u === 6 || v === 6,
          ink = (u < 3 && v < 3) || (u > 3 && v > 3) || (u === 4 && v === 2);
        c.fillStyle = border || !ink ? '#f0d38e' : '#1c3139';
      }
      c.fillRect(x, y, cell + 1, cell + 1);
    }
  // A pinhole ray for each strip: positive image x looks to the robot's right.
  // Walls are painted over the floor, so shelves occlude the marker naturally.
  for (let x = 0; x < width; x += 2) {
    const offset = Math.atan((x + 1 - width / 2) / view.focal),
      hit = cameraRay(rects, view, view.theta - offset);
    if (!hit) continue;
    const depth = Math.max(0.02, hit.distance * Math.cos(offset)),
      top = view.horizon - ((SLAM_CAMERA.wallHeight - SLAM_CAMERA.height) * view.focal) / depth,
      bottom = view.horizon + (SLAM_CAMERA.height * view.focal) / depth;
    const shade = Math.round(94 / (1 + depth * 0.13) + (hit.side ? 14 : 0)),
      tint = hit.shelf ? [0, 11, 18] : [18, 23, 24];
    // Slight overlap prevents antialiasing seams when the responsive canvas scales.
    c.fillStyle = `rgb(${shade + tint[0]},${shade + tint[1]},${shade + tint[2]})`;
    c.fillRect(x, top, 3, bottom - top);
    c.fillStyle = hit.shelf ? '#607b89' : '#91a3a8';
    c.fillRect(x, bottom - 2, 3, 2);
  }
  c.fillStyle = '#102b35d9';
  c.fillRect(14, 12, 310, 33);
  c.fillStyle = '#e1eef1';
  c.font = '15px system-ui';
  c.textAlign = 'left';
  c.fillText('RGB-DカメラのRGB映像（模擬）', 25, 34);
  c.strokeStyle = '#dcecf17a';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(width / 2 - 6, view.horizon);
  c.lineTo(width / 2 + 6, view.horizon);
  c.moveTo(width / 2, view.horizon - 6);
  c.lineTo(width / 2, view.horizon + 6);
  c.stroke();
  c.restore();
}

export {
  SLAM_CAMERA,
  slamSceneRects,
  cameraRay,
  cameraView,
  cameraProject,
  cameraGroundPoint,
  slamCameraObservation,
  slamDepthAt,
  drawSlamCamera,
};
