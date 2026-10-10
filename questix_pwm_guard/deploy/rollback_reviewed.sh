#!/usr/bin/env bash
# REVIEW BEFORE EXECUTION. Restores exactly the recorded paths; never starts robot/PWM.
# Current Low/export must be preserved until the operator approves an ESC-OFF reboot/migration.
set -euo pipefail
[[ $# == 1 && $EUID == 0 ]] || exit 2
backup=$(realpath -- "$1")
[[ "$backup" == /var/backups/questix-rp1-* && ! -L "$1" ]] || exit 2
test -f "$backup/present" || test -f "$backup/absent"
exec 9>/run/questix-rp1-install.lock
flock -n 9 || exit 2
for unit in questix_robot.service questix_pwm_guard.service; do
  state=$(systemctl show -P ActiveState "$unit")
  [[ "$state" == inactive || "$state" == failed ]] || {
    echo 'Owner must be quiescent by an independently reviewed ESC-OFF procedure; Low is not stopped here.' >&2; exit 2;
  }
done
paths=(/etc/questix_pwm_guard /opt/questix_pwm_guard /opt/questix_robot/questix_robot_launcher.sh
  /etc/systemd/system/questix_pwm_guard.service /etc/systemd/system/questix_robot.service.d/50-rp1-pwm.conf
  /boot/firmware/config.txt /boot/firmware/overlays/questix-gpio13-pwm.dtbo)
withdrawn=$(mktemp -d "$backup/withdrawn-XXXXXXXX")
for p in "${paths[@]}"; do
  if [[ -f "$backup/present" ]] && grep -Fxq "$p" "$backup/present"; then
    [[ -e "$backup$p" || -L "$backup$p" ]] || { echo "missing backup: $p" >&2; exit 2; }
  elif [[ ! -f "$backup/absent" ]] || ! grep -Fxq "$p" "$backup/absent"; then
    echo "incomplete path inventory: $p" >&2; exit 2
  fi
done
# Retain PARTIAL until the entire restore succeeds. Keep withdrawn assets for diagnosis.
install -d -m 0700 /var/lib/questix_pwm_guard
printf '%s\n' "$backup" > /var/lib/questix_pwm_guard/deployment-in-progress
chmod 0600 /var/lib/questix_pwm_guard/deployment-in-progress
install -d -m 0755 /etc/questix_pwm_guard
printf 'PARTIAL\n' > /etc/questix_pwm_guard/deployment-state
for p in "${paths[@]}"; do
  if [[ -e "$p" || -L "$p" ]]; then
    install -d -m 0700 "$withdrawn$(dirname -- "$p")"
    mv -- "$p" "$withdrawn$p"
  fi
  if [[ -f "$backup/present" ]] && grep -Fxq "$p" "$backup/present"; then
    cp -a -- "$backup$p" "$p"
  fi
done
systemctl daemon-reload
rm -- /var/lib/questix_pwm_guard/deployment-in-progress
echo 'RECORDED_PATHS_RESTORED=1; unit enable state was not changed. ESC OFF across operator-approved reboot. Verify PWM0 pinmux/export before lgpio.'
