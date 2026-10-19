#!/bin/bash
# Helpers for the local QUESTiX Pi Desktop image builder. Sourcing does no work.

questix_pi_verify_base() {
    local base="$1" expected="$2" actual
    [[ -f "$base" && ! -L "$base" && "$base" = *.img.xz ]] || {
        echo "Expected a regular .img.xz file (not a device or symlink)" >&2
        return 1
    }
    [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || return 1
    actual="$(sha256sum -- "$base")" || return 1
    [[ "${actual%% *}" = "$expected" ]] || {
        echo "Base SHA-256 mismatch; use the pinned official Pi Desktop image" >&2
        return 1
    }
}

questix_pi_check_partitions() {
    local loop="$1" partitions
    [[ "$loop" =~ ^/dev/loop[0-9]+$ ]] || return 1
    partitions="$(lsblk -nrpo NAME,TYPE "$loop" | awk '$2 == "part" {print $1}')" || return 1
    # The supported official image has a FAT boot partition and final ext4 root.
    # Refuse other layouts before growpart or any filesystem writes.
    [[ "$partitions" = "${loop}p1"$'\n'"${loop}p2" ]] || return 1
    [[ "$(blkid -s TYPE -o value "${loop}p1")" = vfat ]] || return 1
    [[ "$(blkid -s LABEL -o value "${loop}p1")" = system-boot ]] || return 1
    [[ "$(blkid -s TYPE -o value "${loop}p2")" = ext4 ]] || return 1
    [[ "$(blkid -s LABEL -o value "${loop}p2")" = writable ]]
}

questix_pi_root_argument() {
    # Preserve the official root= identity, including LABEL/UUID/PARTUUID spelling.
    awk '{for (i=1; i<=NF; i++) if ($i ~ /^root=/) {value=$i; count++}}
         END {if (count != 1 || value ~ /XXXXXXXX/) exit 1; print value}' "$1"
}

questix_pi_check_boot() {
    local root="$1" expected_root="$2"
    [[ -s "$root/boot/firmware/config.txt" ]] || return 1
    [[ -s "$root/boot/firmware/vmlinuz" && -s "$root/boot/firmware/initrd.img" ]] || return 1
    [[ -s "$root/boot/firmware/bcm2712-rpi-5-b.dtb" ]] || return 1
    [[ "$(questix_pi_root_argument "$root/boot/firmware/cmdline.txt")" = "$expected_root" ]] || return 1
    # Kernel cmdline must not force the OEM target that conflicts with multi-user.
    ! grep -qE 'systemd.unit=oem-config|init=/|boot=casper' "$root/boot/firmware/cmdline.txt"
}

questix_pi_check_desktop() {
    local root="$1"
    [[ "$(readlink "$root/etc/systemd/system/default.target")" = /usr/lib/systemd/system/graphical.target ]] || return 1
    [[ "$(readlink "$root/etc/systemd/system/oem-config.service")" = /dev/null ]] || return 1
    [[ "$(readlink "$root/etc/systemd/system/oem-config.target")" = /dev/null ]] || return 1
    [[ -f "$root/etc/cloud/cloud-init.disabled" ]] || return 1
    ! grep -q '^oem:' "$root/etc/passwd" || return 1
    ! grep -qE '^[[:space:]]*(Automatic|Timed)LoginEnable[[:space:]]*=[[:space:]]*[Tt]rue' \
        "$root/etc/gdm3/custom.conf" || return 1
    [[ ! -e "$root/var/lib/questix/first-boot-enrolled" ]]
}

questix_pi_unmount() {
    # Caller registers only mounts it created. Never lazy-unmount and then package
    # a still-busy filesystem. Leave the loop and scratch image for recovery on error.
    local index
    for ((index=${#PI_MOUNTS[@]}-1; index>=0; index--)); do
        umount --recursive "${PI_MOUNTS[index]}" || return 1
        unset 'PI_MOUNTS[index]'
    done
    if [[ -n "$PI_LOOP" ]]; then
        losetup --detach "$PI_LOOP" || return 1
        PI_LOOP=""
    fi
}
