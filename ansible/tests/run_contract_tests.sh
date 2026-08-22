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

run_playbook() {
    ansible-playbook "$@" -i localhost, --connection=local \
        >/tmp/questix_contract_test_last.log 2>&1
}

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

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
else
    fail "fresh render: playbook run failed (see /tmp/questix_contract_test_last.log)"
fi

# --- 2. Existing launch.env preservation + domain-only sync -----------------
PRESERVE_DIR="$TMP_ROOT/preserve"
mkdir -p "$PRESERVE_DIR"
cat >"$PRESERVE_DIR/launch.env" <<'EOF'
# custom header a human wrote
ENABLE_LIDAR=true
ROS_DOMAIN_ID=42
CONTROLLER_TYPE=uart
EOF
if run_playbook ansible/tests/test_launch_env.yaml \
    -e "questix_robot_config_dir=$PRESERVE_DIR" -e "ros_domain_id=12"; then
    ENV_FILE="$PRESERVE_DIR/launch.env"
    assert_contains "$ENV_FILE" "ENABLE_LIDAR=true" "preserve: existing non-domain setting kept"
    assert_contains "$ENV_FILE" "CONTROLLER_TYPE=uart" "preserve: existing non-domain setting kept (2)"
    assert_contains "$ENV_FILE" "# custom header a human wrote" "preserve: existing comment kept"
    assert_contains "$ENV_FILE" "ROS_DOMAIN_ID=12" "domain sync: ROS_DOMAIN_ID updated to resolved value"
    assert_not_contains "$ENV_FILE" "ROS_DOMAIN_ID=42" "domain sync: stale legacy value removed"
else
    fail "preserve: playbook run failed (see /tmp/questix_contract_test_last.log)"
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
    fail "duplicate: playbook run failed (see /tmp/questix_contract_test_last.log)"
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
    fail "bashrc sync: playbook run failed (see /tmp/questix_contract_test_last.log)"
fi

if run_playbook ansible/tests/test_bashrc_sync.yaml \
    -e "bashrc_path=$BASHRC_FILE" -e "workspace_path=$BASHRC_DIR/robot_ws" -e "ros_domain_id=15"; then
    assert_contains "$BASHRC_FILE" "export ROS_DOMAIN_ID=15" "bashrc sync: re-run updates to the new resolved value"
    assert_not_contains "$BASHRC_FILE" "export ROS_DOMAIN_ID=14" "bashrc sync: stale value replaced on re-run"
else
    fail "bashrc sync (re-run): playbook run failed (see /tmp/questix_contract_test_last.log)"
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
        >/tmp/questix_contract_test_last.log 2>&1; then
        result="pass"
    else
        result="fail"
    fi
    if [ "$result" = "$expect" ]; then
        pass "range assert: ros_domain_id=$value -> $expect"
    else
        fail "range assert: ros_domain_id=$value expected $expect, got $result (see /tmp/questix_contract_test_last.log)"
    fi
}

for v in 0 101 215 232; do assert_range_case "$v" pass; done
for v in 102 214 233 -1 abc; do assert_range_case "$v" fail; done

echo ""
echo "==================================================================="
echo "Contract tests: $PASS passed, $FAIL failed"
echo "==================================================================="
[ "$FAIL" -eq 0 ]
