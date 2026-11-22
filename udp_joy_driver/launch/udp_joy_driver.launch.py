"""Start UDP input with optional network and core-selected rearm overrides."""

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import OpaqueFunction
from launch_ros.actions import Node


def start(context):
    params = [get_package_share_directory('udp_joy_driver')
              + '/config/udp_joy_driver_params.yaml']
    config = context.launch_configurations
    if config.get('control_config_file'):
        params.append(config['control_config_file'])
    overrides = {}
    for name in ('local_address', 'peer_address', 'port', 'allow_rearm_after_stop'):
        key = 'udp_' + name
        if config.get(key):
            value = config[key]
            if name == 'port':
                value = int(value)
            elif name == 'allow_rearm_after_stop':
                if value.lower() not in ('true', 'false'):
                    raise ValueError('invalid UDP rearm flag')
                value = value.lower() == 'true'
            overrides[name] = value
    params.append(overrides)
    return [Node(package='udp_joy_driver', executable='udp_joy_driver_node',
                 name='udp_joy_driver', output='screen', parameters=params)]


def generate_launch_description():
    return LaunchDescription([OpaqueFunction(function=start)])
