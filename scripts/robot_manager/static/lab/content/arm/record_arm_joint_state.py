#!/usr/bin/env python3
"""Save one complete SO-ARM101 JointState. Read only; no motor commands."""
from pathlib import Path
from json import dump
from rclpy import init, ok, spin_once, shutdown
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import JointState

NAMES = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll']

def main():
    init()
    node = Node('questix_record_arm')
    node.declare_parameter('topic', '/joint_states')
    done = False
    def receive(msg):
        nonlocal done
        if done or len(msg.name) != len(msg.position):
            return
        if any(msg.name.count(name) != 1 for name in NAMES):
            return
        data = {'name': NAMES, 'position': [msg.position[msg.name.index(n)] for n in NAMES]}
        data['stamp'] = {'sec': msg.header.stamp.sec, 'nanosec': msg.header.stamp.nanosec}
        path = Path('arm-joint-state.json')
        try:
            with path.open('x', encoding='utf-8') as stream:
                dump(data, stream, indent=2, allow_nan=False)
            node.get_logger().info('Saved ' + str(path.resolve()))
        except (OSError, ValueError) as error:
            node.get_logger().error(str(error) + '; existing files are not overwritten')
        done = True
    sub = node.create_subscription(JointState, node.get_parameter('topic').value, receive, qos_profile_sensor_data)  # noqa: F841 (held so the subscription stays alive)
    try:
        while ok() and not done:
            spin_once(node, timeout_sec=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        shutdown()

if __name__ == '__main__':
    main()
