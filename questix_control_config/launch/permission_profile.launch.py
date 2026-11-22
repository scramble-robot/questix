"""Resolve controller votes before any robot process is launched."""

import atexit
from pathlib import Path
import tempfile

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, OpaqueFunction, RegisterEventHandler
from launch.actions import SetLaunchConfiguration
from launch.event_handlers import OnShutdown
from launch.substitutions import LaunchConfiguration
from questix_control_config.permission_profile import compose
import yaml


def prepare(context):
    source = LaunchConfiguration('permission_source_file').perform(context)
    controller = LaunchConfiguration('controller_type').perform(context)
    mode = LaunchConfiguration('robot_mode').perform(context)
    # Any exception aborts launch before child creation. Never retain the original YAML.
    result = compose(yaml.safe_load(Path(source).read_text()), controller, mode)
    directory = tempfile.TemporaryDirectory(prefix='questix-permission-')
    try:
        path = Path(directory.name) / 'permission.yaml'
        with path.open('x') as stream:
            yaml.safe_dump(result, stream)
    except Exception:
        directory.cleanup()
        raise
    atexit.register(directory.cleanup)

    def cleanup(event, context):
        directory.cleanup()
        atexit.unregister(directory.cleanup)
        return []

    return [RegisterEventHandler(OnShutdown(on_shutdown=cleanup)),
            SetLaunchConfiguration('permission_config_file', str(path))]


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument('permission_source_file', default_value=(
            get_package_share_directory('operation_manager')
            + '/config/operation_manager.permission.yaml')),
        OpaqueFunction(function=prepare),
    ])
