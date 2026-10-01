// Units: metres, seconds, radians; map y and heading are clockwise-positive.
const CONTROL_DT = 0.1,
  PHYSICS_DT = 0.01,
  SCAN_COUNT = 24;
const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const rpmToSpeed = (rpm, radius) => (rpm * 2 * Math.PI * radius) / 60;
const speedToRpm = (v, radius) => (v / (2 * Math.PI * radius)) * 60;
function randomGenerator(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng) {
  return Math.sqrt(-2 * Math.log(Math.max(1e-9, rng()))) * Math.cos(2 * Math.PI * rng());
}
const DEFAULT_PHYSICS = {
  radius: 0.065,
  track: 0.32,
  bodyRadius: 0.18,
  maxRpm: 80,
  accelRpm: 180,
  motorLag: 0.14,
  latency: 0.06,
  slip: 0.035,
  noise: 0.01,
  randomize: true,
};
const DEFAULT_REWARD = {
  success: 100,
  collision: 30,
  time: 1,
  progress: 25,
  heading: 5,
  settling: 0.3,
  careful: 1,
  clearance: 4,
  moving: 8,
  near: 8,
  orientation: true,
  threshold: 12,
  enabled: {
    success: true,
    collision: true,
    time: true,
    progress: true,
    heading: true,
    settling: true,
    careful: true,
    clearance: false,
    moving: false,
    near: false,
  },
};
const FEATURE_NAMES = [
  'goal_forward',
  'goal_left',
  'bearing_sin',
  'bearing_turn_cost',
  'distance',
  'dock_heading',
  'velocity',
  'yaw_rate',
  'front_obstacle',
  'left_front_obstacle',
  'right_front_obstacle',
  'left_obstacle',
  'right_obstacle',
  'rear_obstacle',
  'forward_alignment',
  'dock_lateral',
];
const FEATURES = FEATURE_NAMES.length,
  PARAMETERS = FEATURES * 2;
const COURSES = {
  standard: {
    name: '基本配置',
    delivery: [
      { x: 1.4, y: 0.7, w: 0.35, h: 1.15 },
      { x: 2.85, y: 1.45, w: 0.35, h: 1.05 },
    ],
    dock: [
      { x: 3.45, y: 0.65, w: 1, h: 0.22 },
      { x: 3.45, y: 2.35, w: 1, h: 0.22 },
    ],
  },
  open: { name: '広い通路', delivery: [{ x: 2.2, y: 1.15, w: 0.45, h: 1 }], dock: [] },
  turns: {
    name: '曲がり道',
    delivery: [
      { x: 1.4, y: 0.7, w: 0.35, h: 1.15 },
      { x: 2.85, y: 1.45, w: 0.35, h: 1.05 },
      { x: 2.05, y: 2.55, w: 1.2, h: 0.25 },
    ],
    dock: [
      { x: 3.45, y: 0.65, w: 1, h: 0.22 },
      { x: 3.45, y: 2.35, w: 1, h: 0.22 },
      { x: 1.7, y: 0.35, w: 0.35, h: 1 },
      { x: 2.5, y: 2.15, w: 0.6, h: 0.3 },
    ],
  },
};

class World {
  constructor(task = 'delivery', rewards = {}, physics = {}) {
    this.task = task;
    this.settings = {
      ...DEFAULT_REWARD,
      ...rewards,
      enabled: { ...DEFAULT_REWARD.enabled, ...rewards.enabled },
    };
    this.physics = { ...DEFAULT_PHYSICS, ...physics };
    this.width = 4.8;
    this.height = 3.2;
    this.goal =
      task === 'delivery'
        ? { x: 4.18, y: 0.62, theta: 0, radius: 0.2 }
        : { x: 4.05, y: 1.6, theta: 0, radius: 0.12 };
    this.marker = { x: this.goal.x + 0.3, y: this.goal.y };
    this.course = Object.hasOwn(COURSES, this.physics.course) ? this.physics.course : 'standard';
    this.walls = COURSES[this.course][task].map((w) => ({ ...w }));
    this.rects = this.walls.map((w) => [w.x, w.y, w.x + w.w, w.y + w.h]);
    this.rayRects = [
      ...this.rects,
      [-1, -1, 0, 5],
      [4.8, -1, 6, 5],
      [-1, -1, 6, 0],
      [-1, 3.2, 6, 5],
    ];
  }
  reset(
    seed = 1,
    { other = false, startRange = 0, randomize = this.physics.randomize, initial } = {},
  ) {
    this.rng = randomGenerator(seed);
    const r = this.rng,
      p = this.physics;
    const factor = (spread) => (randomize ? 1 + (r() * 2 - 1) * spread : 1);
    this.actual = {
      radiusL: p.radius * factor(0.025),
      radiusR: p.radius * factor(0.025),
      track: p.track * factor(0.025),
      lag: p.motorLag * factor(0.3),
      latency: p.latency * factor(0.5),
      gripL: 1 - p.slip * factor(0.7),
      gripR: 1 - p.slip * factor(0.7),
      gainL: factor(0.03),
      gainR: factor(0.03),
    };
    let x = 0.55 + r() * 0.22,
      y = this.task === 'delivery' ? 2.45 + r() * 0.2 : 1.9 + r() * 0.6,
      theta = (r() - 0.5) * 0.7;
    if ((other || startRange > 0) && !initial) {
      const range = other ? 1 : clamp(startRange, 0, 1);
      ({ x, y } = this.randomStart(r, range));
      theta = (r() * 2 - 1) * (0.35 + (Math.PI - 0.35) * range);
    }
    if (initial) {
      x = initial.x;
      y = initial.y;
      theta = initial.theta;
    }
    this.state = {
      x,
      y,
      theta,
      left: 0,
      right: 0,
      targetL: 0,
      targetR: 0,
      v: 0,
      omega: 0,
      t: 0,
      hold: 0,
      contact: false,
      latched: false,
      peak: 0,
      total: 0,
      done: false,
      success: false,
      wrongAngle: false,
      collisions: 0,
      ax: 0,
      ay: 0,
      estX: x,
      estY: y,
      estTheta: theta,
      roll: 0,
      pitch: 0,
      rollRate: 0,
      pitchRate: 0,
    };
    this.queue = [];
    this.gyroBias = (r() - 0.5) * 0.008;
    this.camera = null;
    this.cameraCounter = 0;
    this.scanCounter = 0;
    this.observe(true);
    return this.state;
  }
  ray(x, y, angle, max = 3.2) {
    const dx = Math.cos(angle),
      dy = Math.sin(angle);
    let best = max;
    for (const [x0, y0, x1, y1] of this.rayRects) {
      let a = -Infinity,
        b = Infinity;
      if (Math.abs(dx) < 1e-9) {
        if (x < x0 || x > x1) continue;
      } else {
        const t0 = (x0 - x) / dx,
          t1 = (x1 - x) / dx;
        a = Math.max(a, Math.min(t0, t1));
        b = Math.min(b, Math.max(t0, t1));
      }
      if (Math.abs(dy) < 1e-9) {
        if (y < y0 || y > y1) continue;
      } else {
        const t0 = (y0 - y) / dy,
          t1 = (y1 - y) / dy;
        a = Math.max(a, Math.min(t0, t1));
        b = Math.min(b, Math.max(t0, t1));
      }
      if (b >= Math.max(0, a) && a >= 0) best = Math.min(best, a);
    }
    return best;
  }
  startBounds(range = 0) {
    const m = this.physics.bodyRadius + 0.12,
      t = clamp(range, 0, 1),
      y0 = this.task === 'delivery' ? 2.45 : 1.9,
      y1 = this.task === 'delivery' ? 2.65 : 2.5;
    return {
      x0: 0.55 + (m - 0.55) * t,
      x1: 0.77 + (this.width - m - 0.77) * t,
      y0: y0 + (m - y0) * t,
      y1: y1 + (this.height - m - y1) * t,
    };
  }
  randomStart(rng = this.rng, range = 1) {
    const b = this.startBounds(range);
    for (let attempt = 0; attempt < 1000; attempt++) {
      const x = b.x0 + rng() * (b.x1 - b.x0),
        y = b.y0 + rng() * (b.y1 - b.y0);
      if (!this.blocked(x, y, 0.12) && Math.hypot(x - this.goal.x, y - this.goal.y) > 0.8)
        return { x, y };
    }
    throw new Error('No clear start position found');
  }
  blocked(x, y, clearance = 0) {
    const r = this.physics.bodyRadius + clearance;
    if (x < r || x > this.width - r || y < r || y > this.height - r) return true;
    for (const [x0, y0, x1, y1] of this.rects) {
      const dx = x - clamp(x, x0, x1),
        dy = y - clamp(y, y0, y1);
      if (dx * dx + dy * dy < r * r) return true;
    }
    return false;
  }
  observe(fresh = false) {
    const s = this.state,
      p = this.physics,
      noise = p.noise,
      r = this.rng;
    const imuNoise = () => gaussian(r) * noise;
    const gyro = -s.omega + this.gyroBias + imuNoise() * 0.3;
    const magneticTheta = s.theta + imuNoise() * 0.8;
    const pitch = s.pitch,
      roll = s.roll;
    const accel = [
      s.ax + 9.81 * Math.sin(pitch) + imuNoise() * 4,
      s.ay - 9.81 * Math.sin(roll) + imuNoise() * 4,
      9.81 * Math.cos(pitch) * Math.cos(roll) + imuNoise() * 4,
    ];
    this.imu = {
      accel,
      gyro: [(s.rollRate * 180) / Math.PI, (s.pitchRate * 180) / Math.PI, (gyro * 180) / Math.PI],
      mag: [25 * Math.cos(magneticTheta), 25 * Math.sin(magneticTheta), -40],
      yaw: -s.estTheta,
      pitch: s.pitch,
      roll: s.roll,
    };
    const scan = Array.from({ length: SCAN_COUNT }, (_, i) => {
      const d = this.ray(s.x, s.y, s.theta + (i * 2 * Math.PI) / SCAN_COUNT),
        n = gaussian(r) * noise;
      return d >= 3.2 ? 3.2 : clamp(d + n, 0.02, 3.2);
    });
    const dx = this.marker.x - s.x,
      dy = this.marker.y - s.y,
      dist = Math.hypot(dx, dy),
      bearing = wrap(Math.atan2(dy, dx) - s.theta);
    const visible =
      Math.abs(bearing) < (55 * Math.PI) / 180 &&
      dist < 5 &&
      this.ray(s.x, s.y, Math.atan2(dy, dx), 5) >= dist - 0.01 &&
      (noise === 0 || r() > 0.015);
    this.camera = visible
      ? {
          visible: true,
          id: this.task === 'delivery' ? 'D-01' : 'C-01',
          distance: Math.max(0.02, dist + gaussian(r) * noise * 1.5),
          bearing: bearing + gaussian(r) * noise,
          yaw: wrap(-s.theta + gaussian(r) * noise),
          age: 0,
        }
      : {
          visible: false,
          id: null,
          distance: null,
          bearing: null,
          yaw: null,
          age: (this.camera?.age || 0) + CONTROL_DT,
        };
    // Marker pose is a simulated camera measurement, not a policy access to ground truth.
    if (visible && !fresh) {
      const ct = -this.camera.yaw,
        ang = ct + this.camera.bearing,
        cx = this.marker.x - this.camera.distance * Math.cos(ang),
        cy = this.marker.y - this.camera.distance * Math.sin(ang);
      s.estX += 0.25 * (cx - s.estX);
      s.estY += 0.25 * (cy - s.estY);
      s.estTheta = wrap(s.estTheta + 0.15 * wrap(ct - s.estTheta));
    }
    this.observation = {
      scan,
      front: scan[0],
      left: scan[21],
      right: scan[3],
      camera: { ...this.camera },
      imu: this.imu,
      odometry: { x: s.estX, y: s.estY, theta: s.estTheta },
      wheelRpm: [speedToRpm(s.left, p.radius), speedToRpm(s.right, p.radius)],
      goal: { ...this.goal },
      task: this.task,
    };
    return this.observation;
  }
  step(command, { capture = false } = {}) {
    const s = this.state,
      p = this.physics,
      a = this.actual,
      dt = PHYSICS_DT;
    if (s.done || s.latched)
      return {
        state: s,
        reward: 0,
        done: true,
        success: s.success,
        emergency: s.latched,
        trace: [],
      };
    const oldD = Math.hypot(this.goal.x - s.x, this.goal.y - s.y),
      oldH = Math.abs(wrap(s.theta - this.goal.theta));
    this.queue.push({
      at: s.t + a.latency,
      left: clamp(command[0]) * p.maxRpm,
      right: clamp(command[1]) * p.maxRpm,
    });
    let collision = false,
      impact = 0,
      axPeak = 0,
      ayPeak = 0;
    const traces = [];
    for (let k = 0; k < 10; k++) {
      while (this.queue.length && this.queue[0].at <= s.t + 1e-9) {
        const q = this.queue.shift();
        s.targetL = q.left;
        s.targetR = q.right;
      }
      const oldV = s.v,
        oldOmega = s.omega;
      const desiredL = rpmToSpeed(s.targetL * a.gainL, a.radiusL),
        desiredR = rpmToSpeed(s.targetR * a.gainR, a.radiusR);
      const maxDelta = rpmToSpeed(p.accelRpm, p.radius) * dt;
      s.left += clamp(((desiredL - s.left) * dt) / Math.max(0.015, a.lag), -maxDelta, maxDelta);
      s.right += clamp(((desiredR - s.right) * dt) / Math.max(0.015, a.lag), -maxDelta, maxDelta);
      const groundL = s.left * a.gripL,
        groundR = s.right * a.gripR;
      let v = (groundL + groundR) / 2,
        omega = (groundL - groundR) / a.track;
      const middle = s.theta + (omega * dt) / 2,
        nx = s.x + Math.cos(middle) * v * dt,
        ny = s.y + Math.sin(middle) * v * dt;
      const contact = this.blocked(nx, ny);
      if (contact) {
        v = 0;
        omega = 0;
        s.left = 0;
        s.right = 0;
        if (!s.contact) {
          collision = true;
          s.collisions++;
        }
      } else {
        s.x = nx;
        s.y = ny;
        s.theta = wrap(s.theta + omega * dt);
      }
      s.contact = contact;
      s.v = v;
      s.omega = omega;
      s.ax = (v - oldV) / dt;
      s.ay = -v * omega;
      const measuredAx = clamp(s.ax + gaussian(this.rng) * p.noise * 4, -156.96, 156.96),
        measuredAy = clamp(s.ay + gaussian(this.rng) * p.noise * 4, -156.96, 156.96),
        magnitude = Math.hypot(measuredAx, measuredAy);
      if (magnitude > impact) {
        impact = magnitude;
        axPeak = measuredAx;
        ayPeak = measuredAy;
      }
      s.peak = Math.max(s.peak, magnitude);
      // A small compliant pitch/roll model; this is not a 3D rigid body solver.
      const targetPitch = clamp(-s.ax * 0.012, -0.08, 0.08),
        targetRoll = clamp(-s.ay * 0.012, -0.08, 0.08);
      s.pitchRate += (50 * (targetPitch - s.pitch) - 10 * s.pitchRate) * dt;
      s.pitch += s.pitchRate * dt;
      s.rollRate += (50 * (targetRoll - s.roll) - 10 * s.rollRate) * dt;
      s.roll += s.rollRate * dt;
      const measuredGyro = -omega + this.gyroBias + gaussian(this.rng) * p.noise * 0.3;
      s.estTheta = wrap(s.estTheta - measuredGyro * dt);
      const compass = s.theta + gaussian(this.rng) * p.noise;
      s.estTheta = wrap(s.estTheta + 0.012 * wrap(compass - s.estTheta));
      const encV = (s.left + s.right) / 2;
      s.estX += Math.cos(s.estTheta) * encV * dt;
      s.estY += Math.sin(s.estTheta) * encV * dt;
      s.t += dt;
      if (magnitude >= this.settings.threshold) {
        s.latched = true;
        s.left = 0;
        s.right = 0;
        s.targetL = 0;
        s.targetR = 0;
        s.v = 0;
        s.omega = 0;
        this.queue = [];
        s.done = true;
      }
      if (capture)
        traces.push({
          t: s.t,
          ax: measuredAx,
          ay: measuredAy,
          impact: magnitude,
          emergency: s.latched,
        });
      if (s.done) break;
    }
    const d = Math.hypot(this.goal.x - s.x, this.goal.y - s.y),
      angle = Math.abs(wrap(s.theta - this.goal.theta));
    const stationary = Math.abs(s.v) < 0.01 && Math.abs(s.omega) < 0.06;
    const within = d < this.goal.radius,
      aligned = this.task === 'delivery' || angle < (8 * Math.PI) / 180;
    s.hold =
      within && stationary && (aligned || !this.settings.orientation) ? s.hold + CONTROL_DT : 0;
    const rewarded = s.hold >= 0.5;
    if (rewarded) {
      s.done = true;
      s.success = aligned;
      s.wrongAngle = !aligned;
    }
    if (collision || s.t >= 35 - 1e-9) s.done = true;
    this.observe();
    const cfg = this.settings,
      on = cfg.enabled;
    const progress = on.progress ? (oldD - d) * cfg.progress : 0;
    const orientation =
      on.heading && this.task === 'dock' && cfg.orientation
        ? (oldH - angle) * cfg.heading * Math.exp(-d * 1.2)
        : 0;
    const settling =
      on.settling && within
        ? (1 - Math.min(1, Math.abs(s.v) / 0.2)) * CONTROL_DT * cfg.settling
        : 0;
    const speedPenalty = on.careful
      ? (Math.abs(s.omega) * 0.025 * CONTROL_DT + Math.max(0, -s.v) * 0.5 * CONTROL_DT) *
        cfg.careful
      : 0;
    const pieces = [
      { text: '目標への接近', value: progress },
      { text: '経過時間', value: on.time ? -cfg.time * CONTROL_DT : 0 },
      { text: '向き・停止', value: orientation + settling },
      { text: '旋回・後退', value: -speedPenalty },
    ];
    const clearance = Math.max(0, Math.min(...this.observation.scan) - p.bodyRadius);
    if (on.clearance)
      pieces.push({
        text: '障害物への接近',
        value: -cfg.clearance * CONTROL_DT * Math.max(0, 1 - clearance / 0.4) ** 2,
      });
    if (on.moving && Math.abs(s.v) > 0.06)
      pieces.push({ text: '動いている時間', value: cfg.moving * CONTROL_DT });
    if (on.near && d < 0.6)
      pieces.push({ text: '目標の近くにいる時間', value: cfg.near * CONTROL_DT });
    if (collision && on.collision) pieces.push({ text: '接触', value: -cfg.collision });
    if (rewarded && on.success)
      pieces.push({ text: s.success ? '到着して停止' : '位置と停止', value: cfg.success });
    if (s.done && on.progress)
      pieces.push({ text: '終了時の残り距離', value: -d * cfg.progress * 0.32 });
    if (s.done && on.heading && this.task === 'dock' && cfg.orientation)
      pieces.push({ text: '終了時の向き', value: -angle * Math.exp(-d) * cfg.heading });
    const reward = pieces.reduce((sum, p) => sum + p.value, 0);
    s.total += reward;
    return {
      state: s,
      reward,
      pieces,
      done: s.done,
      success: s.success,
      collision,
      emergency: s.latched,
      impact,
      axPeak,
      ayPeak,
      trace: traces,
      wrongAngle: s.wrongAngle,
    };
  }
  snapshot() {
    return { state: { ...this.state }, observation: structuredClone(this.observation) };
  }
}

// Fixed continuous features are shared by browser and exported policy inference.
function features(o) {
  const { x, y, theta } = o.odometry,
    dx = o.goal.x - x,
    dy = o.goal.y - y,
    d = Math.hypot(dx, dy),
    bearing = wrap(Math.atan2(dy, dx) - theta),
    gate = Math.min(1, d / 0.5),
    near = Math.exp(-d * 1.3);
  const proximity = (i) => clamp((0.75 - o.scan[i]) / 0.6, 0, 1);
  const heading = wrap(o.goal.theta - theta),
    dock = o.task === 'dock' ? 1 : 0;
  return [
    clamp((dx * Math.cos(theta) + dy * Math.sin(theta)) / 2),
    clamp((-dx * Math.sin(theta) + dy * Math.cos(theta)) / 2),
    Math.sin(bearing) * gate,
    (1 - Math.cos(bearing)) * gate,
    Math.min(1, d / 2),
    Math.sin(heading) * near * dock,
    (o.wheelRpm[0] + o.wheelRpm[1]) / 160,
    o.imu.gyro[2] / 180,
    proximity(0),
    proximity(21),
    proximity(3),
    proximity(18),
    proximity(6),
    proximity(12),
    Math.cos(bearing) * gate,
    (dy * Math.cos(o.goal.theta) - dx * Math.sin(o.goal.theta)) * near * dock,
  ];
}
function act(weights, observation) {
  const f = features(observation);
  let v = 0,
    w = 0;
  for (let i = 0; i < FEATURES; i++) {
    v += weights[i] * f[i];
    w += weights[FEATURES + i] * f[i];
  }
  v = Math.tanh(v);
  w = Math.tanh(w) * 0.7;
  return [clamp(v + w), clamp(v - w)];
}
function rollout(
  world,
  weights,
  seed = 10,
  { other = false, startRange = 0, capture = false, initial, randomize } = {},
) {
  world.reset(seed, { other, startRange, initial, randomize });
  const trace = [];
  let last,
    previousCommand = [0, 0],
    commandChange = 0;
  if (capture) trace.push({ ...world.snapshot(), reward: 0, pieces: [], impact: 0 });
  for (let i = 0; i < 350; i++) {
    const cmd = act(weights, world.observation);
    commandChange +=
      ((Math.abs(cmd[0] - previousCommand[0]) + Math.abs(cmd[1] - previousCommand[1])) *
        world.physics.maxRpm) /
      2;
    previousCommand = cmd;
    last = world.step(cmd, { capture });
    if (capture)
      trace.push({
        ...world.snapshot(),
        reward: last.reward,
        pieces: last.pieces,
        impact: last.impact,
        axPeak: last.axPeak,
        ayPeak: last.ayPeak,
        events: last.trace,
        command: cmd,
      });
    if (last.done) break;
  }
  const s = world.state,
    d = Math.hypot(world.goal.x - s.x, world.goal.y - s.y);
  const score = s.total;
  return {
    score,
    totalReward: s.total,
    success: s.success,
    collision: s.collisions > 0,
    emergency: s.latched,
    wrongAngle: s.wrongAngle,
    time: s.t,
    commandRate: s.t > 0 ? commandChange / s.t : 0,
    distance: d,
    angle: (Math.abs(wrap(s.theta)) * 180) / Math.PI,
    trace,
  };
}
// Quality statistics are conditioned on successful arrival; failures remain in the success rate.
function summarizeEvaluation(results) {
  const completed = results.filter((r) => r.success),
    count = results.length,
    successCount = completed.length;
  const average = (key) =>
    successCount ? completed.reduce((sum, r) => sum + r[key], 0) / successCount : null;
  return {
    rate: count ? (successCount / count) * 100 : 0,
    count,
    successCount,
    arrivalTime: average('time'),
    commandRate: average('commandRate'),
  };
}
class Trainer {
  constructor(task, rewards, physics, seed = 42, { startMode = 'near' } = {}) {
    this.world = new World(task, rewards, physics);
    this.weights = new Float64Array(PARAMETERS);
    this.rng = randomGenerator(seed);
    this.iterations = 0;
    this.episodes = 0;
    this.history = [];
    this.bestScore = -Infinity;
    this.bestWeights = this.weights.slice();
    this.startMode = startMode;
    this.phaseStartIterations = 0;
    this.historyStartEpisodes = 0;
  }
  setStartMode(next) {
    if (next === this.startMode) return;
    this.startMode = next;
    this.weights = this.bestWeights.slice();
    this.bestScore = -Infinity;
    this.history = [];
    this.historyStartEpisodes = this.episodes;
    this.phaseStartIterations = this.iterations;
  }
  get startRange() {
    return this.startMode === 'varied'
      ? Math.min(1, 0.2 + (this.iterations - this.phaseStartIterations) * 0.008)
      : 0;
  }
  iteration() {
    const dirs = 12,
      top = 6,
      noise = 0.15,
      step = 0.065,
      results = [],
      batch = { count: 0, success: 0, collision: 0, unreached: 0, rewardSum: 0 },
      varied = this.startMode === 'varied',
      startRange = this.startRange;
    for (let n = 0; n < dirs; n++) {
      const seed = varied ? 5000 + this.iterations * 12 + n : 500 + (this.iterations % 5) * 997,
        delta = Float64Array.from({ length: PARAMETERS }, () => gaussian(this.rng));
      const plus = this.weights.map((w, i) => w + noise * delta[i]),
        minus = this.weights.map((w, i) => w - noise * delta[i]);
      const positive = rollout(this.world, plus, seed, { startRange }),
        negative = rollout(this.world, minus, seed, { startRange }),
        rp = positive.score,
        rm = negative.score;
      for (const r of [positive, negative]) {
        batch.count++;
        batch.rewardSum += r.totalReward;
        if (r.success) batch.success++;
        else if (r.collision) batch.collision++;
        else batch.unreached++;
      }
      results.push({ delta, rp, rm });
      this.episodes += 2;
    }
    this.lastBatch = { ...batch, meanReward: batch.rewardSum / batch.count };
    results.sort((a, b) => Math.max(b.rp, b.rm) - Math.max(a.rp, a.rm));
    const selected = results.slice(0, top),
      returns = selected.flatMap((r) => [r.rp, r.rm]),
      mean = returns.reduce((a, b) => a + b, 0) / returns.length,
      std = Math.max(
        1,
        Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length),
      );
    for (let i = 0; i < PARAMETERS; i++) {
      let update = 0;
      for (const r of selected) update += (r.rp - r.rm) * r.delta[i];
      this.weights[i] = clamp(this.weights[i] + (step / (top * std)) * update, -8, 8);
    }
    this.iterations++;
    if (this.iterations % 5 === 0) {
      let score = 0;
      const validation = [];
      for (let j = 0; j < 5; j++) {
        const result = rollout(this.world, this.weights, 100 + j * 137, { other: varied });
        score += result.score;
        validation.push(result);
        this.episodes++;
      }
      score /= 5;
      if (score > this.bestScore) {
        this.bestScore = score;
        this.bestWeights = this.weights.slice();
      }
      this.history.push({
        episodes: this.episodes,
        score,
        startMode: this.startMode,
        ...summarizeEvaluation(validation),
      });
    }
    return {
      iterations: this.iterations,
      episodes: this.episodes,
      rate: this.history.at(-1)?.rate ?? 0,
    };
  }
  evaluate({ other = false, count = 20, weights = this.bestWeights } = {}) {
    const results = [];
    for (let i = 0; i < count; i++)
      results.push(rollout(this.world, weights, 90001 + i * 811, { other }));
    return { rate: (results.filter((r) => r.success).length / count) * 100, results };
  }
}

export {
  CONTROL_DT,
  clamp,
  wrap,
  rpmToSpeed,
  speedToRpm,
  randomGenerator,
  gaussian,
  DEFAULT_PHYSICS,
  DEFAULT_REWARD,
  FEATURE_NAMES,
  FEATURES,
  COURSES,
  World,
  features,
  act,
  rollout,
  summarizeEvaluation,
  Trainer,
  PHYSICS_DT,
  SCAN_COUNT,
  PARAMETERS,
};
