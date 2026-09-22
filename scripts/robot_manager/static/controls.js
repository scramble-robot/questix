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

function openMapEditor(selection, returnTarget) {
  if (controlsBusy) return;
  mapSelection = selection;
  mapReturnTarget = returnTarget;
  renderControllerMap();
  const panel = document.getElementById("controller-map-editor");
  if (!panel.open) panel.showModal();
  const saved = document.getElementById("controller-map-source").value === "saved";
  document.getElementById(selection.mode === "action" || saved ? "map-input" : "map-action")
    .focus({ preventScroll: true });
}

function finishMapEditor() {
  if (!mapSelection) return;
  mapSelection = null;
  renderControllerMap();
  document.querySelector(mapReturnTarget)?.focus({ preventScroll: true });
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
  const input = document.getElementById("map-input");
  const action = document.getElementById("map-action");
  const actionMode = mapSelection.mode === "action";
  document.getElementById("map-editor-title").textContent = `${mapSelection.title} の${actionMode ? "割り当て" : "機能"}`;
  const inputs = actionMode
    ? ControllerMap.destinations(controlProfile.controller, mapSelection.key)
    : ControllerMap.inputs(controlProfile.controller, mapSelection.spot);
  mapSelectOptions(input, inputs, mapSelection.inputId);
  mapSelection.inputId = input.value;
  const channel = inputs.find((item) => item.id === input.value);
  if (actionMode && channel) mapSelection.spot = channel.spot;
  const actions = channel ? ControllerMap.actions(values, channel.kind)
    .filter((item) => !actionMode || item.id === mapSelection.actionId) : [];
  const current = ControllerMap.bindings(controlProfile.controller, values, values)
    .filter((item) => channel && ControlLabels.kind(item.key) === channel.kind && item.value === channel.value);
  const currentAction = current[0] && `${current[0].node}.${current[0].key}`;
  mapSelectOptions(action, actions.map((item) => ({ id: item.id,
    label: ControllerMap.actionLabel(item.key, item.action) })),
    mapSelection.actionId || currentAction);
  mapSelection.actionId = action.value;
  document.getElementById("map-current").textContent = `${saved ? "保存済み" : "編集中"}の割り当て: `
    + (current.map((item) => item.action).join("、") || "なし");
  const apply = document.getElementById("map-apply");
  const edit = document.getElementById("map-edit-draft");
  input.disabled = controlsBusy;
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
    const changes = ControllerMap.planAssignment(controlProfile.controller, values,
      mapSelection.spot, input.value, action.value);
    const selected = actions.find((item) => item.id === action.value);
    const previous = ControlLabels.valueLabel(controlProfile.controller, selected.key, values[selected.node][selected.key]);
    const shared = current.filter((item) => `${item.node}.${item.key}` !== action.value);
    preview.textContent = `${selected.action}: ${previous} → ${channel.label}。`
      + (shared.length ? `同じ入力の ${shared.map((item) => item.action).join("、")} も残り、同時に動作します。` : "")
      + (changes.some((item) => item.key === "tilt_axis" && item.value === -1)
        ? "チルトは上下のボタン操作に切り替わります。"
        : selected.key === "tilt_axis" ? "チルトは軸操作に切り替わります。" : "")
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
    const changes = ControllerMap.planAssignment(controlProfile.controller, controlDraft,
      mapSelection.spot, mapSelection.inputId, mapSelection.actionId);
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
    saved ? controlProfile.values : controlDraft, controlProfile.values, (assignment) => {
      const actionId = `${assignment.node}.${assignment.key}`;
      openMapEditor({ mode: "action", spot: assignment.spot, key: assignment.key,
        title: ControllerMap.actionLabel(assignment.key, assignment.action), actionId,
        inputId: `${ControlLabels.kind(assignment.key)}:${assignment.value}` },
      `[data-action="${actionId}"]`);
    }, { selectedSpot: mapSelection?.spot, onSelect: (spot, title) => {
      openMapEditor({ mode: "key", spot, title }, `[data-spot="${spot}"]`);
    } });
  renderMapEditor();
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
  controlMessage(count ? `${count} 項目を変更しています。「操作設定を保存」で確定します。`
    : "保存済みの設定を表示しています。実行中の設定は「実行中の値を取得」で確認できます。");
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
  try {
    const profile = await api(`/api/control-config/${controller}`);
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
  controlsSetBusy(true);
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
  });
  document.getElementById("map-action").addEventListener("change", () => {
    if (!mapSelection) return;
    mapSelection.actionId = document.getElementById("map-action").value;
    document.getElementById("map-feedback").textContent = "";
    renderMapEditor();
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
