# Copyright 2026 scramble-robot
#
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import ComposableNodeContainer
from launch_ros.descriptions import ComposableNode
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

    # Create container with GPIO Reader component
    # config_file が Single Source of Truth。
    container = ComposableNodeContainer(
        name='gpio_reader_container',
        namespace='',
        package='rclcpp_components',
        executable='component_container',
        composable_node_descriptions=[
            ComposableNode(
                package='gpio_reader',
                plugin='gpio_reader::GpioReaderComponent',
                name='gpio_reader_node',
                parameters=[LaunchConfiguration('config_file')],
                extra_arguments=[{'use_intra_process_comms': True}]
            ),
        ],
        output='screen',
    )

    return LaunchDescription([
        config_file_arg,
        use_sim_time_arg,
        container,
    ])
