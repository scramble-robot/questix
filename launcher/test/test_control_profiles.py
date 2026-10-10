# Copyright 2026 scramble-robot
# SPDX-License-Identifier: MIT
"""Operator control profiles reach every node (launch expansion: conftest.expand)."""

import os
from pathlib import Path

import pytest
import questix_control_config
import yaml

ROOT = Path(os.environ['QUESTIX_SOURCE_ROOT'])


DRIVERS = {'uart': 'uart_joy_driver', 'dualshock': 'joy_node', 'web': 'web_joy_driver'}
# A saved profile is used only with the current unit generation (wheel_radius 0.05 m, #179).
UNITS_MARKER = f'# questix_controls_units: {questix_control_config.UNITS_GENERATION}\n'


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
    (tmp_path / f'controls.{controller}.yaml').write_text(UNITS_MARKER + yaml.safe_dump(profile))
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


@pytest.mark.parametrize('marker', ['', '# questix_controls_units: 1\n'])
def test_saved_profile_from_before_the_wheel_radius_fix_is_ignored(expand, tmp_path, marker):
    """Old-unit speeds would drive twice as fast with the real radius: the defaults apply."""
    packaged = ROOT / 'questix_control_config/config/controls.dualshock.yaml'
    profile = yaml.safe_load(packaged.read_text())
    profile['joy_controller']['ros__parameters']['longitudinal_input_ratio'] = 2.0
    profile['drive_component']['ros__parameters']['max_linear_accel'] = 3.0
    (tmp_path / 'controls.dualshock.yaml').write_text(marker + yaml.safe_dump(profile))
    nodes = expand('launcher/launch/questix_core.launch.xml', controller_type='dualshock',
                   enable_gpio_ref='true', enable_lidar='false', enable_rviz='false')
    assert nodes['/joy_controller']['longitudinal_input_ratio'] == 1.0
    assert nodes['/drive_component']['max_linear_accel'] == 1.5


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
    assert dual['longitudinal_input_ratio'] == 0.025
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
     'joy_controller', 'angular_input_ratio', 3.0),
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
    assert nodes['/drive_component']['max_linear_accel'] == 1.5
    assert nodes['/drive_component']['serial_port'] == '/dev/test-port'
