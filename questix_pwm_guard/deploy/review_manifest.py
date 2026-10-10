#!/usr/bin/env python3
"""Seal a reviewed source/build pair; verify it without executing any workspace code.

Usage: digest SOURCE; seal SOURCE INSTALL OUTPUT; verify MANIFEST [ARM64]
A seal records evidence, not code-review approval. Review its source digest before installation.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import xml.etree.ElementTree as ET

PACKAGES = ('questix_msgs', 'questix_control_config', 'questix_safety',
            'questix_pwm_guard', 'esc_motor_control_cpp', 'launcher')
ELFS = ('questix_pwm_guard/lib/questix_pwm_guard/questix_pwm_guard',
        'questix_pwm_guard/lib/questix_pwm_guard/questix_pwm_ctl',
        'esc_motor_control_cpp/lib/esc_motor_control_cpp/esc_motor_control_node',
        'esc_motor_control_cpp/lib/libesc_motor_control_component.so')
REQUIRED = ELFS + ('setup.bash', 'local_setup.bash',
                  'questix_launcher/share/questix_launcher/launch/questix_core.launch.xml',
                  'esc_motor_control_cpp/share/esc_motor_control_cpp/config/esc_motor_control_cpp.yaml')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_files(root):
    files = []
    for package in PACKAGES:
        folder = root / package
        if not folder.is_dir():
            raise ValueError(f'missing source package: {package}')
        files.extend(p for p in folder.rglob('*') if p.is_file()
                     and '__pycache__' not in p.parts and p.suffix != '.pyc')
    files.append(root / 'systemd/questix_robot_launcher.sh')
    return sorted(files)


def digest(root):
    records = ''.join(f'{p.relative_to(root)}:{sha(p)}\n' for p in source_files(root))
    return hashlib.sha256(records.encode()).hexdigest()


def install_files(prefix):
    return {str(p.relative_to(prefix)): sha(p) for p in sorted(prefix.rglob('*'))
            if p.is_file() and p.relative_to(prefix) != Path('reviewed-release.json')}


def verify(data, arm64=False):
    if data['schema'] != 2 or data['contract'] != 'rp1-reviewed-v2':
        raise ValueError('unsupported review manifest')
    records = ''.join(f'{name}:{digest}\n' for name, digest in sorted(data['source_files'].items()))
    if hashlib.sha256(records.encode()).hexdigest() != data['source_digest']:
        raise ValueError('source hash table differs from embedded identity')
    prefix = Path(data['prefix'])
    if not prefix.is_absolute() or prefix.resolve() != prefix:
        raise ValueError('review prefix must be canonical')
    if install_files(prefix) != data['install_files']:
        raise ValueError('reviewed install content changed')
    for relative in REQUIRED:
        if relative not in data['install_files']:
            raise ValueError(f'missing reviewed artifact: {relative}')
    for package in PACKAGES[:-1] + ('questix_launcher',):
        if not (prefix / package / 'share' / package / 'package.xml').is_file():
            raise ValueError(f'missing reviewed dependency: {package}')
    # Reject an incomplete runtime prefix before granting any manual ticket. ROS distro packages
    # may resolve only from the fixed Jazzy underlay, never an inherited arbitrary overlay.
    launcher = prefix / 'questix_launcher/share/questix_launcher/package.xml'
    for element in ET.parse(launcher).getroot():
        if element.tag not in ('depend', 'exec_depend'):
            continue
        name = element.text.strip()
        if not ((prefix/name/'share'/name/'package.xml').is_file()
                or (Path('/opt/ros/jazzy/share')/name/'package.xml').is_file()):
            raise ValueError(f'missing launcher runtime dependency: {name}')
    marker = f"QUESTIX_RP1_REVIEW_V2:{data['source_digest']}".encode()
    for relative in ELFS:
        binary = (prefix / relative).read_bytes()
        if marker not in binary:
            raise ValueError(f'old or mismatched reviewed ELF: {relative}')
        if arm64 and (binary[:6] != b'\x7fELF\x02\x01'
                      or int.from_bytes(binary[18:20], 'little') != 183):
            raise ValueError(f'ARM64 ELF required: {relative}')
    native = {'/opt/questix_pwm_guard/questix_pwm_guard': ELFS[0],
              '/opt/questix_pwm_guard/questix_pwm_ctl': ELFS[1]}
    for filename, expected in data.get('deployed_files', {}).items():
        if filename in native and expected != data['install_files'][native[filename]]:
            raise ValueError(f'deployed ELF differs from reviewed prefix: {filename}')
        path = Path(filename)
        if path.stat().st_uid != 0 or path.stat().st_mode & 0o022 or sha(path) != expected:
            raise ValueError(f'changed deployed asset: {filename}')
    return prefix


def approved_manifest(path, approval):
    fd = os.open(approval, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('approval must be root-owned mode 0600')
        expected = os.read(fd, 128).decode('ascii').strip()
        if len(expected) != 64 or sha(Path(path)) != expected:
            raise ValueError('release manifest lacks independent approval')
    finally:
        os.close(fd)


def trusted_json(path):
    # Do not follow a user-controlled manifest symlink or trust group-readable/writable records.
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('review manifest must be root-owned mode 0600')
        with os.fdopen(fd, closefd=False) as stream:
            return json.load(stream)
    finally:
        os.close(fd)


def main():
    operation = sys.argv[1]
    if operation == 'digest':
        print(digest(Path(sys.argv[2]).resolve()))
    elif operation == 'seal':
        root, prefix = (Path(v).resolve() for v in sys.argv[2:4])
        data = {'schema': 2, 'contract': 'rp1-reviewed-v2', 'prefix': str(prefix),
                'source_digest': digest(root), 'install_files': install_files(prefix),
                'source_files': {str(p.relative_to(root)): sha(p) for p in source_files(root)}}
        verify(data)
        Path(sys.argv[4]).write_text(json.dumps(data, indent=2) + '\n')
    elif operation == 'approved':
        approved_manifest(sys.argv[2], sys.argv[3])
    elif operation == 'verify':
        verify(json.loads(Path(sys.argv[2]).read_text()), len(sys.argv) > 3)
    else:
        raise ValueError('unknown operation')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, IndexError) as error:
        raise SystemExit(f'review identity rejected: {error}')
