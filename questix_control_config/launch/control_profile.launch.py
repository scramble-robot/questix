# Copyright 2026 scramble-robot
# SPDX-License-Identifier: MIT
"""Select the shared QUESTiX profile for XML launch consumers."""

from launch import LaunchDescription
from questix_control_config import control_actions


def generate_launch_description():
    """Expose profile selection without starting hardware or ROS nodes."""
    return LaunchDescription(control_actions())
