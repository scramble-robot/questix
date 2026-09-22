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
let mapSelection = null;
let mapReturnTarget = null;

// UI choices and units only. Defaults and validation limits come from the profile API.
const tuningFields = {
  joy_controller: {
    longitudinal_input_ratio: { title: "走行速度", unit: "m/s", scale: 1, signed: true,
      help: "スティックを最大まで倒したときの前進・後退の速さ。大きくすると速くなります。" },
    angular_input_ratio: { title: "旋回の速さ", signed: true },
  },
  drive_component: {
    max_linear_accel: { title: "走り出し・停止のきびきび感", acceleration: true,
      help: "小さくするとおだやかに、大きくするとすばやく加速・減速します。おだやかにすると、スティックを戻して止まるまでの時間も長くなります。" },
    max_angular_accel: { title: "旋回のきびきび感", acceleration: true,
      help: "曲がり始め・曲がり終わりの反応を調整します。小さくするとおだやかに、大きくするとすばやく旋回速度が変わります。旋回の最高速度は変わりません。" },
  },
  esc_motor_control: {
    full_speed_value: { title: "ローラー出力", unit: "%", scale: 100,
      help: "回転ボタンを押したときの出力。0% で停止、100% で最大出力です。" },
  },
  joy_node: { deadzone: { title: "スティックの遊び", unit: "%", scale: 100,
    help: "中心付近の小さな傾きを無視する幅。触っていないのに動くときは大きくします。" } },
  uart_joy_driver: { deadzone: { title: "スティックの遊び", unit: "%", scale: 100,
    help: "中心付近の小さな傾きを無視する幅。触っていないのに動くときは大きくします。" } },
};

function tuningSpec(node, key) {
  if (node === "joy_node" && controlProfile.controller !== "dualshock"
      || node === "uart_joy_driver" && controlProfile.controller !== "uart") return null;
  const spec = tuningFields[node]?.[key];
  if (node === "joy_controller" && key === "angular_input_ratio") {
    const reference = Math.abs(controlProfile.defaults[node][key]);
    if (reference > 0) return { ...spec, unit: "%", scale: 100 / reference,
      help: "100% が標準の速さです。50% で半分、150% で1.5倍。0% では旋回しません。",
      presets: [[50, "ゆっくり 50%"], [100, "標準 100%"], [150, "速め 150%"]] };
    // A custom profile can define a zero default; a relative percentage is then undefined.
    return { ...spec, unit: "回転/秒", scale: 1 / (2 * Math.PI),
      help: "1 で1秒に1回転、0.5 で2秒に1回転の指令です。0 では旋回しません。" };
  }
  if (spec?.acceleration) {
    const reference = controlProfile.defaults[node][key];
    if (reference > 0) return { ...spec, unit: "%", scale: 100 / reference,
      help: `100% が標準です。${spec.help}`,
      presets: [[50, "おだやか 50%"], [100, "標準 100%"], [150, "きびきび 150%"]] };
    // Zero disables the underlying limiter and cannot define a percentage baseline.
    return { ...spec, unit: key === "max_linear_accel" ? "m/s²" : "回転/秒²",
      scale: key === "max_linear_accel" ? 1 : 1 / (2 * Math.PI),
      help: `${spec.help} 初期設定は制限なしのため、加速度の数値を直接入力します。` };
  }
  return spec;
}

function tuningNumber(spec, value) {
  if (value === null) return "";
  const displayed = (spec.signed ? Math.abs(value) : value) * spec.scale;
  const rounded = Number(displayed.toFixed(2));
  return displayed !== 0 && rounded === 0 ? Number(displayed.toPrecision(3)) : rounded;
}

function tuningDirection(current, saved) {
  return current < 0 || (current === 0 || current === null) && saved < 0 ? -1 : 1;
}

function tuningValue(spec, value) {
  if (spec.acceleration && value === 0) return "制限なし";
  return `${tuningNumber(spec, value)} ${spec.unit}${spec.signed && value < 0 ? "（方向反転）" : ""}`;
}

function tiltDirectionKey() {
  return ["tilt_up_button_index", "tilt_down_button_index"]
    .find((key) => mapSelection?.actionId === `shot_component.${key}`);
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
    preview.textContent = "保存済みの設定を表示しています。「編集中に切り替える」で変更できます。";
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
      + "「編集値に反映」の後、「操作設定を保存」で確定します。";
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
    document.getElementById("map-feedback").textContent = "編集値に反映しました。操作設定を保存すると確定します。";
  } catch (error) {
    document.getElementById("map-feedback").textContent = error.message;
  }
}

function controlMessage(message) {
  document.getElementById("controls-message").textContent = message;
  document.getElementById("map-status").textContent = message;
  const loadError = document.getElementById("controls-load-error");
  loadError.hidden = Boolean(controlProfile);
  loadError.textContent = controlProfile ? "" : message;
}

function controllerName(controller) {
  return controller === "uart" ? "UART / Switch" : controller === "dualshock" ? "DualShock" : "未確認";
}

function renderControlSummary() {
  const summary = document.getElementById("controls-summary");
  if (!controlProfile) {
    summary.textContent = "設定を読み込んでください。";
    return;
  }
  summary.textContent = `編集中: ${controllerName(controlProfile.controller)} ｜ `
    + `Launch 設定: ${controllerName(launchController)} ｜ 読み込み: ${controlsLoadedAt}`;
  document.getElementById("controls-layout-note").textContent = controlProfile.controller === "uart"
    ? "Switch のボタン名・スティック名で選択できます。番号は UART ドライバの配列に対応しています。"
    : "DualShock の標準配置の名前を表示しています。接続方式やドライバで番号が異なる場合は、"
      + "実際の Joy の番号に合わせて選んでください（接続機器の自動判別ではありません）。";
}

function renderControllerMap() {
  document.getElementById("map-feedback").textContent = "";
  const wrapper = document.getElementById("controller-map-panel");
  wrapper.hidden = !controlProfile;
  const host = document.getElementById("controller-map");
  if (!controlProfile) {
    host.replaceChildren();
    renderMapEditor();
    return;
  }
  const saved = document.getElementById("controller-map-source").value === "saved";
  document.getElementById("controller-map-caption").textContent = saved
    ? "保存済みの割り当てを表示しています。"
    : "編集中の割り当てを表示しています。変更は保存するまで反映されません。";
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

function refreshControlChanges() {
  const count = ControlLabels.changedCount(controlProfile.values, controlDraft);
  controlsDirty = count > 0;
  renderControllerMap();
  for (const row of document.querySelectorAll(".control-field")) {
    const { node, key } = row.dataset;
    const changed = controlDraft[node][key] !== controlProfile.values[node][key];
    row.classList.toggle("changed", changed);
    row.querySelector(".control-change-state").textContent = changed ? "変更あり" : "保存済みと同じ";
  }
  document.getElementById("controls-change-count").textContent = `未保存の変更: ${count} 項目`;
  document.getElementById("map-change-count").textContent = `未保存: ${count} 項目`;
  document.getElementById("map-save").disabled = controlsBusy || !count;
  controlMessage(count ? `${count} 項目の変更を保存できます。` : "変更はありません。");
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
      const labels = { unavailable: "ノード未検出", timeout: "応答なし", error: "取得失敗" };
      value.textContent = labels[report.status] || "取得失敗";
      status.textContent = "";
    } else if (!Object.hasOwn(report.values, key)) {
      value.textContent = "パラメータ未宣言";
      status.textContent = "";
    } else {
      const actual = report.values[key];
      value.textContent = tuningValue(tuningSpec(node, key), actual);
      status.textContent = actual === controlProfile.values[node][key]
        ? "保存済みと一致" : "保存済みと異なる";
    }
  }
}

async function loadRuntimeValues() {
  if (runtimeBusy || controlsBusy || !controlProfile || !runtimeAvailable) return;
  runtimeBusy = true;
  const button = document.getElementById("controls-runtime-load");
  const message = document.getElementById("controls-runtime-message");
  button.disabled = true;
  message.textContent = "実行中の ROS パラメータを取得しています…";
  try {
    controlRuntime = await api("/api/control-runtime");
    const captured = new Date(controlRuntime.captured_at).toLocaleTimeString("ja-JP");
    message.textContent = `取得時刻: ${captured}。実行中の設定と保存済みの設定を比較しています。`;
  } catch (error) {
    controlRuntime = null;
    message.textContent = error.message;
  } finally {
    runtimeBusy = false;
    button.disabled = controlsBusy || !controlProfile || !runtimeAvailable;
    renderRuntimeValues();
  }
}

function renderControls() {
  const container = document.getElementById("controls-fields");
  container.replaceChildren();
  for (const group of controlProfile.groups) {
    const fields = group.fields.filter((field) => tuningSpec(group.node, field.key));
    if (!fields.length) continue;
    const section = document.createElement("fieldset");
    section.className = "control-section";
    const legend = document.createElement("legend");
    legend.textContent = group.node === "joy_controller" ? "走行"
      : group.node === "drive_component" ? "加速・減速の調整"
        : group.node === "esc_motor_control" ? "射出ローラー" : "スティック";
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
      const value = controlDraft[group.node][field.key];
      // Preserve any existing axis inversion when editing the speed magnitude.
      const direction = spec.signed ? tuningDirection(value, controlProfile.values[group.node][field.key]) : 1;
      input.type = "number";
      input.required = true;
      input.min = spec.signed ? 0 : field.min * spec.scale;
      input.max = tuningNumber(spec, field.max);
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
      savedValue.textContent = tuningValue(spec, controlProfile.values[group.node][field.key]);
      saved.append(savedCaption, savedValue);
      input.setAttribute("aria-describedby", `${help.id} ${saved.id}`);
      const updateValue = () => {
        if (controlsBusy) return;
        input.required = true;
        const entered = Number(input.value);
        // Returning to a rounded display value restores its exact original ROS value.
        const raw = entered === tuningNumber(spec, value) ? value
          : entered === tuningNumber(spec, field.max) ? field.max * direction
            : entered / spec.scale * direction;
        controlDraft[group.node][field.key] = input.value === "" ? null : raw;
        if (spec.acceleration) input.setCustomValidity(input.value !== "" && raw <= 0
          ? "0より大きい値を入力するか、プリセットを選んでください。" : "");
        refreshControlChanges();
      };
      input.addEventListener("input", updateValue);
      const presets = document.createElement("div");
      presets.className = "control-presets";
      for (const [amount, title] of spec.presets || []) {
        if (amount > input.max) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-small";
        button.textContent = title;
        button.addEventListener("click", () => {
          if (controlsBusy) return;
          input.value = String(amount);
          updateValue();
        });
        presets.appendChild(button);
      }
      const editor = document.createElement("div");
      editor.className = "control-editor";
      const caption = document.createElement("span");
      caption.className = "control-value-caption";
      caption.textContent = "変更後";
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
      row.append(label, help);
      if (spec.presets) row.append(presets);
      row.append(editor, saved, runtime);
      section.appendChild(row);
    }
    container.appendChild(section);
  }
  renderControlSummary();
  refreshControlChanges();
  renderRuntimeValues();
}

function controlsSetBusy(busy) {
  controlsBusy = busy;
  renderMapEditor();
  document.getElementById("controls-runtime-load").disabled = busy || runtimeBusy || !controlProfile || !runtimeAvailable;
  document.getElementById("controls-profile").disabled = busy;
  document.getElementById("controls-reload").disabled = busy;
  document.getElementById("controls-save").disabled = busy || !controlProfile;
  document.getElementById("map-save").disabled = busy || !controlProfile || !controlsDirty;
  document.getElementById("controls-reset").disabled = busy || !controlProfile;
  for (const input of document.querySelectorAll("#controls-fields input, #controls-fields select, #controls-fields button")) {
    input.disabled = busy;
  }

}

async function loadControls(controller) {
  controlsSetBusy(true);
  document.getElementById("controls-load-error").hidden = true;
  try {
    const profile = await api(`/api/control-config/${controller}`);
    if (!['tilt_up_axis', 'tilt_down_axis', 'tilt_up_axis_sign', 'tilt_down_axis_sign']
      .every((key) => Object.hasOwn(profile.values.shot_component || {}, key))) {
      throw new Error("射出角度を上下別に設定する API が未反映です。robot_manager を更新・再起動してから読み直してください。");
    }
    controlProfile = profile;
    mapSelection = null;
    controlDraft = structuredClone(profile.values);
    controlsLoadedAt = new Date().toLocaleTimeString("ja-JP");
    controlRuntime = null;
    document.getElementById("controls-runtime-message").textContent = runtimeAvailable
      ? "実行中の値は未取得です。"
      : "実行中の値の取得 API が未反映です。管理画面サービスを再起動してから、このタブを開き直してください。";
    controlsDirty = false;
    renderControls();
  } catch (error) {
    controlProfile = null;
    controlDraft = null;
    renderControllerMap();
    controlRuntime = null;
    document.getElementById("controls-runtime-message").textContent = runtimeAvailable
      ? "実行中の値は未取得です。"
      : "実行中の値の取得 API が未反映です。管理画面サービスを再起動してから、このタブを開き直してください。";
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
  return !controlsDirty || confirm("未保存の変更を破棄しますか？");
}

async function saveControls(event) {
  event.preventDefault();
  if (controlsBusy || !controlProfile) return;
  // Check constraints without the browser scrolling to a field below the diagram.
  if (!document.getElementById("controls-form").checkValidity()) {
    const invalid = document.getElementById("controls-fields").querySelector(":invalid");
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
    controlMessage("保存しました。ロボットを安全な状態にして、制御タブから再起動すると反映されます。");
    toast("操作設定を保存しました（再起動後に反映）", "success");
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
  document.getElementById("map-save").addEventListener("click", saveControls);
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
      if (!controlsOpened && ["uart", "dualshock"].includes(launchController)) {
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
          "実行中の値の取得 API が未反映です。管理画面サービスを再起動してから、このタブを開き直してください。";
      } else if (!controlRuntime) {
        document.getElementById("controls-runtime-message").textContent = "実行中の値は未取得です。";
      }
      controlsOpened = true;
      controlsSetBusy(false);
    }
    if (!controlProfile) await loadControls(select.value);
    else renderControlSummary();
  });
  window.addEventListener("beforeunload", (event) => {
    if (controlsDirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
});
