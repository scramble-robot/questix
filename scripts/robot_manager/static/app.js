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
      if (['uart', 'dualshock'].includes(controller)) {
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
    document.getElementById('ready-controller').textContent =
      { uart: 'UART / Switch', dualshock: 'DualShock' }[data.controller] || '未設定';
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
  setTimeout(() => el.remove(), 3000);
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
      { uart: 'UART / Switch', dualshock: 'DualShock' }[data.launch_config.CONTROLLER_TYPE] || '未設定';
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
  // Controller type toggle: checked = dualshock, unchecked = uart
  const ctrlToggle = document.getElementById("controller-type-toggle");
  if (ctrlToggle && config.CONTROLLER_TYPE !== undefined) {
    ctrlToggle.checked = config.CONTROLLER_TYPE === "dualshock";
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
      toast(`${label}を保存しました（次のロボット制御の起動・再起動で反映）`, "success");
      await refreshStatus();
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
        config.CONTROLLER_TYPE = input.checked ? "dualshock" : "uart";
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
});
