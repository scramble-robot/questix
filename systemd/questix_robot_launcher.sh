#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="/etc/questix_robot"
MODE_FILE="${CONFIG_DIR}/mode"
ENV_FILE="${CONFIG_DIR}/launch.env"
LOG_TAG="questix_robot"

# Read mode
MODE="practice"
if [ -f "${MODE_FILE}" ]; then
  MODE=$(cat "${MODE_FILE}" | tr -d '[:space:]')
fi

if [ "${MODE}" != "competition" ]; then
  logger -t "${LOG_TAG}" "Mode is '${MODE}' (not 'competition'). Skipping ROS2 launch."
  echo "[questix_robot] Mode is '${MODE}'. ROS2 launch skipped."
  exit 0
fi

logger -t "${LOG_TAG}" "Mode is 'competition'. Starting ROS2 launch..."

# Source launch.env if present
if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

# Determine ROS2 distro and workspace (env vars or defaults)
ROS_DISTRO="${ROS_DISTRO:-jazzy}"
ROBOT_WS="${ROBOT_WS:-/home/ubuntu/robot_ws}"

# Source ROS2 environment (disable -u temporarily as setup.bash uses unset vars)
set +u
# shellcheck disable=SC1090
source "/opt/ros/${ROS_DISTRO}/setup.bash"
if [ -f "${ROBOT_WS}/install/setup.bash" ]; then
  # shellcheck disable=SC1090
  source "${ROBOT_WS}/install/setup.bash"
fi
set -u

# Build launch arguments
LAUNCH_ARGS=""
LAUNCH_ARGS="${LAUNCH_ARGS} enable_lidar:=${ENABLE_LIDAR:-true}"
LAUNCH_ARGS="${LAUNCH_ARGS} enable_shot:=${ENABLE_SHOT:-true}"
LAUNCH_ARGS="${LAUNCH_ARGS} enable_drive:=${ENABLE_DRIVE:-true}"
LAUNCH_ARGS="${LAUNCH_ARGS} enable_gpio_ref:=${ENABLE_GPIO_REF:-true}"
LAUNCH_ARGS="${LAUNCH_ARGS} enable_rviz:=${ENABLE_RVIZ:-false}"

logger -t "${LOG_TAG}" "ROS_DOMAIN_ID=${ROS_DOMAIN_ID:-42}, Launching with: ${LAUNCH_ARGS}"

# Export ROS_DOMAIN_ID (from launch.env or systemd Environment, default 42)
export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-42}"

# shellcheck disable=SC2086
exec ros2 launch questix_launcher questix_core.launch.xml ${LAUNCH_ARGS}
