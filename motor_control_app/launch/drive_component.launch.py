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
from launch_ros.parameter_descriptions import ParameterValue
from questix_control_config import control_actions


def _launch_setup(context, *args, **kwargs):
    # Optional hardware configuration, followed by the shared operator controls.
    # Integrated launch supplies launcher/config/drive_component.yaml here.
    config_file = LaunchConfiguration('config_file').perform(context)
    parameters = [config_file] if config_file else []
    parameters.append(LaunchConfiguration('control_config_file'))
    # The E-stop requirement (questix_core: enable_gpio_ref) and the teacher's runtime authority
    # (practice opt-in, never in competition). Not in the YAML (one source per launch).
    parameters.append({
        'require_emergency_stop': ParameterValue(
            LaunchConfiguration('require_emergency_stop'), value_type=bool),
        'require_runtime_actuation_authority': ParameterValue(
            LaunchConfiguration('require_runtime_actuation_authority'), value_type=bool),
    })

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
        DeclareLaunchArgument(
            'require_emergency_stop',
            default_value='true',
            description='Treat an unheard or silent /emergency_stop as pressed (questix_core '
                        'passes enable_gpio_ref; a received active=true always stops)'),
        DeclareLaunchArgument(
            'require_runtime_actuation_authority',
            default_value='false',
            description='Drive only while the teacher runtime authority (/actuation_authority) '
                        'is fresh (practice opt-in; competition launches pass false)'),
        OpaqueFunction(function=_launch_setup),
    ])
