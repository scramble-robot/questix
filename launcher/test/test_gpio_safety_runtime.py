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

The graph is read by an rclpy node inside this test process (parameter services, the node and
subscription graph, the latched /emergency_stop), not by one ros2 CLI process per query: each
CLI call starts Python and DDS discovery again, which made this test slow on CI runners.
"""

import os
import signal
import subprocess
import time

import pytest
from questix_msgs.msg import EmergencyStop
from rcl_interfaces.msg import ParameterType
from rcl_interfaces.srv import GetParameters
import rclpy
from rclpy.context import Context
from rclpy.executors import SingleThreadedExecutor
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy


STARTUP_TIMEOUT_SECONDS = 15.0
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


class GraphProbe:
    """An rclpy node in the test's ROS domain that reads what the launched nodes expose."""

    def __init__(self, environment):
        # The discovery range is read from the process environment when the context starts.
        previous_range = os.environ.get('ROS_AUTOMATIC_DISCOVERY_RANGE')
        os.environ['ROS_AUTOMATIC_DISCOVERY_RANGE'] = environment['ROS_AUTOMATIC_DISCOVERY_RANGE']
        try:
            self.context = Context()
            rclpy.init(context=self.context, domain_id=int(environment['ROS_DOMAIN_ID']))
        finally:
            if previous_range is None:
                os.environ.pop('ROS_AUTOMATIC_DISCOVERY_RANGE', None)
            else:
                os.environ['ROS_AUTOMATIC_DISCOVERY_RANGE'] = previous_range
        self.node = rclpy.create_node('gpio_safety_runtime_probe', context=self.context)
        self.executor = SingleThreadedExecutor(context=self.context)
        self.executor.add_node(self.node)
        self.estop = None
        self.node.create_subscription(
            EmergencyStop, '/emergency_stop', self._receive_estop,
            QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                       durability=DurabilityPolicy.TRANSIENT_LOCAL))

    def _receive_estop(self, message):
        if self.estop is None:  # the first (latched) one, as ros2 topic echo --once read it
            self.estop = (message.active, message.reason)

    def spin_until(self, condition, timeout):
        """Spin until condition() holds or the timeout passes; return condition()."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if condition():
                return True
            self.executor.spin_once(timeout_sec=0.05)
        return condition()

    def node_names(self):
        """Return the fully qualified node names the graph shows."""
        return {
            (namespace.rstrip('/') + '/' + name)
            for name, namespace in self.node.get_node_names_and_namespaces()
        }

    def wait_for_nodes(self, node_names, process):
        """Wait until the graph shows every node (discovery is not instant) while it runs."""
        expected = set(node_names)

        def present():
            assert process.poll() is None, 'questix_core exited during startup'
            return expected <= self.node_names()

        if not self.spin_until(present, STARTUP_TIMEOUT_SECONDS):
            pytest.fail(f'{sorted(expected - self.node_names())} not in the graph: '
                        f'{sorted(self.node_names())}')

    def parameters(self, node_name, names):
        """Wait until a node answers and return {name: (ParameterType, value)}."""
        client = self.node.create_client(GetParameters, f'{node_name}/get_parameters')
        try:
            if not self.spin_until(client.service_is_ready, STARTUP_TIMEOUT_SECONDS):
                pytest.fail(f'{node_name} did not provide {names}')
            future = client.call_async(GetParameters.Request(names=list(names)))
            if not self.spin_until(future.done, STARTUP_TIMEOUT_SECONDS):
                pytest.fail(f'{node_name} did not answer for {names}')
        finally:
            self.node.destroy_client(client)
        values = {}
        for name, value in zip(names, future.result().values):
            if value.type == ParameterType.PARAMETER_BOOL:
                values[name] = (value.type, value.bool_value)
            elif value.type == ParameterType.PARAMETER_INTEGER_ARRAY:
                values[name] = (value.type, list(value.integer_array_value))
            else:
                values[name] = (value.type, None)
        return values

    def read_emergency_stop(self):
        """Return (active, reason) of the latched /emergency_stop, or None if it never came."""
        self.spin_until(lambda: self.estop is not None, STARTUP_TIMEOUT_SECONDS)
        return self.estop

    def subscription_count(self, topic):
        """Return how many subscriptions the graph shows for a topic."""
        self.executor.spin_once(timeout_sec=0.0)
        return self.node.count_subscribers(topic)

    def close(self):
        """Destroy the probe node and its context."""
        self.executor.shutdown()
        self.node.destroy_node()
        rclpy.shutdown(context=self.context)


ACTUATING_NODES = ('/drive_component', '/shot_component', '/esc_motor_control')
GPIO_SAFETY_NODES = ('/gpio_reader_node', '/operation_manager_node')
NO_GPIO_REASON = 'released (no GPIO safety path)'
BOOL = ParameterType.PARAMETER_BOOL
INTEGER_ARRAY = ParameterType.PARAMETER_INTEGER_ARRAY


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
        (['enable_gpio_ref:=true'], (True, 'pin 5 not received; '), False, ([5], [])),
        # Competition never depends on the classroom heartbeat, even when asked to.
        (['enable_gpio_ref:=true', 'enable_autoreferee:=true',
          'require_teacher_permission:=true'],
         (True, 'pin 5 not received; pin 27 not received; '), False, ([5], [27])),
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
    probe = GraphProbe(environment)
    process = start_process(
        ['ros2', 'launch', 'questix_launcher', 'questix_core.launch.xml',
         *arguments, *launch_arguments],
        environment,
    )
    try:
        for node in ACTUATING_NODES:
            assert probe.parameters(
                node, ('require_emergency_stop', 'require_teacher_permission')) == {
                'require_emergency_stop': (BOOL, True),
                'require_teacher_permission': (BOOL, expect_teacher_permission_required),
            }, node
        if expect_safe_pins is not None:
            assert probe.parameters(
                '/operation_manager_node',
                ('safe_low_pins', 'safe_high_pins', 'gpio_safety_enabled')) == {
                'safe_low_pins': (INTEGER_ARRAY, expect_safe_pins[0]),
                'safe_high_pins': (INTEGER_ARRAY, expect_safe_pins[1]),
                'gpio_safety_enabled': (BOOL, True),
            }
            probe.wait_for_nodes(GPIO_SAFETY_NODES, process)
        assert probe.read_emergency_stop() == expect_estop
        # Graph discovery is not instant: wait for the expected count (the opt-in), or watch for
        # a while that none appears (disabled).
        expected_subscriptions = len(ACTUATING_NODES) if expect_teacher_permission_required else 0
        if expect_teacher_permission_required:
            probe.spin_until(
                lambda: probe.subscription_count('/actuation_authority') == (
                    expected_subscriptions), 15.0)
        else:
            probe.spin_until(lambda: probe.subscription_count('/actuation_authority') != 0, 15.0)
        assert probe.subscription_count('/actuation_authority') == expected_subscriptions
        assert process.poll() is None, 'questix_core exited during the checks'
    finally:
        output = stop_process(process)
        probe.close()
    assert 'InvalidParameterValueException' not in output
    assert 'parameter_value_from failed' not in output
