#!/bin/bash
# prepare-base-system.sh
# Extract and prepare Ubuntu base system for customization

set -e

ISO_FILE="$1"
ARCHITECTURE="$2"
UBUNTU_VERSION="$3"

if [ "$#" -ne 3 ]; then
    echo "Usage: $0 <iso_file> <architecture> <ubuntu_version>"
    exit 1
fi

echo "🔧 Preparing base system for $ARCHITECTURE architecture, Ubuntu $UBUNTU_VERSION"

# Create working directories
WORK_DIR="/tmp/iso-work"
CHROOT_DIR="$WORK_DIR/chroot"
ISO_EXTRACT_DIR="$WORK_DIR/iso-extract"

mkdir -p "$WORK_DIR" "$CHROOT_DIR" "$ISO_EXTRACT_DIR"

# Extract ISO contents
echo "📦 Extracting ISO contents..."
if command -v 7z >/dev/null 2>&1; then
    7z x "$ISO_FILE" -o"$ISO_EXTRACT_DIR"
else
    # Mount and copy ISO contents
    MOUNT_POINT="/tmp/iso-mount"
    mkdir -p "$MOUNT_POINT"
    mount -o loop "$ISO_FILE" "$MOUNT_POINT"
    cp -rT "$MOUNT_POINT" "$ISO_EXTRACT_DIR"
    umount "$MOUNT_POINT"
    rmdir "$MOUNT_POINT"
fi

# Extract squashfs filesystem
echo "🗂️  Extracting squashfs filesystem..."
if [ -f "$ISO_EXTRACT_DIR/casper/filesystem.squashfs" ]; then
    unsquashfs -d "$CHROOT_DIR" "$ISO_EXTRACT_DIR/casper/filesystem.squashfs"
elif [ -f "$ISO_EXTRACT_DIR/live/filesystem.squashfs" ]; then
    unsquashfs -d "$CHROOT_DIR" "$ISO_EXTRACT_DIR/live/filesystem.squashfs"
else
    echo "❌ Could not find filesystem.squashfs"
    exit 1
fi

# Set up chroot environment
echo "🏗️  Setting up chroot environment..."

# Copy DNS resolution
cp /etc/resolv.conf "$CHROOT_DIR/etc/"

# Set up QEMU for cross-architecture support
if [ "$ARCHITECTURE" = "arm64" ] && [ "$(uname -m)" = "x86_64" ]; then
    echo "🔄 Setting up QEMU for ARM64 emulation..."
    cp /usr/bin/qemu-aarch64-static "$CHROOT_DIR/usr/bin/"
    update-binfmts --enable qemu-aarch64
fi

# Mount necessary filesystems
mount -t proc none "$CHROOT_DIR/proc"
mount -t sysfs none "$CHROOT_DIR/sys"
mount -o bind /dev "$CHROOT_DIR/dev"
mount -o bind /dev/pts "$CHROOT_DIR/dev/pts"

# Create cleanup script
cat > "$WORK_DIR/cleanup.sh" << 'EOF'
#!/bin/bash
CHROOT_DIR="/tmp/iso-work/chroot"

# Unmount filesystems
umount "$CHROOT_DIR/proc" 2>/dev/null || true
umount "$CHROOT_DIR/sys" 2>/dev/null || true
umount "$CHROOT_DIR/dev/pts" 2>/dev/null || true
umount "$CHROOT_DIR/dev" 2>/dev/null || true

echo "🧹 Cleanup completed"
EOF

chmod +x "$WORK_DIR/cleanup.sh"

# Prepare chroot environment
chroot "$CHROOT_DIR" /bin/bash << 'CHROOT_EOF'
export HOME=/root
export LC_ALL=C
export DEBIAN_FRONTEND=noninteractive

# Update package lists
apt-get update

# Install essential packages
apt-get install -y \
    software-properties-common \
    curl \
    wget \
    gnupg \
    lsb-release \
    ca-certificates \
    python3 \
    python3-pip \
    sudo \
    openssh-server \
    network-manager

# Create default user for ROS2. No password is baked into the image: the account stays locked
# (and SSH disabled) until someone sets a password at the robot's console on first boot
# (scripts/iso/questix-first-boot-enroll.sh, enabled by scripts/apply-ansible-config.sh).
# sudo asks for that password: the image has no NOPASSWD rule.
useradd -m -s /bin/bash -G sudo,adm,dialout,cdrom,floppy,audio,dip,video,plugdev,netdev,gpio ubuntu
passwd -l ubuntu

# SSH: the package only. Remote login is enabled by the first-boot enrollment, not here.
mkdir -p /home/ubuntu/.ssh
chown ubuntu:ubuntu /home/ubuntu/.ssh
chmod 700 /home/ubuntu/.ssh

# Set hostname
echo "ros2-robotics-kit" > /etc/hostname

# Clean package cache
apt-get clean
rm -rf /var/lib/apt/lists/*

exit 0
CHROOT_EOF

echo "✅ Base system preparation completed"
echo "📁 Chroot directory: $CHROOT_DIR"
echo "📁 ISO extract directory: $ISO_EXTRACT_DIR"
echo "🧹 Run '$WORK_DIR/cleanup.sh' when finished"
