"""Exercise real migration tasks only, under temporary paths without become or devices."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

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
                          {'boot_config_path': str(path)}, check)

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
