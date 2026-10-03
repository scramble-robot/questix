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
        try:
            last_result = run_command(
                ['ros2', 'param', 'get', node_name, parameter_name], environment)
        except subprocess.TimeoutExpired:
            continue  # a loaded machine (parallel colcon test): retry until the deadline
        if last_result.returncode == 0:
            value_lines = [
                line for line in last_result.stdout.splitlines()
                if 'values are:' in line or 'value is:' in line
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


def test_invalid_autoreferee_configuration_starts_no_child_processes():
    """Reject the invalid profile before any hardware-facing child can start."""
    environment = isolated_ros_environment(3)
    process = start_process(
        [
            'ros2', 'launch', 'questix_launcher', 'questix_core.launch.xml',
            'enable_lidar:=true',
            'enable_shot:=true',
            'enable_drive:=true',
            'enable_gpio_ref:=false',
            'enable_autoreferee:=true',
            'enable_rviz:=true',
        ],
        environment,
    )
    forbidden_nodes = {
        '/gpio_reader_node',
        '/operation_manager_node',
        '/drive_component',
        '/shot_component',
        '/esc_motor_control',
        '/ydlidar_ros2_driver_node',
        '/rviz2',
    }
    observed_nodes = set()
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    while process.poll() is None and time.monotonic() < deadline:
        result = run_command(['ros2', 'node', 'list', '--no-daemon'], environment)
        if result.returncode == 0:
            observed_nodes.update(result.stdout.splitlines())
        time.sleep(0.02)

    try:
        assert process.poll() is not None, 'invalid questix_core launch did not exit'
        assert process.returncode == 0
    finally:
        output = stop_process(process)

    assert 'ERROR: enable_autoreferee=true requires enable_gpio_ref=true' in output
    assert forbidden_nodes.isdisjoint(observed_nodes)
    assert 'process started with pid' not in output


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


def topic_subscription_count(topic, environment):
    """Return how many subscriptions the graph shows for a topic (0 when it does not exist)."""
    result = run_command(['ros2', 'topic', 'info', topic, '--no-daemon'], environment)
    for line in result.stdout.splitlines():
        if line.startswith('Subscription count:'):
            return int(line.split(':', 1)[1])
    return 0


ACTUATING_NODES = ('/drive_component', '/shot_component', '/esc_motor_control')
NO_GPIO_REASON = 'released (no GPIO safety path)'


def read_emergency_stop(environment):
    """Return (active, reason) of the latched /emergency_stop, or None if it never came."""
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        try:
            result = run_command(
                ['ros2', 'topic', 'echo', '--once', '--qos-reliability', 'reliable',
                 '--qos-durability', 'transient_local', '/emergency_stop',
                 'questix_msgs/msg/EmergencyStop'],
                environment, timeout=COMMAND_TIMEOUT_SECONDS + 5.0)
        except subprocess.TimeoutExpired:
            continue
        fields = {}
        for line in result.stdout.splitlines():
            key, _, value = line.partition(':')
            fields[key.strip()] = value.strip().strip("'")
        if 'active' in fields:
            return fields['active'] == 'true', fields.get('reason', '')
        time.sleep(0.2)
    return None


@pytest.mark.parametrize(
    ('launch_arguments', 'expect_estop', 'expect_authority_required'),
    [
        # Practice without the GPIO safety path (ENABLE_GPIO_REF=false): operation_manager still
        # owns /emergency_stop and reports released, so the robot (and QUESTiX LAB) can move.
        (['enable_gpio_ref:=false'], (False, NO_GPIO_REASON), False),
        # Practice with the GPIO safety path but no GPIO hardware here: GPIO5 is never received,
        # so operation_manager reports the E-stop as active.
        (['enable_gpio_ref:=true'], (True, 'pin 5 not received; '), False),
        # A practice opt-in to the teacher's authority (a permission, not an E-stop).
        (['enable_gpio_ref:=false', 'require_runtime_actuation_authority:=true'],
         (False, NO_GPIO_REASON), True),
        # Competition never depends on the classroom heartbeat, even when asked to.
        (['enable_gpio_ref:=true', 'enable_autoreferee:=true',
          'require_runtime_actuation_authority:=true'],
         (True, 'pin 5 not received; pin 27 not received; '), False),
    ],
)
def test_core_launch_publishes_the_estop_and_passes_the_authority_switch(
        launch_arguments, expect_estop, expect_authority_required):
    """
    Start questix_core with drive and launcher and read what every actuating node got.

    /emergency_stop always comes from operation_manager and is always required. The teacher's
    authority is an opt-in, and disabled must mean disabled: no node subscribes to
    /actuation_authority without it.
    """
    environment = isolated_ros_environment(10 + len(launch_arguments) * 3 +
                                           int(expect_estop[0]) +
                                           2 * int(expect_authority_required))
    arguments = ['enable_lidar:=false', 'enable_shot:=true', 'enable_drive:=true',
                 'enable_rviz:=false', 'controller_type:=dualshock']
    if not any(argument.startswith('enable_autoreferee:=') for argument in launch_arguments):
        arguments.append('enable_autoreferee:=false')
    process = start_process(
        ['ros2', 'launch', 'questix_launcher', 'questix_core.launch.xml',
         *arguments, *launch_arguments],
        environment,
    )
    expected_authority = f'Boolean value is: {expect_authority_required}'
    try:
        for node in ACTUATING_NODES:
            assert wait_for_parameter(node, 'require_emergency_stop', environment) == (
                'Boolean value is: True'), node
            assert wait_for_parameter(
                node, 'require_runtime_actuation_authority', environment) == (
                expected_authority), node
        assert read_emergency_stop(environment) == expect_estop
        # Graph discovery is not instant: wait for the expected count (the opt-in), or watch for
        # a while that none appears (disabled).
        expected_subscriptions = len(ACTUATING_NODES) if expect_authority_required else 0
        deadline = time.monotonic() + 15.0
        subscriptions = topic_subscription_count('/actuation_authority', environment)
        while time.monotonic() < deadline:
            if expect_authority_required and subscriptions == expected_subscriptions:
                break
            if not expect_authority_required and subscriptions != 0:
                break
            time.sleep(0.2)
            subscriptions = topic_subscription_count('/actuation_authority', environment)
        assert subscriptions == expected_subscriptions
    finally:
        output = stop_process(process)
    assert 'InvalidParameterValueException' not in output
    assert 'parameter_value_from failed' not in output
