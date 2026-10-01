#!/usr/bin/env python3
"""Save camera images for QUESTiX LAB. Subscribes only; sends no motion commands."""
import argparse
from pathlib import Path
import time
import cv2
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Image
from cv_bridge import CvBridge

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--topic', default='/camera/image_raw')
    parser.add_argument('--output', default='robo-lab-images')
    parser.add_argument('--interval', type=float, default=2.0)
    parser.add_argument('--count', type=int, default=10)
    args, ros_args = parser.parse_known_args()
    if args.interval < 0.2 or not 1 <= args.count <= 200:
        parser.error('Use interval >= 0.2 and count between 1 and 200')
    out = Path(args.output).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    rclpy.init(args=ros_args)
    node = Node('robo_lab_camera_capture')
    bridge = CvBridge()
    state = {'last': -float('inf'), 'count': 0, 'done': False}

    def receive(message):
        now = time.monotonic()
        if state['done'] or now - state['last'] < args.interval:
            return
        try:
            frame = bridge.imgmsg_to_cv2(message, desired_encoding='bgr8')
            stamp = message.header.stamp
            filename = out / ('frame_%d_%09d_%03d.png' % (stamp.sec, stamp.nanosec, state['count']))
            if filename.exists():
                filename = out / ('frame_%d_%03d.png' % (time.time_ns(), state['count']))
            if not cv2.imwrite(str(filename), frame):
                raise RuntimeError('Could not write image')
            state['last'] = now
            state['count'] += 1
            node.get_logger().info('Saved ' + str(filename))
            state['done'] = state['count'] >= args.count
        except Exception as error:
            node.get_logger().error(str(error))

    sub = node.create_subscription(Image, args.topic, receive, qos_profile_sensor_data)  # noqa: F841 (held so the subscription stays alive)
    node.get_logger().info('Waiting for ' + args.topic + '; Ctrl+C to stop')
    try:
        while rclpy.ok() and not state['done']:
            rclpy.spin_once(node, timeout_sec=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()

if __name__ == '__main__':
    main()
