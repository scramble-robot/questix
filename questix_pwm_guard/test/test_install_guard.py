"""Private source-copy and installer contract tests; no root install, systemd or GPIO."""
import importlib.util
import contextlib
import io
from pathlib import Path
import os
import tempfile
import unittest
from unittest import mock
import hashlib
import json
import types

path = Path(__file__).resolve().parents[1]/'deploy/install_guard.py'
spec = importlib.util.spec_from_file_location('guard_install', path)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class SourceCopyTest(unittest.TestCase):
    def test_read_only_inventory_matches_the_bounded_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, target = root/'source', root/'target'
            source.mkdir()
            target.mkdir()
            (source/'file').write_bytes(b'reviewed source')
            before = list(root.rglob('*'))
            inventory = installer.snapshot(source)
            self.assertEqual(list(root.rglob('*')), before)
            self.assertEqual(inventory, installer.snapshot(source, target))

    def test_snapshot_independent_from_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, target = root/'source', root/'target'
            source.mkdir()
            target.mkdir()
            (source/'file').write_text('approved')
            table = installer.snapshot(source, target)
            (source/'file').write_text('modified')
            self.assertEqual((target/'file').read_text(), 'approved')
            self.assertEqual(set(table), {'file'})

    def test_symlink_fifo_git_and_parent_traversal_refused(self):
        for kind in ('symlink', 'fifo', 'git', 'parent'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                source, target = root/'source', root/'target'
                source.mkdir()
                target.mkdir()
                if kind == 'symlink':
                    (source/'bad').symlink_to('/dev/zero')
                elif kind == 'fifo':
                    os.mkfifo(source/'bad')
                elif kind == 'git':
                    (source/'.git').mkdir()
                else:
                    source = source/'..'/'source'
                with self.assertRaises((ValueError, OSError)):
                    installer.snapshot(source, target)

    def test_source_link_and_oversized_file_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root/'source').mkdir()
            (root/'target').mkdir()
            (root/'link').symlink_to(root/'source', target_is_directory=True)
            with self.assertRaises(OSError):
                installer.snapshot(root/'link', root/'target')
            with (root/'source/big').open('wb') as f:
                f.truncate(4*1024*1024+1)
            with self.assertRaises(ValueError):
                installer.snapshot(root/'source', root/'target')

    def test_clean_migration_has_no_warning(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stderr(io.StringIO()) as log:
            self.assertEqual(installer.migration_preflight(Path(tmp)), [])
            self.assertEqual(log.getvalue(), '')

    def test_legacy_assets_warn_without_modification(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            relatives = ('etc/questix_pwm_guard/reviewed-launch.env',
                         'etc/questix_pwm_guard/reviewed-release.json',
                         'etc/questix_pwm_guard/approved-release.sha256',
                         'etc/questix_pwm_guard/runtime-approved.sha256',
                         'etc/questix_pwm_guard/deployment-state',
                         'opt/questix_pwm_guard/releases',
                         'var/lib/questix_pwm_guard/deployment-in-progress')
            for relative in relatives:
                target = root/relative
                target.parent.mkdir(parents=True, exist_ok=True)
                if relative.endswith('/releases'):
                    target.mkdir()
                    (target/'evidence').write_text('retained')
                else:
                    target.write_text('retained')
            with contextlib.redirect_stderr(io.StringIO()) as log:
                found = installer.migration_preflight(root)
            self.assertEqual(set(found), {str(root/p) for p in relatives})
            for relative in relatives:
                self.assertIn(str(root/relative), log.getvalue())
                target = root/relative
                if target.is_dir():
                    target = target/'evidence'
                self.assertEqual(target.read_text(), 'retained')
            link = root/'etc/questix_pwm_guard/reviewed-launch.env'
            link.unlink()
            link.symlink_to(root/'missing')
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertIn(str(link), installer.migration_preflight(root))

    def test_old_dropin_and_broken_link_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dropin = root/'etc/systemd/system/questix_robot.service.d/50-rp1-pwm.conf'
            dropin.parent.mkdir(parents=True)
            dropin.write_text('legacy')
            with self.assertRaises(ValueError):
                installer.migration_preflight(root)
            self.assertEqual(dropin.read_text(), 'legacy')
            dropin.unlink()
            dropin.symlink_to(root/'missing')
            with self.assertRaises(ValueError):
                installer.migration_preflight(root)

    def test_unit_is_independent_and_sandboxed(self):
        template = (path.parents[1]/'systemd/questix_pwm_guard.service.in').read_text()
        for key in ('NoNewPrivileges=yes', 'ProtectSystem=strict', 'CapabilityBoundingSet=',
                    '--recover-low', '--lease-ms 500'):
            self.assertIn(key, template)
        self.assertNotIn('questix_robot.service', template)
        self.assertNotIn('Requires=', template)
        self.assertNotIn('ReadWritePaths=/sys', template)

    def test_installer_never_operates_services_git_or_workspace_prefix(self):
        text = path.read_text()
        self.assertNotIn('systemctl', text)
        self.assertNotIn("['git'", text)
        self.assertIn('CCACHE_DISABLE', text)
        self.assertIn('-DQUESTIX_STANDALONE=ON', text)
        self.assertIn("account.pw_uid == 0", text)
        self.assertIn('teacher approval not given', text)


class InstalledCurrentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.destination = self.root / 'opt'
        self.destination.mkdir()
        self.unit = self.root / 'guard.service'
        self.record = self.root / 'installed.txt'
        self.inventory = {'CMakeLists.txt': 'reviewed-sha'}
        self.template = 'User=root\nGroup=@ROBOT_GROUP@\nExecStart=guard --allowed-uid @ROBOT_UID@\n'
        self.account = types.SimpleNamespace(pw_uid=1234, pw_gid=os.getgid())
        self.unit.write_text(installer.unit_text(self.template, self.account))
        checksums = {}
        for name in ('questix_pwm_guard', 'questix_pwm_ctl'):
            target = self.destination / name
            target.write_bytes(name.encode())
            target.chmod(0o755)
            checksums[str(target)] = hashlib.sha256(target.read_bytes()).hexdigest()
        self.record.write_text(json.dumps({'status': 'INSTALLED_NOT_STARTED',
                                          'source_files': self.inventory,
                                          'binary_sha256': checksums}))
        # Ownership is checked in production; these temporary fixtures belong to the test user.
        self.protection = mock.patch.object(installer, 'protected', self.no_links)
        self.protection.start()
        self.addCleanup(self.protection.stop)

    def no_links(self, target):
        if target.is_symlink():
            raise ValueError('test refuses destination link')

    def current(self):
        return installer.installed_current(self.record, self.inventory, self.template,
                                           self.account, self.destination, self.unit)

    def test_unchanged_install_does_not_need_a_rebuild(self):
        self.assertTrue(self.current())
        self.assertTrue(self.current(), 'repeatability')

    def test_changed_source_binary_unit_or_identity_needs_rebuild(self):
        for change in ('source', 'binary', 'unit', 'identity'):
            with self.subTest(change=change):
                with mock.patch.object(self, 'inventory', dict(self.inventory)):
                    original = self.unit.read_text()
                    if change == 'source':
                        self.inventory['new.cpp'] = 'new-sha'
                    elif change == 'binary':
                        (self.destination / 'questix_pwm_ctl').write_bytes(b'changed')
                    elif change == 'unit':
                        self.unit.write_text('wrong unit')
                    else:
                        self.account.pw_uid = 5678
                    self.assertFalse(self.current())
                    self.unit.write_text(original)
                    self.account.pw_uid = 1234
                    (self.destination / 'questix_pwm_ctl').write_bytes(b'questix_pwm_ctl')

    def test_missing_binary_or_execute_permission_is_not_current(self):
        target = self.destination / 'questix_pwm_ctl'
        target.chmod(0o644)
        self.assertFalse(self.current())
        target.unlink()
        self.assertFalse(self.current())

    def test_partial_install_and_links_require_operator_action(self):
        self.record.write_text('PARTIAL\n')
        with self.assertRaises(ValueError):
            self.current()
        self.record.unlink()
        self.record.symlink_to(self.unit)
        with self.assertRaises(ValueError):
            self.current()


if __name__ == '__main__':
    unittest.main()
