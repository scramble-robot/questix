"""Convert ROS messages into the JSON payloads of the QUESTiX LAB live protocol.

Protocol version 1, server to browser only. Units follow REP-103: metres, radians,
seconds; x forward, y left, theta counter-clockwise. Every function here is pure and
duck-typed so it can be tested without a ROS installation.

Text frames are JSON objects tagged by ``type``:

* ``hello``  - protocol version, robot geometry, and the topic behind each stream.
* ``scan``   - ``angle_min``, ``angle_increment``, ``range_max``, ``ranges``
  (unmeasured beams are ``null``), and ``mount`` - the scan frame's pose ``x``, ``y``
  [m], ``yaw`` [rad] in the robot's base frame, from TF (``null`` until TF knows it).
* ``odom``   - ``x``, ``y``, ``theta``, ``v``, ``w``.
* ``drive``  - measured/target wheel RPM, current, chassis velocity, emergency stop.
* ``twist``  - commanded ``linear`` / ``angular`` velocity.
* ``status`` - message rate per stream over the last reporting interval.

Binary frames carry one compressed camera image (JPEG or PNG bytes, unmodified).

scripts/robot_manager/static/lab/js/live/rosbag-core.js ports the scan/odom/drive/twist
conversions below so the lab can read a rosbag into the same payloads; change both together.
"""

import json
import math

PROTOCOL_VERSION = 1


def stamp_seconds(stamp):
    """Return a builtin_interfaces/Time as float seconds."""
    return stamp.sec + stamp.nanosec * 1e-9


def yaw_from_quaternion(q):
    """Return the rotation about +z [rad] of a geometry_msgs/Quaternion."""
    return math.atan2(2.0 * (q.w * q.z + q.x * q.y), 1.0 - 2.0 * (q.y * q.y + q.z * q.z))


def _finite(value, digits):
    return round(value, digits) if math.isfinite(value) else None


def hello_payload(streams, wheel_radius, wheel_separation):
    """Describe the bridge to a newly connected browser."""
    return {
        'type': 'hello',
        'protocol': PROTOCOL_VERSION,
        'read_only': True,
        'config': {'wheel_radius': wheel_radius, 'wheel_separation': wheel_separation},
        'streams': streams,
    }


def mount_from_transform(transform):
    """Planar pose of a geometry_msgs/Transform: ``{x, y, yaw}`` in metres and radians."""
    return {
        'x': round(transform.translation.x, 4),
        'y': round(transform.translation.y, 4),
        'yaw': round(yaw_from_quaternion(transform.rotation), 4),
    }


def scan_payload(msg, max_points=360, mount=None):
    """Convert sensor_msgs/LaserScan, keeping at most ``max_points`` beams.

    Beams are decimated by an integer stride so ``angle_increment`` stays uniform.
    Non-finite or out-of-range readings become ``None`` (JSON ``null``): an
    unmeasured beam must not be mistaken for free space or for an obstacle.
    ``mount`` is where the scan frame sits on the robot (``mount_from_transform``);
    the lab places the points with it instead of assuming the LiDAR at the centre.
    """
    count = len(msg.ranges)
    stride = max(1, math.ceil(count / max(1, max_points)))
    ranges = []
    for index in range(0, count, stride):
        value = msg.ranges[index]
        valid = math.isfinite(value) and msg.range_min <= value <= msg.range_max
        ranges.append(round(value, 3) if valid else None)
    return {
        'type': 'scan',
        'stamp': stamp_seconds(msg.header.stamp),
        'frame': msg.header.frame_id,
        'angle_min': msg.angle_min,
        'angle_increment': msg.angle_increment * stride,
        'range_min': msg.range_min,
        'range_max': msg.range_max,
        'ranges': ranges,
        'mount': mount,
    }


def odom_payload(msg):
    """Convert nav_msgs/Odometry to a planar pose and body velocity."""
    pose = msg.pose.pose
    twist = msg.twist.twist
    return {
        'type': 'odom',
        'stamp': stamp_seconds(msg.header.stamp),
        'x': _finite(pose.position.x, 4),
        'y': _finite(pose.position.y, 4),
        'theta': _finite(yaw_from_quaternion(pose.orientation), 4),
        'v': _finite(twist.linear.x, 4),
        'w': _finite(twist.angular.z, 4),
    }


def _wheel(feedback):
    return {
        'rpm': feedback.velocity_rpm,
        'rpm_raw': feedback.velocity_rpm_raw,
        'target_rpm': feedback.target_rpm,
        'current_amp': _finite(feedback.current_amp, 3),
        'fault_code': feedback.fault_code,
    }


def drive_payload(msg):
    """Convert questix_msgs/DriveStatus (measured wheel feedback)."""
    return {
        'type': 'drive',
        'stamp': stamp_seconds(msg.header.stamp),
        'left': _wheel(msg.left),
        'right': _wheel(msg.right),
        'v': _finite(msg.linear_velocity, 4),
        'w': _finite(msg.angular_velocity, 4),
        'emergency_stop': bool(msg.emergency_stop),
    }


def twist_payload(msg, stamp):
    """Convert geometry_msgs/Twist; ``stamp`` is the receipt time [s] (Twist has none)."""
    return {
        'type': 'twist',
        'stamp': stamp,
        'linear': _finite(msg.linear.x, 4),
        'angular': _finite(msg.angular.z, 4),
    }


def status_payload(rates):
    """Report the received message rate [Hz] per stream."""
    return {'type': 'status', 'rates': {name: round(hz, 1) for name, hz in rates.items()}}


def image_kind(data):
    """Return 'jpeg' or 'png' from the magic bytes, else None (frame is not relayed)."""
    head = bytes(data[:8])
    if head[:3] == b'\xff\xd8\xff':
        return 'jpeg'
    if head == b'\x89PNG\r\n\x1a\n':
        return 'png'
    return None


def encode(payload):
    """Serialize a payload compactly; NaN/Infinity are rejected rather than emitted."""
    return json.dumps(payload, separators=(',', ':'), allow_nan=False)


class RateLimiter:
    """Latest-wins throttle: ``ready(now)`` is true at most ``max_hz`` times a second."""

    def __init__(self, max_hz):
        self._period = 1.0 / max_hz if max_hz > 0 else 0.0
        self._last = None

    def ready(self, now):
        if self._last is not None and now - self._last < self._period:
            return False
        self._last = now
        return True
