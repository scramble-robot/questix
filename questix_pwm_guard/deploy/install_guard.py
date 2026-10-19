"""Copy a teacher-reviewed guard source snapshot, build privately, install two root programs.

No Git, user build prefix, ROS workspace code, service operation or GPIO is used.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import grp
import shutil
import stat
import subprocess
import sys
import tempfile


def protected(path):
    """Require root ownership and no writable/aliased ancestors before privileged execution."""
    for p in (path, *path.parents):
        s = p.lstat()
        if s.st_uid != 0 or s.st_mode & 0o022 or stat.S_ISLNK(s.st_mode):
            raise ValueError(f'unprotected installation path: {p}')


def snapshot(source, destination=None):
    """Bounded no-follow directory-FD inventory/copy; never read Git settings/hooks."""
    source = Path(source)
    if not source.is_absolute() or '..' in source.parts:
        raise ValueError('source must be absolute with no parent traversal')
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
    fd = os.open('/', flags | os.O_DIRECTORY)
    try:
        for part in source.parts[1:]:
            child = os.open(part, flags | os.O_DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = child
        inventory = {}
        total = 0
        entries = 0

        def copy(parent, relative):
            nonlocal total, entries
            for name in sorted(os.listdir(parent)):
                entries += 1
                if entries > 4096 or len(relative.parts) > 32:
                    raise ValueError("guard source inventory limit exceeded")
                if name == '.git':
                    raise ValueError('Git metadata is not guard source')
                s = os.stat(name, dir_fd=parent, follow_symlinks=False)
                path = relative / name
                target = destination / path if destination is not None else None
                if stat.S_ISDIR(s.st_mode):
                    child = os.open(name, flags | os.O_DIRECTORY, dir_fd=parent)
                    try:
                        if target is not None:
                            target.mkdir(mode=0o700)
                        copy(child, path)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(s.st_mode):
                    child = os.open(name, flags | os.O_NONBLOCK, dir_fd=parent)
                    with os.fdopen(child, 'rb') as stream:
                        info = os.fstat(stream.fileno())
                        if not stat.S_ISREG(info.st_mode) or info.st_size > 4 * 1024 * 1024:
                            raise ValueError('nonregular or oversized guard source')
                        data = stream.read(4 * 1024 * 1024 + 1)
                    total += len(data)
                    if len(data) > 4 * 1024 * 1024 or total > 32 * 1024 * 1024:
                        raise ValueError('guard source snapshot limit exceeded')
                    if target is not None:
                        with target.open('xb') as output:
                            output.write(data)
                        target.chmod(0o600 | (info.st_mode & 0o111))
                    inventory[str(path)] = hashlib.sha256(data).hexdigest()
                else:
                    raise ValueError(f'link/special source refused: {path}')
        copy(fd, Path())
        return inventory
    finally:
        os.close(fd)


def unit_text(template, account):
    """Use numeric peer/socket identity while leaving the robot account unchanged."""
    group = grp.getgrgid(account.pw_gid).gr_name
    return template.replace('@ROBOT_UID@', str(account.pw_uid)).replace(
        '@ROBOT_GID@', str(account.pw_gid)).replace('@ROBOT_GROUP@', group)


def atomic_file(path, contents, mode):
    """Publish only inside checked root-managed directories, never follow a destination link."""
    protected(path.parent)
    if path.exists() or path.is_symlink():
        protected(path)
        if not stat.S_ISREG(path.lstat().st_mode):
            raise ValueError('nonregular installed asset')
    fd, temporary = tempfile.mkstemp(prefix='.install-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        Path(temporary).chmod(mode)
        os.replace(temporary, path)
    finally:
        if Path(temporary).exists():
            Path(temporary).unlink()


def migration_preflight(filesystem_root=Path('/')):
    """Refuse a coupled robot unit, report inert frozen assets without deleting evidence."""
    dropin = filesystem_root / 'etc/systemd/system/questix_robot.service.d/50-rp1-pwm.conf'
    if dropin.exists() or dropin.is_symlink():
        raise ValueError('legacy reviewed robot drop-in remains; teacher migration required')
    assets = ('etc/questix_pwm_guard/reviewed-launch.env',
              'etc/questix_pwm_guard/reviewed-release.json',
              'etc/questix_pwm_guard/approved-release.sha256',
              'etc/questix_pwm_guard/runtime-approved.sha256',
              'etc/questix_pwm_guard/deployment-state',
              'opt/questix_pwm_guard/releases',
              'var/lib/questix_pwm_guard/deployment-in-progress')
    found = []
    for relative in assets:
        path = filesystem_root / relative
        if path.exists() or path.is_symlink():
            found.append(str(path))
            print(f'WARNING: legacy frozen asset remains: {path}; teacher must back up and '
                  'verify standard workspace launcher before starting services', file=sys.stderr)
    return found


def installed_current(record_path, inventory, template, account, destination, unit):
    """Check root-owned recorded inputs, both binaries and the rendered unit before a rebuild."""
    if not record_path.exists() and not record_path.is_symlink():
        return False
    protected(record_path)
    text = record_path.read_text()
    if text.startswith('PARTIAL'):
        raise ValueError('previous installation is PARTIAL; administrator recovery required')
    try:
        record = json.loads(text)
    except ValueError:
        return False
    if record.get('status') != 'INSTALLED_NOT_STARTED' or record.get('source_files') != inventory:
        return False
    expected = record.get('binary_sha256', {})
    for name in ('questix_pwm_guard', 'questix_pwm_ctl'):
        path = destination / name
        if not path.exists() and not path.is_symlink():
            return False
        protected(path)
        if not stat.S_ISREG(path.lstat().st_mode) or path.stat().st_mode & 0o111 != 0o111:
            return False
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected.get(str(path)):
            return False
    if not unit.exists() and not unit.is_symlink():
        return False
    protected(unit)
    return stat.S_ISREG(unit.lstat().st_mode) and unit.read_text() == unit_text(template, account)


def main():
    if os.geteuid() != 0:
        raise ValueError('teacher/root installation required')
    entry = Path(sys.argv[1])
    if not entry.is_absolute():
        raise ValueError("installer entry must be an absolute protected path")
    protected(entry)
    protected(Path(__file__))
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path, help='absolute questix_pwm_guard source directory')
    parser.add_argument('robot_user')
    parser.add_argument('source_commit', help='operator-supplied identity, recorded but not certified')
    parser.add_argument('--yes', action='store_true', help='teacher approval of the displayed snapshot')
    parser.add_argument('--if-changed', action='store_true',
                        help='skip a verified matching installation; never skip migration checks')
    args = parser.parse_args(sys.argv[2:])
    if not args.source_commit or len(args.source_commit) > 128 or any(
            ord(c) < 32 for c in args.source_commit):
        raise ValueError('invalid source identity')
    account = pwd.getpwnam(args.robot_user)
    if account.pw_uid == 0:
        raise ValueError('robot user must not be root')
    migration_preflight()
    state = Path('/var/lib/questix_pwm_guard')
    protected(state.parent)
    state.mkdir(mode=0o700, exist_ok=True)
    protected(state)
    stage = Path(tempfile.mkdtemp(prefix='source-', dir=state))
    source = stage / 'source'
    source.mkdir(mode=0o700)
    records = snapshot(args.source, source)
    for name, digest in records.items():
        print(digest, name, flush=True)
    (stage / 'source-files.json').write_text(json.dumps(records, indent=2))
    print('source_commit (operator supplied, not authenticated):', args.source_commit, flush=True)
    if not args.yes and input('Teacher reviewed this snapshot? Type INSTALL: ') != 'INSTALL':
        raise ValueError('teacher approval not given; no build/install performed')
    destination = Path('/opt/questix_pwm_guard')
    unit = Path('/etc/systemd/system/questix_pwm_guard.service')
    template = (source / 'systemd/questix_pwm_guard.service.in').read_text()
    if args.if_changed and installed_current(state / 'installed.txt', records, template,
                                            account, destination, unit):
        print('CURRENT; binaries and unit match the reviewed source; no rebuild or service action')
        return
    # Root executes only the approved immutable snapshot, with no user cache/config/env.
    home = stage / 'home'
    home.mkdir(mode=0o700)
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(home), 'LANG': 'C', 'CCACHE_DISABLE': '1'}
    build = stage / 'build'
    subprocess.run(['/usr/bin/cmake', '-S', str(source), '-B', str(build),
                    '-DQUESTIX_STANDALONE=ON', '-DBUILD_TESTING=OFF',
                    '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_CXX_COMPILER=/usr/bin/c++'],
                   env=env, check=True)
    subprocess.run(['/usr/bin/cmake', '--build', str(build), '--parallel', '2'], env=env, check=True)
    protected(destination.parent)
    destination.mkdir(mode=0o755, exist_ok=True)
    protected(destination)
    destination.chmod(0o755)
    protected(unit.parent)
    backup = stage / 'previous'
    backup.mkdir(mode=0o700)
    assets = {destination / name: (build / name).read_bytes()
              for name in ('questix_pwm_guard', 'questix_pwm_ctl')}
    assets[unit] = unit_text((source / 'systemd/questix_pwm_guard.service.in').read_text(),
                             account).encode()
    for path in assets:
        if path.exists() or path.is_symlink():
            protected(path)
            if not path.is_file():
                raise ValueError('nonregular previous asset')
            shutil.copyfile(path, backup / path.name)
    previous_record = state / 'installed.txt'
    if previous_record.exists() or previous_record.is_symlink():
        protected(previous_record)
        if not stat.S_ISREG(previous_record.lstat().st_mode):
            raise ValueError('nonregular installed record')
        shutil.copyfile(previous_record, backup / 'installed.txt')
    atomic_file(state / 'installed.txt', b'PARTIAL\n', 0o600)
    for path, contents in assets.items():
        atomic_file(path, contents, 0o644 if path == unit else 0o755)
    record = {'status': 'INSTALLED_NOT_STARTED', 'source_commit': args.source_commit,
              'source_files': records, 'source_snapshot': str(source), 'backup': str(backup),
              'time_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'binary_sha256': {str(p): hashlib.sha256(b).hexdigest()
                                for p, b in assets.items() if p != unit}}
    atomic_file(state / 'installed.txt', (json.dumps(record, indent=2)+'\n').encode(), 0o600)
    print('INSTALLED_NOT_STARTED; teacher must review before daemon-reload/start/enable')


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--inventory':
        # Read-only controller operation as the administrator, with no become or root build.
        print(json.dumps(snapshot(Path(sys.argv[2])), sort_keys=True))
    else:
        main()
