#!/usr/bin/env bash
# Source-only contract tests for the kitting ROS_DOMAIN_ID resolver / shipping
# defaults change. Everything runs against temp directories with no `become`
# and no root — never touches /etc/questix_robot or real systemd state.
#
# Usage: ansible/tests/run_contract_tests.sh   (run from anywhere; cd's to repo root)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0

# The contract suite must never modify the developer/CI user's real shell
# configuration.  Role dependencies are exercised too, so guard this explicitly.
real_bashrc_fingerprint() {
    if [ -e "$HOME/.bashrc" ]; then
        sha256sum "$HOME/.bashrc" | awk '{print $1}'
    else
        echo "MISSING"
    fi
}
REAL_BASHRC_BEFORE="$(real_bashrc_fingerprint)"

pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

assert_contains() {
    local file="$1" needle="$2" label="$3"
    if grep -qF -- "$needle" "$file" 2>/dev/null; then
        pass "$label"
    else
        fail "$label (expected to find: $needle)"
    fi
}

assert_not_contains() {
    local file="$1" needle="$2" label="$3"
    if grep -qF -- "$needle" "$file" 2>/dev/null; then
        fail "$label (did not expect to find: $needle)"
    else
        pass "$label"
    fi
}

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
# Run-local (no shared /tmp path, so parallel runs never mix logs). The directory is removed on
# exit, so a failed playbook prints the end of its log right away.
PLAYBOOK_LOG="$TMP_ROOT/playbook.log"

show_log_tail() {
    echo "----- last lines of the playbook log -----"
    tail -n 40 "$PLAYBOOK_LOG" 2>/dev/null || true
    echo "------------------------------------------"
}

run_playbook() {
    if ansible-playbook "$@" -i localhost, --connection=local >"$PLAYBOOK_LOG" 2>&1; then
        return 0
    fi
    show_log_tail
    return 1
}

# --- 1. Fresh launch.env rendering (shipping defaults) ----------------------
FRESH_DIR="$TMP_ROOT/fresh"
mkdir -p "$FRESH_DIR"
if run_playbook ansible/tests/test_launch_env.yaml \
    -e "questix_robot_config_dir=$FRESH_DIR" -e "ros_domain_id=11"; then
    ENV_FILE="$FRESH_DIR/launch.env"
    assert_contains "$ENV_FILE" "ENABLE_LIDAR=false" "fresh render: ENABLE_LIDAR default false"
    assert_contains "$ENV_FILE" "ENABLE_SHOT=false" "fresh render: ENABLE_SHOT default false"
    assert_contains "$ENV_FILE" "ENABLE_DRIVE=false" "fresh render: ENABLE_DRIVE default false"
    assert_contains "$ENV_FILE" "ENABLE_GPIO_REF=true" "fresh render: ENABLE_GPIO_REF default true (manual-launch safety)"
    assert_contains "$ENV_FILE" "ENABLE_RVIZ=false" "fresh render: ENABLE_RVIZ default false"
    assert_contains "$ENV_FILE" "CONTROLLER_TYPE=dualshock" "fresh render: CONTROLLER_TYPE default dualshock"
    assert_contains "$ENV_FILE" "ROS_DOMAIN_ID=11" "fresh render: ROS_DOMAIN_ID synced to resolved value"
    # The lessons' drive/launch permissions are session-only (Robot Manager), never kit config.
    assert_not_contains "$ENV_FILE" "ALLOW_" "fresh render: no QUESTiX LAB permission in launch.env"
else
    fail "fresh render: playbook run failed (log shown above)"
fi

# --- 2. Existing launch.env preservation + domain-only sync -----------------
PRESERVE_DIR="$TMP_ROOT/preserve"
mkdir -p "$PRESERVE_DIR"
cat >"$PRESERVE_DIR/launch.env" <<'EOF'
# custom header a human wrote
ENABLE_LIDAR=true
ENABLE_SHOT=true
ENABLE_DRIVE=true
ROS_DOMAIN_ID=42
CONTROLLER_TYPE=uart
EOF
if run_playbook ansible/tests/test_launch_env.yaml \
    -e "questix_robot_config_dir=$PRESERVE_DIR" -e "ros_domain_id=12"; then
    ENV_FILE="$PRESERVE_DIR/launch.env"
    assert_contains "$ENV_FILE" "ENABLE_LIDAR=true" "preserve: existing non-domain setting kept"
    assert_contains "$ENV_FILE" "CONTROLLER_TYPE=uart" "preserve: existing non-domain setting kept (2)"
    assert_contains "$ENV_FILE" "ENABLE_SHOT=true" "preserve: an enabled launcher is not switched off by the new defaults"
    assert_contains "$ENV_FILE" "ENABLE_DRIVE=true" "preserve: an enabled drive is not switched off by the new defaults"
    assert_not_contains "$ENV_FILE" "ENABLE_DRIVE=false" "preserve: no fresh-kit value appended to an existing file"
    assert_contains "$ENV_FILE" "# custom header a human wrote" "preserve: existing comment kept"
    assert_contains "$ENV_FILE" "ROS_DOMAIN_ID=12" "domain sync: ROS_DOMAIN_ID updated to resolved value"
    assert_not_contains "$ENV_FILE" "ROS_DOMAIN_ID=42" "domain sync: stale legacy value removed"
else
    fail "preserve: playbook run failed (log shown above)"
fi

# --- 3. Duplicate ROS_DOMAIN_ID lines (documented last-wins behavior) -------
DUP_DIR="$TMP_ROOT/dup"
mkdir -p "$DUP_DIR"
cat >"$DUP_DIR/launch.env" <<'EOF'
ROS_DOMAIN_ID=10
ROS_DOMAIN_ID=20
EOF
if run_playbook ansible/tests/test_launch_env.yaml \
    -e "questix_robot_config_dir=$DUP_DIR" -e "ros_domain_id=13"; then
    ENV_FILE="$DUP_DIR/launch.env"
    DOMAIN_LINE_COUNT=$(grep -c '^ROS_DOMAIN_ID=' "$ENV_FILE")
    LAST_VALUE=$(grep '^ROS_DOMAIN_ID=' "$ENV_FILE" | tail -1)
    if [ "$LAST_VALUE" = "ROS_DOMAIN_ID=13" ]; then
        pass "duplicate ROS_DOMAIN_ID: last line reflects the resolved value (matches bash source semantics)"
    else
        fail "duplicate ROS_DOMAIN_ID: expected last line 'ROS_DOMAIN_ID=13', got: $LAST_VALUE"
    fi
    echo "INFO: duplicate ROS_DOMAIN_ID line count after sync: $DOMAIN_LINE_COUNT" \
        "(lineinfile replaces only the last match; pre-existing duplicate lines are not deleted -- known limitation, see README)"
else
    fail "duplicate: playbook run failed (log shown above)"
fi

# --- 4. bashrc synchronization -----------------------------------------------
BASHRC_DIR="$TMP_ROOT/bashrc"
mkdir -p "$BASHRC_DIR"
BASHRC_FILE="$BASHRC_DIR/.bashrc"
: >"$BASHRC_FILE"
if run_playbook ansible/tests/test_bashrc_sync.yaml \
    -e "bashrc_path=$BASHRC_FILE" -e "workspace_path=$BASHRC_DIR/robot_ws" -e "ros_domain_id=14"; then
    assert_contains "$BASHRC_FILE" "export ROS_DOMAIN_ID=14" "bashrc sync: managed block exports resolved domain id"
    assert_contains "$BASHRC_FILE" "# BEGIN ANSIBLE MANAGED BLOCK - ROS2 Robotics Kit" "bashrc sync: managed block markers present"
else
    fail "bashrc sync: playbook run failed (log shown above)"
fi

if run_playbook ansible/tests/test_bashrc_sync.yaml \
    -e "bashrc_path=$BASHRC_FILE" -e "workspace_path=$BASHRC_DIR/robot_ws" -e "ros_domain_id=15"; then
    assert_contains "$BASHRC_FILE" "export ROS_DOMAIN_ID=15" "bashrc sync: re-run updates to the new resolved value"
    assert_not_contains "$BASHRC_FILE" "export ROS_DOMAIN_ID=14" "bashrc sync: stale value replaced on re-run"
else
    fail "bashrc sync (re-run): playbook run failed (log shown above)"
fi

# --- 5. Static shipping-default / mode / service-enabled regression checks --
assert_contains "ansible/roles/robot_autostart/defaults/main.yaml" "robot_mode: practice" \
    "shipping defaults: robot_mode defaults to practice"
assert_contains "ansible/roles/robot_autostart/tasks/main.yaml" "enabled: true" \
    "shipping defaults: questix_robot service enabled"

# --- 6. ROS_DOMAIN_ID range assert (valid/invalid) ---------------------------
assert_range_case() {
    local value="$1" expect="$2"
    local result
    if ansible-playbook ansible/tests/test_validate_ros_domain_id.yaml \
        -i localhost, --connection=local -e "ros_domain_id=$value" \
        >"$PLAYBOOK_LOG" 2>&1; then
        result="pass"
    else
        result="fail"
    fi
    if [ "$result" = "$expect" ]; then
        pass "range assert: ros_domain_id=$value -> $expect"
    else
        show_log_tail
        fail "range assert: ros_domain_id=$value expected $expect, got $result (log shown above)"
    fi
}

for v in 0 101 215 232; do assert_range_case "$v" pass; done
for v in 102 214 233 -1 abc; do assert_range_case "$v" fail; done

# --- 7. bashrc GPIO helper (Pi 5 / Ubuntu 24.04) ------------------------------
# $BASHRC_FILE was rendered by the real robotics_workspace role in section 4.
assert_contains "$BASHRC_FILE" "alias gpio_status='gpioinfo gpiochip4'" \
    "gpio helper: gpio_status lists gpiochip4 read-only (gpio_reader's chip)"
assert_not_contains "$BASHRC_FILE" "raspi-gpio" "gpio helper: no raspi-gpio (absent on Ubuntu 24.04 / Pi 5)"
assert_not_contains "ansible/playbooks/setup_kit.yaml" "raspi-gpio" "gpio helper: completion message names no raspi-gpio"
assert_contains "gpio_reader/config/gpio_reader.yaml" 'chip_name: "/dev/gpiochip4"' \
    "gpio helper: gpio_reader still reads gpiochip4 (keep gpio_status_chip in step)"

# --- 8. Fresh-kit workspace build (ros2_build with fake ROS tools) ------------
# The real role tasks run against a temp workspace; fake vcs / rosdep / colcon / ros2 on PATH log
# every call. No network, no ROS, no apt, no root.
FAKE_TOOLS="$REPO_ROOT/ansible/tests/fake_ros_tools"
BUILD_WS="$TMP_ROOT/build_ws"
mkdir -p "$BUILD_WS/src/ydlidar_sdk_vendor/.git"
cp dependency.repos "$BUILD_WS/dependency.repos"
export FAKE_ROS_LOG="$TMP_ROOT/fake_ros.log"
: >"$FAKE_ROS_LOG"
REFUSE_ROOT=true
if [ "$(id -u)" -eq 0 ]; then REFUSE_ROOT=false; fi # only an isolated test may build as root
run_build() {
    PATH="$FAKE_TOOLS:$PATH" run_playbook ansible/tests/test_workspace_build.yaml \
        -e "workspace_path=$BUILD_WS" -e "workspace_ros_setup=$FAKE_TOOLS/setup.bash" \
        -e "workspace_rosdep_become=false" -e "workspace_build_refuse_root=$REFUSE_ROOT" "$@"
}
count_calls() { grep -c "^$1" "$FAKE_ROS_LOG" || true; }

if run_build; then
    assert_contains "$FAKE_ROS_LOG" "vcs import --input dependency.repos --skip-existing src" \
        "workspace build: missing dependency.repos entries imported with --skip-existing"
    if [ -d "$BUILD_WS/src/ydlidar_ros2/.git" ]; then
        pass "workspace build: the missing repository is in src/"
    else
        fail "workspace build: src/ydlidar_ros2 was not imported"
    fi
    assert_contains "$FAKE_ROS_LOG" "rosdep install --from-paths $BUILD_WS --ignore-src --rosdistro jazzy -r -y" \
        "workspace build: rosdep installs the workspace's keys"
    assert_contains "$FAKE_ROS_LOG" "ROS_HOME=/home/$USER/.ros" "workspace build: rosdep reads the kit user's index"
    assert_contains "$FAKE_ROS_LOG" "colcon build --symlink-install" "workspace build: colcon build --symlink-install"
    assert_contains "$FAKE_ROS_LOG" "ros2 pkg prefix questix_lab_bridge" "workspace build: questix_lab_bridge must resolve"
    assert_contains "$FAKE_ROS_LOG" "ros2 pkg executables questix_lab_bridge" "workspace build: lab_bridge_node must resolve"
    assert_contains "$PLAYBOOK_LOG" "Workspace built at: $BUILD_WS" "workspace build: result reported"
else
    fail "workspace build: first run failed (log shown above)"
fi

# Second setup run: nothing is imported again, the build and the checks run again.
if run_build; then
    if [ "$(count_calls vcs)" = "1" ]; then
        pass "workspace build idempotency: second run imports nothing"
    else
        fail "workspace build idempotency: vcs ran $(count_calls vcs) times over two runs"
    fi
    if [ "$(count_calls colcon)" = "2" ]; then
        pass "workspace build idempotency: second run rebuilds"
    else
        fail "workspace build idempotency: colcon ran $(count_calls colcon) times over two runs"
    fi
else
    fail "workspace build: second run failed (log shown above)"
fi

# A package that does not resolve fails the setup instead of reporting it complete: a colcon
# that builds no questix_lab_bridge.
BROKEN_TOOLS="$TMP_ROOT/broken_tools"
mkdir -p "$BROKEN_TOOLS"
cat >"$BROKEN_TOOLS/colcon" <<'EOF_COLCON'
#!/usr/bin/env bash
echo "colcon $*" >>"$FAKE_ROS_LOG"
rm -rf install && mkdir -p build log install
: >install/setup.bash
EOF_COLCON
chmod +x "$BROKEN_TOOLS/colcon"
if PATH="$BROKEN_TOOLS:$FAKE_TOOLS:$PATH" ansible-playbook ansible/tests/test_workspace_build.yaml \
    -i localhost, --connection=local -e "workspace_path=$BUILD_WS" \
    -e "workspace_ros_setup=$FAKE_TOOLS/setup.bash" -e "workspace_rosdep_become=false" \
    -e "workspace_build_refuse_root=$REFUSE_ROOT" >"$PLAYBOOK_LOG" 2>&1; then
    fail "workspace build: a build without questix_lab_bridge was reported as success"
else
    assert_not_contains "$PLAYBOOK_LOG" "Workspace built at:" "workspace build: a missing questix_lab_bridge fails the setup"
fi

# Check mode (the CI dry run) runs no import, rosdep or build.
CHECK_LOG_BEFORE=$(wc -l <"$FAKE_ROS_LOG")
if run_build --check; then
    if [ "$(wc -l <"$FAKE_ROS_LOG")" = "$CHECK_LOG_BEFORE" ]; then
        pass "workspace build: check mode runs no tool"
    else
        fail "workspace build: check mode ran a tool"
    fi
else
    fail "workspace build: check mode run failed (log shown above)"
fi

# Not the QUESTiX checkout: refuse, with the reason.
NOT_WS="$TMP_ROOT/not_a_checkout"
mkdir -p "$NOT_WS"
if PATH="$FAKE_TOOLS:$PATH" ansible-playbook ansible/tests/test_workspace_build.yaml \
    -i localhost, --connection=local -e "workspace_path=$NOT_WS" \
    -e "workspace_build_refuse_root=$REFUSE_ROOT" >"$PLAYBOOK_LOG" 2>&1; then
    fail "workspace build: a workspace without dependency.repos was accepted"
else
    assert_contains "$PLAYBOOK_LOG" "dependency.repos not found" "workspace build: a path that is not the checkout is refused"
fi

# Static: the kit playbook builds after the bashrc/workspace role and before the services.
ROLE_ORDER=$(grep -oE 'role: (robotics_workspace|ros2_build|robot_autostart|openssh_server)' ansible/playbooks/setup_kit.yaml | tr '\n' ' ')
if [ "$ROLE_ORDER" = "role: openssh_server role: robotics_workspace role: ros2_build role: robot_autostart " ]; then
    pass "setup_kit: openssh_server, robotics_workspace, ros2_build, robot_autostart in that order"
else
    fail "setup_kit role order: $ROLE_ORDER"
fi
assert_not_contains "ansible/roles/ros2_build/tasks/main.yaml" "ros2 launch" "workspace build: starts no node"
assert_not_contains "ansible/roles/ros2_build/tasks/main.yaml" "ros2 run" "workspace build: runs no node"

# --- 9. OpenSSH server -----------------------------------------------------------
assert_contains "ansible/roles/openssh_server/defaults/main.yaml" "install_openssh_server: true" \
    "openssh: installed by default"
assert_contains "ansible/roles/openssh_server/tasks/main.yaml" "name: openssh-server" "openssh: package"
assert_contains "ansible/roles/openssh_server/tasks/main.yaml" "enabled: true" "openssh: unit enabled"
assert_contains "ansible/roles/openssh_server/tasks/main.yaml" "state: started" "openssh: unit started"
assert_contains "ansible/roles/openssh_server/tasks/main.yaml" "/usr/sbin/sshd -t" "openssh: configuration validated"
for forbidden in "state: absent" "enabled: false" "state: stopped" "lineinfile" "sshd_config.d" \
    "PasswordAuthentication" "PermitRootLogin" "authorized_key" "ufw" "Port "; do
    assert_not_contains "ansible/roles/openssh_server/tasks/main.yaml" "$forbidden" \
        "openssh: no '$forbidden' (Ubuntu's defaults, nothing removed or weakened)"
done
if run_playbook ansible/tests/test_openssh_disabled.yaml; then
    # Every task of the role is skipped: nothing changed, nothing ran (only include_role is ok).
    if grep -qE 'localhost +: ok=1 +changed=0 ' "$PLAYBOOK_LOG" &&
        ! grep -qE '^(ok|changed): \[localhost\]' "$PLAYBOOK_LOG"; then
        pass "openssh: install_openssh_server=false does nothing"
    else
        fail "openssh: install_openssh_server=false still ran a task"
        show_log_tail
    fi
else
    fail "openssh: disabled run failed (log shown above)"
fi

# --- 10. Desktop shortcut trust is read back, never assumed ----------------------
DESKTOP_TASKS="ansible/roles/robot_autostart/tasks/robot_manager.yaml"
assert_contains "$DESKTOP_TASKS" "register: desktop_trust_set" "desktop trust: gio set result registered"
assert_contains "$DESKTOP_TASKS" "gio info --attributes=metadata::trusted" "desktop trust: read back with gio info"
assert_contains "$DESKTOP_TASKS" "WARNING: the Robot Manager desktop shortcut is not marked as trusted." \
    "desktop trust: an untrusted shortcut is reported as a warning"
assert_contains "ansible/playbooks/setup_kit.yaml" "Desktop shortcut not trusted" \
    "desktop trust: the completion message does not claim trust it did not verify"

REAL_BASHRC_AFTER="$(real_bashrc_fingerprint)"
if [ "$REAL_BASHRC_BEFORE" = "$REAL_BASHRC_AFTER" ]; then
    pass "isolation: real user ~/.bashrc remained byte-identical"
else
    fail "isolation: real user ~/.bashrc was modified"
fi

echo ""
echo "==================================================================="
echo "Contract tests: $PASS passed, $FAIL failed"
echo "==================================================================="
[ "$FAIL" -eq 0 ]
