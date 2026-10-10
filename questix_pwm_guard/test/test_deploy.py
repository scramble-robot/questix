"""Exercise installer failure ordering in a relocated, unprivileged fixture.

No production path, real systemctl, GPIO or privileged command is used. The fixture
substitutes its UID for root checks and fake tools for uname/systemctl/dtc only.
This is not a root/systemd/ARM64 integration test.
"""
import importlib.util
import json
import os
import pwd
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

REPO = Path(__file__).parents[2]
SPEC = importlib.util.spec_from_file_location('seal', REPO/'questix_pwm_guard/deploy/review_manifest.py')
seal = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(seal)


class DeploymentTest(unittest.TestCase):
    def exercise(self, failure):
        with tempfile.TemporaryDirectory() as name:
            base = Path(name)
            root, source, prefix, tools = (base/p for p in ('root', 'source', 'install', 'tools'))
            for file in seal.source_files(REPO):
                target = source/file.relative_to(REPO)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(file, target)
            # Relocate absolute deployment paths in this fixture only.
            script = source/'questix_pwm_guard/deploy/install_reviewed.sh'
            text = script.read_text().replace('$EUID == 0', '$EUID == '+str(os.getuid()))
            for original in ('/etc/questix_pwm_guard', '/etc/questix_robot', '/etc/systemd/system',
                             '/opt/questix_pwm_guard', '/opt/questix_robot', '/boot/firmware',
                             '/var/backups', '/var/tmp', '/var/lib/questix_pwm_guard',
                             '/run/questix-rp1-install.lock'):
                text = text.replace(original, str(root)+original)
            text = text.replace('for candidate in (path,*path.parents):',
                f'for candidate in (path,*(p for p in path.parents if p == Path({str(source)!r}) '
                f'or Path({str(source)!r}) in p.parents)):')
            text = text.replace('export PATH=/usr/bin:/bin LANG=C', f'export PATH={tools}:/usr/bin:/bin LANG=C')
            text = text.replace('.st_uid != 0', '.st_uid != '+str(os.getuid()))
            script.write_text(text)
            helper = source/'questix_pwm_guard/deploy/review_manifest.py'
            helper_text = helper.read_text().replace('.st_uid != 0', '.st_uid != '+str(os.getuid()))
            helper_text = helper_text.replace('/opt/questix_pwm_guard', str(root)+'/opt/questix_pwm_guard')
            # Model / as fixture root; real /tmp is intentionally not a privileged ancestor.
            helper_text = helper_text.replace('for candidate in (path, *path.parents):',
                f'for candidate in (path, *(p for p in path.parents if p == Path({str(root)!r}) '
                f'or Path({str(root)!r}) in p.parents)):')
            helper.write_text(helper_text)
            for folder in ('etc/questix_robot', 'etc/questix_pwm_guard', 'boot/firmware/overlays',
                           'var/backups', 'var/tmp', 'run', 'opt/questix_robot'):
                (root/folder).mkdir(mode=0o755, parents=True, exist_ok=True)
            for path in (root, *root.rglob('*')):
                if path.is_dir():
                    path.chmod(0o755)
            (root/'etc/questix_robot/mode').write_text('lesson')
            (root/'boot/firmware/config.txt').write_text('# preserved boot config\n')
            old_launcher = root/'opt/questix_robot/questix_robot_launcher.sh'
            old_launcher.write_text('# legacy launcher preserved\n')
            rollback = source/'questix_pwm_guard/deploy/rollback_reviewed.sh'
            rollback_text = rollback.read_text().replace('$EUID == 0', '$EUID == '+str(os.getuid()))
            for original in ('/etc/questix_pwm_guard', '/etc/systemd/system', '/opt/questix_pwm_guard',
                         '/opt/questix_robot', '/boot/firmware', '/var/backups',
                         '/var/lib/questix_pwm_guard', '/run/questix-rp1-install.lock'):
                rollback_text = rollback_text.replace(original, str(root)+original)
            rollback.write_text(rollback_text)
            rollback_text = rollback.read_text().replace('.st_uid != 0', '.st_uid != '+str(os.getuid()))
            rollback_text = rollback_text.replace('for candidate in (path,*path.parents):',
                f'for candidate in (path,*(p for p in path.parents if p == Path({str(source)!r}) '
                f'or Path({str(source)!r}) in p.parents)):')
            rollback_text = rollback_text.replace('export PATH=/usr/bin:/bin LANG=C', f'export PATH={tools}:/usr/bin:/bin LANG=C')
            rollback.write_text(rollback_text)
            for path in (source, *source.rglob('*')):
                path.chmod(0o755 if path.is_dir() else 0o644)
            digest = seal.digest(source)
            marker = f'QUESTIX_RP1_REVIEW_V2:{digest}'.encode()
            for relative in seal.REQUIRED:
                file = prefix/relative
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b'\x7fELF\x02\x01'+b'\x00'*12+b'\xb7\x00'+marker)
            (prefix/seal.REQUIRED[-1]).write_text('pwm_backend: "auto"\n')
            for package in seal.PACKAGES[:-1]+('questix_launcher',):
                file = prefix/package/'share'/package/'package.xml'
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('<package/>')
            data = dict(schema=3, contract='rp1-reviewed-v3', source_digest=digest,
                        source_files={str(p.relative_to(source)):seal.sha(p) for p in seal.source_files(source)},
                        prefix=str(prefix), install_layout=seal.install_layout(prefix), install_files=seal.install_files(prefix))
            if failure == 'prefix':
                # The CLI path has copied selected artifacts, but the approved table refers elsewhere.
                other = base/'other'
                shutil.copytree(prefix, other)
                data['prefix'] = str(other)
            manifest = prefix/'reviewed-release.json'
            manifest.write_text(json.dumps(data))
            approval = root/'etc/questix_pwm_guard/approved-release.sha256'
            approval.write_text(seal.sha(manifest)+'\n')
            approval.chmod(0o600)
            receipt = source/'reviewed-installer-source.json'
            receipt.write_text(json.dumps(dict(schema=1, contract='rp1-installer-source-v1',
                source_digest=digest, source_files=data['source_files'])))
            receipt.chmod(0o600)
            tools.mkdir()
            scripts = {
                'uname':'#!/bin/sh\necho aarch64\n',
                'id':'#!/bin/sh\ncase \"$1\" in -gn) echo robot;; *) echo 1000;; esac\n',
                'systemctl':'#!/bin/sh\nif [ "$1" = show ]; then echo inactive; fi\n',
                'dtc':'#!/bin/sh\nexit 42\n',
            }
            if failure not in ('dtc', 'copy', 'prefix'):
                scripts['dtc'] = ('#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n'
                                  'if [ "$1" = -o ]; then shift; printf compiled > "$1"; fi\n'
                                  'shift\ndone\n')
            if failure == 'original':
                scripts['dtc'] += f'printf modified > "{prefix}/local_setup.bash"\n'
            if failure == 'copy':
                scripts['install'] = ('#!/bin/sh\n/usr/bin/install "$@" || exit $?\n'
                    'for arg in "$@"; do\n case "$arg" in *stage-*/questix_pwm_ctl)\n'
                    ' printf substituted > "$arg";;\n esac\ndone\n')
            if failure == 'write':
                scripts['install'] = ('#!/bin/sh\n/usr/bin/install "$@" || exit $?\n'
                    f'for arg in "$@"; do\n [ "$arg" != "{root}/etc/systemd/system/questix_pwm_guard.service" ] '
                    '|| exit 47\ndone\n')
            for tool, content in scripts.items():
                file = tools/tool
                file.write_text(content)
                file.chmod(0o755)
            result = subprocess.run(['bash', str(script), str(prefix), pwd.getpwuid(os.getuid()).pw_name],
                                    env=dict(os.environ, PATH=f'{tools}:/usr/bin:/bin'),
                                    capture_output=True, text=True, timeout=30)
            if failure in ('success', 'original', 'write'):
                self.assertEqual(result.returncode, 47 if failure == 'write' else 0,
                                 result.stdout+result.stderr)
                config = root/'etc/questix_pwm_guard'
                if failure == 'write':
                    self.assertEqual((config/'deployment-state').read_text(), 'PARTIAL\n')
                    self.assertTrue((root/'var/lib/questix_pwm_guard/deployment-in-progress').exists())
                else:
                    self.assertEqual((config/'deployment-state').read_text(), 'READY\n')
                    frozen = json.loads((config/'reviewed-release.json').read_text())
                    runtime = Path(frozen['prefix'])
                    self.assertNotEqual(runtime, prefix)
                    self.assertEqual(runtime.parent, root/'opt/questix_pwm_guard/releases')
                    self.assertEqual(frozen['frozen_runtime']['approved_manifest_sha256'], seal.sha(manifest))
                    self.assertEqual(seal.install_files(runtime), data['install_files'])
                    self.assertIn(f'RP1_REVIEW_PREFIX={runtime}\n', (config/'reviewed-launch.env').read_text())
                backup = re.search(r'^BACKUP=(.*)$', result.stdout, re.M).group(1)
                rollback = source/'questix_pwm_guard/deploy/rollback_reviewed.sh'
                restored = subprocess.run(['bash', str(rollback), backup],
                    env=dict(os.environ, PATH=f'{tools}:/usr/bin:/bin'),
                    capture_output=True, text=True, timeout=30)
                self.assertEqual(restored.returncode, 0, restored.stdout+restored.stderr)
                self.assertEqual(old_launcher.read_text(), '# legacy launcher preserved\n')
                self.assertEqual((root/'boot/firmware/config.txt').read_text(), '# preserved boot config\n')
                self.assertFalse((root/'opt/questix_pwm_guard').exists())
                self.assertFalse((root/'etc/systemd/system/questix_pwm_guard.service').exists())
                self.assertFalse((root/'var/lib/questix_pwm_guard/deployment-in-progress').exists())
                self.assertTrue(list((Path(backup)/'withdrawn').glob('*')) if (Path(backup)/'withdrawn').exists()
                                else list(Path(backup).glob('withdrawn-*')))
                return
            self.assertNotEqual(result.returncode, 0, result.stdout)
            if failure == 'copy':
                self.assertIn('staged asset differs', result.stderr)
            elif failure == 'prefix':
                self.assertIn('installer prefix differs', result.stderr)
            else:
                self.assertEqual(result.returncode, 42, result.stderr)
            self.assertEqual((root/'boot/firmware/config.txt').read_text(), '# preserved boot config\n')
            self.assertFalse((root/'opt/questix_pwm_guard').exists())
            self.assertFalse((root/'etc/systemd/system/questix_pwm_guard.service').exists())
            self.assertFalse((root/'etc/questix_pwm_guard/deployment-state').exists())
            self.assertFalse(list((root/'var/backups').iterdir()))

    def test_dt_compile_failure_does_not_modify_installed_assets(self):
        self.exercise('dtc')

    def test_substituted_staged_binary_is_rejected_before_asset_changes(self):
        self.exercise('copy')

    def test_cli_manifest_prefix_mismatch_is_rejected(self):
        self.exercise('prefix')

    def test_frozen_runtime_publication_and_rollback(self):
        self.exercise('success')

    def test_original_prefix_change_after_freeze_does_not_change_release(self):
        self.exercise('original')

    def test_partial_write_failure_blocks_start_and_rollback_restores(self):
        self.exercise('write')


if __name__ == '__main__':
    unittest.main()
