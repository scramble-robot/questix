#!/usr/bin/env python3
"""Seal a reviewed source/build pair; verify it without executing any workspace code.

Usage: digest SOURCE; seal SOURCE INSTALL OUTPUT; verify MANIFEST [ARM64]
A seal records evidence, not code-review approval. Review its source digest before installation.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
import xml.etree.ElementTree as ET

PACKAGES = ('questix_msgs', 'questix_control_config', 'questix_safety',
            'questix_pwm_guard', 'esc_motor_control_cpp', 'launcher')
ELFS = ('questix_pwm_guard/lib/questix_pwm_guard/questix_pwm_guard',
        'questix_pwm_guard/lib/questix_pwm_guard/questix_pwm_ctl',
        'esc_motor_control_cpp/lib/esc_motor_control_cpp/esc_motor_control_node',
        'esc_motor_control_cpp/lib/libesc_motor_control_component.so')
PROGRAMS = ELFS[:3]
REQUIRED = ELFS + ('setup.bash', 'local_setup.bash',
                  'questix_launcher/share/questix_launcher/launch/questix_core.launch.xml',
                  'esc_motor_control_cpp/share/esc_motor_control_cpp/config/esc_motor_control_cpp.yaml')
RELEASE_ROOT = Path('/opt/questix_pwm_guard/releases')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_files(root):
    files = []
    for package in PACKAGES:
        folder = root / package
        if not stat.S_ISDIR(folder.lstat().st_mode):
            raise ValueError(f'missing or aliased source package: {package}')
        for path in folder.rglob('*'):
            mode = path.lstat().st_mode
            if stat.S_ISDIR(mode):
                continue
            if not stat.S_ISREG(mode):
                raise ValueError(f'nonregular reviewed source: {path}')
            if '__pycache__' not in path.relative_to(root).parts and path.suffix != '.pyc':
                files.append(path)
    launcher = root / 'systemd/questix_robot_launcher.sh'
    if not stat.S_ISREG(launcher.lstat().st_mode):
        raise ValueError('nonregular reviewed launcher')
    files.append(launcher)
    return sorted(files)


def digest(root):
    records = ''.join(f'{p.relative_to(root)}:{sha(p)}\n' for p in source_files(root))
    return hashlib.sha256(records.encode()).hexdigest()


def install_files(prefix):
    files = {}
    for path in sorted(prefix.rglob('*')):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(f'release must contain only directories and regular files: {path}')
        if path.relative_to(prefix) != Path('reviewed-release.json'):
            files[str(path.relative_to(prefix))] = sha(path)
    return files


def install_layout(prefix):
    """Approved public-readable runtime layout, including empty directories and execute bits."""
    layout = {}
    for path in sorted(prefix.rglob('*')):
        info = path.lstat()
        name = str(path.relative_to(prefix))
        if name == 'reviewed-release.json':
            continue
        if stat.S_ISDIR(info.st_mode):
            layout[name] = {'kind': 'directory', 'mode': 0o755}
        elif stat.S_ISREG(info.st_mode):
            if info.st_mode & 0o7000:
                raise ValueError('special runtime permission bits are not supported')
            layout[name] = {'kind': 'file', 'mode': 0o644 | (info.st_mode & 0o111)}
        else:
            raise ValueError(f'nonregular runtime layout: {name}')
    return layout


def validate_layout(data):
    layout = data['install_layout']
    if not isinstance(layout, dict) or not layout:
        raise ValueError('missing runtime layout')
    validate_inventory({name: '0'*64 for name in layout})
    files = set()
    for name, entry in layout.items():
        if not isinstance(entry, dict) or set(entry) != {'kind', 'mode'}:
            raise ValueError('invalid runtime layout entry')
        kind, mode = entry['kind'], entry['mode']
        if type(mode) is not int:
            raise ValueError('invalid runtime mode')
        if kind == 'directory' and mode == 0o755:
            pass
        elif kind == 'file' and mode & ~0o111 == 0o644:
            files.add(name)
        else:
            raise ValueError('unsupported runtime kind/mode')
        for parent in Path(name).parents:
            if parent != Path('.') and layout.get(str(parent)) != {'kind': 'directory', 'mode': 0o755}:
                raise ValueError('missing runtime parent directory')
    if files != set(data['install_files']):
        raise ValueError('runtime layout and file inventory differ')
    # Root-owned programs must remain executable by the non-root robot account.
    # Shared libraries and sourced setup files do not require execute permission.
    for name in PROGRAMS:
        if layout.get(name) != {'kind': 'file', 'mode': 0o755}:
            raise ValueError(f'reviewed executable must have mode 0755: {name}')


def protected_path(path):
    """Root ownership through every ancestor prevents rename/replacement by the robot."""
    for candidate in (path, *path.parents):
        info = candidate.lstat()
        if (info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode)
                or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode))):
            raise ValueError(f'runtime path is not root protected: {candidate}')
    if path.is_file() and path.stat().st_nlink != 1:
        raise ValueError(f'linked runtime file: {path}')


def validate_inventory(files):
    if not isinstance(files, dict) or not files:
        raise ValueError('empty or invalid install inventory')
    for name, digest in files.items():
        if (not isinstance(name, str) or not name or name.startswith('/')
                or any(part in ('', '.', '..') for part in name.split('/'))
                or name == 'reviewed-release.json'
                or not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest)):
            raise ValueError('noncanonical install inventory')


def verify_frozen(data, prefix):
    frozen = data.get('frozen_runtime', {})
    release = frozen.get('approved_manifest_sha256', '')
    if (not re.fullmatch('[0-9a-f]{64}', release)
            or prefix != RELEASE_ROOT / release):
        raise ValueError('runtime must use an approved frozen release path')
    protected_path(prefix)
    for path in prefix.rglob('*'):
        protected_path(path)
    original_manifest = prefix / 'reviewed-release.json'
    original = trusted_json(original_manifest)
    if (sha(original_manifest) != release
            or original['prefix'] != frozen.get('original_prefix')
            or any(original[key] != data[key] for key in ('source_digest', 'source_files', 'install_files', 'install_layout'))):
        raise ValueError('frozen runtime differs from original approval')


def verify(data, arm64=False, require_frozen=False):
    if data['schema'] != 3 or data['contract'] != 'rp1-reviewed-v3':
        raise ValueError('unsupported review manifest')
    records = ''.join(f'{name}:{digest}\n' for name, digest in sorted(data['source_files'].items()))
    if hashlib.sha256(records.encode()).hexdigest() != data['source_digest']:
        raise ValueError('source hash table differs from embedded identity')
    prefix = Path(data['prefix'])
    if not prefix.is_absolute() or prefix.resolve() != prefix:
        raise ValueError('review prefix must be canonical')
    validate_inventory(data['install_files'])
    validate_layout(data)
    if require_frozen:
        verify_frozen(data, prefix)
    if install_layout(prefix) != data['install_layout']:
        raise ValueError('reviewed runtime layout changed')
    if 'frozen_runtime' in data:
        for name, entry in data['install_layout'].items():
            if stat.S_IMODE((prefix/name).lstat().st_mode) != entry['mode']:
                raise ValueError('frozen runtime mode changed')
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


def freeze(manifest, source, destination):
    """Copy approved bytes with no-follow descriptor traversal, without running setup/code."""
    data = trusted_json(manifest)
    source, destination = Path(source), Path(destination)
    if source != Path(data['prefix']) or source.resolve() != source:
        raise ValueError('installer prefix differs from approved manifest')
    verify(data, arm64=True)
    destination.mkdir(mode=0o700)
    for name, entry in sorted(data['install_layout'].items()):
        if entry['kind'] == 'directory':
            (destination/name).mkdir(mode=0o755, parents=True, exist_ok=True)
    root_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for name, expected in sorted(data['install_files'].items()):
            parent = os.dup(root_fd)
            try:
                parts = name.split('/')
                for part in parts[:-1]:
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                                    | os.O_CLOEXEC, dir_fd=parent)
                    os.close(parent)
                    parent = child
                fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                             | os.O_CLOEXEC, dir_fd=parent)
                with os.fdopen(fd, 'rb') as stream:
                    info = os.fstat(stream.fileno())
                    if not stat.S_ISREG(info.st_mode):
                        raise ValueError(f'nonregular runtime input: {name}')
                    target = destination / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with target.open('xb') as output:
                        shutil.copyfileobj(stream, output)
                    mode = 0o644 | (info.st_mode & 0o111)
                    if info.st_mode & 0o7000 or mode != data['install_layout'][name]['mode']:
                        raise ValueError('source execute mode changed during copy')
                    target.chmod(mode)
                if sha(target) != expected:
                    raise ValueError(f'copied runtime differs from approved inventory: {name}')
            finally:
                os.close(parent)
    finally:
        os.close(root_fd)
    # Preserve the exact independent approval, not just a relabeled derived manifest.
    shutil.copyfile(manifest, destination / 'reviewed-release.json')
    (destination / 'reviewed-release.json').chmod(0o600)
    for path in destination.rglob('*'):
        if path.is_dir():
            path.chmod(0o755)
    destination.chmod(0o755)
    data['frozen_runtime'] = {'approved_manifest_sha256': sha(Path(manifest)),
                              'original_prefix': str(source)}
    data['prefix'] = str(destination)
    verify(data, arm64=True)
    return data


def publish(data):
    """Never overwrite a version. Existing identical protected versions may be reused."""
    source = Path(data['prefix'])
    verify(data, arm64=True)
    # The parent is privileged and checked before mkdir, not inherited from a user path.
    protected_path(RELEASE_ROOT.parent)
    RELEASE_ROOT.mkdir(mode=0o755, exist_ok=True)
    protected_path(RELEASE_ROOT)
    target = RELEASE_ROOT / data['frozen_runtime']['approved_manifest_sha256']
    data = dict(data, prefix=str(target))
    if target.exists() or target.is_symlink():
        verify(data, arm64=True, require_frozen=True)
    else:
        # /var/tmp and /opt may be different filesystems. Copy into a private directory
        # on the release filesystem, verify again, then publish with a same-filesystem rename.
        pending = Path(tempfile.mkdtemp(prefix='.pending-', dir=RELEASE_ROOT))
        try:
            runtime = pending / 'runtime'
            shutil.copytree(source, runtime, symlinks=True)
            verify(dict(data, prefix=str(runtime)), arm64=True)
            for path in (runtime, *runtime.rglob('*')):
                protected_path(path)
            os.rename(runtime, target)
            verify(data, arm64=True, require_frozen=True)
        finally:
            shutil.rmtree(pending)
    return data


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
    if operation == 'source-seal':
        root = Path(sys.argv[2]).resolve()
        data = {'schema': 1, 'contract': 'rp1-installer-source-v1',
                'source_digest': digest(root),
                'source_files': {str(p.relative_to(root)): sha(p) for p in source_files(root)}}
        Path(sys.argv[3]).write_text(json.dumps(data, indent=2) + '\n')
    elif operation == 'digest':
        print(digest(Path(sys.argv[2]).resolve()))
    elif operation == 'seal':
        root, prefix = (Path(v).resolve() for v in sys.argv[2:4])
        data = {'schema': 3, 'contract': 'rp1-reviewed-v3', 'prefix': str(prefix),
                'source_digest': digest(root), 'install_files': install_files(prefix),
                'install_layout': install_layout(prefix),
                'source_files': {str(p.relative_to(root)): sha(p) for p in source_files(root)}}
        verify(data)
        Path(sys.argv[4]).write_text(json.dumps(data, indent=2) + '\n')
    elif operation == 'approved':
        approved_manifest(sys.argv[2], sys.argv[3])
    elif operation == 'verify':
        verify(json.loads(Path(sys.argv[2]).read_text()), len(sys.argv) > 3)
    elif operation == 'freeze':
        data = freeze(sys.argv[2], sys.argv[3], sys.argv[4])
        Path(sys.argv[5]).write_text(json.dumps(data, indent=2) + '\n')
        Path(sys.argv[5]).chmod(0o600)
    elif operation == 'publish':
        data = publish(trusted_json(sys.argv[2]))
        Path(sys.argv[2]).write_text(json.dumps(data, indent=2) + '\n')
        print(data['prefix'])
    else:
        raise ValueError('unknown operation')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, IndexError) as error:
        raise SystemExit(f'review identity rejected: {error}')
