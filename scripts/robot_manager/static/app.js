/* QUESTiX Robot Manager — Frontend Logic */

const API = "";
let pollTimer = null;
let configDirty = false;
let latestStatus = null;
let serviceRequestCount = 0;
let issuePanel = 'control';

function showIssue(path, status, detail) {
  const issue = OperatorGuide.failure(path, status, detail);
  document.getElementById('issue-title').textContent = issue.title;
  document.getElementById('issue-next').textContent = issue.next;
  document.getElementById('issue-detail').textContent = issue.detail;
  document.getElementById('operation-issue').hidden = false;
  issuePanel = issue.panel;
  const names = { control: '操作', tuning: '調整', rec: '記録', log: '診断ログ', admin: '管理設定' };
  document.getElementById('issue-open-panel').textContent = `${names[issue.panel]}を開く`;
}

function activatePanel(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === name);
  });
  document.getElementById('open-admin').setAttribute('aria-pressed', String(name === 'admin'));
  if (name === 'admin') document.querySelector('.tab').tabIndex = 0;
}

async function refreshReadiness() {
  const button = document.getElementById('readiness-refresh');
  button.disabled = true;
  try {
    let data;
    try {
      data = await apiSilent('/api/readiness');
    } catch (error) {
      if (error.status !== 404) throw error;
      // Static assets can update before the long-running Python process reloads.
      // Existing read-only APIs still validate the saved controller profile.
      const config = await apiSilent('/api/launch-config');
      const controller = config.CONTROLLER_TYPE;
      let profile = { ok: false, message: 'コントローラー設定を担当者に確認してください。' };
      if (ControlLabels.controllers.includes(controller)) {
        try {
          await apiSilent(`/api/control-config/${controller}`);
          profile = { ok: true, message: '保存済みの操作設定を読み込みました' };
        } catch {
          profile = { ok: false, message: '操作設定を確認できません。「調整」で読み込み状態を確認してください。' };
        }
      }
      data = { controller, profile, workspace: {
        ok: false, message: '自動確認には管理画面のプログラムの更新・再起動が必要です。担当者に確認してください。' } };
    }
    document.getElementById('ready-controller').textContent = ControlLabels.controllerName(data.controller);
    for (const key of ['profile', 'workspace']) {
      const el = document.getElementById(`ready-${key}`);
      el.textContent = data[key].message;
      el.classList.toggle('check-warning', !data[key].ok);
    }
  } catch (error) {
    showIssue('/api/readiness', error.status || 0, error.message);
    for (const key of ['controller', 'profile', 'workspace']) {
      document.getElementById(`ready-${key}`).textContent = '取得できませんでした';
    }
  } finally {
    button.disabled = false;
  }
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  // Errors often say what to type on the robot (e.g. a chown command): give time to read them.
  // Keep in sync with the toast-out delays in style.css.
  setTimeout(() => el.remove(), type === "error" ? 10000 : 3000);
}

async function api(path, opts = {}) {
  let status = 0;
  try {
    const res = await fetch(API + path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    status = res.status;
    let data;
    try { data = await res.json(); }
    catch { throw new Error(`サーバーから読み取れない応答が届きました (HTTP ${status})`); }
    if (!res.ok) {
      const detail = Array.isArray(data.detail)
        ? data.detail.map((item) => item.msg).join("; ") : data.detail;
      throw new Error(detail || `HTTP ${status}`);
    }
    return data;
  } catch (error) {
    showIssue(path, status, error.message);
    toast('操作を完了できませんでした。画面上部の案内を確認してください。', 'error');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

async function refreshStatus() {
  if (typeof renderControlApplication === 'function') renderControlApplication();
  try {
    const data = await apiSilent("/api/status");
    const old = latestStatus;
    latestStatus = data;
    document.getElementById('connection-warning').hidden = true;
    if (typeof invalidateControlRuntime === 'function' && old &&
        (old.service !== data.service || JSON.stringify(old.launch_config) !== JSON.stringify(data.launch_config))) {
      invalidateControlRuntime();
    }
    if (typeof renderControlApplication === 'function') renderControlApplication();
    if (data.service === 'failed' && old?.service !== 'failed') {
      showIssue('/api/service/start', 500, 'ロボット制御の起動に失敗しました。診断ログで原因を担当者と確認してください。');
    }
    updateMode(data.mode);
    updateServiceIndicator(data.service);
    updateLaunchConfig(data.launch_config);
    document.getElementById('ready-controller').textContent =
      ControlLabels.controllerName(data.launch_config.CONTROLLER_TYPE);
  } catch {
    latestStatus = null;
    updateServiceIndicator('unknown');
    document.getElementById('connection-warning').hidden = false;
    if (typeof invalidateControlRuntime === 'function') invalidateControlRuntime();
  }
}

function updateMode(mode) {
  const label = document.getElementById("mode-label");
  const names = { practice: '練習', competition: '大会' };
  label.textContent = names[mode] || '未確認';
  document.getElementById('header-mode').textContent = `次回起動: ${names[mode] || '未確認'}`;
  label.className = `mode-badge ${mode}`;
  document.getElementById("mode-toggle").checked = mode === "competition";
  document.getElementById('mode-apply-note').textContent = mode === 'practice'
    ? '練習モードでは、この画面の起動ボタンからロボットを動かせません。動かす手順は担当者に確認してください。モードを変えるだけでは、実行中の動作は変わりません。'
    : '大会モードでは「起動」でロボット制御を開始します。保存したモードは、次にロボット制御を起動・再起動するときに使われます。';
}

function updateServiceIndicator(status) {
  const indicator = document.getElementById("service-indicator");
  const text = document.getElementById("service-status-text");
  const states = {
    active: ['実行中', '制御プログラムが動いています。コントローラーの接続・操作可否は未確認です。', 'active'],
    activating: ['起動処理中', 'ロボット制御を起動しています。表示が変わるまでお待ちください。', 'activating'],
    deactivating: ['停止処理中', 'ロボット制御を停止しています。表示が変わるまでお待ちください。', 'activating'],
    inactive: ['停止中', 'この画面から起動する制御プログラムは停止しています。', 'inactive'],
    failed: ['起動失敗', 'ロボット制御を起動できませんでした。診断ログを保存して担当者に確認してください。', 'failed'],
    unknown: ['状態未確認', '現在の状態を確認できません。ネットワークとロボットの電源を確認してください。', 'unknown'],
  };
  const [label, help, appearance] = states[status] || states.unknown;
  text.textContent = label;
  indicator.className = `indicator ${appearance}`;
  indicator.title = help;
  document.getElementById('robot-state-help').textContent = help;
}

function updateLaunchConfig(config) {
  if (configDirty) return;
  document.getElementById('launch-save-state').textContent = '保存済みの設定です。変更は次のロボット制御の起動・再起動で反映します。';
  const toggleKeys = ["ENABLE_LIDAR", "ENABLE_SHOT", "ENABLE_DRIVE", "ENABLE_GPIO_REF", "ENABLE_RVIZ"];
  for (const key of toggleKeys) {
    const input = document.querySelector(`[data-config="${key}"]`);
    if (input && config[key] !== undefined) {
      input.checked = config[key] === "true";
    }
  }
  // Controller type select: uart / dualshock / web
  const ctrlSelect = document.getElementById("controller-type");
  if (ctrlSelect && config.CONTROLLER_TYPE !== undefined) {
    ctrlSelect.value = config.CONTROLLER_TYPE;
  }
  if (config.ROS_DOMAIN_ID !== undefined) {
    document.getElementById("ros-domain-id").value = config.ROS_DOMAIN_ID;
  }
  if (config.ROBOT_WS !== undefined) {
    document.getElementById("robot-ws").value = config.ROBOT_WS;
  }
}

// ---------------------------------------------------------------------------
// Log collection
// ---------------------------------------------------------------------------

async function collectLogs() {
  const dest = document.getElementById("log-dest").value.trim();
  if (!dest) {
    toast("保存先フォルダを選択してください", "error");
    return;
  }
  const sources = [];
  for (const cb of document.querySelectorAll("[data-log-source]")) {
    if (cb.checked) sources.push(cb.dataset.logSource);
  }
  if (!sources.length) {
    toast("回収するログを1つ以上選択してください", "error");
    return;
  }

  const btn = document.getElementById("log-collect");
  btn.disabled = true;
  btn.textContent = "ログを保存中…";
  try {
    const data = await api("/api/logs/collect", {
      method: "POST",
      body: JSON.stringify({ dest_dir: dest, sources }),
    });
    toast(`ログを保存しました (${fmtBytes(data.size_bytes)})`, "success");
    renderLogResult(data);
  } catch {
    // already toasted
  } finally {
    btn.disabled = false;
    btn.textContent = "診断ログを保存";
  }
}

function renderLogResult(data) {
  const box = document.getElementById("log-result");
  while (box.firstChild) box.removeChild(box.firstChild);

  const head = document.createElement("div");
  head.className = "log-result-head";
  head.textContent = "保存しました";

  const path = document.createElement("div");
  path.className = "log-result-path";
  path.textContent = data.path;

  const size = document.createElement("div");
  size.className = "log-result-size";
  size.textContent = `サイズ: ${fmtBytes(data.size_bytes)}`;

  const notes = document.createElement("div");
  notes.className = "log-notes";
  for (const n of data.notes || []) {
    const row = document.createElement("div");
    row.className = "log-note";

    const label = document.createElement("span");
    label.className = "log-note-label";
    label.textContent = {
      service: "ロボット制御のログ",
      system: "本体全体のログ（今回の起動分）",
      syslog: "本体のログファイル（syslog）",
    }[n.source] || n.label;

    const note = document.createElement("span");
    note.className = "log-note-text";
    note.textContent = n.note;

    row.appendChild(label);
    row.appendChild(note);
    notes.appendChild(row);
  }

  box.appendChild(head);
  box.appendChild(path);
  box.appendChild(size);
  box.appendChild(notes);
  box.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// rosbag recorder
// ---------------------------------------------------------------------------

let lastStopReasonShown = null;

function fmtBytes(n) {
  if (!n || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = String(Math.floor(sec / 3600)).padStart(2, "0");
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

async function apiSilent(path) {
  const res = await fetch(API + path, { headers: { "Content-Type": "application/json" } });
  let data;
  try { data = await res.json(); }
  catch {
    const error = new Error(`読み取れない応答です (HTTP ${res.status})`);
    error.status = res.status;
    throw error;
  }
  if (!res.ok) {
    const error = new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

async function refreshRecStatus() {
  let data;
  try {
    data = await apiSilent("/api/rosbag/status");
  } catch {
    return; // recorder unavailable; leave UI as-is
  }
  const recording = data.recording;

  const indicator = document.getElementById("rec-indicator");
  indicator.className = "rec-indicator " + (recording ? "recording" : "idle");
  // Mirror recording state onto the 記録 tab so it is visible from any tab
  document.getElementById("tab-rec-dot").classList.toggle("recording", recording);
  document.getElementById("rec-state-text").textContent = recording ? "記録中" : "記録していません";
  document.getElementById("rec-bag-name").textContent = recording ? data.bag_name : "—";
  document.getElementById("rec-elapsed").textContent = recording ? fmtDuration(data.elapsed_sec) : "—";
  document.getElementById("rec-size").textContent = recording ? fmtBytes(data.size_bytes) : "—";

  // Disk gauge
  const free = data.disk_free_bytes || 0;
  const total = data.disk_total_bytes || 0;
  const minFree = data.min_free_bytes || 0;
  const low = minFree > 0 && free < minFree;
  document.getElementById("disk-text").textContent =
    total > 0 ? `${fmtBytes(free)} / ${fmtBytes(total)}` : "—";
  const usedPct = total > 0 ? Math.min(100, ((total - free) / total) * 100) : 0;
  const fill = document.getElementById("disk-bar-fill");
  fill.style.width = `${usedPct}%`;
  fill.classList.toggle("low", low);

  // Buttons
  document.getElementById("rec-start").disabled = recording || low;
  document.getElementById("rec-stop").disabled = !recording;

  // Notify once when an auto-stop happened
  if (!recording && data.last_stop_reason === "auto_stopped_low_disk" &&
      lastStopReasonShown !== "auto_stopped_low_disk") {
    toast("ディスク空き容量不足のため記録を自動停止しました", "error");
  }
  lastStopReasonShown = data.last_stop_reason;
}

async function refreshRecConfig() {
  try {
    const data = await api("/api/rosbag/config");
    for (const input of document.querySelectorAll("[data-rec-config]")) {
      const key = input.dataset.recConfig;
      if (data[key] !== undefined) input.value = data[key];
    }
  } catch {
    // already toasted
  }
}

async function refreshBagList() {
  let data;
  try {
    data = await apiSilent("/api/rosbag/list");
  } catch {
    return;
  }
  document.getElementById("disk-used-text").textContent = fmtBytes(data.total_used_bytes);
  const list = document.getElementById("rec-bag-list");
  while (list.firstChild) list.removeChild(list.firstChild);
  if (!data.bags.length) {
    const empty = document.createElement("li");
    empty.className = "rec-bag-empty";
    empty.textContent = "記録データはまだありません";
    list.appendChild(empty);
    return;
  }
  for (const bag of data.bags) {
    const li = document.createElement("li");
    li.className = "rec-bag-item" + (bag.recording ? " recording" : "");
    const date = bag.mtime ? new Date(bag.mtime * 1000).toLocaleString("ja-JP") : "";

    const main = document.createElement("div");
    main.className = "rec-bag-main";

    const name = document.createElement("span");
    name.className = "rec-bag-name";
    name.textContent = bag.name + (bag.recording ? " ●REC" : "");

    const meta = document.createElement("span");
    meta.className = "rec-bag-meta";
    meta.textContent = `${fmtBytes(bag.size_bytes)} · ${date}`;

    const path = document.createElement("span");
    path.className = "rec-bag-path";
    path.textContent = bag.path;

    main.appendChild(name);
    main.appendChild(meta);
    main.appendChild(path);

    const btn = document.createElement("button");
    btn.className = "btn btn-small btn-del";
    btn.dataset.bag = bag.name;
    btn.textContent = "削除";
    btn.disabled = Boolean(bag.recording);

    li.appendChild(main);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

// ---- Folder picker ----------------------------------------------------------

let folderCurrentPath = null;      // directory whose contents are listed
let folderCurrentWritable = false; // writability of that directory
let folderSelectedPath = null;     // path the 決定 button will apply
let folderPickMode = "rosbag";     // "rosbag" (OUTPUT_DIR) or "log" (log-dest)

function setSelectedFolder(path, writable) {
  folderSelectedPath = path;
  document.getElementById("folder-selected-path").textContent = path;
  document.getElementById("folder-selected-warn").classList.toggle("hidden", !!writable);
  document.getElementById("folder-pick").disabled = !writable;
  for (const item of document.querySelectorAll("#folder-list .folder-item")) {
    item.classList.toggle("selected", item.dataset.path === path);
  }
}

async function loadShortcuts() {
  let data;
  try {
    data = await apiSilent("/api/rosbag/locations");
  } catch {
    return; // shortcuts are best-effort
  }
  const icons = { home: "🏠", default: "★", current: "⚙", usb: "💾" };
  const box = document.getElementById("folder-shortcuts");
  box.innerHTML = "";
  for (const loc of data.locations) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.path = loc.path;
    chip.textContent = `${icons[loc.kind] || "📁"} ${loc.label}`;
    box.appendChild(chip);
  }
}

function renderBreadcrumb(path) {
  const bc = document.getElementById("folder-breadcrumb");
  bc.innerHTML = "";
  const segments = path.split("/").filter(Boolean);
  // Root
  const root = document.createElement("span");
  root.className = "crumb";
  root.dataset.path = "/";
  root.textContent = "/";
  bc.appendChild(root);
  let acc = "";
  segments.forEach((seg, i) => {
    acc += "/" + seg;
    const el = document.createElement("span");
    el.className = "crumb";
    el.dataset.path = acc;
    el.textContent = seg;
    bc.appendChild(el);
    if (i < segments.length - 1) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "/";
      bc.appendChild(sep);
    }
  });
}

async function browseFolder(path) {
  const q = path ? `?path=${encodeURIComponent(path)}` : "";
  let data;
  try {
    data = await api(`/api/rosbag/browse${q}`);
  } catch {
    return; // already toasted
  }
  folderCurrentPath = data.path;
  folderCurrentWritable = data.writable;
  renderBreadcrumb(data.path);

  const list = document.getElementById("folder-list");
  list.innerHTML = "";

  if (!data.dirs.length) {
    const empty = document.createElement("li");
    empty.className = "folder-empty";
    empty.textContent = "サブフォルダはありません";
    list.appendChild(empty);
  }
  for (const dir of data.dirs) {
    const li = document.createElement("li");
    li.className = "folder-item";
    li.dataset.path = dir.path;

    const name = document.createElement("span");
    name.className = "folder-item-name";
    name.textContent = `📁 ${dir.name}`;

    const open = document.createElement("button");
    open.type = "button";
    open.className = "btn btn-small folder-open-btn";
    open.dataset.path = dir.path;
    open.textContent = "開く ›";

    li.appendChild(name);
    li.appendChild(open);
    list.appendChild(li);
  }

  // Entering a folder resets the selection to the folder itself.
  setSelectedFolder(data.path, data.writable);
  return data;
}

async function selectFolderRow(path) {
  if (folderSelectedPath === path) {
    // Tapping the selected row again deselects it (back to the current folder).
    setSelectedFolder(folderCurrentPath, folderCurrentWritable);
    return;
  }
  // Select immediately, then verify writability in the background.
  setSelectedFolder(path, true);
  try {
    const data = await apiSilent(`/api/rosbag/browse?path=${encodeURIComponent(path)}`);
    if (folderSelectedPath === path) setSelectedFolder(path, data.writable);
  } catch {
    if (folderSelectedPath === path) {
      setSelectedFolder(folderCurrentPath, folderCurrentWritable);
    }
  }
}

function openFolderPicker(mode = "rosbag") {
  folderPickMode = mode;
  document.getElementById("folder-modal").classList.remove("hidden");
  loadShortcuts(); // refresh each open so USB plug/unplug is picked up
  const sourceId = mode === "log" ? "log-dest" : "rec-output";
  const current = document.getElementById(sourceId).value.trim();
  browseFolder(current);
}

function closeFolderPicker() {
  document.getElementById("folder-modal").classList.add("hidden");
  document.getElementById("folder-newname").value = "";
}

async function pickFolder() {
  if (!folderSelectedPath) return;
  if (folderPickMode === "log") {
    // The log destination is not persisted server-side; just fill the field.
    document.getElementById("log-dest").value = folderSelectedPath;
    toast(`保存先を設定しました: ${folderSelectedPath}`, "success");
    closeFolderPicker();
    return;
  }
  try {
    await api("/api/rosbag/config", {
      method: "PUT",
      body: JSON.stringify({ OUTPUT_DIR: folderSelectedPath }),
    });
    document.getElementById("rec-output").value = folderSelectedPath;
    toast(`出力フォルダを設定しました: ${folderSelectedPath}`, "success");
    closeFolderPicker();
    await refreshRecStatus();
    await refreshBagList();
  } catch {
    // already toasted (e.g. path contains characters not allowed for OUTPUT_DIR)
  }
}

async function createFolder() {
  const name = document.getElementById("folder-newname").value.trim();
  if (!name || !folderCurrentPath) return;
  try {
    const data = await api("/api/rosbag/mkdir", {
      method: "POST",
      body: JSON.stringify({ path: folderCurrentPath, name }),
    });
    document.getElementById("folder-newname").value = "";
    // Re-render the parent listing that mkdir returned, then pre-select the
    // new folder so it can be confirmed immediately.
    const listing = await browseFolder(data.path);
    const created = listing && listing.dirs.find((d) => d.name === name);
    if (created) await selectFolderRow(created.path);
    toast(`フォルダを作成しました: ${name}`, "success");
  } catch {
    // already toasted
  }
}

function setupFolderPickerEvents() {
  document.getElementById("rec-browse").addEventListener("click", () => openFolderPicker("rosbag"));
  document.getElementById("folder-close").addEventListener("click", closeFolderPicker);
  document.getElementById("folder-pick").addEventListener("click", pickFolder);
  document.getElementById("folder-mkdir").addEventListener("click", createFolder);
  document.getElementById("folder-newname").addEventListener("keydown", (e) => {
    if (e.key === "Enter") createFolder();
  });
  // Shortcut chips jump straight to a location
  document.getElementById("folder-shortcuts").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) browseFolder(chip.dataset.path);
  });
  // List: [開く ›] enters the folder, tapping the row selects it
  document.getElementById("folder-list").addEventListener("click", (e) => {
    const openBtn = e.target.closest(".folder-open-btn");
    if (openBtn) {
      browseFolder(openBtn.dataset.path);
      return;
    }
    const item = e.target.closest(".folder-item");
    if (item) selectFolderRow(item.dataset.path);
  });
  // Double-click also enters (desktop convenience)
  document.getElementById("folder-list").addEventListener("dblclick", (e) => {
    const item = e.target.closest(".folder-item");
    if (item) browseFolder(item.dataset.path);
  });
  // Breadcrumb jump to any ancestor
  document.getElementById("folder-breadcrumb").addEventListener("click", (e) => {
    const crumb = e.target.closest(".crumb");
    if (crumb) browseFolder(crumb.dataset.path);
  });
  // Click on the backdrop (outside the box) closes the modal
  document.getElementById("folder-modal").addEventListener("click", (e) => {
    if (e.target.id === "folder-modal") closeFolderPicker();
  });
}

function setupRecorderEvents() {
  setupFolderPickerEvents();
  document.getElementById("rec-start").addEventListener("click", async () => {
    try {
      const data = await api("/api/rosbag/start", { method: "POST" });
      toast(`記録を開始しました: ${data.bag_name}`, "success");
      await refreshRecStatus();
    } catch {
      // already toasted
    }
  });

  document.getElementById("rec-stop").addEventListener("click", async () => {
    try {
      await api("/api/rosbag/stop", { method: "POST" });
      toast("記録を停止しました", "success");
      await refreshRecStatus();
      await refreshBagList();
    } catch {
      // already toasted
    }
  });

  document.getElementById("rec-save-config").addEventListener("click", async () => {
    const config = {};
    for (const input of document.querySelectorAll("[data-rec-config]")) {
      config[input.dataset.recConfig] = input.value.trim();
    }
    try {
      await api("/api/rosbag/config", { method: "PUT", body: JSON.stringify(config) });
      toast("記録設定を保存しました", "success");
      await refreshRecStatus();
      await refreshBagList();
    } catch {
      // already toasted
    }
  });

  document.getElementById("rec-refresh-list").addEventListener("click", refreshBagList);

  // Delete via event delegation
  document.getElementById("rec-bag-list").addEventListener("click", async (e) => {
    const btn = e.target.closest(".btn-del");
    if (!btn || btn.disabled) return;
    const name = btn.dataset.bag;
    if (!confirm(`記録「${name}」を削除しますか？`)) return;
    try {
      await api("/api/rosbag/bag", { method: "DELETE", body: JSON.stringify({ bag_name: name }) });
      toast(`削除しました: ${name}`, "success");
      await refreshBagList();
      await refreshRecStatus();
    } catch {
      // already toasted
    }
  });
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// QUESTiX LAB tab: start/stop the read-only lab bridge (teaching pages on the LAN)
// ---------------------------------------------------------------------------

let labConfigLoaded = false;
// Inputs of the "スマートフォンで開く" QR codes; they are redrawn only when these change.
const joinQr = { accessPoint: null, labUrls: [], serving: false, drawn: "" };

async function refreshLabStatus() {
  let data;
  try {
    data = await apiSilent("/api/lab/status");
  } catch {
    return; // lab console unavailable; leave UI as-is
  }
  const serving = data.running || data.external;
  document.getElementById("lab-indicator").className =
    "rec-indicator " + (serving ? "serving" : "idle");
  document.getElementById("tab-lab-dot").classList.toggle("serving", serving);
  document.getElementById("lab-state-text").textContent = data.running
    ? "配信中"
    : data.external
      ? "配信中 (手動で起動)"
      : data.last_stop_reason === "autostart_failed"
        ? "停止中 (自動開始に失敗しました。ROS環境とビルドを確認してください)"
        : data.last_stop_reason === "competition_mode"
          ? "停止中 (大会モードに切り替えたため停止しました)"
          : data.last_stop_reason === "start_failed" || data.last_stop_reason === "exited"
            ? "停止中 (ブリッジが終了しました。「ブリッジのログ」を確認してください)"
            : "停止中";
  document.getElementById("lab-elapsed").textContent = data.running
    ? fmtDuration(data.elapsed_sec)
    : "—";

  const urls = document.getElementById("lab-urls");
  urls.replaceChildren();
  if (serving && data.urls.length) {
    for (const url of data.urls) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = url;
      urls.append(link);
    }
  } else {
    urls.textContent = serving ? "ネットワークに接続されていません" : "—";
  }

  joinQr.labUrls = data.urls;
  joinQr.serving = serving;
  renderJoinQr();

  document.getElementById("lab-start").disabled = serving;
  document.getElementById("lab-stop").disabled = !data.running;
  showLabLog(data, serving);
  showLabDrive(data);
  showLabShoot(data);
  showLabRecords(data.bridge);
  if (!labConfigLoaded) {
    document.getElementById("lab-camera").value = data.config.CAMERA_TOPIC || "";
    document.getElementById("lab-autostart").checked = data.config.AUTOSTART === "true";
    labConfigLoaded = true;
  }
}

async function refreshAccessPoint() {
  try {
    joinQr.accessPoint = await apiSilent("/api/wifi-ap");
  } catch {
    return;
  }
  renderJoinQr();
}

function labUrlForPhones() {
  const ap = joinQr.accessPoint;
  // On the robot's own access point the address is fixed (10.42.0.1), whatever else is listed.
  if (ap && ap.configured && ap.active && ap.lab_url) return ap.lab_url;
  return joinQr.labUrls[0] || "";
}

function renderJoinQr() {
  const ap = joinQr.accessPoint;
  const url = labUrlForPhones();
  const key = JSON.stringify([ap, url, joinQr.serving]);
  if (key === joinQr.drawn) return;
  joinQr.drawn = key;

  const wifiBox = document.getElementById("lab-wifi-qr");
  const wifiCaption = document.getElementById("lab-wifi-caption");
  wifiBox.replaceChildren();
  if (ap && ap.configured) {
    wifiBox.append(qrSvg(wifiQrText(ap.ssid, ap.password), `Wi-Fi ${ap.ssid} に接続するQRコード`));
    wifiCaption.textContent =
      `① Wi-Fi: ${ap.ssid} / パスワード: ${ap.password}` +
      (ap.active ? "" : "（アクセスポイントは現在オフ）");
  } else {
    wifiCaption.textContent =
      "① ロボットの Wi-Fi は未設定です（sudo scripts/wifi-ap.sh up）。同じネットワークの端末なら ② だけで開けます。";
  }

  const urlBox = document.getElementById("lab-url-qr");
  const urlCaption = document.getElementById("lab-url-caption");
  urlBox.replaceChildren();
  if (url) {
    urlBox.append(qrSvg(url, `${url} を開くQRコード`));
    urlCaption.textContent =
      `② 教材: ${url}` + (joinQr.serving ? "" : "（配信停止中です。「配信開始」を押してください）");
  } else {
    urlCaption.textContent = "② ネットワークに接続されていません";
  }
}

// The last lab error stays in its card until the next success (a toast is easy to miss).
function setLabError(id, message) {
  const el = document.getElementById(id);
  el.textContent = message || "";
  el.hidden = !message;
}

// "ブリッジのログ": the end of the bridge's output, while it is stopped or has failed.
function showLabLog(data, serving) {
  const details = document.getElementById("lab-log");
  const show = !serving && Boolean(data.log_tail);
  details.hidden = !show;
  if (!show) return;
  const text = document.getElementById("lab-log-text");
  if (text.textContent !== data.log_tail) text.textContent = data.log_tail;
  document.getElementById("lab-log-file").textContent = `全体: ${data.log_file}`;
  if (data.last_stop_reason === "start_failed" || data.last_stop_reason === "exited") {
    details.open = true;
  }
}

// "ロボットに保存された記録": what the running bridge keeps (its /api/state records), so the
// teacher sees how full the folder is and where to collect the pupils' records.
function showLabRecords(bridge) {
  const records = bridge && bridge.records;
  const value = document.getElementById("lab-records");
  const dir = document.getElementById("lab-records-dir");
  if (!records || !records.dir) {
    // records.dir null: the bridge runs with records_dir "" (keeps nothing).
    value.textContent = records ? "保存しない設定です" : "—";
    dir.hidden = true;
    return;
  }
  const limit = `${Math.round(records.limit_bytes / (1024 * 1024))} MB`;
  value.textContent =
    `${records.count}件・${fmtBytes(records.used_bytes)}（上限 ${limit}）` +
    (records.save ? "" : "・いっぱいか書き込めないため、教材から保存できません");
  value.classList.toggle("lab-records-full", !records.save);
  dir.textContent =
    `保存先フォルダ: ${records.dir}` +
    (records.auto_record ? "（コントローラーでの走行も自動で記録します）" : "") +
    (records.rosbag_dir ? `／録画（rosbag）: ${records.rosbag_dir}` : "");
  dir.hidden = false;
}

// Why pages cannot drive right now, from the bridge's drive_state.blockers, for the teacher.
function labBlockerText(blocker, bridge) {
  switch (blocker.code) {
    case "other_publisher":
      return `ほかのノード（${(blocker.nodes || []).join(", ") || "不明なノード"}）が教材用の指令（/target_twist/lab）を出しています。`;
    case "no_drive_node": {
      const domain = bridge.robot && bridge.robot.domain != null ? bridge.robot.domain : "未設定(0)";
      return (
        `切り替えノード twist_arbiter が見つかりません（ロボットのROSが questix_core で起動していないか、ROS_DOMAIN_ID ${domain} が違います）。` +
        "大会用の起動（enable_autoreferee:=true）では教材から走らせられません。"
      );
    }
    case "emergency_stop":
      return "非常停止が押されています";
    default:
      return null; // not_allowed is the state line itself
  }
}

// "教材からの走行": what the running bridge itself does (bridge = its GET /api/state), not only
// what lab.env asks for. Driving possible is shown in orange on the card and the tab.
function showLabDrive(data) {
  const bridge = data.bridge;
  const serving = data.running || data.external;
  const bridgeAllows = Boolean(bridge && bridge.read_only === false);
  const setting = data.drive_allowed;
  // Forbidden here, but the bridge still accepts driving (restart failed, or started by hand).
  const stale = !setting && bridgeAllows && !data.external;

  let state;
  let tone;
  if (!serving) {
    state = "配信が止まっています";
    tone = "idle";
  } else if (!bridge) {
    state = "ブリッジの状態が分かりません（起動中か、状態を返さない古いブリッジです）";
    tone = "idle";
  } else if (stale) {
    state =
      "止めました（配信中のブリッジはまだ走らせられます。『配信停止』→『配信開始』を押してください）";
    tone = "driving";
  } else if (bridgeAllows) {
    state = "走行できます（生徒が教材で安全確認をして走らせます）";
    tone = "driving";
  } else {
    state = "止めています（教材からは走らせられません）";
    tone = "idle";
  }
  document.getElementById("lab-drive-indicator").className =
    `rec-indicator ${tone} lab-drive-status`;
  document.getElementById("lab-drive-state").textContent = state;
  document.getElementById("lab-drive-external").hidden = !(data.external && bridge);

  const robot = bridge && bridge.robot;
  document.getElementById("lab-drive-robot").textContent = robot
    ? `${robot.name}（ROS_DOMAIN_ID ${robot.domain != null ? robot.domain : "未設定(0)"}）`
    : "—";
  document.getElementById("lab-drive-clients").textContent =
    bridge && bridge.clients != null ? `${bridge.clients} / ${bridge.max_clients}` : "—";
  const drive = (bridge && bridge.drive_state) || {};
  document.getElementById("lab-drive-owner-row").hidden = !drive.active;
  document.getElementById("lab-drive-owner").textContent = drive.active
    ? `生徒の端末 #${drive.owner}`
    : "—";

  // Readiness for the teacher: only meaningful while the bridge accepts driving at all.
  const ready = document.getElementById("lab-drive-ready");
  ready.replaceChildren();
  ready.hidden = !bridgeAllows;
  if (bridgeAllows) {
    const texts = (drive.blockers || []).map((b) => labBlockerText(b, bridge)).filter(Boolean);
    for (const text of texts) {
      const item = document.createElement("li");
      item.className = "blocked";
      item.textContent = text;
      ready.append(item);
    }
    if (!texts.length) {
      const item = document.createElement("li");
      item.className = "ready";
      item.textContent = "生徒の教材から走らせられます";
      ready.append(item);
    }
  }

  const drivable = bridgeAllows || setting;
  document.getElementById("lab-drive-card").classList.toggle("allowed", drivable);
  document.getElementById("tab-lab-dot").classList.toggle("driving", drivable);
  // A lab.env write that failed without failing the request (e.g. owned by another user).
  if (data.config_error) setLabError("lab-drive-error", data.config_error);

  document.getElementById("lab-drive-allow").disabled = setting;
  // Forbidding again also restarts a bridge of ours that still accepts driving.
  document.getElementById("lab-drive-forbid").disabled =
    !setting && !(bridgeAllows && data.running);
}

// Why pages cannot use the launcher right now, from the bridge's shoot_state.blockers.
function labShootBlockerText(blocker, bridge) {
  const parts = blocker.parts || [];
  const names = parts
    .map((p) => (p === "roller" ? "ローラー(esc_motor_control)" : p === "shot" ? "発射台(shot_component)" : null))
    .filter(Boolean)
    .join("・");
  switch (blocker.code) {
    case "no_launcher": {
      const domain = bridge.robot && bridge.robot.domain != null ? bridge.robot.domain : "未設定(0)";
      return (
        `${names || "発射装置"}が教材の指令を受け付けていません（ノードが動いていないか、練習用の起動ではないか、` +
        `ROS_DOMAIN_ID ${domain} が違います）。大会用の起動では教材から発射できません。`
      );
    }
    case "other_publisher":
      return `ほかのノード（${(blocker.nodes || []).join(", ") || "不明なノード"}）が教材用の発射指令（/roller/lab・/shot/lab/*）を出しています。`;
    case "emergency_stop":
      return "非常停止が押されています";
    case "controller":
      return "コントローラーで発射装置を操作中です（ボタンを離すと教材から使えます）";
    default:
      return null; // not_allowed is the state line itself
  }
}

// "教材からの発射": the same as driving, from the running bridge's shoot_state (an older bridge
// without it counts as "cannot").
function showLabShoot(data) {
  const bridge = data.bridge;
  const serving = data.running || data.external;
  const shoot = (bridge && bridge.shoot_state) || {};
  const bridgeAllows = shoot.allowed === true;
  const setting = data.shoot_allowed;
  const stale = !setting && bridgeAllows && !data.external;

  let state;
  let tone;
  if (!serving) {
    state = "配信が止まっています";
    tone = "idle";
  } else if (!bridge) {
    state = "ブリッジの状態が分かりません（起動中か、状態を返さない古いブリッジです）";
    tone = "idle";
  } else if (stale) {
    state =
      "止めました（配信中のブリッジはまだ発射できます。『配信停止』→『配信開始』を押してください）";
    tone = "driving";
  } else if (bridgeAllows) {
    state = "発射できます（生徒が教材で安全確認をして操作します）";
    tone = "driving";
  } else {
    state = "止めています（教材からは発射できません）";
    tone = "idle";
  }
  document.getElementById("lab-shoot-indicator").className =
    `rec-indicator ${tone} lab-drive-status`;
  document.getElementById("lab-shoot-state").textContent = state;

  document.getElementById("lab-shoot-owner-row").hidden = !shoot.active;
  document.getElementById("lab-shoot-owner").textContent = shoot.active
    ? `生徒の端末 #${shoot.owner}（ローラー ${Math.round((shoot.roller ? shoot.roller.power : 0) * 100)}%）`
    : "—";

  const ready = document.getElementById("lab-shoot-ready");
  ready.replaceChildren();
  ready.hidden = !bridgeAllows;
  if (bridgeAllows) {
    const texts = (shoot.blockers || []).map((b) => labShootBlockerText(b, bridge)).filter(Boolean);
    for (const text of texts) {
      const item = document.createElement("li");
      item.className = "blocked";
      item.textContent = text;
      ready.append(item);
    }
    if (!texts.length) {
      const item = document.createElement("li");
      item.className = "ready";
      item.textContent = "生徒の教材から発射装置を使えます";
      ready.append(item);
    }
  }

  const shootable = bridgeAllows || setting;
  document.getElementById("lab-shoot-card").classList.toggle("allowed", shootable);
  // showLabDrive ran first and set the dot for driving; either permission lights it.
  const dot = document.getElementById("tab-lab-dot");
  dot.classList.toggle("driving", dot.classList.contains("driving") || shootable);
  if (data.config_error) setLabError("lab-shoot-error", data.config_error);

  document.getElementById("lab-shoot-allow").disabled = setting;
  document.getElementById("lab-shoot-forbid").disabled =
    !setting && !(bridgeAllows && data.running);
}

async function setLabShoot(allow) {
  if (!confirm("配信中のブリッジを起動し直すため、生徒全員の接続が数秒切れます。よろしいですか？")) {
    return;
  }
  try {
    await api("/api/lab/shoot", { method: "POST", body: JSON.stringify({ allow }) });
    toast(allow ? "教材からの発射を再開しました" : "教材からの発射を止めました", "success");
    setLabError("lab-shoot-error", null);
  } catch (e) {
    setLabError("lab-shoot-error", e.message); // also toasted
  }
  await refreshLabStatus();
}

async function setLabDrive(allow) {
  if (!confirm("配信中のブリッジを起動し直すため、生徒全員の接続が数秒切れます。よろしいですか？")) {
    return;
  }
  try {
    await api("/api/lab/drive", { method: "POST", body: JSON.stringify({ allow }) });
    toast(allow ? "教材からの走行を再開しました" : "教材からの走行を止めました", "success");
    setLabError("lab-drive-error", null);
  } catch (e) {
    setLabError("lab-drive-error", e.message); // also toasted
  }
  await refreshLabStatus();
}

// Start/stop of the bridge: success toasts, failure stays in the card too.
async function labServeAction(path, done) {
  try {
    await api(path, { method: "POST" });
    toast(done, "success");
    setLabError("lab-serve-error", null);
  } catch (e) {
    setLabError("lab-serve-error", e.message); // also toasted
  }
  await refreshLabStatus();
}

function setupLabEvents() {
  document.getElementById("lab-drive-allow").addEventListener("click", () => setLabDrive(true));
  document.getElementById("lab-drive-forbid").addEventListener("click", () => setLabDrive(false));
  document.getElementById("lab-shoot-allow").addEventListener("click", () => setLabShoot(true));
  document.getElementById("lab-shoot-forbid").addEventListener("click", () => setLabShoot(false));
  document
    .getElementById("lab-start")
    .addEventListener("click", () => labServeAction("/api/lab/start", "教材の配信を開始しました"));
  document
    .getElementById("lab-stop")
    .addEventListener("click", () => labServeAction("/api/lab/stop", "教材の配信を停止しました"));
  document.getElementById("lab-save-config").addEventListener("click", async () => {
    try {
      await api("/api/lab/config", {
        method: "PUT",
        body: JSON.stringify({
          CAMERA_TOPIC: document.getElementById("lab-camera").value,
          AUTOSTART: document.getElementById("lab-autostart").checked,
        }),
      });
      toast("教材の設定を保存しました (次の配信開始から有効)", "success");
    } catch {
      // already toasted
    }
  });
}

function setupTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => activatePanel(tab.dataset.tab));
    tab.addEventListener('keydown', (event) => {
      const positions = { ArrowRight: (index + 1) % tabs.length,
        ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 };
      if (!Object.hasOwn(positions, event.key)) return;
      event.preventDefault();
      const next = tabs[positions[event.key]];
      next.focus();
      next.click();
    });
  }
  document.getElementById('open-admin').addEventListener('click', () => activatePanel('admin'));
  document.getElementById('issue-open-panel').addEventListener('click', () => {
    const tab = document.querySelector(`.tab[data-tab="${issuePanel}"]`);
    if (tab) tab.click(); else activatePanel(issuePanel);
  });
  document.getElementById('issue-dismiss').addEventListener('click', () => {
    document.getElementById('operation-issue').hidden = true;
  });
  document.getElementById('readiness-refresh').addEventListener('click', refreshReadiness);
  activatePanel('control');
}

async function serviceAction(action) {
  // Stopping remains available while a start/restart request is pending.
  if (action !== 'stop' && serviceRequestCount) return;
  if (action === 'restart' && !confirm('ロボット制御を再起動しますか？ 動作をいったん止め、保存した設定で起動し直します。ロボットを安全な状態にしてから実行してください。')) return;
  serviceRequestCount++;
  const updateButtons = () => document.querySelectorAll('[data-service-action]').forEach((button) => {
    button.disabled = button.dataset.serviceAction !== 'stop' && serviceRequestCount > 0;
  });
  updateButtons();
  if (typeof invalidateControlRuntime === 'function') invalidateControlRuntime();
  try {
    await api(`/api/service/${action}`, { method: 'POST' });
    const labels = { start: 'ロボット制御の起動', stop: 'ロボット制御の停止', restart: 'ロボット制御の再起動' };
    toast(`${labels[action]}の処理が完了しました。状態表示を確認してください。`, 'success');
  } catch {
    // Persistent guidance is rendered by api(); avoid an unhandled rejection.
  } finally {
    serviceRequestCount--;
    updateButtons();
    await refreshStatus();
  }
}

function setupEvents() {
  setupTabs();

  // Mode toggle
  document.getElementById("mode-toggle").addEventListener("change", async (e) => {
    const newMode = e.target.checked ? "competition" : "practice";
    const label = newMode === "competition" ? "大会モード" : "練習モード";
    if (!confirm(`${label}を次回起動用に保存しますか？ 実行中のモードは変わりません。`)) {
      e.target.checked = !e.target.checked;
      return;
    }
    try {
      await api("/api/mode", {
        method: "POST",
        body: JSON.stringify({ mode: newMode }),
      });
      // The robot keeps its running mode until its next start; QUESTiX LAB follows the saved
      // mode at once (lab.py: competition stops the lessons and forbids driving and launching).
      toast(
        newMode === "competition"
          ? `${label}を保存しました（ロボット制御は次の起動・再起動で反映。教材の配信・自動開始・走行と発射の許可はすぐにオフにしました）`
          : `${label}を保存しました（ロボット制御は次の起動・再起動で反映。教材の配信はすぐに開始します）`,
        "success",
      );
      await refreshStatus();
      // The server turned AUTOSTART off (competition) or on (practice); show it in the checkbox.
      labConfigLoaded = false;
      await refreshLabStatus();
    } catch {
      e.target.checked = !e.target.checked;
    }
  });

  // Separate service actions from controller-map assignment buttons.
  for (const button of document.querySelectorAll('[data-service-action]')) {
    button.addEventListener('click', () => serviceAction(button.dataset.serviceAction));
  }

  // Mark config dirty without polling away the student's edits.
  const markConfigDirty = () => {
    configDirty = true;
    document.getElementById('launch-save-state').textContent = '未保存の変更があります。';
  };
  for (const input of document.querySelectorAll('[data-config]')) {
    input.addEventListener('change', markConfigDirty);
  }
  document.getElementById('ros-domain-id').addEventListener('input', markConfigDirty);
  document.getElementById('robot-ws').addEventListener('input', markConfigDirty);

  // Save launch config
  document.getElementById("save-config").addEventListener("click", async () => {
    const config = {};
    for (const input of document.querySelectorAll("[data-config]")) {
      if (input.dataset.config === "CONTROLLER_TYPE") {
        config.CONTROLLER_TYPE = input.value;
      } else {
        config[input.dataset.config] = input.checked ? "true" : "false";
      }
    }
    config.ROS_DOMAIN_ID = document.getElementById("ros-domain-id").value;
    config.ROBOT_WS = document.getElementById("robot-ws").value;
    try {
      await api("/api/launch-config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      configDirty = false;
      document.getElementById('launch-save-state').textContent = '保存しました。次のロボット制御の起動・再起動で反映されます。';
      toast("設定を保存しました（次のロボット制御の起動・再起動で反映）", "success");
      await refreshStatus();
      await refreshReadiness();
    } catch {
      // already toasted
    }
  });

  // Log collection
  document.getElementById("log-collect").addEventListener("click", collectLogs);
  document.getElementById("log-browse").addEventListener("click", () => openFolderPicker("log"));

  setupRecorderEvents();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  setupEvents();
  refreshStatus();
  refreshReadiness();
  refreshRecConfig();
  refreshRecStatus();
  refreshBagList();
  // Poll service status every 5 seconds
  pollTimer = setInterval(() => {
    refreshStatus();
  }, 5000);
  // Poll recorder status more frequently for a live elapsed/size readout
  setInterval(refreshRecStatus, 2000);
  setupLabEvents();
  refreshLabStatus();
  setInterval(refreshLabStatus, 3000);
  refreshAccessPoint();
  setInterval(refreshAccessPoint, 5000);
});
