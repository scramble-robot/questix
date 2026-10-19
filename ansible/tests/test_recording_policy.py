"""Recording drop-in deployment contracts; only source reads and temporary files."""

import ast
import configparser
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
RELATIVE = 'systemd/questix_robot_manager.service.d/recording.conf'
TARGET = '/etc/systemd/system/questix_robot_manager.service.d/recording.conf'


def source(path):
    """Read a repository file."""
    return (ROOT / path).read_text()


class RecordingPolicy(unittest.TestCase):
    """Keep policy, recorder deadlines and all deployment paths in step."""

    def test_policy_and_recorder_deadlines(self):
        policy = configparser.ConfigParser()
        policy.read_string(source(RELATIVE))
        self.assertEqual(policy['Unit']['After'], 'questix_robot.service')
        self.assertNotIn('Wants', policy['Unit'])
        service = policy['Service']
        self.assertEqual(service['StateDirectory'], 'questix/rosbags')
        self.assertEqual(service['StateDirectoryMode'], '0750')
        self.assertEqual(service['KillMode'], 'mixed')
        constants = {}
        for node in ast.parse(source('scripts/robot_manager/recorder.py')).body:
            if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
                try:
                    constants[node.targets[0].id] = ast.literal_eval(node.value)
                except (ValueError, TypeError):
                    pass
        self.assertEqual('/var/lib/' + service['StateDirectory'],
                         constants['_DEFAULT_CONFIG']['OUTPUT_DIR'])
        self.assertGreater(int(service['TimeoutStopSec']),
                           constants['STOP_TIMEOUT_SEC'] + 5
                           + constants['SHUTDOWN_FINALIZE_TIMEOUT_SEC'])

    def test_all_deployments_use_the_same_source_and_target(self):
        installer = source('scripts/install-robot-manager.sh')
        updater = source('scripts/update-robot-manager.sh')
        self.assertIn('${REPO_DIR}/' + RELATIVE, installer)
        self.assertIn('$REPO_ROOT/' + RELATIVE, updater)
        for script in (installer, updater):
            self.assertIn(TARGET, script)
            self.assertIn('install -d -o root -g root -m 0755 ' + str(Path(TARGET).parent),
                          script)
            self.assertIn('install -o root -g root -m 0644', script)
        tasks = yaml.safe_load(source('ansible/roles/robot_autostart/tasks/robot_manager.yaml'))
        copies = [t for t in tasks if t.get('ansible.builtin.copy', {}).get('dest') == TARGET]
        self.assertEqual(len(copies), 1)
        task = copies[0]
        self.assertEqual(task['ansible.builtin.copy'], {
            'src': '{{ playbook_dir }}/../../' + RELATIVE, 'dest': TARGET,
            'owner': 'root', 'group': 'root', 'mode': '0644'})
        self.assertEqual(task['notify'], ['reload_systemd', 'restart_robot_manager'])
        handlers = yaml.safe_load(source('ansible/roles/robot_autostart/handlers/main.yaml'))
        reload_index = next(i for i, h in enumerate(handlers) if h['name'] == 'reload_systemd')
        restart_index = next(i for i, h in enumerate(handlers)
                             if h['name'] == 'restart_robot_manager')
        self.assertLess(reload_index, restart_index)
        restart = handlers[restart_index]
        self.assertEqual(restart['ansible.builtin.systemd'],
                         {'name': 'questix_robot_manager', 'state': 'restarted'})
        self.assertIn('questix_image_build', restart['when'])
        self.assertNotIn('check_mode', task)
        self.assertNotIn('check_mode', restart)
        for path in ('systemd/questix_robot_manager.service',
                     'ansible/roles/robot_autostart/templates/questix_robot_manager.service.j2'):
            text = source(path)
            for key in ('StateDirectory=', 'StateDirectoryMode=', 'KillMode=', 'TimeoutStopSec=',
                        'After=questix_robot.service'):
                self.assertNotIn(key, text)

    def test_update_check_detects_missing_different_and_current_dropin(self):
        # Source only function definitions. Stub unrelated discovery, never call systemctl,
        # install, pip, privilege cleanup or the live updater entry point.
        script = source('scripts/update-robot-manager.sh').rsplit('main "$@"', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'recording.conf'
            unrelated = Path(directory) / 'custom.conf'
            unrelated.write_text('operator setting\n')
            for content, expected in ((None, 1), ('[Service]\nKillMode=control-group\n', 1),
                                      (source(RELATIVE), 0)):
                if content is not None:
                    target.write_text(content)
                fixture = script + f'''
RECORDING_SOURCE='{ROOT / RELATIVE}'
RECORDING_TARGET='{target}'
installed_dir() {{ echo /unused; }}
is_current() {{ return 0; }}
deps_current() {{ return 0; }}
launcher_current() {{ return 0; }}
network_admin_current() {{ return 0; }}
check_legacy() {{ LEGACY_STATE=0; }}
main --check
'''
                result = subprocess.run(['bash', '-s'], input=fixture, text=True,
                                        capture_output=True, cwd=ROOT, timeout=10)
                self.assertEqual(result.returncode, expected, result.stderr)
                self.assertEqual(unrelated.read_text(), 'operator setting\n')

    def test_dropin_is_loaded_before_existing_restart_flow(self):
        text = source('scripts/update-robot-manager.sh')
        install = text.split('install_recording_config() {', 1)[1].split('\n}', 1)[0]
        self.assertIn('systemctl daemon-reload', install)
        self.assertIn('Managerを再起動', install)
        main = text.split('main() {', 1)[1]
        self.assertLess(main.index('install_recording_config'), main.index('    restart_service'))
        self.assertIn('[ "$recording_ok" = 1 ]', main)
        self.assertNotIn('questix_robot_manager.service" >', install)


if __name__ == '__main__':
    unittest.main()
