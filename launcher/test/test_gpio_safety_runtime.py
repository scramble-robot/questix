# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.

"""ROS 2 runtime smoke tests for installed GPIO safety parameter profiles."""

import os
from pathlib import Path
import signal
import subprocess
import time

import pytest


STARTUP_TIMEOUT_SECONDS = 15.0
COMMAND_TIMEOUT_SECONDS = 5.0


def isolated_ros_environment(offset):
    """Return an environment using a test-specific local ROS domain."""
    environment = os.environ.copy()
    environment['ROS_DOMAIN_ID'] = str(100 + ((os.getpid() + offset) % 100))
    environment['ROS_AUTOMATIC_DISCOVERY_RANGE'] = 'LOCALHOST'
    environment.pop('ROS_LOCALHOST_ONLY', None)
    return environment


def run_command(command, environment, timeout=COMMAND_TIMEOUT_SECONDS):
    """Run a ROS command and capture text output."""
    return subprocess.run(
        command,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
        check=False,
    )


def start_process(command, environment):
    """Start a ROS process in its own group for scoped cleanup."""
    return subprocess.Popen(
        command,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )


def stop_process(process):
    """Stop only the process group created by this test and return its output."""
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGINT)
    try:
        output, _ = process.communicate(timeout=5.0)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            output, _ = process.communicate(timeout=5.0)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            output, _ = process.communicate(timeout=5.0)
    return output


def wait_for_parameter(node_name, parameter_name, environment):
    """Wait until a node is alive and returns a parameter value."""
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    last_result = None
    while time.monotonic() < deadline:
        last_result = run_command(
            ['ros2', 'param', 'get', node_name, parameter_name], environment)
        if last_result.returncode == 0:
            value_lines = [
                line for line in last_result.stdout.splitlines()
                if 'values are:' in line
            ]
            assert value_lines, last_result.stdout
            return value_lines[-1]
        time.sleep(0.2)
    output = last_result.stdout if last_result is not None else 'command not run'
    pytest.fail(f'{node_name} did not provide {parameter_name}: {output}')


def installed_profile_path(profile_name, environment):
    """Resolve a profile from the installed operation_manager package share."""
    result = run_command(['ros2', 'pkg', 'prefix', 'operation_manager'], environment)
    assert result.returncode == 0, result.stdout
    path = (
        Path(result.stdout.strip()) / 'share' / 'operation_manager' / 'config' /
        profile_name
    )
    assert path.is_file(), f'installed profile not found: {path}'
    return path


@pytest.mark.parametrize(
    ('profile_name', 'expected_safe_high'),
    [
        ('operation_manager.practice.yaml', 'Integer values are: []'),
        ('operation_manager.competition.yaml', 'Integer values are: [27]'),
    ],
)
def test_installed_profiles_load_with_typed_integer_arrays(profile_name, expected_safe_high):
    """Load installed YAML through rclcpp and verify both polarity arrays."""
    environment = isolated_ros_environment(0 if 'practice' in profile_name else 1)
    profile_path = installed_profile_path(profile_name, environment)
    node_name = '/operation_manager_node'
    process = start_process(
        [
            'ros2', 'run', 'operation_manager', 'operation_manager_node',
            '--ros-args', '--params-file', str(profile_path),
        ],
        environment,
    )
    try:
        safe_low = wait_for_parameter(node_name, 'safe_low_pins', environment)
        safe_high = wait_for_parameter(node_name, 'safe_high_pins', environment)
        assert process.poll() is None, 'operation_manager exited after loading its profile'
        assert safe_low == 'Integer values are: [5]'
        assert safe_high == expected_safe_high
    finally:
        output = stop_process(process)
    assert 'InvalidParameterValueException' not in output
    assert 'parameter_value_from failed' not in output


def test_practice_core_launch_keeps_gpio_safety_nodes_alive():
    """Start the installed practice safety-only launch and verify both nodes survive."""
    environment = isolated_ros_environment(2)
    process = start_process(
        [
            'ros2', 'launch', 'questix_launcher', 'questix_core.launch.xml',
            'enable_lidar:=false',
            'enable_shot:=false',
            'enable_drive:=false',
            'enable_gpio_ref:=true',
            'enable_autoreferee:=false',
            'enable_rviz:=false',
        ],
        environment,
    )
    expected_nodes = {'/gpio_reader_node', '/operation_manager_node'}
    observed_nodes = set()
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    try:
        while time.monotonic() < deadline:
            assert process.poll() is None, 'questix_core exited during practice startup'
            result = run_command(['ros2', 'node', 'list', '--no-daemon'], environment)
            if result.returncode == 0:
                observed_nodes = set(result.stdout.splitlines())
                if expected_nodes <= observed_nodes:
                    break
            time.sleep(0.2)
        assert expected_nodes <= observed_nodes
        assert process.poll() is None
    finally:
        output = stop_process(process)
    assert 'InvalidParameterValueException' not in output
    assert 'parameter_value_from failed' not in output
