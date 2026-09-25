import { html, nothing, unsafeHTML } from '../vendor/lit-html.js';
import { loadJson, fillSentence as fill } from '../core/content.js';
import { runModeBadgeHtml } from '../shell/run-mode.js';
import {
  LEARNER_BLOCKERS,
  shootOffered,
  powerRange,
  reasonSentence,
  blockerValues,
  refusalSentence,
} from './shoot-core.js';

// The block a lesson shows where the learner operates the real launcher, and the stop bar every
// page shows while a roller turns. Pure templates of shoot-link.js's `shootModel()` plus the
// panel's own view state (`view`: the tilt being dragged, the record note, whether the last shot
// got a row); shoot-ui.js renders them. Sentences live in content/live/shoot.json.
//
// Two readers, as for driving (drive-view.js): the learner sees one sentence per reason and what
// to do; what a teacher needs (node names, launch arguments) is folded into one details element.

const shootCopy = await loadJson('content/live/shoot.json');

const isLearners = (blocker) => LEARNER_BLOCKERS.includes(blocker.code);
const studentText = (blocker) =>
  reasonSentence(blocker.code, shootCopy, blockerValues(blocker, shootCopy));

function teacherDetails(model) {
  const entries = model.blockers.filter((blocker) => shootCopy.blockers[blocker.code]?.teacher);
  if (!entries.length) return nothing;
  return html`<details class="drive-teacher">
    <summary>${shootCopy.teacherDetails}</summary>
    ${entries.map(
      (blocker) =>
        html`<p data-shoot-teacher=${blocker.code}>
          ${fill(shootCopy.blockers[blocker.code].teacher, blockerValues(blocker, shootCopy))}
        </p>`,
    )}
  </details>`;
}

// The reasons that need the teacher, in the learner's words.
function checklist(model) {
  if (!model.blockers.length)
    return html`<p class="drive-ready" data-shoot-ready>${shootCopy.ready}</p>`;
  const teacherSide = model.blockers.filter((blocker) => !isLearners(blocker));
  if (!teacherSide.length) return nothing;
  return html`<ul class="drive-blockers">
    ${teacherSide.map(
      (blocker) => html`<li data-shoot-blocker=${blocker.code}>${studentText(blocker)}</li>`,
    )}
  </ul>`;
}

function confirmBox(model, actions) {
  return html`<label class="drive-confirm shoot-confirm">
      <input
        type="checkbox"
        data-shoot-confirm
        .checked=${model.confirmed}
        ?disabled=${model.spinning}
        @change=${(event) => actions.confirm(event.target.checked)}
      />
      ${shootCopy.confirm}
    </label>
    <p class="drive-note">${shootCopy.confirmNote}</p>`;
}

function powerSlider(model, actions) {
  const range = powerRange(model.limits);
  return html`<label class="shoot-slider">
    <span>${shootCopy.power}</span>
    <input
      type="range"
      data-shoot-power
      min=${range.min}
      max=${range.max}
      step="1"
      .value=${String(model.percent)}
      ?disabled=${!model.allowed}
      @input=${(event) => actions.setPercent(Number(event.target.value))}
    />
    <output data-shoot-power-value>${model.percent}%</output>
  </label>`;
}

function tiltSlider(model, view, actions) {
  const shown = view.tiltPreview ?? model.tilt;
  const control = model.controls.tilt;
  return html`<label class="shoot-slider">
      <span>${shootCopy.tilt}</span>
      <input
        type="range"
        data-shoot-tilt
        min=${Math.ceil(model.limits.tilt_min)}
        max=${Math.floor(model.limits.tilt_max)}
        step="1"
        .value=${String(shown)}
        ?disabled=${!control.enabled}
        @input=${(event) => actions.previewTilt(Number(event.target.value))}
        @change=${(event) => actions.setTilt(Number(event.target.value))}
      />
      <output data-shoot-tilt-value>${shown}°</output>
    </label>
    <p class="drive-note">${shootCopy.tiltNote}</p>`;
}

function buttons(model, actions) {
  const spin = model.controls.spin;
  const fire = model.controls.fire;
  const spinButton = spin.stop
    ? html`<button class="drive-stop" data-shoot-spin="stop" @click=${actions.stopOwn}>
        ${shootCopy.spinStop}
      </button>`
    : html`<button
        class="drive-start"
        data-shoot-spin="start"
        ?disabled=${!spin.enabled}
        @click=${actions.startRoller}
      >
        ${shootCopy.spin}
      </button>`;
  return html`<div class="live-capture-actions shoot-actions">
    ${spinButton}
    <button class="shoot-fire" data-shoot-fire ?disabled=${!fire.enabled} @click=${actions.fire}>
      ${shootCopy.fire}
    </button>
  </div>`;
}

// While this page's roller turns: how long until it is steady (a bar filling up), then ready.
function spinLine(model) {
  if (!model.spinning) return nothing;
  if (model.afterShot)
    return html`<p class="drive-progress" role="status" data-shoot-spin-state="after">
      ${shootCopy.afterShot}
    </p>`;
  const full = model.limits.spin_up_sec;
  if (model.owner !== 'me' || model.spinReadyIn === null)
    return html`<p class="drive-progress" data-shoot-spin-state="starting">
      ${shootCopy.starting}
    </p>`;
  const done = model.spinReadyIn <= 0;
  const text = done
    ? shootCopy.spinReady
    : fill(shootCopy.spinUp, { seconds: model.spinReadyIn.toFixed(1) });
  return html`<div class="shoot-spin" data-shoot-spin-state=${done ? 'ready' : 'spinning'}>
    <meter min="0" max=${full} .value=${Math.max(0, full - model.spinReadyIn)}></meter>
    <p class="drive-progress" role="status">${text}</p>
    ${
      model.sessionLeft !== null
        ? html`<p class="drive-note">
            ${fill(shootCopy.sessionLeft, { seconds: Math.ceil(model.sessionLeft) })}
          </p>`
        : nothing
    }
  </div>`;
}

// The one learner reason next to the buttons: the one for 「ローラーを回す」 while it cannot be
// pressed, otherwise the one for 「1枚発射」 (except the countdown, which spinLine shows).
function whyLine(model) {
  const spin = model.controls.spin;
  const fire = model.controls.fire;
  const reason = spin.enabled ? fire.reason : spin.reason;
  if (!reason || (spin.enabled && reason.key === 'spinning_up')) return nothing;
  const blocker = model.blockers.find((entry) => entry.code === reason.key);
  if (blocker && !isLearners(blocker) && !spin.enabled) return nothing; // listed above already
  const text = blocker
    ? studentText(blocker)
    : reasonSentence(reason.key, shootCopy, reason.values);
  return html`<p class="drive-why" data-shoot-why=${reason.key}>${text}</p>`;
}

function notFiredText(note) {
  const reason = shootCopy.notFiredReasons[note.reason] ?? '';
  return fill(shootCopy.notFired, { reason });
}

function noteText(model, view) {
  const note = model.note;
  if (!note) return '';
  if (note.kind === 'refused') return refusalSentence(note.refused, shootCopy, model.limits);
  if (note.kind === 'not_fired') return notFiredText(note);
  if (note.kind === 'fired')
    return fill(view.rowAdded === false ? shootCopy.firedFull : shootCopy.fired, {
      percent: note.row.percent,
      tilt: Math.round(note.row.tilt),
    });
  return shootCopy.ended[note.key] ?? note.key;
}

function noteLines(model, view) {
  const text = noteText(model, view);
  return html`${
    text
      ? html`<p class="drive-result" role="status" data-shoot-note=${model.note.kind}>${text}</p>`
      : nothing
  }${view.recordNote ? html`<p class="drive-note" data-shoot-record>${view.recordNote}</p>` : nothing}`;
}

function stateValue(value, fresh, heard) {
  if (fresh) return value;
  return heard ? shootCopy.state.stale : shootCopy.state.never;
}

// The emergency stop as the drive strip says it (「非常停止：押されています／解除されています」),
// from the bridge's own check: the launcher cannot run while it is pressed.
function estopLine(model) {
  const pressed = model.blockers.some((blocker) => blocker.code === 'emergency_stop');
  return html`<p
    class=${pressed ? 'rs-strip-estop is-pressed' : 'rs-strip-estop is-released'}
    data-shoot-estop=${pressed ? 'pressed' : 'released'}
  >
    ${pressed ? html`<span aria-hidden="true">⛔</span>` : nothing}${
      pressed ? shootCopy.estop.pressed : shootCopy.estop.released
    }
  </p>`;
}

/** The launcher's own values: the roller command and who gives it, the tilt, the shots. */
function launcherState(model) {
  const words = shootCopy.state;
  const { roller, shot, heard } = model.launcher;
  const rollerText = roller
    ? fill(words.rollerValue, {
        percent: roller.percent ?? '—',
        source: words.sources[roller.source],
      })
    : '';
  const firedText = shot
    ? fill(words.firedValue, { count: shot.fired ?? '—', mine: model.shotsThisPage })
    : '';
  return html`<div class="shoot-state" data-shoot-state>
    <p class="rs-label">${words.title}</p>
    <dl>
      <div data-shoot-state-roller=${roller?.source ?? 'none'}>
        <dt>${words.roller}</dt>
        <dd>${stateValue(rollerText, Boolean(roller), heard.roller)}</dd>
      </div>
      <div>
        <dt>${words.tilt}</dt>
        <dd data-shoot-state-tilt>
          ${stateValue(fill(words.tiltValue, { tilt: shot?.tilt?.toFixed(1) ?? '—' }), Boolean(shot), heard.shot)}
        </dd>
      </div>
      <div>
        <dt>${words.fired}</dt>
        <dd data-shoot-state-fired>${stateValue(firedText, Boolean(shot), heard.shot)}</dd>
      </div>
    </dl>
    ${shot?.shooting ? html`<p class="shoot-state-flag">${words.shooting}</p>` : nothing}
    ${roller?.locked && roller.source !== 'joy' ? html`<p class="drive-note">${words.locked}</p>` : nothing}
    <p class="drive-note">${words.note}</p>
  </div>`;
}

function limitsNote(model) {
  const range = powerRange(model.limits);
  return html`<p class="drive-note">
      ${fill(shootCopy.limits, {
        min: range.min,
        max: range.max,
        tiltMin: Math.ceil(model.limits.tilt_min),
        tiltMax: Math.floor(model.limits.tilt_max),
        interval: model.limits.fire_interval_sec,
      })}
    </p>
    <p class="drive-note">${fill(shootCopy.how, { seconds: model.limits.seconds })}</p>`;
}

// Nothing to operate (no robot, the teacher has not allowed it, an older bridge): one line, the
// launcher's values when the robot sends them, and the lesson's typed data carries on.
function offLine(model, after) {
  const code = model.blockers[0]?.code;
  let text = shootCopy.notAllowed;
  if (code === 'no_link') text = shootCopy.offline;
  else if (code === 'old_bridge') text = shootCopy.oldBridge;
  const heard = model.launcher.heard.roller || model.launcher.heard.shot;
  return html`<div
    class="drive-block drive-block-off shoot-block"
    data-shoot-block
    data-shoot-off=${code}
  >
    <p>${text}</p>
    ${teacherDetails(model)} ${code !== 'no_link' && heard ? launcherState(model) : nothing}
    ${after}
  </div>`;
}

/**
 * The launcher block: `model` from shootModel(), `view` the panel's state (`tiltPreview`,
 * `recordNote`, `rowAdded`), `actions`: confirm, setPercent, previewTilt, setTilt, startRoller,
 * stopOwn, fire. `after`: the lesson's part right under the buttons (launcherPanel's `after`).
 */
function shootBlock(model, view, actions, after = nothing) {
  const heading = html`<h2>${unsafeHTML(runModeBadgeHtml('drive'))} ${shootCopy.title}</h2>`;
  if (!shootOffered(model)) return html`${heading}${offLine(model, after)}`;
  return html`${heading}
    <div class="drive-block shoot-block" data-shoot-block>
      <p>${shootCopy.lead}</p>
      ${checklist(model)} ${teacherDetails(model)} ${confirmBox(model, actions)}
      <div class="shoot-sliders">
        ${powerSlider(model, actions)}${tiltSlider(model, view, actions)}
      </div>
      <div class="shoot-run" data-shoot-run>
        ${buttons(model, actions)} ${spinLine(model)} ${whyLine(model)} ${after}
        <div class="shoot-strip" data-live-strip>${estopLine(model)} ${launcherState(model)}</div>
        ${noteLines(model, view)}
      </div>
      ${limitsNote(model)}
    </div>`;
}

/** The bar fixed at the bottom of every page while a roller turns on a page's command. */
function shootStopBar(model, stop) {
  const turning = model.spinning || (model.active && model.power > 0);
  if (!turning) return nothing;
  const mine = model.spinning || model.owner === 'me';
  return html`<div class="drive-bar shoot-bar" role="alert" data-shoot-bar>
    <span class="drive-bar-dot" aria-hidden="true"></span>
    <strong>${mine ? shootCopy.bar.mine : shootCopy.bar.other}</strong>
    <button class="drive-bar-stop" data-shoot-bar-stop @click=${stop}>
      ${shootCopy.bar.stop}${
        mine ? html`<span class="drive-bar-esc">${shootCopy.bar.esc}</span>` : nothing
      }
    </button>
  </div>`;
}

/** A recorded launcher session in 記録の一覧 (`summary` from launcherRecordSummary). */
function launcherRecordView(summary) {
  const words = shootCopy.summary;
  return html`<div class="shoot-record" data-shoot-record-summary>
    <p>
      ${fill(words.line, {
        percent: summary.maxPercent ?? '—',
        tilt: summary.tilt === null ? '—' : summary.tilt.toFixed(1),
        fired: summary.fired,
      })}
    </p>
    ${summary.controller ? html`<p>${words.controller}</p>` : nothing}
    ${summary.estop ? html`<p>${words.estop}</p>` : nothing}
    <p class="drive-note">${words.note}</p>
  </div>`;
}

export { shootCopy, shootBlock, shootStopBar, launcherRecordView };
