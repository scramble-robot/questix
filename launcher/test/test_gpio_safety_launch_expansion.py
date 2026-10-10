# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.

"""
What questix_core hands each node for every GPIO safety switch, resolved without ROS.

These are the launch-logic halves of the runtime smoke tests: the launch argument matrix, the
safety-only and environment variants and the invalid AutoReferee configuration are resolved by
expanding (or, for the invalid one, running) the real launch description in-process, with every
process execution intercepted. test_gpio_safety_runtime.py starts questix_core once per
operation_manager profile and checks that the nodes really take these values and what they do
with them (typed profile arrays, the E-stop, the /actuation_authority subscriptions).
"""

from launch import LaunchDescription, LaunchService
from launch.actions import ExecuteProcess, IncludeLaunchDescription, LogInfo
from launch.launch_description_sources import AnyLaunchDescriptionSource
from launch_ros.actions import LoadComposableNodes
import pytest
import yaml


CORE_LAUNCH = 'launcher/launch/questix_core.launch.xml'
ACTUATING_NODES = ('/drive_component', '/shot_component', '/esc_motor_control')
GPIO_SAFETY_NODES = ('/gpio_reader_node', '/operation_manager_node')
# The arguments test_gpio_safety_runtime.py starts questix_core with.
RUNTIME_ARGUMENTS = {'enable_lidar': 'false', 'enable_shot': 'true', 'enable_drive': 'true',
                     'enable_rviz': 'false', 'controller_type': 'dualshock'}
SAFETY_ONLY_ARGUMENTS = {'enable_lidar': 'false', 'enable_shot': 'false', 'enable_drive': 'false',
                         'enable_autoreferee': 'false', 'enable_rviz': 'false'}


def operation_manager_profile(root, profile):
    """Return the parameters of one installed operation_manager profile."""
    document = yaml.safe_load(
        (root / 'operation_manager' / 'config' / profile).read_text(encoding='utf-8'))
    return document['operation_manager_node']['ros__parameters']


@pytest.mark.parametrize(
    ('launch_arguments', 'expect_profile', 'expect_teacher_permission_required'),
    [
        # Manual diagnostic run without the GPIO safety path.
        ({'enable_gpio_ref': 'false'}, 'operation_manager.no_gpio.yaml', False),
        # Practice with the GPIO safety path.
        ({'enable_gpio_ref': 'true'}, 'operation_manager.practice.yaml', False),
        # A practice opt-in to the teacher's permission (a permission, not an E-stop).
        ({'enable_gpio_ref': 'false', 'require_teacher_permission': 'true'},
         'operation_manager.no_gpio.yaml', True),
        # Competition never depends on the classroom heartbeat, even when asked to.
        ({'enable_gpio_ref': 'true', 'enable_autoreferee': 'true',
          'require_teacher_permission': 'true'},
         'operation_manager.competition.yaml', False),
    ],
)
def test_core_launch_passes_the_estop_profile_and_the_teacher_permission_switch(
        expand, source_packages, launch_arguments, expect_profile,
        expect_teacher_permission_required):
    """
    Every actuating node requires /emergency_stop; the teacher's permission only on opt-in.

    operation_manager (the E-stop's single owner) gets exactly the profile the switches select,
    with or without the GPIO safety path, and gpio_reader runs only with it.
    """
    arguments = {'enable_autoreferee': 'false', **RUNTIME_ARGUMENTS, **launch_arguments}
    nodes = expand(CORE_LAUNCH, **arguments)
    for node in ACTUATING_NODES:
        assert nodes[node]['require_emergency_stop'] is True, node
        assert nodes[node]['require_teacher_permission'] is (
            expect_teacher_permission_required), node
    assert nodes['/operation_manager_node'] == operation_manager_profile(
        source_packages, expect_profile)
    assert ('/gpio_reader_node' in nodes) is (arguments['enable_gpio_ref'] == 'true')


def test_safety_only_practice_launch_runs_the_same_gpio_safety_nodes(expand):
    """
    Without drive and launcher, practice still runs gpio_reader and operation_manager.

    They get the parameters of the full practice launch, whose processes the runtime test
    keeps alive.
    """
    safety_only = expand(CORE_LAUNCH, enable_gpio_ref='true', **SAFETY_ONLY_ARGUMENTS)
    full = expand(CORE_LAUNCH, enable_gpio_ref='true', enable_autoreferee='false',
                  **RUNTIME_ARGUMENTS)
    for node in GPIO_SAFETY_NODES:
        assert safety_only[node] == full[node], node
    assert not set(ACTUATING_NODES) & set(safety_only)


def test_gpio_ref_environment_does_not_select_the_no_gpio_diagnostic(expand, monkeypatch):
    """
    Leave enable_gpio_ref out with ENABLE_GPIO_REF=false exported: GPIO safety stays on.

    Issue #168: the no-GPIO diagnostic needs an explicit enable_gpio_ref:=false on the launch;
    an exported variable or a sourced legacy launch.env must not select it. (No node reads the
    variable itself: only the launch file could.)
    """
    explicit = expand(CORE_LAUNCH, enable_gpio_ref='true', **SAFETY_ONLY_ARGUMENTS)
    monkeypatch.setenv('ENABLE_GPIO_REF', 'false')
    from_environment = expand(CORE_LAUNCH, **SAFETY_ONLY_ARGUMENTS)
    assert from_environment == explicit
    for node in GPIO_SAFETY_NODES:
        assert node in from_environment, node
    assert 'gpio_safety_enabled' not in from_environment['/operation_manager_node']


def test_invalid_autoreferee_configuration_starts_no_child_processes(
        source_packages, monkeypatch):
    """
    Reject the invalid profile before any hardware-facing child can start.

    Runs the real launch service (event loop, timer, shutdown) in-process, with every process
    execution and component load intercepted.
    """
    started = []
    logged = []

    def record_process(action, context):
        started.append(action)
        return None

    def record_load(action, context):
        started.append(action)
        return None

    log_info_execute = LogInfo.execute

    def record_log(action, context):
        logged.append(''.join(context.perform_substitution(part) for part in action.msg))
        return log_info_execute(action, context)

    monkeypatch.setattr(ExecuteProcess, 'execute', record_process)
    monkeypatch.setattr(LoadComposableNodes, 'execute', record_load)
    monkeypatch.setattr(LogInfo, 'execute', record_log)
    service = LaunchService()
    service.include_launch_description(LaunchDescription([IncludeLaunchDescription(
        AnyLaunchDescriptionSource(str(source_packages / CORE_LAUNCH)),
        launch_arguments={
            'enable_lidar': 'true',
            'enable_shot': 'true',
            'enable_drive': 'true',
            'enable_gpio_ref': 'false',
            'enable_autoreferee': 'true',
            'enable_rviz': 'true',
        }.items(),
    )]))
    assert service.run() == 0
    assert 'ERROR: enable_autoreferee=true requires enable_gpio_ref=true' in logged
    assert started == []
