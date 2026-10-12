# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.

"""
What questix_core hands each node for every mode and GPIO safety switch, resolved without ROS.

These are the launch-logic halves of the runtime smoke tests: the launch argument matrix, the
safety-only and environment variants and the invalid configurations are resolved by
expanding (or, for the invalid one, running) the real launch description in-process, with every
process execution intercepted. test_gpio_safety_runtime.py starts questix_core once per
mode and checks that the nodes really take these values and what they do
with them (typed profile arrays, the E-stop, the /motion_permission subscriptions).
"""

from launch import LaunchDescription, LaunchService
from launch.actions import ExecuteProcess, IncludeLaunchDescription, LogInfo
from launch.launch_description_sources import AnyLaunchDescriptionSource
from launch_ros.actions import LoadComposableNodes
import pytest
import yaml


CORE_LAUNCH = 'launcher/launch/questix_core.launch.xml'
ACTUATING_NODES = ('/drive_component', '/shot_component', '/esc_motor_control')
GPIO_SAFETY_NODES = ('/gpio_reader_node', '/emergency_stop_manager')
# The arguments test_gpio_safety_runtime.py starts questix_core with.
RUNTIME_ARGUMENTS = {'enable_lidar': 'false', 'enable_shot': 'true', 'enable_drive': 'true',
                     'enable_rviz': 'false', 'controller_type': 'dualshock'}
SAFETY_ONLY_ARGUMENTS = {'enable_lidar': 'false', 'enable_shot': 'false', 'enable_drive': 'false',
                         'robot_mode': 'practice', 'enable_rviz': 'false'}


def emergency_stop_profile(root, profile):
    """Return the parameters of one installed emergency_stop_manager profile."""
    document = yaml.safe_load(
        (root / 'operation_manager' / 'config' / profile).read_text(encoding='utf-8'))
    return document['emergency_stop_manager']['ros__parameters']


@pytest.mark.parametrize(
    ('launch_arguments', 'expect_profile'),
    [
        # Manual diagnostic run without the GPIO safety path (practice, and lesson: allowed as
        # in #170 until section 9 of the design decides it).
        ({'robot_mode': 'practice', 'enable_gpio_ref': 'false'},
         'emergency_stop_manager.no_gpio.yaml'),
        ({'robot_mode': 'lesson', 'enable_gpio_ref': 'false'},
         'emergency_stop_manager.no_gpio.yaml'),
        # The three production modes, always with the GPIO safety path.
        # The E-stop is GPIO5 in every mode (GPIO27 is the referee's vote, not an E-stop input).
        ({'robot_mode': 'practice', 'enable_gpio_ref': 'true'}, 'emergency_stop_manager.yaml'),
        ({'robot_mode': 'lesson', 'enable_gpio_ref': 'true'}, 'emergency_stop_manager.yaml'),
        ({'robot_mode': 'competition', 'enable_gpio_ref': 'true'}, 'emergency_stop_manager.yaml'),
    ],
)
def test_core_launch_wires_each_mode(expand, source_packages, launch_arguments, expect_profile):
    """
    The same actuators in every mode; the mode decides the inputs and the votes.

    Every actuating node requires /emergency_stop and /motion_permission whatever the mode
    (no launch switches either). emergency_stop_manager (the E-stop's single owner) gets exactly
    the profile the switches select, gpio_reader runs only with the GPIO safety path, the motion
    permission runs for the mode with the referee in competition, and QUESTiX LAB's inputs
    (twist_arbiter, the launcher nodes' lab input) exist in lesson mode only.
    """
    arguments = {**RUNTIME_ARGUMENTS, **launch_arguments}
    mode = arguments['robot_mode']
    nodes = expand(CORE_LAUNCH, **arguments)
    for node in ACTUATING_NODES:
        assert nodes[node]['require_emergency_stop'] is True, node
        assert nodes[node]['require_motion_permission'] is True, node
        assert not any('teacher_permission' in name for name in nodes[node]), node
    assert nodes['/emergency_stop_manager'] == emergency_stop_profile(
        source_packages, expect_profile)
    assert ('/gpio_reader_node' in nodes) is (arguments['enable_gpio_ref'] == 'true')
    assert nodes['/motion_permission_manager']['mode'] == mode
    assert ('/referee_monitor' in nodes) is (mode == 'competition')
    assert ('/twist_arbiter' in nodes) is (mode == 'lesson')
    for node in ('/shot_component', '/esc_motor_control'):
        assert nodes[node]['accept_lab_input'] is (mode == 'lesson'), node


def test_safety_only_practice_launch_runs_the_same_gpio_safety_nodes(expand):
    """
    Without drive and launcher, practice still runs gpio_reader and emergency_stop_manager.

    They get the parameters of the full practice launch, whose processes the runtime test
    keeps alive.
    """
    safety_only = expand(CORE_LAUNCH, enable_gpio_ref='true', **SAFETY_ONLY_ARGUMENTS)
    full = expand(CORE_LAUNCH, enable_gpio_ref='true', robot_mode='practice',
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
    assert 'gpio_safety_enabled' not in from_environment['/emergency_stop_manager']


@pytest.mark.parametrize(
    ('launch_arguments', 'expect_error'),
    [
        ({'robot_mode': 'competition', 'enable_gpio_ref': 'false'},
         'ERROR: robot_mode=competition requires enable_gpio_ref=true'),
        ({'robot_mode': 'holiday', 'enable_gpio_ref': 'true'},
         "ERROR: robot_mode must be lesson, practice or competition (got 'holiday')"),
        # An argument robot_mode replaced: refused instead of silently running practice.
        ({'enable_autoreferee': 'true', 'enable_gpio_ref': 'true'}, 'replaced by robot_mode'),
        ({'robot_mode': 'practice', 'require_teacher_permission': 'false'},
         'replaced by robot_mode'),
        ({'robot_mode': 'lesson', 'enable_twist_arbiter': 'true'}, 'replaced by robot_mode'),
        ({'robot_mode': 'lesson', 'enable_lab_shoot': 'true'}, 'replaced by robot_mode'),
    ],
)
def test_invalid_configuration_starts_no_child_processes(
        source_packages, monkeypatch, launch_arguments, expect_error):
    """
    Reject an invalid configuration before any hardware-facing child can start.

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
            'enable_rviz': 'true',
            **launch_arguments,
        }.items(),
    )]))
    assert service.run() == 0
    assert any(expect_error in line for line in logged), logged
    assert started == []
