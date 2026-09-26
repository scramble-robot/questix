"""Launch the optional Blockly desktop simulation without hardware drivers."""
from pathlib import Path
import xacro
import math
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import (DeclareLaunchArgument, OpaqueFunction, SetEnvironmentVariable,
                            RegisterEventHandler, EmitEvent)
from launch.event_handlers import OnProcessExit
from launch.events import Shutdown
import socket
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def setup(context):
    root = Path(get_package_share_directory('questix_blockly'))
    port = int(LaunchConfiguration('port').perform(context))
    domain = int(LaunchConfiguration('domain').perform(context))
    if not 1024 <= port <= 65535 or not 0 <= domain <= 232:
        raise ValueError('Invalid port or ROS domain')
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(('127.0.0.1', port))
        except OSError as exc:
            raise RuntimeError(f'Port {port} is in use. Stop the existing Blockly session first.') from exc
    show_rviz = LaunchConfiguration('rviz').perform(context).lower() == 'true'
    device = LaunchConfiguration('controller_name').perform(context)
    model = Path(get_package_share_directory('description_launch')) / 'urdf/questix.xacro'
    model_yaw = float(LaunchConfiguration('model_yaw').perform(context))
    if not math.isfinite(model_yaw):
        raise ValueError('model_yaw must be finite')
    document = xacro.process_file(str(model))
    # CAD mesh orientation only: preserve base_link +X forward for differential drive.
    for visual in document.getElementsByTagName('visual'):
        for origin in visual.getElementsByTagName('origin'):
            rpy = origin.getAttribute('rpy').split() or ['0', '0', '0']
            rpy[2] = str(float(rpy[2]) + model_yaw)
            origin.setAttribute('rpy', ' '.join(rpy))
    description = document.toxml()
    joy_config = str(Path(get_package_share_directory('joy_controller')) /
                     'config/joy_controller_params.yaml')
    # Speed ratios and axes are operator tuning: the packaged default profile
    # (questix_control_config, controls.uart.yaml) is applied after the node's own YAML.
    control_profile = str(Path(get_package_share_directory('questix_control_config')) /
                          'config/controls.uart.yaml')
    import yaml
    ratios = yaml.safe_load(Path(control_profile).read_text())['joy_controller']['ros__parameters']
    linear_scale = float(ratios['longitudinal_input_ratio'])
    angular_scale = float(ratios['angular_input_ratio'])
    if not all(math.isfinite(x) and x > 0 for x in (linear_scale, angular_scale)):
        raise ValueError('Joy input ratios must be finite and positive')
    nodes = [
        Node(package='operation_manager', executable='operation_manager_node',
             name='operation_manager_node', output='screen'),
        Node(package='joy_gate', executable='joy_gate_node', name='joy_gate', output='screen'),
        Node(package='joy_controller', executable='joy_controller_node',
             name='joy_controller', output='screen', parameters=[joy_config, control_profile, {
                 'joy_topic': '/joy_gated', 'linear_x_axis': 1,
                 'angular_z_axis': 2, 'lateral_input_ratio': 0.0}]),
        Node(package='esc_motor_control_cpp', executable='esc_motor_control_node',
             name='esc_motor_control', output='screen', parameters=[{
                 'test_mode': True, 'pwm_backend': 'simulation', 'joy_topic': '/joy_gated',
                 'full_speed_button': 10}]),
        Node(package='robot_state_publisher', executable='robot_state_publisher',
             parameters=[{'robot_description': description}], output='screen'),
        Node(package='questix_blockly', executable='drive_sim.py',
             parameters=[{'demo': False}], output='screen'),
    ]
    if LaunchConfiguration('controller').perform(context).lower() == 'true':
        nodes.append(Node(package='joy', executable='game_controller_node',
                          name='game_controller', output='screen',
                          remappings=[('/joy', '/blockly/controller_joy')],
                          parameters=[{
                              'device_name': device, 'device_id': 0,
                              'deadzone': 0.1, 'autorepeat_rate': 50.0,
                              'sticky_buttons': False}]))
    if show_rviz:
        nodes.append(Node(package='rviz2', executable='rviz2', name='rviz2',
                          arguments=['-d', str(root / 'config/questix.rviz')], output='screen'))
    bridge = Node(package='questix_blockly', executable='bridge.py', output='screen',
                  arguments=['--port', str(port), '--domain', str(domain),
                             '--linear-scale', str(linear_scale), '--angular-scale', str(angular_scale)])
    return [SetEnvironmentVariable('ROS_DOMAIN_ID', str(domain)),
            SetEnvironmentVariable('ROS_AUTOMATIC_DISCOVERY_RANGE', 'LOCALHOST'),
            RegisterEventHandler(OnProcessExit(target_action=bridge,
                on_exit=[EmitEvent(event=Shutdown(reason='Blockly bridge exited'))])),
            RegisterEventHandler(OnProcessExit(target_action=nodes[5],
                on_exit=[EmitEvent(event=Shutdown(reason='Simulation exited'))])),
            *nodes, bridge]


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument('rviz', default_value='true', choices=['true', 'false']),
        DeclareLaunchArgument('port', default_value='5174'),
        DeclareLaunchArgument('domain', default_value='75'),
        DeclareLaunchArgument('model_yaw', default_value='1.5707963267948966'),
        DeclareLaunchArgument('controller', default_value='true', choices=['true', 'false']),
        DeclareLaunchArgument('controller_name', default_value='Generic X-Box pad'),
        OpaqueFunction(function=setup),
    ])
