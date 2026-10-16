"""Standard deployment contracts using temporary files, no root/services/GPIO/builds."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]


def read(relative):
    """Read a tracked source asset."""
    return (ROOT / relative).read_text()


def unit_values(text, key):
    """Return active unit keys only, ignoring comments and unrelated properties."""
    return re.findall(r'^' + re.escape(key) + r'=(.*)$', text, re.M)


class StandardDeploymentTest(unittest.TestCase):
    def test_ordering_is_consistent_without_a_drive_dependency(self):
        assets = ('systemd/questix_robot.service',
                  'ansible/roles/robot_autostart/templates/questix_robot.service.j2',
                  'systemd/questix_robot.service.d/pwm-guard-order.conf')
        for asset in assets:
            with self.subTest(asset=asset):
                text = read(asset)
                self.assertIn('questix_pwm_guard.service', ' '.join(unit_values(text, 'After')))
                self.assertFalse(unit_values(text, 'Requires'))
                self.assertFalse(unit_values(text, 'Wants'))
        guard = read('questix_pwm_guard/systemd/questix_pwm_guard.service.in')
        self.assertEqual(unit_values(guard, 'WantedBy'), ['multi-user.target'])
        self.assertEqual(unit_values(guard, 'CapabilityBoundingSet'), [''])
        self.assertEqual(unit_values(guard, 'AmbientCapabilities'), [''])
        self.assertEqual(unit_values(guard, 'ProtectSystem'), ['strict'])
        self.assertEqual(unit_values(guard, 'NoNewPrivileges'), ['yes'])
        self.assertEqual(unit_values(guard, 'ReadWritePaths'), [
            '/run/questix_pwm_guard /sys/devices/platform/axi/1000120000.pcie/1f00098000.pwm'])

    def test_installer_actual_sed_preserves_order_and_user_configuration(self):
        text = read('scripts/install-robot-manager.sh')
        statement = re.search(r'sed \\\n(?:.*\n)*?  "\$\{REPO_DIR\}/systemd/questix_robot.service" '
                              r'> /etc/systemd/system/questix_robot.service', text)
        self.assertIsNotNone(statement)
        # Start at the sed that configures the unit, not an earlier launch.env sed.
        command = statement.group().rsplit('sed \\\n', 1)[-1]
        command = 'sed \\\n' + command.replace('> /etc/systemd/system/questix_robot.service',
                                                '> "$QA_UNIT"')
        with tempfile.TemporaryDirectory() as tmp:
            unit = Path(tmp) / 'robot.service'
            env = dict(os.environ, REPO_DIR=str(ROOT), TARGET_USER='student',
                       ROBOT_WS='/home/student/questix', ROS_DISTRO='jazzy', QA_UNIT=str(unit))
            subprocess.run(['bash', '-e', '-c', command], env=env, check=True)
            result = unit.read_text()
            self.assertEqual(unit_values(result, 'After'), ['network.target questix_pwm_guard.service'])
            self.assertEqual(unit_values(result, 'User'), ['student'])
            self.assertIn('Environment=ROBOT_WS=/home/student/questix', result)

    def test_updater_adds_only_its_dropin_and_reload_failure_preserves_launcher(self):
        text = read('scripts/update-robot-manager.sh')
        function = re.search(r'install_launcher\(\) \{.*?\n\}', text, re.S).group()
        for fail_reload in (False, True):
            with self.subTest(fail_reload=fail_reload), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                units = root / 'units'
                units.mkdir()
                other = units / 'launcher-config.conf'
                other.write_text('[Service]\nRestartPreventExitStatus=78\n')
                unrelated = units / '99-local.conf'
                unrelated.write_text('[Service]\nTimeoutStartSec=60\n')
                launcher = root / 'launcher'
                launcher.write_text('previous launcher')
                log = root / 'calls'
                command_function = function.replace('/etc/systemd/system/questix_robot.service.d', str(units))
                # Test doubles perform only temporary-file copies; never call real systemctl.
                stubs = r'''
install() {
  local last="${!#}"
  if [ "$1" = -d ]; then mkdir -p "$last"; return; fi
  local args=("$@")
  cp "${args[$#-2]}" "$last"
}
systemctl() {
  [ "$*" = daemon-reload ] || return 95
  echo reload >> "$QA_LOG"
  return "$QA_RELOAD_CODE"
}
'''
                env = dict(os.environ, REPO_ROOT=str(ROOT), LAUNCHER_SOURCE=str(ROOT/'systemd/questix_robot_launcher.sh'),
                           LAUNCHER_TARGET=str(launcher), QA_LOG=str(log),
                           LAUNCHER_POLICY_DIR=str(units),
                           LAUNCHER_POLICY_SOURCE=str(ROOT/'systemd/questix_robot.service.d/launcher-config.conf'),
                           LAUNCHER_POLICY_TARGET=str(other),
                           QA_RELOAD_CODE='1' if fail_reload else '0')
                result = subprocess.run(['bash', '-e', '-c', stubs + command_function + '\ninstall_launcher'],
                                        env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, not fail_reload)
                self.assertEqual(other.read_text(),
                                 read('systemd/questix_robot.service.d/launcher-config.conf'))
                self.assertEqual(unrelated.read_text(), '[Service]\nTimeoutStartSec=60\n')
                self.assertEqual((units/'pwm-guard-order.conf').read_text(),
                                 read('systemd/questix_robot.service.d/pwm-guard-order.conf'))
                self.assertEqual(launcher.read_text(), 'previous launcher' if fail_reload
                                 else read('systemd/questix_robot_launcher.sh'))
                self.assertEqual(log.read_text(), 'reload\n')

    def test_role_enables_without_starting_and_uses_reviewed_snapshot(self):
        tasks = yaml.safe_load(read('ansible/roles/pwm_guard/tasks/main.yaml'))
        service = [t['ansible.builtin.systemd'] for t in tasks if 'ansible.builtin.systemd' in t]
        self.assertEqual(len(service), 1)
        self.assertTrue(service[0]['enabled'])
        self.assertEqual(service[0]['name'], 'questix_pwm_guard.service')
        self.assertNotIn('state', service[0])
        self.assertIn('questix_image_build', service[0]['daemon_reload'])
        command = [t['ansible.builtin.command']['argv'] for t in tasks
                   if 'ansible.builtin.command' in t
                   and t['ansible.builtin.command']['argv'][0] == '/usr/bin/env'][0]
        self.assertEqual(command[:4], ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C'])
        self.assertIn('--if-changed', command)
        self.assertIn('--noprofile', command)
        self.assertIn('--norc', command)
        self.assertFalse(any('workspace_path' in a or '/install/' in a for a in command))
        inventory = next(t for t in tasks if 'ansible.builtin.command' in t
                         and '--inventory' in t['ansible.builtin.command']['argv'])
        self.assertEqual(inventory['delegate_to'], 'localhost')
        self.assertFalse(inventory['become'])
        self.assertEqual(inventory['ansible.builtin.command']['argv'][:2], ['/usr/bin/python3', '-I'])
        stage = next(t['ansible.builtin.set_fact']['pwm_guard_source_stage'] for t in tasks
                     if 'ansible.builtin.set_fact' in t)
        self.assertIn("hash('sha256')", stage)
        self.assertIn('pwm_guard_source_files.stdout', stage)

    def test_overlay_is_identical_gpio13_only_and_persisted_for_flash_kernel(self):
        source = read('ansible/roles/hardware_interfaces/files/gpio13-rp1-pwm.dts')
        self.assertEqual(source, read('questix_pwm_guard/deploy/gpio13-rp1-pwm.dts'))
        self.assertIn('pins = "gpio13"', source)
        self.assertIn('target = <&rp1_pwm0>', source)
        self.assertNotIn('target = <&rp1_pwm1>', source)
        defaults = yaml.safe_load(read('ansible/roles/hardware_interfaces/defaults/main.yaml'))
        self.assertEqual(defaults['rp1_pwm_source_dir'], '/etc/flash-kernel/dtbs/overlays')
        tasks = yaml.safe_load(read('ansible/roles/hardware_interfaces/tasks/rp1_pwm.yaml'))
        compiler = next(t for t in tasks if 'ansible.builtin.command' in t)
        self.assertIn('not rp1_pwm_compiled.stat.exists', compiler['when'])
        self.assertIn('rp1_pwm_source.changed', compiler['when'])
        copies = [t['ansible.builtin.copy'] for t in tasks if 'ansible.builtin.copy' in t]
        self.assertTrue(any('rp1_pwm_boot_overlay_dir' in c['dest'] and c['remote_src'] for c in copies))
        config = next(t for t in yaml.safe_load(
            read('ansible/roles/hardware_interfaces/tasks/rp1_pwm_config.yaml'))
            if 'ansible.builtin.blockinfile' in t)
        self.assertEqual(config['ansible.builtin.blockinfile']['insertafter'], 'EOF')
        self.assertEqual(config['ansible.builtin.blockinfile']['block'],
                         '[all]\ndtoverlay=questix-gpio13-rp1-pwm\n')

    def test_backend_defaults_and_kit_role(self):
        values = yaml.safe_load(read('esc_motor_control_cpp/config/esc_motor_control_cpp.yaml'))
        self.assertEqual(values['esc_motor_control']['ros__parameters']['pwm_backend'], 'rp1_hw')
        cpp = read('esc_motor_control_cpp/src/esc_motor_control_component.cpp')
        self.assertRegex(cpp, r'declare_parameter<std::string>\("pwm_backend",\s*"rp1_hw"\)')
        self.assertIn('no simulation fallback', cpp)
        kit = yaml.safe_load(read('ansible/playbooks/setup_kit.yaml'))[0]
        role = next(r for r in kit['roles'] if r['role'] == 'pwm_guard')
        self.assertIn('questix_rp1_pwm', role['when'])
        self.assertNotIn('pwm_guard', read('ansible/playbooks/setup_dev.yaml'))


if __name__ == '__main__':
    unittest.main()
