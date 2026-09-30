#!/bin/bash
# questix-first-boot-enroll.sh
# First-boot account enrollment of a QUESTiX custom image (installed as
# /usr/local/sbin/questix-first-boot-enroll, root:root 0755, and run only by
# questix-first-boot.service on the console, tty1).
#
# The image ships the robot user with a LOCKED password, in the sudo group but without any
# NOPASSWD rule, and with SSH disabled: nobody can log in, locally or remotely, until someone at
# the robot's own screen and keyboard sets a password here. Then, and only then:
#   1. the password is set (read from the console without echo, handed to chpasswd on stdin:
#      never on a command line, in a log or in a file);
#   2. SSH host keys are generated and SSH (ssh.socket on Ubuntu 24.04) is enabled, started and
#      checked active;
#   3. only then the enrollment marker is written and this unit disables itself.
# Any failure locks the account again and leaves SSH disabled; the next boot asks again.
# sudo keeps asking for the user's password (no rule of its own is added or kept here).

set -uo pipefail

ENROLL_USER="${QUESTIX_ENROLL_USER:-ubuntu}"
STATE_DIR="${QUESTIX_ENROLL_STATE_DIR:-/var/lib/questix}"
SYSTEMD_UNIT_DIR="${QUESTIX_SYSTEMD_UNIT_DIR:-/usr/lib/systemd/system}"
MARKER="$STATE_DIR/first-boot-enrolled"
SELF_UNIT=questix-first-boot.service
MIN_LENGTH=8
MAX_LENGTH=128

say() {
    printf '%s\n' "$*"
}

ssh_unit() {
    # Ubuntu 24.04 starts sshd through socket activation (ssh.socket).
    if [ -e "$SYSTEMD_UNIT_DIR/ssh.socket" ]; then
        echo ssh.socket
    else
        echo ssh.service
    fi
}

# Fail closed: no password login, no SSH, and the next boot asks again (no marker).
fail() {
    say ""
    say "❌ $*"
    passwd -l "$ENROLL_USER" > /dev/null 2>&1
    systemctl disable ssh.socket ssh.service > /dev/null 2>&1
    systemctl stop ssh.socket ssh.service > /dev/null 2>&1
    say "   アカウントはロックしたままです。SSH も無効のままです。次の起動でもう一度設定できます。"
    exit 1
}

# Empty when the pair is acceptable, otherwise the reason (never the password itself).
password_problem() {
    local first="$1" second="$2"
    if [ "$first" != "$second" ]; then
        echo "2 回の入力が一致しません。"
    elif [ "${#first}" -lt "$MIN_LENGTH" ]; then
        echo "${MIN_LENGTH} 文字以上にしてください。"
    elif [ "${#first}" -gt "$MAX_LENGTH" ]; then
        echo "${MAX_LENGTH} 文字以下にしてください。"
    elif [ "$first" = "$ENROLL_USER" ] || [ "$first" = ubuntu ] || [ "$first" = questix ]; then
        echo "ユーザー名や初期値と同じパスワードは使えません。"
    fi
}

main() {
    if [ -e "$MARKER" ]; then
        exit 0
    fi
    id "$ENROLL_USER" > /dev/null 2>&1 || fail "ユーザー $ENROLL_USER がありません。"
    # The image is locked already; lock again in case a previous attempt stopped half-way.
    passwd -l "$ENROLL_USER" > /dev/null 2>&1

    say "=================================================================="
    say " QUESTiX ロボットの初期設定"
    say "=================================================================="
    say " ユーザー「$ENROLL_USER」のパスワードを決めてください。"
    say " このパスワードは、ログイン・SSH・sudo に使います。"
    say " 初期パスワードはありません。設定するまで、誰もログインできません。"
    say ""

    local first second problem
    while true; do
        IFS= read -r -s -p "新しいパスワード: " first || fail "入力が終わりました。"
        say ""
        IFS= read -r -s -p "もう一度入力: " second || fail "入力が終わりました。"
        say ""
        problem="$(password_problem "$first" "$second")"
        if [ -z "$problem" ]; then
            break
        fi
        say "⚠️  $problem もう一度入力してください。"
        say ""
    done
    second=""

    # printf is a shell builtin: the password is never an argument of a program.
    if ! printf '%s:%s\n' "$ENROLL_USER" "$first" | chpasswd; then
        first=""
        fail "パスワードを設定できませんでした。"
    fi
    first=""

    # SSH is enabled only now, after the password; the marker only once SSH is really up, so a
    # failure anywhere before it leaves no marker and the next boot asks again.
    local unit
    unit="$(ssh_unit)"
    ssh-keygen -A > /dev/null || fail "SSH の鍵を作れませんでした。"
    systemctl enable "$unit" > /dev/null || fail "SSH を有効にできませんでした。"
    systemctl start "$unit" > /dev/null || fail "SSH を開始できませんでした。"
    systemctl is-active --quiet "$unit" || fail "SSH が動いていません。"
    mkdir -p "$STATE_DIR" || fail "設定済みの印を書けませんでした。"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER" || fail "設定済みの印を書けませんでした。"
    # With the marker written, the unit's ConditionPathExists= already keeps it from running
    # again; disabling it only tidies up.
    systemctl disable "$SELF_UNIT" > /dev/null 2>&1 \
        || say "⚠️  $SELF_UNIT を無効にできませんでした（設定済みの印があるため、次回は動きません）。"

    say ""
    say "✅ 設定しました。ログイン画面に進みます。"
    say "   SSH: ssh $ENROLL_USER@<ロボットの IP>（このパスワードで入れます）"
    say "   sudo もこのパスワードを求めます。"
    exit 0
}

main "$@"
