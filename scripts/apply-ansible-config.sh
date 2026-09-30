#!/bin/bash
# apply-ansible-config.sh
# Apply the QUESTiX Ansible configuration to the custom image's chroot (after
# scripts/prepare-base-system.sh, before scripts/build-iso.sh).
#
# The image is built from the checkout this script is in (not from the current directory: the
# workflow runs it from /tmp/iso-build): that commit is cloned to /home/ubuntu/questix in the
# image and the playbook runs from there, so the workspace is built in the image (a first boot
# needs no download) and Robot Manager, its QUESTiX Local helper and the legacy cleanup are the
# same revision. The playbook runs as root in the chroot with questix_image_build=true: the kit
# user's own tasks (home, workspace import and build) become that user, services are enabled but
# not started, and systemd/udev are not reloaded (none runs in a chroot). Functions:
# scripts/iso/image-build-lib.sh (contract-tested by ansible/tests/test_image_build_contract.sh).

set -e

ARCHITECTURE="$1"
ROS2_DISTRO="$2"

if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <architecture> <ros2_distro>"
    exit 1
fi

echo "🤖 Applying Ansible configuration for $ARCHITECTURE with ROS2 $ROS2_DISTRO"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ISO_FILES_DIR="$SCRIPT_DIR/iso"
WORK_DIR="/tmp/iso-work"
CHROOT_DIR="$WORK_DIR/chroot"
IMAGE_USER=ubuntu
IMAGE_SOURCE="/home/$IMAGE_USER/questix"
# Ansible for the build only, in a venv removed afterwards (Ubuntu 24.04's pip refuses the system
# Python, PEP 668). The same version as .github/workflows/ansible-check.yaml.
IMAGE_ANSIBLE_VENV=/opt/questix-image-ansible
IMAGE_ANSIBLE_VERSION=14.2.0

# shellcheck source=iso/image-build-lib.sh
. "$ISO_FILES_DIR/image-build-lib.sh"

echo "📋 Installing the QUESTiX source into the image..."
questix_image_install_source "$REPO_ROOT" "$CHROOT_DIR" "$IMAGE_USER"

# Local inventory. No ansible_become here: an inventory variable would override the play's
# `become` and every task's own become, including the kit user's tasks.
printf '%s\n' '[localhost]' \
    '127.0.0.1 ansible_connection=local ansible_python_interpreter=/usr/bin/python3' \
    > "$CHROOT_DIR/tmp/questix-image-inventory.ini"

echo "📦 Installing Ansible $IMAGE_ANSIBLE_VERSION in the chroot (build only)..."
chroot "$CHROOT_DIR" /bin/bash << CHROOT_EOF
set -e
export HOME=/root
export LC_ALL=C
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3-venv sudo git
python3 -m venv "$IMAGE_ANSIBLE_VENV"
"$IMAGE_ANSIBLE_VENV/bin/pip" install --quiet "ansible==$IMAGE_ANSIBLE_VERSION"
"$IMAGE_ANSIBLE_VENV/bin/ansible" --version
CHROOT_EOF

# Apply appropriate playbook based on architecture
if [ "$ARCHITECTURE" = "arm64" ]; then
    PLAYBOOK="setup_kit.yaml"
    echo "🍓 Applying Raspberry Pi 5 robotics kit configuration..."
else
    PLAYBOOK="setup_dev.yaml"
    echo "💻 Applying development environment configuration..."
fi

# Run Ansible playbook
echo "🚀 Running Ansible playbook: $PLAYBOOK"
chroot "$CHROOT_DIR" /bin/bash << CHROOT_EOF
set -e
export HOME=/root
export LC_ALL=C
export DEBIAN_FRONTEND=noninteractive
cd "$IMAGE_SOURCE/ansible"

# SSH: the playbooks do not manage it (prepare-base-system.sh installs openssh-server; the units
# are disabled below, and the image enables remote login only after the first-boot enrollment set
# a password). No autologin: the first login of the image is the console enrollment.
# questix_image_build: see the header of this script.
"$IMAGE_ANSIBLE_VENV/bin/ansible-playbook" \
    -i /tmp/questix-image-inventory.ini \
    -e "ros2_distro=$ROS2_DISTRO" \
    -e "questix_image_build=true" \
    -e "enable_autologin=false" \
    -e "ansible_user=$IMAGE_USER" \
    -e "workspace_path=$IMAGE_SOURCE" \
    -e "ansible_env={'HOME': '/home/$IMAGE_USER'}" \
    --connection=local \
    "playbooks/$PLAYBOOK"

# The build's Ansible is not part of the image.
rm -rf "$IMAGE_ANSIBLE_VENV" /tmp/questix-image-inventory.ini
rm -rf /root/.ansible "/home/$IMAGE_USER/.ansible"
apt-get autoremove -y
apt-get clean
rm -rf /var/lib/apt/lists/*
CHROOT_EOF

# Post-configuration for robotics kit
if [ "$ARCHITECTURE" = "arm64" ]; then
    echo "🔧 Applying Raspberry Pi 5 specific configurations..."

    # Configure boot settings for Raspberry Pi
    chroot "$CHROOT_DIR" /bin/bash << 'CHROOT_EOF'
# Enable necessary modules
echo "i2c-dev" >> /etc/modules
echo "spi-dev" >> /etc/modules

# Create firmware config for Raspberry Pi
mkdir -p /boot/firmware
cat > /boot/firmware/config.txt << 'CONFIG_EOF'
# ROS2 Robotics Kit Configuration for Raspberry Pi 5

# Enable hardware interfaces
dtparam=i2c_arm=on
dtparam=spi=on
dtparam=audio=on

# GPIO configuration
gpio=2-27=op,dh

# Camera support
start_x=1
gpu_mem=128

# Performance optimizations
arm_boost=1
over_voltage=2
arm_freq=2400

# USB configuration
max_usb_current=1
CONFIG_EOF

# Create cmdline.txt
echo "console=serial0,115200 console=tty1 root=PARTUUID=XXXXXXXX-02 rootfstype=ext4 elevator=deadline fsck.repair=yes rootwait cgroup_enable=cpuset cgroup_enable=memory cgroup_memory=1" > /boot/firmware/cmdline.txt
CHROOT_EOF

    echo "🍓 Raspberry Pi 5 configuration completed"
fi

# Final system configuration
echo "🔧 Applying final system configuration..."
questix_image_install_first_boot "$ISO_FILES_DIR" "$CHROOT_DIR"
chroot "$CHROOT_DIR" /bin/bash << 'CHROOT_EOF'
set -e
export HOME=/root
export LC_ALL=C
export DEBIAN_FRONTEND=noninteractive

systemctl enable NetworkManager

# First-enrollment policy, whatever the roles above did: no known password (the account is
# locked), no NOPASSWD rule, no console autologin, SSH installed but not enabled. The console
# enrollment unit sets the password, then enables SSH and disables itself.
passwd -l ubuntu
rm -f /etc/sudoers.d/ubuntu
rm -f /etc/systemd/system/getty@tty1.service.d/autologin.conf
for unit in ssh.socket ssh.service; do
    if [ -e "/usr/lib/systemd/system/$unit" ]; then
        systemctl disable "$unit"
    fi
done
systemctl enable questix-first-boot.service

# Refuse to produce an image that breaks the policy (inside the chroot; the same checks run
# again on the file tree after this block).
visudo -cf /etc/sudoers
if grep -rqs 'NOPASSWD' /etc/sudoers /etc/sudoers.d; then
    echo "❌ A NOPASSWD sudo rule is in the image" >&2
    exit 1
fi
if [ "$(passwd -S ubuntu | awk '{print $2}')" != L ]; then
    echo "❌ The ubuntu account is not locked" >&2
    exit 1
fi
if grep -qsE '^[[:space:]]*AutomaticLoginEnable[[:space:]]*=[[:space:]]*[Tt]rue' /etc/gdm3/custom.conf; then
    echo "❌ Desktop autologin is enabled in the image" >&2
    exit 1
fi
if systemctl is-enabled --quiet ssh.socket 2> /dev/null || systemctl is-enabled --quiet ssh.service 2> /dev/null; then
    echo "❌ SSH is enabled before the first-boot enrollment" >&2
    exit 1
fi
if [ "$(systemctl is-enabled questix-first-boot.service)" != enabled ]; then
    echo "❌ questix-first-boot.service is not enabled" >&2
    exit 1
fi

# Final cleanup
apt-get clean
rm -rf /var/lib/apt/lists/*
rm -rf /tmp/*
rm -rf /var/tmp/*

# Clear bash history
history -c
rm -f /root/.bash_history
rm -f /home/ubuntu/.bash_history

exit 0
CHROOT_EOF

# The same postconditions again from outside, on the file tree the image is made of.
questix_image_verify_security "$CHROOT_DIR" "$IMAGE_USER" \
    || { echo "❌ The image does not meet the first-enrollment policy" >&2; exit 1; }

echo "✅ Ansible configuration applied successfully"
echo "🎯 System configured for $ARCHITECTURE with ROS2 $ROS2_DISTRO"
