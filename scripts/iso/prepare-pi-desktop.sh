#!/bin/bash
# Executed ONLY inside the fresh official Pi Desktop image by build-pi-image.sh.
# Replaces Ubuntu's OEM user-creation flow with QUESTiX console enrollment.
set -euo pipefail

[[ "${1:-}" = --inside-questix-image && -f /run/questix-pi-image-build ]] || {
    echo "Run scripts/build-pi-image.sh; this helper is only for its chroot" >&2
    exit 1
}
# Installed in the private /run by the outer builder; shared validation is also
# repeated inside the image so no existing system identity can be repurposed.
. /run/questix-image-build-lib.sh
IMAGE_USER="${2-ubuntu}"
questix_image_check_user_available / "$IMAGE_USER"
export DEBIAN_FRONTEND=noninteractive
export LC_ALL=C.UTF-8

[[ "$(dpkg --print-architecture)" = arm64 ]]
# Retain the actual Desktop and Pi kernel stacks through Ansible's autoremove.
for package in ubuntu-desktop ubuntu-desktop-raspi ubuntu-raspi-settings-desktop linux-image-raspi gdm3; do
    [[ "$(dpkg-query -W -f='${db:Status-Status}' "$package")" = installed ]]
    apt-mark manual "$package"
done

# Disable the OEM target before creating the permanent robot user. It conflicts
# with multi-user.target and would otherwise bypass QUESTiX enrollment.
for unit in oem-config.service oem-config.target; do
    systemctl disable "$unit"
    ln -sfn /dev/null "/etc/systemd/system/$unit"
done
ln -sfn /usr/lib/systemd/system/graphical.target /etc/systemd/system/default.target
if getent passwd oem > /dev/null; then
    userdel --remove oem
fi
rm -f /etc/sudoers.d/oem /etc/sudoers.d/99_oem /var/lib/oem-config/run
# cloud-init must not recreate users/passwords/SSH settings from the boot volume.
# Desktop's growroot-almost (ubuntu-raspi-settings-desktop) remains installed.
mkdir -p /etc/cloud
touch /etc/cloud/cloud-init.disabled

apt-get update
apt-get install -y software-properties-common curl wget gnupg lsb-release \
    ca-certificates python3 python3-pip sudo openssh-server network-manager git
groupadd -f gpio
# Expose /dev/i2c-* after boot; SPI devices bind through the firmware's SPI overlay.
# Write configuration only: never load host modules while building the image.
mkdir -p /etc/modules-load.d
printf 'i2c-dev\n' > /etc/modules-load.d/questix-i2c.conf
questix_image_check_user_available / "$IMAGE_USER"
if ! getent passwd "$IMAGE_USER" > /dev/null; then
    useradd -m -U -d "/home/$IMAGE_USER" -s /bin/bash "$IMAGE_USER"
fi
usermod -aG sudo,adm,dialout,audio,video,plugdev,netdev,gpio "$IMAGE_USER"
passwd -l "$IMAGE_USER"
# If the official base ever includes ubuntu as well, keep that unused account locked.
if [[ "$IMAGE_USER" != ubuntu ]] && getent passwd ubuntu > /dev/null; then
    passwd -l ubuntu
fi
passwd -l root
# Known provisioning rules only. Unexpected NOPASSWD grants fail final checks.
rm -f /etc/sudoers.d/90-cloud-init-users /etc/sudoers.d/ubuntu
rm -f /usr/share/applications/oem-config-prepare-gtk.desktop

# The upstream desktop can carry OEM autologin settings. Keep the rest of GDM's
# configuration; enrollment precedes display-manager.service on the first boot.
sed -i -E 's/^([[:space:]]*)(Automatic|Timed)LoginEnable[[:space:]]*=.*/\1\2LoginEnable=false/' \
    /etc/gdm3/custom.conf
for unit in ssh.socket ssh.service; do
    systemctl disable "$unit"
done
printf 'questix-robot\n' > /etc/hostname
sed -i -E 's/^127\.0\.1\.1[[:space:]].*/127.0.1.1 questix-robot/' /etc/hosts
