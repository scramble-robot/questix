"""Write test/fixtures/drive-approach.mcap, the rosbag the browser-side bag reader is tested with.

The bag is written by rosbag2 itself (the MCAP storage plugin robot_manager records with), so the
Node test checks the reader against real rosbag2 output rather than against a hand-made file.
Next to it, drive-approach.expected.json lists the values the reader must recover.

Needs ROS 2 Jazzy and a built questix_msgs, for example:

    source /opt/ros/jazzy/setup.bash
    colcon build --packages-select questix_msgs --base-paths questix_msgs \
        --build-base /tmp/qx/build --install-base /tmp/qx/install
    source /tmp/qx/install/setup.bash
    python3 scripts/robot_manager/static/lab/test/fixtures/make-rosbag-fixture.py

The scene: the LiDAR, mounted 0.2 m ahead of base_link as on QUESTiX (/tf_static), stands 1.50 m
from a wall for 1 s; the robot is then commanded 0.2 m/s straight ahead for 2.5 s and stops.
Wheel feedback, odometry and the LiDAR follow the command without lag, which is all the reader
needs; the physics is the lessons' business.
"""

import json
import math
from pathlib import Path
import shutil
import tempfile

from builtin_interfaces.msg import Time
from geometry_msgs.msg import TransformStamped, Twist
from nav_msgs.msg import Odometry
from questix_msgs.msg import DriveStatus
from rclpy.serialization import serialize_message
import rosbag2_py
from sensor_msgs.msg import LaserScan
from std_msgs.msg import String
from tf2_msgs.msg import TFMessage

HERE = Path(__file__).resolve().parent
START_NS = 1_758_000_000 * 10**9  # an epoch time, so 64-bit timestamps are exercised
PERIOD = 0.05  # s: drive, twist and odom at 20 Hz
SCAN_EVERY = 4  # one scan per 4 periods: 5 Hz
DURATION = 4.0  # s
MOVE_FROM = 1.0  # s
MOVE_TO = 3.5  # s
SPEED = 0.2  # m/s
WALL = 1.5  # m from the LiDAR to the wall at the start
WHEEL_RADIUS = 0.1  # m, launcher/config/drive_component.yaml
BEAMS = 400  # more than the bridge's 360, so the reader has to decimate like the bridge does
LIDAR_X = 0.2  # m ahead of base_link, launcher/launch/lidar_driver.launch.xml


def stamp(seconds):
    ns = START_NS + round(seconds * 1e9)
    return Time(sec=ns // 10**9, nanosec=ns % 10**9)


def speed_at(seconds):
    return SPEED if MOVE_FROM <= seconds < MOVE_TO else 0.0


def travelled(seconds):
    return SPEED * max(0.0, min(seconds, MOVE_TO) - MOVE_FROM)


def drive_status(seconds):
    msg = DriveStatus()
    msg.header.stamp = stamp(seconds)
    rpm = round(speed_at(seconds) / (2 * math.pi * WHEEL_RADIUS) * 60)
    msg.left.velocity_rpm = rpm
    msg.left.velocity_rpm_raw = rpm
    msg.left.target_rpm = rpm
    msg.left.current_amp = 0.25
    msg.right.velocity_rpm = -rpm  # the right motor is mirrored on the wire
    msg.right.velocity_rpm_raw = -rpm
    msg.right.target_rpm = -rpm
    msg.right.current_amp = 0.25
    msg.linear_velocity = speed_at(seconds)
    msg.angular_velocity = 0.0
    msg.emergency_stop = False
    return msg


def odometry(seconds):
    msg = Odometry()
    msg.header.stamp = stamp(seconds)
    msg.header.frame_id = 'odom'
    msg.child_frame_id = 'base_link'
    msg.pose.pose.position.x = travelled(seconds)
    msg.pose.pose.orientation.w = 1.0
    msg.twist.twist.linear.x = speed_at(seconds)
    return msg


def scan(seconds):
    msg = LaserScan()
    msg.header.stamp = stamp(seconds)
    msg.header.frame_id = 'laser_frame'
    msg.angle_min = -math.pi
    msg.angle_max = math.pi
    msg.angle_increment = 2 * math.pi / BEAMS
    msg.range_min = 0.05
    msg.range_max = 12.0
    wall = WALL - travelled(seconds)
    ranges = []
    for index in range(BEAMS):
        angle = msg.angle_min + index * msg.angle_increment
        # A flat wall ahead; nothing measured behind the robot (inf, as the driver reports it).
        ranges.append(wall / math.cos(angle) if abs(angle) < 1.2 else math.inf)
    msg.ranges = ranges
    return msg


def static_tf():
    mount = TransformStamped()
    mount.header.stamp = stamp(0.0)
    mount.header.frame_id = 'base_link'
    mount.child_frame_id = 'laser_frame'
    mount.transform.translation.x = LIDAR_X
    mount.transform.translation.z = 0.02
    mount.transform.rotation.w = 1.0
    return TFMessage(transforms=[mount])


def main():
    work = Path(tempfile.mkdtemp())
    uri = work / 'bag'
    writer = rosbag2_py.SequentialWriter()
    writer.open(
        rosbag2_py.StorageOptions(uri=str(uri), storage_id='mcap'),
        rosbag2_py.ConverterOptions('', ''),
    )
    topics = [
        ('/drive_status', 'questix_msgs/msg/DriveStatus'),
        ('/target_twist', 'geometry_msgs/msg/Twist'),
        ('/cmd_vel', 'geometry_msgs/msg/Twist'),  # another Twist: must not be taken as the command
        ('/odom', 'nav_msgs/msg/Odometry'),
        ('/scan', 'sensor_msgs/msg/LaserScan'),
        ('/chatter', 'std_msgs/msg/String'),  # a type the reader does not use
        ('/tf_static', 'tf2_msgs/msg/TFMessage'),
    ]
    for index, (name, kind) in enumerate(topics):
        writer.create_topic(rosbag2_py.TopicMetadata(index, name, kind, 'cdr'))

    steps = round(DURATION / PERIOD)
    for step in range(steps):
        seconds = step * PERIOD
        log_ns = START_NS + round(seconds * 1e9)
        command = Twist()
        command.linear.x = speed_at(seconds)
        writer.write('/target_twist', serialize_message(command), log_ns)
        writer.write('/cmd_vel', serialize_message(Twist()), log_ns)
        writer.write('/drive_status', serialize_message(drive_status(seconds)), log_ns + 1000)
        writer.write('/odom', serialize_message(odometry(seconds)), log_ns + 2000)
        if step % SCAN_EVERY == 0:
            writer.write('/scan', serialize_message(scan(seconds)), log_ns + 3000)
        if step == 0:
            writer.write('/chatter', serialize_message(String(data='hello')), log_ns)
            writer.write('/tf_static', serialize_message(static_tf()), log_ns)
    del writer

    bag = next(uri.glob('*.mcap'))
    shutil.copy(bag, HERE / 'drive-approach.mcap')
    shutil.rmtree(work)

    expected = {
        'start': START_NS / 1e9,
        'counts': {'drive': steps, 'twist': steps, 'odom': steps, 'scan': steps // SCAN_EVERY},
        'moveFrom': MOVE_FROM,
        'moveTo': MOVE_TO,
        'speed': SPEED,
        'wall': WALL,
        'travelled': travelled(DURATION),
        'beams': BEAMS,
        'rpm': round(SPEED / (2 * math.pi * WHEEL_RADIUS) * 60),
        'mount': {'x': LIDAR_X, 'y': 0.0, 'yaw': 0.0},
    }
    (HERE / 'drive-approach.expected.json').write_text(json.dumps(expected, indent=2) + '\n')


if __name__ == '__main__':
    main()
