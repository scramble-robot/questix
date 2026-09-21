#!/usr/bin/env bash
# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
#
# 同定データを「メタ情報付きで 1 コマンド」記録する（design/model_based_drive_control.md Phase A）。
#
# これは Phase A システム同定用のハーネスであり、授業の通常手動操縦ロガーではない。
# /target_twist へ自動でステップ指令を publish するため、原則として車輪を浮かせ、
# 教員／開発者の管理下で実行すること。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/identify/lib_evidence.sh
. "$SCRIPT_DIR/lib_evidence.sh"

OUT_ROOT="${IDENT_OUT:-$HOME/ident_data}"
LEVELS="20,30,40,60,80,100,150,200,300,400"
HOLD="4.0"
SETTLE="3.0"
TURN=""
YES=""

NODE="/drive_component"
REQUIRED_TOPICS="/drive_status,/target_twist"
# 存在するときだけ記録に足す。無いことを失敗条件にしない。
# /joy /joy_gated は足さない: step_sequence.py が /target_twist へ直接 publish する
# 同定試験では、これらは同定入力の authority ではないため。
OPTIONAL_TOPICS="/odom,/emergency_stop"

usage() {
  cat <<'USAGE'
使い方:
  bash scripts/identify/record.sh [--out DIR] [--levels L] [--hold S] [--settle S] [--turn] [--yes]

Phase A システム同定用の記録ハーネス（授業の手動操縦ロガーではない）。

やること:
  1. preflight: drive_component / 必須 topic / control_mode / velocity_rpm_raw を確認
  2. ロボット ID / 床 / 電池電圧 / 積載 / ファーム / メモ を対話で聞いて meta.yaml に保存
  3. source identity（完全 SHA・ブランチ・dirty・ROS 環境）と実効パラメータを保存
  4. ros2 bag record を開始（必須 topic + 存在する optional topic）
  5. step_sequence.py でステップ列を publish（Ctrl-C で即 0 を publish して終了）
  6. bag を停止し、実効パラメータを再取得して before/after を突き合わせ、bag info を保存

オプション:
  --out DIR      出力先ルート（既定: $IDENT_OUT または ~/ident_data）
  --levels L     車輪 RPM のレベル（カンマ区切り）
  --hold S       各レベルの保持時間 [s]
  --settle S     レベル間の 0 保持時間 [s]
  --turn         旋回で取る（左右逆回転）
  --yes          対話をスキップして既定値を使う
  -h, --help     このヘルプ

出力: <out>/ident_<robot>_<floor>_<YYYYmmdd_HHMM>/
        meta.yaml, source_identity.txt, git_status.txt,
        drive_component_params_before.yaml, drive_component_params_after.yaml,
        parameter_diff.txt（差分があるときだけ）, bag/, bag_info.txt, bag_record.log
解析: python3 scripts/identify/batch_fit.py <out>/ident_*

安全: 車輪を浮かせるか、床の上なら教員が指定した十分広い場所で。
      非常停止が効くこと、周囲に人がいないことを確認してから実行する。
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT_ROOT="$2"; shift 2 ;;
    --levels) LEVELS="$2"; shift 2 ;;
    --hold) HOLD="$2"; shift 2 ;;
    --settle) SETTLE="$2"; shift 2 ;;
    --turn) TURN="--turn"; shift ;;
    --yes) YES="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

for cmd in ros2 python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: $cmd が見つかりません。ROS 2 環境を source してください" >&2
    exit 1
  fi
done

# ---- preflight（ここで落ちたデータは同定に使えないので hard fail）-----------

fail() { echo "error: $*" >&2; exit 1; }

echo "=== preflight ==="

TOPIC_LIST="$(mktemp)"
trap 'rm -f "$TOPIC_LIST"' EXIT
ros2 topic list >"$TOPIC_LIST" 2>/dev/null || true

if ! ros2 node list 2>/dev/null | grep -qxF "$NODE"; then
  fail "$NODE が見つかりません。drive_component を起動してから実行してください"
fi
echo "  node $NODE: OK"

IFS=',' read -r -a REQ_ARR <<<"$REQUIRED_TOPICS"
for t in "${REQ_ARR[@]}"; do
  grep -qxF "$t" "$TOPIC_LIST" || fail "$t が見えません。drive_component の起動と ROS_DOMAIN_ID を確認してください"
  echo "  topic $t: OK"
done

CONTROL_MODE="$(ros2 param get "$NODE" control_mode 2>/dev/null | awk '{print $NF}' || true)"
[[ -n "$CONTROL_MODE" ]] || fail "$NODE の control_mode パラメータを取得できません"
echo "  control_mode: $CONTROL_MODE"

# Phase A は LPF 前の生 RPM で同定する。velocity_rpm_raw が無い msg 定義で記録すると
# LPF 後 RPM しか残らず τ・むだ時間の意味が変わるため、記録前に止める（fit_models.py と同じ契約）。
MOTOR_FEEDBACK_DEF="$(ros2 interface show questix_msgs/msg/MotorFeedback 2>/dev/null || true)"
if [[ -z "$MOTOR_FEEDBACK_DEF" ]]; then
  fail "questix_msgs/msg/MotorFeedback の定義を取得できません。
       questix_msgs を含むワークスペースを source してから実行してください"
fi
if ! grep -q '\bvelocity_rpm_raw\b' <<<"$MOTOR_FEEDBACK_DEF"; then
  fail "questix_msgs/msg/MotorFeedback に velocity_rpm_raw がありません。
       LPF 後 RPM では τ・むだ時間の意味が変わるため記録しません。velocity_rpm_raw を含む
       questix_msgs をビルドして source し直してください（PR #144 以降）"
fi
echo "  questix_msgs/MotorFeedback.velocity_rpm_raw: OK"

mapfile -t RECORD_TOPICS < <(evidence_select_topics "$REQUIRED_TOPICS" "$OPTIONAL_TOPICS" "$TOPIC_LIST")
echo "  記録対象: ${RECORD_TOPICS[*]}"

# ---- メタ情報 ---------------------------------------------------------------

ask() {  # ask VAR "prompt" "default"
  local var="$1" prompt="$2" default="${3:-}" value
  if [[ -n "$YES" ]]; then
    printf -v "$var" '%s' "$default"
    return
  fi
  read -r -p "$prompt [${default}]: " value
  printf -v "$var" '%s' "${value:-$default}"
}

echo
echo "=== QUESTiX 同定データ記録 ==="
echo "安全確認: (1) 車輪を浮かせた or 教員が指定した十分広い場所  (2) 非常停止が効く  (3) 周囲に人がいない"
if [[ -z "$YES" ]]; then
  read -r -p "上記を確認したら Enter（中止は Ctrl-C）: " _
fi

ask ROBOT_ID   "ロボット ID（例 questix-03）" "${HOSTNAME}"
ask FLOOR      "床（lifted=浮かせ / tile / carpet / wood / asphalt / other）" "lifted"
ask BATTERY_V  "電池電圧 [V]（不明なら空欄）" ""
ask PAYLOAD_KG "積載 [kg]" "0"
ask FIRMWARE   "モータファームバージョン（不明なら空欄）" ""
ask NOTES      "メモ（任意）" ""

STAMP="$(date +%Y%m%d_%H%M)"
# ディレクトリ名に使える文字だけ残す。`tr -c 'A-Za-z0-9_-\n'` は '_'..'\n' を逆順レンジと
# 解釈して tr がエラー終了し、set -e で記録前に落ちるため bash の置換を使う。
SAFE_ROBOT="${ROBOT_ID//[^A-Za-z0-9_-]/_}"
SAFE_FLOOR="${FLOOR//[^A-Za-z0-9_-]/_}"
SAFE_ROBOT="${SAFE_ROBOT:-unknown}"
SAFE_FLOOR="${SAFE_FLOOR:-unknown}"
DEST="$OUT_ROOT/ident_${SAFE_ROBOT}_${SAFE_FLOOR}_${STAMP}"
mkdir -p "$DEST"

# ---- source identity --------------------------------------------------------

evidence_source_identity "$SCRIPT_DIR" >"$DEST/source_identity.txt"
evidence_git_status_body "$SCRIPT_DIR" >"$DEST/git_status.txt"

GIT_SHA="$(evidence_git_full_sha "$SCRIPT_DIR")"
GIT_BRANCH="$(evidence_git_branch "$SCRIPT_DIR")"
GIT_DETACHED="$(evidence_git_detached "$SCRIPT_DIR")"
GIT_WORKTREE="$(evidence_git_dirty "$SCRIPT_DIR")"

if [[ "$GIT_WORKTREE" == "dirty" ]]; then
  echo "warning: 作業ツリーが dirty です。この bag は commit $GIT_SHA だけでは再現できません" >&2
  echo "         変更一覧: $DEST/git_status.txt" >&2
fi

cat > "$DEST/meta.yaml" <<META
# scripts/identify/record.sh が生成
robot_id: "${ROBOT_ID}"
floor: "${FLOOR}"
battery_voltage: ${BATTERY_V:-null}
payload_kg: ${PAYLOAD_KG}
firmware: "${FIRMWARE}"
control_mode: "${CONTROL_MODE}"
date: "$(date -Iseconds)"
questix_commit: "${GIT_SHA}"
questix_branch: "${GIT_BRANCH}"
questix_detached_head: ${GIT_DETACHED}
questix_worktree: "${GIT_WORKTREE}"
hostname: "$(hostname 2>/dev/null || echo unknown)"
ros_distro: "${ROS_DISTRO:-unset}"
ros_domain_id: "${ROS_DOMAIN_ID:-unset}"
rmw_implementation: "${RMW_IMPLEMENTATION:-unset}"
pattern: "${TURN:-straight}"
levels_rpm: [${LEVELS}]
hold_sec: ${HOLD}
settle_sec: ${SETTLE}
recorded_topics: [$(printf '"%s", ' "${RECORD_TOPICS[@]}" | sed 's/, $//')]
notes: "${NOTES}"
# 詳細: source_identity.txt / git_status.txt / drive_component_params_*.yaml / bag_info.txt
META

# ---- 実効パラメータ snapshot（記録直前）------------------------------------

PARAM_BEFORE="$DEST/drive_component_params_before.yaml"
PARAM_AFTER="$DEST/drive_component_params_after.yaml"
if ! ros2 param dump "$NODE" >"$PARAM_BEFORE" 2>/dev/null; then
  echo "warning: $NODE の param dump に失敗しました（実効パラメータの証跡なし）" >&2
fi

# ---- 記録 -------------------------------------------------------------------

BAG_PID=""
cleanup() {
  if [[ -n "$BAG_PID" ]] && kill -0 "$BAG_PID" 2>/dev/null; then
    kill -INT "$BAG_PID" 2>/dev/null || true
    wait "$BAG_PID" 2>/dev/null || true
  fi
}
trap 'cleanup; rm -f "$TOPIC_LIST"' EXIT INT TERM

echo "recording -> $DEST/bag"
ros2 bag record -o "$DEST/bag" "${RECORD_TOPICS[@]}" >"$DEST/bag_record.log" 2>&1 &
BAG_PID=$!
sleep 2

python3 "$SCRIPT_DIR/step_sequence.py" --levels "$LEVELS" --hold "$HOLD" --settle "$SETTLE" --sign both $TURN

cleanup
BAG_PID=""

# ---- 記録後の証跡 -----------------------------------------------------------

if ! ros2 param dump "$NODE" >"$PARAM_AFTER" 2>/dev/null; then
  echo "warning: 記録後の param dump に失敗しました（before/after 比較なし）" >&2
fi

PARAM_DIFF="$DEST/parameter_diff.txt"
set +e
evidence_param_diff "$PARAM_BEFORE" "$PARAM_AFTER" "$PARAM_DIFF"
DIFF_RC=$?
set -e
case "$DIFF_RC" in
  0) echo "parameters: 記録中の変更なし" ;;
  1) echo "warning: 記録の前後で $NODE の実効パラメータが変わっています。" >&2
     echo "         Phase A 同定はパラメータ固定が前提です。この bag の証跡品質を落とします。" >&2
     echo "         差分: $PARAM_DIFF" >&2 ;;
  *) echo "warning: 実効パラメータの before/after を比較できませんでした" >&2 ;;
esac

BAG_INFO="$DEST/bag_info.txt"
if ! ros2 bag info "$DEST/bag" >"$BAG_INFO" 2>&1; then
  echo "warning: ros2 bag info に失敗しました（$BAG_INFO を確認してください）" >&2
fi
set +e
BAG_WARN="$(evidence_bag_info_warnings "$BAG_INFO" "$REQUIRED_TOPICS")"
BAG_RC=$?
set -e
if [[ "$BAG_RC" -ne 0 ]]; then
  echo "warning: bag の内容に問題がある可能性があります:" >&2
  echo "$BAG_WARN" | sed 's/^/         /' >&2
fi

echo
echo "done: $DEST"
echo "  meta     : $DEST/meta.yaml"
echo "  source   : $DEST/source_identity.txt (commit $GIT_SHA, $GIT_WORKTREE)"
echo "  params   : $(basename "$PARAM_BEFORE") / $(basename "$PARAM_AFTER")"
echo "  bag      : $DEST/bag"
echo "  bag info : $BAG_INFO"
echo "解析: python3 $SCRIPT_DIR/batch_fit.py $DEST"
