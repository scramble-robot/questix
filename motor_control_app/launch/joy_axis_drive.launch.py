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

    # config_file が Single Source of Truth。serial_port 等の個別 arg は廃止。
    config_file_arg = DeclareLaunchArgument(
        'config_file',
        default_value=config_file,
        description='Path to the joy axis drive configuration YAML'
    )

    joy_axis_drive_node = Node(
        package='motor_control_app',
        executable='joy_axis_drive_node',
        name='joy_axis_drive',
        parameters=[LaunchConfiguration('config_file')],
        output='screen',
        emulate_tty=True,
        respawn=True,
        respawn_delay=2.0
    )

    return LaunchDescription([
        config_file_arg,
        joy_axis_drive_node,
    ])
