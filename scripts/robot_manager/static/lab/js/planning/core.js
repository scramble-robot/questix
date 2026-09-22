import { DEFAULT_PHYSICS } from '../core/engine.js';

// Geometry uses metres. The grid is only a planning representation; motion is continuous.
const PLAN_ROBOT = {
  radius: DEFAULT_PHYSICS.bodyRadius,
  track: DEFAULT_PHYSICS.track,
  wheelRadius: DEFAULT_PHYSICS.radius,
};
const PLAN_TOPICS = [
  { id: 'draw', label: '自分で道を決める', title: 'どこを通れば、棚をよけて進める？' },
  { id: 'width', label: '機体の幅を考える', title: '線が通れる場所を、ロボットも通れる？' },
  { id: 'margin', label: '余裕と距離を比べる', title: '障害物から、どれくらい離れて通る？' },
  { id: 'replan', label: '道を計画し直す', title: '途中で道がふさがったら、どうする？' },
  { id: 'room', label: '測った部屋で試す', title: '実際に測った部屋でも、道を計画できる？' },
];
function planningMap(topic = 'draw') {
  // The measured room is built from a recording (room-core.js); until one is opened the frame is
  // empty, with the start and goal where the other topics have them.
  if (topic === 'room')
    return { width: 6, height: 4, start: { x: 0.6, y: 2 }, goal: { x: 5.4, y: 2 }, obstacles: [] };
  const narrow = ['margin', 'replan'].includes(topic);
  return {
    width: 6,
    height: 4,
    start: { x: 0.6, y: 2 },
    goal: { x: 5.4, y: 2 },
    obstacles: narrow
      ? [
          { x: 2.4, y: 0.85, w: 1.2, h: 0.9 },
          { x: 2.4, y: 2.25, w: 1.2, h: 0.9 },
        ]
      : [{ x: 2.4, y: 1.2, w: 1.2, h: 1.6 }],
  };
}
function planningDefaults(topic) {
  return {
    topic,
    body: topic !== 'width',
    margin: 0,
    algorithm: 'astar',
    replan: false,
    points: [],
    // Which measured room the run used (room topic only), so opening another recording marks
    // the result on screen as belonging to other conditions.
    room: '',
  };
}
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
function rectDistance(p, r) {
  return Math.hypot(
    Math.max(r.x - p.x, 0, p.x - r.x - r.w),
    Math.max(r.y - p.y, 0, p.y - r.y - r.h),
  );
}
function pointSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const k = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)),
  );
  return distance(p, { x: a.x + k * dx, y: a.y + k * dy });
}
function intersects(a, b, r) {
  let lo = 0;
  let hi = 1;
  for (const [p, d, min, max] of [
    [a.x, b.x - a.x, r.x, r.x + r.w],
    [a.y, b.y - a.y, r.y, r.y + r.h],
  ]) {
    if (Math.abs(d) < 1e-12) {
      if (p < min || p > max) return false;
    } else {
      let x = (min - p) / d;
      let y = (max - p) / d;
      if (x > y) [x, y] = [y, x];
      lo = Math.max(lo, x);
      hi = Math.min(hi, y);
      if (lo > hi) return false;
    }
  }
  return true;
}
function planningClearance(p, map) {
  return Math.min(
    p.x,
    p.y,
    map.width - p.x,
    map.height - p.y,
    ...map.obstacles.map((r) => rectDistance(p, r)),
  );
}
function segmentClearance(a, b, map) {
  let min = Math.min(
    a.x,
    a.y,
    map.width - a.x,
    map.height - a.y,
    b.x,
    b.y,
    map.width - b.x,
    map.height - b.y,
  );
  for (const r of map.obstacles) {
    if (intersects(a, b, r)) return 0;
    min = Math.min(
      min,
      rectDistance(a, r),
      rectDistance(b, r),
      ...[
        [r.x, r.y],
        [r.x + r.w, r.y],
        [r.x, r.y + r.h],
        [r.x + r.w, r.y + r.h],
      ].map(([x, y]) => pointSegment({ x, y }, a, b)),
    );
  }
  return min;
}
function planningLength(path) {
  return path.slice(1).reduce((s, p, i) => s + distance(path[i], p), 0);
}
class MinHeap {
  constructor() {
    this.items = [];
  }
  push(v) {
    const a = this.items;
    a.push(v);
    let i = a.length - 1;
    while (i) {
      const p = (i - 1) >> 1;
      if (a[p].f <= v.f) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = v;
  }
  pop() {
    const a = this.items;
    const first = a[0];
    const last = a.pop();
    if (a.length) {
      let i = 0;
      while (2 * i + 1 < a.length) {
        let child = 2 * i + 1;
        if (child + 1 < a.length && a[child + 1].f < a[child].f) child++;
        if (a[child].f >= last.f) break;
        a[i] = a[child];
        i = child;
      }
      a[i] = last;
    }
    return first;
  }
}
function planRoute(
  map,
  {
    start = map.start,
    goal = map.goal,
    radius = PLAN_ROBOT.radius,
    margin = 0,
    algorithm = 'astar',
    cell = 0.1,
  } = {},
) {
  const required = radius + margin;
  const cols = Math.round(map.width / cell) + 1;
  const rows = Math.round(map.height / cell) + 1;
  const n = cols * rows;
  const point = (id) => ({ x: (id % cols) * cell, y: Math.floor(id / cols) * cell });
  const blocked = new Uint8Array(n);
  const expanded = [];
  for (let id = 0; id < n; id++) blocked[id] = planningClearance(point(id), map) <= required + 1e-7;
  const result = (path, reason = '') => ({
    path,
    reason,
    expanded,
    blocked,
    cols,
    rows,
    cell,
    required,
    algorithm,
    length: planningLength(path),
  });
  if (planningClearance(start, map) <= required + 1e-7) return result([], 'start');
  if (planningClearance(goal, map) <= required + 1e-7) return result([], 'goal');
  function connector(p) {
    let best = -1;
    let d = Infinity;
    for (let id = 0; id < n; id++) {
      const q = point(id);
      const next = distance(p, q);
      if (!blocked[id] && next < d && segmentClearance(p, q, map) > required + 1e-7) {
        best = id;
        d = next;
      }
    }
    return best;
  }
  const from = connector(start);
  const to = connector(goal);
  if (from < 0 || to < 0) return result([], 'blocked');
  const g = new Float64Array(n).fill(Infinity);
  const parents = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  g[from] = 0;
  const heuristic = (id) => {
    const x = Math.abs((id % cols) - (to % cols));
    const y = Math.abs(Math.floor(id / cols) - Math.floor(to / cols));
    return algorithm === 'dijkstra'
      ? 0
      : cell * (Math.max(x, y) + (Math.SQRT2 - 1) * Math.min(x, y));
  };
  heap.push({ id: from, f: heuristic(from) });
  const dirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  while (heap.items.length) {
    const { id } = heap.pop();
    if (closed[id]) continue;
    closed[id] = 1;
    expanded.push(point(id));
    if (id === to) {
      const raw = [];
      for (let j = id; j !== -1; j = parents[j]) raw.push(point(j));
      raw.reverse();
      raw.unshift({ ...start });
      raw.push({ ...goal });
      const path = [raw[0]];
      let index = 0;
      while (index < raw.length - 1) {
        let next = raw.length - 1;
        while (next > index + 1 && segmentClearance(raw[index], raw[next], map) <= required + 1e-7)
          next--;
        if (distance(path.at(-1), raw[next]) > 1e-8) path.push(raw[next]);
        index = next;
      }
      return { ...result(path), gridLength: g[to] };
    }
    const x = id % cols;
    const y = Math.floor(id / cols);
    const p = point(id);
    for (const [dx, dy] of dirs) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || xx >= cols || yy < 0 || yy >= rows) continue;
      const j = yy * cols + xx;
      if (blocked[j] || closed[j] || segmentClearance(p, point(j), map) <= required + 1e-7)
        continue;
      const cost = g[id] + cell * Math.hypot(dx, dy);
      if (cost + 1e-9 < g[j]) {
        g[j] = cost;
        parents[j] = id;
        heap.push({ id: j, f: cost + heuristic(j) });
      }
    }
  }
  return result([], 'blocked');
}
// `map` replaces the topic's built-in map (the measured room).
function planningExperiment(config, map = planningMap(config.topic)) {
  const cfg = {
    ...planningDefaults(config.topic),
    ...config,
    points: (config.points || []).map((p) => ({ ...p })),
  };
  const radius = cfg.body ? PLAN_ROBOT.radius : 0;
  const initial =
    cfg.topic === 'draw'
      ? { path: [map.start, ...cfg.points, map.goal], expanded: [], required: 0 }
      : planRoute(map, { radius, margin: cfg.margin, algorithm: cfg.algorithm });
  const first = {
    ...map.start,
    theta: 0,
    t: 0,
    left: 0,
    right: 0,
    travel: 0,
    clearance: planningClearance(map.start, map) - PLAN_ROBOT.radius,
    changed: false,
    phase: 'moving',
  };
  const out = {
    config: cfg,
    map,
    plan: initial,
    newPlan: null,
    eventIndex: null,
    samples: [first],
    status: 'no-path',
    distance: 0,
    time: 0,
    minimum: first.clearance,
  };
  if (!initial.path.length) return out;
  let path = initial.path;
  let index = 1;
  let pose = { ...first };
  let obstacles = map.obstacles;
  let changed = false;
  let extra = null;
  let total = 0;
  const dt = 0.04;
  const rpm = (v) => (v / (2 * Math.PI * PLAN_ROBOT.wheelRadius)) * 60;
  const sample = (phase, left = 0, right = 0) => {
    pose = {
      ...pose,
      t: pose.t + dt,
      left,
      right,
      travel: total,
      clearance: Math.max(0, planningClearance(pose, { ...map, obstacles }) - PLAN_ROBOT.radius),
      changed,
      phase,
    };
    out.samples.push(pose);
    out.minimum = Math.min(out.minimum, pose.clearance);
  };
  for (let tick = 0; tick < 6000; tick++) {
    if (cfg.topic === 'replan' && !changed && pose.x >= 1.5) {
      changed = true;
      extra = { x: 2.55, y: 1.75, w: 0.45, h: 0.5 };
      obstacles = [...map.obstacles, extra];
      out.obstacle = extra;
      out.eventIndex = out.samples.length;
      sample('obstacle');
      if (!cfg.replan) {
        out.status = 'blocked';
        break;
      }
      out.newPlan = planRoute(
        { ...map, obstacles },
        { start: pose, radius, margin: cfg.margin, algorithm: cfg.algorithm },
      );
      if (!out.newPlan.path.length) {
        out.status = 'no-replan';
        break;
      }
      // A visible one-second pause represents detecting the obstacle and replacing the plan,
      // not the measured execution time of the search algorithm.
      for (let i = 0; i < 25; i++) sample('replan');
      path = out.newPlan.path;
      index = 1;
    }
    while (index < path.length && distance(pose, path[index]) < 0.002) index++;
    if (index >= path.length) {
      out.status = 'success';
      sample('arrived');
      break;
    }
    const target = path[index];
    const d = distance(pose, target);
    const heading = Math.atan2(target.y - pose.y, target.x - pose.x);
    const error = wrap(heading - pose.theta);
    let v = 0;
    let w = 0;
    if (Math.abs(error) > 0.001) w = Math.sign(error) * Math.min(1.4, Math.abs(error) / dt);
    else v = Math.min(0.4, d / dt);
    const next = {
      ...pose,
      theta: wrap(pose.theta + w * dt),
      x: pose.x + v * Math.cos(pose.theta) * dt,
      y: pose.y + v * Math.sin(pose.theta) * dt,
    };
    if (segmentClearance(pose, next, { ...map, obstacles }) <= PLAN_ROBOT.radius) {
      out.status = 'contact';
      sample('contact');
      break;
    }
    total += distance(pose, next);
    pose = next;
    sample('moving', rpm(v - (w * PLAN_ROBOT.track) / 2), rpm(v + (w * PLAN_ROBOT.track) / 2));
  }
  if (out.status === 'no-path') out.status = 'timeout';
  out.distance = total;
  out.time = pose.t;
  return out;
}
function planningCSV(run) {
  const rows = [
    [
      'time_s',
      'x_m',
      'y_m',
      'heading_rad',
      'left_rpm',
      'right_rpm',
      'clearance_m',
      'phase',
      'topic',
      'consider_body',
      'margin_m',
      'algorithm',
      'replan',
      'result',
    ],
  ];
  for (const s of run.samples)
    rows.push([
      s.t,
      s.x,
      s.y,
      s.theta,
      s.left,
      s.right,
      s.clearance,
      s.phase,
      run.config.topic,
      run.config.body,
      run.config.margin,
      run.config.algorithm,
      run.config.replan,
      run.status,
    ]);
  return rows.map((row) => row.join(',')).join('\n');
}

export {
  PLAN_ROBOT,
  PLAN_TOPICS,
  planningMap,
  planningDefaults,
  planningClearance,
  segmentClearance,
  planningLength,
  planRoute,
  planningExperiment,
  planningCSV,
};
