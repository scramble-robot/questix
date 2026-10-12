# Copyright 2026 scramble-robot
# SPDX-License-Identifier: MIT
"""The launcher's controller buttons live in the joy_launcher section; older profiles migrate."""

from pathlib import Path

from questix_control_config import (_launcher_layout_actions, LAUNCHER_LEGACY_SECTIONS,
                                    LAUNCHER_NODE, migrate_launcher_layout)
import yaml

CONFIG = Path(__file__).resolve().parents[1] / 'config'
OLD = {
    'joy_controller': {'ros__parameters': {'linear_x_axis': 1}},
    'shot_component': {'ros__parameters': {'fire_button': 2, 'tilt_axis': 7,
                                           'tilt_up_button_index': 4}},
    'esc_motor_control': {'ros__parameters': {'full_speed_button': 9, 'full_speed_value': 0.5}},
}


def test_packaged_profiles_use_the_joy_launcher_section():
    keys = {key for names in LAUNCHER_LEGACY_SECTIONS.values() for key in names} - {'tilt_axis'}
    for controller in ('uart', 'dualshock', 'web'):
        document = yaml.safe_load((CONFIG / f'controls.{controller}.yaml').read_text())
        assert 'shot_component' not in document and 'esc_motor_control' not in document
        assert set(document[LAUNCHER_NODE]['ros__parameters']) == keys
        assert migrate_launcher_layout(document) == (document, False)


def test_an_old_profile_moves_its_launcher_keys():
    document, moved = migrate_launcher_layout(OLD)
    assert moved
    assert document['joy_launcher']['ros__parameters'] == {
        'fire_button': 2, 'tilt_axis': 7, 'tilt_up_button_index': 4, 'full_speed_button': 9,
        'full_speed_value': 0.5}
    assert 'shot_component' not in document and 'esc_motor_control' not in document
    assert document['joy_controller'] == OLD['joy_controller']


def test_new_values_win_and_other_keys_stay():
    old = {**OLD, 'joy_launcher': {'ros__parameters': {'fire_button': 3}},
           'esc_motor_control': {'ros__parameters': {'full_speed_value': 0.5,
                                                     'use_sim_time': False}}}
    document, moved = migrate_launcher_layout(old)
    assert moved
    assert document['joy_launcher']['ros__parameters']['fire_button'] == 3
    assert document['esc_motor_control'] == {'ros__parameters': {'use_sim_time': False}}


def test_the_launch_uses_a_converted_copy_and_never_rewrites_the_file(tmp_path):
    saved = tmp_path / 'controls.uart.yaml'
    text = '# questix_controls_units: 2\n' + yaml.safe_dump(OLD)
    saved.write_text(text)
    path, actions = _launcher_layout_actions(saved)
    try:
        assert path != saved and len(actions) == 1
        assert saved.read_text() == text
        converted = yaml.safe_load(path.read_text())
        assert converted['joy_launcher']['ros__parameters']['full_speed_button'] == 9
    finally:
        path.unlink()
    current = tmp_path / 'controls.dualshock.yaml'
    current.write_text((CONFIG / 'controls.dualshock.yaml').read_text())
    assert _launcher_layout_actions(current) == (current, [])
