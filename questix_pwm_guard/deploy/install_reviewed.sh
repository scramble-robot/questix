#!/usr/bin/env bash
# REVIEW BEFORE EXECUTION. Installs reviewed binaries/units/DT only; never starts control or PWM.
# Usage: sudo bash install_reviewed.sh <reviewed-colcon-install-prefix> <robot-user>
set -euo pipefail
[[ $# == 2 && $EUID == 0 ]] || { echo 'root and two arguments required' >&2; exit 2; }
review_prefix=$(realpath -- "$1")
robot_user=$2
[[ "$robot_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || exit 2
robot_uid=$(id -u "$robot_user")
robot_gid=$(id -g "$robot_user")
robot_group=$(id -gn "$robot_user")
[[ $(uname -m) == aarch64 ]] || { echo 'Pi ARM64 required' >&2; exit 2; }
[[ $(systemctl show -P ActiveState questix_robot.service) == inactive ]] || { echo 'robot must be inactive' >&2; exit 2; }
mode=$(cat /etc/questix_robot/mode)
[[ "$mode" == lesson || "$mode" == practice ]] || { echo 'manual lesson/practice only' >&2; exit 2; }
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
guard_prefix="$review_prefix/questix_pwm_guard"
esc_prefix="$review_prefix/esc_motor_control_cpp"
for binary in questix_pwm_guard questix_pwm_ctl; do
  test -x "$guard_prefix/lib/questix_pwm_guard/$binary"
done
test -f "$esc_prefix/share/esc_motor_control_cpp/config/esc_motor_control_cpp.yaml"
# This installer is deliberately separate from the general kit installer and Ansible.
# Targeted opt-in only; existing fleet/boot defaults remain unchanged.
backup="/var/backups/questix-rp1-$(date -u +%Y%m%dT%H%M%SZ)"
test ! -e "$backup"
install -d -m 0700 "$backup"
cp -a /boot/firmware/config.txt "$backup/config.txt"
for p in /etc/questix_pwm_guard /opt/questix_pwm_guard /etc/systemd/system/questix_pwm_guard.service /etc/systemd/system/questix_robot.service.d/50-rp1-pwm.conf /boot/firmware/overlays/questix-gpio13-pwm.dtbo; do
  if [[ -e "$p" ]]; then cp -a --parents -- "$p" "$backup"; fi
done
install -d -m 0755 /opt/questix_pwm_guard /etc/questix_pwm_guard /etc/systemd/system/questix_robot.service.d
for binary in questix_pwm_guard questix_pwm_ctl; do
  install -m 0755 "$guard_prefix/lib/questix_pwm_guard/$binary" "/opt/questix_pwm_guard/$binary"
done
install -m 0644 "$script_dir/validate_manual_start.py" /opt/questix_pwm_guard/validate_manual_start.py
python3 - "$esc_prefix/share/esc_motor_control_cpp/config/esc_motor_control_cpp.yaml" <<'PY'
from pathlib import Path
import sys
source=Path(sys.argv[1]).read_text()
if source.count('pwm_backend: "auto"')!=1:
    raise SystemExit('unexpected canonical backend config')
Path('/etc/questix_pwm_guard/esc.yaml').write_text(source.replace('pwm_backend: "auto"','pwm_backend: "rp1_hw"'))
PY
sed -e "s/@ROBOT_UID@/$robot_uid/g" -e "s/@ROBOT_GID@/$robot_gid/g" -e "s/@ROBOT_GROUP@/$robot_group/g" \
  "$script_dir/../systemd/questix_pwm_guard.service.in" > /etc/systemd/system/questix_pwm_guard.service
install -m 0644 "$script_dir/../systemd/50-rp1-pwm.conf" /etc/systemd/system/questix_robot.service.d/50-rp1-pwm.conf
dtc -@ -I dts -O dtb -o /boot/firmware/overlays/questix-gpio13-pwm.dtbo "$script_dir/gpio13-rp1-pwm.dts"
if ! grep -Fxq 'dtoverlay=questix-gpio13-pwm' /boot/firmware/config.txt; then
  printf '\n[all]\n# QUESTiX reviewed GPIO13 PWM0 channel 1\ndtoverlay=questix-gpio13-pwm\n' >> /boot/firmware/config.txt
fi
systemctl daemon-reload
# No enable --now, no reboot, no GPIO export, no Robot Manager replacement.
printf 'BACKUP=%s\nINSTALLED_NOT_STARTED=1\n' "$backup"
echo 'After review: verify ROS workspace points to this reviewed build, reboot with ESC OFF, then start guard and observe Low before any manual robot start.'
