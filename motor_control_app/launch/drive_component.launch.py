# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.actions import OpaqueFunction
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def _launch_setup(context, *args, **kwargs):
    # config_file が空（単体launch）のときはノード宣言デフォルトで起動する
    # （launcher/config/drive_component.yaml と同値）。統合起動（questix_launcher）は
    # config_file に launcher/config/drive_component.yaml を渡す（単一ソース）。
    config_file = LaunchConfiguration('config_file').perform(context)
    parameters = [config_file] if config_file else []

    drive_component_node = Node(
        package='motor_control_app',
        executable='drive_component_node',
        name='drive_component',
        output='screen',
        emulate_tty=True,
        respawn=True,
        respawn_delay=2.0,
        parameters=parameters
    )

    return [drive_component_node]


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument(
            'config_file',
            default_value='',
            description='drive_component parameter YAML (empty = node defaults)'),
        OpaqueFunction(function=_launch_setup),
    ])
