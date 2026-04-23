#!/usr/bin/env bash
# Install Questix Robot autostart service and (optionally) Robot Manager Web UI.
# Usage:
#   sudo ./scripts/install-robot-manager.sh              # ROS2 autostart only
#   sudo ./scripts/install-robot-manager.sh --with-gui   # + Web管理GUI
#
# Environment variables (override defaults):
#   TARGET_USER   — service run-as user          (default: ubuntu)
#   ROBOT_WS      — ROS2 workspace path          (default: /home/$TARGET_USER/robot_ws)
#   ROS_DISTRO    — ROS2 distribution            (default: jazzy)
#   MANAGER_PORT  — Web UI port                  (default: 8888)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ---------- configuration ----------
TARGET_USER="${TARGET_USER:-ubuntu}"
ROBOT_WS="${ROBOT_WS:-/home/${TARGET_USER}/robot_ws}"
ROS_DISTRO="${ROS_DISTRO:-jazzy}"
MANAGER_PORT="${MANAGER_PORT:-8888}"
INSTALL_GUI=false

for arg in "$@"; do
  case "$arg" in
    --with-gui) INSTALL_GUI=true ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: this script must be run as root (sudo)." >&2
  exit 1
fi

echo "=== Questix Robot Installer ==="
echo "  User:       ${TARGET_USER}"
echo "  Workspace:  ${ROBOT_WS}"
echo "  ROS Distro: ${ROS_DISTRO}"
echo "  Install GUI: ${INSTALL_GUI}"
echo ""

# ---------- 1. Config directory & files ----------
echo "[1/6] Creating /etc/questix_robot/ ..."
install -d -o "${TARGET_USER}" -g "${TARGET_USER}" -m 0755 /etc/questix_robot

if [ ! -f /etc/questix_robot/mode ]; then
  echo "practice" > /etc/questix_robot/mode
  chown "${TARGET_USER}:${TARGET_USER}" /etc/questix_robot/mode
  echo "  -> mode = practice (default)"
else
  echo "  -> mode already exists, skipping"
fi

if [ ! -f /etc/questix_robot/launch.env ]; then
  sed \
    -e "s|^ROS_DISTRO=.*|ROS_DISTRO=${ROS_DISTRO}|" \
    -e "s|^ROBOT_WS=.*|ROBOT_WS=${ROBOT_WS}|" \
    "${REPO_DIR}/systemd/questix_robot.env" > /etc/questix_robot/launch.env
  chown "${TARGET_USER}:${TARGET_USER}" /etc/questix_robot/launch.env
  echo "  -> launch.env created"
else
  echo "  -> launch.env already exists, skipping"
fi

# ---------- 2. Launcher script ----------
echo "[2/6] Installing launcher script to /opt/questix_robot/ ..."
install -d -m 0755 /opt/questix_robot
install -m 0755 "${REPO_DIR}/systemd/questix_robot_launcher.sh" /opt/questix_robot/

# ---------- 3. systemd service (ROS2) ----------
echo "[3/6] Installing questix_robot.service ..."
sed \
  -e "s|^User=.*|User=${TARGET_USER}|" \
  -e "s|^Group=.*|Group=${TARGET_USER}|" \
  -e "s|Environment=ROS_DISTRO=.*|Environment=ROS_DISTRO=${ROS_DISTRO}|" \
  -e "s|Environment=ROBOT_WS=.*|Environment=ROBOT_WS=${ROBOT_WS}|" \
  "${REPO_DIR}/systemd/questix_robot.service" > /etc/systemd/system/questix_robot.service

systemctl daemon-reload
systemctl enable questix_robot
echo "  -> enabled (will start on next boot in 'competition' mode)"

# ---------- 4. polkit rules ----------
echo "[4/5] Installing polkit rules for passwordless service control ..."
# Deploy modern JavaScript rules (Ubuntu 24.04+, polkit ≥0.113)
install -d -m 0755 /etc/polkit-1/rules.d
sed -e "s|ubuntu|${TARGET_USER}|g" \
  "${REPO_DIR}/systemd/50-questix-robot.rules" \
  > /etc/polkit-1/rules.d/50-questix-robot.rules
chmod 0644 /etc/polkit-1/rules.d/50-questix-robot.rules
echo "  -> /etc/polkit-1/rules.d/50-questix-robot.rules deployed"

# Deploy legacy .pkla rules (Ubuntu 22.04, polkit <0.113)
if [ -d /etc/polkit-1/localauthority/50-local.d ]; then
  install -m 0644 \
    "${REPO_DIR}/systemd/50-questix-robot.pkla" \
    /etc/polkit-1/localauthority/50-local.d/50-questix-robot.pkla
  echo "  -> /etc/polkit-1/localauthority/50-local.d/50-questix-robot.pkla deployed"
fi

# ---------- 5. Robot Manager Web UI (optional) ----------
if [ "${INSTALL_GUI}" = true ]; then
  echo "[5/5] Installing Robot Manager Web UI ..."

  # Install dependencies
  apt-get install -y -qq python3-pip > /dev/null 2>&1 || true

  # Copy source and pip install (force non-editable to override any prior editable installs)
  cp -r "${REPO_DIR}/scripts/robot_manager" /opt/questix_robot/robot_manager
  cp "${REPO_DIR}/scripts/setup.py" /opt/questix_robot/setup.py
  pip3 uninstall robot-manager -y -q 2>/dev/null || true
  pip3 install /opt/questix_robot --break-system-packages -q

  # Install manager service
  sed \
    -e "s|^User=.*|User=${TARGET_USER}|" \
    -e "s|^Group=.*|Group=${TARGET_USER}|" \
    -e "s|--port [0-9]*|--port ${MANAGER_PORT}|" \
    "${REPO_DIR}/systemd/questix_robot_manager.service" > /etc/systemd/system/questix_robot_manager.service

  systemctl daemon-reload
  systemctl enable --now questix_robot_manager
  echo "  -> Web UI running at http://localhost:${MANAGER_PORT}"

  # Desktop shortcut
  DESKTOP_DIR="/home/${TARGET_USER}/Desktop"
  if [ -d "${DESKTOP_DIR}" ] || install -d -o "${TARGET_USER}" -g "${TARGET_USER}" -m 0755 "${DESKTOP_DIR}" 2>/dev/null; then
    install -o "${TARGET_USER}" -g "${TARGET_USER}" -m 0755 \
      "${REPO_DIR}/systemd/questix_robot_manager.desktop" "${DESKTOP_DIR}/"
    echo "  -> Desktop shortcut created"
  fi
else
  echo "[5/5] Skipping Robot Manager Web UI (use --with-gui to install)"
fi

# ---------- Done ----------
echo "Done!"
echo ""
echo "Next steps:"
echo "  - Set mode:  echo competition | sudo tee /etc/questix_robot/mode"
echo "  - Start now: sudo systemctl start questix_robot"
echo "  - Check:     sudo systemctl status questix_robot"
if [ "${INSTALL_GUI}" = true ]; then
  echo "  - Web UI:    http://localhost:${MANAGER_PORT}"
fi
