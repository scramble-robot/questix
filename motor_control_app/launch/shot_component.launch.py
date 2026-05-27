# Copyright 2026 scramble-robot
#
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    # パッケージディレクトリを取得
    pkg_dir = get_package_share_directory('motor_control_app')

    # 設定ファイルのパス
    config_file = os.path.join(pkg_dir, 'config', 'shot_config.yaml')

    fire_button_arg = DeclareLaunchArgument(
        'fire_button',
        default_value='5',
        description='Fire button number (Switch2 native: R=5)'
    )

    joy_topic_arg = DeclareLaunchArgument(
        'joy_topic',
        default_value='/joy',
        description='Joy topic name'
    )

    # shot componentノード
    shot_component_node = Node(
        package='motor_control_app',
        executable='shot_component_node',
        name='shot_component',
        parameters=[
            config_file,
            {
                'fire_button': LaunchConfiguration('fire_button'),
                'joy_topic': LaunchConfiguration('joy_topic')
            }
        ],
        output='screen'
    )

    return LaunchDescription([
        fire_button_arg,
        joy_topic_arg,
        shot_component_node
    ])
