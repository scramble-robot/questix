# Copyright 2026 scramble-robot
# SPDX-License-Identifier: MIT
"""Operator control profiles reach every node (launch expansion: conftest.expand)."""

import math
import os
from pathlib import Path
import re

from launch.actions import LogInfo
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
    """A saved profile reaches all consumers, with or without the GPIO safety path."""
    profile = yaml.safe_load((ROOT / 'questix_control_config/config'
                              / f'controls.{controller}.yaml').read_text())
    changes = {'joy_controller': ('angular_z_axis', 6),
               'joy_launcher': ('fire_button', 2),
               'drive_component': ('max_motor_rpm', 120)}
    for node, (key, value) in changes.items():
        profile[node]['ros__parameters'][key] = value
    (tmp_path / f'controls.{controller}.yaml').write_text(UNITS_MARKER + yaml.safe_dump(profile))
    nodes = expand('launcher/launch/questix_core.launch.xml', controller_type=controller,
                   enable_gpio_ref=gated, enable_lidar='false', enable_rviz='false')
    for node, (key, value) in changes.items():
        assert nodes['/' + node][key] == value
    # Nothing gates /joy (joy_gate was removed): the controller's nodes read /joy with or without
    # GPIO, and the launcher nodes read /launcher_command only (joy_launcher's buttons).
    assert 'joy_topic' not in nodes['/joy_controller']  # the node's default, /joy
    assert 'joy_topic' not in nodes['/joy_launcher']
    for node in ('shot_component', 'esc_motor_control'):
        assert 'joy_topic' not in nodes['/' + node] and 'fire_button' not in nodes['/' + node]
        assert nodes['/' + node]['launcher_command_topic'] == '/launcher_command'
    assert '/joy_gate' not in nodes
    assert nodes['/shot_component']['tilt_servo_id'] == 11  # hardware settings preserved
    assert nodes['/drive_component']['cmd_timeout_sec'] == 1.0  # watchdog preserved
    driver = DRIVERS[controller]
    assert nodes['/' + driver]['deadzone'] == profile[driver]['ros__parameters']['deadzone']
    assert not (set(DRIVERS.values()) - {driver}) & set(nodes)  # only the selected driver


def test_a_saved_profile_in_the_old_launcher_layout_still_reaches_joy_launcher(expand, tmp_path):
    """Buttons saved under shot_component / esc_motor_control (before joy_launcher) migrate."""
    profile = yaml.safe_load((ROOT / 'questix_control_config/config/controls.uart.yaml')
                             .read_text())
    buttons = profile.pop('joy_launcher')['ros__parameters']
    profile['shot_component'] = {'ros__parameters': {
        key: value for key, value in buttons.items() if not key.startswith('full_speed')}}
    profile['shot_component']['ros__parameters']['fire_button'] = 2
    profile['esc_motor_control'] = {'ros__parameters': {'full_speed_button': 3,
                                                        'full_speed_value': 0.5}}
    saved = tmp_path / 'controls.uart.yaml'
    text = UNITS_MARKER + yaml.safe_dump(profile)
    saved.write_text(text)
    nodes = expand('launcher/launch/questix_core.launch.xml', controller_type='uart',
                   enable_gpio_ref='true', enable_lidar='false', enable_rviz='false')
    launcher = nodes['/joy_launcher']
    assert (launcher['fire_button'], launcher['full_speed_button'],
            launcher['full_speed_value']) == (2, 3, 0.5)
    assert saved.read_text() == text  # the saved file is never rewritten


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
    saved['joy_launcher']['ros__parameters']['fire_button'] = 2
    (tmp_path / 'controls.web.yaml').write_text(yaml.safe_dump(saved))
    nodes = expand('launcher/launch/questix_core.launch.xml', controller_type='web',
                   enable_gpio_ref=gated, enable_lidar='false', enable_rviz='false')
    assert nodes['/joy_launcher']['fire_button'] == 5
    # Nothing gates /joy (joy_gate was removed): the controller's nodes read /joy.
    assert 'joy_topic' not in nodes['/joy_controller']  # the node's default, /joy
    assert '/joy_gate' not in nodes
    assert not {'uart_joy_driver', 'joy_node'} & set(nodes)  # only the browser driver


def test_web_profile_is_packaged_and_reaches_the_browser_driver(expand, tmp_path):
    """controller_type=web resolves controls.web.yaml (tilt on buttons) for every consumer."""
    nodes = expand('launcher/launch/questix_core.launch.xml', controller_type='web',
                   enable_gpio_ref='true', enable_lidar='false', enable_rviz='false')
    launcher = nodes['/joy_launcher']
    assert (launcher['tilt_up_axis'], launcher['tilt_down_axis']) == (-1, -1)
    assert (launcher['tilt_up_button_index'], launcher['tilt_down_button_index']) == (4, 6)
    assert launcher['full_speed_button'] == 7
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


@pytest.mark.parametrize('controller', ['uart', 'dualshock', 'web'])
def test_dual_stick_drives_like_3_2_0(expand, controller):
    """A full dual-stick deflection leaves the stop gate at 3.2.0's wheel speed."""
    # 3.2.0 started the dual-stick node as /joy_controller with 2.0 m/s and 6.0 at wheel_radius
    # 0.1 m (about 191 rpm). Its own scale (0.05, later 0.025) never reached the stop gate's exit
    # (min_command_rpm + kExitMarginRpm), so the robot did not move at all.
    nodes = expand('joy_controller/launch/joy_controller.launch.xml', dual_stick='true',
                   controller_type=controller)
    assert '/joy_controller' not in nodes
    dual = nodes['/joy_controller_dual_stick']
    assert dual['longitudinal_input_ratio'] == 1.0
    assert dual['angular_input_ratio'] == 6.0  # [1/m] on the wheel speed difference
    assert dual['left_stick_vertical_axis'] == 1

    hardware = yaml.safe_load((ROOT / 'launcher/config/drive_component.yaml').read_text())
    wheel_radius = hardware['drive_component']['ros__parameters']['wheel_radius']
    profile = yaml.safe_load((ROOT / 'questix_control_config/config'
                              / f'controls.{controller}.yaml').read_text())
    min_command_rpm = profile['drive_component']['ros__parameters']['min_command_rpm']
    gate = (ROOT / 'motor_control_lib/include/motor_control_lib/drive_stop_gate.hpp').read_text()
    exit_margin = int(re.search(r'kExitMarginRpm = (\d+);', gate).group(1))
    full_stick_rpm = dual['longitudinal_input_ratio'] / (2 * math.pi * wheel_radius) * 60
    assert full_stick_rpm >= min_command_rpm + exit_margin
    assert full_stick_rpm == pytest.approx(2.0 / (2 * math.pi * 0.1) * 60)  # 3.2.0


@pytest.mark.parametrize('relative_path,node,key,value', [
    ('motor_control_app/launch/shot_component.launch.xml', 'shot_component',
     'tilt_max_angle', 120.0),
    ('motor_control_app/launch/joy_axis_drive.launch.xml', 'joy_axis_drive', 'max_motor_rpm', 100),
    ('motor_control_app/launch/joy_axis_drive.launch.py', 'joy_axis_drive', 'max_motor_rpm', 100),
    ('motor_control_app/launch/drive_component.launch.xml',
     'drive_component', 'max_motor_rpm', 475),
    ('motor_control_app/launch/drive_component.launch.py',
     'drive_component', 'max_motor_rpm', 475),
    ('esc_motor_control_cpp/launch/esc_motor_control_cpp.launch.xml',
     'esc_motor_control', 'safety_timeout', 1.0),
    ('joy_controller/launch/joy_controller.launch.xml', 'joy_launcher', 'full_speed_button', 7),
    ('joy_controller/launch/joy_controller.launch.py', 'joy_launcher', 'fire_button', 5),
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
    profile['joy_launcher']['ros__parameters']['fire_button'] = 1
    explicit = tmp_path / 'custom.yaml'
    explicit.write_text(yaml.safe_dump(profile))
    nodes = expand('joy_controller/launch/joy_controller.launch.py',
                   control_config_file=str(explicit))
    assert nodes['/joy_launcher']['fire_button'] == 1


def test_missing_explicit_profile_fails_before_nodes(expand, tmp_path):
    """A misspelled profile path must not silently fall back to motor defaults."""
    with pytest.raises(ValueError, match='Control profile not found'):
        expand('joy_controller/launch/joy_controller.launch.py',
               control_config_file=str(tmp_path / 'missing.yaml'))


@pytest.mark.parametrize('extension', ['xml', 'py'])
def test_composed_drive_receives_profile_and_serial_port(expand, extension):
    """Resolve the real LoadNode request without starting a component container."""
    nodes = expand(f'motor_control_app/launch/drive_component_container.launch.{extension}',
                   serial_port='/dev/test-port')
    assert nodes['/drive_component']['max_motor_rpm'] == 475
    assert nodes['/drive_component']['max_linear_accel'] == 1.5
    assert nodes['/drive_component']['serial_port'] == '/dev/test-port'


@pytest.fixture
def warnings(monkeypatch):
    """Collect the launch's [WARN] lines instead of logging them."""
    logged = []

    def execute(action, context):
        text = ''.join(part.perform(context) for part in action.msg)
        if text.startswith('[WARN]'):
            logged.append(text)
    monkeypatch.setattr(LogInfo, 'execute', execute)
    return logged


def test_operator_keys_in_a_node_yaml_are_reported_once(expand, warnings, tmp_path):
    """A 3.2.0-style node YAML with speeds and buttons says why they have no effect."""
    joy = tmp_path / 'my_joy.yaml'
    joy.write_text(yaml.safe_dump({'joy_controller': {'ros__parameters': {
        'longitudinal_input_ratio': 0.3, 'angular_z_axis': 2, 'debug_mode': True}}}))
    # The standalone drive launch includes joy_controller.launch.xml and the drive launch, and
    # each resolves the profile again: still one warning for the file.
    nodes = expand('launcher/launch/drive_component.launch.xml', joy_config_file=str(joy),
                   controller_type='dualshock')
    assert nodes['/joy_controller']['longitudinal_input_ratio'] == 1.0  # the profile's value
    assert nodes['/joy_controller']['debug_mode'] is True  # a node setting stays in effect
    assert len(warnings) == 1
    assert str(joy) in warnings[0]
    assert 'joy_controller: angular_z_axis, longitudinal_input_ratio' in warnings[0]
    assert 'debug_mode' not in warnings[0]


def test_launcher_buttons_left_in_a_shot_yaml_are_reported_as_ignored(expand, warnings, tmp_path):
    """shot_component reads /launcher_command: buttons in its own YAML (3.2.0 style) do nothing."""
    shot = tmp_path / 'my_shot.yaml'
    hardware = yaml.safe_load((ROOT / 'motor_control_app/config/shot_config.yaml').read_text())
    hardware['shot_component']['ros__parameters'].update({'tilt_axis': 6, 'fire_button': 2})
    shot.write_text(yaml.safe_dump(hardware))
    nodes = expand('launcher/launch/questix_core.launch.xml', shot_config_file=str(shot),
                   controller_type='uart', enable_lidar='false', enable_rviz='false')
    assert nodes['/joy_launcher']['fire_button'] == 5  # the profile's button
    assert nodes['/joy_launcher']['tilt_up_axis'] == 7
    assert len(warnings) == 1
    assert 'shot_component: fire_button, tilt_axis' in warnings[0]


@pytest.mark.parametrize('relative_path,arguments', [
    ('launcher/launch/questix_core.launch.xml',
     {'enable_lidar': 'false', 'enable_rviz': 'false', 'controller_type': 'uart'}),
    ('launcher/launch/questix_core.launch.xml',
     {'enable_lidar': 'false', 'enable_rviz': 'false', 'controller_type': 'web'}),
    ('joy_controller/launch/joy_controller.launch.xml', {'dual_stick': 'true'}),
    ('motor_control_app/launch/drive_component_container.launch.py', {}),
    ('motor_control_app/launch/joy_axis_drive.launch.xml', {}),
    ('esc_motor_control_cpp/launch/esc_motor_control_cpp.launch.xml', {}),
])
def test_packaged_node_yamls_hold_no_operator_controls(expand, warnings, relative_path, arguments):
    """Nothing to report with the packaged files: a warning always means a user's file."""
    expand(relative_path, **arguments)
    assert warnings == []


def test_overridden_keys_cover_wildcard_sections():
    """A /** section reaches every node, so any profile key in it is overridden too."""
    profile = {'joy_node': {'ros__parameters': {'deadzone': 0.05}},
               'joy_launcher': {'ros__parameters': {'tilt_up_axis': 7}}}
    document = {'/**': {'ros__parameters': {'deadzone': 0.1, 'use_sim_time': False}},
                '/joy_launcher': {'ros__parameters': {'tilt_axis': 6}},
                'esc_motor_control': {'ros__parameters': {'full_speed_button': 3, 'pwm_pin': 13}},
                'other': 'not a node section'}
    assert questix_control_config.overridden_keys(document, profile) == {
        '/**': ['deadzone'], 'joy_launcher': ['tilt_axis'],
        'esc_motor_control': ['full_speed_button']}
    assert questix_control_config.overridden_keys(None, profile) == {}
