import { html, nothing } from '../vendor/lit-html.js';
import { fillSentence as fill } from '../core/content.js';
import { recordsCopy as copy, lessonName, megabytes, BAG_MAX_SECONDS } from './records-core.js';
import { driveReportView } from './drive-report-view.js';
import { launcherRecordSummary } from './shoot-core.js';
import { launcherRecordView } from './shoot-view.js';

// Templates of 記録の一覧 (records-ui.js) and of the 「ロボットの記録から選ぶ」 picker
// (record-picker.js): pure functions of the model those modules build. The pieces both show — one
// record, one rosbag with its time window — are shared, so a record looks the same wherever it is
// chosen. Sentences come from content/live/records.json.

const STATUS_ICONS = { ok: '✓', stopped: '■', problem: '⚠︎', none: '●' };

const pad = (number) => String(number).padStart(2, '0');

/** 「9/25 10:51」 in local time, '' for a missing date. */
function dateText(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const secondsText = (seconds) => fill(copy.item.seconds, { seconds: seconds.toFixed(1) });

// --- one record -------------------------------------------------------------------------------

// Only the lesson records carry a 班; for them, saying there was none is worth the space.
function groupText(entry) {
  if (entry.group) return fill(copy.item.group, { group: entry.group });
  return ['lab', 'local'].includes(entry.source) ? copy.item.noGroup : '';
}

// What a record is, in the order a learner looks for it: its name, then lesson, group, robot, when,
// how long and how it ended.
function recordFacts(item) {
  const entry = item.entry;
  // A record without a label of its own is already headed by its lesson.
  const lesson = item.label === lessonName(item.lesson) ? '' : lessonName(item.lesson);
  const facts = [
    lesson,
    groupText(entry),
    entry.robot ?? '',
    dateText(entry.recordedAt),
    secondsText(entry.seconds),
  ].filter(Boolean);
  return html`<p class="records-facts">
    ${facts.map((fact) => html`<span>${fact}</span>`)}
    <span class="records-outcome ${item.outcomeKind}"
      ><span class="records-outcome-icon" aria-hidden="true">${STATUS_ICONS[item.outcomeKind]}</span
      >${item.outcome}</span
    >
    ${item.onRobot ? html`<span class="records-badge">${copy.item.saved}</span>` : nothing}
    ${item.fromFile ? html`<span class="records-badge">${copy.item.fromFile}</span>` : nothing}
  </p>`;
}

// More than a couple of lessons (a controller drive fits almost all) are folded, so the list stays
// a list on a phone.
const FOLDED_TARGETS = 2;

function targetButtons(item, actions) {
  if (!item.targets.length) return nothing;
  const buttons = targetList(item, actions);
  if (item.targets.length <= FOLDED_TARGETS) return buttons;
  return html`<details class="records-more">
    <summary>${fill(copy.actions.openMore, { count: item.targets.length })}</summary>
    ${buttons}
  </details>`;
}

function targetList(item, actions) {
  return html`<div class="records-targets" role="group" aria-label=${copy.actions.openTitle}>
    ${item.targets.map(
      (target) =>
        html`<button
            class="quiet"
            data-records-open=${target.id}
            ?disabled=${item.busy}
            @click=${() => actions.openIn(item.key, target.id, false)}
          >
            ${fill(copy.actions.open, { lesson: lessonName(target.id) })}
          </button>
          ${
            target.compare
              ? html`<button
                  class="quiet"
                  data-records-compare=${target.id}
                  ?disabled=${item.busy}
                  @click=${() => actions.openIn(item.key, target.id, true)}
                >
                  ${fill(copy.actions.compare, { lesson: lessonName(target.id) })}
                </button>`
              : nothing
          }`,
    )}
  </div>`;
}

function recordActions(item, actions) {
  return html`<div class="records-actions">
      <button
        data-records-view=${item.key}
        aria-expanded=${item.open ? 'true' : 'false'}
        ?disabled=${item.busy && !item.open}
        @click=${() => actions.toggleView(item.key)}
      >
        ${item.open ? copy.actions.hide : copy.actions.view}
      </button>
      <button
        class="quiet"
        data-records-save="json"
        ?disabled=${item.busy}
        @click=${() => actions.save(item.key, 'json')}
      >
        ${copy.actions.saveJson}
      </button>
      <button
        class="quiet"
        data-records-save="csv"
        ?disabled=${item.busy}
        @click=${() => actions.save(item.key, 'csv')}
      >
        ${copy.actions.saveCsv}
      </button>
    </div>
    ${targetButtons(item, actions)}`;
}

function itemStatus(item) {
  if (item.busy) return html`<p class="records-status" role="status">${copy.actions.loading}</p>`;
  if (item.error) return html`<p class="records-error" role="alert">${item.error}</p>`;
  if (item.message) return html`<p class="records-status" role="status">${item.message}</p>`;
  return nothing;
}

// The run report of the record, right under it (press → see), with the same charts as the run
// history of the 実機 dialog.
function itemReport(item, actions) {
  if (!item.open || !item.run) return nothing;
  // A launcher session (js/live/shoot-ui.js) did not drive: its roller and tilt instead.
  const launcher = item.run.slot === 'launch-measure' && launcherRecordSummary(item.run.recording);
  if (launcher)
    return html`<div class="records-report" data-records-report=${item.key}>
      ${launcherRecordView(launcher)}
    </div>`;
  return html`<div class="records-report" data-records-report=${item.key}>
    ${driveReportView(item.run, { saveRun: (id, kind) => actions.save(item.key, kind) })}
  </div>`;
}

/** One record of 記録の一覧: facts, 見る / 保存 / 教材で開く, and its report when opened. */
function recordItem(item, actions) {
  return html`<li class="records-item" data-records-item=${item.key}>
    <h4 class="records-label">${item.label}</h4>
    ${recordFacts(item)} ${recordActions(item, actions)} ${itemStatus(item)}
    ${itemReport(item, actions)}
  </li>`;
}

/** One record of the picker: facts and 「これを開く」 (「これを重ねる」 when comparing). */
function pickItem(item, actions, compare) {
  return html`<li class="records-item" data-records-item=${item.key}>
    <h4 class="records-label">${item.label}</h4>
    ${recordFacts(item)}
    <div class="records-actions">
      <button
        class="primary"
        data-picker-use=${item.key}
        ?disabled=${item.busy}
        @click=${() => actions.use(item.key)}
      >
        ${compare ? copy.actions.useCompare : copy.actions.use}
      </button>
    </div>
    ${itemStatus(item)}
  </li>`;
}

// --- one rosbag --------------------------------------------------------------------------------

function windowField(bag, field, label, actions, max) {
  return html`<label class="records-window-field"
    >${label}
    <input
      type="number"
      inputmode="decimal"
      min="0"
      max=${max}
      step="1"
      data-bag-window=${field}
      .value=${String(bag.window[field])}
      ?disabled=${Boolean(bag.converting)}
      @change=${(event) => actions.setBagWindow(bag.key, field, event.target.value)}
  /></label>`;
}

function bagTopics(bag) {
  return html`<p class="records-facts">
    <span>${dateText(bag.bag.startedAt)}</span><span>${secondsText(bag.bag.seconds)}</span
    ><span>${fill(copy.item.size, { size: megabytes(bag.bag.bytes) })}</span>
    <span>${fill(copy.bag.topics, { topics: bag.bag.topics.join('・') || '—' })}</span>
  </p>`;
}

function bagConverting(bag, actions) {
  return html`<p class="records-status" role="status">
      ${fill(copy.bag.converting, { seconds: bag.converting.seconds })}
    </p>
    <button class="quiet" data-bag-cancel @click=${() => actions.cancelConvert(bag.key)}>
      ${copy.bag.cancel}
    </button>`;
}

function bagWindowControls(bag, actions, convertLabel) {
  const max = Math.max(0, Math.floor(bag.bag.seconds));
  return html`<div class="records-window">
    ${windowField(bag, 'start', copy.bag.start, actions, max)}
    ${windowField(bag, 'seconds', copy.bag.length, actions, BAG_MAX_SECONDS)}
    <p class="records-window-text">
      ${fill(copy.bag.window, {
        start: bag.window.start,
        seconds: bag.window.seconds,
        total: bag.bag.seconds.toFixed(0),
      })}
    </p>
    ${
      bag.converting
        ? bagConverting(bag, actions)
        : html`<button data-bag-convert @click=${() => actions.convertBag(bag.key)}>
            ${convertLabel}
          </button>`
    }
  </div>`;
}

/**
 * One rosbag of Robot Manager: when, how long, which topics; for a usable one the time window and
 * 「変換して見る」 (page; the result is listed under 変換済みの録画) or 「変換して開く」 (picker).
 */
function bagItem(bag, actions, { picker = false } = {}) {
  const unusable = !bag.bag.usable;
  return html`<li class="records-item records-bag" data-records-bag=${bag.bag.name}>
    <h4 class="records-label">${bag.bag.name}</h4>
    ${bagTopics(bag)}
    ${
      unusable
        ? html`<p class="records-error">
            ${fill(copy.bag.unusable, { reason: bag.bag.reason || copy.bag.unusableUnknown })}
          </p>`
        : bagWindowControls(bag, actions, picker ? copy.bag.convertUse : copy.bag.convert)
    }
    ${bag.error ? html`<p class="records-error" role="alert">${bag.error}</p>` : nothing}
  </li>`;
}

// --- 記録の一覧 --------------------------------------------------------------------------------

function filterSelect(label, key, value, options, allLabel, actions) {
  return html`<label class="records-filter"
    >${label}
    <select
      data-records-filter=${key}
      @change=${(event) => actions.setFilter(key, event.target.value)}
    >
      <option value="" ?selected=${value === ''}>${allLabel}</option>
      ${options.map(
        (option) =>
          html`<option value=${option.value} ?selected=${option.value === value}>
            ${option.label}
          </option>`,
      )}
    </select></label
  >`;
}

function filterCheck(label, key, checked, actions, disabled = false) {
  return html`<label class="records-check"
    ><input
      type="checkbox"
      data-records-filter=${key}
      .checked=${checked}
      ?disabled=${disabled}
      @change=${(event) => actions.setFilter(key, event.target.checked)}
    />${label}</label
  >`;
}

function filters(model, actions) {
  const text = copy.filters;
  const filter = model.filters;
  const lessons = model.choices.lessons.map((key) => ({ value: key, label: lessonName(key) }));
  const groups = model.choices.groups.map((group) => ({ value: group, label: group }));
  const mine = model.myGroup ? fill(text.mine, { group: model.myGroup }) : text.mineNoGroup;
  // Folded, with the count in its summary: on a phone the records come first.
  return html`<details class="records-filters" data-records-filters>
    <summary>
      ${text.title}
      <span class="records-count" role="status">
        ${fill(text.count, { shown: model.records.length, total: model.total })}
      </span>
    </summary>
    <div class="records-filter-fields">
      ${filterSelect(text.lesson, 'lesson', filter.lesson, lessons, text.lessonAll, actions)}
      ${filterSelect(text.group, 'group', filter.group, groups, text.groupAll, actions)}
      ${filterCheck(mine, 'mine', filter.mine, actions, !model.myGroup)}
      ${filterCheck(text.controller, 'controller', filter.controller, actions)}
    </div>
  </details>`;
}

function offlineNote(model, actions, sentence = copy.offline) {
  return html`<div class="records-offline" data-records-offline>
    <p>${sentence}</p>
    <button class="primary" @click=${actions.connect}>${copy.connect}</button>
  </div>`;
}

function quotaLine(model) {
  if (!model.quota?.limit) return nothing;
  const used = megabytes(model.quota.used);
  const limit = megabytes(model.quota.limit);
  const full = model.quota.used >= model.quota.limit;
  return html`<p class=${full ? 'records-error' : 'records-note'}>
    ${fill(copy.quota, { used, limit })}${full ? html` ${copy.quotaFull}` : nothing}
  </p>`;
}

function robotSection(model, actions) {
  const text = copy.sections;
  if (!model.connected)
    return html`<section class="records-section card" data-records-robot>
      <h2>${text.robot}</h2>
      ${offlineNote(model, actions)}
    </section>`;
  return html`<section class="records-section card" data-records-robot>
    <div class="records-section-top">
      <h2>${text.robot}</h2>
      <button class="quiet" data-records-reload ?disabled=${model.loading} @click=${actions.reload}>
        ${copy.reload}
      </button>
    </div>
    <p>${text.robotLead}</p>
    ${model.robot ? html`<p class="records-note">${fill(copy.robotName, { robot: model.robot })}</p>` : nothing}
    ${quotaLine(model)}
    ${model.list && !model.save ? html`<p class="records-note">${copy.saveOff}</p>` : nothing}
    ${model.loading ? html`<p class="records-status" role="status">${copy.loading}</p>` : nothing}
    ${model.error ? html`<p class="records-error" role="alert">${model.error}</p>` : nothing}
    ${model.list ? filters(model, actions) : nothing}
    ${
      model.list && !model.records.length && !model.loading
        ? html`<p>${text.robotEmpty}</p>`
        : nothing
    }
    <ul class="records-list">
      ${model.records.map((item) => recordItem(item, actions))}
    </ul>
  </section>`;
}

function bagSection(model, actions) {
  const text = copy.sections;
  if (!model.connected) return nothing;
  const bags = model.bags;
  const body = bags.supported
    ? html`<p>${fill(text.bagsLead, { max: BAG_MAX_SECONDS })}</p>
        ${bags.error ? html`<p class="records-error" role="alert">${bags.error}</p>` : nothing}
        ${
          bags.converted.length
            ? html`<h3>${text.converted}</h3>
                <ul class="records-list">
                  ${bags.converted.map((item) => recordItem(item, actions))}
                </ul>`
            : nothing
        }
        ${!bags.list.length && !bags.loading ? html`<p>${text.bagsEmpty}</p>` : nothing}
        <ul class="records-list">
          ${bags.list.map((bag) => bagItem(bag, actions))}
        </ul>`
    : html`<p>${text.bagsOff}</p>`;
  return html`<section class="records-section card" data-records-bags>
    <h2>${text.bags}</h2>
    ${body}
  </section>`;
}

function localSection(model, actions) {
  const text = copy.sections;
  return html`<section class="records-section card" data-records-local>
    <h2>${text.local}</h2>
    <p>${text.localLead}</p>
    ${model.local.length ? nothing : html`<p>${text.localEmpty}</p>`}
    <ul class="records-list">
      ${model.local.map((item) => recordItem(item, actions))}
    </ul>
  </section>`;
}

/** 記録の一覧: the robot's records, Robot Manager's rosbags and this device's runs. */
function recordsPage(model, actions) {
  return html`<div class="records-page-inner">
    <div class="page-heading">
      <div>
        <p class="eyebrow">${copy.eyebrow}</p>
        <h1>${copy.title}</h1>
      </div>
    </div>
    <p>${copy.lead}</p>
    <p class="records-privacy" data-records-privacy>${copy.privacy}</p>
    ${robotSection(model, actions)} ${bagSection(model, actions)} ${localSection(model, actions)}
  </div>`;
}

// --- the picker -------------------------------------------------------------------------------

function pickerBody(model, actions) {
  const text = copy.picker;
  if (!model.connected) return offlineNote(model, actions, text.offline);
  const empty = !model.loading && !model.error && !model.records.length && !model.bags.length;
  return html`${model.loading ? html`<p class="records-status" role="status">${copy.loading}</p>` : nothing}
    ${model.error ? html`<p class="records-error" role="alert">${model.error}</p>` : nothing}
    ${empty ? html`<p>${model.showAll ? text.emptyAll : text.empty}</p>` : nothing}
    <ul class="records-list">
      ${model.records.map((item) => pickItem(item, actions, model.compare))}
    </ul>
    ${
      model.bags.length
        ? html`<h3>${copy.sections.bags}</h3>
            <ul class="records-list">
              ${model.bags.map((bag) => bagItem(bag, actions, { picker: true }))}
            </ul>`
        : nothing
    }`;
}

/** The picker dialog's content: lead, 「ほかも表示」, the records of this lesson (or all). */
function recordPicker(model, actions) {
  const text = copy.picker;
  const lead = model.showAll
    ? fill(text.leadAll, { streams: model.streams })
    : fill(text.lead, { lesson: lessonName(model.lesson) });
  return html`<header class="dialog-heading">
      <h2 id="recordPickerTitle">${text.title}</h2>
      <button data-picker-close aria-label=${text.close} @click=${actions.close}>×</button>
    </header>
    <div class="record-picker-body">
      <p>${lead}</p>
      <p class="records-privacy">${copy.privacyShort}</p>
      ${
        model.connected
          ? filterCheck(text.showAll, 'showAll', model.showAll, {
              setFilter: (key, value) => actions.setShowAll(value),
            })
          : nothing
      }
      ${model.message ? html`<p class="records-error" role="alert">${model.message}</p>` : nothing}
      ${pickerBody(model, actions)}
    </div>
    <footer class="record-picker-footer">
      <button class="quiet" data-picker-records @click=${actions.openRecords}>
        ${text.records}
      </button>
      <button @click=${actions.close}>${text.close}</button>
    </footer>`;
}

export { recordsPage, recordPicker };
