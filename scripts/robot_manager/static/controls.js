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
      document.getElementById(`control-${node}-${key}`).value = String(value);
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
      // Raw values avoid assuming that the running robot uses the edited controller profile.
      const actual = report.values[key];
      value.textContent = typeof actual === "boolean" ? (actual ? "ON" : "OFF") : String(actual);
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
    message.textContent = `ROS_DOMAIN_ID=${controlRuntime.domain_id} ｜ 取得時刻: ${captured}。`
      + "ボタン・軸は実際の番号を表示します。コントローラー種別は自動判別していません。";
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
    if (group.node === "joy_node" && controlProfile.controller !== "dualshock") continue;
    if (group.node === "uart_joy_driver" && controlProfile.controller !== "uart") continue;
    const section = document.createElement("fieldset");
    section.className = "control-section";
    const legend = document.createElement("legend");
    legend.textContent = group.label;
    section.appendChild(legend);
    for (const field of group.fields) {
      const row = document.createElement("div");
      row.className = "control-field";
      row.dataset.node = group.node;
      row.dataset.key = field.key;
      const label = document.createElement("label");
      const namedInput = ControlLabels.kind(field.key);
      const input = document.createElement(namedInput ? "select" : "input");
      input.id = `control-${group.node}-${field.key}`;
      input.dataset.node = group.node;
      input.dataset.key = field.key;
      input.dataset.kind = field.type;
      label.htmlFor = input.id;
      label.textContent = field.label.replaceAll("軸番号", "入力軸").replaceAll("ボタン番号", "ボタン");
      const value = controlDraft[group.node][field.key];
      if (namedInput) {
        for (const option of ControlLabels.options(controlProfile.controller, field)) {
          const element = document.createElement("option");
          element.value = option.value;
          element.textContent = option.label;
          input.appendChild(element);
        }
        input.value = value;
      } else if (field.type === "bool") {
        input.type = "checkbox";
        input.checked = value;
      } else {
        input.type = "number";
        input.required = true;
        input.min = field.min;
        input.max = field.max;
        input.step = field.type === "int" ? "1" : "any";
        input.value = value;
      }
      const saved = document.createElement("div");
      saved.className = "control-saved";
      saved.id = `${input.id}-saved`;
      const savedCaption = document.createElement("span");
      savedCaption.className = "control-value-caption";
      savedCaption.textContent = "保存済み";
      const savedValue = document.createElement("strong");
      savedValue.textContent = ControlLabels.valueLabel(controlProfile.controller, field.key,
        controlProfile.values[group.node][field.key]);
      saved.append(savedCaption, savedValue);
      input.setAttribute("aria-describedby", saved.id);
      input.addEventListener("input", () => {
        controlDraft[group.node][field.key] = field.type === "bool"
          ? input.checked : input.value === "" ? null : Number(input.value);
        refreshControlChanges();
      });
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
      row.append(label, saved, runtime, editor);
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
  for (const input of document.querySelectorAll("#controls-fields input, #controls-fields select")) {
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
      throw new Error("上下別のチルト設定 API が未反映です。robot_manager を更新・再起動してから読み直してください。");
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
    controlMessage(`${field?.label || "入力値"}を確認してください。${invalid?.validationMessage || ""}`);
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
    if (!controlProfile || !confirm("表示中の設定を初期値に戻しますか？ 保存するまで適用されません。")) return;
    controlDraft = structuredClone(controlProfile.defaults);
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
