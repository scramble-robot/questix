/* Questix Robot Manager — Frontend Logic */

const API = "";
let pollTimer = null;
let configDirty = false;

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
  try {
    const res = await fetch(API + path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    return data;
  } catch (e) {
    toast(e.message, "error");
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

async function refreshStatus() {
  try {
    const data = await api("/api/status");
    updateMode(data.mode);
    updateServiceIndicator(data.service);
    updateLaunchConfig(data.launch_config);
  } catch {
    // already toasted
  }
}

function updateMode(mode) {
  const label = document.getElementById("mode-label");
  label.textContent = mode;
  label.className = `mode-badge ${mode}`;
  document.getElementById("mode-toggle").checked = mode === "competition";
}

function updateServiceIndicator(status) {
  const indicator = document.getElementById("service-indicator");
  const text = document.getElementById("service-status-text");
  text.textContent = status;
  indicator.className = "indicator " +
    (status === "active" ? "active" : status === "activating" ? "activating" : "inactive");
}

function updateLaunchConfig(config) {
  if (configDirty) return;
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
  btn.textContent = "回収中...";
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
    btn.textContent = "ログを回収";
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
    label.textContent = n.label;

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
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
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
  // Mirror recording state onto the 録画 tab so it is visible from any tab
  document.getElementById("tab-rec-dot").classList.toggle("recording", recording);
  document.getElementById("rec-state-text").textContent = recording ? "録画中" : "停止中";
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
    toast("ディスク空き容量不足のため録画を自動停止しました", "error");
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
    empty.textContent = "バッグはまだありません";
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
      toast(`録画を開始しました: ${data.bag_name}`, "success");
      await refreshRecStatus();
    } catch {
      // already toasted
    }
  });

  document.getElementById("rec-stop").addEventListener("click", async () => {
    try {
      await api("/api/rosbag/stop", { method: "POST" });
      toast("録画を停止しました", "success");
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
      toast("録画設定を保存しました", "success");
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
    if (!confirm(`バッグ「${name}」を削除しますか？`)) return;
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
  showLabDrive(data);
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

// "教材からの走行": what lab.env allows, and what the running bridge does. Allowed is shown in
// orange on the card and the tab, so nobody forgets to switch it back after a class.
function showLabDrive(data) {
  const allowed = data.drive_allowed;
  const applied = data.drive_running;
  const indicator = document.getElementById("lab-drive-indicator");
  indicator.className = "rec-indicator " + (allowed ? "driving" : "idle");
  document.getElementById("lab-drive-state").textContent = allowed
    ? applied === false
      ? "許可 (配信を開始し直すと反映されます)"
      : "許可中"
    : applied
      ? "禁止 (配信を開始し直すと反映されます)"
      : "禁止";
  document.getElementById("lab-drive-card").classList.toggle("allowed", allowed);
  document.getElementById("lab-drive-warning").hidden = !allowed;
  document.getElementById("tab-lab-dot").classList.toggle("driving", allowed);
  document.getElementById("lab-drive-allow").disabled = allowed;
  document.getElementById("lab-drive-forbid").disabled = !allowed;
}

async function setLabDrive(allow) {
  if (
    allow &&
    !confirm(
      "教材からロボットを動かせるようにします。\n" +
        "ロボットはコントローラーなし（enable_controller:=false）で起動しましたか？\n" +
        "周りに人や物がないことを確かめましたか？",
    )
  ) {
    return;
  }
  try {
    await api("/api/lab/drive", { method: "POST", body: JSON.stringify({ allow }) });
    toast(allow ? "教材からの走行を許可しました" : "教材からの走行を禁止しました", "success");
  } catch {
    // already toasted
  }
  await refreshLabStatus();
}

function setupLabEvents() {
  document.getElementById("lab-drive-allow").addEventListener("click", () => setLabDrive(true));
  document.getElementById("lab-drive-forbid").addEventListener("click", () => setLabDrive(false));
  document.getElementById("lab-start").addEventListener("click", async () => {
    try {
      await api("/api/lab/start", { method: "POST" });
      toast("教材の配信を開始しました", "success");
    } catch {
      // already toasted
    }
    await refreshLabStatus();
  });
  document.getElementById("lab-stop").addEventListener("click", async () => {
    try {
      await api("/api/lab/stop", { method: "POST" });
      toast("教材の配信を停止しました", "success");
    } catch {
      // already toasted
    }
    await refreshLabStatus();
  });
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
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".tab-panel");
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      tabs.forEach((t) => t.classList.toggle("active", t === tab));
      panels.forEach((p) => p.classList.toggle("active", p.dataset.panel === name));
    });
  }
}

function setupEvents() {
  setupTabs();

  // Mode toggle
  document.getElementById("mode-toggle").addEventListener("change", async (e) => {
    const newMode = e.target.checked ? "competition" : "practice";
    const label = newMode === "competition" ? "大会モード" : "練習モード";
    if (!confirm(`${label}に切り替えますか？`)) {
      e.target.checked = !e.target.checked;
      return;
    }
    try {
      await api("/api/mode", {
        method: "POST",
        body: JSON.stringify({ mode: newMode }),
      });
      toast(
        newMode === "competition"
          ? `モードを ${label} に変更しました（教材の配信・自動開始・走行の許可はオフにしました）`
          : `モードを ${label} に変更しました（教材の配信を開始します）`,
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

  // Service control buttons
  for (const btn of document.querySelectorAll("[data-action]")) {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.action;
      const labels = { start: "起動", stop: "停止", restart: "再起動" };
      // Disable all service buttons during operation
      const buttons = document.querySelectorAll("[data-action]");
      buttons.forEach((b) => (b.disabled = true));
      try {
        await api(`/api/service/${action}`, { method: "POST" });
        toast(`サービスを${labels[action]}しました`, "success");
        // Wait briefly then refresh
        setTimeout(refreshStatus, 1000);
      } finally {
        buttons.forEach((b) => (b.disabled = false));
      }
    });
  }

  // Mark config dirty when toggles or fields change
  for (const input of document.querySelectorAll("[data-config]")) {
    input.addEventListener("change", () => { configDirty = true; });
  }
  document.getElementById("ros-domain-id").addEventListener("input", () => { configDirty = true; });
  document.getElementById("robot-ws").addEventListener("input", () => { configDirty = true; });

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
      toast("設定を保存しました", "success");
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
