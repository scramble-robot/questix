#!/bin/bash
# apply-ansible-config.sh
# Apply Ansible configuration to the chroot environment

set -e

ARCHITECTURE="$1"
ROS2_DISTRO="$2"

if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <architecture> <ros2_distro>"
    exit 1
fi

echo "🤖 Applying Ansible configuration for $ARCHITECTURE with ROS2 $ROS2_DISTRO"

WORK_DIR="/tmp/iso-work"
CHROOT_DIR="$WORK_DIR/chroot"
ANSIBLE_DIR="$(pwd)/ansible"
# First-boot enrollment (installed into the image by the final configuration below).
ISO_FILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/iso"

# Copy Ansible files to chroot
echo "📋 Copying Ansible files..."
mkdir -p "$CHROOT_DIR/tmp/ansible"
cp -r "$ANSIBLE_DIR"/* "$CHROOT_DIR/tmp/ansible/"

# Create inventory for localhost
cat > "$CHROOT_DIR/tmp/ansible/localhost_inventory.ini" << EOF
[localhost]
127.0.0.1 ansible_connection=local ansible_python_interpreter=/usr/bin/python3

[localhost:vars]
ansible_user=root
ansible_become=false
EOF

# Install Ansible in chroot
echo "📦 Installing Ansible in chroot environment..."
chroot "$CHROOT_DIR" /bin/bash << CHROOT_EOF
export HOME=/root
export LC_ALL=C
export DEBIAN_FRONTEND=noninteractive

# Update package lists
apt-get update

# Install Ansible
apt-get install -y python3-pip python3-dev
pip3 install ansible

# Verify Ansible installation
ansible --version
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
export HOME=/root
export LC_ALL=C
export DEBIAN_FRONTEND=noninteractive

cd /tmp/ansible

# Set target user as ubuntu (created in base system preparation)
export ANSIBLE_REMOTE_USER=ubuntu

# Run the playbook. SSH: the playbooks do not manage it (prepare-base-system.sh installs
# openssh-server; the units are disabled below, and the image enables remote login only after the
# first-boot enrollment set a password). No autologin: the first login of the image is the
# console enrollment.
ansible-playbook \
    -i localhost_inventory.ini \
    -e "ros2_distro=$ROS2_DISTRO" \
    -e "enable_autologin=false" \
    -e "ansible_user=ubuntu" \
    -e "ansible_env={'HOME': '/home/ubuntu'}" \
    --connection=local \
    playbooks/$PLAYBOOK

# Clean up Ansible installation to save space
pip3 uninstall -y ansible
apt-get remove -y python3-dev
apt-get autoremove -y
apt-get clean
rm -rf /var/lib/apt/lists/*
rm -rf /tmp/ansible
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
install -D -o root -g root -m 0755 "$ISO_FILES_DIR/questix-first-boot-enroll.sh" \
    "$CHROOT_DIR/usr/local/sbin/questix-first-boot-enroll"
install -D -o root -g root -m 0644 "$ISO_FILES_DIR/questix-first-boot.service" \
    "$CHROOT_DIR/etc/systemd/system/questix-first-boot.service"
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

# Refuse to produce an image that breaks the policy.
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

echo "✅ Ansible configuration applied successfully"
echo "🎯 System configured for $ARCHITECTURE with ROS2 $ROS2_DISTRO"
