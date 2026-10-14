# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
"""Command contracts with fake publisher/clock/process, no ROS or motors."""
import importlib.util
from pathlib import Path
from unittest.mock import Mock
import threading
import types

import pytest

import sim_server as sim


@pytest.fixture
def monitor(monkeypatch):
    """Build only the command source, without ROS or child processes."""
    now = [0.0]
    monkeypatch.setattr(sim.time, 'monotonic', lambda: now[0])
    source = object.__new__(sim.Monitor)
    source._lock = threading.Lock()
    source._profile = None
    source._manual = None
    source._neutral_until = 0.0
    source.wheel_radius = .05
    source.wheel_separation = .5
    source.Twist = lambda: types.SimpleNamespace(linear=types.SimpleNamespace(x=0),
                                               angular=types.SimpleNamespace(z=0))
    sent = []
    source._twist_pub = types.SimpleNamespace(
        publish=lambda msg: sent.append((msg.linear.x, msg.angular.z)))
    return source, now, sent


def test_idle_and_robot_monitor(monitor):
    source, now, sent = monitor
    for value in (0, .02, .04, 1):
        now[0] = value
        source._publish_twist()
    assert sent == [(0, 0)] * 4
    source._twist_pub = None
    source._publish_twist()
    assert len(sent) == 4


@pytest.mark.parametrize('name', sim.PROFILES)
def test_every_profile_first_run_prepares_neutral(monitor, name):
    source, now, sent = monitor
    source.run_profile(name)
    for value in (0, .02, .04, .06, .08):
        now[0] = value
        source._publish_twist()
    assert sent == [(0, 0)] * 5
    now[0] = .11
    source._publish_twist()
    assert sent[-1] != (0, 0)
    now[0] = .1 + sum(step[2] for step in sim.PROFILES[name][2]) + .01
    source._publish_twist()
    assert sent[-1] == (0, 0)


def test_manual_heartbeat_preserves_preparation_and_timeout_zero(monitor):
    source, now, sent = monitor
    source.manual(.1, .2)
    source._publish_twist()
    now[0] = .08
    source.manual(.1, .2)
    source._publish_twist()
    assert sent == [(0, 0)] * 2
    now[0] = .11
    source._publish_twist()
    assert sent[-1] == (.1, .2)
    now[0] = .6
    source._publish_twist()
    assert sent[-1] == (0, 0)
    source.manual(.3, 0)
    source._publish_twist()
    assert sent[-1] == (0, 0)


def test_simulated_node_opts_out_of_both_safety_inputs(monkeypatch):
    commands = []
    monkeypatch.setattr(sim.subprocess, 'Popen', lambda cmd, **kwargs: commands.append(cmd))
    monkeypatch.setattr(
        sim.threading, 'Thread', lambda **kwargs: types.SimpleNamespace(start=lambda: None))
    sim.NodeProcess(types.SimpleNamespace(), '/fake/pty', 'current', 4, 5, '/fake/config.yaml')
    assert 'require_emergency_stop:=false' in commands[0]
    assert 'require_motion_permission:=false' in commands[0]


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
