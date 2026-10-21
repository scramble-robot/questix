/* QUESTiX operator controls: edits are persisted for the next robot restart. */
let controlProfile = null;
let controlDraft = null;
let controlsDirty = false;
let controlsBusy = false;
let controlsOpened = false;
let launchController = null;
let controlsLoadedAt = null;
let controlRuntime = null;
let runtimeBusy = false;
let runtimeAvailable = false;
let runtimeGeneration = 0;
let mapSelection = null;
let mapReturnTarget = null;
let tuningTimes = {};
let rangeWarningActive = false;
let rangeRepairLateral = false;

function tuningRangeIssues(values) {
  const speeds = ["longitudinal_input_ratio", "lateral_input_ratio", "angular_input_ratio"];
  return controlProfile.groups.filter((group) => group.node === "joy_controller")
    .flatMap((group) => group.fields.filter((field) => speeds.includes(field.key)
      && (!TuningModel.finite(values[group.node][field.key])
        || values[group.node][field.key] < field.min || values[group.node][field.key] > field.max))
      .map((field) => ({ node: group.node, key: field.key,
        value: values[group.node][field.key], min: field.min, max: field.max })));
}

function createRangeWarning() {
  const host = document.getElementById("controls-range-warning");
  const issues = [...tuningRangeIssues(controlProfile.values), ...tuningRangeIssues(controlDraft)];
  const unique = [...new Map(issues.map((issue) => [issue.key, issue])).values()];
  rangeWarningActive = unique.length > 0;
  rangeRepairLateral = unique.some((issue) => issue.key === "lateral_input_ratio");
  host.hidden = !rangeWarningActive;
  host.classList.toggle("has-lateral-repair", rangeRepairLateral);
  host.replaceChildren();
  for (const issue of unique) {
    const warning = document.createElement("p");
    warning.textContent = TuningModel.finite(issue.value)
      ? TuningModel.speedWarning(issue.key, issue.value, issue.max, true)
      : "読み込んだ速さを確認してください。";
    host.appendChild(warning);
  }
  const status = document.createElement("p");
  status.id = "controls-range-state";
  status.setAttribute("aria-live", "polite");
  host.appendChild(status);
  if (!rangeRepairLateral) return;
  const label = document.createElement("label");
  label.htmlFor = "control-lateral-repair";
  label.textContent = "左右の速さ（保存値の修正、m/s）";
  const input = document.createElement("input");
  input.id = label.htmlFor;
  input.type = "number";
  input.min = 0;
  input.max = unique.find((issue) => issue.key === "lateral_input_ratio").max;
  input.step = "any";
  input.required = true;
  input.value = Math.abs(controlDraft.joy_controller.lateral_input_ratio);
  const help = document.createElement("p");
  help.id = "control-lateral-repair-help";
  help.textContent = "この機体（左右 2 輪）では使われませんが、保存するには範囲内にしてください。"
    + `入力できる範囲：0〜${Number(input.max).toFixed(1)} m/s（方向の反転は保存済みのまま）。値は自動で変更しません。`;
  input.setAttribute("aria-describedby", help.id);
  input.addEventListener("input", () => {
    if (controlsBusy) return;
    const direction = tuningDirection(controlDraft.joy_controller.lateral_input_ratio,
      controlProfile.values.joy_controller.lateral_input_ratio);
    controlDraft.joy_controller.lateral_input_ratio = input.value === "" ? null : Number(input.value) * direction;
    refreshControlChanges(input);
  });
  host.append(label, input, help);
}

function refreshRangeWarning() {
  if (!rangeWarningActive) return;
  const issues = tuningRangeIssues(controlDraft);
  document.getElementById("controls-range-state").textContent = issues.length
    ? "範囲の外の値が残っています。編集していない項目も含め、範囲内にしてから保存してください。"
    : "速さは範囲内に修正されました。まだ保存されていません。「操作設定を保存」で確定します。";
  if (rangeRepairLateral) {
    const input = document.getElementById("control-lateral-repair");
    input.disabled = controlsBusy;
    const issue = issues.find((item) => item.key === "lateral_input_ratio");
    input.setCustomValidity(issue ? "左右の速さを入力できる範囲内にしてください。" : "");
    input.setAttribute("aria-invalid", String(Boolean(issue)));
  }
}

// UI choices and units only. Defaults and validation limits come from the profile API.
const tuningFields = {
  joy_controller: {
    longitudinal_input_ratio: { title: "走行速度", unit: "m/s", scale: 1, signed: true,
      help: "スティックを最大まで倒したときの前進・後退の速さ。速さを変えると、加速時間を保つよう加速度を計算し直します。" },
    angular_input_ratio: { title: "旋回の速さ", unit: "rad/s", scale: 1, signed: true },
  },
  drive_component: {
    max_linear_accel: { title: "走り出し・停止のきびきび感（加速時間）", acceleration: true,
      kind: "linear", unit: "s", scale: 1 },
    max_angular_accel: { title: "旋回のきびきび感（加速時間）", acceleration: true,
      kind: "angular", unit: "s", scale: 1 },
  },
  joy_launcher: {
    full_speed_value: { title: "ローラー出力", unit: "%", scale: 100,
      help: "回転ボタンを押したときの出力。0% で停止、100% で最大出力です。" },
  },
  joy_node: { deadzone: { title: "スティックの遊び", unit: "%", scale: 100,
    help: "中心付近の小さな傾きを無視する幅。触っていないのに動くときは大きくします。" } },
  uart_joy_driver: { deadzone: { title: "スティックの遊び", unit: "%", scale: 100,
    help: "中心付近の小さな傾きを無視する幅。触っていないのに動くときは大きくします。" } },
};

// Stick dead zone of the input driver each controller type actually starts.
const controllerDrivers = { dualshock: "joy_node", uart: "uart_joy_driver" };

function tuningSpec(node, key) {
  if (Object.values(controllerDrivers).includes(node)
      && controllerDrivers[controlProfile.controller] !== node) return null;
  const spec = tuningFields[node]?.[key];
  if (node === "joy_controller" && key === "angular_input_ratio") {
    const reference = Math.abs(controlProfile.defaults[node][key]);
    return { ...spec, help: "スティックを最大まで倒したときの旋回の速さ。速さを変えると、加速時間を保つよう加速度を計算し直します。0では旋回しません。",
      presets: [[reference * 0.5, "ゆっくり 50%"], [reference, "標準 100%"], [reference * 1.5, "速め 150%"]],
      baseline: reference };
  }
  if (spec?.acceleration) {
    return { ...spec,
      help: "停止から車輪の上限を考慮した最高速度までの時間の目安です。短いほどきびきび変化します。上限を超えない設定では、スティックを戻したときの減速も、同じ時間が目安です（非常停止は別で、すぐに止まります）。",
      presets: [[0.5, "おだやか 50%"], [1, "標準 100%"], [1.5, "きびきび 150%"]]
        .map(([factor, title]) => [TuningModel.presetTime(controlProfile.defaults,
          controlProfile.geometry, spec.kind, factor), title]) };
  }
  return spec;
}

function tuningNumber(spec, value, values = controlDraft) {
  if (value === null) return "";
  if (spec.acceleration) {
    const snapshot = { ...values, drive_component: { ...values.drive_component,
      [TuningModel.axes[spec.kind].accel]: value } };
    return TuningModel.number(TuningModel.motion(snapshot, controlProfile.geometry, spec.kind)?.time);
  }
  const displayed = (spec.signed ? Math.abs(value) : value) * spec.scale;
  const rounded = Number(displayed.toFixed(2));
  return displayed !== 0 && rounded === 0 ? Number(displayed.toPrecision(3)) : rounded;
}

function tuningDirection(current, saved) {
  return current < 0 || (current === 0 || current === null) && saved < 0 ? -1 : 1;
}

function tuningValue(spec, value, values = controlDraft, geometry = controlProfile.geometry) {
  if (spec.acceleration && value === 0) return "制限なし";
  if (spec.acceleration) {
    const state = TuningModel.motion(values, geometry, spec.kind);
    if (!state) return "加速時間は未確認";
    if (state.speed === 0) return spec.kind === "angular" ? "旋回なし（時間は算出できません）" : "走行なし（時間は算出できません）";
    return `${TuningModel.number(state.time)} s`;
  }
  if (spec.signed) return TuningModel.speedText(value,
    spec.unit === "rad/s" ? "angular" : "linear");
  return `${tuningNumber(spec, value)} ${spec.unit}${spec.signed && value < 0 ? "（方向反転）" : ""}`;
}

function runtimeTuningValues() {
  const values = {};
  for (const [node, report] of Object.entries(controlRuntime?.nodes || {})) {
    if (report.status === "ok") values[node] = report.values;
  }
  return values;
}

function refreshTuningFields(activeInput) {
  for (const row of document.querySelectorAll(".control-field")) {
    const { node, key } = row.dataset;
    const spec = tuningSpec(node, key);
    const input = document.getElementById(`control-${node}-${key}`);
    const field = controlProfile.groups.find((group) => group.node === node).fields.find((f) => f.key === key);
    const kind = spec.kind || (key === "angular_input_ratio" ? "angular" : "linear");
    const state = spec.signed || spec.acceleration
      ? TuningModel.motion(controlDraft, controlProfile.geometry, kind) : null;
    const note = row.querySelector(".control-estimate");
    if (spec.acceleration) {
      const speed = controlDraft.joy_controller[TuningModel.axes[kind].speed];
      const limit = TuningModel.wheelLimit(controlDraft, controlProfile.geometry, kind);
      input.disabled = controlsBusy || limit === null || !TuningModel.finite(speed) || speed === 0;
      input.required = controlDraft[node][key] !== 0 && !input.disabled && state?.time !== null;
      if (input !== activeInput) input.value = state?.time === null || !state ? "" : TuningModel.number(state.time);
      input.placeholder = state?.unlimited ? "制限なし（未変更）" : "算出できません";
      const raw = controlDraft[node][key];
      input.setCustomValidity(!TuningModel.finite(raw) || raw < field.min || raw > field.max
        ? "計算した加速度が保存できる範囲の外です。加速時間を長くするか、プリセットを選んでください。" : "");
      const shortest = TuningModel.minimumTime(state?.speed, field.max);
      row.querySelector(".control-range").textContent = shortest === null
        ? "入力できる最短時間は算出できません。加速度0は制限なしのまま保持します。"
        : `入力できる範囲：${shortest} s 以上（短すぎると保存できません）。加速度0は制限なしのまま保持し、正の時間を入力すると制限を有効にします。`;
      note.textContent = limit === null ? "車輪の寸法を確認できないため、加速時間から加速度を計算できず、この欄は編集できません。"
        : !state ? "速度・加速度を確認できないため、加速時間は算出できません。"
        : state.speed === 0 ? "速さが0のため時間は算出できません。加速度は保持します。"
          : state.unlimited ? "加速度の制限なし。正の加速時間を入力すると制限を有効にします。"
            : `保存する加速度: ${TuningModel.number(state.accel)} ${kind === "linear" ? "m/s²" : "rad/s²"}。`;
    } else if (spec.signed) {
      const raw = controlDraft[node][key];
      input.setCustomValidity(TuningModel.finite(raw) && raw >= field.min && raw <= field.max
        ? "" : TuningModel.finite(raw) ? TuningModel.speedWarning(key, raw, field.max)
          : "速さを入力してください。");
      const reference = Math.abs(controlProfile.defaults[node][key]);
      note.textContent = TuningModel.finite(raw)
        ? `${TuningModel.speedText(raw, kind)}${reference > 0 ? `・配布元の${TuningModel.number(Math.abs(raw) / reference * 100)}%` : "・配布元が0のため割合は算出できません"}。` : "速さを入力してください。";
      if (state?.limited) note.textContent += ` 設定は ${TuningModel.speedText(state.configured, kind)} ですが、車輪の上限で実際は約 ${TuningModel.speedText(state.speed, kind)} までです。`;
      if (state?.limited) note.textContent += ` ${TuningModel.limitedText(state, kind)}`;
      if (!state) note.textContent += " 車輪上限・加速時間は未確認です。";
      note.textContent += " 単独で倒したときの目安です。";
      if (kind === "linear") note.textContent += " 前進が速いときは、旋回が弱くなります。";
    }
    for (const button of row.querySelector(".control-presets")?.children || []) {
      const amount = button.tuningAmount;
      button.disabled = controlsBusy || amount === null || spec.baseline === 0
        || spec.acceleration && input.disabled;
      if (button.disabled && !controlsBusy) button.title = "速さ・車輪寸法・配布元の加速時間を確認できません。";
    }
    row.querySelector(".control-saved").children[1].textContent =
      tuningValue(spec, controlProfile.values[node][key], controlProfile.values);
    input.setAttribute("aria-invalid", String(Boolean(input.validationMessage)));
    row.classList.toggle("out-of-range", Boolean(input.validationMessage));
  }
}

function createTuningPreviews(container) {
  for (const [kind, title] of [["angular", "旋回の変化の目安"], ["linear", "走行の変化の目安"]]) {
    const section = document.createElement("section");
    section.className = "tuning-preview";
    const heading = document.createElement("h3");
    heading.textContent = title;
    heading.id = `tuning-${kind}-heading`;
    section.setAttribute("aria-labelledby", heading.id);
    const summary = document.createElement("p");
    summary.id = `tuning-${kind}-summary`;
    summary.className = "tuning-motion-summary";
    summary.tabIndex = 0;
    summary.setAttribute("aria-live", "polite");
    const note = document.createElement("p");
    note.className = "control-help";
    note.textContent = "単独で倒したときの目安です。前進と旋回を同時に入れたときの切り詰めは含みません。"
      + "標準起動の車輪寸法で一定加速度として計算し、最後の減速をなめらかにする帯を省いているため、時間と停止量は約の値です。実測値ではありません。";
    const chart = document.createElement("div");
    chart.id = `tuning-${kind}-chart`;
    section.append(heading, summary, chart, note);
    container.appendChild(section);
  }
}

function renderTuningPreviews() {
  for (const kind of ["angular", "linear"]) {
    const summary = document.getElementById(`tuning-${kind}-summary`);
    summary.textContent = TuningModel.summary(TuningModel.motion(controlDraft, controlProfile.geometry, kind), kind);
    TuningChart.render(document.getElementById(`tuning-${kind}-chart`),
      TuningModel.motion(controlDraft, controlProfile.geometry, kind),
      TuningModel.motion(controlProfile.defaults, controlProfile.geometry, kind), kind);
  }
}

function tiltDirectionKey() {
  return ["tilt_up_button_index", "tilt_down_button_index"]
    .find((key) => mapSelection?.actionId === `joy_launcher.${key}`);
}

function planMapAssignment(values) {
  const key = tiltDirectionKey();
  if (mapSelection.mode === "action" && key) {
    return ControllerMap.planTiltDirection(controlProfile.controller, values, key, mapSelection.inputId);
  }
  return ControllerMap.planAssignment(controlProfile.controller, values,
    mapSelection.spot, mapSelection.inputId, mapSelection.actionId);
}

function mapPopupPosition(anchor, width, height, viewportWidth, viewportHeight) {
  const gap = 12;
  const maxLeft = Math.max(gap, viewportWidth - width - gap);
  const maxTop = Math.max(gap, viewportHeight - height - gap);
  if (viewportWidth < 640) return { left: gap, top: maxTop };
  const rightSpace = viewportWidth - anchor.right;
  const leftSpace = anchor.left;
  const left = rightSpace >= width + gap || rightSpace >= leftSpace
    ? anchor.right + gap : anchor.left - width - gap;
  return { left: Math.max(gap, Math.min(left, maxLeft)),
    top: Math.max(gap, Math.min(anchor.top - 16, maxTop)) };
}

function positionMapEditor() {
  const panel = document.getElementById("controller-map-editor");
  if (!panel.open || !mapReturnTarget) return;
  const callout = window.innerWidth >= 640 && mapReturnTarget.startsWith('[data-action=')
    ? document.querySelector(mapReturnTarget.replace("data-action", "data-map-function")) : null;
  const source = callout || document.querySelector(mapReturnTarget);
  if (!source) return;
  const anchor = (source.querySelector(".map-callout-hit") || source).getBoundingClientRect();
  const bounds = panel.getBoundingClientRect();
  const position = mapPopupPosition(anchor, bounds.width || bounds.right - bounds.left,
    bounds.height || bounds.bottom - bounds.top, window.innerWidth, window.innerHeight);
  panel.style.left = `${position.left}px`;
  panel.style.top = `${position.top}px`;
}

function openMapEditor(selection, returnTarget) {
  if (controlsBusy) return;
  mapSelection = selection;
  mapReturnTarget = returnTarget;
  renderControllerMap();
  const panel = document.getElementById("controller-map-editor");
  if (!panel.open) panel.showModal();
  positionMapEditor();
  const saved = document.getElementById("controller-map-source").value === "saved";
  document.getElementById(selection.mode === "action" || saved ? "map-input" : "map-action")
    .focus({ preventScroll: true });
}

function finishMapEditor() {
  if (!mapSelection) return;
  mapSelection = null;
  renderControllerMap();
  const callout = window.innerWidth >= 640 && mapReturnTarget?.startsWith('[data-action=')
    ? document.querySelector(mapReturnTarget.replace("data-action", "data-map-function")) : null;
  (callout || document.querySelector(mapReturnTarget))?.focus({ preventScroll: true });
  mapReturnTarget = null;
}

function mapSelectOptions(select, options, selected) {
  select.replaceChildren();
  for (const item of options) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label;
    select.appendChild(option);
  }
  select.value = options.some((item) => item.id === selected) ? selected : options[0]?.id || "";
}

function renderMapEditor() {
  const panel = document.getElementById("controller-map-editor");
  if (!controlProfile || !mapSelection) {
    if (panel.open) panel.close();
    return;
  }
  const saved = document.getElementById("controller-map-source").value === "saved";
  const values = saved ? controlProfile.values : controlDraft;
  document.getElementById("map-tilt-opposite").hidden = true;
  const input = document.getElementById("map-input");
  const action = document.getElementById("map-action");
  const actionMode = mapSelection.mode === "action";
  document.getElementById("map-editor-title").textContent = `${mapSelection.title} の${actionMode ? "割り当て" : "機能"}`;
  const inputs = actionMode
    ? ControllerMap.destinations(controlProfile.controller, mapSelection.key)
    : ControllerMap.inputs(controlProfile.controller, mapSelection.spot);
  // Preserve custom input indices when opening a direction editor.
  if (actionMode && tiltDirectionKey()) {
    const current = ControllerMap.directionInput(controlProfile.controller, values, mapSelection.key);
    if (!inputs.some((item) => item.id === current.id)) inputs.push(current);
  }
  mapSelectOptions(input, inputs, mapSelection.inputId);
  mapSelection.inputId = input.value;
  const channel = inputs.find((item) => item.id === input.value);
  if (actionMode && channel) mapSelection.spot = channel.spot;
  const actions = channel ? ControllerMap.actions(values, channel.kind)
    .filter((item) => !actionMode || item.id === mapSelection.actionId) : [];
  const current = ControllerMap.bindings(controlProfile.controller, values, values)
    .filter((item) => channel && (item.inputId === channel.id || item.value === channel.value
      && item.kind !== "button" && channel.kind !== "button"
      && (item.kind === "axis" || channel.kind === "axis")));
  const currentAction = current[0] && `${current[0].node}.${current[0].key}`;
  mapSelectOptions(action, actions.map((item) => ({ id: item.id,
    label: ControllerMap.actionLabel(item.key, item.action) })),
    mapSelection.actionId || currentAction);
  mapSelection.actionId = action.value;
  const direction = tiltDirectionKey();
  document.getElementById("map-input-caption").textContent = actionMode && direction
    ? direction === "tilt_up_button_index" ? "上げる操作" : "下げる操作" : "使う入力";
  if (direction) {
    const other = direction === "tilt_up_button_index" ? "tilt_down_button_index" : "tilt_up_button_index";
    const opposite = document.getElementById("map-tilt-opposite");
    opposite.hidden = false;
    opposite.textContent = `${direction === "tilt_up_button_index" ? "下げる" : "上げる"}（現在）: `
      + ControllerMap.directionInput(controlProfile.controller, values, other).label;
  }
  document.getElementById("map-current").textContent = `${saved ? "保存済み" : "編集中"}の割り当て: `
    + (current.map((item) => item.action).join("、") || "なし");
  const apply = document.getElementById("map-apply");
  const edit = document.getElementById("map-edit-draft");
  input.disabled = controlsBusy || saved;
  action.disabled = controlsBusy || saved || actionMode || !actions.length;
  apply.disabled = controlsBusy || saved;
  edit.hidden = !saved;
  edit.disabled = controlsBusy;
  const preview = document.getElementById("map-preview");
  if (saved) {
    preview.textContent = "保存済みの設定を表示しています。「割り当てを編集する」で変更できます。";
    return;
  }
  try {
    const changes = planMapAssignment(values);
    const selected = actions.find((item) => item.id === action.value);
    const previous = ControllerMap.isTilt(selected.key)
      ? ControllerMap.directionInput(controlProfile.controller, values, selected.key).label
      : ControlLabels.valueLabel(controlProfile.controller, selected.key, values[selected.node][selected.key]);
    const shared = current.filter((item) => `${item.node}.${item.key}` !== action.value);
    preview.textContent = `${selected.action}: ${previous} → ${channel.label}。`
      + (shared.length ? `同じ入力の ${shared.map((item) => item.action).join("、")} も残り、同時に動作します。` : "")
      + "「この割り当てに変更」の後、「操作設定を保存」で確定します。";
    apply.disabled = controlsBusy || changes.every((item) => values[item.node][item.key] === item.value);
  } catch (error) {
    preview.textContent = error.message;
    apply.disabled = true;
  }
}

function applyMapAssignment() {
  if (controlsBusy || !controlProfile || !mapSelection
      || document.getElementById("controller-map-source").value === "saved") return;
  try {
    const changes = planMapAssignment(controlDraft);
    for (const { node, key, value } of changes) {
      controlDraft[node][key] = value;
    }
    refreshControlChanges();
    document.getElementById("map-feedback").textContent = "割り当てを変更しました。まだ保存はされていません。「操作設定を保存」で確定します。";
  } catch (error) {
    document.getElementById("map-feedback").textContent = error.message;
  }
}

function controlMessage(message) {
  document.getElementById("controls-message").textContent = message;
  document.getElementById("controls-message").hidden = !message;
  if (typeof renderSavebar === "function") renderSavebar();
  const loadError = document.getElementById("controls-load-error");
  loadError.hidden = Boolean(controlProfile);
  loadError.textContent = controlProfile ? "" : message;
}

function controllerName(controller) {
  return ControlLabels.controllers.includes(controller) ? ControlLabels.controllerName(controller) : "未確認";
}

function renderControlSummary() {
  const summary = document.getElementById("controls-summary");
  if (!controlProfile) {
    summary.textContent = "設定を読み込んでください。";
    return;
  }
  summary.textContent = `編集中: ${controllerName(controlProfile.controller)} ｜ `
    + `次回起動で使うコントローラー: ${controllerName(launchController)} ｜ 読み込み: ${controlsLoadedAt}`;
  const notes = {
    uart: "Switch のボタン名・スティック名で選択できます。番号は UART ドライバの配列に対応しています。",
    dualshock: "DualShock の標準配置の名前を表示しています。接続方式やドライバで番号が異なる場合は、"
      + "実際の Joy の番号に合わせて選んでください（接続機器の自動判別ではありません）。",
  };
  document.getElementById("controls-layout-note").textContent = notes[controlProfile.controller] || notes.dualshock;
}

function renderControllerMap() {
  document.getElementById("map-feedback").textContent = "";
  const wrapper = document.getElementById("controller-map-panel");
  wrapper.hidden = !controlProfile;
  renderSavebar();
  const host = document.getElementById("controller-map");
  if (!controlProfile) {
    host.replaceChildren();
    renderMapEditor();
    return;
  }
  const saved = document.getElementById("controller-map-source").value === "saved";
  document.getElementById("controller-map-caption").textContent = saved
    ? "保存済みの割り当てを表示しています。"
    : "編集中の割り当てを表示しています。保存後、次にロボット制御を起動するときに使われます。";
  ControllerMap.render(host, controlProfile.controller,
    saved ? controlProfile.values : controlDraft, controlProfile.values, (assignment, returnTarget) => {
      const actionId = `${assignment.node}.${assignment.key}`;
      openMapEditor({ mode: "action", spot: assignment.spot, key: assignment.key,
        title: ControllerMap.actionLabel(assignment.key, assignment.action), actionId,
        inputId: assignment.inputId },
      returnTarget || `[data-action="${actionId}"]`);
    }, { compact: window.innerWidth < 640, selectedSpot: mapSelection?.spot, onSelect: (spot, title) => {
      openMapEditor({ mode: "key", spot, title }, `[data-spot="${spot}"]`);
    } });
  renderMapEditor();
  positionMapEditor();
}

// The save bar floats over the page only while there is something to save (or a save is being
// reported), so it never covers the diagram for nothing.
function renderSavebar() {
  const message = document.getElementById("controls-message");
  document.getElementById("controls-savebar").hidden =
    !controlProfile || !(controlsDirty || controlsBusy || !message.hidden);
}

function refreshControlChanges(activeInput) {
  const count = ControlLabels.changedCount(controlProfile.values, controlDraft);
  controlsDirty = count > 0;
  refreshTuningFields(activeInput);
  refreshRangeWarning();
  renderTuningPreviews();
  renderControllerMap();
  for (const row of document.querySelectorAll(".control-field")) {
    const { node, key } = row.dataset;
    const changed = controlDraft[node][key] !== controlProfile.values[node][key];
    row.classList.toggle("changed", changed);
    row.querySelector(".control-change-state").textContent = changed
      ? tuningSpec(node, key).acceleration ? "加速度に変更あり" : "変更あり" : "";
    row.querySelector(".control-change-state").hidden = !changed;
    const saved = row.querySelector(".control-saved");
    saved.hidden = !changed;
    const input = document.getElementById(`control-${node}-${key}`);
    input.setAttribute("aria-describedby", `${input.id}-help ${input.id}-range ${input.id}-estimate${changed ? ` ${saved.id}` : ""}`);
  }
  document.getElementById("controls-change-count").textContent = `未保存の変更: ${count} 項目`;
  document.getElementById("controls-save").disabled = controlsBusy || !count;
  controlMessage("");
  renderControlApplication();
}

function renderControlApplication() {
  const state = OperatorGuide.application(controlProfile, controlDraft, controlRuntime, launchController);
  const box = document.getElementById('controls-application');
  box.dataset.state = state.kind;
  document.getElementById('controls-application-title').textContent = state.title;
  document.getElementById('controls-application-note').textContent = state.note;
  document.getElementById('controls-verify').disabled = controlsBusy || runtimeBusy || !controlProfile || !runtimeAvailable;
  document.getElementById('controls-undo').disabled = controlsBusy || !controlProfile?.previous_values;
}

function invalidateControlRuntime() {
  runtimeGeneration++;
  controlRuntime = null;
  if (typeof latestStatus !== 'undefined') launchController = latestStatus?.launch_config?.CONTROLLER_TYPE || null;
  renderRuntimeValues();
  renderControlApplication();
}

function restorePreviousControls() {
  if (controlsBusy || !controlProfile?.previous_values) return;
  if (!confirm('現在の編集内容を置き換えて、直前の保存より前の設定を読み込みますか？ この操作だけでは保存されません。')) return;
  controlDraft = structuredClone(controlProfile.previous_values);
  renderControls();
  controlMessage('ひとつ前の設定を編集画面に読み込みました。まだ保存はされていません。内容を確認して「操作設定を保存」で確定してください。');
}

function renderRuntimeValues() {
  for (const row of document.querySelectorAll(".control-field")) {
    const { node, key } = row.dataset;
    const value = row.querySelector(".control-runtime-value");
    const status = row.querySelector(".control-runtime-state");
    const report = controlRuntime?.nodes[node];
    row.querySelector(".control-runtime").hidden = !controlRuntime;
    row.classList.toggle("runtime-visible", Boolean(controlRuntime));
    if (!report) {
      value.textContent = "未取得";
      status.textContent = "";
    } else if (report.status !== "ok") {
      const labels = { unavailable: "対象のプログラムが見つかりません", timeout: "応答なし", error: "取得失敗" };
      value.textContent = labels[report.status] || "取得失敗";
      status.textContent = "";
    } else if (!Object.hasOwn(report.values, key)) {
      value.textContent = "この項目は確認できません";
      status.textContent = "";
    } else {
      const actual = report.values[key];
      const values = runtimeTuningValues();
      value.textContent = tuningValue(tuningSpec(node, key), actual, values, values.drive_component);
      status.textContent = actual === controlProfile.values[node][key]
        ? "保存済みと一致" : "保存済みと異なる";
      if (tuningSpec(node, key).acceleration) {
        status.textContent = actual === controlProfile.values[node][key]
          ? "加速度が保存済みと一致" : "加速度が保存済みと異なる";
      }
    }
  }
}

async function loadRuntimeValues() {
  if (runtimeBusy || controlsBusy || !controlProfile || !runtimeAvailable) return;
  runtimeBusy = true;
  const generation = runtimeGeneration;
  const controller = controlProfile.controller;
  const revision = controlProfile.revision;
  renderControlApplication();
  const button = document.getElementById("controls-runtime-load");
  const message = document.getElementById("controls-runtime-message");
  button.disabled = true;
  message.textContent = "ロボットが使っている設定を確認しています…";
  try {
    const snapshot = await api("/api/control-runtime");
    if (generation !== runtimeGeneration || controller !== controlProfile?.controller || revision !== controlProfile?.revision) {
      message.textContent = '取得中に状態が変わりました。もう一度確認してください。';
      return;
    }
    controlRuntime = snapshot;
    const captured = new Date(controlRuntime.captured_at).toLocaleTimeString("ja-JP");
    message.textContent = `取得時刻: ${captured}。実行中の設定と保存済みの設定を比較しています。`;
  } catch (error) {
    controlRuntime = null;
    message.textContent = error.message;
  } finally {
    runtimeBusy = false;
    button.disabled = controlsBusy || !controlProfile || !runtimeAvailable;
    renderRuntimeValues();
    renderControlApplication();
  }
}

function renderControls() {
  const container = document.getElementById("controls-fields");
  container.replaceChildren();
  createRangeWarning();
  tuningTimes = Object.fromEntries(["linear", "angular"].map((kind) =>
    [kind, TuningModel.motion(controlDraft, controlProfile.geometry, kind)?.time ?? null]));
  for (const group of controlProfile.groups) {
    const fields = group.fields.filter((field) => tuningSpec(group.node, field.key));
    if (!fields.length) continue;
    const section = document.createElement("fieldset");
    section.className = "control-section";
    const legend = document.createElement("legend");
    legend.textContent = group.node === "joy_controller" ? "走行"
      : group.node === "drive_component" ? "加速・減速の調整"
        : group.node === "joy_launcher" ? "射出ローラー" : "スティック";
    section.appendChild(legend);
    for (const field of fields) {
      const spec = tuningSpec(group.node, field.key);
      const row = document.createElement("div");
      row.className = "control-field";
      row.dataset.node = group.node;
      row.dataset.key = field.key;
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.id = `control-${group.node}-${field.key}`;
      input.dataset.node = group.node;
      input.dataset.key = field.key;
      label.htmlFor = input.id;
      label.textContent = `${spec.title}（${spec.unit}）`;
      const help = document.createElement("p");
      help.className = "control-field-help";
      help.id = `${input.id}-help`;
      help.textContent = spec.help;
      if (spec.signed) help.textContent += " 実際の速さは車体の上限や路面によって変わります。";
      help.hidden = true;
      const info = document.createElement("button");
      info.type = "button";
      info.className = "control-info";
      info.textContent = "ⓘ";
      info.setAttribute("aria-label", `${spec.title}の説明`);
      info.setAttribute("aria-controls", help.id);
      info.setAttribute("aria-expanded", "false");
      info.addEventListener("click", () => {
        help.hidden = !help.hidden;
        info.setAttribute("aria-expanded", String(!help.hidden));
      });
      const heading = document.createElement("div");
      heading.className = "control-field-heading";
      heading.append(label, info);
      const value = controlDraft[group.node][field.key];
      // Preserve any existing axis inversion when editing the speed magnitude.
      const direction = spec.signed ? tuningDirection(value, controlProfile.values[group.node][field.key]) : 1;
      input.type = "number";
      input.required = true;
      input.min = spec.signed || spec.acceleration ? 0 : field.min * spec.scale;
      if (!spec.acceleration) input.max = tuningNumber(spec, field.max);
      input.step = "any";
      input.value = spec.acceleration && value === 0 ? "" : tuningNumber(spec, value);
      if (spec.acceleration && value === 0) {
        // Preserve a legacy disabled limit until the user explicitly edits this field.
        input.required = false;
        input.placeholder = "制限なし（未変更）";
      }
      const saved = document.createElement("div");
      saved.className = "control-saved";
      saved.id = `${input.id}-saved`;
      const savedCaption = document.createElement("span");
      savedCaption.className = "control-value-caption";
      savedCaption.textContent = "保存済み";
      const savedValue = document.createElement("strong");
      savedValue.textContent = tuningValue(spec, controlProfile.values[group.node][field.key], controlProfile.values);
      saved.append(savedCaption, savedValue);
      input.setAttribute("aria-describedby", `${help.id} ${saved.id}`);
      const updateValue = (exactAmount) => {
        if (controlsBusy) return;
        input.required = true;
        const entered = typeof exactAmount === "number" ? exactAmount : Number(input.value);
        // Returning to a rounded display value restores its exact original ROS value.
        if (spec.acceleration) {
          const state = TuningModel.motion({ ...controlDraft, drive_component: {
            ...controlDraft.drive_component, [field.key]: 0 } }, controlProfile.geometry, spec.kind);
          const savedState = TuningModel.motion(controlProfile.values, controlProfile.geometry, spec.kind);
          const currentTime = tuningTimes[spec.kind];
          const exactTime = typeof exactAmount === "number" ? entered
            : currentTime !== null && entered === TuningModel.number(currentTime) ? currentTime
              : entered === TuningModel.number(savedState?.time) ? savedState?.time : entered;
          tuningTimes[spec.kind] = input.value === "" ? null : exactTime;
          const raw = input.value === "" ? null : TuningModel.acceleration(state?.speed, exactTime);
          controlDraft[group.node][field.key] = raw !== null && state?.speed === savedState?.speed
            && exactTime === savedState?.time ? controlProfile.values[group.node][field.key] : raw;
        } else {
          const raw = entered === tuningNumber(spec, value) ? value
            : entered === tuningNumber(spec, field.max) ? field.max * direction
              : entered / spec.scale * direction;
          controlDraft[group.node][field.key] = input.value === "" ? null : raw;
          if (spec.signed && TuningModel.finite(controlDraft[group.node][field.key])) {
            const kind = field.key === "angular_input_ratio" ? "angular" : "linear";
            const state = TuningModel.motion(controlDraft, controlProfile.geometry, kind);
            const savedState = TuningModel.motion(controlProfile.values, controlProfile.geometry, kind);
            if (state?.speed === 0) tuningTimes[kind] = null;
            else if (state && tuningTimes[kind] !== null) {
              controlDraft.drive_component[TuningModel.axes[kind].accel] = state.speed === savedState?.speed
                && tuningTimes[kind] === savedState?.time ? savedState.accel
                  : TuningModel.acceleration(state.speed, tuningTimes[kind]);
            } else if (state) tuningTimes[kind] = state.time;
          }
        }
        refreshControlChanges(input);
      };
      input.addEventListener("input", updateValue);
      const presets = document.createElement("div");
      presets.className = "control-presets";
      for (const [amount, title] of spec.presets || []) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-small";
        button.textContent = title;
        button.tuningAmount = amount;
        button.addEventListener("click", () => {
          if (controlsBusy || button.disabled) return;
          input.value = String(TuningModel.number(amount));
          updateValue(amount);
        });
        presets.appendChild(button);
      }
      const editor = document.createElement("div");
      editor.className = "control-editor";
      const caption = document.createElement("span");
      caption.className = "control-value-caption";
      caption.textContent = "設定値";
      const state = document.createElement("span");
      state.className = "control-change-state";
      editor.append(caption, input, state);
      const runtime = document.createElement("div");
      runtime.className = "control-runtime";
      const runtimeCaption = document.createElement("span");
      runtimeCaption.className = "control-value-caption";
      runtimeCaption.textContent = "実行中（取得時点）";
      const runtimeValue = document.createElement("strong");
      runtimeValue.className = "control-runtime-value";
      const runtimeState = document.createElement("span");
      runtimeState.className = "control-runtime-state";
      runtime.append(runtimeCaption, runtimeValue, runtimeState);
      row.append(heading, help);
      if (spec.presets) row.append(presets);
      row.append(editor, runtime, saved);
      const range = document.createElement("p");
      range.className = "control-range";
      range.id = `${input.id}-range`;
      range.textContent = spec.acceleration
        ? "入力できる最短時間を確認しています。"
        : spec.signed ? `入力できる範囲：0〜${Number(field.max).toFixed(1)} ${spec.unit}（方向の反転は保存済みのまま）。`
          : `入力できる範囲：${field.min * spec.scale}〜${field.max * spec.scale} ${spec.unit}。`;
      const estimate = document.createElement("p");
      estimate.className = "control-estimate";
      estimate.id = `${input.id}-estimate`;
      estimate.tabIndex = 0;
      row.append(range, estimate);
      section.appendChild(row);
    }
    container.appendChild(section);
  }
  createTuningPreviews(container);
  renderControlSummary();
  refreshControlChanges();
  renderRuntimeValues();
}

function controlsSetBusy(busy) {
  controlsBusy = busy;
  renderSavebar();
  renderControlApplication();
  renderMapEditor();
  document.getElementById("controls-runtime-load").disabled = busy || runtimeBusy || !controlProfile || !runtimeAvailable;
  document.getElementById("controls-profile").disabled = busy;
  document.getElementById("controls-reload").disabled = busy;
  document.getElementById("controls-save").disabled = busy || !controlProfile || !controlsDirty;
  document.getElementById("controls-reset").disabled = busy || !controlProfile;
  for (const input of document.querySelectorAll("#controls-fields input, #controls-fields select, #controls-fields button")) {
    input.disabled = busy;
  }
  if (controlProfile) refreshTuningFields();
  if (controlProfile) refreshRangeWarning();

}

async function loadControls(controller) {
  invalidateControlRuntime();
  controlsSetBusy(true);
  document.getElementById("controls-load-error").hidden = true;
  try {
    const profile = await api(`/api/control-config/${controller}`);
    if (!['tilt_up_axis', 'tilt_down_axis', 'tilt_up_axis_sign', 'tilt_down_axis_sign']
      .every((key) => Object.hasOwn(profile.values.joy_launcher || {}, key))) {
      throw new Error("射出角度を上下別に設定する機能がまだ使えません。担当者に管理画面のプログラムを更新・再起動してもらってください。");
    }
    controlProfile = profile;
    mapSelection = null;
    controlDraft = structuredClone(profile.values);
    controlsLoadedAt = new Date().toLocaleTimeString("ja-JP");
    controlRuntime = null;
    document.getElementById("controls-runtime-message").textContent = runtimeAvailable
      ? "ロボットが使っている設定は、まだ確認していません。"
      : "ロボットの設定を比較する機能がまだ使えません。担当者に管理画面のプログラムの更新・再起動を確認してもらってください。";
    controlsDirty = false;
    renderControls();
    const warnings = [profile.legacy_warning, profile.history_warning].filter(Boolean);
    if (warnings.length) controlMessage(warnings.join(" "));
  } catch (error) {
    controlProfile = null;
    controlDraft = null;
    renderControllerMap();
    controlRuntime = null;
    document.getElementById("controls-runtime-message").textContent = runtimeAvailable
      ? "ロボットが使っている設定は、まだ確認していません。"
      : "ロボットの設定を比較する機能がまだ使えません。担当者に管理画面のプログラムの更新・再起動を確認してもらってください。";
    controlsDirty = false;
    document.getElementById("controls-fields").replaceChildren();
    document.getElementById("controls-change-count").textContent = "";
    document.getElementById("controls-layout-note").textContent = "";
    renderControlSummary();
    controlMessage(error.message);
  } finally {
    controlsSetBusy(false);
  }
}

function confirmControlDiscard() {
  return !controlsDirty || confirm("保存していない変更を取り消しますか？");
}

async function saveControls(event) {
  event.preventDefault();
  if (controlsBusy || !controlProfile) return;
  const rangeIssue = tuningRangeIssues(controlDraft)[0];
  if (rangeIssue) {
    controlMessage(TuningModel.finite(rangeIssue.value)
      ? TuningModel.speedWarning(rangeIssue.key, rangeIssue.value, rangeIssue.max)
      : "速さを入力してください。");
    return;
  }
  // Check constraints without the browser scrolling to a field below the diagram.
  const invalidRow = [...document.querySelectorAll(".control-field")].find((row) => {
    const { node, key } = row.dataset;
    const field = controlProfile.groups.find((group) => group.node === node).fields.find((f) => f.key === key);
    const raw = controlDraft[node][key];
    return !TuningModel.finite(raw) || raw < field.min || raw > field.max
      || !document.getElementById(`control-${node}-${key}`).checkValidity();
  });
  const invalidInput = invalidRow
    && document.getElementById(`control-${invalidRow.dataset.node}-${invalidRow.dataset.key}`);
  if (invalidInput || !document.getElementById("controls-form").checkValidity()) {
    const invalid = invalidInput || document.getElementById("controls-fields").querySelector("input:invalid");
    const group = controlProfile.groups.find((item) => item.node === invalid?.dataset.node);
    const field = group?.fields.find((item) => item.key === invalid.dataset.key);
    const spec = tuningSpec(group?.node, field?.key);
    controlMessage(`${spec?.title || "入力値"}を確認してください。${invalid?.validationMessage || ""}`);
    return;
  }
  controlsSetBusy(true);
  controlMessage("操作設定を保存しています…");
  try {
    controlProfile = await api(`/api/control-config/${controlProfile.controller}`, {
      method: "PUT",
      body: JSON.stringify({ revision: controlProfile.revision, values: controlDraft }),
    });
    controlDraft = structuredClone(controlProfile.values);
    controlsLoadedAt = new Date().toLocaleTimeString("ja-JP");
    controlsDirty = false;
    renderControls();
    controlMessage("");
    // Offer the restart at the top of the page (with the usual safety confirmation) when the
    // robot runs; otherwise the next start uses the saved settings anyway.
    // Only when the robot uses this profile (a saved UART profile does nothing for a Web start).
    const offered = typeof offerApply === "function" && launchController === controlProfile.controller
      && offerApply("操作設定");
    toast(offered ? "操作設定を保存しました。画面上部の「今すぐ再起動して反映」で使い始めます"
      : "操作設定を保存しました（次にロボット制御を起動したときに使います）", "success");
  } catch (error) {
    controlMessage(error.message);
  } finally {
    controlsSetBusy(false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  let compactMap = window.innerWidth < 640;
  window.addEventListener("resize", () => {
    const compact = window.innerWidth < 640;
    if (compact !== compactMap) { compactMap = compact; renderControllerMap(); }
    positionMapEditor();
  });
  window.addEventListener("scroll", positionMapEditor, true);
  document.getElementById("controls-save").addEventListener("click", saveControls);
  document.getElementById('controls-verify').addEventListener('click', loadRuntimeValues);
  document.getElementById('controls-undo').addEventListener('click', restorePreviousControls);
  const mapDialog = document.getElementById("controller-map-editor");
  document.getElementById("map-close").addEventListener("click", () => mapDialog.close());
  mapDialog.addEventListener("close", finishMapEditor);
  mapDialog.addEventListener("click", (event) => {
    if (event.target !== mapDialog) return;
    const rect = mapDialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom) mapDialog.close();
  });
  document.getElementById("map-input").addEventListener("change", () => {
    if (!mapSelection) return;
    mapSelection.inputId = document.getElementById("map-input").value;
    if (mapSelection.mode !== "action") mapSelection.actionId = null;
    document.getElementById("map-feedback").textContent = "";
    renderMapEditor();
    positionMapEditor();
  });
  document.getElementById("map-action").addEventListener("change", () => {
    if (!mapSelection) return;
    mapSelection.actionId = document.getElementById("map-action").value;
    document.getElementById("map-feedback").textContent = "";
    renderMapEditor();
    positionMapEditor();
  });
  document.getElementById("map-apply").addEventListener("click", applyMapAssignment);
  document.getElementById("map-edit-draft").addEventListener("click", () => {
    document.getElementById("controller-map-source").value = "draft";
    renderControllerMap();
    document.getElementById(mapSelection?.mode === "action" ? "map-input" : "map-action")
      .focus({ preventScroll: true });
  });
  document.getElementById("controller-map-source").addEventListener("change", renderControllerMap);
  document.getElementById("controls-runtime-load").addEventListener("click", loadRuntimeValues);
  const select = document.getElementById("controls-profile");
  let lastController = select.value;
  select.addEventListener("change", () => {
    if (!confirmControlDiscard()) {
      select.value = lastController;
      return;
    }
    lastController = select.value;
    loadControls(select.value);
  });
  document.getElementById("controls-form").addEventListener("submit", saveControls);
  document.getElementById("controls-reload").addEventListener("click", () => {
    if (confirmControlDiscard()) loadControls(select.value);
  });
  document.getElementById("controls-reset").addEventListener("click", () => {
    if (controlsBusy || !controlProfile || !confirm("速度・操作感の表示項目を初期値に戻しますか？ 保存するまで適用されません。")) return;
    for (const group of controlProfile.groups) {
      for (const field of group.fields) {
        const spec = tuningSpec(group.node, field.key);
        if (!spec) continue;
        const value = controlProfile.defaults[group.node][field.key];
        const current = controlDraft[group.node][field.key];
        const direction = tuningDirection(current, controlProfile.values[group.node][field.key]);
        controlDraft[group.node][field.key] = spec.signed ? Math.abs(value) * direction : value;
      }
    }
    renderControls();
  });
  document.querySelector('[data-tab="tuning"]').addEventListener("click", async () => {
    if (controlsBusy) return;
    controlsSetBusy(true);
    try {
      const config = await apiSilent("/api/launch-config");
      launchController = config.CONTROLLER_TYPE || null;
      document.getElementById("controls-web-note").hidden = launchController !== "web";
      if (!controlsOpened && ControlLabels.editable.includes(launchController)) {
        select.value = launchController;
        lastController = select.value;
      }
    } catch {
      launchController = null;
    } finally {
      try {
        const schema = await apiSilent("/openapi.json");
        runtimeAvailable = Boolean(schema.paths?.["/api/control-runtime"]?.get);
      } catch {
        runtimeAvailable = false;
      }
      if (!runtimeAvailable) {
        document.getElementById("controls-runtime-message").textContent =
          "ロボットの設定を比較する機能がまだ使えません。担当者に管理画面のプログラムの更新・再起動を確認してもらってください。";
      } else if (!controlRuntime) {
        document.getElementById("controls-runtime-message").textContent = "ロボットが使っている設定は、まだ確認していません。";
      }
      controlsOpened = true;
      controlsSetBusy(false);
    }
    if (!controlProfile) await loadControls(select.value);
    else { renderControlSummary(); renderControlApplication(); }
  });
  window.addEventListener("beforeunload", (event) => {
    if (controlsDirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
});
