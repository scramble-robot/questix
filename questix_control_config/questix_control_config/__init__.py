# Copyright 2026 scramble-robot
# SPDX-License-Identifier: MIT
"""Resolve the shared QUESTiX controls for ROS launch files."""

import os
from pathlib import Path

from ament_index_python.packages import get_package_share_directory
from launch.actions import DeclareLaunchArgument, OpaqueFunction, SetLaunchConfiguration
from launch.substitutions import EnvironmentVariable, LaunchConfiguration

# One packaged profile per controller: config/controls.<controller>.yaml.
CONTROLLER_TYPES = ('uart', 'dualshock', 'web')


def _select_profile(context):
    """Use an explicit file, a saved robot profile, or the packaged defaults."""
    controller = LaunchConfiguration('controller_type').perform(context)
    if controller not in CONTROLLER_TYPES:
        raise ValueError('controller_type must be one of: ' + ', '.join(CONTROLLER_TYPES))
    explicit = LaunchConfiguration('control_config_file').perform(context)
    if explicit:
        path = Path(explicit).expanduser()
    else:
        filename = f'controls.{controller}.yaml'
        saved = Path(os.environ.get('QUESTIX_CONFIG_DIR', '/etc/questix_robot')) / filename
        path = saved if saved.exists() else (
            Path(get_package_share_directory('questix_control_config')) / 'config' / filename)
    if not path.is_file():
        raise ValueError(f'Control profile not found: {path}')
    return [SetLaunchConfiguration('control_config_file', str(path))]


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
