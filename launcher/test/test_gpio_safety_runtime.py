# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.

"""
ROS 2 runtime smoke tests for installed GPIO safety parameter profiles.

questix_core is started once per operation_manager profile (no GPIO, practice, competition) to
check what the running nodes really do: the installed profiles load with typed integer arrays,
the nodes stay up, every actuating node requires /emergency_stop, operation_manager publishes it,
and /actuation_authority is subscribed only on the teacher's opt-in. Which arguments select
which profile and switches (the whole matrix, the safety-only and environment variants and the
invalid AutoReferee configuration) is resolved without ROS in
test_gpio_safety_launch_expansion.py.
"""

import os
import signal
import subprocess
import time

import pytest


STARTUP_TIMEOUT_SECONDS = 15.0
COMMAND_TIMEOUT_SECONDS = 5.0
# Domains 1-101 only: from 102 on, the DDS discovery ports (7400 + 250 * domain) fall into the
# Linux ephemeral range (32768-60999), where another process's socket can hold them and the
# launch is never discovered (cf. scripts/robot_manager/ros_domain.py). 0 is the default of the
# other packages' tests running in parallel and 78 is questix_blockly's.
TEST_DOMAIN_IDS = tuple(domain for domain in range(1, 102) if domain != 78)


def isolated_ros_environment(offset):
    """Return an environment using a test-specific local ROS domain."""
    environment = os.environ.copy()
    environment['ROS_DOMAIN_ID'] = str(
        TEST_DOMAIN_IDS[(os.getpid() + offset) % len(TEST_DOMAIN_IDS)])
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


def topic_subscription_count(topic, environment):
    """Return how many subscriptions the graph shows for a topic (0 when it does not exist)."""
    result = run_command(['ros2', 'topic', 'info', topic, '--no-daemon'], environment)
    for line in result.stdout.splitlines():
        if line.startswith('Subscription count:'):
            return int(line.split(':', 1)[1])
    return 0


ACTUATING_NODES = ('/drive_component', '/shot_component', '/esc_motor_control')
GPIO_SAFETY_NODES = ('/gpio_reader_node', '/operation_manager_node')
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
    ('launch_arguments', 'expect_estop', 'expect_teacher_permission_required',
     'expect_safe_pins'),
    [
        # Manual diagnostic run without the GPIO safety path (enable_gpio_ref:=false, never passed
        # by the production launcher), opted in to the teacher's permission (a permission, not an
        # E-stop): operation_manager still owns /emergency_stop and reports released, so the
        # robot (and QUESTiX LAB) can move.
        (['enable_gpio_ref:=false', 'require_teacher_permission:=true'],
         (False, NO_GPIO_REASON), True, None),
        # Practice with the GPIO safety path but no GPIO hardware here: GPIO5 is never received,
        # so operation_manager reports the E-stop as active.
        (['enable_gpio_ref:=true'], (True, 'pin 5 not received; '), False,
         ('Integer values are: [5]', 'Integer values are: []')),
        # Competition never depends on the classroom heartbeat, even when asked to.
        (['enable_gpio_ref:=true', 'enable_autoreferee:=true',
          'require_teacher_permission:=true'],
         (True, 'pin 5 not received; pin 27 not received; '), False,
         ('Integer values are: [5]', 'Integer values are: [27]')),
    ],
)
def test_core_launch_publishes_the_estop_and_passes_the_teacher_permission_switch(
        launch_arguments, expect_estop, expect_teacher_permission_required, expect_safe_pins):
    """
    Start questix_core with drive and launcher and read what every node got and does.

    /emergency_stop always comes from operation_manager and is always required. The teacher's
    permission is an opt-in, and disabled must mean disabled: no node subscribes to
    /actuation_authority without it. With the GPIO safety path, the installed profile's pin
    arrays load as typed integer arrays and gpio_reader and operation_manager stay up.
    """
    environment = isolated_ros_environment(10 + len(launch_arguments) * 3 +
                                           int(expect_estop[0]) +
                                           2 * int(expect_teacher_permission_required))
    arguments = ['enable_lidar:=false', 'enable_shot:=true', 'enable_drive:=true',
                 'enable_rviz:=false', 'controller_type:=dualshock']
    if not any(argument.startswith('enable_autoreferee:=') for argument in launch_arguments):
        arguments.append('enable_autoreferee:=false')
    process = start_process(
        ['ros2', 'launch', 'questix_launcher', 'questix_core.launch.xml',
         *arguments, *launch_arguments],
        environment,
    )
    expected_teacher_permission = f'Boolean value is: {expect_teacher_permission_required}'
    try:
        for node in ACTUATING_NODES:
            assert wait_for_parameter(node, 'require_emergency_stop', environment) == (
                'Boolean value is: True'), node
            assert wait_for_parameter(
                node, 'require_teacher_permission', environment) == (
                expected_teacher_permission), node
        if expect_safe_pins is not None:
            safe_low = wait_for_parameter(
                '/operation_manager_node', 'safe_low_pins', environment)
            safe_high = wait_for_parameter(
                '/operation_manager_node', 'safe_high_pins', environment)
            assert (safe_low, safe_high) == expect_safe_pins
            assert wait_for_parameter(
                '/operation_manager_node', 'gpio_safety_enabled', environment) == (
                'Boolean value is: True')
            result = run_command(['ros2', 'node', 'list', '--no-daemon'], environment)
            assert set(GPIO_SAFETY_NODES) <= set(result.stdout.splitlines()), result.stdout
        assert read_emergency_stop(environment) == expect_estop
        # Graph discovery is not instant: wait for the expected count (the opt-in), or watch for
        # a while that none appears (disabled).
        expected_subscriptions = len(ACTUATING_NODES) if expect_teacher_permission_required else 0
        deadline = time.monotonic() + 15.0
        subscriptions = topic_subscription_count('/actuation_authority', environment)
        while time.monotonic() < deadline:
            if expect_teacher_permission_required and subscriptions == expected_subscriptions:
                break
            if not expect_teacher_permission_required and subscriptions != 0:
                break
            time.sleep(0.2)
            subscriptions = topic_subscription_count('/actuation_authority', environment)
        assert subscriptions == expected_subscriptions
        assert process.poll() is None, 'questix_core exited during the checks'
    finally:
        output = stop_process(process)
    assert 'InvalidParameterValueException' not in output
    assert 'parameter_value_from failed' not in output
