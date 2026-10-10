# Copyright 2026 scramble-robot
# SPDX-License-Identifier: MIT
"""Resolve the shared QUESTiX controls for ROS launch files."""

import os
from pathlib import Path
import re

from ament_index_python.packages import get_package_share_directory
from launch.actions import (DeclareLaunchArgument, LogInfo, OpaqueFunction,
                            SetLaunchConfiguration)
from launch.substitutions import EnvironmentVariable, LaunchConfiguration

# One packaged profile per controller: config/controls.<controller>.yaml.
CONTROLLER_TYPES = ('uart', 'dualshock', 'web')
# The browser controller's buttons are fixed by its page, so it always uses the packaged profile
# (a saved file of the same name in QUESTIX_CONFIG_DIR is ignored; Robot Manager never writes one).
FIXED_CONTROLLERS = ('web',)
# Unit generation of the m/s and rad/s values in a profile. Generation 2 reads them with the real
# wheel_radius 0.05 m (#179); a profile saved before it (no marker) holds values meant for the old
# 0.1 m and would drive twice as fast, so a saved profile without this marker is not used.
# Robot Manager writes the same line (scripts/robot_manager/controls.py, kept identical by
# scripts/robot_manager/test_controls.py).
UNITS_GENERATION = '2'
_UNITS_MARKER = re.compile(r'^# questix_controls_units: (\S+)', re.MULTILINE)


def units_generation(text):
    """Return the unit generation a profile's text declares, or None without a marker."""
    match = _UNITS_MARKER.search(text)
    return match.group(1) if match else None


def _select_profile(context):
    """Use an explicit file, a saved robot profile, or the packaged defaults."""
    controller = LaunchConfiguration('controller_type').perform(context)
    if controller not in CONTROLLER_TYPES:
        raise ValueError('controller_type must be one of: ' + ', '.join(CONTROLLER_TYPES))
    explicit = LaunchConfiguration('control_config_file').perform(context)
    actions = []
    if explicit:
        # An explicit file is a deliberate diagnostic choice and is used as given.
        path = Path(explicit).expanduser()
    else:
        filename = f'controls.{controller}.yaml'
        saved = Path(os.environ.get('QUESTIX_CONFIG_DIR', '/etc/questix_robot')) / filename
        use_saved = saved.exists() and controller not in FIXED_CONTROLLERS
        if use_saved and units_generation(saved.read_text(encoding='utf-8')) != UNITS_GENERATION:
            use_saved = False
            actions.append(LogInfo(msg=(
                f'[WARN] {saved} was saved before the wheel_radius fix (#179) and is ignored: '
                'its speeds would drive twice as fast. Using the packaged defaults; '
                'review and save the controls again in Robot Manager.')))
        path = saved if use_saved else (
            Path(get_package_share_directory('questix_control_config')) / 'config' / filename)
    if not path.is_file():
        raise ValueError(f'Control profile not found: {path}')
    return actions + [SetLaunchConfiguration('control_config_file', str(path))]


def control_actions():
    """Declare and resolve one profile before creating any consuming nodes."""
    return [
        DeclareLaunchArgument('controller_type',
                              default_value=EnvironmentVariable('CONTROLLER_TYPE',
                                                                default_value='dualshock')),
        DeclareLaunchArgument('control_config_file', default_value='',
                              description='Shared operator controls YAML; empty = saved/default'),
        OpaqueFunction(function=_select_profile),
    ]
