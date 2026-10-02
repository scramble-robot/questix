#!/usr/bin/env python3
"""Save registered, rectified RGB-D pairs for QUESTiX LAB; no motor commands."""
import argparse
import json
import math
import time
from pathlib import Path


def make_record(rgb, depth, info, rgb_time, depth_time, depth_scale=0.001):
    """Pure conversion; dependencies stay inside main for unit testing."""
    import numpy as np
    h, w = depth.shape
    if rgb.shape != (h, w, 3) or info.width != w or info.height != h:
        raise ValueError('RGB, registered depth and CameraInfo sizes must agree')
    if abs(rgb_time - depth_time) > 0.05:
        raise ValueError('Image timestamps differ by more than 50 ms')
    # CameraInfo may retain the original D even for rectified images.
    # P describes the rectified projection; --aligned confirms the input contract.
    fx, fy, cx, cy = (info.p[0], info.p[5], info.p[2], info.p[6])
    if not all(math.isfinite(v) for v in [fx, fy, cx, cy]) or fx <= 0 or fy <= 0:
        raise ValueError('Valid rectified projection parameters P are required')
    step = max(1, math.ceil(w / 640), math.ceil(h / 480))
    small_rgb, small_depth = rgb[::step, ::step], depth[::step, ::step]
    if small_depth.dtype == np.uint16:
        metres = small_depth.astype(float) * depth_scale
    elif small_depth.dtype in [np.dtype('float32'), np.dtype('float64')]:
        metres = small_depth.astype(float)
    else:
        raise ValueError('Use 16UC1 or 32FC1 depth')
    values = [round(float(z), 5) if math.isfinite(z) and 0 < z <= 100 else None
              for z in metres.ravel()]
    return dict(format='robo-lab-rgbd-v1', width=small_rgb.shape[1], height=small_rgb.shape[0],
                aligned=True, depth_unit='m', rgb_time=rgb_time, depth_time=depth_time,
                intrinsics=dict(fx=fx / step, fy=fy / step, cx=cx / step, cy=cy / step),
                rgb=small_rgb.reshape(-1).tolist(), depth=values)


def main():
    import rclpy
    from rclpy.node import Node
    from rclpy.qos import qos_profile_sensor_data
    from sensor_msgs.msg import Image, CameraInfo
    from cv_bridge import CvBridge
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rgb', required=True, help='Rectified RGB Image topic')
    parser.add_argument('--depth', required=True, help='Depth registered to that RGB image')
    parser.add_argument('--info', required=True, help='Rectified RGB CameraInfo topic')
    parser.add_argument('--aligned', action='store_true', help='Confirm driver registration is enabled')
    parser.add_argument('--depth-scale', type=float, default=.001, help='Metres per 16UC1 unit; check driver')
    parser.add_argument('--output', default='rgbd-images')
    parser.add_argument('--count', type=int, default=5)
    args, ros_args = parser.parse_known_args()
    if not args.aligned or not 1 <= args.count <= 100 or not 0 < args.depth_scale <= 1:
        parser.error('Enable registration/rectification, pass --aligned; count 1..100; depth scale in (0,1]')
    out = Path(args.output).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    rclpy.init(args=ros_args)
    node, bridge = Node('robo_lab_rgbd_capture'), CvBridge()
    state = dict(rgb=[], depth=[], info=None, count=0, last=-math.inf)
    stamp = lambda msg: msg.header.stamp.sec + msg.header.stamp.nanosec * 1e-9

    def receive_info(message):
        state['info'] = message

    def receive(kind, message):
        state[kind].append(message)
        state[kind] = state[kind][-8:]
        if state['info'] is None or not state['rgb'] or not state['depth'] or time.monotonic()-state['last'] < 2:
            return
        rgb, depth = min(((r, d) for r in state['rgb'] for d in state['depth']), key=lambda pair: abs(stamp(pair[0])-stamp(pair[1])))
        if abs(stamp(rgb)-stamp(depth)) > .05:
            return
        try:
            info = state['info']
            if not rgb.header.frame_id or len({rgb.header.frame_id, depth.header.frame_id, info.header.frame_id}) != 1:
                raise ValueError('Registered RGB, depth and CameraInfo must use the same optical frame')
            if depth.encoding not in ('16UC1', '32FC1'):
                raise ValueError('Unsupported depth encoding: ' + depth.encoding)
            data = make_record(bridge.imgmsg_to_cv2(rgb, 'rgb8'), bridge.imgmsg_to_cv2(depth, 'passthrough'), info, stamp(rgb), stamp(depth), args.depth_scale)
            data['optical_frame'] = rgb.header.frame_id
            filename = out / ('rgbd_%d.json' % time.time_ns())
            with filename.open('x', encoding='utf-8') as file:
                json.dump(data, file, allow_nan=False, separators=(',', ':'))
            state['count'] += 1
            node.get_logger().info('Saved ' + str(filename))
        except Exception as error:
            node.get_logger().error(str(error))
        state['rgb'].clear()
        state['depth'].clear()
        state['last'] = time.monotonic()

    subscriptions = [node.create_subscription(Image, args.rgb, lambda msg: receive('rgb', msg), qos_profile_sensor_data),  # noqa: F841 (held so the subscription stays alive)
                     node.create_subscription(Image, args.depth, lambda msg: receive('depth', msg), qos_profile_sensor_data),
                     node.create_subscription(CameraInfo, args.info, receive_info, qos_profile_sensor_data)]
    node.get_logger().info('Waiting for matched RGB-D pairs; keep the robot and target still')
    try:
        while rclpy.ok() and state['count'] < args.count:
            rclpy.spin_once(node, timeout_sec=.2)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
