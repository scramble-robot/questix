#!/usr/bin/env bash
# ExecStart of questix_robot.service: starts the QUESTiX robot's ROS 2 launch for the saved mode.
#
# competition: always launches (also at power-on) with the competition safety profile.
# practice:    launches only when someone pressed 起動 / 再起動 in Robot Manager just now. Robot
#              Manager writes a start request (${CONFIG_DIR}/start-request) right before
#              `systemctl start|restart`; this script consumes it (deletes it) and runs the practice
#              launch (enable_autoreferee:=false: questix_core then adds twist_arbiter and the lab
#              launcher input, so QUESTiX LAB can drive and fire). Without a fresh request (power-on,
#              `systemctl start` by hand, or Restart=on-failure after a crash) it logs and exits 0,
#              so practice mode never starts the robot by itself.
#
# Consequence of consuming the request: a practice launch that crashes is NOT restarted by
# Restart=on-failure (the restart finds no request and exits 0; the unit ends up inactive).
# Press 起動 again in Robot Manager. Competition launches keep Restart=on-failure as before.
#
# The start request is a small key=value file (never sourced):
#   mode=practice
#   requested_at=<seconds since the epoch>
#   boot_id=<the kernel's boot id when it was written>
# It counts only for the same boot, when it asks for the saved mode, and when it is at most
# START_REQUEST_MAX_AGE_SEC old (a request left behind by a crash or a reboot never starts the
# robot later). A request that is not used is deleted too.
#
# Each launch also records what was started in ${CONFIG_DIR}/last-launch (mode, time, boot id), so
# Robot Manager can show the running mode next to the mode saved for the next start.
set -euo pipefail

# QUESTIX_CONFIG_DIR and QUESTIX_BOOT_ID_FILE only exist for tests (Robot Manager reads the same
# QUESTIX_CONFIG_DIR); the service sets neither.
CONFIG_DIR="${QUESTIX_CONFIG_DIR:-/etc/questix_robot}"
MODE_FILE="${CONFIG_DIR}/mode"
ENV_FILE="${CONFIG_DIR}/launch.env"
START_REQUEST_FILE="${CONFIG_DIR}/start-request"
LAST_LAUNCH_FILE="${CONFIG_DIR}/last-launch"
START_REQUEST_MAX_AGE_SEC=120
BOOT_ID_FILE="${QUESTIX_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}"
LOG_TAG="questix_robot"

log() {
  logger -t "${LOG_TAG}" "$1" || true
  echo "[questix_robot] $1"
}

boot_id() {
  tr -d '[:space:]' < "${BOOT_ID_FILE}" 2> /dev/null || true
}

# Value of KEY in the start request (empty when missing).
request_value() {
  sed -n "s/^$1=//p" "${START_REQUEST_FILE}" 2> /dev/null | head -n 1 | tr -d '[:space:]'
}

# Delete the start request; fails (non-zero) when it cannot be deleted.
consume_start_request() {
  rm -f "${START_REQUEST_FILE}" 2> /dev/null && [ ! -e "${START_REQUEST_FILE}" ]
}

# Why the start request cannot start a practice launch now; empty when it can.
start_request_problem() {
  local requested_mode requested_at requested_boot now age
  if [ ! -f "${START_REQUEST_FILE}" ]; then
    echo "no start request from Robot Manager"
    return
  fi
  requested_mode="$(request_value mode)"
  requested_at="$(request_value requested_at)"
  requested_boot="$(request_value boot_id)"
  if [ "${requested_mode}" != "practice" ]; then
    echo "the start request asks for mode '${requested_mode}'"
    return
  fi
  if ! [[ "${requested_at}" =~ ^[0-9]+$ ]]; then
    echo "the start request has no valid time"
    return
  fi
  if [ -z "${requested_boot}" ] || [ "${requested_boot}" != "$(boot_id)" ]; then
    echo "the start request is from an earlier boot"
    return
  fi
  now="$(date +%s)"
  age=$((now - requested_at))
  # A few seconds into the future are tolerated (clock adjustments while starting).
  if [ "${age}" -gt "${START_REQUEST_MAX_AGE_SEC}" ] || [ "${age}" -lt -5 ]; then
    echo "the start request is ${age} s old (limit ${START_REQUEST_MAX_AGE_SEC} s)"
    return
  fi
}

record_launch() {
  local tmp="${LAST_LAUNCH_FILE}.tmp.$$"
  if printf 'mode=%s\nstarted_at=%s\nboot_id=%s\n' "$1" "$(date +%s)" "$(boot_id)" \
      > "${tmp}" 2> /dev/null && mv -f "${tmp}" "${LAST_LAUNCH_FILE}" 2> /dev/null; then
    return
  fi
  rm -f "${tmp}" 2> /dev/null || true
  log "Could not write ${LAST_LAUNCH_FILE}; Robot Manager will show the running mode as unknown."
}

# Read mode
MODE="practice"
if [ -f "${MODE_FILE}" ]; then
  MODE=$(tr -d '[:space:]' < "${MODE_FILE}")
fi

if [ "${MODE}" != "competition" ]; then
  if [ "${MODE}" != "practice" ]; then
    log "Mode is '${MODE}' (neither 'competition' nor 'practice'). Skipping ROS2 launch."
    consume_start_request || true
    exit 0
  fi
  PROBLEM="$(start_request_problem)"
  if [ -n "${PROBLEM}" ]; then
    if [ -e "${START_REQUEST_FILE}" ] && ! consume_start_request; then
      log "Could not delete ${START_REQUEST_FILE}."
    fi
    log "Mode is 'practice': ${PROBLEM}. Skipping ROS2 launch (practice starts only from Robot Manager's 起動 / 再起動)."
    exit 0
  fi
  # Consume the request before launching: a crash and Restart=on-failure must not relaunch.
  if ! consume_start_request; then
    log "Mode is 'practice' but ${START_REQUEST_FILE} cannot be deleted. Skipping ROS2 launch."
    exit 0
  fi
  log "Mode is 'practice' and Robot Manager asked to start. Starting the practice ROS2 launch..."
else
  # A practice start request never applies to a competition launch; drop a leftover one.
  consume_start_request || true
  log "Mode is 'competition'. Starting ROS2 launch..."
fi

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
# QUESTIX_ROS_SETUP only exists for tests, like QUESTIX_CONFIG_DIR.
ROS_SETUP="${QUESTIX_ROS_SETUP:-/opt/ros/${ROS_DISTRO}/setup.bash}"
set +u
# shellcheck disable=SC1090
source "${ROS_SETUP}"
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
if [ "${MODE}" = "competition" ]; then
  # Competition always requires both physical E-stop and AutoReferee GPIO safety inputs.
  # ENABLE_GPIO_REF from launch.env is intentionally ignored in this mode.
  LAUNCH_ARGS="${LAUNCH_ARGS} enable_gpio_ref:=true"
  LAUNCH_ARGS="${LAUNCH_ARGS} enable_autoreferee:=true"
else
  # Practice: the GPIO safety path follows launch.env (Robot Manager's 管理設定), on unless it
  # says exactly "false". Without AutoReferee, questix_core's practice defaults add twist_arbiter
  # (controller or QUESTiX LAB on /target_twist, the stick always wins) and let the ESC and shot
  # nodes accept the lab's launcher input.
  PRACTICE_GPIO_REF="true"
  if [ "${ENABLE_GPIO_REF:-true}" = "false" ]; then
    PRACTICE_GPIO_REF="false"
  fi
  LAUNCH_ARGS="${LAUNCH_ARGS} enable_gpio_ref:=${PRACTICE_GPIO_REF}"
  LAUNCH_ARGS="${LAUNCH_ARGS} enable_autoreferee:=false"
fi
LAUNCH_ARGS="${LAUNCH_ARGS} enable_rviz:=${ENABLE_RVIZ:-false}"
LAUNCH_ARGS="${LAUNCH_ARGS} controller_type:=${CONTROLLER_TYPE:-uart}"

log "ROS_DOMAIN_ID=${ROS_DOMAIN_ID:-42}, Launching (${MODE}) with: ${LAUNCH_ARGS}"

# Export ROS_DOMAIN_ID (from launch.env or systemd Environment, default 42)
export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-42}"

record_launch "${MODE}"

# shellcheck disable=SC2086
exec ros2 launch questix_launcher questix_core.launch.xml ${LAUNCH_ARGS}
