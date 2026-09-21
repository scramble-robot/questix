#!/usr/bin/env bash
# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
#
# lib_evidence.sh と record.sh の preflight を実機なしで検証する。
#
#   bash scripts/identify/test_evidence.sh
#
# ros2 は PATH 上のスタブに差し替えるため、ROS 2 環境も drive_component も不要。
# bag 記録とステップ列 publish（実機が要る部分）は対象外で、preflight までを見る。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/identify/lib_evidence.sh
. "$SCRIPT_DIR/lib_evidence.sh"

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); echo "  ok   - $1"; }
ng()   { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else ng "$1 (expected '$3', got '$2')"; fi; }
contains() { if [[ "$2" == *"$3"* ]]; then ok "$1"; else ng "$1 (missing '$3' in: $2)"; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---- source identity --------------------------------------------------------

echo "== source identity =="

REPO="$TMP/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email t@example.com
git -C "$REPO" config user.name test
echo one >"$REPO/a.txt"
git -C "$REPO" add a.txt
git -C "$REPO" commit -qm first

SHA="$(evidence_git_full_sha "$REPO")"
check "完全 SHA は 40 桁（短縮しない）" "${#SHA}" "40"
check "clean な作業ツリー" "$(evidence_git_dirty "$REPO")" "clean"
check "detached でない" "$(evidence_git_detached "$REPO")" "false"
check "git status は clean なら空" "$(evidence_git_status_body "$REPO")" ""

echo two >"$REPO/a.txt"
check "変更を dirty として検出" "$(evidence_git_dirty "$REPO")" "dirty"
contains "git status に変更ファイルが残る" "$(evidence_git_status_body "$REPO")" "a.txt"

git -C "$REPO" checkout -q --detach HEAD
check "detached HEAD を検出" "$(evidence_git_detached "$REPO")" "true"
check "detached のブランチ名" "$(evidence_git_branch "$REPO")" "(detached)"

IDENT="$(ROS_DISTRO=jazzy ROS_DOMAIN_ID=7 RMW_IMPLEMENTATION=rmw_fastrtps_cpp \
  evidence_source_identity "$REPO")"
contains "source identity に完全 SHA" "$IDENT" "git_commit: $SHA"
contains "source identity に ROS_DISTRO" "$IDENT" "ros_distro: jazzy"
contains "source identity に ROS_DOMAIN_ID" "$IDENT" "ros_domain_id: 7"
contains "source identity に RMW" "$IDENT" "rmw_implementation: rmw_fastrtps_cpp"
contains "source identity に dirty 状態" "$IDENT" "git_worktree: dirty"

NOTGIT="$TMP/notgit"
mkdir -p "$NOTGIT"
check "git 外では unknown" "$(evidence_git_full_sha "$NOTGIT")" "unknown"
contains "git 外の status は注記" "$(evidence_git_status_body "$NOTGIT")" "not a git working tree"

# ---- 記録対象 topic ---------------------------------------------------------

echo "== 記録対象 topic =="

AVAIL="$TMP/topics.txt"
printf '/drive_status\n/target_twist\n/rosout\n' >"$AVAIL"
check "optional 不在でも required だけで組み立つ" \
  "$(evidence_select_topics '/drive_status,/target_twist' '/odom,/emergency_stop' "$AVAIL" | tr '\n' ' ')" \
  "/drive_status /target_twist "

printf '/drive_status\n/target_twist\n/odom\n' >"$AVAIL"
check "存在する optional だけ足す" \
  "$(evidence_select_topics '/drive_status,/target_twist' '/odom,/emergency_stop' "$AVAIL" | tr '\n' ' ')" \
  "/drive_status /target_twist /odom "

printf '/drive_status_extra\n/target_twist\n' >"$AVAIL"
check "部分一致で optional を拾わない" \
  "$(evidence_select_topics '/target_twist' '/drive_status' "$AVAIL" | tr '\n' ' ')" \
  "/target_twist "

# ---- パラメータ差分 ---------------------------------------------------------

echo "== パラメータ before/after =="

BEFORE="$TMP/before.yaml"
AFTER="$TMP/after.yaml"
DIFF="$TMP/diff.txt"
printf 'drive_component:\n  ros__parameters:\n    control_mode: velocity\n' >"$BEFORE"
cp "$BEFORE" "$AFTER"
evidence_param_diff "$BEFORE" "$AFTER" "$DIFF"
check "同一なら rc=0" "$?" "0"
if [[ ! -e "$DIFF" ]]; then ok "同一なら diff ファイルを残さない"; else ng "同一なのに diff ファイルが残った"; fi

printf 'drive_component:\n  ros__parameters:\n    control_mode: current\n' >"$AFTER"
evidence_param_diff "$BEFORE" "$AFTER" "$DIFF"
check "差分ありなら rc=1" "$?" "1"
contains "diff ファイルに変化が載る" "$(cat "$DIFF")" "control_mode"

evidence_param_diff "$TMP/missing.yaml" "$AFTER" "$DIFF"
check "片側が無ければ rc=2（比較不能）" "$?" "2"

# ---- bag integrity ----------------------------------------------------------

echo "== bag info =="

INFO="$TMP/bag_info.txt"
cat >"$INFO" <<'INFO_OK'
Files:             bag_0.mcap
Messages:          4213
Topic information: Topic: /drive_status | Type: questix_msgs/msg/DriveStatus | Count: 3200
                   Topic: /target_twist | Type: geometry_msgs/msg/Twist | Count: 1013
INFO_OK
evidence_bag_info_warnings "$INFO" '/drive_status,/target_twist' >/dev/null
check "健全な bag info は警告なし" "$?" "0"

cat >"$INFO" <<'INFO_EMPTY'
Files:             bag_0.mcap
Messages:          0
Topic information:
INFO_EMPTY
WARN="$(evidence_bag_info_warnings "$INFO" '/drive_status,/target_twist')"
check "空の bag は警告" "$?" "1"
contains "メッセージ 0 を指摘" "$WARN" "メッセージ総数が 0"
contains "欠けた topic を指摘" "$WARN" "/drive_status"

: >"$INFO"
evidence_bag_info_warnings "$INFO" '/drive_status' >/dev/null
check "bag info が空なら警告" "$?" "1"

# ---- record.sh の preflight（ros2 スタブ）-----------------------------------

echo "== record.sh preflight =="

STUB_DIR="$TMP/bin"
mkdir -p "$STUB_DIR"
cat >"$STUB_DIR/ros2" <<'STUB'
#!/usr/bin/env bash
# preflight 検証用の最小 ros2 スタブ。STUB_NODES / STUB_TOPICS / STUB_RAW で応答を変える。
case "$1 ${2:-}" in
  "node list")      printf '%s\n' ${STUB_NODES:-} ;;
  "topic list")     printf '%s\n' ${STUB_TOPICS:-} ;;
  "param get")      [[ -n "${STUB_NODES:-}" ]] && echo "String value is: velocity" ;;
  "param dump")     # STUB_PARAM_STATE がある場合、2 回目の dump は値を変えて差分を作る
                    if [[ -n "${STUB_PARAM_STATE:-}" && -e "$STUB_PARAM_STATE" ]]; then
                      printf 'drive_component:\n  ros__parameters:\n    control_mode: current\n'
                    else
                      [[ -n "${STUB_PARAM_STATE:-}" ]] && : >"$STUB_PARAM_STATE"
                      printf 'drive_component:\n  ros__parameters:\n    control_mode: velocity\n'
                    fi ;;
  "bag record")     shift 2
                    while [[ $# -gt 0 && "$1" != "-o" ]]; do shift; done
                    [[ "${1:-}" == "-o" ]] && mkdir -p "$2"
                    # `&` 起動の非対話 bash は SIGINT を SIG_IGN で継承し trap できないため、
                    # record.sh の kill -INT はこのスタブには効かない（実 ros2 bag record は
                    # Python プロセスで自前ハンドラを持つのでそちらは効く）。有限時間で終わらせて
                    # cleanup の wait を解く。
                    sleep 3 ;;
  "bag info")       printf 'Files:             bag_0.mcap\nMessages:          4213\nTopic information: Topic: /drive_status | Count: 3200\n                   Topic: /target_twist | Count: 1013\n' ;;
  "interface show") if [[ "${STUB_RAW:-1}" == "1" ]]; then
                      printf 'int32 target_rpm\nfloat32 velocity_rpm\nfloat32 velocity_rpm_raw\n'
                    else
                      printf 'int32 target_rpm\nfloat32 velocity_rpm\n'
                    fi ;;
  *) exit 1 ;;
esac
exit 0
STUB
chmod +x "$STUB_DIR/ros2"

run_preflight() {  # run_preflight -> stdout+stderr、$? に終了コード
  PATH="$STUB_DIR:$PATH" bash "$SCRIPT_DIR/record.sh" --yes --out "$TMP/out" 2>&1
}

OUT="$(STUB_NODES='/rosout' STUB_TOPICS='/rosout' run_preflight)"
check "drive_component 不在なら異常終了" "$?" "1"
contains "drive_component 不在を明示" "$OUT" "/drive_component が見つかりません"

OUT="$(STUB_NODES='/drive_component' STUB_TOPICS='/drive_status' run_preflight)"
check "/target_twist 不在なら異常終了" "$?" "1"
contains "欠けた必須 topic を明示" "$OUT" "/target_twist が見えません"

OUT="$(STUB_NODES='/drive_component' STUB_TOPICS='/drive_status /target_twist' STUB_RAW=0 run_preflight)"
check "velocity_rpm_raw 契約不成立なら hard fail" "$?" "1"
contains "velocity_rpm_raw 欠落を明示" "$OUT" "velocity_rpm_raw がありません"
if [[ ! -d "$TMP/out" ]]; then ok "preflight 失敗時は出力ディレクトリを作らない"; else ng "preflight 失敗なのに出力ディレクトリができた"; fi

bash "$SCRIPT_DIR/record.sh" --help >/dev/null
check "--help は正常終了" "$?" "0"
contains "--help に出力ファイル契約" "$(bash "$SCRIPT_DIR/record.sh" --help)" "source_identity.txt"

# ---- 出力ディレクトリ契約（ros2 / step_sequence をスタブして最後まで通す）----

echo "== 出力ディレクトリ契約 =="

# step_sequence.py は rclpy が要るのでスタブに差し替える。ここで見るのは
# record.sh の証跡まわりの配線だけで、ステップ列そのものの正しさではない。
cat >"$STUB_DIR/python3" <<'PYSTUB'
#!/usr/bin/env bash
exit 0
PYSTUB
chmod +x "$STUB_DIR/python3"

FULL_OUT="$TMP/full"
OUT="$(STUB_NODES='/drive_component' \
  STUB_TOPICS='/drive_status /target_twist /odom' \
  STUB_PARAM_STATE="$TMP/param_state" \
  PATH="$STUB_DIR:$PATH" bash "$SCRIPT_DIR/record.sh" --yes --out "$FULL_OUT" 2>&1)"
check "スタブ環境で最後まで完走" "$?" "0"

DEST="$(find "$FULL_OUT" -maxdepth 1 -type d -name 'ident_*' | head -1)"
if [[ -n "$DEST" ]]; then ok "ident_<robot>_<condition>_<timestamp> を作る"; else ng "出力ディレクトリが無い"; fi

for f in meta.yaml source_identity.txt git_status.txt \
         drive_component_params_before.yaml drive_component_params_after.yaml \
         bag_info.txt bag_record.log; do
  if [[ -f "$DEST/$f" ]]; then ok "$f を残す"; else ng "$f が無い"; fi
done
if [[ -d "$DEST/bag" ]]; then ok "bag/ を残す"; else ng "bag/ が無い"; fi

contains "meta.yaml に完全 SHA" "$(cat "$DEST/meta.yaml")" "questix_commit: \"$(evidence_git_full_sha "$SCRIPT_DIR")\""
contains "meta.yaml に記録対象 topic" "$(cat "$DEST/meta.yaml")" '"/odom"'
contains "bag_info.txt を保存" "$(cat "$DEST/bag_info.txt")" "/drive_status"

if [[ -f "$DEST/parameter_diff.txt" ]]; then ok "before/after 差分を parameter_diff.txt に残す"; else ng "parameter_diff.txt が無い"; fi
contains "パラメータ変化を warning で知らせる" "$OUT" "実効パラメータが変わっています"

echo
echo "passed: $PASS, failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
