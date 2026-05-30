# Copyright 2026 scramble-robot
#
#!/usr/bin/env python3

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    # config_file は YAML を Single Source of Truth として読み込む。
    # 個別のパラメータ launch 引数は廃止。値を変えたい場合は YAML を編集するか、
    # 別 YAML を `config_file:=...` で指定すること。
    config_file_arg = DeclareLaunchArgument(
        'config_file',
        default_value=PathJoinSubstitution([
            FindPackageShare('motor_control_app'),
            'config',
            'single_ddt_motor_config.yaml',
        ]),
        description='Path to the single DDT motor configuration YAML',
    )

    single_ddt_motor_node = Node(
        package='motor_control_app',
        executable='single_ddt_motor_node',
        name='single_ddt_motor_node',
        output='screen',
        parameters=[LaunchConfiguration('config_file')],
        remappings=[
            ('cmd_vel', '/cmd_vel'),
            ('motor_status', '/motor_status'),
        ],
    )

    return LaunchDescription([
        config_file_arg,
        single_ddt_motor_node,
    ])
