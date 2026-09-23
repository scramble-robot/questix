#!/usr/bin/env bash
# wifi-ap.sh
# Turn the Raspberry Pi Wi-Fi into a QUESTiX access point (or back) right away.
# Runs the wifi_access_point Ansible role (ansible/playbooks/wifi_ap.yaml) on this machine and
# keeps the settings in /etc/questix_robot/wifi_ap.env, so every kit keeps its own SSID/password.
#
# Usage:
#   sudo scripts/wifi-ap.sh up [options]   access point on, now and at every boot; also turns on
#                                          the QUESTiX LAB bridge (except in competition mode)
#   sudo scripts/wifi-ap.sh down           access point off; saved Wi-Fi client profiles take over
#   sudo scripts/wifi-ap.sh status         SSID, password, address and connected devices
#   sudo scripts/wifi-ap.sh remove         delete the access point profile and its settings
#
# Options for "up" (saved for the next runs):
#   --ssid NAME|auto    default: QUESTiX-<last 4 hex digits of the Wi-Fi MAC address>, which differs
#                       on every kit even when they were all installed from the same image
#   --password PASS     8-63 characters; generated on the first run when omitted
#   --new-password      generate a new password
#   --band bg|a         bg = 2.4 GHz (default), a = 5 GHz
#   --channel N|auto    default on the first run: auto = the least crowded of 1/6/11 (2.4 GHz) or
#                       36/40/44/48 (5 GHz) around this robot, so several robots spread out
#   --country CC        regulatory domain, default: JP
#   --interface IF      default: wlan0
#   --yes               do not ask before dropping an SSH session that uses this Wi-Fi

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAYBOOK="$REPO_ROOT/ansible/playbooks/wifi_ap.yaml"
ENV_FILE=/etc/questix_robot/wifi_ap.env
LOG_FILE=/var/log/questix-wifi-ap.log
CONNECTION_NAME=questix-ap
# robot_manager (scripts/robot_manager/__main__.py) and its QUESTiX LAB settings.
CONFIG_DIR="${QUESTIX_CONFIG_DIR:-/etc/questix_robot}"
ROBOT_MANAGER_URL=http://127.0.0.1:8888
LAB_BRIDGE_PORT=8897  # questix_lab_bridge/config/lab_bridge.yaml
PASSWORD_LENGTH=12
# No 0/O, 1/l/I: the password is read off a screen and typed on a phone.
PASSWORD_CHARACTERS='A-HJ-NP-Za-km-z2-9'

usage() {
    sed -n '2,/^$/s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"
}

die() {
    echo "❌ $*" >&2
    exit 1
}

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        exec sudo "${BASH_SOURCE[0]}" "$@"
    fi
}

find_ansible() {
    if command -v ansible-playbook > /dev/null; then
        command -v ansible-playbook
        return
    fi
    # setup.sh may have installed Ansible for the login user only (pip --user).
    local user_bin
    user_bin="$(getent passwd "${SUDO_USER:-}" | cut -d: -f6)/.local/bin/ansible-playbook"
    if [ -n "${SUDO_USER:-}" ] && [ -x "$user_bin" ]; then
        echo "$user_bin"
        return
    fi
    die "ansible-playbook が見つかりません。sudo apt install ansible でインストールしてください。"
}

load_settings() {
    WIFI_AP_STATE=""
    WIFI_AP_INTERFACE=wlan0
    WIFI_AP_SSID=""
    WIFI_AP_PASSWORD=""
    WIFI_AP_BAND=bg
    WIFI_AP_CHANNEL=""
    WIFI_AP_COUNTRY=JP
    WIFI_AP_ADDRESS=10.42.0.1/24
    if [ -f "$ENV_FILE" ]; then
        # shellcheck source=/dev/null
        . "$ENV_FILE"
    fi
}

generate_password() {
    local password
    password="$(LC_ALL=C tr -dc "$PASSWORD_CHARACTERS" < /dev/urandom | head -c "$PASSWORD_LENGTH")" || true
    echo "$password"
}

# Last 4 hex digits of the Wi-Fi MAC address, e.g. 3F2A: unique per kit, printed on no label.
mac_suffix() {
    local mac
    mac="$(cat "/sys/class/net/$1/address" 2> /dev/null || true)"
    mac="${mac//:/}"
    echo "${mac: -4}" | tr '[:lower:]' '[:upper:]'
}

default_ssid() {
    local suffix
    suffix="$(mac_suffix "$WIFI_AP_INTERFACE")"
    echo "QUESTiX-${suffix:-$(hostname -s)}"
}

# Channels that do not overlap each other. 5 GHz: W52 only, the band Japan allows indoors
# without radar detection (DFS), which a Pi access point does not do.
candidate_channels() {
    if [ "$1" = a ]; then echo 36 40 44 48; else echo 1 6 11; fi
}

# Picks the channel with the least signal around this robot (other robots' access points
# included). 2.4 GHz channels closer than 5 apart overlap, so their signals count too.
# Without a scan (the interface is already an access point), the candidates are rotated by the
# MAC address so that robots still spread over the channels.
pick_channel() {
    local band="$1"
    local candidates
    read -r -a candidates <<< "$(candidate_channels "$band")"
    local mac
    mac="$(mac_suffix "$WIFI_AP_INTERFACE")"
    local offset=$(( 16#${mac:-0} % ${#candidates[@]} ))
    local scan
    scan="$(nmcli -t -f CHAN,SIGNAL device wifi list ifname "$WIFI_AP_INTERFACE" --rescan yes 2> /dev/null || true)"
    local overlap=1
    [ "$band" = bg ] && overlap=5
    local best=""
    local best_load=""
    local index channel load
    for index in "${!candidates[@]}"; do
        channel="${candidates[$(( (index + offset) % ${#candidates[@]} ))]}"
        load="$(awk -F: -v c="$channel" -v o="$overlap" \
            '{d = $1 - c; if (d < 0) d = -d; if (d < o) sum += $2} END {print sum + 0}' <<< "$scan")"
        if [ -z "$best" ] || [ "$load" -lt "$best_load" ]; then
            best="$channel"
            best_load="$load"
        fi
    done
    if [ -n "$scan" ]; then
        echo "📡 周囲の電波を調べて、チャンネル $best を選びました。" >&2
    else
        echo "📡 周囲を調べられなかったため、この機体用のチャンネル $best を使います。" >&2
    fi
    echo "$best"
}

# Local addresses of established SSH sessions that arrive over the given interface.
ssh_sessions_on() {
    local interface="$1"
    local address
    for address in $(ip -o -4 addr show dev "$interface" 2> /dev/null | awk '{split($4, a, "/"); print a[1]}'); do
        ss -Htn state established "( sport = :22 )" 2> /dev/null | awk -v ip="$address" '$3 ~ "^" ip ":" {print $3}'
    done
}

confirm_ssh_drop() {
    local assume_yes="$1"
    if [ -z "$(ssh_sessions_on "$WIFI_AP_INTERFACE")" ]; then
        DETACH=0
        return
    fi
    DETACH=1
    echo "⚠️  $WIFI_AP_INTERFACE 経由の SSH 接続があります。Wi-Fi を切り替えるとこの接続は切れます。"
    echo "   設定はバックグラウンドで続行し、ログは $LOG_FILE に残ります。"
    if [ "$assume_yes" = 1 ]; then
        return
    fi
    local answer
    read -r -p "続けますか？ [y/N] " answer
    [ "$answer" = y ] || [ "$answer" = Y ] || die "中止しました。"
}

# Runs the role with the current settings. Vars go through a root-only temporary file so the
# password never appears on a command line (ps) or in the shell history.
run_playbook() {
    local ansible_playbook vars_file
    ansible_playbook="$(find_ansible)"
    vars_file="$(mktemp)"
    chmod 600 "$vars_file"
    python3 - "$vars_file" << 'PYTHON'
import json, os, sys
keys = ['STATE', 'INTERFACE', 'SSID', 'PASSWORD', 'BAND', 'CHANNEL', 'COUNTRY', 'ADDRESS']
values = {'wifi_ap_' + key.lower(): os.environ['WIFI_AP_' + key] for key in keys}
with open(sys.argv[1], 'w') as out:
    json.dump(values, out)
PYTHON
    local command=("$ansible_playbook" "$PLAYBOOK" -i localhost, --connection=local
        -e "ansible_python_interpreter=/usr/bin/python3" -e "@$vars_file")
    cd "$REPO_ROOT"
    if [ "${DETACH:-0}" = 1 ]; then
        # Survives the SSH session that the switch is about to drop.
        setsid nohup bash -c '"$@"; status=$?; rm -f "'"$vars_file"'"; exit $status' _ "${command[@]}" \
            >> "$LOG_FILE" 2>&1 < /dev/null &
        echo "▶️  バックグラウンドで適用中です（ログ: $LOG_FILE）。"
        return
    fi
    local status=0
    "${command[@]}" || status=$?
    rm -f "$vars_file"
    return "$status"
}

export_settings() {
    export WIFI_AP_STATE WIFI_AP_INTERFACE WIFI_AP_SSID WIFI_AP_PASSWORD WIFI_AP_BAND \
        WIFI_AP_CHANNEL WIFI_AP_COUNTRY WIFI_AP_ADDRESS
}

command_up() {
    local assume_yes=0
    local new_password=0
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --ssid) WIFI_AP_SSID="${2:?--ssid に値が必要です}"; shift 2 ;;
            --password) WIFI_AP_PASSWORD="${2:?--password に値が必要です}"; shift 2 ;;
            --new-password) new_password=1; shift ;;
            --band) WIFI_AP_BAND="${2:?--band に値が必要です}"; WIFI_AP_CHANNEL=auto; shift 2 ;;
            --channel) WIFI_AP_CHANNEL="${2:?--channel に値が必要です}"; shift 2 ;;
            --country) WIFI_AP_COUNTRY="${2:?--country に値が必要です}"; shift 2 ;;
            --interface) WIFI_AP_INTERFACE="${2:?--interface に値が必要です}"; shift 2 ;;
            --yes | -y) assume_yes=1; shift ;;
            *) die "不明なオプション: $1（--help を参照）" ;;
        esac
    done
    if [ -z "$WIFI_AP_PASSWORD" ] || [ "$new_password" = 1 ]; then
        WIFI_AP_PASSWORD="$(generate_password)"
    fi
    [ -d "/sys/class/net/$WIFI_AP_INTERFACE" ] || die "Wi-Fi インターフェース $WIFI_AP_INTERFACE がありません。"
    if [ -z "$WIFI_AP_SSID" ] || [ "$WIFI_AP_SSID" = auto ]; then
        WIFI_AP_SSID="$(default_ssid)"
    fi
    if [ -z "$WIFI_AP_CHANNEL" ] || [ "$WIFI_AP_CHANNEL" = auto ]; then
        WIFI_AP_CHANNEL="$(pick_channel "$WIFI_AP_BAND")"
    fi
    WIFI_AP_STATE=up
    confirm_ssh_drop "$assume_yes"
    export_settings
    run_playbook
    [ "${DETACH:-0}" = 1 ] || command_status
    enable_lab_bridge
    print_join_hint
}

# Learners join the access point to open the teaching pages, so the bridge that serves them
# (started by robot_manager) is switched on with it: AUTOSTART for the next boots, and a start
# request now. Competition mode keeps the bridge off (robot_manager turned AUTOSTART off).
enable_lab_bridge() {
    if [ "$(cat "$CONFIG_DIR/mode" 2> /dev/null)" = competition ]; then
        echo "ℹ️  大会モードのため、教材の配信（QUESTiX LAB）は開始しません。"
        return
    fi
    local lab_env="$CONFIG_DIR/lab.env"
    if [ -f "$lab_env" ] && ! grep -qx 'AUTOSTART="true"' "$lab_env"; then
        # robot_manager (the login user) owns lab.env; keep it that way.
        local owner
        owner="$(stat -c %U:%G "$lab_env")"
        if grep -q '^AUTOSTART=' "$lab_env"; then
            sed -i 's/^AUTOSTART=.*/AUTOSTART="true"/' "$lab_env"
        else
            echo 'AUTOSTART="true"' >> "$lab_env"
        fi
        chown "$owner" "$lab_env"
    fi
    # No lab.env: robot_manager's default is AUTOSTART on.
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$ROBOT_MANAGER_URL/api/lab/start" || true)"
    case "$code" in
        200) echo "📚 教材の配信を開始しました: http://${WIFI_AP_ADDRESS%/*}:$LAB_BRIDGE_PORT/" ;;
        409) echo "📚 教材の配信は動作中です: http://${WIFI_AP_ADDRESS%/*}:$LAB_BRIDGE_PORT/" ;;
        000) echo "ℹ️  Robot Manager が動いていないため、教材の配信は次の起動時に自動で始まります。" ;;
        *) echo "⚠️  教材の配信を開始できませんでした (HTTP $code)。Robot Manager の「教材」タブを確認してください。" ;;
    esac
}

# 1 when the only argument is --yes/-y.
yes_flag() {
    case "$1" in
        --yes | -y) echo 1 ;;
        "") echo 0 ;;
        *) die "不明なオプション: $1（--help を参照）" ;;
    esac
}

command_down() {
    [ -f "$ENV_FILE" ] || die "アクセスポイントはまだ設定されていません。"
    local assume_yes
    assume_yes="$(yes_flag "${1:-}")"
    WIFI_AP_STATE=down
    confirm_ssh_drop "$assume_yes"
    export_settings
    run_playbook
    echo "📴 アクセスポイントを止めました。保存済みの Wi-Fi があれば自動で接続します。"
}

command_remove() {
    WIFI_AP_STATE=absent
    local assume_yes
    assume_yes="$(yes_flag "${1:-}")"
    confirm_ssh_drop "$assume_yes"
    # The role validates the other settings only when they are used; keep them well-formed.
    WIFI_AP_CHANNEL="${WIFI_AP_CHANNEL:-6}"
    export_settings
    run_playbook
    echo "🗑️  アクセスポイントの設定を削除しました。"
}

command_status() {
    if [ ! -f "$ENV_FILE" ]; then
        echo "アクセスポイントは未設定です。 sudo $0 up で作成します。"
        return
    fi
    local active=off
    if nmcli -t -f NAME connection show --active 2> /dev/null | grep -qx "$CONNECTION_NAME"; then
        active=on
    fi
    local clients
    clients="$(iw dev "$WIFI_AP_INTERFACE" station dump 2> /dev/null | grep -c '^Station' || true)"
    echo "📶 QUESTiX アクセスポイント"
    echo "   状態        : $active（起動時: $WIFI_AP_STATE）"
    echo "   SSID        : $WIFI_AP_SSID"
    echo "   パスワード  : $WIFI_AP_PASSWORD"
    echo "   周波数/ch   : $([ "$WIFI_AP_BAND" = a ] && echo 5 GHz || echo 2.4 GHz) / $WIFI_AP_CHANNEL（国: $WIFI_AP_COUNTRY）"
    echo "   ロボットのIP: ${WIFI_AP_ADDRESS%/*}"
    [ "$active" = on ] && echo "   接続中の端末: ${clients:-0} 台"
    return 0
}

# A phone camera joins the network from this QR code (standard Wi-Fi QR format).
print_join_hint() {
    command -v qrencode > /dev/null || return 0
    local escaped_ssid escaped_password
    escaped_ssid="$(printf '%s' "$WIFI_AP_SSID" | sed 's/[\\;,:"]/\\&/g')"
    escaped_password="$(printf '%s' "$WIFI_AP_PASSWORD" | sed 's/[\\;,:"]/\\&/g')"
    echo "📱 スマートフォンのカメラで読み取ると接続できます:"
    qrencode -t ansiutf8 "WIFI:T:WPA;S:${escaped_ssid};P:${escaped_password};;"
}

main() {
    local subcommand="${1:-}"
    case "$subcommand" in
        -h | --help | help | "") usage; exit 0 ;;
        up | down | status | remove) ;;
        *) die "不明なコマンド: $subcommand（--help を参照）" ;;
    esac
    require_root "$@"
    shift
    load_settings
    case "$subcommand" in
        up) command_up "$@" ;;
        down) command_down "$@" ;;
        status) command_status ;;
        remove) command_remove "$@" ;;
    esac
}

main "$@"
