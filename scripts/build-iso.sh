#!/bin/bash
# build-iso.sh
# Build custom ISO from prepared chroot environment

set -e

ARCHITECTURE="$1"
UBUNTU_VERSION="$2"
ROS2_DISTRO="$3"

if [ "$#" -ne 3 ]; then
    echo "Usage: $0 <architecture> <ubuntu_version> <ros2_distro>"
    exit 1
fi

# Pi 5 uses a preinstalled Desktop disk image, never this UEFI ISO path.
if [ "$ARCHITECTURE" != amd64 ]; then
    echo "Use scripts/build-pi-image.sh for Raspberry Pi 5 Desktop (.img.xz)" >&2
    exit 1
fi

echo "🏗️  Building ISO for $ARCHITECTURE, Ubuntu $UBUNTU_VERSION, ROS2 $ROS2_DISTRO"

WORK_DIR="/tmp/iso-work"
CHROOT_DIR="$WORK_DIR/chroot"
ISO_EXTRACT_DIR="$WORK_DIR/iso-extract"
NEW_ISO_DIR="$WORK_DIR/new-iso"
OUTPUT_DIR="/tmp/iso-output"

# Create new ISO directory structure
echo "📁 Creating ISO directory structure..."
mkdir -p "$NEW_ISO_DIR"
cp -rT "$ISO_EXTRACT_DIR" "$NEW_ISO_DIR"

# Create manifest
echo "📝 Creating manifest..."
chroot "$CHROOT_DIR" dpkg-query -W --showformat='${Package} ${Version}\n' | sudo tee "$NEW_ISO_DIR/casper/filesystem.manifest" > /dev/null
cp "$NEW_ISO_DIR/casper/filesystem.manifest" "$NEW_ISO_DIR/casper/filesystem.manifest-desktop"

# Calculate filesystem size
echo "📏 Calculating filesystem size..."
FILESYSTEM_SIZE=$(du -sx --block-size=1 "$CHROOT_DIR" | cut -f1)
echo "$FILESYSTEM_SIZE" | sudo tee "$NEW_ISO_DIR/casper/filesystem.size" > /dev/null

# Clean up chroot before creating squashfs
echo "🧹 Final cleanup of chroot environment..."
chroot "$CHROOT_DIR" /bin/bash << 'CLEANUP_EOF'
# Remove temporary files
rm -rf /tmp/*
rm -rf /var/tmp/*
rm -rf /var/crash/*

# Clear logs
find /var/log -type f -exec truncate -s0 {} \;

# Clear package cache
apt-get clean
rm -rf /var/lib/apt/lists/*

# Clear user histories
rm -f /root/.bash_history
rm -f /home/ubuntu/.bash_history

# Remove SSH host keys (will be regenerated on first boot)
rm -f /etc/ssh/ssh_host_*

exit 0
CLEANUP_EOF

# Create new squashfs
echo "📦 Creating new squashfs filesystem..."
if [ -d "$NEW_ISO_DIR/casper" ]; then
    SQUASHFS_PATH="$NEW_ISO_DIR/casper/filesystem.squashfs"
elif [ -d "$NEW_ISO_DIR/live" ]; then
    SQUASHFS_PATH="$NEW_ISO_DIR/live/filesystem.squashfs"
else
    echo "❌ Could not determine squashfs location"
    exit 1
fi

# Remove old squashfs
rm -f "$SQUASHFS_PATH"

# Create new squashfs with optimal compression
mksquashfs "$CHROOT_DIR" "$SQUASHFS_PATH" \
    -comp xz \
    -e boot \
    -noappend \
    -no-progress \
    -b 1048576

# Update filesystem checksum
echo "🔐 Updating filesystem checksum..."
cd "$NEW_ISO_DIR"
find . -type f -print0 | xargs -0 md5sum | grep -v "\./md5sum.txt" > md5sum.txt

# Customize ISO metadata
echo "🏷️  Customizing ISO metadata..."
ISO_NAME="ros2-robotics-kit-${ARCHITECTURE}-ubuntu${UBUNTU_VERSION}-ros2${ROS2_DISTRO}"
VOLUME_ID="ROS2 Robotics Kit ${ROS2_DISTRO}"

# Update disk info
if [ -f "$NEW_ISO_DIR/.disk/info" ]; then
    echo "$VOLUME_ID $(date +%Y%m%d)" > "$NEW_ISO_DIR/.disk/info"
fi

# Create custom isolinux/grub configuration
if [ "$ARCHITECTURE" = "amd64" ]; then
    echo "🖥️  Configuring BIOS/UEFI boot for AMD64..."
    
    # Update isolinux configuration
    if [ -f "$NEW_ISO_DIR/isolinux/isolinux.cfg" ]; then
        sed -i "s/Ubuntu/ROS2 Robotics Kit/g" "$NEW_ISO_DIR/isolinux/isolinux.cfg"
    fi
    
    # Update GRUB configuration
    if [ -f "$NEW_ISO_DIR/boot/grub/grub.cfg" ]; then
        sed -i "s/Ubuntu/ROS2 Robotics Kit/g" "$NEW_ISO_DIR/boot/grub/grub.cfg"
    fi
    
    # Build ISO with hybrid boot support
    echo "🔥 Building ISO with BIOS/UEFI support..."
    xorriso -as mkisofs \
        -V "$VOLUME_ID" \
        -J -joliet-long \
        -r \
        -iso-level 3 \
        -o "$OUTPUT_DIR/${ISO_NAME}.iso" \
        -isohybrid-mbr /usr/lib/ISOLINUX/isohdpfx.bin \
        -partition_offset 16 \
        -eltorito-boot isolinux/isolinux.bin \
        -eltorito-catalog isolinux/boot.cat \
        -no-emul-boot -boot-load-size 4 -boot-info-table \
        -eltorito-alt-boot \
        -e boot/grub/efi.img \
        -no-emul-boot \
        -isohybrid-gpt-basdat \
        -isohybrid-apm-hfsplus \
        "$NEW_ISO_DIR"
fi

# Make ISO bootable and verify
echo "🔍 Verifying ISO..."
if [ -f "$OUTPUT_DIR/${ISO_NAME}.iso" ]; then
    ISO_SIZE=$(du -h "$OUTPUT_DIR/${ISO_NAME}.iso" | cut -f1)
    echo "✅ ISO created successfully: ${ISO_NAME}.iso (${ISO_SIZE})"
    
    # Test ISO integrity
    if command -v isohybrid >/dev/null 2>&1 && [ "$ARCHITECTURE" = "amd64" ]; then
        isohybrid "$OUTPUT_DIR/${ISO_NAME}.iso"
        echo "✅ ISO hybrid boot configured"
    fi
    
    # Create symlink for latest
    ln -sf "${ISO_NAME}.iso" "$OUTPUT_DIR/latest-${ARCHITECTURE}.iso"
    
else
    echo "❌ ISO creation failed"
    exit 1
fi

# Cleanup
echo "🧹 Cleaning up build environment..."
bash "$WORK_DIR/cleanup.sh"

echo "🎉 ISO build completed successfully!"
echo "📁 Output: $OUTPUT_DIR/${ISO_NAME}.iso"
echo "💾 Size: $ISO_SIZE"
echo ""
echo "🚀 Usage instructions:"
echo "  - Flash to USB drive or burn to DVD"
echo "  - Boot from USB/DVD and follow installation"
echo "  - Supports both BIOS and UEFI systems"
