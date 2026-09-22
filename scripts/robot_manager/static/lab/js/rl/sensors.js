import { loadJson } from '../core/content.js';

// Sensor figures of the reinforcement-learning lab: the LiDAR sweep and the time plot behind the
// "センサーの値を見る" panel. Both draw from plain data handed in by lab.js and hold no state.
// What each figure means is written in content/rl/lab-sensors.json.

const copy = await loadJson('content/rl/lab-sensors.json');

const SERIES_COLORS = ['#087f75', '#6760bd', '#c07626'];

const LIDAR = {
  background: '#f5f9fa',
  ring: '#d3e2e5',
  ringLabel: '#607d89',
  ray: '#4baba82b',
  nearPoint: '#c57324', // measured closer than NEAR_RANGE
  point: '#158a85',
  body: '#153e4a',
  lens: '#67cffa',
  caption: '#4e6a77',
  pixelsPerMetre: 55,
  rings: 3, // labelled distance circles, one per metre
  nearRange: 0.5, // metres; closer than this the point is drawn in warning colour
  outOfRange: 3.18, // metres; beyond this the beam hit nothing and only an outline is drawn
};

const PLOT = {
  background: '#f5f9fa',
  grid: '#dce6e8',
  axisText: '#5c7580',
  thresholdLine: '#c34a38',
  thresholdText: '#af4d3e',
  markerLine: '#c05e37',
  markerText: '#a04a2c',
  left: 66,
  rightInset: 22,
  top: 32,
  bottomInset: 66,
  window: 10, // seconds of history shown
  gridLines: 4,
  timeLabels: 2,
};

// Which figure the sensor panel shows: the wheels and the impact trace have one each, the rest of
// the IMU shares the attitude plot.
function graphSpec(mode, view = 'tilt') {
  if (mode === 'impact') return copy.graphs.impact;
  if (mode === 'wheels') return copy.graphs.wheels;
  if (view === 'heading') return copy.graphs.heading;
  if (view === 'rotation') return copy.graphs.rotation;
  return copy.graphs.tilt;
}

// The numbers printed beside the plot: the latest sample of every series it draws.
function graphReadings(history, spec) {
  return spec.keys.map((key, index) => ({
    label: spec.labels[index],
    color: SERIES_COLORS[index],
    value: (history.at(-1)?.[key] || 0).toFixed(1),
  }));
}

function drawLidarRings(ctx, centre, scale) {
  for (let metres = 1; metres <= LIDAR.rings; metres++) {
    ctx.strokeStyle = LIDAR.ring;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, metres * scale, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.fillStyle = LIDAR.ringLabel;
    ctx.fillText(metres + ' m', centre.x + metres * scale + 5, centre.y + 6);
  }
  const reach = 3.2 * scale;
  ctx.setLineDash([3, 6]);
  ctx.beginPath();
  ctx.moveTo(centre.x, centre.y - reach);
  ctx.lineTo(centre.x, centre.y + reach);
  ctx.moveTo(centre.x - reach, centre.y);
  ctx.lineTo(centre.x + reach, centre.y);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawLidarBody(ctx, centre) {
  ctx.fillStyle = LIDAR.body;
  ctx.beginPath();
  ctx.moveTo(centre.x, centre.y - 15);
  ctx.lineTo(centre.x + 10, centre.y - 4);
  ctx.lineTo(centre.x + 10, centre.y + 12);
  ctx.lineTo(centre.x - 10, centre.y + 12);
  ctx.lineTo(centre.x - 10, centre.y - 4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = LIDAR.lens;
  ctx.fillRect(centre.x - 5, centre.y - 9, 10, 3);
}

// One sweep of the 2D LiDAR, robot centred, the front of the body pointing up.
function drawLidar(canvas, scan) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const centre = { x: width / 2, y: height / 2 + 7 };
  const scale = LIDAR.pixelsPerMetre;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = LIDAR.background;
  ctx.fillRect(0, 0, width, height);
  ctx.textAlign = 'left';
  ctx.font = '24px system-ui';
  drawLidarRings(ctx, centre, scale);
  scan.forEach((distance, index) => {
    // Index 0 looks straight ahead, which is up on screen.
    const angle = (index * 2 * Math.PI) / scan.length - Math.PI / 2;
    const x = centre.x + Math.cos(angle) * distance * scale;
    const y = centre.y + Math.sin(angle) * distance * scale;
    ctx.strokeStyle = LIDAR.ray;
    ctx.beginPath();
    ctx.moveTo(centre.x, centre.y);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.fillStyle = distance < LIDAR.nearRange ? LIDAR.nearPoint : LIDAR.point;
    const beyondRange = distance >= LIDAR.outOfRange;
    ctx.beginPath();
    ctx.arc(x, y, beyondRange ? 3 : 5, 0, 2 * Math.PI);
    if (beyondRange) ctx.stroke();
    else ctx.fill();
  });
  drawLidarBody(ctx, centre);
  ctx.textAlign = 'center';
  ctx.fillStyle = LIDAR.caption;
  ctx.fillText(copy.lidar.front, centre.x, 26);
  ctx.font = '22px system-ui';
  ctx.fillText(copy.lidar.footer, centre.x, height - 10);
}

// Impact and gyro traces outgrow their nominal range, so the axis follows what was measured.
function plotRange(spec, observed, threshold) {
  if (spec.keys[0] === 'impact')
    return {
      min: spec.min,
      max: Math.max(spec.max, threshold * 1.15, ...observed.map((value) => value * 1.08)),
    };
  if (spec.keys[0] === 'gyro') {
    const top = Math.ceil(Math.max(180, ...observed.map(Math.abs)) / 90) * 90;
    return { min: -top, max: top };
  }
  if (spec.keys[0] === 'left') {
    const top = Math.max(80, ...observed.map(Math.abs));
    return { min: -top, max: top };
  }
  return { min: spec.min, max: spec.max };
}

function drawPlotAxes(ctx, canvas, axis, start) {
  const { left, right, top, bottom, x, y, min, max } = axis;
  ctx.font = '24px system-ui';
  ctx.textAlign = 'right';
  ctx.fillStyle = PLOT.axisText;
  for (let i = 0; i <= PLOT.gridLines; i++) {
    const value = min + ((max - min) * i) / PLOT.gridLines;
    const lineY = y(value);
    ctx.strokeStyle = PLOT.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, lineY);
    ctx.lineTo(right, lineY);
    ctx.stroke();
    ctx.fillText(Math.abs(value) < 10 ? value.toFixed(1) : value.toFixed(0), left - 12, lineY + 6);
  }
  ctx.textAlign = 'center';
  for (let i = 0; i <= PLOT.timeLabels; i++) {
    const seconds = start + (i * PLOT.window) / PLOT.timeLabels;
    ctx.fillText(seconds.toFixed(0) + copy.graph.secondsSuffix, x(seconds), bottom + 34);
  }
  ctx.font = '22px system-ui';
  ctx.fillText(copy.graph.footer, canvas.width / 2, canvas.height - 8);
}

function drawThreshold(ctx, axis, threshold) {
  ctx.strokeStyle = PLOT.thresholdLine;
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(axis.left, axis.y(threshold));
  ctx.lineTo(axis.right, axis.y(threshold));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.textAlign = 'right';
  ctx.fillStyle = PLOT.thresholdText;
  ctx.fillText(copy.graph.stopPrefix + threshold.toFixed(0), axis.right, axis.y(threshold) - 7);
}

function drawSeries(ctx, axis, samples, key, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  let previous = null;
  for (const sample of samples) {
    // Heading wraps at ±180°; a jump that large is the wrap, not a movement, so lift the pen.
    const wrapped = key === 'yaw' && Math.abs(sample[key] - previous) > 180;
    if (previous === null || wrapped) ctx.moveTo(axis.x(sample.t), axis.y(sample[key]));
    else ctx.lineTo(axis.x(sample.t), axis.y(sample[key]));
    previous = sample[key];
  }
  ctx.stroke();
}

function drawMarkers(ctx, axis, markers, start, end) {
  for (const marker of markers.filter((m) => m.t >= start && m.t <= end)) {
    ctx.strokeStyle = PLOT.markerLine;
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(axis.x(marker.t), axis.top);
    ctx.lineTo(axis.x(marker.t), axis.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = 'right';
    ctx.font = '22px system-ui';
    ctx.fillStyle = PLOT.markerText;
    ctx.fillText(
      marker.label,
      Math.min(axis.right, Math.max(axis.left + 95, axis.x(marker.t) - 5)),
      21,
    );
  }
}

// The last PLOT.window seconds of the chosen sensor values. Returns the latest reading per series
// so the panel beside the figure can print the same numbers.
function drawGraph(canvas, history, spec, threshold, markers) {
  const ctx = canvas.getContext('2d');
  const left = PLOT.left;
  const right = canvas.width - PLOT.rightInset;
  const top = PLOT.top;
  const bottom = canvas.height - PLOT.bottomInset;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = PLOT.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const end = Math.max(PLOT.window, history.at(-1)?.t || 0);
  const start = end - PLOT.window;
  const samples = history.filter((sample) => sample.t >= start);
  const observed = samples.flatMap((sample) => spec.keys.map((key) => sample[key] || 0));
  const { min, max } = plotRange(spec, observed, threshold);
  const axis = {
    left,
    right,
    top,
    bottom,
    min,
    max,
    x: (t) => left + ((t - start) / PLOT.window) * (right - left),
    y: (value) => bottom - ((value - min) / (max - min)) * (bottom - top),
  };
  drawPlotAxes(ctx, canvas, axis, start);
  if (spec.keys[0] === 'impact') drawThreshold(ctx, axis, threshold);
  spec.keys.forEach((key, index) => drawSeries(ctx, axis, samples, key, SERIES_COLORS[index]));
  drawMarkers(ctx, axis, markers, start, end);
  return graphReadings(history, spec);
}

export { graphSpec, graphReadings, drawLidar, drawGraph };
