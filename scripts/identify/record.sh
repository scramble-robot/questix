#!/usr/bin/env bash
# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
#
# 同定データを「メタ情報付きで 1 コマンド」記録する（design/model_based_drive_control.md Phase A）。
#
#   bash scripts/identify/record.sh [--out DIR] [--levels L] [--hold S] [--settle S] [--turn] [--yes]
#
# やること:
#   1. ロボット ID / 床 / 電池電圧 / 積載 / ファーム / メモ を対話で聞いて meta.yaml に保存
#   2. ros2 bag record /drive_status /target_twist を開始
#   3. step_sequence.py でステップ列を publish（Ctrl-C で即 0 を publish して終了）
#   4. bag を停止し、出力ディレクトリを表示
#
# 出力: <out>/ident_<robot>_<floor>_<YYYYmmdd_HHMM>/{meta.yaml, bag/}
# 解析: python3 scripts/identify/batch_fit.py <out>/ident_*
#
# 安全: 車輪を浮かせるか、床の上なら広い場所で。非常停止が効くことを確認してから実行する。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_ROOT="${IDENT_OUT:-$HOME/ident_data}"
LEVELS="20,30,40,60,80,100,150,200,300,400"
HOLD="4.0"
SETTLE="3.0"
TURN=""
YES=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT_ROOT="$2"; shift 2 ;;
    --levels) LEVELS="$2"; shift 2 ;;
    --hold) HOLD="$2"; shift 2 ;;
    --settle) SETTLE="$2"; shift 2 ;;
    --turn) TURN="--turn"; shift ;;
    --yes) YES="1"; shift ;;
    -h|--help) sed -n '8,22p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

for cmd in ros2 python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: $cmd が見つかりません。ROS 2 環境を source してください" >&2
    exit 1
  fi
done

ask() {  # ask VAR "prompt" "default"
  local var="$1" prompt="$2" default="${3:-}" value
  if [[ -n "$YES" ]]; then
    printf -v "$var" '%s' "$default"
    return
  fi
  read -r -p "$prompt [${default}]: " value
  printf -v "$var" '%s' "${value:-$default}"
}

echo "=== QUESTiX 同定データ記録 ==="
echo "安全確認: (1) 車輪を浮かせた or 広い場所  (2) 非常停止が効く  (3) 周囲に人がいない"
if [[ -z "$YES" ]]; then
  read -r -p "上記を確認したら Enter（中止は Ctrl-C）: " _
fi

ask ROBOT_ID   "ロボット ID（例 questix-03）" "${HOSTNAME}"
ask FLOOR      "床（lifted=浮かせ / tile / carpet / wood / asphalt / other）" "lifted"
ask BATTERY_V  "電池電圧 [V]（不明なら空欄）" ""
ask PAYLOAD_KG "積載 [kg]" "0"
ask FIRMWARE   "モータファームバージョン（不明なら空欄）" ""
ask NOTES      "メモ（任意）" ""

CONTROL_MODE="$(ros2 param get /drive_component control_mode 2>/dev/null | awk '{print $NF}' || true)"
CONTROL_MODE="${CONTROL_MODE:-unknown}"
GIT_REV="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
STAMP="$(date +%Y%m%d_%H%M)"
SAFE_ROBOT="$(echo "$ROBOT_ID" | tr -c 'A-Za-z0-9_-\n' '_')"
SAFE_FLOOR="$(echo "$FLOOR" | tr -c 'A-Za-z0-9_-\n' '_')"
DEST="$OUT_ROOT/ident_${SAFE_ROBOT}_${SAFE_FLOOR}_${STAMP}"
mkdir -p "$DEST"

cat > "$DEST/meta.yaml" <<META
# scripts/identify/record.sh が生成
robot_id: "${ROBOT_ID}"
floor: "${FLOOR}"
battery_voltage: ${BATTERY_V:-null}
payload_kg: ${PAYLOAD_KG}
firmware: "${FIRMWARE}"
control_mode: "${CONTROL_MODE}"
date: "$(date -Iseconds)"
questix_commit: "${GIT_REV}"
pattern: "${TURN:-straight}"
levels_rpm: [${LEVELS}]
hold_sec: ${HOLD}
settle_sec: ${SETTLE}
notes: "${NOTES}"
META

if ! ros2 topic list 2>/dev/null | grep -q '^/drive_status$'; then
  echo "warning: /drive_status が見えません。drive_component が active か確認してください" >&2
fi

BAG_PID=""
cleanup() {
  if [[ -n "$BAG_PID" ]] && kill -0 "$BAG_PID" 2>/dev/null; then
    kill -INT "$BAG_PID" 2>/dev/null || true
    wait "$BAG_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "recording -> $DEST/bag"
ros2 bag record -o "$DEST/bag" /drive_status /target_twist >"$DEST/bag_record.log" 2>&1 &
BAG_PID=$!
sleep 2

python3 "$SCRIPT_DIR/step_sequence.py" --levels "$LEVELS" --hold "$HOLD" --settle "$SETTLE" --sign both $TURN

cleanup
BAG_PID=""
echo
echo "done: $DEST"
echo "  meta : $DEST/meta.yaml"
echo "  bag  : $DEST/bag"
echo "解析: python3 $SCRIPT_DIR/batch_fit.py $DEST"
