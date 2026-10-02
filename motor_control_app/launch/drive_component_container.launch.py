# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import ComposableNodeContainer
from launch_ros.descriptions import ComposableNode
from questix_control_config import control_actions


def generate_launch_description():
    # 単体launch のハードウェア設定はノード宣言デフォルトを使用する。
    # キー割り当て・速度は questix_control_config の共通プロファイルを使用する。
    container_name_arg = DeclareLaunchArgument(
        'container_name',
        default_value='drive_container',
        description='Name of the component container'
    )

    container = ComposableNodeContainer(
        name=LaunchConfiguration('container_name'),
        namespace='',
        package='rclcpp_components',
        executable='component_container',
        composable_node_descriptions=[
            ComposableNode(
                package='motor_control_app',
                plugin='motor_control_app::DriveComponent',
                name='drive_component',
                parameters=[LaunchConfiguration('control_config_file'),
                            {'serial_port': LaunchConfiguration('serial_port')}],
            ),
        ],
        output='screen',
    )

    return LaunchDescription([
        *control_actions(),
        DeclareLaunchArgument('serial_port', default_value='/dev/ttyACM0'),
        container_name_arg,
        container,
    ])
