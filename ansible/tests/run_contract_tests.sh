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
ROLE_ORDER=$(grep -oE 'role: (robotics_workspace|ros2_build|robot_autostart)' ansible/playbooks/setup_kit.yaml | tr '\n' ' ')
if [ "$ROLE_ORDER" = "role: robotics_workspace role: ros2_build role: robot_autostart " ]; then
    pass "setup_kit: robotics_workspace, ros2_build, robot_autostart in that order"
else
    fail "setup_kit role order: $ROLE_ORDER"
fi
assert_not_contains "ansible/roles/ros2_build/tasks/main.yaml" "ros2 launch" "workspace build: starts no node"
assert_not_contains "ansible/roles/ros2_build/tasks/main.yaml" "ros2 run" "workspace build: runs no node"

# --- 9. Desktop shortcut trust is read back, never assumed -----------------------
DESKTOP_TASKS="ansible/roles/robot_autostart/tasks/robot_manager.yaml"
assert_contains "$DESKTOP_TASKS" "register: desktop_trust_set" "desktop trust: gio set result registered"
assert_contains "$DESKTOP_TASKS" "gio info --attributes=metadata::trusted" "desktop trust: read back with gio info"
assert_contains "$DESKTOP_TASKS" "WARNING: the Robot Manager desktop shortcut is not marked as trusted." \
    "desktop trust: an untrusted shortcut is reported as a warning"
assert_contains "ansible/playbooks/setup_kit.yaml" "Desktop shortcut not trusted" \
    "desktop trust: the completion message does not claim trust it did not verify"

# --- 11. QUESTiX Local (Robot Manager network card) ------------------------------
# The root helper writes the same files as the wifi_access_point role: render the role's own
# templates with Ansible and compare them with the helper's render_* output (first line = header).
for case in \
    '{"wifi_ap_state": "up", "wifi_ap_interface": "wlan0", "wifi_ap_ssid": "QUESTiX 3F2A", "wifi_ap_password": "ab\"c'"'"'d;e:f", "wifi_ap_band": "a", "wifi_ap_channel": 40, "wifi_ap_country": "JP", "wifi_ap_address": "10.43.0.1/24"}' \
    '{"wifi_ap_state": "down", "wifi_ap_interface": "wlan0", "wifi_ap_ssid": "QUESTiX-3F2A", "wifi_ap_password": "Abc23456defg", "wifi_ap_band": "bg", "wifi_ap_channel": 6, "wifi_ap_country": "JP", "wifi_ap_address": "10.42.0.1/24"}'; do
    RENDER_DIR="$(mktemp -d "$TMP_ROOT/render.XXXX")"
    printf '%s' "$case" > "$RENDER_DIR/vars.json"
    if run_playbook ansible/tests/test_wifi_ap_render.yaml -e "render_dir=$RENDER_DIR" \
        -e "wifi_ap_connection_name=questix-ap" -e "@$RENDER_DIR/vars.json"; then
        if PYTHONPATH=scripts python3 - "$RENDER_DIR" << 'PYTHON'
import json, pathlib, sys
from robot_manager import network_admin as na
directory = pathlib.Path(sys.argv[1])
values = {k.removeprefix("wifi_ap_"): v for k, v in json.loads((directory / "vars.json").read_text()).items()}
body = lambda text: text.split("\n", 1)[1]
ok = body((directory / "keyfile").read_text()) == na.render_keyfile(values)
ok = ok and body((directory / "settings").read_text()) == na.render_settings(values)
sys.exit(0 if ok else 1)
PYTHON
        then
            pass "QUESTiX Local: helper renders the role's keyfile and settings ($(printf '%s' "$case" | cut -c1-30)...)"
        else
            fail "QUESTiX Local: helper output differs from the role's templates"
            diff <(tail -n +2 "$RENDER_DIR/keyfile") <(PYTHONPATH=scripts python3 -c "import json,sys; from robot_manager import network_admin as na; v={k[8:]:x for k,x in json.load(open('$RENDER_DIR/vars.json')).items()}; sys.stdout.write(na.render_keyfile(v))") || true
        fi
    else
        fail "QUESTiX Local: template render failed (log shown above)"
    fi
done
assert_contains "ansible/roles/wifi_access_point/tasks/main.yaml" \
    "options cfg80211 ieee80211_regdom={{ wifi_ap_country }}" "QUESTiX Local: regulatory domain line of the role"
assert_contains "scripts/robot_manager/network_admin.py" \
    'f"options cfg80211 ieee80211_regdom={s['"'"'country'"'"']}\n"' "QUESTiX Local: same regulatory domain line in the helper"

# polkit: the static rules and the template are the same apart from the user, and the new rule
# allows only `start` of questix_network_admin.service.
if diff <(sed 's|"ubuntu"|"{{ target_user }}"|' systemd/50-questix-robot.rules) \
    ansible/roles/robot_autostart/templates/50-questix-robot.rules.j2 >/dev/null; then
    pass "QUESTiX Local: polkit static rules and Ansible template are identical"
else
    fail "QUESTiX Local: polkit static rules and Ansible template differ"
fi
if python3 - systemd/50-questix-robot.rules << 'PYTHON'
import re, sys
text = open(sys.argv[1]).read()
rules = re.findall(r"polkit\.addRule\(function\(action, subject\) \{(.*?)\n\}\);", text, re.S)
network = [r for r in rules if "questix_network_admin.service" in r]
assert len(network) == 1, "one rule for the network unit"
rule = network[0]
assert re.findall(r'action\.lookup\("verb"\) === "(\w+)"', rule) == ["start"], "verb start only"
assert 'action.lookup("unit") === "questix_network_admin.service"' in rule
assert 'subject.user === "ubuntu"' in rule
assert "org.freedesktop.systemd1.manage-units" in rule
# No rule without a unit check.
assert all('action.lookup("unit") ===' in r for r in rules), "every rule names its unit"
PYTHON
then
    pass "QUESTiX Local: polkit allows only starting questix_network_admin.service for the robot user"
else
    fail "QUESTiX Local: polkit rule is broader than start of questix_network_admin.service"
fi

UNIT=systemd/questix_network_admin.service
assert_contains "$UNIT" "Type=oneshot" "QUESTiX Local: helper unit is a oneshot"
assert_contains "$UNIT" "User=root" "QUESTiX Local: helper unit runs as root"
assert_contains "$UNIT" "ExecStart=/usr/bin/python3 -I /opt/questix_robot/questix_network_admin.py apply" \
    "QUESTiX Local: helper unit runs the root-owned copy with python3 -I"
assert_not_contains "$UNIT" "[Install]" "QUESTiX Local: helper unit is never enabled (no AP at boot or setup)"
# Sandbox of the root oneshot (systemd-analyze security: 8.9 before, 4.9 with these).
for directive in "ProtectSystem=strict" \
    "ReadWritePaths=/etc/questix_robot -/etc/NetworkManager/system-connections -/etc/modprobe.d" \
    "RuntimeDirectory=questix_network_admin" "NoNewPrivileges=yes" "PrivateDevices=yes" \
    "ProtectHome=yes" "ProtectKernelTunables=yes" "ProtectKernelModules=yes" "ProtectKernelLogs=yes" \
    "ProtectControlGroups=yes" "RestrictSUIDSGID=yes" "RestrictNamespaces=yes" "LockPersonality=yes" \
    "RestrictAddressFamilies=AF_UNIX AF_NETLINK"; do
    assert_contains "$UNIT" "$directive" "QUESTiX Local: helper unit sets $directive"
done
assert_contains scripts/robot_manager/network_admin.py 'LOCK_PATH = "/run/questix_network_admin/lock"' \
    "QUESTiX Local: the helper's lock is in the unit's RuntimeDirectory"
if command -v systemd-analyze >/dev/null 2>&1; then
    if systemd-analyze verify "$UNIT" >"$TMP_ROOT/verify.log" 2>&1; then
        pass "QUESTiX Local: systemd-analyze verify accepts the helper unit"
    else
        fail "QUESTiX Local: systemd-analyze verify rejects the helper unit"
        cat "$TMP_ROOT/verify.log"
    fi
fi
RM_TASKS=ansible/roles/robot_autostart/tasks/robot_manager.yaml
if python3 - "$RM_TASKS" << 'PYTHON'
import sys, yaml
tasks = yaml.safe_load(open(sys.argv[1]))
helper = [t for t in tasks if t.get("ansible.builtin.copy", {}).get("dest") == "/opt/questix_robot/questix_network_admin.py"]
unit = [t for t in tasks if t.get("ansible.builtin.copy", {}).get("dest") == "/etc/systemd/system/questix_network_admin.service"]
assert len(helper) == 1 and len(unit) == 1
copy = helper[0]["ansible.builtin.copy"]
assert (copy["owner"], copy["group"], copy["mode"]) == ("root", "root", "0755")
assert helper[0]["ansible.builtin.copy"]["src"].endswith("scripts/robot_manager/network_admin.py")
apt = [t["ansible.builtin.apt"]["name"] for t in tasks if "ansible.builtin.apt" in t]
assert any("dnsmasq-base" in names and "iw" in names for names in apt)
# The helper unit is neither started nor enabled by setup, and nothing brings the AP up here.
for t in tasks:
    unit_name = str(t.get("ansible.builtin.systemd", {}).get("name", ""))
    assert "questix_network_admin" not in unit_name
    assert "nmcli" not in str(t.get("ansible.builtin.command", ""))
PYTHON
then
    pass "QUESTiX Local: setup installs the root-owned helper, its unit and tools, and starts nothing"
else
    fail "QUESTiX Local: setup tasks for the helper are wrong"
fi
assert_contains "ansible/playbooks/vars/setup_kit_vars.yaml" "wifi_ap_enabled: false" \
    "QUESTiX Local: fresh kits still create no access point (wifi_ap_enabled: false)"
assert_contains "ansible/playbooks/setup_kit.yaml" "{ role: wifi_access_point, when: wifi_ap_enabled | bool }" \
    "QUESTiX Local: wifi_ap_enabled keeps its meaning"
for installer in scripts/install-robot-manager.sh scripts/update-robot-manager.sh; do
    assert_contains "$installer" "questix_network_admin" "QUESTiX Local: $installer installs the helper"
done
assert_contains scripts/install-robot-manager.sh \
    'install -o root -g root -m 0755 "${REPO_DIR}/scripts/robot_manager/network_admin.py"' \
    "QUESTiX Local: installer copies the helper root-owned"
assert_contains scripts/update-robot-manager.sh \
    'install -o root -g root -m 0755 "$NETWORK_ADMIN_SOURCE" "$NETWORK_ADMIN_TARGET"' \
    "QUESTiX Local: updater copies the helper root-owned"
# Robot Manager stays an unprivileged, local-only service; nothing grants sudo.
for unit in systemd/questix_robot_manager.service ansible/roles/robot_autostart/templates/questix_robot_manager.service.j2; do
    assert_contains "$unit" "--host 127.0.0.1" "QUESTiX Local: $unit listens on 127.0.0.1 only"
    assert_not_contains "$unit" "User=root" "QUESTiX Local: $unit does not run as root"
done
# The QUESTiX Local change never adds a sudo rule (checked with section 12's scanner).
if python3 ansible/tests/scan_privileges.py nopasswd ansible/roles ansible/playbooks systemd \
    scripts/robot_manager scripts/install-robot-manager.sh scripts/update-robot-manager.sh \
    scripts/wifi-ap.sh > "$TMP_ROOT/hits"; then
    pass "QUESTiX Local: no NOPASSWD sudoers rule in the kit setup or Robot Manager"
else
    fail "QUESTiX Local: a NOPASSWD sudoers rule exists: $(tr '\n' ' ' < "$TMP_ROOT/hits")"
fi

# --- 12. Legacy root-equivalent defaults (custom image, polkit, sudoers) ---------
# Shipping and runtime paths (the tests and the cleanup script's own description of what it
# removes excluded) carry no known password, no NOPASSWD:ALL and no broad polkit rule.
SHIPPING=(scripts systemd ansible/roles ansible/playbooks .github setup.sh setup_dev.sh)
for check in nopasswd known-password autologin-ubuntu broad-polkit; do
    if python3 ansible/tests/scan_privileges.py "$check" "${SHIPPING[@]}" > "$TMP_ROOT/hits"; then
        pass "legacy privileges: no $check in shipping paths"
    else
        fail "legacy privileges: $check still shipped: $(tr '\n' ' ' < "$TMP_ROOT/hits")"
    fi
done
if git ls-files '*.pkla' | grep -q .; then
    fail "legacy privileges: a .pkla file is still in the repository"
else
    pass "legacy privileges: no .pkla file in the repository"
fi
for installer in scripts/install-robot-manager.sh scripts/update-robot-manager.sh; do
    assert_not_contains "$installer" "localauthority/50-local.d/50-questix-robot.pkla\"" \
        "legacy privileges: $installer deploys no .pkla"
    assert_contains "$installer" "cleanup_legacy_privileges.py" \
        "legacy privileges: $installer removes stale legacy files"
done
assert_contains ansible/playbooks/setup_kit.yaml "{ role: legacy_privilege_cleanup }" \
    "legacy privileges: setup_kit ends with the cleanup role"
assert_contains ansible/playbooks/setup_dev.yaml "name: legacy_privilege_cleanup" \
    "legacy privileges: setup_dev runs the cleanup role"
# The robot service keeps exactly its three verbs.
if python3 - systemd/50-questix-robot.rules << 'PYTHON'
import re, sys
text = open(sys.argv[1]).read()
rules = re.findall(r"polkit\.addRule\(function\(action, subject\) \{(.*?)\n\}\);", text, re.S)
robot = [r for r in rules if 'action.lookup("unit") === "questix_robot.service"' in r]
assert len(robot) == 1 and len(rules) == 2
assert sorted(re.findall(r'action\.lookup\("verb"\) === "(\w+)"', robot[0])) == ["restart", "start", "stop"]
assert "policykit.exec" not in text
PYTHON
then
    pass "legacy privileges: polkit = questix_robot start/stop/restart + network start, nothing else"
else
    fail "legacy privileges: polkit rules are not the two narrow rules"
fi

# The custom image: locked account, SSH off until the console enrollment, no autologin.
assert_contains scripts/prepare-base-system.sh "passwd -l ubuntu" "image: the account is created locked"
assert_not_contains scripts/prepare-base-system.sh "chpasswd" "image: no password is baked in"
assert_not_contains scripts/prepare-base-system.sh "systemctl enable ssh" "image: base system does not enable SSH"
ISO_APPLY=scripts/apply-ansible-config.sh
assert_contains "$ISO_APPLY" '-e "enable_autologin=false"' "image: Ansible adds no autologin"
assert_contains "$ISO_APPLY" "systemctl enable questix-first-boot.service" "image: first-boot enrollment enabled"
assert_contains "$ISO_APPLY" 'systemctl disable "$unit"' "image: SSH units disabled before the image is built"
assert_contains "$ISO_APPLY" "rm -f /etc/sudoers.d/ubuntu" "image: no legacy sudoers file"
assert_contains "$ISO_APPLY" "A NOPASSWD sudo rule is in the image" "image: build fails on a NOPASSWD rule"
assert_contains "$ISO_APPLY" "The ubuntu account is not locked" "image: build fails on an unlocked account"
assert_contains "$ISO_APPLY" "SSH is enabled before the first-boot enrollment" "image: build fails on enabled SSH"
assert_not_contains "$ISO_APPLY" "first-boot-setup.sh" "image: no .bashrc first-boot script"
assert_contains scripts/iso/image-build-lib.sh 'install -D -m 0755 "$iso_dir/questix-first-boot-enroll.sh"' \
    "image: enrollment helper installed 0755 (root-owned by the root build)"

# The role's decisions, with a fake cleanup script.
FAKE_CLEANUP="$TMP_ROOT/fake_cleanup.py"
cat > "$FAKE_CLEANUP" << 'PYTHON'
import os, sys
log = os.environ["FAKE_CLEANUP_LOG"]
with open(log, "a") as out:
    out.write(" ".join(sys.argv[1:]) + "\n")
if "--check" in sys.argv:
    print("would remove /etc/sudoers.d/ubuntu" if os.environ["FAKE_CLEANUP_PENDING"] == "1" else "")
    sys.exit(int(os.environ["FAKE_CLEANUP_PENDING"]))
print("removed /etc/sudoers.d/ubuntu: legacy NOPASSWD:ALL rule")
PYTHON
for pending in 0 1; do
    export FAKE_CLEANUP_LOG="$TMP_ROOT/fake_cleanup.$pending.log" FAKE_CLEANUP_PENDING=$pending
    if run_playbook ansible/tests/test_legacy_cleanup.yaml -e "legacy_privilege_cleanup_script=$FAKE_CLEANUP"; then
        runs="$(grep -cv -- '--check' "$FAKE_CLEANUP_LOG" || true)"
        if [ "$pending" = 1 ] && [ "$runs" = 1 ] && grep -qE 'changed=1 ' "$PLAYBOOK_LOG"; then
            pass "cleanup role: a pending cleanup runs once and reports a change"
        elif [ "$pending" = 0 ] && [ "$runs" = 0 ] && grep -qE 'changed=0 ' "$PLAYBOOK_LOG"; then
            pass "cleanup role: nothing pending, nothing run (idempotent second run)"
        else
            fail "cleanup role: pending=$pending ran $runs time(s)"
            show_log_tail
        fi
    else
        fail "cleanup role: playbook failed (pending=$pending)"
    fi
done
# 2 = unsafe (e.g. the old image's known password): the setup must fail, and nothing is removed.
export FAKE_CLEANUP_LOG="$TMP_ROOT/fake_cleanup.2.log" FAKE_CLEANUP_PENDING=2
if run_playbook ansible/tests/test_legacy_cleanup.yaml -e "legacy_privilege_cleanup_script=$FAKE_CLEANUP" \
    > /dev/null 2>&1; then
    fail "cleanup role: an unsafe state (exit 2) did not fail the setup"
elif grep -q "Unsafe legacy privilege state" "$PLAYBOOK_LOG" \
    && [ "$(grep -cv -- '--check' "$FAKE_CLEANUP_LOG" || true)" = 0 ]; then
    pass "cleanup role: an unsafe state (exit 2) fails the setup without a cleanup run"
else
    fail "cleanup role: exit 2 not reported as unsafe"
    show_log_tail
fi
# The update and install paths never treat an unsafe state as clean.
UPDATER=scripts/update-robot-manager.sh
assert_contains "$UPDATER" 'LEGACY_REPORT="$(python3 -I "$LEGACY_CLEANUP" --check 2>&1)" || LEGACY_STATE=$?' \
    "legacy exit contract: the updater reads the cleanup's --check status"
assert_contains "$UPDATER" '[ "$mode" = --check ] && exit 3' \
    "legacy exit contract: update --check reports an unsafe state as 3 (never up to date)"
assert_contains "$UPDATER" '[ "$LEGACY_STATE" = 0 ] && legacy_ok=1' \
    "legacy exit contract: only 0 counts as clean in the updater"
assert_contains "$UPDATER" "古い版の権限の状態を安全に整理できません" \
    "legacy exit contract: an update stops on an unsafe state"
assert_contains scripts/check-robot-manager.sh '3) ng "古い版が残した権限に' \
    "legacy exit contract: check-robot-manager reports update --check 3"
assert_contains scripts/install-robot-manager.sh 'if [ "$legacy_state" != 0 ] && [ "$legacy_state" != 1 ]; then' \
    "legacy exit contract: the installer stops before any change on an unsafe state"
if run_playbook ansible/tests/test_legacy_cleanup.yaml -e "legacy_privilege_cleanup_script=$TMP_ROOT/missing.py" &&
    grep -q "Legacy privilege cleanup skipped" "$PLAYBOOK_LOG"; then
    pass "cleanup role: skipped with a message when the script is not there (image build)"
else
    fail "cleanup role: missing script not handled"
fi
unset FAKE_CLEANUP_LOG FAKE_CLEANUP_PENDING

# --- 13. Custom image build (scripts/iso/image-build-lib.sh, apply-ansible-config.sh) ---
. ansible/tests/image_build_contract.sh

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
