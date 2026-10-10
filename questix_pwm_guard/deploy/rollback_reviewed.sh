#!/usr/bin/env bash
# REVIEW BEFORE EXECUTION. ESC power must be OFF; never turns robot control back on.
set -euo pipefail
[[ $# == 1 && $EUID == 0 ]] || exit 2
backup=$(realpath -- "$1")
[[ "$backup" == /var/backups/questix-rp1-* ]] || exit 2
test -f "$backup/config.txt"
[[ $(systemctl show -P ActiveState questix_robot.service) == inactive ]] || exit 2
if systemctl is-active --quiet questix_pwm_guard.service; then
  /opt/questix_pwm_guard/questix_pwm_ctl low
  systemctl stop questix_pwm_guard.service
fi
# Preserve new assets for diagnosis rather than deleting; reboot releases the PWM export.
if [[ -f /etc/systemd/system/questix_robot.service.d/50-rp1-pwm.conf ]]; then
  mv /etc/systemd/system/questix_robot.service.d/50-rp1-pwm.conf "$backup/withdrawn-50-rp1-pwm.conf"
fi
cp -a "$backup/config.txt" /boot/firmware/config.txt
systemctl daemon-reload
echo 'ROLLBACK_CONFIG_RESTORED=1; ESC OFF required across reviewed reboot. Verify no PWM0 pinmux before selecting lgpio.'
