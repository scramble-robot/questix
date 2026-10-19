# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
"""Exercise the actual Monitor constructor with ROS stubs, without installing ROS."""

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from unittest.mock import Mock

import pytest


def load_server():
    spec = importlib.util.spec_from_file_location(
        'current_sim_monitor_test', Path(__file__).with_name('sim_server.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize('robot_mode', [True, False])
def test_robot_has_no_publishers_and_simulation_has_only_twist(monkeypatch, robot_mode):
    modules = {
        'rclpy': (),
        'geometry_msgs.msg': ('Twist',),
        'lifecycle_msgs.srv': ('ChangeState', 'GetState'),
        'nav_msgs.msg': ('Odometry',),
        'questix_msgs.msg': ('DriveControlSample',),
        'rcl_interfaces.msg': ('Log',),
        'rcl_interfaces.srv': ('GetParameters', 'SetParametersAtomically'),
        'rclpy.qos': ('QoSProfile', 'ReliabilityPolicy'),
        'rclpy.executors': ('SingleThreadedExecutor',),
    }
    stubs = {}
    for name, attributes in modules.items():
        for parent in (name.split('.')[0], name):
            if parent not in stubs:
                stubs[parent] = ModuleType(parent)
                monkeypatch.setitem(sys.modules, parent, stubs[parent])
        for attribute in attributes:
            setattr(stubs[name], attribute, Mock())
    node = Mock()
    stubs['rclpy'].create_node = Mock(return_value=node)
    # The stub executor's spin returns immediately, so no background ROS activity occurs.
    server = load_server()
    monitor = server.Monitor(Mock(), None, robot_mode, 0.05, 0.5, (4, 5))
    try:
        topics = [call.args[1] for call in node.create_publisher.call_args_list]
        assert topics == ([] if robot_mode else ['/target_twist'])
        if robot_mode:
            node.create_timer.assert_not_called()
            assert monitor._twist_pub is None
        else:
            periods = [call.args[0] for call in node.create_timer.call_args_list]
            assert periods == [0.02]
    finally:
        monitor.close()
