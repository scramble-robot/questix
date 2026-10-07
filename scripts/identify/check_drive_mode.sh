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
DOMAIN=""
LAUNCH_ENV="${QUESTIX_CONFIG_DIR:-/etc/questix_robot}/launch.env"
# questix_robot_launcher.sh と同じ既定値（launch.env に ROS_DOMAIN_ID が無いとき）
LAUNCHER_DEFAULT_DOMAIN=42

usage() {
  cat <<'USAGE'
使い方:
  bash scripts/identify/check_drive_mode.sh [--duration S] [--estop-cycle] [--after-sec S]
                                            [--domain N]

DDT モータの応答フレームの mode が drive_component の control_mode と一致するかを確かめる。
/drive_status を聞くだけで、モータを動かす指令は送らない（車輪を浮かせる必要はない）。

オプション:
  --duration S    /drive_status を聞く時間 [s]（既定 3）
  --estop-cycle   続けて非常停止の押下・解除をはさみ、解除の後の mode も確かめる（対話）。
                  非常停止で DDT の電源が切れる機体（ID13 など）で、電源投入時のモードに
                  戻っていないかを見る
  --after-sec S   非常停止を解除した後に聞く時間 [s]（既定 6。DDT の起動に 1.3〜1.6 s）
  --domain N      ROS_DOMAIN_ID を指定する。既定はロボットの起動と同じ値
                  （/etc/questix_robot/launch.env の ROS_DOMAIN_ID、無ければ 42）。
                  シェルの ROS_DOMAIN_ID とは違うことがあるので、使った値を表示する
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
    --domain) DOMAIN="$2"; shift 2 ;;
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

# launch.env の KEY の値（source しない。最後の行が有効、前後の空白と引用符を外す）。
launch_env_value() {
  [[ -r "$LAUNCH_ENV" ]] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$LAUNCH_ENV" | tail -n 1 \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\\(.*\\)'$/\\1/"
}

echo "=== preflight ==="
# ロボット（questix_robot.service）は launch.env の ROS_DOMAIN_ID で動く。シェルの値が違うと
# drive_component が見えないので、指定が無ければロボットと同じ値に合わせる。
SHELL_DOMAIN="${ROS_DOMAIN_ID:-}"
if [[ -z "$DOMAIN" ]]; then
  if [[ -r "$LAUNCH_ENV" ]]; then
    DOMAIN="$(launch_env_value ROS_DOMAIN_ID)"
    DOMAIN="${DOMAIN:-$LAUNCHER_DEFAULT_DOMAIN}"
    DOMAIN_SOURCE="$LAUNCH_ENV"
  else
    DOMAIN="${SHELL_DOMAIN:-0}"
    DOMAIN_SOURCE="シェル（$LAUNCH_ENV が読めない）"
  fi
else
  DOMAIN_SOURCE="--domain"
fi
[[ "$DOMAIN" =~ ^[0-9]+$ ]] || fail "ROS_DOMAIN_ID '$DOMAIN'（$DOMAIN_SOURCE）が数字ではありません"
export ROS_DOMAIN_ID="$DOMAIN"
if [[ "${SHELL_DOMAIN:-0}" != "$DOMAIN" ]]; then
  echo "  ROS_DOMAIN_ID: $DOMAIN（$DOMAIN_SOURCE。シェルの値 ${SHELL_DOMAIN:-未設定=0} とは違うので合わせた）"
else
  echo "  ROS_DOMAIN_ID: $DOMAIN（$DOMAIN_SOURCE）"
fi

# 見つからないときの手がかり（読み取りだけ。何も起動・停止しない）。
diagnose_missing_node() {
  echo "error: $NODE が見つかりません（ROS_DOMAIN_ID=$DOMAIN）" >&2
  local active enable_drive nodes
  active="$(systemctl is-active questix_robot.service 2>/dev/null || true)"
  enable_drive="$(launch_env_value ENABLE_DRIVE)"
  echo "  questix_robot.service: ${active:-不明}" >&2
  if [[ -r "$LAUNCH_ENV" ]]; then
    echo "  $LAUNCH_ENV の ENABLE_DRIVE: ${enable_drive:-未設定（既定 true）}" >&2
  fi
  nodes="$(ros2 node list --no-daemon --spin-time 3 2>/dev/null || true)"
  if [[ -n "$nodes" ]]; then
    echo "  このドメインで見えるノード:" >&2
    sed 's/^/    /' <<<"$nodes" >&2
  else
    echo "  このドメインではノードが 1 つも見えません" >&2
  fi
  echo "  確認すること:" >&2
  [[ "$active" != "active" ]] && echo "    - ロボットが起動していない（Robot Manager で起動する）" >&2
  [[ "${enable_drive,,}" == "false" ]] \
    && echo "    - 走行（drive）を起動しない設定になっている（Robot Manager の起動設定で走行を有効にする）" >&2
  echo "    - ロボットが別の ROS_DOMAIN_ID で動いている（--domain N で指定）" >&2
  echo "    - ros2 daemon が古い情報を持っている（ros2 daemon stop の後にもう一度）" >&2
  echo "    - ロボットとは別の PC で実行している（ロボットの Pi で実行する）" >&2
  exit 3
}

# ros2 daemon が古い情報を返すことがあるので、見つからなければ daemon を使わずに聞き直す。
if ros2 node list 2>/dev/null | grep -qxF "$NODE" \
    || ros2 node list --no-daemon --spin-time 3 2>/dev/null | grep -qxF "$NODE"; then
  echo "  node $NODE: OK"
else
  diagnose_missing_node
fi

{ ros2 topic list 2>/dev/null | grep -qxF "$TOPIC" \
    || ros2 topic list --no-daemon --spin-time 3 2>/dev/null | grep -qxF "$TOPIC"; } \
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
