#!/usr/bin/env bash
# check-robot-manager.sh
# Read-only health report of Robot Manager on the robot: the Python it runs with, the versions
# and locations of its libraries (apt vs pip), dependency conflicts, whether the installed copy
# matches this repository, the service, its API answers and the last error in its log.
# Changes nothing. Run it with sudo to include the service log.
#
# Usage:
#   sudo scripts/check-robot-manager.sh
#   sudo scripts/check-robot-manager.sh > robot-manager-check.txt   # to share the report

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE=questix_robot_manager
PROBLEMS=0

section() {
    printf '\n== %s ==\n' "$1"
}

ok() {
    echo "  ✅ $*"
}

ng() {
    echo "  ❌ $*"
    PROBLEMS=$((PROBLEMS + 1))
}

info() {
    echo "  ・$*"
}

# The unit's ExecStart decides the interpreter and port; defaults match the installers.
unit_text="$(systemctl cat "$SERVICE.service" 2> /dev/null || true)"
exec_start="$(sed -n 's/^ExecStart=//p' <<< "$unit_text" | tail -n 1)"
PYTHON="$(awk '{print $1}' <<< "$exec_start")"
PYTHON="${PYTHON:-/usr/bin/python3}"
PORT="$(sed -n 's/.*--port \([0-9]*\).*/\1/p' <<< "$exec_start")"
PORT="${PORT:-8888}"
SERVICE_USER="$(sed -n 's/^User=//p' <<< "$unit_text" | tail -n 1)"

section "Robot Manager のサービス"
if [ -z "$unit_text" ]; then
    ng "$SERVICE.service がありません（sudo scripts/install-robot-manager.sh --with-gui）"
else
    state="$(systemctl is-active "$SERVICE.service" 2> /dev/null || true)"
    if [ "$state" = active ]; then ok "状態: active"; else ng "状態: $state"; fi
    info "実行ユーザー: ${SERVICE_USER:-root}"
    info "ExecStart: $exec_start"
fi

section "Python とライブラリ（サービスと同じ $PYTHON）"
# -I: the repository (current directory) must not shadow the installed packages.
"$PYTHON" -I - << 'PYTHON'
import sys
from importlib import import_module, metadata

try:
    from packaging.requirements import Requirement
    from packaging.version import Version
except ImportError:
    from pip._vendor.packaging.requirements import Requirement
    from pip._vendor.packaging.version import Version

PACKAGES = ['fastapi', 'starlette', 'pydantic', 'pydantic-core', 'uvicorn', 'anyio',
            'typing-extensions', 'robot-manager']
MODULES = {'pydantic-core': 'pydantic_core', 'typing-extensions': 'typing_extensions',
           'robot-manager': 'robot_manager'}
problems = 0


def norm(name):
    return name.lower().replace('_', '-')


def origin(path):
    path = str(path)
    if path.startswith('/usr/lib/python3/dist-packages'):
        return 'apt'
    if '/usr/local/lib/' in path:
        return 'pip(system)'
    if '/.local/lib/' in path:
        return 'pip(user)'
    return 'other'


print(f'  ・Python {sys.version.split()[0]} ({sys.executable})')

# Every installed copy, so a pip copy hiding an apt copy (or the reverse) is visible.
copies = {}
for dist in metadata.distributions():
    name = norm(dist.metadata['Name'] or '')
    if name in PACKAGES or name == 'robot-manager':
        copies.setdefault(name, []).append((dist.version, dist.locate_file('')))

for name in PACKAGES:
    found = copies.get(name, [])
    module_name = MODULES.get(name, name)
    try:
        module = import_module(module_name)
        loaded = getattr(module, '__file__', '') or ''
    except Exception as error:  # an import failure is exactly what we are looking for
        loaded = f'import に失敗: {type(error).__name__}: {error}'
    if not found:
        print(f'  ❌ {name}: インストールされていません')
        problems += 1
        continue
    listed = ', '.join(f'{version} [{origin(path)}]' for version, path in found)
    mark = '⚠️ ' if len(found) > 1 else '・'
    print(f'  {mark}{name}: {listed}')
    print(f'      読み込まれる: {loaded}')
    if len(found) > 1:
        print('      → 複数の版が入っています（apt と pip の混在）。読み込まれる方が要件を満たすか下で確認します。')

# Requirements between the libraries, checked against the copy that is actually imported.
print()
for parent in ['fastapi', 'uvicorn', 'pydantic', 'robot-manager']:
    try:
        requirements = metadata.requires(parent) or []
    except metadata.PackageNotFoundError:
        continue
    for text in requirements:
        requirement = Requirement(text)
        if requirement.marker and not requirement.marker.evaluate({'extra': ''}):
            continue
        try:
            installed = metadata.version(requirement.name)
        except metadata.PackageNotFoundError:
            print(f'  ❌ {parent} には {requirement} が必要ですが、入っていません')
            problems += 1
            continue
        if requirement.specifier and not requirement.specifier.contains(Version(installed), prereleases=True):
            print(f'  ❌ {parent} には {requirement} が必要ですが、{requirement.name} {installed} が入っています')
            problems += 1

try:
    if Version(metadata.version('pydantic')).major < 2:
        print('  ❌ pydantic 1.x です。Robot Manager は pydantic 2 の書き方（field_validator）を使います')
        problems += 1
except metadata.PackageNotFoundError:
    pass

# Import the app like uvicorn does: module-level errors show up here with their traceback.
try:
    import_module('robot_manager.app')
    print('  ✅ robot_manager.app を import できます')
except Exception:
    import traceback
    print('  ❌ robot_manager.app の import に失敗:')
    print('      ' + traceback.format_exc().replace('\n', '\n      '))
    problems += 1

if problems == 0:
    print('  ✅ ライブラリの要件はすべて満たしています')
sys.exit(min(problems, 100))
PYTHON
PROBLEMS=$((PROBLEMS + $?))

section "pip check（Robot Manager に関係する行）"
conflicts="$("$PYTHON" -m pip check 2> /dev/null | grep -i -E "fastapi|starlette|pydantic|uvicorn|anyio|typing" || true)"
if [ -n "$conflicts" ]; then
    sed 's/^/  ❌ /' <<< "$conflicts"
    PROBLEMS=$((PROBLEMS + 1))
else
    ok "食い違いはありません"
fi

section "インストール済みの Robot Manager とリポジトリ"
"$REPO_ROOT/scripts/update-robot-manager.sh" --check
case $? in
    0) ok "リポジトリと同じです" ;;
    1) ng "リポジトリと違います（sudo scripts/update-robot-manager.sh で更新）" ;;
    2) ng "インストールされていません" ;;
esac

section "API の応答（http://127.0.0.1:$PORT）"
for path in /api/status /api/lab/status /api/wifi-ap; do
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$PORT$path" || true)"
    case "$code" in
        200) ok "$path → 200" ;;
        000) ng "$path → 応答なし（サービスが動いていない、またはポート違い）" ;;
        404) ng "$path → 404（古い Robot Manager: sudo scripts/update-robot-manager.sh）" ;;
        *) ng "$path → $code" ;;
    esac
done

section "サービスのログ: 最後のエラー"
if [ "$(id -u)" -ne 0 ] && ! journalctl -u "$SERVICE.service" -n 1 --no-pager > /dev/null 2>&1; then
    info "ログを読むには sudo で実行してください"
else
    log="$(journalctl -u "$SERVICE.service" -n 400 --no-pager 2> /dev/null | grep -v '" 304')"
    last_traceback="$(awk '/Traceback \(most recent call last\)/ {block = ""; keep = 1; lines = 0}
        keep {block = block $0 "\n"; if (++lines > 60) keep = 0}
        /\]: [A-Za-z_.]*(Error|Exception|Group)(:|$)/ {if (keep) {last = block; keep = 0; lines = 0}}
        END {printf "%s", last}' <<< "$log")"
    if [ -n "$last_traceback" ]; then
        sed 's/^/  | /' <<< "$last_traceback" | tail -n 40
    else
        ok "直近のログに Traceback はありません"
        grep -E " 5[0-9][0-9] |Error|error" <<< "$log" | tail -n 5 | sed 's/^/  | /'
    fi
fi

section "まとめ"
if [ "$PROBLEMS" -eq 0 ]; then
    ok "問題は見つかりませんでした"
else
    ng "$PROBLEMS 件の問題があります（上の ❌ を確認）"
fi
exit $((PROBLEMS > 0))
