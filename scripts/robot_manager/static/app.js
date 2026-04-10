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
  if (config.ROS_DOMAIN_ID !== undefined) {
    document.getElementById("ros-domain-id").value = config.ROS_DOMAIN_ID;
  }
  if (config.ROBOT_WS !== undefined) {
    document.getElementById("robot-ws").value = config.ROBOT_WS;
  }
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

async function refreshLogs() {
  try {
    const data = await api("/api/logs?n=50");
    document.getElementById("log-output").textContent = data.logs || "(ログなし)";
    const viewer = document.getElementById("log-output");
    viewer.scrollTop = viewer.scrollHeight;
  } catch {
    // already toasted
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function setupEvents() {
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
      toast(`モードを ${label} に変更しました`, "success");
      await refreshStatus();
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
      config[input.dataset.config] = input.checked ? "true" : "false";
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

  // Refresh logs button
  document.getElementById("refresh-logs").addEventListener("click", refreshLogs);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  setupEvents();
  refreshStatus();
  refreshLogs();
  // Poll every 5 seconds
  pollTimer = setInterval(() => {
    refreshStatus();
    refreshLogs();
  }, 5000);
});
