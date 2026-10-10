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
from questix_control_config import control_actions


def _launch_setup(context, *args, **kwargs):
    # Optional hardware configuration, followed by the shared operator controls.
    # Integrated launch supplies launcher/config/drive_component.yaml here.
    config_file = LaunchConfiguration('config_file').perform(context)
    parameters = [config_file] if config_file else []
    parameters.append(LaunchConfiguration('control_config_file'))

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
        *control_actions(),
        DeclareLaunchArgument(
            'config_file',
            default_value='',
            description='drive_component parameter YAML (empty = node defaults)'),
        OpaqueFunction(function=_launch_setup),
    ])
