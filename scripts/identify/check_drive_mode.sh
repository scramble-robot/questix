#!/usr/bin/env bash
# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
#
# DDT モータが実際にどの制御モードで動いているかを確かめる（読み取りのみ）。
#
# drive_component の control_mode と、/drive_status に載る各輪の応答フレームの mode
# （1 = 電流ループ、2 = 速度ループ）を突き合わせる。モータを動かす指令は何も送らない。
# 判定は scripts/identify/drive_mode_check.py。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="/drive_component"
TOPIC="/drive_status"
DURATION="3.0"
AFTER_SEC="6.0"
ESTOP_CYCLE=""

usage() {
  cat <<'USAGE'
使い方:
  bash scripts/identify/check_drive_mode.sh [--duration S] [--estop-cycle] [--after-sec S]

DDT モータの応答フレームの mode が drive_component の control_mode と一致するかを確かめる。
/drive_status を聞くだけで、モータを動かす指令は送らない（車輪を浮かせる必要はない）。

オプション:
  --duration S    /drive_status を聞く時間 [s]（既定 3）
  --estop-cycle   続けて非常停止の押下・解除をはさみ、解除の後の mode も確かめる（対話）。
                  非常停止で DDT の電源が切れる機体（ID13 など）で、電源投入時のモードに
                  戻っていないかを見る
  --after-sec S   非常停止を解除した後に聞く時間 [s]（既定 6。DDT の起動に 1.3〜1.6 s）
  -h, --help      このヘルプ

前提: drive_component が active（統合起動中）で、非常停止は解除されていること。

終了コード: 0 = 一致 / 1 = 不一致（または解除の後に mode が変わった）/ 2 = 判定できない /
            3 = 実行環境の不足（ros2 が無い、drive_component が見えない など）

電流モードへの切替が効くかの確認（任意。車輪を浮かせ、非常停止に手を添えて行う）:
  1. launcher/config/drive_component.yaml の control_mode を "current" にして
     drive_component を起動し直す（control_mode は実行時に変更できない）
  2. このスクリプトを実行する。mode が 速度ループ のままなら切替フレームが効いていない。
     その状態では電流指令の生値が速度指令として解釈されるので、すぐに 3. へ
  3. control_mode を "velocity" に戻して起動し直す
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --duration) DURATION="$2"; shift 2 ;;
    --estop-cycle) ESTOP_CYCLE="--estop-cycle"; shift ;;
    --after-sec) AFTER_SEC="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 3 ;;
  esac
done

fail() { echo "error: $*" >&2; exit 3; }

for cmd in ros2 python3; do
  command -v "$cmd" >/dev/null 2>&1 || fail "$cmd が見つかりません。ROS 2 環境を source してください"
done
python3 -c 'import rclpy, questix_msgs.msg' 2>/dev/null \
  || fail "rclpy または questix_msgs を import できません。QUESTiX のワークスペースを source してください"

echo "=== preflight ==="
ros2 node list 2>/dev/null | grep -qxF "$NODE" \
  || fail "$NODE が見つかりません。drive_component の起動と ROS_DOMAIN_ID を確認してください"
echo "  node $NODE: OK"

ros2 topic list 2>/dev/null | grep -qxF "$TOPIC" \
  || fail "$TOPIC が見えません。drive_component の起動と ROS_DOMAIN_ID を確認してください"
echo "  topic $TOPIC: OK"

# lifecycle が active でないとフィードバックが来ない（判定不能になる）。止めずに知らせるだけ。
STATE="$(ros2 lifecycle get "$NODE" 2>/dev/null | awk '{print $1}' || true)"
if [[ -n "$STATE" && "$STATE" != "active" ]]; then
  echo "  注意: $NODE は $STATE です（active でないと新しいフィードバックが来ません）"
else
  echo "  lifecycle: ${STATE:-unknown}"
fi

param() {  # param NAME -> 値（"String value is: velocity" の最後の語）
  ros2 param get "$NODE" "$1" 2>/dev/null | awk '{print $NF}' || true
}
CONTROL_MODE="$(param control_mode)"
LEFT_ID="$(param left_motor_id)"
RIGHT_ID="$(param right_motor_id)"
[[ -n "$CONTROL_MODE" ]] || fail "$NODE の control_mode を取得できません"
[[ "$LEFT_ID" =~ ^[0-9]+$ && "$RIGHT_ID" =~ ^[0-9]+$ ]] \
  || fail "$NODE の left_motor_id / right_motor_id を取得できません"
echo "  control_mode: $CONTROL_MODE  motor id: left=$LEFT_ID right=$RIGHT_ID"

set +e
python3 "$SCRIPT_DIR/drive_mode_check.py" \
  --control-mode "$CONTROL_MODE" --left-id "$LEFT_ID" --right-id "$RIGHT_ID" \
  --duration "$DURATION" --after-sec "$AFTER_SEC" --topic "$TOPIC" $ESTOP_CYCLE
code=$?
set -e
exit "$code"
