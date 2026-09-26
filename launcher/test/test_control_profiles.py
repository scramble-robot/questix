# Copyright 2026 scramble-robot
# SPDX-License-Identifier: MIT
"""Expand real launch descriptions while intercepting every process execution."""

import os
from pathlib import Path
import xml.etree.ElementTree as ET

import ament_index_python.packages
from launch import LaunchContext
from launch.actions import ExecuteProcess
from launch.launch_description_sources import AnyLaunchDescriptionSource
from launch.utilities import visit_all_entities_and_collect_futures
from launch_ros.actions import ComposableNodeContainer, Node
from launch_ros.actions.load_composable_nodes import get_composable_node_load_request
from launch_ros.substitutions import FindPackageShare
import pytest
import questix_control_config
from rclpy.parameter import Parameter
import yaml

ROOT = Path(os.environ['QUESTIX_SOURCE_ROOT'])


@pytest.fixture
def expand(monkeypatch, tmp_path):
    """Return effective per-node parameters, never opening hardware or running a node."""
    packages = {ET.parse(path).getroot().findtext('name'): str(path.parent)
                for path in ROOT.glob('*/package.xml')}
    monkeypatch.setenv('QUESTIX_CONFIG_DIR', str(tmp_path))
    monkeypatch.setattr(FindPackageShare, 'find', lambda self, name: packages[name])
    monkeypatch.setattr(ament_index_python.packages, 'get_package_share_directory',
                        lambda name: packages[name])
    monkeypatch.setattr(questix_control_config, 'get_package_share_directory',
                        lambda name: packages[name])

    def forbid_process(*args, **kwargs):
        raise AssertionError('Hardware/process execution is forbidden in this test')

    monkeypatch.setattr(ExecuteProcess, 'execute', forbid_process)

    def run(relative_path, **arguments):
        nodes = {}

        def capture(node, context):
            node._perform_substitutions(context)
            parameters = {}
            for filename, is_file in node._Node__expanded_parameter_arguments or []:
                assert is_file
                document = yaml.safe_load(Path(filename).read_text())
                for selector in ('/**', node.node_name.lstrip('/'), node.node_name):
                    parameters.update(document.get(selector, {}).get('ros__parameters', {}))
            assert node.node_name not in nodes
            nodes['/' + node.node_name.lstrip('/')] = parameters
            return []

        def capture_container(container, context):
            for description in container._ComposableNodeContainer__composable_node_descriptions:
                request = get_composable_node_load_request(description, context)
                nodes['/' + request.node_name] = {
                    parameter.name: Parameter.from_parameter_msg(parameter).value
                    for parameter in request.parameters}
            return []

        monkeypatch.setattr(ComposableNodeContainer, 'execute', capture_container)
        monkeypatch.setattr(Node, 'execute', capture)
        context = LaunchContext()
        context.launch_configurations['ros_namespace'] = '/'
        context.launch_configurations.update(arguments)
        description = AnyLaunchDescriptionSource(str(ROOT / relative_path))
        visit_all_entities_and_collect_futures(
            description.get_launch_description(context), context)
        return nodes

    return run


DRIVERS = {'uart': 'uart_joy_driver', 'dualshock': 'joy_node', 'web': 'web_joy_driver'}


@pytest.mark.parametrize('controller', ['uart', 'dualshock'])
@pytest.mark.parametrize('gated', ['true', 'false'])
def test_integrated_profile_and_topic_overrides(expand, tmp_path, controller, gated):
    """A saved profile reaches all consumers and cannot undo the GPIO topic gate."""
    profile = yaml.safe_load((ROOT / 'questix_control_config/config'
                              / f'controls.{controller}.yaml').read_text())
    changes = {'joy_controller': ('angular_z_axis', 6),
               'shot_component': ('fire_button', 2),
               'esc_motor_control': ('full_speed_button', 3),
               'drive_component': ('max_motor_rpm', 120)}
    for node, (key, value) in changes.items():
        profile[node]['ros__parameters'][key] = value
    (tmp_path / f'controls.{controller}.yaml').write_text(yaml.safe_dump(profile))
    nodes = expand('launcher/launch/questix_core.launch.xml', controller_type=controller,
                   enable_gpio_ref=gated, enable_lidar='false', enable_rviz='false')
    for node, (key, value) in changes.items():
        assert nodes['/' + node][key] == value
    for node in ('joy_controller', 'shot_component', 'esc_motor_control'):
        assert nodes['/' + node]['joy_topic'] == ('/joy_gated' if gated == 'true' else '/joy')
    assert nodes['/shot_component']['tilt_servo_id'] == 11  # hardware settings preserved
    assert nodes['/drive_component']['cmd_timeout_sec'] == 1.0  # watchdog preserved
    driver = DRIVERS[controller]
    assert nodes['/' + driver]['deadzone'] == profile[driver]['ros__parameters']['deadzone']
    assert not (set(DRIVERS.values()) - {driver}) & set(nodes)  # only the selected driver


@pytest.mark.parametrize('gated', ['true', 'false'])
def test_saved_web_profile_is_ignored(expand, tmp_path, gated):
    """The browser controller's buttons are fixed by its page: only the packaged one applies."""
    packaged = ROOT / 'questix_control_config/config/controls.web.yaml'
    profile = yaml.safe_load(packaged.read_text())
    saved = yaml.safe_load(yaml.safe_dump(profile))
    saved['shot_component']['ros__parameters']['fire_button'] = 2
    (tmp_path / 'controls.web.yaml').write_text(yaml.safe_dump(saved))
    nodes = expand('launcher/launch/questix_core.launch.xml', controller_type='web',
                   enable_gpio_ref=gated, enable_lidar='false', enable_rviz='false')
    assert nodes['/shot_component']['fire_button'] == 5
    for node in ('joy_controller', 'shot_component', 'esc_motor_control'):
        assert nodes['/' + node]['joy_topic'] == ('/joy_gated' if gated == 'true' else '/joy')
    assert not {'uart_joy_driver', 'joy_node'} & set(nodes)  # only the browser driver


def test_web_profile_is_packaged_and_reaches_the_browser_driver(expand, tmp_path):
    """controller_type=web resolves controls.web.yaml (tilt on buttons) for every consumer."""
    nodes = expand('launcher/launch/questix_core.launch.xml', controller_type='web',
                   enable_gpio_ref='true', enable_lidar='false', enable_rviz='false')
    shot = nodes['/shot_component']
    assert (shot['tilt_up_axis'], shot['tilt_down_axis']) == (-1, -1)
    assert (shot['tilt_up_button_index'], shot['tilt_down_button_index']) == (4, 6)
    assert nodes['/esc_motor_control']['full_speed_button'] == 7
    web = nodes['/web_joy_driver']
    assert web['deadzone'] == 0.05
    assert web['port'] == 8899 and web['message_timeout_sec'] == 0.5  # hardware YAML kept
    hardware = yaml.safe_load((ROOT / 'web_joy_driver/config/web_joy_driver_params.yaml')
                              .read_text())['web_joy_driver']['ros__parameters']
    assert 'deadzone' not in hardware  # single source: the operator profile
    # The standalone browser-driver launch resolves the same packaged profile.
    nodes = expand('web_joy_driver/launch/web_joy_driver.launch.xml')
    assert nodes['/web_joy_driver']['deadzone'] == 0.05


def test_unknown_controller_type_fails_before_nodes(expand):
    """A typo in CONTROLLER_TYPE must not silently start another controller's profile."""
    with pytest.raises(ValueError, match='uart, dualshock, web'):
        expand('launcher/launch/questix_core.launch.xml', controller_type='switch',
               enable_lidar='false', enable_rviz='false')


def test_dual_stick_keeps_its_own_scaling(expand):
    """Moving controls must not apply the faster single-stick scales to dual-stick mode."""
    nodes = expand('joy_controller/launch/joy_controller.launch.xml', dual_stick='true')
    assert '/joy_controller' not in nodes
    dual = nodes['/joy_controller_dual_stick']
    assert dual['longitudinal_input_ratio'] == 0.05
    assert dual['angular_input_ratio'] == 0.05
    assert dual['left_stick_vertical_axis'] == 1


@pytest.mark.parametrize('relative_path,node,key,value', [
    ('motor_control_app/launch/shot_component.launch.xml', 'shot_component', 'tilt_up_axis', 7),
    ('motor_control_app/launch/joy_axis_drive.launch.xml', 'joy_axis_drive', 'max_motor_rpm', 100),
    ('motor_control_app/launch/joy_axis_drive.launch.py', 'joy_axis_drive', 'max_motor_rpm', 100),
    ('motor_control_app/launch/drive_component.launch.xml',
     'drive_component', 'max_motor_rpm', 475),
    ('motor_control_app/launch/drive_component.launch.py',
     'drive_component', 'max_motor_rpm', 475),
    ('esc_motor_control_cpp/launch/esc_motor_control_cpp.launch.xml',
     'esc_motor_control', 'full_speed_button', 7),
    ('uart_joy_driver/launch/uart_joy_driver.launch.xml', 'uart_joy_driver', 'deadzone', 0.05),
    ('web_joy_driver/launch/web_joy_driver.launch.xml', 'web_joy_driver', 'deadzone', 0.05),
    ('joy_controller/launch/joy_controller.launch.py',
     'joy_controller', 'angular_input_ratio', 6.0),
])
def test_standalone_entry_points(expand, relative_path, node, key, value):
    """Both Python and XML standalone entry points consume the central defaults."""
    assert expand(relative_path)['/' + node][key] == value


def test_explicit_profile_wins_over_saved(expand, tmp_path):
    """CLI overrides remain usable for diagnostics without modifying robot settings."""
    profile = yaml.safe_load(
        (ROOT / 'questix_control_config/config/controls.uart.yaml').read_text())
    profile['shot_component']['ros__parameters']['fire_button'] = 1
    explicit = tmp_path / 'custom.yaml'
    explicit.write_text(yaml.safe_dump(profile))
    nodes = expand('motor_control_app/launch/shot_component.launch.py',
                   control_config_file=str(explicit))
    assert nodes['/shot_component']['fire_button'] == 1


def test_missing_explicit_profile_fails_before_nodes(expand, tmp_path):
    """A misspelled profile path must not silently fall back to motor defaults."""
    with pytest.raises(ValueError, match='Control profile not found'):
        expand('motor_control_app/launch/shot_component.launch.py',
               control_config_file=str(tmp_path / 'missing.yaml'))


@pytest.mark.parametrize('extension', ['xml', 'py'])
def test_composed_drive_receives_profile_and_serial_port(expand, extension):
    """Resolve the real LoadNode request without starting a component container."""
    nodes = expand(f'motor_control_app/launch/drive_component_container.launch.{extension}',
                   serial_port='/dev/test-port')
    assert nodes['/drive_component']['max_motor_rpm'] == 475
    assert nodes['/drive_component']['max_linear_accel'] == 3.0
    assert nodes['/drive_component']['serial_port'] == '/dev/test-port'
