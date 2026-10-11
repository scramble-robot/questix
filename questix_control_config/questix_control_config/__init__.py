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
import yaml

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


# Every consuming launch reads a node's own YAML (config_file, drive_config_file, ...) and then
# the profile, so an operator key in the former has no effect. A legacy key the node maps onto
# profile keys only when those are unset (shot_component tilt_axis, -2) never takes effect either.
_LEGACY_KEYS = {'shot_component': {'tilt_axis': ('tilt_up_axis', 'tilt_down_axis')}}
# (file, profile) pairs already checked in this launch process: nested launches resolve the
# profile again and see their parent's arguments.
_checked = set()


def _sections(document):
    """Return {node: keys} of a ROS parameter YAML; anything else is ignored."""
    sections = {}
    if isinstance(document, dict):
        for node, section in document.items():
            params = section.get('ros__parameters') if isinstance(section, dict) else None
            if isinstance(params, dict):
                name = str(node)
                sections[name if name == '/**' else name.lstrip('/')] = set(params)
    return sections


def overridden_keys(document, profile):
    """Return {node: keys} that a node YAML sets in vain because the profile sets them."""
    own, controlled = _sections(document), _sections(profile)
    every = set().union(*controlled.values()) if controlled else set()
    result = {}
    for node, keys in own.items():
        profile_keys = every if node == '/**' else controlled.get(node, set())
        hits = sorted(keys & profile_keys)
        for legacy, replacements in _LEGACY_KEYS.get(node, {}).items():
            if legacy in keys and profile_keys & set(replacements):
                hits.append(legacy)
        if hits:
            result[node] = hits
    return result


def _override_warnings(context, profile_path):
    """Warn once per node YAML argument (``*config_file``) that holds operator controls."""
    try:
        profile = yaml.safe_load(profile_path.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, yaml.YAMLError):
        return []
    actions = []
    for name, value in sorted(context.launch_configurations.items()):
        if not name.endswith('config_file') or name == 'control_config_file' or not value:
            continue
        path = Path(value).expanduser()
        if (str(path), str(profile_path)) in _checked or path == profile_path:
            continue
        _checked.add((str(path), str(profile_path)))
        try:
            document = yaml.safe_load(path.read_text(encoding='utf-8'))
        except (OSError, UnicodeDecodeError, yaml.YAMLError):
            continue  # the node reports a file it cannot read
        overridden = overridden_keys(document, profile)
        if overridden:
            listed = '; '.join(f'{node}: {", ".join(keys)}' for node, keys in overridden.items())
            actions.append(LogInfo(msg=(
                f'[WARN] {path} ({name}) sets operator controls that the profile {profile_path} '
                f'overrides, so these values have no effect: {listed}. Change them in Robot '
                'Manager (操作・速度) or pass control_config_file:=<file>.')))
    return actions


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
    actions += _override_warnings(context, path)
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
