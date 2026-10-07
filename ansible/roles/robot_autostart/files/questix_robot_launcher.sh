#!/usr/bin/env bash
# ExecStart of questix_robot.service: starts the QUESTiX robot's ROS 2 launch for the saved mode.
#
# Three modes (scripts/robot_manager/modes.py repeats them; test_launcher_script.py keeps them
# identical):
# competition: 本番. Always launches (also at power-on) with the competition safety profile.
# practice:    練習. The controller drives freely; no QUESTiX LAB (no twist_arbiter, no lab
#              launcher input) and no teacher permission.
# lesson:      教材. QUESTiX LAB can drive and fire (twist_arbiter and the lab launcher input),
#              and the drive and launcher move only while the teacher's permission
#              (/actuation_authority, Robot Manager's 操作 tab) is on, controller included.
# practice and lesson launch only when someone pressed 起動 / 再起動 in Robot Manager just now.
# Robot Manager writes a start request (${CONFIG_DIR}/start-request) right before
# `systemctl start|restart`; this script consumes it (deletes it) and runs the launch. Without a
# fresh request (power-on, `systemctl start` by hand, or Restart=on-failure after a crash) it logs
# and exits 0, so these modes never start the robot by themselves.
#
# Consequence of consuming the request: a practice or lesson launch that crashes is NOT restarted
# by Restart=on-failure (the restart finds no request and exits 0; the unit ends up inactive).
# Press 起動 again in Robot Manager. Competition launches keep Restart=on-failure as before.
#
# The start request is a small key=value file (never sourced):
#   mode=practice (or lesson)
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

# Why the start request cannot start a ${MODE} launch now; empty when it can.
start_request_problem() {
  local requested_mode requested_at requested_boot now age
  if [ ! -f "${START_REQUEST_FILE}" ]; then
    echo "no start request from Robot Manager"
    return
  fi
  requested_mode="$(request_value mode)"
  requested_at="$(request_value requested_at)"
  requested_boot="$(request_value boot_id)"
  if [ "${requested_mode}" != "${MODE}" ]; then
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
  if [ "${MODE}" != "practice" ] && [ "${MODE}" != "lesson" ]; then
    log "Mode is '${MODE}' (not 'competition', 'practice' or 'lesson'). Skipping ROS2 launch."
    consume_start_request || true
    exit 0
  fi
  PROBLEM="$(start_request_problem)"
  if [ -n "${PROBLEM}" ]; then
    if [ -e "${START_REQUEST_FILE}" ] && ! consume_start_request; then
      log "Could not delete ${START_REQUEST_FILE}."
    fi
    log "Mode is '${MODE}': ${PROBLEM}. Skipping ROS2 launch (${MODE} starts only from Robot Manager's 起動 / 再起動)."
    exit 0
  fi
  # Consume the request before launching: a crash and Restart=on-failure must not relaunch.
  if ! consume_start_request; then
    log "Mode is '${MODE}' but ${START_REQUEST_FILE} cannot be deleted. Skipping ROS2 launch."
    exit 0
  fi
  log "Mode is '${MODE}' and Robot Manager asked to start. Starting the ${MODE} ROS2 launch..."
else
  # A practice / lesson start request never applies to a competition launch; drop a leftover one.
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
# A value missing from launch.env falls back to the fresh-kit topology
# (ansible/roles/robot_autostart/defaults/main.yaml): LiDAR, launcher and drive off, GPIO safety on,
# RViz off, DualShock. launcher/test/test_gpio_safety_launch.py keeps these in step.
# The GPIO5 physical E-stop path is not part of that topology: every production launch (lesson,
# practice and competition) passes enable_gpio_ref:=true, and ENABLE_GPIO_REF from launch.env is
# ignored here, so a legacy ENABLE_GPIO_REF=false cannot disable it (issue #168). Only a manual
# diagnostic `ros2 launch ... enable_gpio_ref:=false` runs without it.
LAUNCH_ARGS="${LAUNCH_ARGS} enable_lidar:=${ENABLE_LIDAR:-false}"
LAUNCH_ARGS="${LAUNCH_ARGS} enable_shot:=${ENABLE_SHOT:-false}"
LAUNCH_ARGS="${LAUNCH_ARGS} enable_drive:=${ENABLE_DRIVE:-false}"
if [ "${MODE}" = "competition" ]; then
  # Competition always requires both physical E-stop and AutoReferee GPIO safety inputs.
  LAUNCH_ARGS="${LAUNCH_ARGS} enable_gpio_ref:=true"
  LAUNCH_ARGS="${LAUNCH_ARGS} enable_autoreferee:=true"
else
  # Practice and lesson (Robot Manager's 起動 only): GPIO5 physical E-stop always on, no
  # AutoReferee. ENABLE_GPIO_REF in launch.env is a legacy field and is never read.
  LAUNCH_ARGS="${LAUNCH_ARGS} enable_gpio_ref:=true"
  LAUNCH_ARGS="${LAUNCH_ARGS} enable_autoreferee:=false"
  if [ "${MODE}" = "lesson" ]; then
    # Lesson: QUESTiX LAB shares /target_twist through twist_arbiter (the stick always wins) and
    # may operate the launcher; drive and launcher move only with the teacher's permission.
    LAUNCH_ARGS="${LAUNCH_ARGS} enable_twist_arbiter:=true enable_lab_shoot:=true"
    LAUNCH_ARGS="${LAUNCH_ARGS} require_teacher_permission:=true"
  else
    # Practice: the controller alone (joy_controller -> /target_twist), no lab input, no
    # teacher permission.
    LAUNCH_ARGS="${LAUNCH_ARGS} enable_twist_arbiter:=false enable_lab_shoot:=false"
    LAUNCH_ARGS="${LAUNCH_ARGS} require_teacher_permission:=false"
  fi
fi
LAUNCH_ARGS="${LAUNCH_ARGS} enable_rviz:=${ENABLE_RVIZ:-false}"
LAUNCH_ARGS="${LAUNCH_ARGS} controller_type:=${CONTROLLER_TYPE:-dualshock}"

# QUESTiX's ROS_DOMAIN_ID policy (scripts/robot_manager/ros_domain.py; kitting and Robot Manager
# refuse anything else). A value outside it is only warned about here, never refused or changed:
# a robot that already runs in such a domain keeps running in it until someone re-kits it.
ros_domain_allowed() {
  [[ "$1" =~ ^[0-9]{1,3}$ ]] || return 1
  local id=$((10#$1))
  { [ "${id}" -ge 0 ] && [ "${id}" -le 101 ]; } || { [ "${id}" -ge 215 ] && [ "${id}" -le 232 ]; }
}
if ! ros_domain_allowed "${ROS_DOMAIN_ID:-42}"; then
  log "WARNING: ROS_DOMAIN_ID=${ROS_DOMAIN_ID:-42} is outside 0-101 / 215-232 (DDS ports may collide with ephemeral ports); set a valid one with Robot Manager or re-run ./setup.sh"
fi

log "ROS_DOMAIN_ID=${ROS_DOMAIN_ID:-42}, Launching (${MODE}) with: ${LAUNCH_ARGS}"

# Export ROS_DOMAIN_ID (from launch.env or systemd Environment, default 42)
export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-42}"

record_launch "${MODE}"

# shellcheck disable=SC2086
exec ros2 launch questix_launcher questix_core.launch.xml ${LAUNCH_ARGS}
