# Copyright 2026 scramble-robot
#
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    # joy_controller / joy_node ともに YAML が Single Source of Truth。
    # 個別パラメータの launch 引数は廃止し、config_file 切替のみ受け付ける。
    config_file_arg = DeclareLaunchArgument(
        'config_file',
        default_value=PathJoinSubstitution([
            FindPackageShare('joy_controller'),
            'config',
            'joy_controller_params.yaml'
        ]),
        description='Path to the joy_controller configuration YAML'
    )

    joy_node_config_arg = DeclareLaunchArgument(
        'joy_node_config_file',
        default_value=PathJoinSubstitution([
            FindPackageShare('joy_controller'),
            'config',
            'joy_node_params.yaml'
        ]),
        description='Path to the joy_node configuration YAML'
    )

    # joy パッケージの joy_node
    joy_node = Node(
        package='joy',
        executable='joy_node',
        name='joy_node',
        parameters=[LaunchConfiguration('joy_node_config_file')],
        output='screen'
    )

    # joy_controller node
    joy_controller_node = Node(
        package='joy_controller',
        executable='joy_controller_node',
        name='joy_controller',
        parameters=[LaunchConfiguration('config_file')],
        output='screen',
        emulate_tty=True
    )

    return LaunchDescription([
        config_file_arg,
        joy_node_config_arg,
        joy_node,
        joy_controller_node
    ])
