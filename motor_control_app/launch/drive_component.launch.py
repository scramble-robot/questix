# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
from launch import LaunchDescription
from launch_ros.actions import Node


def generate_launch_description():
    # 単体launch はノード宣言デフォルトで起動する（launcher/config/drive_component.yaml と同値）。
    # 設定を変えたい場合は launcher/config/drive_component.yaml を編集する（単一ソース）。
    drive_component_node = Node(
        package='motor_control_app',
        executable='drive_component_node',
        name='drive_component',
        output='screen',
        emulate_tty=True,
        respawn=True,
        respawn_delay=2.0
    )

    return LaunchDescription([
        drive_component_node,
    ])
