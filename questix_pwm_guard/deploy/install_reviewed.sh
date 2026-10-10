#!/usr/bin/env bash
# REVIEW BEFORE EXECUTION. Installs sealed ARM64 assets; never enables/starts/export/reboots.
# Usage: sudo bash install_reviewed.sh <reviewed-colcon-install-prefix> <robot-user>
set -euo pipefail
[[ $# == 2 && $EUID == 0 ]] || { echo 'root and two arguments required' >&2; exit 2; }
review_prefix=$(realpath -- "$1")
robot_user=$2
[[ "$robot_user" =~ ^[a-z_][a-z0-9_-]*$ && "$review_prefix" =~ ^/[a-zA-Z0-9_./-]+$ ]] || exit 2
robot_uid=$(id -u "$robot_user")
[[ "$robot_uid" != 0 ]] || { echo 'robot user must be unprivileged' >&2; exit 2; }
robot_gid=$(id -g "$robot_user")
robot_group=$(id -gn "$robot_user")
[[ $(uname -m) == aarch64 ]] || { echo 'Pi ARM64 required' >&2; exit 2; }
# Serialize install/rollback and refuse active or restarting owners, without stopping Low for them.
exec 9>/run/questix-rp1-install.lock
flock -n 9 || { echo 'another deployment owns the lock' >&2; exit 2; }
for unit in questix_robot.service questix_pwm_guard.service; do
  state=$(systemctl show -P ActiveState "$unit")
  [[ "$state" == inactive || "$state" == failed ]] || { echo "$unit must be quiescent" >&2; exit 2; }
done
[[ ! -f /etc/questix_pwm_guard/deployment-state || $(cat /etc/questix_pwm_guard/deployment-state) == READY ]] || {
  echo 'partial deployment: use its backup/recovery procedure, do not rerun' >&2; exit 2;
}
[[ ! -e /var/lib/questix_pwm_guard/deployment-in-progress ]] || {
  echo 'unfinished deployment: recover its recorded backup before rerun' >&2; exit 2;
}
# Root callbacks must reside under root-managed directories, never writable by the robot.
/usr/bin/python3 -I - <<'PY_CHECK'
from pathlib import Path
for name in ('/etc/questix_pwm_guard','/opt/questix_pwm_guard','/opt/questix_robot',
             '/etc/systemd/system','/etc/systemd/system/questix_robot.service.d',
             '/var/lib/questix_pwm_guard'):
    path=Path(name)
    if path.is_symlink() or (path.exists() and (path.stat().st_uid != 0 or path.stat().st_mode & 0o022)):
        raise SystemExit(f'unsafe privileged asset directory: {name}')
PY_CHECK
mode=$(cat /etc/questix_robot/mode)
[[ "$mode" == lesson || "$mode" == practice ]] || exit 2
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
manifest="$review_prefix/reviewed-release.json"
approval=/etc/questix_pwm_guard/approved-release.sha256
# A source marker is identity, not authenticity. Approval of the exact ARM64 artifact table
# must be recorded independently by the root operator, never imported from the robot prefix.
/usr/bin/python3 -I "$script_dir/review_manifest.py" approved "$manifest" "$approval"
/usr/bin/python3 -I "$script_dir/review_manifest.py" verify "$manifest" ARM64
expected_digest=$(/usr/bin/python3 -I "$script_dir/review_manifest.py" digest "$script_dir/../..")
/usr/bin/python3 -I - "$manifest" "$expected_digest" <<'PY'
import json,sys
if json.load(open(sys.argv[1]))['source_digest'] != sys.argv[2]:
    raise SystemExit('installer source and sealed ARM64 build differ')
PY
# Compile and stage everything before modifying installed assets. A missing tool/invalid DT is inert.
stage=$(mktemp -d /var/tmp/questix-rp1-stage-XXXXXX)
trap 'rm -rf -- "$stage"' EXIT
# Freeze the manifest itself in root-owned staging before any prefix copies or further reads.
install -m 0600 "$manifest" "$stage/input-manifest.json"
manifest="$stage/input-manifest.json"
/usr/bin/python3 -I "$script_dir/review_manifest.py" approved "$manifest" "$approval"
/usr/bin/python3 -I "$script_dir/review_manifest.py" verify "$manifest" ARM64
/usr/bin/python3 -I - "$manifest" "$expected_digest" <<'PY_FROZEN'
import json,sys
if json.load(open(sys.argv[1]))['source_digest'] != sys.argv[2]:
 raise SystemExit('frozen manifest identity mismatch')
PY_FROZEN
for binary in questix_pwm_guard questix_pwm_ctl; do
  install -m 0755 "$review_prefix/questix_pwm_guard/lib/questix_pwm_guard/$binary" "$stage/$binary"
done
for file in validate_manual_start.py review_manifest.py; do
  install -m 0644 "$script_dir/$file" "$stage/$file"
done
# Install the reviewed launcher itself, so the standard unit cannot keep an old script.
install -m 0755 "$script_dir/../../systemd/questix_robot_launcher.sh" "$stage/questix_robot_launcher.sh"
install -m 0644 "$review_prefix/esc_motor_control_cpp/share/esc_motor_control_cpp/config/esc_motor_control_cpp.yaml" "$stage/canonical-esc.yaml"
/usr/bin/python3 -I - "$review_prefix" "$stage" <<'PY'
from pathlib import Path
import sys
prefix,stage=map(Path,sys.argv[1:])
source=(stage/'canonical-esc.yaml').read_text()
if source.count('pwm_backend: "auto"') != 1:
    raise SystemExit('unexpected canonical backend config')
(stage/'esc.yaml').write_text(source.replace('pwm_backend: "auto"','pwm_backend: "rp1_hw"'))
(stage/'reviewed-launch.env').write_text(f'RP1_REVIEW_PREFIX={prefix}\nRP1_REVIEW_CONFIG=/etc/questix_pwm_guard/esc.yaml\n')
PY
for relative in systemd/questix_pwm_guard.service.in systemd/50-rp1-pwm.conf deploy/gpio13-rp1-pwm.dts; do
  install -m 0644 "$script_dir/../$relative" "$stage/$(basename -- "$relative")"
done
sed -e "s/@ROBOT_UID@/$robot_uid/g" -e "s/@ROBOT_GID@/$robot_gid/g" -e "s/@ROBOT_GROUP@/$robot_group/g" \
  "$stage/questix_pwm_guard.service.in" > "$stage/questix_pwm_guard.service"
# Copies must match frozen expectations, not whatever was present during a mutable-prefix read.
/usr/bin/python3 -I - "$manifest" "$stage" <<'PY_STAGE'
import hashlib,json,sys
from pathlib import Path
data=json.loads(Path(sys.argv[1]).read_text());stage=Path(sys.argv[2])
expected={
 'questix_pwm_guard':data['install_files']['questix_pwm_guard/lib/questix_pwm_guard/questix_pwm_guard'],
 'questix_pwm_ctl':data['install_files']['questix_pwm_guard/lib/questix_pwm_guard/questix_pwm_ctl'],
 'validate_manual_start.py':data['source_files']['questix_pwm_guard/deploy/validate_manual_start.py'],
 'review_manifest.py':data['source_files']['questix_pwm_guard/deploy/review_manifest.py'],
 'questix_robot_launcher.sh':data['source_files']['systemd/questix_robot_launcher.sh'],
 'canonical-esc.yaml':data['install_files']['esc_motor_control_cpp/share/esc_motor_control_cpp/config/esc_motor_control_cpp.yaml'],
 'questix_pwm_guard.service.in':data['source_files']['questix_pwm_guard/systemd/questix_pwm_guard.service.in'],
 '50-rp1-pwm.conf':data['source_files']['questix_pwm_guard/systemd/50-rp1-pwm.conf'],
 'gpio13-rp1-pwm.dts':data['source_files']['questix_pwm_guard/deploy/gpio13-rp1-pwm.dts'],
}
for name,digest in expected.items():
 if hashlib.sha256((stage/name).read_bytes()).hexdigest()!=digest:
  raise SystemExit(f'staged asset differs from reviewed source/build: {name}')
PY_STAGE
dtc -@ -I dts -O dtb -o "$stage/questix-gpio13-pwm.dtbo" "$stage/gpio13-rp1-pwm.dts"
cp -a /boot/firmware/config.txt "$stage/config.txt"
if ! grep -Fxq 'dtoverlay=questix-gpio13-pwm' "$stage/config.txt"; then
  printf '\n[all]\n# QUESTiX reviewed GPIO13 PWM0 channel 1\ndtoverlay=questix-gpio13-pwm\n' >> "$stage/config.txt"
fi
# Back up every modified path and record absences. Do not claim automatic custom-asset recovery.
for unit in questix_robot.service questix_pwm_guard.service; do
  state=$(systemctl show -P ActiveState "$unit")
  [[ "$state" == inactive || "$state" == failed ]] || exit 2
done
backup=$(mktemp -d /var/backups/questix-rp1-XXXXXXXX)
chmod 0700 "$backup"
printf 'BACKUP=%s\n' "$backup"
# Do not follow custom asset symlinks during opt-in updates. Review them separately.
for p in /etc/questix_pwm_guard /opt/questix_pwm_guard /opt/questix_robot/questix_robot_launcher.sh \
  /etc/systemd/system/questix_pwm_guard.service /etc/systemd/system/questix_robot.service.d/50-rp1-pwm.conf \
  /boot/firmware/config.txt /boot/firmware/overlays/questix-gpio13-pwm.dtbo; do
  [[ ! -L "$p" ]] || { echo "custom symlink requires review: $p" >&2; exit 2; }
done
paths=(/etc/questix_pwm_guard /opt/questix_pwm_guard /opt/questix_robot/questix_robot_launcher.sh
  /etc/systemd/system/questix_pwm_guard.service /etc/systemd/system/questix_robot.service.d/50-rp1-pwm.conf
  /boot/firmware/config.txt /boot/firmware/overlays/questix-gpio13-pwm.dtbo)
for p in "${paths[@]}"; do
  if [[ -e "$p" || -L "$p" ]]; then
    cp -a --parents -- "$p" "$backup"
    printf '%s\n' "$p" >> "$backup/present"
  else printf '%s\n' "$p" >> "$backup/absent"; fi
done
for unit in questix_robot.service questix_pwm_guard.service; do
  systemctl is-enabled "$unit" >> "$backup/unit-enable-state" || true
done
# All failures from here leave a durable explicit PARTIAL gate, including a killed installer.
install -d -m 0700 /var/lib/questix_pwm_guard
printf '%s\n' "$backup" > /var/lib/questix_pwm_guard/deployment-in-progress
chmod 0600 /var/lib/questix_pwm_guard/deployment-in-progress
install -d -m 0755 /etc/questix_pwm_guard /opt/questix_pwm_guard /etc/systemd/system/questix_robot.service.d
printf 'PARTIAL\n' > /etc/questix_pwm_guard/deployment-state
printf '%s\n' "$backup" > /etc/questix_pwm_guard/recovery-backup
install -m 0755 "$stage/questix_pwm_guard" "$stage/questix_pwm_ctl" /opt/questix_pwm_guard/
install -m 0644 "$stage/validate_manual_start.py" "$stage/review_manifest.py" /opt/questix_pwm_guard/
install -d -m 0755 /opt/questix_robot
install -m 0755 "$stage/questix_robot_launcher.sh" /opt/questix_robot/questix_robot_launcher.sh
install -m 0644 "$stage/esc.yaml" "$stage/reviewed-launch.env" /etc/questix_pwm_guard/
install -m 0644 "$stage/questix_pwm_guard.service" /etc/systemd/system/questix_pwm_guard.service
install -m 0644 "$stage/50-rp1-pwm.conf" /etc/systemd/system/questix_robot.service.d/50-rp1-pwm.conf
install -m 0644 "$stage/questix-gpio13-pwm.dtbo" /boot/firmware/overlays/questix-gpio13-pwm.dtbo
install -m 0644 "$stage/config.txt" /boot/firmware/config.txt
# Verify the original prefix again after copying, and bind all deployed runtime assets to it.
/usr/bin/python3 -I - "$script_dir/review_manifest.py" "$manifest" <<'PY'
import json,runpy,sys
from pathlib import Path
module=runpy.run_path(sys.argv[1]);data=json.loads(Path(sys.argv[2]).read_text())
module['verify'](data,arm64=True)
files=('/opt/questix_pwm_guard/questix_pwm_guard','/opt/questix_pwm_guard/questix_pwm_ctl',
       '/opt/questix_pwm_guard/validate_manual_start.py','/opt/questix_pwm_guard/review_manifest.py',
       '/opt/questix_robot/questix_robot_launcher.sh','/etc/questix_pwm_guard/esc.yaml',
       '/etc/questix_pwm_guard/reviewed-launch.env',
       '/etc/systemd/system/questix_pwm_guard.service',
       '/etc/systemd/system/questix_robot.service.d/50-rp1-pwm.conf')
data['deployed_files']={p:module['sha'](Path(p)) for p in files}
target=Path('/etc/questix_pwm_guard/reviewed-release.json')
target.write_text(json.dumps(data,indent=2)+'\n');target.chmod(0o600)
module['verify'](data,arm64=True)
PY
systemctl daemon-reload
printf 'READY\n' > /etc/questix_pwm_guard/deployment-state
rm -- /var/lib/questix_pwm_guard/deployment-in-progress
printf 'INSTALLED_NOT_STARTED=1\n'
echo 'Review backup and manifest. ESC OFF across reboot. Verify pinmux/export migration and Low before manual ARM.'
