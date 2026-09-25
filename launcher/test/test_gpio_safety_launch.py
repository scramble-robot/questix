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
    assert 'safe_high_pins' not in practice_parameters
    assert competition_parameters['safe_low_pins'] == [5]
    assert competition_parameters['safe_high_pins'] == [27]
    assert 'safe_high_pins' not in default_manager[
        'operation_manager_node']['ros__parameters']
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

    valid_group = next(
        group for group in core.findall('./group')
        if group.get('unless') == invalid_condition
    )
    assert fail_fast_group.find('.//include') is None
    assert fail_fast_group.find('.//node') is None
    assert len(valid_group.findall('.//include')) == len(core.findall('.//include'))
    assert len(valid_group.findall('.//node')) == len(core.findall('.//node'))
    guarded_files = {
        include.get('file') for include in valid_group.findall('.//include')
    }
    assert any('shot_component.launch.xml' in path for path in guarded_files)
    assert any('drive_component.launch.xml' in path for path in guarded_files)
    assert any('ydlidar_launch.py' in path for path in guarded_files)
    assert any('gpio_reader.launch.xml' in path for path in guarded_files)
    assert any('operation_manager.launch.xml' in path for path in guarded_files)
    assert valid_group.find(".//node[@name='rviz2']") is not None

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
        group for group in core.findall('.//group')
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


def test_twist_arbiter_only_in_practice_launches():
    # Practice runs share /target_twist between the controller and QUESTiX LAB through
    # twist_arbiter; a competition run (AutoReferee) must keep joy_controller -> /target_twist.
    core = load_xml('launcher/launch/questix_core.launch.xml')
    assert find_arg(core, 'enable_twist_arbiter').get('default') == 'true'
    drive_include = next(
        include for include in core.findall('.//include')
        if 'drive_component.launch.xml' in include.get('file', '')
    )
    forwarded = next(
        arg for arg in drive_include.findall('./arg') if arg.get('name') == 'enable_twist_arbiter')
    assert forwarded.get('value') == (
        '$(and $(var enable_twist_arbiter) $(not $(var enable_autoreferee)))')

    drive = load_xml('launcher/launch/drive_component.launch.xml')
    assert find_arg(drive, 'enable_twist_arbiter').get('default') == 'false'
    controller_groups = [
        group for group in drive.findall('./group')
        if any('find-pkg-share joy_controller' in include.get('file', '')
               for include in group.findall('./include'))
    ]
    assert len(controller_groups) == 2
    for group in controller_groups:
        remap = group.find('./set_remap')
        assert remap is not None
        assert remap.get('from') == '/target_twist'
        assert remap.get('to') == '$(var controller_twist_topic)'
    lets = {(let.get('value'), let.get('if'), let.get('unless')) for let in drive.findall('./let')}
    assert ('/target_twist/joy', '$(var enable_twist_arbiter)', None) in lets
    assert ('/target_twist', None, '$(var enable_twist_arbiter)') in lets

    for relative_path in (
        'systemd/questix_robot_launcher.sh',
        'ansible/roles/robot_autostart/files/questix_robot_launcher.sh',
    ):
        text = (SOURCE_ROOT / relative_path).read_text(encoding='utf-8')
        assert 'enable_twist_arbiter' not in text
        assert 'LAUNCH_ARGS="${LAUNCH_ARGS} enable_autoreferee:=true"' in text


def test_lab_launcher_input_only_in_practice_launches():
    # Practice runs let QUESTiX LAB operate the roller, tilt and fire through the ESC and shot
    # nodes' accept_lab_input; a competition run (AutoReferee) must never subscribe to those.
    core = load_xml('launcher/launch/questix_core.launch.xml')
    assert find_arg(core, 'enable_lab_shoot').get('default') == 'true'
    shot_include = next(
        include for include in core.findall('.//include')
        if 'shot_component.launch.xml' in include.get('file', '')
    )
    forwarded = next(
        arg for arg in shot_include.findall('./arg') if arg.get('name') == 'accept_lab_input')
    assert forwarded.get('value') == (
        '$(and $(var enable_lab_shoot) $(not $(var enable_autoreferee)))')

    shot = load_xml('launcher/launch/shot_component.launch.xml')
    assert find_arg(shot, 'accept_lab_input').get('default') == 'false'
    node_includes = [
        include for include in shot.findall('./include')
        if 'find-pkg-share motor_control_app' in include.get('file', '')
        or 'find-pkg-share esc_motor_control_cpp' in include.get('file', '')
    ]
    assert len(node_includes) == 2
    for include in node_includes:
        values = {arg.get('name'): arg.get('value') for arg in include.findall('./arg')}
        assert values.get('accept_lab_input') == '$(var accept_lab_input)'

    # The node launch files only forward the override; the YAML default stays false.
    esc = load_xml('esc_motor_control_cpp/launch/esc_motor_control_cpp.launch.xml')
    assert find_arg(esc, 'accept_lab_input').get('default') == 'false'
    esc_params = {
        param.get('name'): param.get('value') for param in esc.findall('./node/param')
    }
    assert esc_params.get('accept_lab_input') == '$(var accept_lab_input)'
    shot_py = (
        SOURCE_ROOT / 'motor_control_app/launch/shot_component.launch.py'
    ).read_text(encoding='utf-8')
    assert "'accept_lab_input',\n        default_value='false'" in shot_py

    esc_defaults = {'accept_lab_input': False, 'lab_topic': '/roller/lab',
                    'lab_max_speed': 0.8, 'lab_joy_quiet_sec': 1.0}
    shot_defaults = {'accept_lab_input': False, 'lab_joy_quiet_sec': 1.0,
                     'lab_min_fire_interval_sec': 2.0}
    for variant in ('', '.dualshock', '.uart'):
        esc_yaml = load_yaml(f'esc_motor_control_cpp/config/esc_motor_control_cpp{variant}.yaml')
        esc_parameters = esc_yaml['esc_motor_control']['ros__parameters']
        for name, value in esc_defaults.items():
            assert esc_parameters[name] == value, (variant, name)
        shot_yaml = load_yaml(f'motor_control_app/config/shot_config{variant}.yaml')
        shot_parameters = shot_yaml['shot_component']['ros__parameters']
        for name, value in shot_defaults.items():
            assert shot_parameters[name] == value, (variant, name)

    for relative_path in (
        'systemd/questix_robot_launcher.sh',
        'ansible/roles/robot_autostart/files/questix_robot_launcher.sh',
    ):
        text = (SOURCE_ROOT / relative_path).read_text(encoding='utf-8')
        assert 'enable_lab_shoot' not in text
        assert 'accept_lab_input' not in text
