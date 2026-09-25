import { html, svg, nothing } from '../vendor/lit-html.js';
import { fillSentence as fill } from '../core/content.js';
import { roleStyle } from '../core/palette.js';
import { htmlChart } from '../core/html-chart.js';
import { questixTopSvg } from '../core/questix-art.js';
import { DEGREES_PER_RADIAN, freshnessText, signed } from './robot-state-core.js';

// Templates of the 「実機の状態」 panel (robot-state.js renders them): pure functions of the model
// robot-state-core.js builds. Big numbers first, then the charts and drawings that explain them;
// every word and number is HTML so nothing shrinks under 12 px on a phone. Sentences come from
// content/live/robot-state.json (`text`).

const CM = 100;
const ROBOT_SIZE = 55; // cm across the top view of QUESTiX
const LIDAR_AHEAD = 20; // cm from the robot's centre to the LiDAR (drawing only)
const POINT_RADIUS = 5; // cm, a LiDAR point in the front view
const fixed = (value, digits) => (Number.isFinite(value) ? value.toFixed(digits) : '—');
const measured = roleStyle('measured');
const target = roleStyle('target');

function linkLine(model, text) {
  const linked = model.robot ? fill(text.linked, { robot: model.robot }) : text.linkedNoName;
  return html`<p class="rs-link" data-rs-link>
    <span class="rs-dot" aria-hidden="true"></span>${linked}
    ${model.silent ? html`<span class="rs-silent">${text.silent}</span>` : nothing}
  </p>`;
}

// The emergency stop is the first thing to see: a wide red block while it is pressed.
function estopBlock(model, text) {
  if (model.estop === true)
    return html`<div class="rs-estop is-pressed" role="alert" data-rs-estop="pressed">
      <span class="rs-estop-icon" aria-hidden="true">⛔</span>
      <div>
        <strong>${text.estop.pressed}</strong>
        <p>${text.estop.pressedNote}</p>
      </div>
    </div>`;
  const released = model.estop === false;
  return html`<p
    class=${released ? 'rs-estop is-released' : 'rs-estop is-unknown'}
    data-rs-estop=${released ? 'released' : 'unknown'}
  >
    ${released ? text.estop.released : text.estop.unknown}
  </p>`;
}

function driverBlock(model, text) {
  const words = text.driver;
  const motion = model.motion;
  let detail = words.noCommand;
  if (model.command)
    detail = fill(words.commandVsMeasured, {
      command: signed(model.command.linear, 2),
      measured: motion ? signed(motion.speed, 2) : '—',
    });
  return html`<div class="rs-driver" data-rs-driver=${model.driver}>
    <span class="rs-label">${words.title}</span>
    <strong>${words[model.driver]}</strong>
    <span class="rs-driver-detail">${detail}</span>
  </div>`;
}

function wheelChart(model, side, text) {
  const words = text.wheels;
  const series = model.wheels?.series;
  const targetKey = side === 'left' ? 'targetLeft' : 'targetRight';
  return htmlChart({
    label: fill(words.chartLabel, { side: words[side], seconds: model.historySeconds }),
    yTitle: words.yTitle,
    xTitle: words.xTitle,
    x: model.timeAxis,
    y: model.wheelAxis,
    // The dashed command is drawn over the measurement: where the wheel follows it exactly, the
    // dashes still show on the solid line instead of disappearing under it.
    series: [
      {
        points: series?.[side] ?? [],
        color: measured.color,
        width: 3,
        label: words.measured,
      },
      {
        points: series?.[targetKey] ?? [],
        color: target.color,
        dash: target.dash,
        width: target.width,
        label: words.target,
      },
    ],
  });
}

function wheelCard(model, side, text) {
  const wheels = model.wheels;
  const value = wheels?.[side];
  const command = wheels?.[side === 'left' ? 'targetLeft' : 'targetRight'];
  const stale = !wheels || wheels.stale;
  return html`<div class=${stale ? 'rs-card rs-wheel is-stale' : 'rs-card rs-wheel'}>
    <p class="rs-label">${text.wheels[side]}</p>
    <p class="rs-big" data-rs-wheel=${side}>
      <span class="rs-number">${fixed(value, 1)}</span><span class="rs-unit">rpm</span>
    </p>
    <p class="rs-sub">
      ${
        Number.isFinite(command)
          ? fill(text.wheels.command, { rpm: command.toFixed(1) })
          : text.wheels.noCommand
      }
    </p>
    ${wheelChart(model, side, text)}
  </div>`;
}

function motionCard(model, text) {
  const motion = model.motion;
  const stale = !motion || motion.stale;
  const degrees = motion ? Math.round(motion.turn * DEGREES_PER_RADIAN) : NaN;
  return html`<div class=${stale ? 'rs-card rs-motion is-stale' : 'rs-card rs-motion'}>
    <div>
      <p class="rs-label">${text.motion.speed}</p>
      <p class="rs-big" data-rs-speed>
        <span class="rs-number">${motion ? signed(motion.speed, 2) : '—'}</span
        ><span class="rs-unit">m/秒</span>
      </p>
    </div>
    <div>
      <p class="rs-label">${text.motion.turn}</p>
      <p class="rs-big" data-rs-turn>
        <span class="rs-number">${motion ? signed(motion.turn, 2) : '—'}</span
        ><span class="rs-unit">rad/秒</span>
      </p>
      <p class="rs-sub">
        ${Number.isFinite(degrees) ? fill(text.motion.turnDegrees, { degrees }) : nothing}
      </p>
    </div>
  </div>`;
}

// --- top view since the panel opened (forward up, left to the left) -----------------------------

function poseGrid(half) {
  const lines = [];
  for (let at = -half; at <= half + 1e-6; at += 50)
    lines.push(
      svg`<line x1=${at} x2=${at} y1=${-half} y2=${half} class=${at === 0 ? 'rs-axis' : 'rs-grid'} vector-effect="non-scaling-stroke"/>`,
      svg`<line y1=${at} y2=${at} x1=${-half} x2=${half} class=${at === 0 ? 'rs-axis' : 'rs-grid'} vector-effect="non-scaling-stroke"/>`,
    );
  return lines;
}

function poseFigure(pose, text) {
  const half = pose.half * CM;
  const points = pose.trail.map((point) => `${-point.left * CM},${-point.forward * CM}`).join(' ');
  const heading = -90 - pose.heading * DEGREES_PER_RADIAN; // SVG turns clockwise, +x is 0
  return html`<svg
    class="rs-pose-svg"
    viewBox=${`${-half} ${-half} ${2 * half} ${2 * half}`}
    role="img"
    aria-label=${text.pose.label}
  >
    ${poseGrid(half)}
    <polyline
      points=${points}
      fill="none"
      stroke=${measured.color}
      stroke-width="3"
      stroke-linejoin="round"
      vector-effect="non-scaling-stroke"
    />
    <circle
      cx="0"
      cy="0"
      r=${half * 0.04}
      fill="#fff"
      stroke="#3d5660"
      stroke-width="2"
      vector-effect="non-scaling-stroke"
    />
    ${questixTopSvg(-pose.left * CM, -pose.forward * CM, heading, ROBOT_SIZE)}
  </svg>`;
}

function poseCard(model, text, actions) {
  const pose = model.pose;
  const words = text.pose;
  if (!pose)
    return html`<div class="rs-card rs-pose is-stale">
      <p class="rs-label">${words.title}</p>
      <p class="rs-sub">${words.none}</p>
    </div>`;
  return html`<div class=${pose.stale ? 'rs-card rs-pose is-stale' : 'rs-card rs-pose'}>
    <p class="rs-label">${words.title}</p>
    <div class="rs-pose-body">
      ${poseFigure(pose, text)}
      <div class="rs-pose-readout">
        <p class="rs-sub">${words.heading}</p>
        <p class="rs-big" data-rs-heading>
          <span class="rs-number">${signed(pose.heading * DEGREES_PER_RADIAN, 0)}</span
          ><span class="rs-unit">°</span>
        </p>
        <p class="rs-sub">${words.headingNote}</p>
        <p class="rs-sub" data-rs-moved>
          ${fill(words.moved, { forward: signed(pose.forward, 2), left: signed(pose.left, 2) })}
        </p>
        <p class="rs-sub">${fill(words.grid, { cm: 50 })}</p>
        <button class="small quiet" data-rs-reset @click=${actions.resetPose}>
          ${words.reset}
        </button>
      </div>
    </div>
  </div>`;
}

// --- what is in front: a fan from the LiDAR, with the robot drawn behind it ---------------------

function fanPath(radius, arc) {
  const x = radius * Math.sin(arc);
  const y = -radius * Math.cos(arc);
  return `M0 0L${-x} ${y}A${radius} ${radius} 0 0 1 ${x} ${y}Z`;
}

function arcPath(radius, arc) {
  const x = radius * Math.sin(arc);
  const y = -radius * Math.cos(arc);
  return `M${-x} ${y}A${radius} ${radius} 0 0 1 ${x} ${y}`;
}

function frontFigure(front, text) {
  const range = front.range * CM;
  const width = 2 * range * Math.sin(front.arc) + 20;
  const rings = [];
  for (let ring = CM; ring < range; ring += CM) rings.push(ring);
  const distance = front.distance;
  const reached = distance !== null && distance <= front.range;
  return html`<svg
    class="rs-front-svg"
    viewBox=${`${-width / 2} ${-range - 10} ${width} ${range + LIDAR_AHEAD + ROBOT_SIZE / 2 + 14}`}
    role="img"
    aria-label=${text.front.label}
  >
    <path d=${fanPath(range, front.arc)} class="rs-fan" vector-effect="non-scaling-stroke" />
    ${rings.map(
      (ring) =>
        svg`<path d=${arcPath(ring, front.arc)} class="rs-grid" fill="none" vector-effect="non-scaling-stroke"/>`,
    )}
    ${front.points.map(
      (point) =>
        svg`<circle cx=${-point.left * CM} cy=${-point.forward * CM} r=${POINT_RADIUS} fill=${measured.color}/>`,
    )}
    ${
      reached
        ? svg`<path d=${arcPath(distance * CM, front.arc)} fill="none" stroke=${measured.color} stroke-width="3" vector-effect="non-scaling-stroke"/>`
        : nothing
    }
    ${questixTopSvg(0, LIDAR_AHEAD, -90, ROBOT_SIZE)}
  </svg>`;
}

function frontCard(model, text) {
  const front = model.front;
  const words = text.front;
  if (!front)
    return html`<div class="rs-card rs-front is-stale">
      <p class="rs-label">${words.title}</p>
      <p class="rs-sub">${words.none}</p>
    </div>`;
  const value =
    front.distance === null
      ? html`<span class="rs-clear">${fill(words.clear, { range: front.range })}</span>`
      : html`<span class="rs-number">${front.distance.toFixed(2)}</span
          ><span class="rs-unit">m</span>`;
  return html`<div class=${front.stale ? 'rs-card rs-front is-stale' : 'rs-card rs-front'}>
    <p class="rs-label">${words.title}</p>
    <p class="rs-big" data-rs-front>${value}</p>
    ${frontFigure(front, text)}
    <p class="rs-sub">${fill(words.grid, { range: front.range })}</p>
  </div>`;
}

function freshList(model, text) {
  const words = text.fresh;
  const shown = model.streams.filter((stream) => stream.offered);
  return html`<div class="rs-fresh">
    <span class="rs-label">${words.title}</span>
    <ul>
      ${shown.map(
        (stream) =>
          html`<li class=${stream.stale ? 'is-stale' : ''} data-rs-fresh=${stream.name}>
            <span>${words.streams[stream.name]}</span>
            <strong>${freshnessText(stream, words)}</strong>
          </li>`,
      )}
    </ul>
    <small>${words.staleNote}</small>
  </div>`;
}

function offlineLine(model, text, actions) {
  if (model.phase === 'connecting')
    return html`<p class="rs-offline" data-rs-offline>${text.connecting}</p>`;
  return html`<p class="rs-offline" data-rs-offline>
    <span>${text.offline}</span>
    <button class="small" data-rs-connect @click=${actions.connect}>${text.connect}</button>
  </p>`;
}

/**
 * The panel. `model` is robot-state-core robotStateModel(); `actions` needs `connect` (opens the
 * 実機 dialog) and `resetPose`; `status` is the lesson's own line about what is happening now
 * (e.g. which step of a run), or ''. Offline it is one line with the way to connect.
 */
function robotStateView(model, text, actions, status = '') {
  if (!model.connected) return offlineLine(model, text, actions);
  return html`<section class="robot-state" aria-label=${text.label} data-robot-state>
    <div class="rs-head">
      <h3 class="rs-title">${text.title}</h3>
      ${linkLine(model, text)}
    </div>
    ${status ? html`<p class="rs-status" role="status" data-rs-status>${status}</p>` : nothing}
    ${estopBlock(model, text)} ${driverBlock(model, text)}
    <div class="rs-grid-cards">
      ${wheelCard(model, 'left', text)} ${wheelCard(model, 'right', text)}
      ${motionCard(model, text)} ${poseCard(model, text, actions)} ${frontCard(model, text)}
    </div>
    ${freshList(model, text)}
  </section>`;
}

// --- the strip under a lesson's start button ------------------------------------------------------

function stripEstop(strip, text) {
  const words = text.strip.estop;
  if (strip.estop === 'pressed')
    return html`<p class="rs-strip-estop is-pressed" role="alert" data-rs-strip-estop="pressed">
      <span aria-hidden="true">⛔</span>${words.pressed}
    </p>`;
  return html`<p class="rs-strip-estop is-${strip.estop}" data-rs-strip-estop=${strip.estop}>
    ${words[strip.estop]}
  </p>`;
}

const rpmText = (value) => (value === null ? '—' : value.toFixed(1));

// The speed of the last ten seconds: measured solid, command dashed (roles of js/core/palette.js),
// named in HTML next to it so nothing is colour alone or smaller than 12 px.
function sparkline(strip, text) {
  const words = text.strip;
  const zero = strip.height / 2;
  return html`<figure class="rs-spark" data-rs-spark>
    <svg
      viewBox=${`0 0 ${strip.width} ${strip.height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label=${fill(words.sparkLabel, { top: strip.top })}
    >
      <line
        x1="0"
        x2=${strip.width}
        y1=${zero}
        y2=${zero}
        class="rs-spark-zero"
        vector-effect="non-scaling-stroke"
      />
      ${strip.measured.map(
        (points) =>
          svg`<polyline points=${points} fill="none" stroke=${measured.color} stroke-width="2.5" vector-effect="non-scaling-stroke"/>`,
      )}
      ${strip.commanded.map(
        // Over the measurement: where the wheels follow exactly, the dashes still show.
        (points) =>
          svg`<polyline points=${points} fill="none" stroke=${target.color} stroke-width="2" stroke-dasharray="5 4" vector-effect="non-scaling-stroke"/>`,
      )}
    </svg>
    <figcaption>
      <span class="rs-spark-key is-measured">${words.measured}</span>
      <span class="rs-spark-key is-target">${words.command}</span>
      <span>${fill(words.span, { seconds: 10, top: strip.top })}</span>
    </figcaption>
  </figure>`;
}

/**
 * The compact strip a live block shows right under its start / record button (robot-state.js
 * liveStateStrip draws it): the emergency stop, who drives, both wheels and the speed in numbers,
 * a sparkline of the speed, and `status`, the lesson's line about the run in progress (or '').
 * Nothing offline: the block already offers the connection.
 */
function stripView(strip, text, status = '') {
  if (!strip.connected) return nothing;
  const words = text.strip;
  const speed = strip.speed === null ? '—' : signed(strip.speed, 2);
  return html`<div class="rs-strip" data-live-strip aria-label=${words.label}>
    ${status ? html`<p class="rs-strip-status" role="status" data-rs-status>${status}</p>` : nothing}
    <div class="rs-strip-row">
      ${stripEstop(strip, text)}
      <p class="rs-strip-driver" data-rs-strip-driver=${strip.driver}>
        <span>${text.driver.title}</span> <strong>${text.driver[strip.driver]}</strong>
      </p>
    </div>
    <div class="rs-strip-row">
      <dl class="rs-strip-values">
        <div>
          <dt>${words.left}</dt>
          <dd data-rs-strip-wheel="left">${rpmText(strip.left)}<small>rpm</small></dd>
        </div>
        <div>
          <dt>${words.right}</dt>
          <dd data-rs-strip-wheel="right">${rpmText(strip.right)}<small>rpm</small></dd>
        </div>
        <div>
          <dt>${words.speed}</dt>
          <dd data-rs-strip-speed>${speed}<small>m/秒</small></dd>
        </div>
      </dl>
      ${sparkline(strip, text)}
    </div>
  </div>`;
}

/**
 * The memo under the panel: `memo` is `{text, connected, placeholder}` (placeholder: the place's
 * own example, or null for the general one); `actions` needs `write`, `snapshot`
 * and `save`. The textarea is only redrawn when the memo changes from outside the typing (a
 * snapshot line), so an input method's composition is never disturbed.
 */
function memoView(memo, text, actions) {
  const words = text.memo;
  return html`<div class="rs-memo" data-rs-memo>
    <label
      ><span class="rs-memo-label">${words.label}</span>
      <textarea
        rows="4"
        data-rs-memo-text
        placeholder=${memo.placeholder ?? words.placeholder}
        .value=${memo.text}
        @input=${(event) => actions.write(event.target.value)}
      ></textarea>
    </label>
    <div class="rs-memo-actions">
      <button
        class="rs-snapshot"
        data-rs-snapshot
        ?disabled=${!memo.connected}
        @click=${actions.snapshot}
      >
        ${words.snapshot}
      </button>
      <button class="quiet" data-rs-memo-save @click=${actions.save}>${words.save}</button>
    </div>
    <p class="helper">${memo.connected ? words.snapshotNote : words.offline} ${words.kept}</p>
  </div>`;
}

export { robotStateView, memoView, stripView };
