#!/bin/bash
# Unprivileged, offline tests: fake files and mocked block/mount queries only.
# Never runs build-pi-image.sh beyond --help/input/architecture rejection.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
. scripts/iso/pi-image-lib.sh
. scripts/iso/image-build-lib.sh
. scripts/iso/pi-desktop-base.env
TEST_DIR="$(mktemp -d)"
trap 'python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1])" "$TEST_DIR"' EXIT
PASS=0
expect_ok() {
    "$@" || { echo "FAIL: expected success: $*" >&2; exit 1; }
    PASS=$((PASS + 1))
}
expect_fail() {
    if "$@"; then
        echo "FAIL: expected failure: $*" >&2; exit 1
    fi
    PASS=$((PASS + 1))
}

for user in ubuntu robot robot_team robot-01 a a1234567890123456789012345678901; do
    expect_ok questix_image_validate_user "$user"
done
for user in '' root oem Root 'robot team' 'robot/team' '../robot' '-robot' 'robot:1000' \
    'robot;touch /tmp/unwanted' 'robot$(id)' 'robot%u' $'robot\nroot' 'ロボット' \
    a12345678901234567890123456789012; do
    expect_fail questix_image_validate_user "$user"
done
accounts="$TEST_DIR/accounts"
mkdir -p "$accounts/etc"
printf 'root:x:0:0::/root:/bin/bash\ndaemon:x:1:1::/usr/sbin:/usr/sbin/nologin\n' > "$accounts/etc/passwd"
printf 'root:x:0:\ndaemon:x:1:\nadm:x:4:\n' > "$accounts/etc/group"
expect_ok questix_image_check_user_available "$accounts" robot
expect_fail questix_image_check_user_available "$accounts" daemon
expect_fail questix_image_check_user_available "$accounts" adm
printf 'ubuntu:x:1000:1000::/home/ubuntu:/bin/bash\n' >> "$accounts/etc/passwd"
printf 'ubuntu:x:1000:\n' >> "$accounts/etc/group"
expect_ok questix_image_check_user_available "$accounts" ubuntu
sed -i 's|/home/ubuntu|/root|' "$accounts/etc/passwd"
expect_fail questix_image_check_user_available "$accounts" ubuntu

base="$TEST_DIR/base.img.xz"
printf 'fixture base\n' > "$base"
digest="$(sha256sum "$base")"
digest="${digest%% *}"
expect_ok questix_pi_verify_base "$base" "$digest"
expect_fail questix_pi_verify_base "$base" "$PI_BASE_SHA256"
printf 'corrupted\n' >> "$base"
expect_fail questix_pi_verify_base "$base" "$digest"
ln -s "$base" "$TEST_DIR/link.img.xz"
expect_fail questix_pi_verify_base "$TEST_DIR/link.img.xz" "$digest"
expect_fail questix_pi_verify_base /dev/null "$digest"
expect_fail questix_pi_verify_base "$TEST_DIR/missing.img.xz" "$digest"
expect_fail questix_pi_verify_base "$base" malformed

cmdline="$TEST_DIR/cmdline.txt"
for rootarg in root=LABEL=writable root=UUID=abcd-ef01 root=PARTUUID=12345678-02; do
    printf 'console=tty1 %s rootfstype=ext4 rootwait\n' "$rootarg" > "$cmdline"
    expect_ok test "$(questix_pi_root_argument "$cmdline")" = "$rootarg"
done
for line in 'root=PARTUUID=XXXXXXXX-02' 'console=tty1' 'root=LABEL=writable root=UUID=123'; do
    printf '%s\n' "$line" > "$cmdline"
    expect_fail questix_pi_root_argument "$cmdline"
done

tree="$TEST_DIR/tree"
mkdir -p "$tree/boot/firmware" "$tree/etc/systemd/system" "$tree/etc/cloud" "$tree/etc/gdm3"
for file in config.txt vmlinuz initrd.img bcm2712-rpi-5-b.dtb; do
    printf 'fixture\n' > "$tree/boot/firmware/$file"
done
printf 'console=tty1 root=LABEL=writable rootwait\n' > "$tree/boot/firmware/cmdline.txt"
expect_ok questix_pi_check_boot "$tree" root=LABEL=writable
expect_fail questix_pi_check_boot "$tree" root=PARTUUID=other-02
printf ' systemd.unit=oem-config.target\n' >> "$tree/boot/firmware/cmdline.txt"
expect_fail questix_pi_check_boot "$tree" root=LABEL=writable
printf 'root=LABEL=writable\n' > "$tree/boot/firmware/cmdline.txt"
mv "$tree/boot/firmware/initrd.img" "$tree/initrd.saved"
expect_fail questix_pi_check_boot "$tree" root=LABEL=writable
mv "$tree/initrd.saved" "$tree/boot/firmware/initrd.img"

ln -s /usr/lib/systemd/system/graphical.target "$tree/etc/systemd/system/default.target"
for unit in oem-config.service oem-config.target; do
    ln -s /dev/null "$tree/etc/systemd/system/$unit"
done
touch "$tree/etc/cloud/cloud-init.disabled"
printf 'ubuntu:x:1000:1000::/home/ubuntu:/bin/bash\n' > "$tree/etc/passwd"
printf '[daemon]\nAutomaticLoginEnable=false\n' > "$tree/etc/gdm3/custom.conf"
expect_ok questix_pi_check_desktop "$tree"
printf 'TimedLoginEnable=True\n' >> "$tree/etc/gdm3/custom.conf"
expect_fail questix_pi_check_desktop "$tree"
sed -i '/TimedLoginEnable/d' "$tree/etc/gdm3/custom.conf"
printf 'oem:x:29999:29999::/home/oem:/bin/bash\n' >> "$tree/etc/passwd"
expect_fail questix_pi_check_desktop "$tree"
sed -i '/^oem:/d' "$tree/etc/passwd"
ln -sfn /usr/lib/systemd/system/oem-config.target "$tree/etc/systemd/system/default.target"
expect_fail questix_pi_check_desktop "$tree"

# Fake lsblk/blkid responses: arbitrary host devices and unrecognised layouts
# must fail before growpart/mount. No real block-device command is invoked.
lsblk() { printf '%s\n' "$MOCK_LAYOUT"; }
blkid() {
    case "$2:$5" in
        TYPE:/dev/loop42p1) echo "${MOCK_BOOT_TYPE:-vfat}" ;;
        LABEL:/dev/loop42p1) echo system-boot ;;
        TYPE:/dev/loop42p2) echo ext4 ;;
        LABEL:/dev/loop42p2) echo "${MOCK_ROOT_LABEL:-writable}" ;;
        *) return 1 ;;
    esac
}
MOCK_LAYOUT=$'/dev/loop42 loop\n/dev/loop42p1 part\n/dev/loop42p2 part'
expect_ok questix_pi_check_partitions /dev/loop42
expect_fail questix_pi_check_partitions /dev/sda
MOCK_BOOT_TYPE=ext4
expect_fail questix_pi_check_partitions /dev/loop42
unset MOCK_BOOT_TYPE
MOCK_ROOT_LABEL=other
expect_fail questix_pi_check_partitions /dev/loop42
unset MOCK_ROOT_LABEL
MOCK_LAYOUT+=$'\n/dev/loop42p3 part'
expect_fail questix_pi_check_partitions /dev/loop42
unset -f lsblk blkid

# Exercise teardown in reverse order and failure halfway through. A busy mount
# must prevent both detachment and subsequent compression, and remain retryable.
MOUNT_LOG="$TEST_DIR/mount.log"
umount() {
    printf 'umount %s\n' "$*" >> "$MOUNT_LOG"
    [[ "$2" != "${BUSY_MOUNT:-}" ]]
}
losetup() { printf 'losetup %s\n' "$*" >> "$MOUNT_LOG"; }
PI_LOOP=/dev/loop42
PI_MOUNTS=(/fake/root /fake/root/boot/firmware /fake/root/dev /fake/root/run)
expect_ok questix_pi_unmount
expect_ok test "${#PI_MOUNTS[@]}" = 0
expect_ok test -z "$PI_LOOP"
cat > "$TEST_DIR/expected.log" <<'EOF'
umount --recursive /fake/root/run
umount --recursive /fake/root/dev
umount --recursive /fake/root/boot/firmware
umount --recursive /fake/root
losetup --detach /dev/loop42
EOF
expect_ok cmp "$MOUNT_LOG" "$TEST_DIR/expected.log"
: > "$MOUNT_LOG"
PI_LOOP=/dev/loop42
PI_MOUNTS=(/fake/root /fake/root/dev /fake/root/run)
BUSY_MOUNT=/fake/root/dev
expect_fail questix_pi_unmount
expect_ok test "$PI_LOOP" = /dev/loop42
expect_ok test "${#PI_MOUNTS[@]}" = 2
expect_fail grep -q losetup "$MOUNT_LOG"
unset BUSY_MOUNT
expect_ok questix_pi_unmount
unset -f umount losetup

expect_ok bash scripts/build-pi-image.sh --help
expect_fail bash scripts/build-pi-image.sh "$base" "$TEST_DIR/output" root
expect_fail bash scripts/build-pi-image.sh "$base" "$TEST_DIR/output" ''
expect_fail bash scripts/build-pi-image.sh "$base" "$TEST_DIR/output"
expect_fail test -e "$TEST_DIR/output"
# The obsolete ARM64 ISO entry points reject before writing any work directories.
expect_fail bash scripts/build-iso.sh arm64 24.04 jazzy
expect_fail bash scripts/prepare-base-system.sh unused.iso arm64 24.04
expect_fail grep -q 'PARTUUID=XXXXXXXX\|gpio=2-27=op,dh\|cat > /boot/firmware' scripts/apply-ansible-config.sh
expect_fail test -e .github/workflows/build-iso.yml
expect_ok grep -q 'preinstalled-desktop-arm64+raspi.img.xz' scripts/iso/pi-desktop-base.env
printf 'Pi image contracts: %s passed (no root, network, mounts or image build).\n' "$PASS"
