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
            text = text.replace('.st_uid != 0', '.st_uid != '+str(os.getuid()))
            script.write_text(text)
            helper = source/'questix_pwm_guard/deploy/review_manifest.py'
            helper.write_text(helper.read_text().replace('.st_uid != 0', '.st_uid != '+str(os.getuid())))
            for folder in ('etc/questix_robot', 'etc/questix_pwm_guard', 'boot/firmware/overlays',
                           'var/backups', 'var/tmp', 'run'):
                (root/folder).mkdir(parents=True, exist_ok=True)
            (root/'etc/questix_robot/mode').write_text('lesson')
            (root/'boot/firmware/config.txt').write_text('# preserved boot config\n')
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
            data = dict(schema=2, contract='rp1-reviewed-v2', source_digest=digest,
                        source_files={str(p.relative_to(source)):seal.sha(p) for p in seal.source_files(source)},
                        prefix=str(prefix), install_files=seal.install_files(prefix))
            manifest = prefix/'reviewed-release.json'
            manifest.write_text(json.dumps(data))
            approval = root/'etc/questix_pwm_guard/approved-release.sha256'
            approval.write_text(seal.sha(manifest)+'\n')
            approval.chmod(0o600)
            tools.mkdir()
            scripts = {
                'uname':'#!/bin/sh\necho aarch64\n',
                'id':'#!/bin/sh\ncase \"$1\" in -gn) echo robot;; *) echo 1000;; esac\n',
                'systemctl':'#!/bin/sh\nif [ "$1" = show ]; then echo inactive; fi\n',
                'dtc':'#!/bin/sh\nexit 42\n',
            }
            if failure == 'copy':
                scripts['install'] = ('#!/bin/sh\n/usr/bin/install "$@" || exit $?\n'
                    'for arg in "$@"; do\n case "$arg" in *stage-*/questix_pwm_ctl)\n'
                    ' printf substituted > "$arg";;\n esac\ndone\n')
            for tool, content in scripts.items():
                file = tools/tool
                file.write_text(content)
                file.chmod(0o755)
            result = subprocess.run(['bash', str(script), str(prefix), pwd.getpwuid(os.getuid()).pw_name],
                                    env=dict(os.environ, PATH=f'{tools}:/usr/bin:/bin'),
                                    capture_output=True, text=True, timeout=30)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            if failure == 'copy':
                self.assertIn('staged asset differs', result.stderr)
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


if __name__ == '__main__':
    unittest.main()
