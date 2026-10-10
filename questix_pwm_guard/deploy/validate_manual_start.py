#!/usr/bin/env python3
"""Root ExecStartPre: authorize one ARM only for an existing manual practice/lesson request.

No shell execution, no file creation, no E-stop bypass. Launcher consumes the same request.
"""
import fcntl, runpy, subprocess, sys, time
from pathlib import Path

def validate(config=Path('/etc/questix_robot'), boot=Path('/proc/sys/kernel/random/boot_id'), now=None):
    mode=(config/'mode').read_text().strip()
    if mode not in ('practice','lesson'):
        raise ValueError('rp1_hw currently supports manual lesson/practice only')
    values={}
    for line in (config/'start-request').read_text().splitlines():
        key,sep,value=line.partition('=')
        if not sep or key in values or key not in ('mode','requested_at','boot_id'):
            raise ValueError('invalid/duplicate start-request field')
        values[key]=value.strip()
    if set(values)!= {'mode','requested_at','boot_id'} or values['mode']!=mode:
        raise ValueError('mode mismatch')
    if not values['requested_at'].isascii() or not values['requested_at'].isdigit():
        raise ValueError('invalid request time')
    age=(time.time() if now is None else now)-int(values['requested_at'])
    if not -5<=age<=120 or values['boot_id']!=boot.read_text().strip():
        raise ValueError('stale start-request')
    return mode

def validate_deployment():
    config = Path('/etc/questix_pwm_guard')
    if Path('/var/lib/questix_pwm_guard/deployment-in-progress').exists():
        raise ValueError('RP1 deployment is incomplete')
    if (config/'deployment-state').read_text().strip() != 'READY':
        raise ValueError('RP1 deployment requires recovery')
    module = runpy.run_path('/opt/questix_pwm_guard/review_manifest.py')
    data = module['trusted_json'](config/'reviewed-release.json')
    module['verify'](data, arm64=True, require_frozen=True)
    original = Path(data['prefix'])/'reviewed-release.json'
    module['approved_manifest'](original, config/'approved-release.sha256')
    module['approved_manifest'](original, config/'runtime-approved.sha256')


def main():
    try:
        with open('/run/questix-rp1-install.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
            validate_deployment()
            validate()
            return subprocess.run(['/opt/questix_pwm_guard/questix_pwm_ctl','authorize'],check=False,timeout=2,
                              env={'PATH':'/usr/bin:/bin','LANG':'C'}).returncode
    except (OSError,ValueError,subprocess.TimeoutExpired) as error:
        print(f'RP1 manual start rejected: {error}',file=sys.stderr)
        return 1
if __name__=='__main__':
    raise SystemExit(main())
