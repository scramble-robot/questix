# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
"""Verify the simulator's diagnostic node invocation without ROS or a child process."""

import importlib.util
from pathlib import Path
from unittest.mock import Mock


def test_node_process_explicitly_opts_out_of_both_safety_inputs(monkeypatch):
    """The isolated diagnostic domain has neither operation_manager safety publisher."""
    spec = importlib.util.spec_from_file_location(
        'current_mode_sim_server', Path(__file__).with_name('sim_server.py'))
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    popen = Mock()
    monkeypatch.setattr(server.subprocess, 'Popen', popen)
    monkeypatch.setattr(server.threading, 'Thread', Mock())
    server.NodeProcess(Mock(), '/fake-port', 'current', 4, 5, Path('/fake-params.yaml'))
    command = popen.call_args.args[0]
    assert command[:4] == ['ros2', 'run', 'motor_control_app', 'drive_component_node']
    for setting in ('require_emergency_stop:=false', 'require_motion_permission:=false'):
        index = command.index(setting)
        assert command[index - 1] == '-p'
