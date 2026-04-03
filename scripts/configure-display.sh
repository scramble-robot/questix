#!/bin/bash
# configure-display.sh
# Configure automatic login and disable screen blanking for robot kiosk use.
# This script applies the same settings as the Ansible display_settings role,
# intended for manual execution on an already-running system.
#
# Usage: sudo ./configure-display.sh [username]
#   username  — the user to auto-login (default: current $SUDO_USER or $USER)

set -e

# ----------------------------------------------------------------
#  Argument handling
# ----------------------------------------------------------------
TARGET_USER="${1:-${SUDO_USER:-$USER}}"

if [ "$(id -u)" -ne 0 ]; then
    echo "❌ This script must be run as root (use sudo)."
    exit 1
fi

if ! id "$TARGET_USER" &>/dev/null; then
    echo "❌ User '$TARGET_USER' does not exist."
    exit 1
fi

echo "🖥️  Configuring display settings for user: $TARGET_USER"

# ================================================================
#  1. Automatic Login
# ================================================================
echo "🔑 Setting up automatic login..."

GDM3_CONF="/etc/gdm3/custom.conf"
MARKER_BEGIN="# BEGIN ANSIBLE MANAGED - display_settings autologin"
MARKER_END="# END ANSIBLE MANAGED - display_settings autologin"

if [ -f "$GDM3_CONF" ]; then
    echo "   → GDM3 detected – configuring $GDM3_CONF"

    # Remove any previous managed block
    sed -i "/$MARKER_BEGIN/,/$MARKER_END/d" "$GDM3_CONF"

    # Insert autologin lines after [daemon]
    sed -i "/^\[daemon\]/a\\
$MARKER_BEGIN\\
AutomaticLoginEnable=True\\
AutomaticLogin=$TARGET_USER\\
$MARKER_END" "$GDM3_CONF"

    echo "   ✅ GDM3 automatic login enabled"
else
    echo "   → GDM3 not found – falling back to systemd getty override"

    OVERRIDE_DIR="/etc/systemd/system/getty@tty1.service.d"
    mkdir -p "$OVERRIDE_DIR"
    cat > "$OVERRIDE_DIR/autologin.conf" << EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $TARGET_USER --noclear %I \$TERM
EOF

    systemctl daemon-reload
    echo "   ✅ Getty automatic login enabled"
fi

# ================================================================
#  2. Disable Screen Blanking (dconf system-wide override)
# ================================================================
echo "🔅 Disabling screen blanking..."

# Ensure dconf-cli is installed
if ! command -v dconf &>/dev/null; then
    echo "   → Installing dconf-cli..."
    apt-get update -qq
    apt-get install -y -qq dconf-cli
fi

# Create dconf user profile (if missing or different)
DCONF_PROFILE="/etc/dconf/profile/user"
mkdir -p "$(dirname "$DCONF_PROFILE")"
cat > "$DCONF_PROFILE" << 'EOF'
user-db:user
system-db:local
EOF

# Create dconf local override
DCONF_DIR="/etc/dconf/db/local.d"
mkdir -p "$DCONF_DIR"
cat > "$DCONF_DIR/00-disable-screen-blank" << 'EOF'
# Managed by configure-display.sh
# Disable screen blanking, screensaver, and power-saving idle

[org/gnome/desktop/session]
idle-delay=uint32 0

[org/gnome/desktop/screensaver]
lock-enabled=false
idle-activation-enabled=false

[org/gnome/settings-daemon/plugins/power]
idle-dim=false
sleep-inactive-ac-type='nothing'
sleep-inactive-battery-type='nothing'
EOF

dconf update
echo "   ✅ Screen blanking disabled (dconf system-wide)"

# ================================================================
#  Done
# ================================================================
echo ""
echo "🎉 Display configuration complete!"
echo "   • Automatic login : $TARGET_USER"
echo "   • Screen blanking : disabled"
echo ""
echo "💡 A reboot is recommended to apply all changes: sudo reboot"
