#!/usr/bin/env bash
# update-robot-manager.sh
# Bring the installed Robot Manager (python package robot_manager, systemd questix_robot_manager)
# up to date with this repository. The service runs the installed copy, so a `git pull` alone
# does not change what it serves; this script copies, reinstalls and restarts only Robot Manager.
# Dependencies are pinned in scripts/robot_manager/requirements.txt and installed into the system
# Python (no venv). Only when an installed version differs from the pins are they downloaded
# (needs the internet); otherwise the update works offline.
#
# Usage:
#   sudo scripts/update-robot-manager.sh                  install or update if outdated
#   sudo scripts/update-robot-manager.sh --if-installed   update only an existing install
#                                                         (used by scripts/wifi-ap.sh up)
#   scripts/update-robot-manager.sh --check               exit 0 = up to date, 1 = outdated
#                                                         (files, pinned versions or the robot
#                                                         launcher), 2 = not
#                                                         installed
#
# Exit status of an update: 0 when Robot Manager is up to date (updated or already current).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$REPO_ROOT/scripts/robot_manager"
REQUIREMENTS="$SOURCE_DIR/requirements.txt"
# Kept as a plain copy too: questix_lab_bridge falls back to its static/lab (static_site.py).
INSTALL_DIR=/opt/questix_robot
SERVICE=questix_robot_manager
READY_TIMEOUT_SEC=30

die() {
    echo "❌ $*" >&2
    exit 1
}

# Directory of the installed package, empty when it is not installed. -I keeps the repository
# (the current directory) off sys.path, so this never finds the source tree by accident.
installed_dir() {
    python3 -I -c 'import os, robot_manager; print(os.path.dirname(robot_manager.__file__))' \
        2> /dev/null || true
}

# The files pip installs (setup.py: *.py and static/**, hidden files excluded) must match the
# repository byte for byte.
is_current() {
    local installed="$1"
    python3 -I - "$SOURCE_DIR" "$installed" << 'PYTHON'
import pathlib, sys
source, installed = map(pathlib.Path, sys.argv[1:3])
for path in source.rglob('*'):
    relative = path.relative_to(source)
    if not path.is_file() or '__pycache__' in relative.parts:
        continue
    # setuptools' package_data globs skip hidden files (static/lab/.prettierrc.json and the like
    # are development settings), so they are never installed.
    if any(part.startswith('.') for part in relative.parts):
        continue
    if relative.suffix != '.py' and relative.parts[0] != 'static':
        continue
    target = installed / relative
    if not target.is_file() or target.read_bytes() != path.read_bytes():
        sys.exit(1)
PYTHON
}

# The robot control service (questix_robot) runs the launcher from INSTALL_DIR. Robot Manager's
# 起動 in practice mode needs the version that honours its start request, so an update refreshes
# it too; questix_robot itself is not restarted (the new launcher is used on its next start).
LAUNCHER_SOURCE="$REPO_ROOT/systemd/questix_robot_launcher.sh"
LAUNCHER_TARGET="$INSTALL_DIR/questix_robot_launcher.sh"

# 0 when the installed launcher matches the repository or no robot service is installed.
launcher_current() {
    [ -f "$LAUNCHER_TARGET" ] || return 0
    cmp -s "$LAUNCHER_SOURCE" "$LAUNCHER_TARGET"
}

install_launcher() {
    echo "🔄 ロボット制御の起動スクリプトを更新します（次のロボット制御の起動から使われます）..."
    install -m 0755 "$LAUNCHER_SOURCE" "$LAUNCHER_TARGET"
}

# Every pinned dependency must be installed in exactly that version; prints the ones that are not.
deps_current() {
    python3 -I - "$REQUIREMENTS" << 'PYTHON'
import sys
from importlib import metadata
wrong = []
for line in open(sys.argv[1]):
    line = line.split('#', 1)[0].strip()
    if not line:
        continue
    name, _, pinned = line.partition('==')
    try:
        installed = metadata.version(name)
    except metadata.PackageNotFoundError:
        installed = 'なし'
    if installed != pinned:
        wrong.append(f'{name} {installed} → {pinned}')
if wrong:
    print('  固定版と違うライブラリ: ' + ', '.join(wrong), file=sys.stderr)
    sys.exit(1)
PYTHON
}

# Downloads the pinned versions. Offline (e.g. on the robot's own Wi-Fi) this fails; the manager
# then keeps running with what is installed, and the next online run fixes it.
install_requirements() {
    echo "📦 固定したバージョンの依存ライブラリを入れます（インターネットが必要）..."
    if ! pip3 install --break-system-packages -q -r "$REQUIREMENTS"; then
        echo "⚠️  依存ライブラリを固定版にできませんでした。インターネットにつないで sudo $0 を再実行してください。" >&2
    fi
}

service_installed() {
    systemctl cat "$SERVICE.service" > /dev/null 2>&1
}

# Port from the unit's ExecStart (--port N); 8888 is the installer default.
service_port() {
    local port
    port="$(systemctl cat "$SERVICE.service" 2> /dev/null | sed -n 's/.*--port \([0-9]*\).*/\1/p' | head -n 1)"
    echo "${port:-8888}"
}

install_package() {
    [ -d "$SOURCE_DIR" ] || die "$SOURCE_DIR がありません。"
    mkdir -p "$INSTALL_DIR"
    # Replace the copy instead of `cp -r` onto an existing directory, which would nest the new
    # files one level deeper and reinstall the old ones.
    rm -rf "$INSTALL_DIR/robot_manager.new"
    cp -r "$SOURCE_DIR" "$INSTALL_DIR/robot_manager.new"
    find "$INSTALL_DIR/robot_manager.new" -name __pycache__ -type d -prune -exec rm -rf {} +
    rm -rf "$INSTALL_DIR/robot_manager"
    mv "$INSTALL_DIR/robot_manager.new" "$INSTALL_DIR/robot_manager"
    cp "$REPO_ROOT/scripts/setup.py" "$INSTALL_DIR/setup.py"

    # Dependencies come from install_requirements; this reinstalls only the package, offline.
    local pip_args=(install --break-system-packages -q --no-deps --force-reinstall)
    if python3 -I -c 'import setuptools' 2> /dev/null; then
        pip_args+=(--no-build-isolation)  # build with the system setuptools instead of downloading it
    fi
    pip3 "${pip_args[@]}" "$INSTALL_DIR"
}

# HTTP status of the manager's /api/status, 000 while nothing answers.
status_code() {
    curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$(service_port)/api/status" || true
}

# The service log without the 304 lines of the UI's polling, so an error is visible at once.
show_service_log() {
    echo "---- systemctl status $SERVICE ----" >&2
    systemctl status "$SERVICE.service" --no-pager 2> /dev/null | head -n 8 >&2 || true
    echo "---- journalctl -u $SERVICE (304 を除く直近) ----" >&2
    journalctl -u "$SERVICE.service" -n 200 --no-pager 2> /dev/null | grep -v '" 304' | tail -n 40 >&2 || true
}

restart_service() {
    service_installed || return 0
    systemctl restart "$SERVICE.service"
    local waited=0
    local code
    code="$(status_code)"
    until [ "$code" != 000 ]; do
        waited=$((waited + 1))
        if [ "$waited" -ge "$READY_TIMEOUT_SEC" ]; then
            show_service_log
            die "Robot Manager が ${READY_TIMEOUT_SEC} 秒以内に応答しませんでした（上のログを確認）。"
        fi
        sleep 1
        code="$(status_code)"
    done
    # It runs, but a request fails: show why instead of reporting success.
    if [ "$code" != 200 ]; then
        show_service_log
        die "Robot Manager は起動しましたが、/api/status が HTTP $code を返しました（上のログを確認）。"
    fi
}

main() {
    local mode="${1:-update}"
    case "$mode" in
        update | --if-installed | --check) ;;
        -h | --help) sed -n '2,/^$/s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) die "不明なオプション: $mode（--help を参照）" ;;
    esac

    local installed
    installed="$(installed_dir)"
    local files_ok=0
    local deps_ok=0
    if [ -z "$installed" ]; then
        case "$mode" in
            --check) exit 2 ;;
            --if-installed)
                echo "ℹ️  Robot Manager はインストールされていません（sudo scripts/install-robot-manager.sh --with-gui）。"
                exit 0
                ;;
        esac
    else
        is_current "$installed" && files_ok=1
    fi
    deps_current && deps_ok=1
    local launcher_ok=0
    launcher_current && launcher_ok=1
    if [ "$files_ok" = 1 ] && [ "$deps_ok" = 1 ] && [ "$launcher_ok" = 1 ]; then
        [ "$mode" = --check ] && exit 0
        echo "✅ Robot Manager は最新です。"
        exit 0
    fi
    [ "$mode" = --check ] && exit 1

    [ "$(id -u)" -eq 0 ] || die "root で実行してください（sudo）。"
    [ "$deps_ok" = 1 ] || install_requirements
    [ "$launcher_ok" = 1 ] || install_launcher
    if [ "$files_ok" = 0 ]; then
        echo "🔄 Robot Manager をこのリポジトリの版に更新します ..."
        install_package
    fi
    restart_service
    echo "✅ Robot Manager を更新しました。"
}

main "$@"
