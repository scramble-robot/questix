# Copyright 2026 scramble-robot
#
#!/usr/bin/env python3

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    return LaunchDescription([
        # Launch arguments
        DeclareLaunchArgument(
            'serial_port',
            default_value='/dev/ttyACM0',
            description='Serial port for DDT motor communication'
        ),

        DeclareLaunchArgument(
            'motor_id',
            default_value='4',
            description='DDT motor ID'
        ),

        DeclareLaunchArgument(
            'max_motor_rpm',
            default_value='30',
            description='Maximum motor RPM'
        ),

        DeclareLaunchArgument(
            'velocity_scale_factor',
            default_value='5.0',
            description='Scale factor to convert linear velocity (m/s) to RPM'
        ),

        # Single DDT Motor Component Node
        Node(
            package='motor_control_app',
            executable='single_ddt_motor_node',
            name='single_ddt_motor_node',
            output='screen',
            parameters=[{
                'serial_port': LaunchConfiguration('serial_port'),
                'motor_id': LaunchConfiguration('motor_id'),
                'max_motor_rpm': LaunchConfiguration('max_motor_rpm'),
                'velocity_scale_factor': LaunchConfiguration('velocity_scale_factor'),
                'baud_rate': 57600,
                'wheel_radius': 0.1,
                'status_publish_rate': 5.0,
                'watchdog_timeout': 1.0
            }],
            remappings=[
                ('cmd_vel', '/cmd_vel'),
                ('motor_status', '/motor_status')
            ]
        )
    ])
