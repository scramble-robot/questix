"""Source-only setup migration contracts: real Ansible tasks, temporary files, fake commands."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]


def executable(path, text):
    path.write_text(text)
    path.chmod(0o755)


def run_tasks(directory, tasks, variables, env):
    play = directory / 'play.json'
    play.write_text(json.dumps([{'name': 'Isolated setup migration', 'hosts': 'localhost',
                                'connection': 'local', 'gather_facts': False, 'become': False,
                                'vars': dict(variables, ansible_python_interpreter=sys.executable),
                                'tasks': tasks}]))
    return subprocess.run(['ansible-playbook', str(play), '-i', 'localhost,'], cwd=ROOT,
                          env=dict(env, ANSIBLE_CONFIG=str(ROOT / 'ansible.cfg')),
                          capture_output=True, text=True)


class SetupMigration(unittest.TestCase):
    def test_rosdep_receives_sources_only_with_or_without_ignore_markers(self):
        role = yaml.safe_load((ROOT / 'ansible/roles/ros2_build/tasks/main.yaml').read_text())
        block = next(t['block'] for t in role if t['name'] == 'Build the QUESTiX workspace')
        start = next(i for i, t in enumerate(block) if t['name'].startswith('Find source roots'))
        end = next(i for i, t in enumerate(block) if t['name'] == "Install the workspace's rosdep dependencies")
        tasks = block[start:end + 1]
        real_colcon = shutil.which('colcon')
        variants = [None] + ([real_colcon] if real_colcon else [])
        for colcon in variants:
            for ignores in (False, True):
                with self.subTest(real_colcon=bool(colcon), ignores=ignores), tempfile.TemporaryDirectory() as temp:
                    directory = Path(temp)
                    ws = directory / 'ws'
                    manifest = ('<package format="3"><name>{name}</name><version>0.0.1</version>'
                                '<description>fixture</description><maintainer email="fixture@example.invalid">'
                                'fixture</maintainer><license>MIT</license><buildtool_depend>ament_cmake'
                                '</buildtool_depend><export><build_type>ament_cmake</build_type></export></package>')
                    for relative in ('core', 'src/external', 'build/obsolete_build', 'log/obsolete_log'):
                        p = ws / relative
                        p.mkdir(parents=True)
                        (p / 'package.xml').write_text(manifest.format(name=p.name))
                    old = ws / 'install/joy_gate/share/joy_gate'
                    old.mkdir(parents=True)
                    (old / 'package.xml').symlink_to(ws / 'removed/joy_gate/package.xml')
                    if ignores:
                        for name in ('build', 'install', 'log'):
                            (ws / name / 'COLCON_IGNORE').touch()
                    tools = directory / 'tools'
                    tools.mkdir()
                    if colcon:
                        (tools / 'colcon').symlink_to(colcon)
                    else:
                        # Deliberately no build/install/log filtering here: only the real role
                        # chooses safe recursion roots. A regression discovers stale manifests.
                        executable(tools / 'colcon', '''#!/usr/bin/python3
import os,sys
from pathlib import Path
assert sys.argv[1:4]==['list','--paths-only','--base-paths']
for base in sys.argv[4:]:
 for folder,dirs,files in os.walk(base):
  if 'package.xml' in files:
   Path(folder,'package.xml').read_text()
   print(folder);dirs[:]=[]
''')
                    executable(tools / 'rosdep', '''#!/usr/bin/python3
import json,os,sys
open(os.environ['TEST_ROSDEP_ARGS'],'w').write(json.dumps(sys.argv[1:]))
''')
                    capture = directory / 'rosdep.json'
                    env = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ['PATH'],
                               TEST_ROSDEP_ARGS=str(capture))
                    result = run_tasks(directory, tasks, {'workspace_path': str(ws),
                        'questix_image_build': False, 'target_user': os.environ['USER'],
                        'workspace_rosdep_become': False, 'workspace_user_ros_home': str(directory / 'ros'),
                        'ros2_distro': 'jazzy'}, env)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    args = json.loads(capture.read_text())
                    sources = args[args.index('--from-paths') + 1:args.index('--ignore-src')]
                    self.assertEqual(set(sources), {str(ws / 'core'), str(ws / 'src/external')})
                    self.assertTrue((old / 'package.xml').is_symlink())

    def verify(self, setup, timeout_status):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        directory = Path(temp.name)
        tools = directory / 'tools'
        tools.mkdir()
        capture = directory / 'timeout.args'
        executable(tools / 'timeout', '#!/bin/sh\nprintf "%s\\n" "$*" > "$TEST_TIMEOUT_ARGS"\nexit "$TEST_TIMEOUT_STATUS"\n')
        source = directory / 'setup.bash'
        if setup is not None:
            source.write_text(setup)
        task = {'name': 'Verify only', 'ansible.builtin.include_tasks': str(
            ROOT / 'ansible/roles/ros2_installation/tasks/verify.yaml')}
        env = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ['PATH'],
                   TEST_TIMEOUT_ARGS=str(capture), TEST_TIMEOUT_STATUS=str(timeout_status))
        result = run_tasks(directory, [task], {'ros2_verification_setup': str(source),
                                              'ros2_distro_to_use': 'jazzy'}, env)
        return result, capture

    def test_ros_verification_accepts_only_expected_distro_and_demo_timeout(self):
        # Reproduce Jazzy's unset-variable use; nounset may be relaxed only during source.
        setup = 'if [ -n "$AMENT_TRACE_SETUP_FILES" ]; then :; fi\nexport ROS_DISTRO=jazzy ROS_VERSION=2\n'
        result, capture = self.verify(setup, 124)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(capture.read_text().strip(), '5 ros2 run demo_nodes_cpp talker')
        for status in (0, 1, 125, 127, 137):
            with self.subTest(status=status):
                result, _ = self.verify(setup, status)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('ROS demo failed', result.stdout)

    def test_missing_wrong_and_failed_setup_are_not_reported_as_success(self):
        for setup in (None, 'export ROS_DISTRO=wrong ROS_VERSION=2\n',
                      'unset ROS_DISTRO\nexport ROS_VERSION=2\n', 'return 7\n'):
            with self.subTest(setup=setup):
                result, capture = self.verify(setup, 124)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(capture.exists())

    def test_upgrade_default_and_false_gate_without_executing_apt(self):
        defaults = yaml.safe_load((ROOT / 'ansible/roles/ros2_installation/defaults/main.yaml').read_text())
        self.assertIs(defaults['questix_os_upgrade'], True)
        tasks = yaml.safe_load((ROOT / 'ansible/roles/ros2_installation/tasks/main.yaml').read_text())
        upgrade = next(t for t in tasks if t.get('ansible.builtin.apt', {}).get('upgrade') == 'dist')
        for flag, expected in ((True, True), (False, False), ('false', False)):
            with self.subTest(flag=flag), tempfile.TemporaryDirectory() as temp:
                # Evaluate the actual task's condition with a harmless debug action.
                task = {'name': 'upgrade gate fixture', 'when': upgrade['when'],
                        'ansible.builtin.debug': {'msg': 'DIST_UPGRADE_SELECTED'}}
                result = run_tasks(Path(temp), [task], {'questix_os_upgrade': flag}, os.environ)
                self.assertEqual(result.returncode, 0, result.stdout)
                self.assertEqual('DIST_UPGRADE_SELECTED' in result.stdout, expected)

    def test_executable_entrypoints_forward_upgrade_option_without_running_setup(self):
        for name in ('setup.sh', 'setup_dev.sh'):
            with self.subTest(script=name), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                tools = directory / 'tools'
                tools.mkdir()
                capture = directory / 'args.json'
                executable(tools / 'python3', '#!/bin/sh\nprintf "11\\n"\n')
                executable(tools / 'ansible-playbook', '''#!/usr/bin/python3
import json,os,sys
open(os.environ['TEST_ANSIBLE_ARGS'],'w').write(json.dumps(sys.argv[1:]))
''')
                path = ROOT / name
                self.assertTrue(path.stat().st_mode & 0o111)
                env = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ['PATH'],
                           TEST_ANSIBLE_ARGS=str(capture))
                result = subprocess.run([str(path), '-e', 'questix_os_upgrade=false'], env=env,
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('questix_os_upgrade=false', json.loads(capture.read_text()))


if __name__ == '__main__':
    unittest.main()
