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


def generate_launch_description():
    # 単体launch はノード宣言デフォルトで起動する（launcher/config/drive_component.yaml と同値）。
    # 設定を変えたい場合は launcher/config/drive_component.yaml を編集する（単一ソース）。
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
            ),
        ],
        output='screen',
    )

    return LaunchDescription([
        container_name_arg,
        container,
    ])
