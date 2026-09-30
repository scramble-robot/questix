#!/bin/bash
# image-build-lib.sh
# Functions of the QUESTiX custom image build (sourced by scripts/apply-ansible-config.sh and by
# ansible/tests/test_image_build_contract.sh). They work on a chroot directory from outside it,
# so the contract test can run them against a fake tree without root, chroot or network.
#
#   questix_image_install_source REPO CHROOT USER
#       The QUESTiX checkout the image is built from, at CHROOT/home/USER/questix: a git clone
#       of REPO's checked-out commit (tracked files only: no untracked files, no build/ install/
#       log/ src/ of the build host), owned by USER (uid/gid from the chroot's own passwd). A
#       clone, not an archive, so the image keeps the commit identity Robot Manager's evidence
#       trials need (scripts/robot_manager/trial.py). Refuses an existing destination.
#   questix_image_install_first_boot ISO_DIR CHROOT
#       The first-boot enrollment helper (root:root 0755) and its unit (0644).
#   questix_image_verify_security CHROOT USER
#       Offline postconditions of the finished file tree (no chroot needed): the account is
#       locked, no NOPASSWD rule, no legacy .pkla, SSH not enabled, no console or desktop
#       autologin, the first-boot unit enabled and root-owned when checked as root, the source
#       checkout present and owned by USER. Prints every failure; returns 1 if any.

questix_image_ids() {
    # uid:gid of USER in CHROOT/etc/passwd (names are resolved in the image, not on the host).
    awk -F: -v user="$2" '$1 == user { print $3 ":" $4; found = 1 } END { exit !found }' \
        "$1/etc/passwd"
}

questix_image_install_source() {
    local repo="$1" chroot_dir="$2" user="$3"
    local dest="$chroot_dir/home/$user/questix"
    local ids commit
    ids="$(questix_image_ids "$chroot_dir" "$user")" || {
        echo "❌ user $user not found in $chroot_dir/etc/passwd" >&2
        return 1
    }
    # The build host's checkout belongs to another user (the CI runner): trust it explicitly.
    commit="$(git -c safe.directory="$repo" -C "$repo" rev-parse --verify HEAD)" || return 1
    if [ -e "$dest" ] && [ -n "$(ls -A "$dest" 2> /dev/null)" ]; then
        echo "❌ $dest already exists; the image build starts from an empty home" >&2
        return 1
    fi
    mkdir -p "$(dirname "$dest")"
    git -c safe.directory="$repo" -c safe.directory="$repo/.git" \
        clone --quiet --no-local --no-checkout "file://$repo" "$dest" || return 1
    git -C "$dest" -c advice.detachedHead=false checkout --quiet --detach "$commit" || return 1
    git -C "$dest" remote set-url origin \
        "${QUESTIX_IMAGE_SOURCE_REMOTE:-https://github.com/scramble-robot/questix.git}"
    if [ "$(git -C "$dest" rev-parse HEAD)" != "$commit" ]; then
        echo "❌ $dest is not at $commit" >&2
        return 1
    fi
    if [ ! -f "$dest/dependency.repos" ]; then
        echo "❌ $dest/dependency.repos is missing (not a QUESTiX checkout)" >&2
        return 1
    fi
    local generated
    for generated in build install log src; do
        if [ -e "$dest/$generated" ]; then
            echo "❌ $dest/$generated came with the source; the image builds it itself" >&2
            return 1
        fi
    done
    chown -R "$ids" "$dest" "$chroot_dir/home/$user" || return 1
    echo "📦 QUESTiX source $commit → /home/$user/questix"
}

questix_image_install_first_boot() {
    local iso_dir="$1" chroot_dir="$2"
    install -D -m 0755 "$iso_dir/questix-first-boot-enroll.sh" \
        "$chroot_dir/usr/local/sbin/questix-first-boot-enroll" || return 1
    install -D -m 0644 "$iso_dir/questix-first-boot.service" \
        "$chroot_dir/etc/systemd/system/questix-first-boot.service" || return 1
    if [ "$(id -u)" -eq 0 ]; then
        chown root:root "$chroot_dir/usr/local/sbin/questix-first-boot-enroll" \
            "$chroot_dir/etc/systemd/system/questix-first-boot.service" || return 1
    fi
}

questix_image_verify_security() {
    local chroot_dir="$1" user="$2"
    local failures=0 ids field unit link
    problem() {
        echo "❌ image: $*" >&2
        failures=$((failures + 1))
    }
    field="$(awk -F: -v user="$user" '$1 == user { print $2 }' "$chroot_dir/etc/shadow" 2> /dev/null)"
    case "$field" in
        '!'*) ;;
        *) problem "$user is not locked (a password or no password is set in the image)" ;;
    esac
    if grep -rqs 'NOPASSWD' "$chroot_dir/etc/sudoers" "$chroot_dir/etc/sudoers.d"; then
        problem "a NOPASSWD sudo rule is in the image"
    fi
    [ ! -e "$chroot_dir/etc/sudoers.d/$user" ] || problem "/etc/sudoers.d/$user is in the image"
    [ ! -e "$chroot_dir/etc/polkit-1/localauthority/50-local.d/50-questix-robot.pkla" ] \
        || problem "the legacy .pkla is in the image"
    for unit in ssh.socket ssh.service sshd.service; do
        for link in "$chroot_dir"/etc/systemd/system/*.wants/"$unit"; do
            [ ! -e "$link" ] && [ ! -L "$link" ] || problem "$unit is enabled (${link#"$chroot_dir"})"
        done
    done
    [ ! -e "$chroot_dir/etc/systemd/system/getty@tty1.service.d/autologin.conf" ] \
        || problem "console autologin is configured"
    if grep -qsE '^[[:space:]]*AutomaticLoginEnable[[:space:]]*=[[:space:]]*[Tt]rue' \
        "$chroot_dir/etc/gdm3/custom.conf"; then
        problem "desktop autologin is enabled"
    fi
    [ -L "$chroot_dir/etc/systemd/system/multi-user.target.wants/questix-first-boot.service" ] \
        || problem "questix-first-boot.service is not enabled"
    [ -f "$chroot_dir/etc/systemd/system/questix-first-boot.service" ] \
        || problem "questix-first-boot.service is missing"
    local helper="$chroot_dir/usr/local/sbin/questix-first-boot-enroll"
    if [ ! -f "$helper" ]; then
        problem "the enrollment helper is missing"
    else
        [ "$(stat -c %a "$helper")" = 755 ] || problem "the enrollment helper is not 0755"
        if [ "$(id -u)" -eq 0 ]; then
            [ "$(stat -c %u:%g "$helper")" = 0:0 ] || problem "the enrollment helper is not root-owned"
        fi
    fi
    ids="$(questix_image_ids "$chroot_dir" "$user")" || problem "$user is not in the image"
    local source="$chroot_dir/home/$user/questix"
    if [ ! -f "$source/dependency.repos" ]; then
        problem "the QUESTiX source is not at /home/$user/questix"
    elif [ -n "$ids" ] && [ "$(stat -c %u:%g "$source/dependency.repos")" != "$ids" ]; then
        problem "/home/$user/questix is not owned by $user"
    fi
    unset -f problem
    [ "$failures" -eq 0 ]
}
