#!/bin/bash
# Build a local QUESTiX Desktop SD image from the pinned official Ubuntu image.
# Root/mount/chroot work happens only on a NEW scratch file in a private mount
# namespace. No physical SD device is accepted and no image is uploaded.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=iso/pi-desktop-base.env
. "$SCRIPT_DIR/iso/pi-desktop-base.env"
# shellcheck source=iso/pi-image-lib.sh
. "$SCRIPT_DIR/iso/pi-image-lib.sh"
# shellcheck source=iso/image-build-lib.sh
. "$SCRIPT_DIR/iso/image-build-lib.sh"

usage() {
    cat <<EOF
Usage: sudo bash $0 BASE.img.xz OUTPUT_DIRECTORY [IMAGE_USER]

Local Pi 5 Desktop image build (Ubuntu 24.04, ROS 2 Jazzy).
Download the official base yourself:
  $PI_BASE_URL
SHA-256: $PI_BASE_SHA256

The input is read-only. Output is a new .img.xz plus manifest and SHA-256.
IMAGE_USER: login/service account, default ubuntu; password is set on first boot.
Requires a committed checkout, root, loop mounts, chroot, network access,
and ~40 GiB free disk space. See scripts/iso/README.md for dependencies.
QUESTIX_PI_SIZE_GIB: raw image size, default 24 (use a 32 GB or larger SD).
AMD64 hosts need qemu-aarch64 binfmt registered with the F flag in advance.
This script does not flash an SD, publish artifacts, or install host packages.
EOF
}
if [[ "${1:-}" = --help || "${1:-}" = -h ]]; then
    usage
    exit 0
fi
[[ $# = 2 || $# = 3 ]] || { usage >&2; exit 2; }
IMAGE_USER="${3-ubuntu}"
questix_image_validate_user "$IMAGE_USER"
questix_pi_verify_base "$1" "$PI_BASE_SHA256"
BASE_IMAGE="$(realpath "$1")"
[[ "$(id -u)" = 0 ]] || { echo "Root is required for loop mounts/chroot" >&2; exit 1; }
SIZE_GIB="${QUESTIX_PI_SIZE_GIB:-24}"
[[ "$SIZE_GIB" =~ ^[1-9][0-9]{1,2}$ && "$SIZE_GIB" -ge 16 && "$SIZE_GIB" -le 256 ]] || {
    echo "QUESTIX_PI_SIZE_GIB must be an integer from 16 to 256" >&2; exit 1;
}
for tool in unshare losetup lsblk blkid growpart e2fsck resize2fs mount umount \
    mountpoint chroot xz dd truncate git tar sha256sum findmnt udevadm; do
    command -v "$tool" > /dev/null || { echo "Missing build tool: $tool" >&2; exit 1; }
done
case "$(uname -m)" in
    aarch64) ;;
    x86_64)
        grep -q '^enabled' /proc/sys/fs/binfmt_misc/qemu-aarch64 \
            && grep -q '^flags:.*F' /proc/sys/fs/binfmt_misc/qemu-aarch64 || {
            echo "Register qemu-aarch64 binfmt with flag F before building" >&2; exit 1;
        }
        ;;
    *) echo "Supported build hosts: aarch64 or x86_64 Linux" >&2; exit 1 ;;
esac
# The shared source installer copies HEAD, not uncommitted edits. Refuse a mixed
# recipe/source build and record precisely that commit in the artifact metadata.
git -c safe.directory="$REPO_ROOT" -C "$REPO_ROOT" diff --quiet HEAD -- || {
    echo "Commit tracked changes before building (the image installs HEAD)" >&2; exit 1;
}
SOURCE_COMMIT="$(git -c safe.directory="$REPO_ROOT" -C "$REPO_ROOT" rev-parse HEAD)"

if [[ "${QUESTIX_PI_MOUNT_NAMESPACE:-}" != 1 ]]; then
    exec unshare --mount --propagation private env QUESTIX_PI_MOUNT_NAMESPACE=1 \
        bash "$0" "$BASE_IMAGE" "$2" "$IMAGE_USER"
fi

mkdir -p "$2"
OUTPUT_DIR="$(realpath "$2")"
[[ -d "$OUTPUT_DIR" && ! -L "$2" ]] || exit 1
IMAGE_NAME="questix-pi5-desktop-ubuntu${PI_BASE_VERSION}-ros2jazzy-${IMAGE_USER}-${SOURCE_COMMIT:0:12}"
# A distinct result directory avoids overwriting previous images or accepting
# symlink destinations. It is renamed into place only after successful packaging.
[[ ! -e "$OUTPUT_DIR/$IMAGE_NAME" && ! -L "$OUTPUT_DIR/$IMAGE_NAME" ]] || {
    echo "Output already exists: $OUTPUT_DIR/$IMAGE_NAME" >&2; exit 1;
}
WORK_DIR="$(mktemp -d "$OUTPUT_DIR/.questix-pi-build.XXXXXXXX")"
CHROOT_DIR="$WORK_DIR/root"
RAW_IMAGE="$WORK_DIR/disk.img"
PI_LOOP=""
PI_MOUNTS=()
cleanup() {
    local status=$?
    trap - EXIT
    if ! questix_pi_unmount; then
        echo "Cleanup failed; retained loop $PI_LOOP and scratch $WORK_DIR. Do not delete mounted files." >&2
        status=1
    fi
    if [[ $status != 0 ]]; then
        echo "Build failed. Scratch retained at $WORK_DIR; no finished image was published." >&2
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$CHROOT_DIR" "$WORK_DIR/result"

echo "Expanding verified Ubuntu Desktop base into $RAW_IMAGE"
xz -dc -- "$BASE_IMAGE" | dd of="$RAW_IMAGE" bs=4M conv=sparse status=progress
[[ "$(stat -c %s "$RAW_IMAGE")" -lt $((SIZE_GIB * 1024 * 1024 * 1024)) ]] || {
    echo "Requested image size must exceed the base image size" >&2; exit 1;
}
truncate -s "${SIZE_GIB}G" "$RAW_IMAGE"
PI_LOOP="$(losetup --find --show --partscan "$RAW_IMAGE")"
udevadm settle --timeout=30
questix_pi_check_partitions "$PI_LOOP" || { echo "Unsupported Pi image partition layout" >&2; exit 1; }
growpart "$PI_LOOP" 2
udevadm settle --timeout=30
# e2fsck returns 1 for corrected errors; all other nonzero statuses stop the build.
fsck_status=0
e2fsck -pf "${PI_LOOP}p2" || fsck_status=$?
[[ $fsck_status -le 1 ]]
resize2fs "${PI_LOOP}p2"

mount "${PI_LOOP}p2" "$CHROOT_DIR"
PI_MOUNTS+=("$CHROOT_DIR")
mount "${PI_LOOP}p1" "$CHROOT_DIR/boot/firmware"
PI_MOUNTS+=("$CHROOT_DIR/boot/firmware")
ROOT_ARGUMENT="$(questix_pi_root_argument "$CHROOT_DIR/boot/firmware/cmdline.txt")"
questix_pi_check_boot "$CHROOT_DIR" "$ROOT_ARGUMENT"
cp "$CHROOT_DIR/boot/firmware/config.txt" "$WORK_DIR/result/base-config.txt"
cp "$CHROOT_DIR/boot/firmware/cmdline.txt" "$WORK_DIR/result/base-cmdline.txt"

mount -t proc proc "$CHROOT_DIR/proc"
PI_MOUNTS+=("$CHROOT_DIR/proc")
mount -t sysfs -o ro sysfs "$CHROOT_DIR/sys"
PI_MOUNTS+=("$CHROOT_DIR/sys")
mount --rbind /dev "$CHROOT_DIR/dev"
PI_MOUNTS+=("$CHROOT_DIR/dev")
# /dev/pts and any other nested /dev mounts are handled as a recursive unit.
mount --make-rslave "$CHROOT_DIR/dev"
mount -t tmpfs tmpfs "$CHROOT_DIR/run"
PI_MOUNTS+=("$CHROOT_DIR/run")
touch "$CHROOT_DIR/run/questix-pi-image-build"
cp "$SCRIPT_DIR/iso/image-build-lib.sh" "$CHROOT_DIR/run/questix-image-build-lib.sh"

# Do not follow the image's absolute resolv.conf symlink into the host. Save it
# verbatim, then supply a regular file for chroot DNS, restoring it before packing.
if [[ -e "$CHROOT_DIR/etc/resolv.conf" || -L "$CHROOT_DIR/etc/resolv.conf" ]]; then
    mv "$CHROOT_DIR/etc/resolv.conf" "$WORK_DIR/resolv.conf"
fi
cp -L /etc/resolv.conf "$CHROOT_DIR/etc/resolv.conf"
if [[ -e "$CHROOT_DIR/usr/sbin/policy-rc.d" || -L "$CHROOT_DIR/usr/sbin/policy-rc.d" ]]; then
    mv "$CHROOT_DIR/usr/sbin/policy-rc.d" "$WORK_DIR/policy-rc.d"
fi
printf '#!/bin/sh\nexit 101\n' > "$CHROOT_DIR/usr/sbin/policy-rc.d"
chmod 0755 "$CHROOT_DIR/usr/sbin/policy-rc.d"
export SYSTEMD_OFFLINE=1
chroot "$CHROOT_DIR" /bin/bash -s -- --inside-questix-image "$IMAGE_USER" < "$SCRIPT_DIR/iso/prepare-pi-desktop.sh"
bash "$SCRIPT_DIR/apply-ansible-config.sh" arm64 jazzy "$CHROOT_DIR" "$IMAGE_USER"

questix_image_verify_security "$CHROOT_DIR" "$IMAGE_USER"
questix_pi_check_desktop "$CHROOT_DIR"
questix_pi_check_boot "$CHROOT_DIR" "$ROOT_ARGUMENT"
# Final desktop/firmware package checks run even after Ansible autoremove.
chroot "$CHROOT_DIR" /bin/bash -e <<'DESKTOP_CHECK'
for package in ubuntu-desktop ubuntu-desktop-raspi ubuntu-raspi-settings-desktop linux-image-raspi gdm3; do
    test "$(dpkg-query -W -f='${db:Status-Status}' "$package")" = installed
done
DESKTOP_CHECK
chroot "$CHROOT_DIR" dpkg-query -W \
    '-f=${binary:Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\n' \
    > "$WORK_DIR/result/packages.tsv"
cp "$CHROOT_DIR/boot/firmware/config.txt" "$WORK_DIR/result/config.txt"
cp "$CHROOT_DIR/boot/firmware/cmdline.txt" "$WORK_DIR/result/cmdline.txt"
cat > "$WORK_DIR/result/build-info.txt" <<EOF
QUESTiX local Pi 5 Desktop image
base_url=$PI_BASE_URL
base_sha256=$PI_BASE_SHA256
source_commit=$SOURCE_COMMIT
image_user=$IMAGE_USER
workspace=/home/$IMAGE_USER/questix
ros_distro=jazzy
raw_size_gib=$SIZE_GIB
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
hardware_validation=not_performed_by_builder
EOF
# Keep upstream copyright/license files in the image, and a convenient copy of
# Debian package notices beside it. This is NOT a substitute for corresponding
# source or permission to redistribute a modified Ubuntu image.
(cd "$CHROOT_DIR" && tar -czf "$WORK_DIR/result/package-copyrights.tar.gz" \
    usr/share/doc/*/copyright)

rm -f "$CHROOT_DIR/etc/resolv.conf" "$CHROOT_DIR/usr/sbin/policy-rc.d"
for saved in resolv.conf policy-rc.d; do
    if [[ -e "$WORK_DIR/$saved" || -L "$WORK_DIR/$saved" ]]; then
        case "$saved" in
            resolv.conf) mv "$WORK_DIR/$saved" "$CHROOT_DIR/etc/resolv.conf" ;;
            policy-rc.d) mv "$WORK_DIR/$saved" "$CHROOT_DIR/usr/sbin/policy-rc.d" ;;
        esac
    fi
done
# These belong to each installed robot, not to the shared local build.
rm -f "$CHROOT_DIR"/etc/ssh/ssh_host_* "$CHROOT_DIR/var/lib/systemd/random-seed"
rm -f "$CHROOT_DIR/var/lib/dbus/machine-id"
: > "$CHROOT_DIR/etc/machine-id"
ln -s /etc/machine-id "$CHROOT_DIR/var/lib/dbus/machine-id"
sync
questix_pi_unmount
# Compression starts only when every mount and the loop are successfully released.
xz -T2 -3 -c "$RAW_IMAGE" > "$WORK_DIR/result/$IMAGE_NAME.img.xz"
(cd "$WORK_DIR/result" && sha256sum "$IMAGE_NAME.img.xz" packages.tsv \
    build-info.txt package-copyrights.tar.gz config.txt cmdline.txt \
    base-config.txt base-cmdline.txt > SHA256SUMS)
mv -T "$WORK_DIR/result" "$OUTPUT_DIR/$IMAGE_NAME"
rm "$RAW_IMAGE"
rmdir "$CHROOT_DIR" "$WORK_DIR"
trap - EXIT INT TERM
echo "Created $OUTPUT_DIR/$IMAGE_NAME"
echo "Verify SHA256SUMS, then use Raspberry Pi Imager 'Use custom' on your own 32 GB+ SD."
echo "Pi 5 hardware validation is still required; this builder does not redistribute images."
