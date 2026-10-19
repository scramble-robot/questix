"""Exercise real migration tasks only, under temporary paths without become or devices."""
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]


class ReviewedMigration(unittest.TestCase):
    def apply(self, task, variables, check=False):
        with tempfile.TemporaryDirectory() as temp:
            play = Path(temp) / 'play.yaml'
            play.write_text(json.dumps([{
                'name': 'Isolated reviewed migration', 'hosts': 'localhost',
                'connection': 'local', 'gather_facts': False, 'become': False,
                'vars': dict(variables, ansible_python_interpreter=sys.executable),
                'tasks': [{'name': 'Run only migration tasks',
                           'ansible.builtin.include_tasks': str(ROOT / task)}],
                'handlers': [{'name': 'reboot_required',
                              'ansible.builtin.debug': {'msg': 'fixture only; no reboot'}}],
            }]))
            args = ['ansible-playbook', str(play), '-i', 'localhost,']
            if check:
                args += ['--check', '--diff']
            return subprocess.run(args, cwd=ROOT, env=dict(os.environ, ANSIBLE_CONFIG=str(
                ROOT / 'ansible.cfg')), capture_output=True, text=True)

    def config(self, path, check=False):
        return self.apply('ansible/roles/hardware_interfaces/tasks/rp1_pwm_config.yaml',
                          {'boot_config_path': str(path),
                           'rp1_pwm_backup_dir': str(path.parent / 'backups'),
                           'rp1_pwm_backup_owner': str(os.getuid()),
                           'rp1_pwm_backup_group': str(os.getgid())}, check)

    def backup_file(self, path, content):
        digest = hashlib.sha256(content.encode()).hexdigest()
        return path.parent / 'backups' / ('config.txt.' + digest)

    def assert_one_backup(self, path, original):
        backup = self.backup_file(path, original)
        self.assertEqual(list(backup.parent.iterdir()), [backup])
        self.assertNotIn(':', backup.name)
        self.assertEqual(backup.read_bytes(), original.encode())
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(backup.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(backup.stat().st_uid, os.getuid())
        return backup


    def assert_config_migration(self, legacy, managed=False):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'config.txt'
            block = ('# BEGIN QUESTiX RP1 PWM\n[all]\n'
                     'dtoverlay=questix-gpio13-rp1-pwm\n# END QUESTiX RP1 PWM\n')
            original = ('# operator header\n[pi5]\ndtoverlay=uart0-pi5\nenable_uart=1\n'
                        + legacy + '[all]\ndtoverlay=other-overlay\n'
                        'dtparam=i2c_arm=on\n# operator footer\n' + (block if managed else ''))
            path.write_text(original)
            result = self.config(path)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            after = path.read_text()
            backup = self.assert_one_backup(path, original)
            self.assertIn(str(backup), result.stdout)
            overlays = [line.strip() for line in after.splitlines()
                        if line.strip().startswith('dtoverlay=questix-gpio13-')]
            self.assertEqual(overlays, ['dtoverlay=questix-gpio13-rp1-pwm'])
            self.assertNotIn('# QUESTiX GPIO13', after)
            self.assertNotIn('# QUESTiX reviewed GPIO13', after)
            self.assertEqual(after.count('[all]'), original.count('[all]') + (not managed))
            for line in ('# operator header', '# operator footer', '[pi5]',
                         'dtoverlay=uart0-pi5', 'enable_uart=1', 'dtoverlay=other-overlay',
                         'dtparam=i2c_arm=on'):
                self.assertIn(line, after)
            again = self.config(path)
            self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
            self.assertEqual(path.read_text(), after)
            self.assertRegex(again.stdout, r'changed=0\s')
            self.assert_one_backup(path, original)

    def test_machine_specific_note_migrates_idempotently_in_any_section(self):
        self.assert_config_migration('# QUESTiX GPIO13 RP1 PWM0 (ID<fixture>, fixed844b381)\n'
                                     ' \tdtoverlay=questix-gpio13-pwm\t \n')

    def test_historical_installer_note_migrates_idempotently(self):
        self.assert_config_migration('[all]\n# QUESTiX reviewed GPIO13 PWM0 channel 1\n'
                                     'dtoverlay=questix-gpio13-pwm\n')

    def test_partial_deployment_with_both_overlays_migrates_idempotently(self):
        self.assert_config_migration('[all]\n# QUESTiX GPIO13 RP1 PWM0 (ID<fixture>, fixed844b381)\n'
                                     'dtoverlay=questix-gpio13-pwm\n', managed=True)

    def test_custom_near_matches_fail_without_any_config_change(self):
        for line in ('dtoverlay=questix-gpio13-pwm,custom=1',
                     'dtoverlay =questix-gpio13-pwm',
                     'dtoverlay=questix-gpio13-pwm-custom',
                     '#dtoverlay=questix-gpio13-pwm',
                     'dtoverlay=questix-gpio13-rp1-pwm,custom=1'):
            with self.subTest(line=line), tempfile.TemporaryDirectory() as temp:
                path = Path(temp) / 'config.txt'
                original = '[all]\n' + line + '\n'
                path.write_text(original)
                result = self.config(path)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Unrecognized GPIO13 PWM', result.stdout)
                self.assertIn(line, result.stdout)
                self.assertEqual(path.read_text(), original)
                self.assertFalse((path.parent / 'backups').exists())

    def test_unpaired_identical_annotation_is_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'config.txt'
            annotation = '# QUESTiX reviewed GPIO13 PWM0 channel 1\n'
            path.write_text('[all]\n' + annotation + '# custom intervening line\n# operator GPIO13 note for questix-gpio13-pwm\n'
                            'dtoverlay=questix-gpio13-pwm\n')
            result = self.config(path)
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertIn(annotation + '# custom intervening line', path.read_text())
            self.assertIn('# operator GPIO13 note', path.read_text())

    def test_check_mode_leaves_legacy_config_untouched(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'config.txt'
            original = ('[all]\n# QUESTiX reviewed GPIO13 PWM0 channel 1\n'
                        'dtoverlay=questix-gpio13-pwm\n')
            path.write_text(original)
            result = self.config(path, check=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(path.read_text(), original)
            self.assertFalse((path.parent / 'backups').exists())

    def test_new_or_changed_managed_block_is_backed_up_once(self):
        for initial in ('[pi5]\ndtoverlay=uart0-pi5\n',
                        '# BEGIN QUESTiX RP1 PWM\n[all]\n# stale block\n'
                        '# END QUESTiX RP1 PWM\n'):
            with self.subTest(initial=initial), tempfile.TemporaryDirectory() as temp:
                path = Path(temp) / 'config.txt'
                path.write_text(initial)
                result = self.config(path)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assert_one_backup(path, initial)
                again = self.config(path)
                self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
                self.assertRegex(again.stdout, r'changed=0\s')
                self.assert_one_backup(path, initial)

    def test_matching_managed_block_alone_creates_no_backup(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'config.txt'
            original = ('# BEGIN QUESTiX RP1 PWM\n[all]\n'
                        'dtoverlay=questix-gpio13-rp1-pwm\n# END QUESTiX RP1 PWM\n')
            path.write_text(original)
            result = self.config(path)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertRegex(result.stdout, r'changed=0\s')
            self.assertEqual(path.read_text(), original)
            self.assertFalse((path.parent / 'backups').exists())

    def test_wrong_backup_checksum_stops_before_any_config_edit(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'config.txt'
            original = ('[all]\n# QUESTiX GPIO13 RP1 PWM0\n'
                        'dtoverlay=questix-gpio13-pwm\n')
            path.write_text(original)
            backup = self.backup_file(path, original)
            backup.parent.mkdir()
            backup.write_text('deliberately corrupted preimage\n')
            result = self.config(path)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('backup SHA-256 mismatch', result.stdout)
            self.assertEqual(path.read_text(), original)
            self.assertEqual(backup.read_text(), 'deliberately corrupted preimage\n')

    def test_boot_partition_writers_never_use_adjacent_backups(self):
        # Track boot-valued defaults (including aliases), then inspect nested role tasks.
        # This covers literal paths and destinations such as {{ boot_config_path }}.
        roles = ROOT / 'ansible/roles'
        defaults = {}
        for path in roles.glob('*/defaults/*.y*ml'):
            defaults.update(yaml.safe_load(path.read_text()) or {})
        boot_vars = set()
        for _ in range(len(defaults) + 1):
            for key, value in defaults.items():
                text = str(value)
                if '/boot/' in text or boot_vars.intersection(re.findall(r'\b\w+\b', text)):
                    boot_vars.add(key)
        checked = []

        def inspect(tasks, path):
            for task in tasks:
                if not isinstance(task, dict):
                    continue
                for section in ('block', 'rescue', 'always'):
                    inspect(task.get(section, []), path)
                for action, args in task.items():
                    if action.split('.')[-1] not in ('copy', 'template', 'replace', 'lineinfile', 'blockinfile'):
                        continue
                    if not isinstance(args, dict):
                        continue
                    dest = str(args.get('dest', args.get('path', '')))
                    if '/boot/' in dest or boot_vars.intersection(re.findall(r'\b\w+\b', dest)):
                        checked.append(str(path))
                        self.assertIn(args.get('backup', False), (False, 'false', 'no'),
                                      f'Adjacent backup on a boot partition: {path}: {task.get("name")}')
        for path in roles.glob('*/tasks/*.y*ml'):
            inspect(yaml.safe_load(path.read_text()) or [], path)
        self.assertIn(str(roles / 'hardware_interfaces/tasks/rp1_pwm_config.yaml'), checked)
        self.assertGreaterEqual(len(checked), 8)
        self.assertEqual(defaults['rp1_pwm_backup_dir'], '/var/backups/questix')
        self.assertEqual(defaults['rp1_pwm_backup_owner'], 'root')
        self.assertEqual(defaults['rp1_pwm_backup_group'], 'root')

    def dropin(self, directory, check=False):
        return self.apply('ansible/roles/pwm_guard/tasks/migrate_reviewed.yaml',
                          {'pwm_guard_robot_dropin_dir': str(directory)}, check)

    def test_both_historical_dropins_removed_once_other_dropins_preserved(self):
        for version in (1, 2):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                legacy = directory / '50-rp1-pwm.conf'
                legacy.write_bytes((ROOT / 'ansible/roles/pwm_guard/files' /
                                    f'reviewed-dropin-v{version}.conf').read_bytes())
                other = directory / 'operator.conf'
                other.write_text('[Service]\nRestartPreventExitStatus=78\n')
                result = self.dropin(directory)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertFalse(legacy.exists())
                self.assertEqual(other.read_text(), '[Service]\nRestartPreventExitStatus=78\n')
                again = self.dropin(directory)
                self.assertEqual(again.returncode, 0, again.stdout)
                self.assertRegex(again.stdout, r'changed=0\s')

    def test_unknown_dropin_and_broken_link_are_refused_without_removal(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            legacy = directory / '50-rp1-pwm.conf'
            legacy.write_text('[Unit]\n# administrator custom\n')
            result = self.dropin(directory)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(legacy.read_text(), '[Unit]\n# administrator custom\n')
            legacy.unlink()
            legacy.symlink_to(directory / 'missing')
            self.assertNotEqual(self.dropin(directory).returncode, 0)
            self.assertTrue(legacy.is_symlink())


if __name__ == '__main__':
    unittest.main()
