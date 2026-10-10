"""Exercise approved copy/publish with real files and modeled root metadata.

Only ownership and ancestors outside the fixture are modeled. Symlinks, modes,
copy races, contents, paths and hardlinks use the real private filesystem. This
is not a live root/systemd or GPIO test.
"""
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    'frozen', Path(__file__).parents[1] / 'deploy/review_manifest.py')
seal = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(seal)


class FrozenRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / 'source'
        self.releases = self.base / 'protected/releases'
        self.releases.parent.mkdir()
        self.releases.parent.chmod(0o755)
        self.source.mkdir()
        marker = b'QUESTIX_RP1_REVIEW_V2:' + seal.hashlib.sha256(b'').hexdigest().encode()
        for relative in seal.REQUIRED:
            file = self.source / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b'\x7fELF\x02\x01' + b'\x00'*12 + b'\xb7\x00' + marker)
        for package in seal.PACKAGES[:-1] + ('questix_launcher',):
            file = self.source / package / 'share' / package / 'package.xml'
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('<package/>')
        self.data = dict(schema=3, contract='rp1-reviewed-v3', prefix=str(self.source),
                         source_digest=seal.hashlib.sha256(b'').hexdigest(), source_files={},
                         install_layout=seal.install_layout(self.source), install_files=seal.install_files(self.source))
        self.manifest = self.base / 'input.json'
        self.manifest.write_text(json.dumps(self.data))
        self.manifest.chmod(0o600)
        self.bad_owner = None
        real_stat = Path.lstat

        def root_metadata(path):
            fields = list(real_stat(path))
            fields[4] = 1234 if path == self.bad_owner else 0
            if path in self.base.parents:
                fields[0] = stat.S_IFDIR | 0o755
            return os.stat_result(fields)

        self.owner = patch.object(Path, 'lstat', root_metadata)
        self.owner.start()
        self.addCleanup(self.owner.stop)
        real_fstat = os.fstat

        def root_descriptor(fd):
            fields = list(real_fstat(fd))
            fields[4] = 0
            return os.stat_result(fields)

        self.fd_owner = patch.object(seal.os, 'fstat', root_descriptor)
        self.fd_owner.start()
        self.addCleanup(self.fd_owner.stop)
        self.release_root = patch.object(seal, 'RELEASE_ROOT', self.releases)
        self.release_root.start()
        self.addCleanup(self.release_root.stop)

    def freeze(self):
        return seal.freeze(self.manifest, self.source, self.base / 'staged')

    def test_mutable_source_and_legacy_deployment_cannot_authorize(self):
        self.assertEqual(seal.verify(self.data, arm64=True), self.source)
        with self.assertRaisesRegex(ValueError, 'frozen release'):
            seal.verify(self.data, arm64=True, require_frozen=True)

    def test_after_copy_original_edits_do_not_change_frozen_runtime(self):
        frozen = self.freeze()
        published = seal.publish(frozen)
        prefix = Path(published['prefix'])
        self.assertEqual(prefix, self.releases / seal.sha(self.manifest))
        for relative in ('local_setup.bash', seal.ELFS[2], seal.ELFS[3], seal.REQUIRED[-1]):
            (self.source / relative).write_text('modified after approval')
            self.assertEqual(seal.sha(prefix / relative), self.data['install_files'][relative])
        self.assertEqual(seal.verify(published, arm64=True, require_frozen=True), prefix)
        # Hardlinking to mutable originals would fail this independent-inode check.
        self.assertNotEqual((prefix / seal.ELFS[2]).stat().st_ino,
                            (self.source / seal.ELFS[2]).stat().st_ino)

    def test_cli_prefix_mismatch_rejected_without_creating_runtime(self):
        other = self.base / 'other'
        other.mkdir()
        with self.assertRaisesRegex(ValueError, 'prefix differs'):
            seal.freeze(self.manifest, other, self.base / 'staged')
        self.assertFalse((self.base / 'staged').exists())

    def test_copy_race_is_rejected_by_post_copy_hash(self):
        real_copy = seal.shutil.copyfileobj

        def changed_copy(source, destination):
            real_copy(source, destination)
            destination.write(b'changed during copy')

        with patch.object(seal.shutil, 'copyfileobj', changed_copy):
            with self.assertRaisesRegex(ValueError, 'copied runtime differs'):
                self.freeze()
        self.assertFalse(self.releases.exists())

    def test_source_symlinks_and_special_files_are_rejected(self):
        for variant in ('file', 'directory', 'dangling', 'fifo'):
            with self.subTest(variant=variant):
                path = self.source / 'escape'
                if variant == 'fifo':
                    os.mkfifo(path)
                else:
                    target = self.source / 'local_setup.bash' if variant == 'file' else self.base
                    if variant == 'dangling':
                        target = self.base / 'missing'
                    path.symlink_to(target)
                with self.assertRaises(ValueError):
                    seal.verify(self.data)
                path.unlink()

    def test_noncanonical_inventory_names_are_rejected(self):
        for name in ('../escape', '/escape', 'a//b', 'a/./b', 'a/../b', 'reviewed-release.json'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                seal.validate_inventory({name: 'a'*64})

    def test_published_permissions_owner_ancestors_and_links_are_checked(self):
        published = seal.publish(self.freeze())
        prefix = Path(published['prefix'])
        file = prefix / 'local_setup.bash'
        for path in (file, prefix, self.releases.parent):
            original = path.stat().st_mode & 0o777
            path.chmod(original | 0o020)
            with self.assertRaisesRegex(ValueError, 'root protected'):
                seal.verify(published, require_frozen=True)
            path.chmod(original)
            self.bad_owner = path
            with self.assertRaisesRegex(ValueError, 'root protected'):
                seal.verify(published, require_frozen=True)
            self.bad_owner = None
        linked = self.base / 'linked'
        os.link(file, linked)
        with self.assertRaisesRegex(ValueError, 'linked runtime file'):
            seal.verify(published, require_frozen=True)
        linked.unlink()
        file.unlink()
        file.symlink_to(self.source / 'local_setup.bash')
        with self.assertRaises(ValueError):
            seal.verify(published, require_frozen=True)

    def test_existing_version_is_verified_never_overwritten(self):
        frozen = self.freeze()
        published = seal.publish(frozen)
        file = Path(published['prefix']) / 'local_setup.bash'
        file.write_text('root-side corruption')
        with self.assertRaises(ValueError):
            seal.publish(frozen)
        self.assertEqual(file.read_text(), 'root-side corruption')

    def test_actual_colcon_python_package_uses_relocated_release(self):
        # Build a harmless package with real colcon-generated setup/hooks. No ROS node,
        # daemon, GPIO or system service is executed; required ARM64 ELF records are fixtures.
        package = self.base / 'probe'
        (package / 'frozen_probe').mkdir(parents=True)
        (package / 'resource').mkdir()
        (package / 'resource/frozen_probe').write_text('')
        (package / 'frozen_probe/__init__.py').write_text('VALUE = "reviewed"\n')
        (package / 'package.xml').write_text(
            '<package format="3"><name>frozen_probe</name><version>0.0.1</version>'
            '<description>Relocation probe</description><maintainer email="test@example.org">Test</maintainer>'
            '<license>MIT</license><export><build_type>ament_python</build_type></export></package>')
        (package / 'setup.py').write_text(
            'from setuptools import setup\nsetup(name="frozen_probe",version="0.0.1",'
            'packages=["frozen_probe"],data_files=['
            '("share/ament_index/resource_index/packages",["resource/frozen_probe"]),'
            '("share/frozen_probe",["package.xml"])])\n')
        env = {k: v for k, v in os.environ.items() if k not in (
            'AMENT_PREFIX_PATH', 'CMAKE_PREFIX_PATH', 'COLCON_PREFIX_PATH',
            'COLCON_CURRENT_PREFIX', 'PYTHONPATH', 'PYTHONHOME', 'LD_LIBRARY_PATH')}
        env.update(PATH='/usr/bin:/bin', PYTHONDONTWRITEBYTECODE='1')
        build = subprocess.run(['colcon', '--log-base', str(self.base / 'log'), 'build',
            '--base-paths', str(package), '--build-base', str(self.base / 'build'),
            '--install-base', str(self.source), '--packages-select', 'frozen_probe'],
            env=env, capture_output=True, text=True, timeout=90)
        self.assertEqual(build.returncode, 0, build.stdout + build.stderr)
        self.data['install_files'] = seal.install_files(self.source)
        self.data['install_layout'] = seal.install_layout(self.source)
        self.manifest.write_text(json.dumps(self.data))
        frozen = seal.publish(self.freeze())
        prefix = Path(frozen['prefix'])
        seal.shutil.rmtree(self.source)
        command = ('source "$1/local_setup.bash" && python3 -c '
                   '\'import frozen_probe,os;print(frozen_probe.VALUE);print(frozen_probe.__file__);'
                   'print(os.environ.get("AMENT_PREFIX_PATH", ""))\'')
        run = subprocess.run(['bash', '-c', command, 'probe', str(prefix)],
            env=env, capture_output=True, text=True, timeout=20)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn('reviewed\n' + str(prefix / 'frozen_probe'), run.stdout)
        self.assertNotIn(str(self.source), run.stdout)
        self.assertEqual(seal.verify(frozen, require_frozen=True), prefix)

    def test_empty_directory_and_public_read_policy_are_approved(self):
        (self.source/'empty/nested').mkdir(parents=True)
        (self.source/'local_setup.bash').chmod(0o600)
        self.data['install_layout'] = seal.install_layout(self.source)
        self.manifest.write_text(json.dumps(self.data))
        published = seal.publish(self.freeze())
        prefix = Path(published['prefix'])
        self.assertTrue((prefix/'empty/nested').is_dir())
        self.assertEqual((prefix/'local_setup.bash').stat().st_mode & 0o777, 0o644)
        (prefix/'empty/nested').rmdir()
        with self.assertRaisesRegex(ValueError, 'layout changed'):
            seal.verify(published, require_frozen=True)

    def test_execute_mode_change_is_rejected_before_and_after_copy(self):
        file = self.source/'local_setup.bash'
        file.chmod(0o755)
        with self.assertRaisesRegex(ValueError, 'layout changed'):
            self.freeze()
        file.chmod(0o644)
        published = seal.publish(self.freeze())
        (Path(published['prefix'])/'local_setup.bash').chmod(0o755)
        with self.assertRaises(ValueError):
            seal.verify(published, require_frozen=True)

    def test_special_mode_and_missing_layout_are_rejected(self):
        file = self.source/'local_setup.bash'
        file.chmod(0o4644)
        with self.assertRaisesRegex(ValueError, 'special runtime'):
            seal.verify(self.data)
        file.chmod(0o644)
        legacy = dict(self.data, schema=2, contract='rp1-reviewed-v2')
        with self.assertRaisesRegex(ValueError, 'unsupported review'):
            seal.verify(legacy)

    @unittest.skipUnless(os.geteuid() == 0, 'real root-to-unprivileged DAC check requires root')
    def test_unprivileged_process_cannot_write_real_root_owned_release(self):
        published = seal.publish(self.freeze())
        prefix = Path(published['prefix'])
        self.base.chmod(0o755)

        def unprivileged():
            os.setgroups([])
            os.setgid(65534)
            os.setuid(65534)

        code = ('import pathlib,sys\np=pathlib.Path(sys.argv[1])\n'
                '(p/"local_setup.bash").read_bytes()\n'
                'for target in (p/"local_setup.bash",p/"new",p.parent/"new"):\n'
                ' try: target.write_bytes(b"unreviewed")\n'
                ' except PermissionError: continue\n'
                ' raise SystemExit("unexpected write permission")\n')
        result = subprocess.run(['/usr/bin/python3', '-I', '-c', code, str(prefix)],
            preexec_fn=unprivileged, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        seal.verify(published, require_frozen=True)


if __name__ == '__main__':
    unittest.main()
