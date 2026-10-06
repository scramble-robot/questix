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
LEVELS="20,30,40,60,80,100,150,200,300"  # M6 規格書の ±330 rpm に収める（README）
HOLD="4.0"
SETTLE="3.0"
TURN=""
YES=""
SCHEDULE=""
LEAD_IN_RPM="0"
LEAD_IN_SEC="0"
PATTERN=""
SIGN="both"
# 試験の間だけ変える drive_component のパラメータ（NAME=VALUE）。終了時に元の値へ戻す。
SET_PARAMS=()
# --set-param で変えてよいパラメータ（実行時変更でき、試験のために変える必要があるものだけ）
ALLOWED_SET_PARAMS="min_command_rpm stop_resend_interval_ms"

NODE="/drive_component"
# preflight で /target_twist に他の送り手が流していないか聞く時間 [s]
LISTEN_SEC="${IDENT_LISTEN_SEC:-2}"
REQUIRED_TOPICS="/drive_status,/target_twist"
# 存在するときだけ記録に足す。無いことを失敗条件にしない。
# /joy /joy_gated は足さない: step_sequence.py が /target_twist へ直接 publish する
# 同定試験では、これらは同定入力の authority ではないため。
# /drive_control_sample: drive_component の制御 tick ごとの診断サンプル（seq で欠落、feedback_new で
# 重複を判別できる。ripple_analysis.py が優先して使う）。publish_control_sample=false なら無い。
OPTIONAL_TOPICS="/odom,/emergency_stop,/drive_control_sample"

usage() {
  cat <<'USAGE'
使い方:
  bash scripts/identify/record.sh [--out DIR] [--levels L] [--hold S] [--schedule R:S,...]
       [--settle S] [--sign pos|neg|both] [--turn | --pattern P]
       [--lead-in-rpm R --lead-in-sec S] [--set-param NAME=VALUE ...] [--yes]

Phase A システム同定用の記録ハーネス（授業の手動操縦ロガーではない）。

やること:
  1. preflight: drive_component / 必須 topic / /target_twist に他の送り手が流していないか /
     control_mode / velocity_rpm_raw を確認
  2. ロボット ID / 床 / 電池電圧 / 積載 / ファーム / メモ を対話で聞いて meta.yaml に保存
  3. source identity（完全 SHA・ブランチ・dirty・ROS 環境）と実効パラメータを保存
  4. ros2 bag record を開始（必須 topic + 存在する optional topic）
  5. step_sequence.py でステップ列を publish（終われば自動で 6 へ進む。Ctrl-C は途中で
     止めたいときだけ: 0 を publish して終了し、meta.yaml に step_sequence: interrupted と残す。
     他の送り手の指令を受けたら中断し、aborted_foreign_publisher と残して終了コード 3。
     非常停止の押下で中断・拒否したら aborted_emergency_stop と終了コード 4、開始前に
     /emergency_stop を受信できなければ refused_estop_not_received と終了コード 6）
  6. bag を停止し、実効パラメータを再取得して before/after を突き合わせ、bag info を保存

オプション:
  --out DIR      出力先ルート（既定: $IDENT_OUT または ~/ident_data）
  --levels L     車輪 RPM のレベル（カンマ区切り）
  --hold S       各レベルの保持時間 [s]
  --schedule R:S,...  レベルごとの保持時間（例 3:60,5:60,10:30）。--levels/--hold より優先
  --settle S     レベル間の 0 保持時間 [s]
  --sign X       pos（正転のみ）/ neg（逆転のみ）/ both（既定）
  --turn         旋回で取る（左右逆回転。--pattern spin と同じ）
  --pattern P    straight / spin / pivot-left / pivot-right（左・右の車輪を止め、もう片方だけを
                 回す信地旋回。床の上で負荷をかける試験。レベルは回す輪の RPM）
  --lead-in-rpm R / --lead-in-sec S
                 R より遅いレベルの前に同じ向きで R を S 秒送り、0 を通らずにレベルへ移る
                 （止まった状態からの動き出しには min_command_rpm + 2 rpm 以上が要るため）
                 レベル（助走を含む）が max_motor_rpm（と仕様上限 475）を超えるステップ列は、
                 切り詰められて同定の入力が変わるため、記録の前に拒否する
  --set-param NAME=VALUE
                 記録の間だけ drive_component のパラメータを変える（繰り返し可）。変えてよいのは
                 min_command_rpm と stop_resend_interval_ms だけ。変える前の値を記録し、終了時
                 （Ctrl-C・失敗を含む）に元へ戻して確認する。params_before/after は変えた後の値
  --yes          対話をスキップして既定値を使う
  -h, --help     このヘルプ

環境変数: IDENT_LISTEN_SEC             preflight で /target_twist を聞く時間 [s]（既定 2）
          IDENT_BAG_STOP_TIMEOUT_SEC  bag を SIGINT で閉じるまで待つ上限 [s]（既定 15。超えたら SIGTERM）

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
    --schedule) SCHEDULE="$2"; shift 2 ;;
    --sign) SIGN="$2"; shift 2 ;;
    --pattern) PATTERN="$2"; shift 2 ;;
    --lead-in-rpm) LEAD_IN_RPM="$2"; shift 2 ;;
    --lead-in-sec) LEAD_IN_SEC="$2"; shift 2 ;;
    --set-param) SET_PARAMS+=("$2"); shift 2 ;;
    --yes) YES="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$SIGN" in pos|neg|both) ;; *) echo "error: --sign は pos / neg / both" >&2; exit 2 ;; esac
if [[ -n "$PATTERN" && -n "$TURN" && "$PATTERN" != "spin" ]]; then
  echo "error: --turn と --pattern は同時に指定できません" >&2
  exit 2
fi
for kv in "${SET_PARAMS[@]}"; do
  name="${kv%%=*}"
  value="${kv#*=}"
  if [[ "$kv" != *=* || -z "$name" || -z "$value" ]]; then
    echo "error: --set-param は NAME=VALUE の形にしてください: $kv" >&2
    exit 2
  fi
  if [[ " $ALLOWED_SET_PARAMS " != *" $name "* ]]; then
    echo "error: --set-param で変えられるのは $ALLOWED_SET_PARAMS だけです: $name" >&2
    exit 2
  fi
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    echo "error: --set-param の値は 0 以上の整数にしてください: $kv" >&2
    exit 2
  fi
done

PATTERN_EFFECTIVE="${PATTERN:-straight}"
[[ -n "$TURN" ]] && PATTERN_EFFECTIVE="spin"

if ! env --default-signal=INT true 2>/dev/null; then
  echo "error: env --default-signal が使えません（coreutils 8.31 以降が必要。Ubuntu 24.04 は対応）" >&2
  exit 1
fi

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

# /target_twist には通常 twist_arbiter（練習）/ joy_controller（競技）も publish する。
# コントローラ接続中は /joy のたびに流れ、ステップ入力に混ざって同定データが汚れる
# （スティック優先の仕組みも素通りする）。publisher の有無ではなく実際の流れで判定する
# （twist_arbiter は publisher を常に持つが、入力が無ければ何も流さない）。
# step_sequence.py も開始前と実行中に同じ検査をする。ここは対話の前に止めるための早期検査。
set +e
LISTEN_ERR="$(timeout "$LISTEN_SEC" ros2 topic echo --once /target_twist geometry_msgs/msg/Twist 2>&1 >/dev/null)"
LISTEN_RC=$?
set -e
case "$LISTEN_RC" in
  0) fail "/target_twist に他の送り手から指令が流れています（コントローラ接続中など）。
       コントローラを外すか joy を止め、/target_twist に他から流れない状態で実行してください
       （送り手は ros2 topic info -v /target_twist で確認できます）" ;;
  124) echo "  /target_twist: 他の送り手からの流れなし（${LISTEN_SEC}s 待機）" ;;
  *) fail "/target_twist を聞く ros2 topic echo が失敗しました（終了コード $LISTEN_RC）: ${LISTEN_ERR}" ;;
esac

CONTROL_MODE="$(ros2 param get "$NODE" control_mode 2>/dev/null | awk '{print $NF}' || true)"
[[ -n "$CONTROL_MODE" ]] || fail "$NODE の control_mode パラメータを取得できません"
echo "  control_mode: $CONTROL_MODE"

# 車輪 RPM -> twist の換算は drive_component と同じ寸法で行う（信地旋回で片輪を 0 にするため）
WHEEL_RADIUS="$(ros2 param get "$NODE" wheel_radius 2>/dev/null | awk '{print $NF}' || true)"
WHEEL_SEPARATION="$(ros2 param get "$NODE" wheel_separation 2>/dev/null | awk '{print $NF}' || true)"
[[ -n "$WHEEL_RADIUS" && -n "$WHEEL_SEPARATION" ]] \
  || fail "$NODE の wheel_radius / wheel_separation を取得できません"
echo "  wheel_radius: $WHEEL_RADIUS m, wheel_separation: $WHEEL_SEPARATION m"

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

# 指定したレベルが停止判定（min_command_rpm）で止められないかを、対話・記録の前に確かめる。
# --set-param min_command_rpm=N を指定したときはその値で判定する。
GATE_MIN="$(ros2 param get "$NODE" min_command_rpm 2>/dev/null | awk '{print $NF}' || true)"
for kv in "${SET_PARAMS[@]}"; do
  [[ "${kv%%=*}" == "min_command_rpm" ]] && GATE_MIN="${kv#*=}"
done
if [[ -n "$GATE_MIN" ]]; then
  GATE_ARGS=(--levels "$LEVELS" --hold "$HOLD" --settle "$SETTLE" --sign "$SIGN"
             --pattern "$PATTERN_EFFECTIVE" --lead-in-rpm "$LEAD_IN_RPM" --lead-in-sec "$LEAD_IN_SEC"
             --min-command-rpm "$GATE_MIN" --dry-run)
  [[ -n "$SCHEDULE" ]] && GATE_ARGS+=(--schedule "$SCHEDULE")
  python3 "$SCRIPT_DIR/step_sequence.py" "${GATE_ARGS[@]}" >/dev/null \
    || fail "ステップ列が min_command_rpm=${GATE_MIN} の停止判定に掛かります（上の理由を参照）"
  echo "  停止判定（min_command_rpm=${GATE_MIN}）: 全レベルが指令どおりに回る"
fi

# 指定したレベルが max_motor_rpm（と仕様上限 475）で切り詰められないかを確かめる。切り詰められた
# ステップは、同定の入力が指定と変わる。
MAX_MOTOR_RPM="$(ros2 param get "$NODE" max_motor_rpm 2>/dev/null | awk '{print $NF}' || true)"
[[ -n "$MAX_MOTOR_RPM" ]] || fail "$NODE の max_motor_rpm を取得できません"
MAX_ARGS=(--levels "$LEVELS" --hold "$HOLD" --settle "$SETTLE" --sign "$SIGN"
          --pattern "$PATTERN_EFFECTIVE" --lead-in-rpm "$LEAD_IN_RPM" --lead-in-sec "$LEAD_IN_SEC"
          --max-command-rpm "$MAX_MOTOR_RPM" --dry-run)
[[ -n "$SCHEDULE" ]] && MAX_ARGS+=(--schedule "$SCHEDULE")
python3 "$SCRIPT_DIR/step_sequence.py" "${MAX_ARGS[@]}" >/dev/null \
  || fail "ステップ列が max_motor_rpm=${MAX_MOTOR_RPM} で切り詰められます（上の理由を参照）"
echo "  上限（max_motor_rpm=${MAX_MOTOR_RPM}）: 全レベルが上限以下"

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
pattern: "${PATTERN_EFFECTIVE}"
levels_rpm: [${LEVELS}]
hold_sec: ${HOLD}
schedule: "${SCHEDULE}"
sign: "${SIGN}"
lead_in_rpm: ${LEAD_IN_RPM}
lead_in_sec: ${LEAD_IN_SEC}
wheel_radius: ${WHEEL_RADIUS}
wheel_separation: ${WHEEL_SEPARATION}
settle_sec: ${SETTLE}
recorded_topics: [$(printf '"%s", ' "${RECORD_TOPICS[@]}" | sed 's/, $//')]
notes: "${NOTES}"
# 詳細: source_identity.txt / git_status.txt / drive_component_params_*.yaml / bag_info.txt
META

# ---- 試験の間だけのパラメータ変更（--set-param）----------------------------

# 変える前の値（NAME=VALUE）。終了時（成功・失敗・Ctrl-C）に restore_params で戻す。
ORIGINAL_PARAMS=()
# 元の値に戻せなかったものがあれば 1。終了コードを EXIT_RESTORE_FAILED にし、meta.yaml に残す。
RESTORE_FAILED=0
EXIT_RESTORE_FAILED=5
param_value() {  # param_value NAME -> 実効値（取得できなければ空）
  ros2 param get "$NODE" "$1" 2>/dev/null | awk '{print $NF}' || true
}
restore_params() {
  local kv name value now
  for kv in "${ORIGINAL_PARAMS[@]}"; do
    name="${kv%%=*}"
    value="${kv#*=}"
    if ros2 param set "$NODE" "$name" "$value" >/dev/null 2>&1; then
      now="$(param_value "$name")"
      if [[ "$now" == "$value" ]]; then
        echo "parameter restored: $name = $value"
        echo "param_restored_${name}: ${value}" >>"$DEST/meta.yaml"
        continue
      fi
    fi
    RESTORE_FAILED=1
    echo "error: $NODE の $name を元の値 $value に戻せませんでした。手で戻してください:" >&2
    echo "       ros2 param set $NODE $name $value" >&2
    echo "param_restore_failed_${name}: ${value}" >>"$DEST/meta.yaml"
  done
  ORIGINAL_PARAMS=()
}
# 終了時（成功・失敗・Ctrl-C）の後片付け。戻せないパラメータがあれば終了コードを上書きする。
on_exit() {
  local rc=$?
  if declare -F cleanup >/dev/null; then cleanup; fi
  restore_params
  rm -f "$TOPIC_LIST"
  if [[ "$RESTORE_FAILED" == 1 ]]; then
    echo "error: 元に戻せなかったパラメータがあります（終了コード $EXIT_RESTORE_FAILED）" >&2
    exit "$EXIT_RESTORE_FAILED"
  fi
  exit "$rc"
}
# 途中で失敗しても、それまでに変えたものは戻す
trap on_exit EXIT
for kv in "${SET_PARAMS[@]}"; do
  name="${kv%%=*}"
  value="${kv#*=}"
  original="$(param_value "$name")"
  [[ -n "$original" ]] || fail "$NODE の $name を取得できません（変更しません）"
  ORIGINAL_PARAMS+=("$name=$original")
  ros2 param set "$NODE" "$name" "$value" >/dev/null 2>&1 \
    || fail "$NODE の $name を $value に設定できませんでした（変えたものは戻します）"
  now="$(param_value "$name")"
  [[ "$now" == "$value" ]] \
    || fail "$NODE の $name を $value に設定したのに、読み戻した値が '$now' です（変えたものは戻します）"
  echo "parameter set for this recording: $name = $value (was $original)"
  echo "param_override_${name}: {value: ${value}, original: ${original}}" >>"$DEST/meta.yaml"
done

# ---- 実効パラメータ snapshot（記録直前）------------------------------------

PARAM_BEFORE="$DEST/drive_component_params_before.yaml"
PARAM_AFTER="$DEST/drive_component_params_after.yaml"
if ! ros2 param dump "$NODE" >"$PARAM_BEFORE" 2>/dev/null; then
  echo "warning: $NODE の param dump に失敗しました（実効パラメータの証跡なし）" >&2
fi

# ---- 記録 -------------------------------------------------------------------

BAG_PID=""
# SIGINT で bag を閉じるまで待つ上限 [s]。超えたら SIGTERM -> SIGKILL（無限に待たない）。
BAG_STOP_TIMEOUT_SEC="${IDENT_BAG_STOP_TIMEOUT_SEC:-15}"
cleanup() {
  local waited=0 limit=$((BAG_STOP_TIMEOUT_SEC * 10))
  if [[ -z "$BAG_PID" ]]; then
    return 0
  fi
  if kill -0 "$BAG_PID" 2>/dev/null; then
    kill -INT "$BAG_PID" 2>/dev/null || true
    while kill -0 "$BAG_PID" 2>/dev/null && [[ "$waited" -lt "$limit" ]]; do
      sleep 0.1
      waited=$((waited + 1))
    done
    if kill -0 "$BAG_PID" 2>/dev/null; then
      echo "warning: ros2 bag record が SIGINT で ${BAG_STOP_TIMEOUT_SEC}s 以内に止まりません。" >&2
      echo "         SIGTERM で止めます（bag の末尾が欠ける可能性があります）" >&2
      kill -TERM "$BAG_PID" 2>/dev/null || true
      waited=0
      while kill -0 "$BAG_PID" 2>/dev/null && [[ "$waited" -lt 50 ]]; do
        sleep 0.1
        waited=$((waited + 1))
      done
      kill -KILL "$BAG_PID" 2>/dev/null || true
    fi
  fi
  wait "$BAG_PID" 2>/dev/null || true
  BAG_PID=""
}
trap on_exit EXIT
trap 'cleanup; restore_params' INT TERM

echo "recording -> $DEST/bag"
# 非対話シェルの `&` 起動は SIGINT を無視（SIG_IGN）で継承し、ros2（Python）は SIGINT の
# ハンドラを入れないため、cleanup の kill -INT が効かず bag が閉じない。env で既定に戻して起動する。
env --default-signal=INT ros2 bag record -o "$DEST/bag" "${RECORD_TOPICS[@]}" >"$DEST/bag_record.log" 2>&1 &
BAG_PID=$!
sleep 2

set +e
STEP_ARGS=(--levels "$LEVELS" --hold "$HOLD" --settle "$SETTLE" --sign "$SIGN"
           --pattern "$PATTERN_EFFECTIVE" --wheel-radius "$WHEEL_RADIUS"
           --wheel-separation "$WHEEL_SEPARATION"
           --lead-in-rpm "$LEAD_IN_RPM" --lead-in-sec "$LEAD_IN_SEC")
[[ -n "$SCHEDULE" ]] && STEP_ARGS+=(--schedule "$SCHEDULE")
MIN_COMMAND_RPM="$(ros2 param get "$NODE" min_command_rpm 2>/dev/null | awk '{print $NF}' || true)"
[[ -n "$MIN_COMMAND_RPM" ]] && STEP_ARGS+=(--min-command-rpm "$MIN_COMMAND_RPM")
STEP_ARGS+=(--max-command-rpm "$MAX_MOTOR_RPM")
python3 "$SCRIPT_DIR/step_sequence.py" "${STEP_ARGS[@]}"
STEP_RC=$?
set -e

cleanup

# ステップ列の完走可否を meta.yaml に残す。completed 以外は batch_fit.py が同定から外す。
case "$STEP_RC" in
  0) STEP_STATUS="completed" ;;
  3) STEP_STATUS="aborted_foreign_publisher" ;;
  4) STEP_STATUS="aborted_emergency_stop" ;;
  6) STEP_STATUS="refused_estop_not_received" ;;
  130) STEP_STATUS="interrupted" ;;
  *) STEP_STATUS="failed_rc_${STEP_RC}" ;;
esac
echo "step_sequence: \"${STEP_STATUS}\"" >>"$DEST/meta.yaml"

# ---- 記録後の証跡 -----------------------------------------------------------

if ! ros2 param dump "$NODE" >"$PARAM_AFTER" 2>/dev/null; then
  echo "warning: 記録後の param dump に失敗しました（before/after 比較なし）" >&2
fi

# 記録後の値を残してから、試験の間だけ変えたパラメータを元に戻す
restore_params
if [[ "$RESTORE_FAILED" == 1 ]]; then
  echo "param_restore: failed" >>"$DEST/meta.yaml"
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

if [[ "$STEP_RC" -ne 0 ]]; then
  echo >&2
  echo "warning: ステップ列が完走していません（step_sequence: ${STEP_STATUS}）。" >&2
  echo "         このデータは同定に使えません（batch_fit.py は除外します）。証跡として残します。" >&2
  exit "$STEP_RC"
fi
