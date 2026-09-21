#!/usr/bin/env python3
"""Read-only ROS 2 sensor recorder for QUESTiX LAB. Never publishes motor commands."""
import json
import math
from collections import deque
from pathlib import Path
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import JointState, Imu, LaserScan


def stamp(msg):
    return msg.header.stamp.sec + msg.header.stamp.nanosec * 1e-9


def interval_average(samples, start, end, max_age=0.25):
    """Time-weighted zero-order-hold average; reject missing/stale intervals."""
    before = [s for s in samples if s[0] <= start]
    if not before or end <= start or start - before[-1][0] > max_age:
        return None
    current = before[-1]
    now = start
    total = [0.0] * len(current[1])
    for sample in [s for s in samples if start < s[0] < end] + [(end, None)]:
        if sample[0] - current[0] > max_age:
            return None
        for j, value in enumerate(current[1]):
            total[j] += value * (sample[0] - now)
        now = sample[0]
        current = sample
    return [v / (end - start) for v in total]


class Recorder(Node):
    def __init__(self):
        super().__init__('robo_lab_record')
        defaults = {'joint_topic': '/joint_states', 'imu_topic': '/imu/data', 'scan_topic': '/scan',
                    'left_joint': 'left_wheel_joint', 'right_joint': 'right_wheel_joint',
                    'left_sign': 1.0, 'right_sign': 1.0, 'radius': 0.065, 'track': 0.32,
                    'range_max': 3.2, 'lidar_x': 0.0, 'lidar_y': 0.0, 'lidar_yaw': 0.0,
                    'imu_frame': 'base_link', 'stationary_seconds': 2.0,
                    'output': 'robo-lab-log.json', 'max_frames': 1000}
        self.p = {k: self.declare_parameter(k, v).value for k, v in defaults.items()}
        self.wheels, self.imus = deque(maxlen=3000), deque(maxlen=6000)
        self.frames, self.pending = [], deque(maxlen=50)
        self.origin = self.previous = None
        self.last_imu = None
        self.warned = set()
        self.subs = [self.create_subscription(JointState, self.p['joint_topic'], self.joints, qos_profile_sensor_data),
                     self.create_subscription(Imu, self.p['imu_topic'], self.imu, qos_profile_sensor_data),
                     self.create_subscription(LaserScan, self.p['scan_topic'], self.scan, qos_profile_sensor_data)]
        self.timer = self.create_timer(0.1, self.drain)
        self.get_logger().info('Read-only recording. Keep still for 2 seconds, then drive slowly. Ctrl+C saves JSON.')

    def warn_once(self, key, message):
        if key not in self.warned:
            self.warned.add(key)
            self.get_logger().warning(message)

    def joints(self, msg):
        try:
            left = msg.velocity[msg.name.index(self.p['left_joint'])] * self.p['left_sign']
            right = msg.velocity[msg.name.index(self.p['right_joint'])] * self.p['right_sign']
        except (ValueError, IndexError):
            self.warn_once('joint', 'Wheel names or rad/s velocities missing in JointState. Check parameters.')
            return
        if all(math.isfinite(x) for x in (left, right)) and (not self.wheels or stamp(msg) > self.wheels[-1][0]):
            self.wheels.append((stamp(msg), [left, right]))

    def imu(self, msg):
        if msg.header.frame_id != self.p['imu_frame']:
            self.warn_once('frame', 'IMU frame differs from imu_frame. Transform angular velocity/acceleration into base axes first.')
            return
        # Input must already be aligned with base_link: x forward, y left, z up.
        if math.isfinite(msg.angular_velocity.z) and (not self.imus or stamp(msg) > self.imus[-1][0]):
            self.imus.append((stamp(msg), [msg.angular_velocity.z]))
            self.last_imu = msg

    def scan(self, msg):
        if msg.angle_increment <= 0:
            self.warn_once('angles', 'LaserScan angle_increment must be positive; normalize scan ordering in the driver.')
            return
        self.pending.append(msg)

    def drain(self):
        while self.pending and self.imus and self.wheels and len(self.frames) < self.p['max_frames']:
            msg = self.pending[0]
            t = stamp(msg)
            if t > min(self.imus[-1][0], self.wheels[-1][0]):
                return  # Wait for measurements spanning this scan timestamp.
            self.pending.popleft()
            if self.previous is None:
                self.previous = t
                continue
            if t <= self.previous:
                self.warn_once('time', 'Non-increasing timestamps. Use one clock and restart after clock resets.')
                continue
            # Limit scan processing to 5 Hz; wheel/gyro samples are averaged over the interval.
            if t - self.previous < 0.19:
                continue
            wheels = interval_average(self.wheels, self.previous, t)
            gyro = interval_average(self.imus, self.previous, t)
            if wheels is None or gyro is None or t - self.previous > 2:
                self.warn_once('gap', 'Missing/stale sensor samples: stopped to avoid integrating across a gap. Save and restart recording.')
                self.pending.clear()
                self.timer.cancel()
                return
            if self.origin is None:
                self.origin = self.previous
            self.previous = t
            stride = max(1, math.ceil(len(msg.ranges) / 180))
            maximum = min(float(msg.range_max), self.p['range_max'])
            ranges = [float(v) if math.isfinite(v) and max(.03, msg.range_min) <= v < maximum else None for v in msg.ranges[::stride]]
            if len(ranges) < 12:
                self.warn_once('scan', 'Need at least 12 scan samples.')
                continue
            frame = {'t': t - self.origin, 'leftRpm': wheels[0] * 60 / (2 * math.pi),
                     'rightRpm': wheels[1] * 60 / (2 * math.pi), 'gyroZ': gyro[0],
                     'angleMin': float(msg.angle_min), 'angleIncrement': float(msg.angle_increment) * stride,
                     'ranges': ranges}
            self.frames.append(frame)
            if len(self.frames) % 100 == 0:
                self.get_logger().info(f'{len(self.frames)} frames recorded')

    def save(self):
        data = {'format': 'robo-lab-sensors-v1', 'source': 'ros2',
                'stationarySeconds': self.p['stationary_seconds'],
                'config': {'radius': self.p['radius'], 'track': self.p['track'], 'rangeMax': self.p['range_max'],
                           'lidar': {'x': self.p['lidar_x'], 'y': self.p['lidar_y'], 'yaw': self.p['lidar_yaw']}},
                'frames': self.frames}
        # Exclusive creation avoids replacing a previous experiment by accident.
        target = Path(self.p['output'])
        with target.open('x', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, allow_nan=False)
        print(f'Saved {len(self.frames)} frames: {target.resolve()}')


def main():
    rclpy.init()
    node = Recorder()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            node.save()
        finally:
            node.destroy_node()
            if rclpy.ok():
                rclpy.shutdown()


if __name__ == '__main__':
    main()
