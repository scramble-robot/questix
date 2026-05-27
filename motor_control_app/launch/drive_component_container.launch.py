# Copyright 2026 scramble-robot
#
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import ComposableNodeContainer
from launch_ros.descriptions import ComposableNode


def generate_launch_description():
    # パッケージのパスを取得
    package_dir = get_package_share_directory('motor_control_app')

    # 設定ファイルのパス
    config_file = os.path.join(package_dir, 'config', 'drive_component.yaml')

    # Launch引数を定義
    config_file_arg = DeclareLaunchArgument(
        'config_file',
        default_value=config_file,
        description='Path to the configuration file'
    )

    serial_port_arg = DeclareLaunchArgument(
        'serial_port',
        default_value='/dev/ttyACM0',
        description='Serial port for motor communication'
    )

    container_name_arg = DeclareLaunchArgument(
        'container_name',
        default_value='drive_container',
        description='Name of the component container'
    )

    # コンポーネントコンテナを作成
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
                parameters=[
                    LaunchConfiguration('config_file'),
                    {
                        'serial_port': LaunchConfiguration('serial_port')
                    }
                ],
            ),
        ],
        output='screen',
    )

    return LaunchDescription([
        config_file_arg,
        serial_port_arg,
        container_name_arg,
        container,
    ])
