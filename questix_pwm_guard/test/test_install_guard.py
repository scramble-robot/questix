"""Private source-copy and installer contract tests; no root install, systemd or GPIO."""
import importlib.util
from pathlib import Path
import os
import tempfile
import unittest

path = Path(__file__).resolve().parents[1]/'deploy/install_guard.py'
spec = importlib.util.spec_from_file_location('guard_install', path)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class SourceCopyTest(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
