# Copyright 2026 scramble-robot
#
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    # パッケージのパスを取得
    package_dir = get_package_share_directory('motor_control_app')

    # 設定ファイルのパス
    config_file = os.path.join(package_dir, 'config', 'joy_axis_drive_params.yaml')

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

    # JoyAxisDriveComponentノードを起動
    joy_axis_drive_node = Node(
        package='motor_control_app',
        executable='joy_axis_drive_node',
        name='joy_axis_drive',
        parameters=[
            LaunchConfiguration('config_file'),
            {
                'serial_port': LaunchConfiguration('serial_port')
            }
        ],
        output='screen',
        emulate_tty=True,
        respawn=True,
        respawn_delay=2.0
    )

    return LaunchDescription([
        config_file_arg,
        serial_port_arg,
        joy_axis_drive_node,
    ])
