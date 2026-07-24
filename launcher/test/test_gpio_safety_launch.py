# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.

import os
from pathlib import Path
import xml.etree.ElementTree as ET

import yaml


SOURCE_ROOT = Path(os.environ['QUESTIX_SOURCE_ROOT'])


def load_xml(relative_path):
    return ET.parse(SOURCE_ROOT / relative_path).getroot()


def load_yaml(relative_path):
    with (SOURCE_ROOT / relative_path).open(encoding='utf-8') as stream:
        return yaml.safe_load(stream)


def find_arg(root, name):
    return next(arg for arg in root.findall('./arg') if arg.get('name') == name)


def test_profiles_select_the_expected_gpio_inputs_and_polarities():
    practice_reader = load_yaml('gpio_reader/config/gpio_reader.practice.yaml')
    competition_reader = load_yaml('gpio_reader/config/gpio_reader.competition.yaml')
    default_reader = load_yaml('gpio_reader/config/gpio_reader.yaml')
    practice_manager = load_yaml(
        'operation_manager/config/operation_manager.practice.yaml')
    competition_manager = load_yaml(
        'operation_manager/config/operation_manager.competition.yaml')
    default_manager = load_yaml('operation_manager/config/operation_manager.yaml')

    assert practice_reader['gpio_reader_node']['ros__parameters']['gpio_pins'] == [5]
    assert competition_reader['gpio_reader_node']['ros__parameters']['gpio_pins'] == [5, 27]
    assert default_reader == practice_reader

    practice_parameters = practice_manager['operation_manager_node']['ros__parameters']
    competition_parameters = competition_manager[
        'operation_manager_node']['ros__parameters']
    assert practice_parameters['safe_low_pins'] == [5]
    assert practice_parameters['safe_high_pins'] == []
    assert competition_parameters['safe_low_pins'] == [5]
    assert competition_parameters['safe_high_pins'] == [27]
    assert default_manager == practice_manager


def test_core_defaults_to_practice_and_selects_both_profile_files():
    core = load_xml('launcher/launch/questix_core.launch.xml')
    assert find_arg(core, 'enable_autoreferee').get('default') == 'false'
    invalid_condition = (
        '$(and $(var enable_autoreferee) $(not $(var enable_gpio_ref)))')
    fail_fast_group = next(
        group for group in core.findall('./group')
        if group.find('./timer/shutdown') is not None
    )
    assert fail_fast_group.get('if') == invalid_condition
    warning = fail_fast_group.find('./log')
    assert warning is not None
    assert warning.get('message') == (
        'ERROR: enable_autoreferee=true requires enable_gpio_ref=true')
    timer = fail_fast_group.find('./timer')
    assert timer is not None
    assert timer.get('period') == '0.01'
    shutdown = timer.find('./shutdown')
    assert shutdown is not None
    assert shutdown.get('reason') == (
        'Invalid configuration: enable_autoreferee=true requires '
        'enable_gpio_ref=true')

    lets = {(
        item.get('name'),
        item.get('if'),
        item.get('unless'),
        item.get('value'),
    ) for item in core.findall('./let')}
    assert (
        'gpio_reader_config_file',
        None,
        '$(var enable_autoreferee)',
        '$(find-pkg-share gpio_reader)/config/gpio_reader.practice.yaml',
    ) in lets
    assert (
        'gpio_reader_config_file',
        '$(var enable_autoreferee)',
        None,
        '$(find-pkg-share gpio_reader)/config/gpio_reader.competition.yaml',
    ) in lets
    assert (
        'operation_manager_config_file',
        None,
        '$(var enable_autoreferee)',
        '$(find-pkg-share operation_manager)/config/operation_manager.practice.yaml',
    ) in lets
    assert (
        'operation_manager_config_file',
        '$(var enable_autoreferee)',
        None,
        '$(find-pkg-share operation_manager)/config/operation_manager.competition.yaml',
    ) in lets


def test_core_owns_exactly_one_operation_manager_when_gpio_ref_is_enabled():
    core = load_xml('launcher/launch/questix_core.launch.xml')
    manager_includes = [
        include for include in core.findall('.//include')
        if 'find-pkg-share operation_manager' in include.get('file', '')
    ]
    assert len(manager_includes) == 1
    manager_group = next(
        group for group in core.findall('./group')
        if manager_includes[0] in list(group)
    )
    assert manager_group.get('if') == '$(var enable_gpio_ref)'

    drive_include = next(
        include for include in core.findall('.//include')
        if 'drive_component.launch.xml' in include.get('file', '')
    )
    manager_arg = next(
        arg for arg in drive_include.findall('./arg')
        if arg.get('name') == 'enable_operation_manager'
    )
    assert manager_arg.get('value') == 'false'

    drive = load_xml('launcher/launch/drive_component.launch.xml')
    assert find_arg(drive, 'enable_operation_manager').get('default') == 'true'
    referee_include = next(
        include for include in drive.findall('.//include')
        if 'joy_controller_referee.launch.xml' in include.get('file', '')
    )
    forwarded_arg = next(
        arg for arg in referee_include.findall('./arg')
        if arg.get('name') == 'enable_operation_manager'
    )
    assert forwarded_arg.get('value') == '$(var enable_operation_manager)'

    referee = load_xml('joy_controller/launch/joy_controller_referee.launch.xml')
    assert find_arg(referee, 'enable_operation_manager').get('default') == 'true'
    nested_managers = [
        node for node in referee.findall('.//node')
        if node.get('pkg') == 'operation_manager'
    ]
    assert len(nested_managers) == 1
    assert nested_managers[0].get('if') == '$(var enable_operation_manager)'

    def integrated_manager_count(enable_drive, enable_shot, enable_gpio_ref):
        del enable_shot  # operation_manager ownership is independent of shot.
        core_manager_count = int(enable_gpio_ref)
        nested_manager_enabled = manager_arg.get('value') != 'false'
        nested_manager_count = int(
            enable_drive and enable_gpio_ref and nested_manager_enabled)
        return core_manager_count + nested_manager_count

    assert integrated_manager_count(False, False, True) == 1
    assert integrated_manager_count(True, True, True) == 1


def test_competition_service_launchers_always_enable_gpio_safety():
    launcher_paths = (
        'systemd/questix_robot_launcher.sh',
        'ansible/roles/robot_autostart/files/questix_robot_launcher.sh',
    )
    launcher_texts = []
    for relative_path in launcher_paths:
        text = (SOURCE_ROOT / relative_path).read_text(encoding='utf-8')
        launcher_texts.append(text)
        assert 'LAUNCH_ARGS="${LAUNCH_ARGS} enable_gpio_ref:=true"' in text
        assert 'LAUNCH_ARGS="${LAUNCH_ARGS} enable_autoreferee:=true"' in text
        assert 'enable_gpio_ref:=${ENABLE_GPIO_REF' not in text
        assert 'if [ "${MODE}" != "competition" ]' in text

    safety_lines = [
        [
            line.strip() for line in text.splitlines()
            if 'enable_gpio_ref:=' in line or 'enable_autoreferee:=' in line
        ]
        for text in launcher_texts
    ]
    assert safety_lines[0] == safety_lines[1]


def test_launch_environment_defaults_enable_gpio_safety():
    systemd_env = (
        SOURCE_ROOT / 'systemd/questix_robot.env').read_text(encoding='utf-8')
    ansible_env = (
        SOURCE_ROOT / 'ansible/roles/robot_autostart/templates/launch.env.j2'
    ).read_text(encoding='utf-8')

    assert 'ENABLE_GPIO_REF=true' in systemd_env.splitlines()
    assert 'ENABLE_GPIO_REF=true' in ansible_env.splitlines()


def test_installers_preserve_existing_environment_but_launcher_is_safe():
    installer = (
        SOURCE_ROOT / 'scripts/install-robot-manager.sh'
    ).read_text(encoding='utf-8')
    ansible_tasks = (
        SOURCE_ROOT / 'ansible/roles/robot_autostart/tasks/main.yaml'
    ).read_text(encoding='utf-8')

    assert (
        '"${REPO_DIR}/systemd/questix_robot.env" > '
        '/etc/questix_robot/launch.env'
    ) in installer
    assert 'launch.env already exists, skipping' in installer
    assert 'src: launch.env.j2' in ansible_tasks
    assert 'force: false' in ansible_tasks
