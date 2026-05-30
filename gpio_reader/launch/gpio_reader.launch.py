# Copyright 2026 scramble-robot
#
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    # Declare launch arguments
    config_file_arg = DeclareLaunchArgument(
        'config_file',
        default_value=PathJoinSubstitution([
            FindPackageShare('gpio_reader'),
            'config',
            'gpio_reader.yaml'
        ]),
        description='Path to the GPIO reader configuration file'
    )

    use_sim_time_arg = DeclareLaunchArgument(
        'use_sim_time',
        default_value='false',
        description='Use simulation time (deprecated: prefer YAML)'
    )

    # GPIO Reader Node
    # config_file が Single Source of Truth。launch 引数によるインライン上書きは廃止。
    gpio_reader_node = Node(
        package='gpio_reader',
        executable='gpio_reader_node',
        name='gpio_reader_node',
        output='screen',
        parameters=[LaunchConfiguration('config_file')]
    )

    return LaunchDescription([
        config_file_arg,
        use_sim_time_arg,
        gpio_reader_node,
    ])
