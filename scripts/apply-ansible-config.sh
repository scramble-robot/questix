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

# Run the playbook
ansible-playbook \
    -i localhost_inventory.ini \
    -e "ros2_distro=$ROS2_DISTRO" \
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
chroot "$CHROOT_DIR" /bin/bash << 'CHROOT_EOF'
export HOME=/root
export LC_ALL=C
export DEBIAN_FRONTEND=noninteractive

# Enable services
systemctl enable ssh
systemctl enable NetworkManager

# Configure automatic login for first boot setup
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf << 'AUTOLOGIN_EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin ubuntu --noclear %I $TERM
AUTOLOGIN_EOF

# Create first boot setup script
cat > /home/ubuntu/first-boot-setup.sh << 'SETUP_EOF'
#!/bin/bash
echo "🤖 Welcome to ROS2 Robotics Kit!"
echo "📍 This system is pre-configured with ROS2 and robotics tools."
echo ""
echo "💡 Quick start:"
echo "  - ROS2 workspace: ~/robot_ws (use 'rw' alias)"
echo "  - Test ROS2: ros2 topic list"
echo "  - Check hardware: gpio_status"
echo ""
echo "🔧 First-time setup:"
echo "  1. Change password: passwd"
echo "  2. Configure WiFi: sudo nmtui"
echo "  3. Update system: sudo apt update && sudo apt upgrade"
echo ""
echo "📚 Documentation: https://github.com/your-repo/questix_core"

# Disable autologin after first boot
sudo rm -f /etc/systemd/system/getty@tty1.service.d/autologin.conf
sudo systemctl daemon-reload

# Remove this script
rm -f /home/ubuntu/first-boot-setup.sh
SETUP_EOF

chmod +x /home/ubuntu/first-boot-setup.sh
chown ubuntu:ubuntu /home/ubuntu/first-boot-setup.sh

# Add first boot setup to .bashrc
echo "" >> /home/ubuntu/.bashrc
echo "# First boot setup" >> /home/ubuntu/.bashrc
echo "if [ -f ~/first-boot-setup.sh ]; then" >> /home/ubuntu/.bashrc
echo "    ~/first-boot-setup.sh" >> /home/ubuntu/.bashrc
echo "fi" >> /home/ubuntu/.bashrc

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
