import { html, svg, nothing } from '../vendor/lit-html.js';
import { drawRobot } from '../core/renderer.js';
import { DURATION, STOP_DISTANCE, DRAG_START, BLOCK_WINDOW } from './core.js';
import { fillSentence as fill } from '../core/content.js';
import { CHART_ROLE_COLORS, roleStyle } from '../core/palette.js';
import { niceScale, formatTick, scaleTo } from '../core/chart-scale.js';
import { formatValue } from './summary.js';

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

// Integrate actual wheel speed. Multiplying the current speed by elapsed time
// would make the wheel jump backwards when a load slows it down.
function controlWheelAngle(samples, index) {
  let turns = 0;
  for (let i = 1; i <= index; i++)
    turns +=
      (((samples[i - 1].rpm + samples[i].rpm) / 2) * (samples[i].time - samples[i - 1].time)) / 60;
  return turns * Math.PI * 2;
}

// The side view of the bench. On a wide canvas the drawing is scaled down and the readout sits
// to its right, so the figure stays short enough for the rpm chart to fit under it on a
// 1366×768 screen; labels keep their on-screen size (fonts divided by the scale).
const BENCH_WIDE = { scale: 0.78, x: 40, y: -40, text: 500 }; // canvas units
const BENCH_FONT = { compact: 17, wide: 16 }; // canvas units: ≥ 12 px on a 352 px phone canvas and at 1366 px

function drawBenchFrame(ctx, font) {
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
  // Floor and support touch; the tire does not. In a side view the other
  // driven wheel is behind the visible one, not a second front/rear wheel.
  ctx.strokeStyle = '#617983';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(24, 266);
  ctx.lineTo(456, 266);
  ctx.stroke();
  ctx.fillStyle = '#a8bec6';
  ctx.font = font + 'px system-ui';
  ctx.fillText('床', 431, 292);
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
}

// Label the actual gap, rather than relying on a caption to explain it.
function drawBenchLabels(ctx, font) {
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
  ctx.lineTo(262, 238);
  ctx.stroke();
  ctx.fillStyle = '#e5c482';
  ctx.font = font + 'px system-ui';
  ctx.fillText('タイヤは床に触れない', 268, 244);
  ctx.strokeStyle = '#a4bac4';
  ctx.beginPath();
  ctx.moveTo(100, 193);
  ctx.lineTo(121, 193);
  ctx.lineTo(145, 216);
  ctx.stroke();
  ctx.fillStyle = '#c9dce3';
  ctx.fillText('支持台', 30, 200);
}

function drawControlBench(ctx, { compact, angle, measured, started, blocked, description }) {
  const scale = compact ? 1 : BENCH_WIDE.scale;
  const font = (compact ? BENCH_FONT.compact : BENCH_FONT.wide) / scale;
  ctx.save();
  if (!compact) {
    ctx.translate(BENCH_WIDE.x, BENCH_WIDE.y);
    ctx.scale(scale, scale);
  }
  drawBenchFrame(ctx, font);
  drawBenchWheel(ctx, angle);
  drawBenchLabels(ctx, font);
  ctx.restore();
  const descriptionColour = blocked ? '#f4c085' : '#b8ccd3';
  if (compact) {
    ctx.fillStyle = '#d4e4e8';
    ctx.font = '19px system-ui';
    ctx.fillText('横から見た図', 20, 32);
    ctx.fillStyle = descriptionColour;
    ctx.font = BENCH_FONT.compact + 'px system-ui';
    ctx.fillText(description, 20, 322);
    return;
  }
  const x = BENCH_WIDE.text;
  ctx.fillStyle = '#a8bec6';
  ctx.font = '16px system-ui';
  ctx.fillText('横から見た図', x, 30);
  ctx.fillStyle = '#c9dce3';
  ctx.font = '18px system-ui';
  ctx.fillText('左右の車輪の回転数', x, 68);
  ctx.font = '38px system-ui';
  ctx.fillText((started ? formatValue(measured, 1) : '—') + ' rpm', x, 114);
  ctx.font = '16px system-ui';
  ctx.fillStyle = '#a8bec6';
  ctx.fillText('奥の車輪も同じ速さで回ります', x, 144);
  ctx.fillStyle = descriptionColour;
  ctx.font = '18px system-ui';
  ctx.fillText(description, x, 182);
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

const centimetres = (metres) => formatValue(metres * 100, 0) + ' cm';

// Text on a dark plate, so a label stays readable where it crosses a line of the scene.
function plateText(ctx, text, x, y, colour) {
  const width = ctx.measureText(text).width;
  ctx.fillStyle = COLOURS.background;
  ctx.fillRect(x - 4, y - 18, width + 8, 24);
  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
}

// Seen from above: the robot approaches the wall from the right-hand side of the canvas.
function drawWideDistanceScene(ctx, frame) {
  const WALL_X = 845; // canvas units
  const SCALE = 370; // canvas units per metre
  const x = WALL_X - frame.actual * SCALE;
  const stopX = WALL_X - STOP_DISTANCE * SCALE;
  const target = roleStyle('target', 'scene');
  const beam = roleStyle('measured', 'scene');
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
  ctx.strokeStyle = target.color;
  ctx.lineWidth = target.width;
  ctx.setLineDash([8, 5]);
  ctx.beginPath();
  ctx.moveTo(stopX, 44);
  ctx.lineTo(stopX, 244);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COLOURS.stopMark;
  ctx.fillText('止まる位置（壁から50 cm）', stopX - 150, 275);
  drawRobot(ctx, { x, y: 150 }, { theta: 0, left: frame.rpm, right: frame.rpm });
  ctx.strokeStyle = beam.color;
  ctx.lineWidth = beam.width;
  ctx.beginPath();
  ctx.moveTo(x, 96);
  ctx.lineTo(WALL_X, 96);
  ctx.stroke();
  plateText(
    ctx,
    'LiDARで測る距離 ' + centimetres(frame.measured),
    Math.max(40, Math.min(520, x + 30)),
    73,
    COLOURS.beamLabel,
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
  const stopX = WALL_X - STOP_DISTANCE * SCALE;
  const target = roleStyle('target', 'scene');
  ctx.font = '18px system-ui';
  ctx.fillStyle = '#c7dce0';
  ctx.fillText('LiDARで壁までの距離を測る', 20, 30);
  ctx.fillStyle = '#637b86';
  ctx.fillRect(WALL_X, 52, 16, 154);
  ctx.strokeStyle = target.color;
  ctx.lineWidth = target.width;
  ctx.setLineDash([8, 5]);
  ctx.beginPath();
  ctx.moveTo(stopX, 55);
  ctx.lineTo(stopX, 206);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COLOURS.stopMark;
  ctx.fillText('50 cm手前', stopX - 53, 229);
  drawRobot(ctx, { x, y: 145 }, { theta: 0, left: frame.rpm, right: frame.rpm });
  ctx.strokeStyle = roleStyle('measured', 'scene').color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 85);
  ctx.lineTo(WALL_X, 85);
  ctx.stroke();
  plateText(ctx, centimetres(frame.measured), Math.min(x, 360), 70, '#c7dce0');
}

const COMPACT_BELOW = 600; // CSS pixels of canvas width

// Canvas units of height for each figure; the width is 480 (compact) or 960 (wide).
function stageHeight(distance, compact) {
  if (distance) return compact ? 240 : 300;
  return compact ? 340 : 200;
}

// Sizes the canvas for the current zoom / pixel density (CSS keeps the aspect ratio) and draws
// either the test bench or the robot approaching the wall.
function drawControlStage(canvas, { distance, angle, frame, started, blocked, description }) {
  const cssWidth = canvas.clientWidth || 960;
  const compact = cssWidth < COMPACT_BELOW;
  const logicalWidth = compact ? 480 : 960;
  const logicalHeight = stageHeight(distance, compact);
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

// Both charts use these edges, so one moment of the run sits at the same x in each (the SVG's
// viewBox is as wide as the container, see measureChartWidth in ui.js). The right margin holds
// the direct labels at the ends of the lines (今回・前回・実機).
const CHART = { height: 232, left: 52, right: 50, top: 30, bottom: 34 };
// Other groups' recordings, one colour each, in the order they were opened.
const COMPARE_COLOURS = ['#3f7fbf', '#c07a1c', '#5b8f3c', '#8a5cc2', '#2a9d9a'];

const TIME_TICKS = [0, 4, 8, 12, 16]; // seconds
const REVEAL_OVERHANG = 2; // px of clip added so the line's cap is not cut off
const LABEL_GAP = 15; // px kept between two labels at the right edge
const EVENT_LABEL_OFFSET = 6; // px between an event line and its label
const EVENT_LABEL_MIN_ROOM = 130; // px the load label needs to the right of its line
const COMMAND_FULL = 100; // % — the command axis keeps its familiar ±100 frame

// A command axis is a percentage: 0–100, or −100–100 once the command goes negative. Lines that
// are not the command (the I part, FF, FB) may go further and widen it.
function commandScale(values) {
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  if (low >= 0 && high <= COMMAND_FULL)
    return niceScale([0, COMMAND_FULL], { ticks: 4, padding: 0 });
  if (low >= -COMMAND_FULL && high <= COMMAND_FULL)
    return niceScale([-COMMAND_FULL, COMMAND_FULL], { ticks: 4, padding: 0 });
  return niceScale(values, { ticks: 4 });
}

// One axis for the whole run (and the previous run drawn with it), never grown while it plays.
function chartScale({
  run,
  previous,
  live,
  compared,
  key,
  target,
  extra,
  breakdown,
  fallback,
  factor,
}) {
  const simulated = run
    ? [
        ...run.samples.map((sample) => sample[key]),
        ...(previous ? previous.samples.map((sample) => sample[key]) : []),
        ...(target ? run.samples.map((sample) => sample.target) : []),
        ...(target && previous ? previous.samples.map((sample) => sample.target) : []),
        ...(extra ? run.samples.map((sample) => sample.i) : []),
        ...(breakdown ? run.samples.flatMap((sample) => [sample.ff, sample.correction]) : []),
      ]
    : [0, fallback];
  // The real recording shares the axis, so a measurement outside the simulated range still fits.
  // A distance recording has no target of its own (NaN), which is filtered out below.
  const values = live
    ? [...simulated, ...live.samples.flatMap((sample) => [sample.measured, sample.target])]
    : simulated;
  for (const entry of compared) values.push(...entry.run.samples.map((sample) => sample.measured));
  const scaled = values.filter(Number.isFinite).map((value) => value * factor);
  if (key === 'command') return commandScale(scaled);
  return niceScale(scaled, { ticks: 4, padding: 0.04 });
}

// A label with a white halo, so it stays readable where it crosses a grid or data line.
const haloText = (x, y, text, { anchor = 'start', colour, weight = 400 } = {}) =>
  svg`<text
    x=${x}
    y=${y}
    text-anchor=${anchor}
    fill=${colour}
    font-weight=${weight}
    paint-order="stroke"
    stroke="#fff"
    stroke-width="4"
    stroke-linejoin="round"
  >${text}</text>`;

const eventLine = (at, top, height, event) =>
  svg`<line
    x1=${at}
    x2=${at}
    y1=${top}
    y2=${top + height}
    stroke=${event.color}
    stroke-width=${event.width}
    stroke-dasharray=${event.dash}
    vector-effect="non-scaling-stroke"
  />`;

// When the experiment's load changes: a grey vertical line (or band) with its own label, the same
// "event" look every chart of the material uses.
function eventMarker(marker, { x, top, height, right, copy }) {
  const event = roleStyle('event');
  const labelStyle = { colour: event.color, weight: 600 };
  if (marker === 'blocked') {
    const from = x(BLOCK_WINDOW.from);
    const to = x(BLOCK_WINDOW.to);
    return svg`<rect
        x=${from}
        y=${top}
        width=${to - from}
        height=${height}
        fill=${event.color}
        opacity=".12"
      />${eventLine(from, top, height, event)}${eventLine(to, top, height, event)}${haloText(
        from + EVENT_LABEL_OFFSET,
        top + 16,
        copy.charts.eventBlocked,
        labelStyle,
      )}`;
  }
  if (marker === 'load') {
    const at = x(DRAG_START);
    const roomRight = right - at > EVENT_LABEL_MIN_ROOM;
    const labelX = roomRight ? at + EVENT_LABEL_OFFSET : at - EVENT_LABEL_OFFSET;
    return svg`${eventLine(at, top, height, event)}${haloText(
      labelX,
      top + 16,
      copy.charts.eventLoad,
      {
        ...labelStyle,
        anchor: roomRight ? 'start' : 'end',
      },
    )}`;
  }
  return nothing;
}

// Direct labels in the right margin, pushed apart so two lines that end close together keep
// readable names. `labels`: [{ y, text, colour, x? }].
function spreadLabels(labels, { top, bottom }) {
  const sorted = labels.map((label) => ({ ...label })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++)
    sorted[i].y = Math.max(sorted[i].y, sorted[i - 1].y + LABEL_GAP);
  const overflow = sorted.length ? sorted.at(-1).y - bottom : 0;
  if (overflow > 0) for (const label of sorted) label.y = Math.max(top, label.y - overflow);
  return sorted;
}

// The sample on screen at `time` (the last one not after it).
function sampleAt(samples, time) {
  let found = samples[0];
  for (const sample of samples) {
    if (sample.time > time + 1e-9) break;
    found = sample;
  }
  return found;
}

// The names written at the ends of the lines: 今回 follows the tip of the line as it is drawn,
// the others sit where their line ends.
function lineLabels({
  run,
  previous,
  live,
  key,
  extra,
  breakdown,
  cursorX,
  cursorTime,
  y,
  factor,
  copy,
}) {
  const labels = [];
  const endOf = (samples, field, text, role) => {
    const last = samples.at(-1);
    if (last && Number.isFinite(last[field]))
      labels.push({ y: y(last[field] * factor) + 4, text, colour: roleStyle(role).color });
  };
  if (!run) return labels;
  if (previous) endOf(previous.samples, key, copy.charts.endPrevious, 'previous');
  if (live && key === 'measured') endOf(live.samples, 'measured', copy.charts.endLive, 'measured');
  const tip = sampleAt(run.samples, cursorTime);
  labels.push({
    y: y(tip[key] * factor) + 4,
    text: copy.charts.endThis,
    colour: roleStyle('actual').color,
    x: cursorX,
  });
  if (extra) endOf(run.samples, 'i', 'I', 'measured');
  if (breakdown) {
    endOf(run.samples, 'ff', 'FF', 'plan');
    endOf(run.samples, 'correction', 'FB', 'measured');
  }
  return labels;
}

/**
 * One time chart. `run` is the finished or running experiment, `previous` the greyed-out
 * comparison, `cursorTime` the moment the playback has reached (seconds). `factor` turns the
 * stored value into the unit on the axis (metres → centimetres). Returns a lit template; the
 * caller decides where it goes.
 */
function controlChart({
  run,
  previous,
  live = null,
  compared = [],
  key,
  title,
  unit,
  target = false,
  extra = false,
  breakdown = false,
  fallback,
  factor = 1,
  width,
  cursorTime,
  marker,
  targetCaption,
  copy,
}) {
  const { left, top, bottom, height: H } = CHART;
  const right = width - CHART.right;
  const plotWidth = right - left;
  const plotHeight = H - top - bottom;
  const scale = chartScale({
    run,
    previous,
    live,
    compared,
    key,
    target,
    extra,
    breakdown,
    fallback: fallback * factor,
    factor,
  });
  const x = (seconds) => left + (seconds / DURATION) * plotWidth;
  const y = scaleTo(scale, top + plotHeight, top);
  const line = (samples, field) =>
    samples
      .map(
        (sample, i) =>
          (i ? 'L' : 'M') + x(sample.time).toFixed(2) + ',' + y(sample[field] * factor).toFixed(2),
      )
      .join(' ');
  const path = (d, role, options = {}) => {
    const style = roleStyle(role);
    const dash = options.dash ?? style.dash;
    return svg`<path
      d=${d}
      fill="none"
      stroke=${options.colour ?? style.color}
      stroke-width=${options.width ?? style.width}
      stroke-dasharray=${dash || nothing}
      stroke-linejoin="round"
      vector-effect="non-scaling-stroke"
    />`;
  };
  const targetValue = (run ? run.target : fallback) * factor;
  const label =
    title +
    '。' +
    fill(copy.charts.axes, { unit }) +
    (run ? copy.charts.withRun : copy.charts.withoutRun);
  const cursorX = x(cursorTime);
  const labels = lineLabels({
    run,
    previous,
    live,
    key,
    extra,
    breakdown,
    cursorX,
    cursorTime,
    y,
    factor,
    copy,
  });

  return html`<div class="control-chart">
    <h3>${title}（${unit}）</h3>
    <svg viewBox=${'0 0 ' + width + ' ' + H} role="img" aria-label=${label}>
      ${scale.ticks.map((value) => {
        const zero = value === 0 && scale.min < 0;
        return svg`<line
          x1=${left}
          y1=${y(value)}
          x2=${right}
          y2=${y(value)}
          stroke=${zero ? CHART_ROLE_COLORS.axis : CHART_ROLE_COLORS.grid}
          stroke-width=${zero ? 1.5 : 1}
        /><text x=${left - 8} y=${y(value) + 5} text-anchor="end">
          ${formatTick(value, scale.step)}
        </text>`;
      })}
      ${eventMarker(marker, { x, top, height: plotHeight, right, copy })}
      ${TIME_TICKS.map(
        (seconds) =>
          svg`<text x=${x(seconds)} y=${H - 10} text-anchor="middle">${seconds + '秒'}</text>`,
      )}
      ${
        target
          ? svg`${previous ? path(line(previous.samples, 'target'), 'previous', { width: 1.5 }) : nothing}${path(
              run
                ? line(run.samples, 'target')
                : `M${left},${y(targetValue)}L${right},${y(targetValue)}`,
              'target',
            )}${haloText(right, y(targetValue) - 8, targetCaption, {
              anchor: 'end',
              colour: CHART_ROLE_COLORS.target,
              weight: 600,
            })}`
          : nothing
      }
      ${
        live
          ? svg`${
              live.samples.some((sample) => Number.isFinite(sample.target))
                ? path(line(live.samples, 'target'), 'target', { dash: '3 3', width: 1.5 })
                : nothing
            }${path(line(live.samples, 'measured'), 'measured', { width: 2.5 })}`
          : nothing
      }
      ${compared.map((entry) =>
        path(line(entry.run.samples, 'measured'), 'measured', { colour: entry.colour, width: 1.6 }),
      )}
      ${
        run
          ? svg`${previous ? path(line(previous.samples, key), 'previous') : nothing}<defs>
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
            ${path(line(run.samples, key), 'actual')}
            ${extra ? path(line(run.samples, 'i'), 'measured') : nothing}
            ${
              breakdown
                ? svg`${path(line(run.samples, 'ff'), 'plan')}${path(line(run.samples, 'correction'), 'measured')}`
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
            stroke=${CHART_ROLE_COLORS.axis}
            stroke-width="1"
            opacity=".5"
          />`
          : svg`<text x=${width / 2} y=${H / 2} text-anchor="middle">${copy.charts.placeholder}</text>`
      }
      ${spreadLabels(labels, { top: top + 6, bottom: top + plotHeight + 4 }).map((entry) =>
        haloText(Math.min(entry.x ?? right, right) + 6, entry.y, entry.text, {
          colour: entry.colour,
          weight: 700,
        }),
      )}
    </svg>
  </div>`;
}

export { COMPARE_COLOURS, controlWheelAngle, drawControlBench, drawControlStage, controlChart };
