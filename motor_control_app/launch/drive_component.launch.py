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
    config_file = os.path.join(package_dir, 'config', 'drive_component.yaml')

    # config_file が Single Source of Truth。
    # 個別の serial_port 等の launch 引数は廃止。値を変えたい場合は YAML を編集するか
    # `config_file:=...` で別 YAML を指定すること。
    config_file_arg = DeclareLaunchArgument(
        'config_file',
        default_value=config_file,
        description='Path to the drive component configuration YAML'
    )

    drive_component_node = Node(
        package='motor_control_app',
        executable='drive_component_node',
        name='drive_component',
        parameters=[LaunchConfiguration('config_file')],
        output='screen',
        emulate_tty=True,
        respawn=True,
        respawn_delay=2.0
    )

    return LaunchDescription([
        config_file_arg,
        drive_component_node,
    ])
