#!/usr/bin/env bash
# REVIEW BEFORE EXECUTION. Restores exactly the recorded paths; never starts robot/PWM.
# Current Low/export must be preserved until the operator approves an ESC-OFF reboot/migration.
set -euo pipefail
# Command lookup is fixed before the first external command. Invoke with a clean environment.
export PATH=/usr/bin:/bin LANG=C
unset BASH_ENV ENV CDPATH
# The operator must execute a reviewed root-managed copy, not a development checkout.
check_reviewed_source() {
/usr/bin/python3 -I - "${BASH_SOURCE[0]}" <<'PY_SOURCE'
import hashlib,json,os,stat,sys
from pathlib import Path
script=Path(sys.argv[1])
if script.absolute().resolve() != script.absolute():
    raise SystemExit('installer source path must be canonical')
root=script.absolute().parents[2]
def protected(path):
    for candidate in (path,*path.parents):
        info=candidate.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise SystemExit('unsafe installer source path: '+str(candidate))
    if path.is_file() and path.stat().st_nlink != 1:
        raise SystemExit('linked installer source file')
protected(script)
receipt=root/'reviewed-installer-source.json'
protected(receipt)
if stat.S_IMODE(receipt.stat().st_mode) != 0o600:
    raise SystemExit('installer approval receipt must be mode0600')
data=json.loads(receipt.read_text())
if data.get('schema') != 1 or data.get('contract') != 'rp1-installer-source-v1':
    raise SystemExit('unsupported installer source approval')
files=data['source_files']
records=''.join(f'{name}:{digest}\n' for name,digest in sorted(files.items()))
if hashlib.sha256(records.encode()).hexdigest()!=data['source_digest']:
    raise SystemExit('installer source approval table mismatch')
for name,digest in files.items():
    if not name or name.startswith('/') or any(p in ('','.', '..') for p in name.split('/')):
        raise SystemExit('invalid installer source inventory')
    path=root/name
    protected(path)
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:
        raise SystemExit('installer source differs from approval: '+name)
required=('questix_pwm_guard/deploy/install_reviewed.sh','questix_pwm_guard/deploy/rollback_reviewed.sh',
          'questix_pwm_guard/deploy/review_manifest.py')
if any(name not in files for name in required) or str(script.relative_to(root)) not in files:
    raise SystemExit('incomplete installer source approval')
PY_SOURCE
}
check_reviewed_source
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
check_reviewed_source
systemctl daemon-reload
rm -- /var/lib/questix_pwm_guard/deployment-in-progress
echo 'RECORDED_PATHS_RESTORED=1; unit enable state was not changed. ESC OFF across operator-approved reboot. Verify PWM0 pinmux/export before lgpio.'
