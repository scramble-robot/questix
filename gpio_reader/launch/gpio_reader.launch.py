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
        description='Use simulation time'
    )

    # GPIO Reader Node
    gpio_reader_node = Node(
        package='gpio_reader',
        executable='gpio_reader_node',
        name='gpio_reader_node',
        output='screen',
        parameters=[
            LaunchConfiguration('config_file'),
            {'use_sim_time': LaunchConfiguration('use_sim_time')}
        ]
    )

    return LaunchDescription([
        config_file_arg,
        use_sim_time_arg,
        gpio_reader_node,
    ])
