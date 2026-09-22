import { html, svg, nothing } from '../vendor/lit-html.js';
import { formatNumber } from '../core/dom.js';
import { drawRobot } from '../core/renderer.js';
import { DURATION, START_DISTANCE, STOP_DISTANCE } from './core.js';
import { fillSentence as fill } from '../core/content.js';

// Drawing for the feedback-control course: the robot on the canvas and the two time charts.
// Everything here is handed plain data by ui.js and keeps no state of its own.

const COLOURS = {
  background: '#182d38',
  wall: '#526574',
  wallLabel: '#cedce0',
  floorLine: '#425864',
  stopMark: '#e3c078',
  beam: '#98d6cc',
  beamLabel: '#cae6e2',
  forward: '#9bdcc6',
  backward: '#edb467',
};
const CHART_COLOURS = {
  grid: '#dbe4e6',
  measured: '#38786e',
  previous: '#a3adb8',
  target: '#af8136',
  integral: '#9367a3',
  correction: '#5d81b7',
  cursor: '#173d4d',
  blocked: '#e4c18b',
  loadEvent: '#b77c34',
  live: '#b2506f', // a recording from the real robot, drawn on the same axes as the simulation
  liveTarget: '#d39ab0',
};

// Integrate actual wheel speed. Multiplying the current speed by elapsed time
// would make the wheel jump backwards when a load slows it down.
function controlWheelAngle(samples, index) {
  let turns = 0;
  for (let i = 1; i <= index; i++)
    turns +=
      (((samples[i - 1].rpm + samples[i].rpm) / 2) * (samples[i].time - samples[i - 1].time)) / 60;
  return turns * Math.PI * 2;
}

function drawControlBench(ctx, { compact, angle, measured, started, blocked, description }) {
  const box = (x, y, w, h, r, fill, stroke) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  };
  ctx.save();
  if (!compact) ctx.translate(50, 0);
  ctx.font = '18px system-ui';
  ctx.fillStyle = '#d4e4e8';
  ctx.fillText('横から見た図', 24, 32);
  // Floor and support touch; the tire does not. In a side view the other
  // driven wheel is behind the visible one, not a second front/rear wheel.
  ctx.strokeStyle = '#617983';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(24, 266);
  ctx.lineTo(456, 266);
  ctx.stroke();
  ctx.fillStyle = '#a8bec6';
  ctx.font = '16px system-ui';
  ctx.fillText('床', 431, 289);
  box(138, 158, 186, 12, 3, '#708894');
  for (const x of [145, 308]) {
    box(x, 170, 10, 87, 2, '#526f7d');
    box(x - 14, 257, 38, 8, 2, '#8ca1ab');
  }
  box(131, 87, 208, 71, 15, '#bdcfd6', '#ecf4f6');
  box(143, 101, 174, 30, 7, '#304d59');
  ctx.fillStyle = '#8ad2c2';
  ctx.fillRect(151, 109, 37, 4);
  box(317, 101, 32, 23, 6, '#213d50', '#7b9cac');
  ctx.beginPath();
  ctx.arc(338, 112, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#9ecfff';
  ctx.fill();
  box(248, 72, 42, 15, 5, '#89a5af');
  box(254, 65, 30, 9, 3, '#284650', '#84bfb7');
  drawBenchWheel(ctx, angle);
  // Label the actual gap, rather than relying on a caption to explain it.
  ctx.strokeStyle = '#e5c482';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(231, 216);
  ctx.lineTo(231, 259);
  ctx.moveTo(226, 216);
  ctx.lineTo(236, 216);
  ctx.moveTo(226, 259);
  ctx.lineTo(236, 259);
  ctx.moveTo(239, 238);
  ctx.lineTo(272, 238);
  ctx.stroke();
  ctx.fillStyle = '#e5c482';
  ctx.font = '16px system-ui';
  ctx.fillText('タイヤは床に触れない', 279, 242);
  ctx.strokeStyle = '#a4bac4';
  ctx.beginPath();
  ctx.moveTo(100, 193);
  ctx.lineTo(121, 193);
  ctx.lineTo(145, 216);
  ctx.stroke();
  ctx.fillStyle = '#c9dce3';
  ctx.fillText('支持台', 44, 199);
  ctx.restore();
  ctx.fillStyle = blocked ? '#f4c085' : '#b8ccd3';
  ctx.font = '16px system-ui';
  ctx.fillText(description, compact ? 24 : 74, 320);
  if (!compact) {
    ctx.fillStyle = '#c9dce3';
    ctx.font = '18px system-ui';
    ctx.fillText('左右の車輪の回転数', 612, 115);
    ctx.font = '38px system-ui';
    ctx.fillText((started ? measured.toFixed(1) : '—') + ' rpm', 612, 164);
    ctx.font = '16px system-ui';
    ctx.fillStyle = '#a8bec6';
    ctx.fillText('奥の車輪も同じ速さで回ります', 612, 202);
  }
}

// Tire, hub and one contrasting spoke make rotation directly visible.
function drawBenchWheel(ctx, angle) {
  ctx.save();
  ctx.translate(231, 164);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.arc(0, 0, 44, 0, Math.PI * 2);
  ctx.fillStyle = '#10232c';
  ctx.fill();
  ctx.strokeStyle = '#7e969f';
  ctx.lineWidth = 3;
  ctx.stroke();
  for (let i = 0; i < 16; i++) {
    const a = (i * Math.PI) / 8;
    ctx.strokeStyle = '#3a535f';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(38 * Math.cos(a), 38 * Math.sin(a));
    ctx.lineTo(42 * Math.cos(a), 42 * Math.sin(a));
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(0, 0, 31, 0, Math.PI * 2);
  ctx.fillStyle = '#385864';
  ctx.fill();
  for (let i = 0; i < 4; i++) {
    ctx.rotate(Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(29, 0);
    ctx.strokeStyle = i === 0 ? '#b7f0de' : '#738e99';
    ctx.lineWidth = i === 0 ? 6 : 4;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(0, 0, 10, 0, Math.PI * 2);
  ctx.fillStyle = '#a9c8ce';
  ctx.fill();
  ctx.restore();
}

// Seen from above: the robot approaches the wall from the right-hand side of the canvas.
function drawWideDistanceScene(ctx, frame) {
  const WALL_X = 845; // canvas units
  const SCALE = 370; // canvas units per metre
  const x = WALL_X - frame.actual * SCALE;
  ctx.fillStyle = COLOURS.wall;
  ctx.fillRect(WALL_X, 36, 32, 222);
  ctx.fillStyle = COLOURS.wallLabel;
  ctx.fillText('壁', 848, 28);
  ctx.strokeStyle = COLOURS.floorLine;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(70, 212);
  ctx.lineTo(WALL_X, 212);
  ctx.stroke();
  ctx.strokeStyle = COLOURS.stopMark;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(WALL_X - STOP_DISTANCE * SCALE, 44);
  ctx.lineTo(WALL_X - STOP_DISTANCE * SCALE, 244);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COLOURS.stopMark;
  ctx.fillText('停止する位置', WALL_X - STOP_DISTANCE * SCALE - 66, 275);
  drawRobot(ctx, { x, y: 150 }, { theta: 0, left: frame.rpm, right: frame.rpm });
  ctx.strokeStyle = COLOURS.beam;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 96);
  ctx.lineTo(WALL_X, 96);
  ctx.stroke();
  ctx.fillStyle = COLOURS.beamLabel;
  ctx.fillText(
    'LiDARで測る距離 ' + formatNumber(frame.measured, 2) + ' m',
    Math.max(40, Math.min(540, x + 30)),
    73,
  );
  if (Math.abs(frame.rpm) > 3) drawTravelArrow(ctx, x, Math.sign(frame.rpm));
}

function drawTravelArrow(ctx, x, direction) {
  ctx.strokeStyle = direction > 0 ? COLOURS.forward : COLOURS.backward;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x, 230);
  ctx.lineTo(x + direction * 60, 230);
  ctx.lineTo(x + direction * 48, 222);
  ctx.moveTo(x + direction * 60, 230);
  ctx.lineTo(x + direction * 48, 238);
  ctx.stroke();
}

// Narrow screens get the same scene with fewer labels and a shorter run-up.
function drawCompactDistanceScene(ctx, frame) {
  const WALL_X = 440; // canvas units
  const SCALE = 215; // canvas units per metre
  const x = WALL_X - frame.actual * SCALE;
  ctx.font = '18px system-ui';
  ctx.fillStyle = '#c7dce0';
  ctx.fillText('LiDARで壁までの距離を測る', 20, 30);
  ctx.fillStyle = '#637b86';
  ctx.fillRect(WALL_X, 52, 16, 154);
  ctx.strokeStyle = COLOURS.stopMark;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(WALL_X - STOP_DISTANCE * SCALE, 55);
  ctx.lineTo(WALL_X - STOP_DISTANCE * SCALE, 206);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COLOURS.stopMark;
  ctx.fillText('50 cm手前', WALL_X - STOP_DISTANCE * SCALE - 53, 229);
  drawRobot(ctx, { x, y: 145 }, { theta: 0, left: frame.rpm, right: frame.rpm });
  ctx.strokeStyle = '#92cfbc';
  ctx.beginPath();
  ctx.moveTo(x, 85);
  ctx.lineTo(WALL_X, 85);
  ctx.stroke();
  ctx.fillStyle = '#c7dce0';
  ctx.fillText(formatNumber(frame.measured, 2) + ' m', Math.min(x, 360), 70);
}

const COMPACT_BELOW = 600; // CSS pixels of canvas width

// Sizes the canvas for the current zoom / pixel density (CSS keeps the aspect ratio) and draws
// either the test bench or the robot approaching the wall.
function drawControlStage(canvas, { distance, angle, frame, started, blocked, description }) {
  const cssWidth = canvas.clientWidth || 960;
  const compact = cssWidth < COMPACT_BELOW;
  const logicalWidth = compact ? 480 : 960;
  const logicalHeight = distance ? (compact ? 240 : 300) : 340;
  // Keep enough backing pixels for zoom / high-density screens; CSS keeps the aspect ratio.
  const width = Math.max(logicalWidth, Math.round(cssWidth * (window.devicePixelRatio || 1)));
  const height = Math.round((width * logicalHeight) / logicalWidth);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(width / logicalWidth, 0, 0, height / logicalHeight, 0, 0);
  ctx.fillStyle = COLOURS.background;
  ctx.fillRect(0, 0, logicalWidth, logicalHeight);
  ctx.font = '20px system-ui';
  if (!distance)
    drawControlBench(ctx, {
      compact,
      angle,
      measured: frame.measured,
      started,
      blocked,
      description,
    });
  else if (compact) drawCompactDistanceScene(ctx, frame);
  else drawWideDistanceScene(ctx, frame);
}

// --- time charts -------------------------------------------------------------------------

const CHART = { height: 224, left: 58, right: 20, top: 28, bottom: 36 };
const GRID_FRACTIONS = [0, 0.5, 1];
const TIME_TICKS = [0, 4, 8, 12, 16]; // seconds
const REVEAL_OVERHANG = 2; // px of clip added so the line's cap is not cut off
const SMALL_RANGE = 4; // a span narrower than this gets one decimal on the axis

// Round the axis outwards to a whole number of these steps, so comparing two runs does not
// silently change the scale by a fraction of a division.
const axisStep = (key, distance) => (key === 'command' ? 25 : distance ? 0.5 : 20);

function chartBounds({ run, previous, live, key, target, extra, breakdown, distance, fallback }) {
  const simulated = run
    ? [
        ...run.samples.map((sample) => sample[key]),
        ...(previous ? previous.samples.map((sample) => sample[key]) : []),
        ...(target ? run.samples.map((sample) => sample.target) : []),
        ...(target && previous ? previous.samples.map((sample) => sample.target) : []),
        ...(extra ? run.samples.map((sample) => sample.i) : []),
        ...(breakdown ? run.samples.flatMap((sample) => [sample.ff, sample.correction]) : []),
      ]
    : [0, distance ? START_DISTANCE : fallback];
  // The real recording shares the axis, so a measurement outside the simulated range still fits.
  const values = live
    ? [...simulated, ...live.samples.flatMap((sample) => [sample.measured, sample.target])]
    : simulated;
  let min = Math.min(0, ...values);
  let max = Math.max(...values);
  if (max - min < 1e-5) max = min + 1;
  const step = axisStep(key, distance);
  max = Math.ceil((max + 1e-6) / step) * step;
  min = Math.floor(min / step) * step;
  // The command axis is a percentage: keep the familiar 0–100 frame unless an extra line needs more.
  if (key === 'command' && !extra && !breakdown) max = 100;
  return { min, max };
}

// The shaded band / dashed line that marks when the experiment's load changes.
function eventMarker(marker, { x, top, height }) {
  if (marker === 'blocked')
    return svg`<rect
      x=${x(3)}
      y=${top}
      width=${x(7) - x(3)}
      height=${height}
      fill=${CHART_COLOURS.blocked}
      opacity=".2"
    />`;
  if (marker === 'load')
    return svg`<line
      x1=${x(5)}
      y1=${top}
      x2=${x(5)}
      y2=${top + height}
      stroke=${CHART_COLOURS.loadEvent}
      stroke-dasharray="3 4"
    />`;
  return nothing;
}

/**
 * One time chart. `run` is the finished or running experiment, `previous` the greyed-out
 * comparison, `cursorTime` the moment the playback has reached (seconds). Returns a
 * lit template; the caller decides where it goes.
 */
function controlChart({
  run,
  previous,
  live = null,
  key,
  title,
  unit,
  target = false,
  extra = false,
  breakdown = false,
  distance,
  fallback,
  width,
  cursorTime,
  marker,
  targetCaption,
  copy,
}) {
  const { left, right, top, bottom, height: H } = CHART;
  const plotWidth = width - left - right;
  const plotHeight = H - top - bottom;
  const { min, max } = chartBounds({
    run,
    previous,
    live,
    key,
    target,
    extra,
    breakdown,
    distance,
    fallback,
  });
  const x = (seconds) => left + (seconds / DURATION) * plotWidth;
  const y = (value) => top + ((max - value) / (max - min)) * plotHeight;
  const line = (samples, field) =>
    samples
      .map(
        (sample, i) =>
          (i ? 'L' : 'M') + x(sample.time).toFixed(2) + ',' + y(sample[field]).toFixed(2),
      )
      .join(' ');
  const reference = run
    ? line(run.samples, 'target')
    : `M${left},${y(fallback)}L${width - right},${y(fallback)}`;
  const label =
    title +
    '。' +
    fill(copy.charts.axes, { unit }) +
    (run ? copy.charts.withRun : copy.charts.withoutRun);
  const cursorX = left + (cursorTime / DURATION) * plotWidth;

  return html`<div class="control-chart">
    <h3>${title}<span>${unit}</span></h3>
    <svg viewBox=${'0 0 ' + width + ' ' + H} role="img" aria-label=${label}>
      ${eventMarker(marker, { x, top, height: plotHeight })}
      ${GRID_FRACTIONS.map((fraction) => {
        const value = min + (max - min) * fraction;
        return svg`<line
          x1=${left}
          y1=${y(value)}
          x2=${width - right}
          y2=${y(value)}
          stroke=${CHART_COLOURS.grid}
        /><text x=${left - 8} y=${y(value) + 4} text-anchor="end">
          ${formatNumber(value, max - min < SMALL_RANGE ? 1 : 0)}
        </text>`;
      })}
      ${TIME_TICKS.map(
        (seconds) =>
          svg`<text x=${x(seconds)} y=${H - 10} text-anchor="middle">${seconds + '秒'}</text>`,
      )}
      ${
        target
          ? svg`${
              previous
                ? svg`<path
                  d=${line(previous.samples, 'target')}
                  fill="none"
                  stroke=${CHART_COLOURS.previous}
                  stroke-width="1.5"
                  stroke-dasharray="9 6"
                />`
                : nothing
            }<path
            d=${reference}
            fill="none"
            stroke=${CHART_COLOURS.target}
            stroke-width="2"
            stroke-dasharray="7 5"
          /><text x=${width - right} y=${y(run ? run.target : fallback) - 7} text-anchor="end">
            ${targetCaption}
          </text>`
          : nothing
      }
      ${
        live
          ? svg`<path
              d=${line(live.samples, 'target')}
              fill="none"
              stroke=${CHART_COLOURS.liveTarget}
              stroke-width="1.5"
              stroke-dasharray="7 5"
            /><path
              d=${line(live.samples, 'measured')}
              fill="none"
              stroke=${CHART_COLOURS.live}
              stroke-width="2.5"
              stroke-linejoin="round"
            />`
          : nothing
      }
      ${
        run
          ? svg`${
              previous
                ? svg`<path
                  d=${line(previous.samples, key)}
                  fill="none"
                  stroke=${CHART_COLOURS.previous}
                  stroke-width="2.5"
                  stroke-dasharray="4 3"
                />`
                : nothing
            }<defs>
            <clipPath id=${'control-reveal-' + key}>
              <rect
                class="control-chart-reveal"
                data-plot-width=${plotWidth}
                x=${left - REVEAL_OVERHANG}
                y="0"
                width=${(cursorTime / DURATION) * plotWidth + REVEAL_OVERHANG}
                height=${H}
              />
            </clipPath>
          </defs>
          <g clip-path=${'url(#control-reveal-' + key + ')'}>
            <path
              d=${line(run.samples, key)}
              fill="none"
              stroke=${CHART_COLOURS.measured}
              stroke-width="2.5"
              stroke-linejoin="round"
            />
            ${
              extra
                ? svg`<path d=${line(run.samples, 'i')} fill="none" stroke=${CHART_COLOURS.integral} stroke-width="2"/>`
                : nothing
            }
            ${
              breakdown
                ? svg`<path d=${line(run.samples, 'ff')} fill="none" stroke=${CHART_COLOURS.integral} stroke-width="2"/><path
                  d=${line(run.samples, 'correction')}
                  fill="none"
                  stroke=${CHART_COLOURS.correction}
                  stroke-width="2"
                  stroke-dasharray="2 3"
                />`
                : nothing
            }
          </g>
          <line
            class="control-chart-cursor"
            data-plot-width=${plotWidth}
            x1=${cursorX}
            x2=${cursorX}
            y1=${top}
            y2=${top + plotHeight}
            stroke=${CHART_COLOURS.cursor}
            stroke-width="1"
            opacity=".5"
          />`
          : svg`<text x=${width / 2} y=${H / 2} text-anchor="middle">${copy.charts.placeholder}</text>`
      }
    </svg>
  </div>`;
}

export { controlWheelAngle, drawControlBench, drawControlStage, controlChart };
