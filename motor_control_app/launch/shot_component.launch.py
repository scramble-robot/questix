# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue
from questix_control_config import control_actions


def generate_launch_description():
    # パッケージディレクトリを取得
    pkg_dir = get_package_share_directory('motor_control_app')

    # 設定ファイルのパス
    config_file = os.path.join(pkg_dir, 'config', 'shot_config.yaml')

    config_file_arg = DeclareLaunchArgument(
        'config_file',
        default_value=config_file,
        description='Path to the shot component configuration YAML'
    )

    # joy_topic は launcher が /joy <-> /joy_gated を切替えるための唯一の override。
    # parameters リストで YAML の後に置くので launcher の指定が勝つ。
    joy_topic_arg = DeclareLaunchArgument(
        'joy_topic',
        default_value='/joy',
        description='Joy input topic (override-only, default matches YAML)'
    )

    # accept_lab_input は練習用起動 (questix_launcher) だけが QUESTiX LAB の
    # チルト・射出を許可するための override。既定値は YAML と同じ false。
    accept_lab_input_arg = DeclareLaunchArgument(
        'accept_lab_input',
        default_value='false',
        description='Accept QUESTiX LAB tilt/fire requests (override-only, default matches '
                    'YAML; practice launches only)'
    )

    # shot componentノード
    shot_component_node = Node(
        package='motor_control_app',
        executable='shot_component_node',
        name='shot_component',
        parameters=[
            LaunchConfiguration('config_file'),
            LaunchConfiguration('control_config_file'),
            {
                'joy_topic': LaunchConfiguration('joy_topic'),
                'accept_lab_input': ParameterValue(
                    LaunchConfiguration('accept_lab_input'), value_type=bool),
            },
        ],
        output='screen'
    )

    return LaunchDescription([
        *control_actions(),
        config_file_arg,
        joy_topic_arg,
        accept_lab_input_arg,
        shot_component_node
    ])
