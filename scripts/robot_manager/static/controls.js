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

function refreshControlChanges() {
  const count = ControlLabels.changedCount(controlProfile.values, controlDraft);
  controlsDirty = count > 0;
  for (const row of document.querySelectorAll(".control-field")) {
    const { node, key } = row.dataset;
    const changed = controlDraft[node][key] !== controlProfile.values[node][key];
    row.classList.toggle("changed", changed);
    row.querySelector(".control-change-state").textContent = changed ? "変更あり" : "保存済みと同じ";
  }
  document.getElementById("controls-change-count").textContent = `未保存の変更: ${count} 項目`;
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
  document.getElementById("controls-runtime-load").disabled = busy || runtimeBusy || !controlProfile || !runtimeAvailable;
  document.getElementById("controls-profile").disabled = busy;
  document.getElementById("controls-reload").disabled = busy;
  document.getElementById("controls-save").disabled = busy || !controlProfile;
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
