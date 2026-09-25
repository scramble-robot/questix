"""Convert ROS messages into the JSON payloads of the QUESTiX LAB live protocol.

Protocol version 1. Units follow REP-103: metres, radians, seconds; x forward, y left,
theta counter-clockwise. Every function here is pure and duck-typed so it can be tested
without a ROS installation.

Server to browser, text frames are JSON objects tagged by ``type``:

* ``hello``  - protocol version, ``read_only``, ``robot`` (``name``: the robot_name parameter
  or the host name; ``domain``: ROS_DOMAIN_ID as an int, ``null`` when unset), robot
  geometry, the topic behind each stream, and ``records`` (``save``: pages may save
  recordings on the robot; ``list``: ``GET /api/records`` answers; ``rosbags``: ``GET
  /api/rosbags`` can convert Robot Manager's rosbags).
* ``session`` - the id this connection has on the bridge (``drive_state.owner`` uses it).
* ``drive_state`` - whether a page may drive the robot now and why not, who drives it,
  the limits, and why the last run ended (drive.DriveArbiter.state). A page whose request
  was refused gets one more, to itself only, with ``refused`` set to the reason.
* ``scan``   - ``angle_min``, ``angle_increment``, ``range_max``, ``ranges``
  (unmeasured beams are ``null``), and ``mount`` - the scan frame's pose ``x``, ``y``
  [m], ``yaw`` [rad] in the robot's base frame, from TF (``null`` until TF knows it).
* ``odom``   - ``x``, ``y``, ``theta``, ``v``, ``w``.
* ``drive``  - measured/target wheel RPM, current, chassis velocity, emergency stop.
* ``twist``  - commanded ``linear`` / ``angular`` velocity.
* ``status`` - message rate per stream over the last reporting interval.
* ``record_saved`` (``id``) / ``record_error`` (``message``, Japanese) - the answer to this
  page's own ``record_save``, to that page only.

Binary frames carry one compressed camera image (JPEG or PNG bytes, unmodified).

Browser to server, always accepted:

* ``{"type": "record_save", "recording": {...}}`` - keep a questix-lab-recording on the robot
  (records.py; up to 8 MiB). The bridge checks format, version and geometry, makes the id
  itself and answers ``record_saved`` or ``record_error``.

Browser to server (only when the bridge runs with ``allow_drive``; otherwise ignored):

* ``{"type": "drive", "linear": v, "angular": w}`` - drive at v [m/s], w [rad/s]. Also the
  heartbeat: the owner repeats it, and silence stops the robot (drive.py).
* ``{"type": "stop"}`` - stop the robot, whichever page drives it (the stop bar).
* ``{"type": "stop", "scope": "mine"}`` - stop the run only if this page owns it; a page
  ending its own experiment sends this so it cannot end another pupil's run. Any other
  ``scope`` value is treated as a plain stop.

Plain HTTP ``GET /api/state`` on the same port returns ``state_payload`` as JSON (see
ws_server.py), for robot_manager and for anyone checking the bridge without a WebSocket.
``GET /api/records*`` and ``GET /api/rosbags*`` serve the records (records_api.py).

scripts/robot_manager/static/lab/js/live/rosbag-core.js ports the scan/odom/drive/twist
conversions below so the lab can read a rosbag into the same payloads; change both together.
"""

import json
import math
import os
import socket

PROTOCOL_VERSION = 1


def stamp_seconds(stamp):
    """Return a builtin_interfaces/Time as float seconds."""
    return stamp.sec + stamp.nanosec * 1e-9


def yaw_from_quaternion(q):
    """Return the rotation about +z [rad] of a geometry_msgs/Quaternion."""
    return math.atan2(2.0 * (q.w * q.z + q.x * q.y), 1.0 - 2.0 * (q.y * q.y + q.z * q.z))


def _finite(value, digits):
    return round(value, digits) if math.isfinite(value) else None


def robot_identity(name='', environ=None):
    """Return ``{name, domain}``: which robot this bridge runs on, for pages and teachers.

    ``name`` falls back to the host name. ``domain`` is ROS_DOMAIN_ID as an int, or None when
    it is unset or not a number (ROS then uses domain 0).
    """
    environ = os.environ if environ is None else environ
    try:
        domain = int(environ.get('ROS_DOMAIN_ID', '').strip())
    except ValueError:
        domain = None
    return {'name': name or socket.gethostname(), 'domain': domain}


def hello_payload(streams, wheel_radius, wheel_separation, drive_allowed=False, robot=None,
                  records=None):
    """Describe the bridge to a newly connected browser; ``robot`` is robot_identity().

    ``records`` is records_api.RecordsApi.hello(); without it pages may neither save nor list.
    """
    return {
        'type': 'hello',
        'protocol': PROTOCOL_VERSION,
        'read_only': not drive_allowed,
        'robot': robot if robot is not None else robot_identity(),
        'config': {'wheel_radius': wheel_radius, 'wheel_separation': wheel_separation},
        'streams': streams,
        'records': records if records is not None else {
            'save': False, 'list': False, 'rosbags': False},
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


def session_payload(client_id):
    """Tell one browser its id on this bridge."""
    return {'type': 'session', 'id': client_id}


def drive_state_payload(state):
    """Wrap drive.DriveArbiter.state() for the browsers."""
    return {'type': 'drive_state', **state}


def state_payload(drive_state, robot, rates, drive_allowed, clients, max_clients,
                  records=None):
    """Body of ``GET /api/state``: the bridge as robot_manager and teachers need to see it.

    ``drive_state`` is DriveArbiter.state(), ``rates`` the last status report [Hz],
    ``records`` records_api.RecordsApi.summary() (``dir``, ``count``, ``used_bytes``,
    ``limit_bytes``, ``save``, ``auto_record``, ``rosbag_dir``) or None.
    """
    return {
        'protocol': PROTOCOL_VERSION,
        'read_only': not drive_allowed,
        'robot': robot,
        'clients': clients,
        'max_clients': max_clients,
        'drive_state': drive_state,
        'rates': {name: round(hz, 1) for name, hz in rates.items()},
        'records': records,
    }


def parse_request(text):
    """Decode a browser frame into ``('drive', linear, angular)``, ``('stop', scope)`` or None.

    ``scope`` is ``'mine'`` (stop only a run this page owns) or ``'any'`` (stop any run; also
    for a missing or unknown scope, so a malformed stop still stops).

    Anything else (binary frames, other types, broken JSON) is None and ignored. Values are
    passed on unchecked; DriveArbiter.request refuses what is not a finite number.
    """
    if not isinstance(text, str):
        return None
    try:
        message = json.loads(text)
    except ValueError:
        return None
    if not isinstance(message, dict):
        return None
    if message.get('type') == 'stop':
        return ('stop', 'mine' if message.get('scope') == 'mine' else 'any')
    if message.get('type') == 'drive':
        return ('drive', message.get('linear'), message.get('angular'))
    return None


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
