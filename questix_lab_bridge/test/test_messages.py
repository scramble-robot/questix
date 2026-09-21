import json
import math
from types import SimpleNamespace as NS

import pytest
from questix_lab_bridge import messages


def _stamp(sec=12, nanosec=500000000):
    return NS(sec=sec, nanosec=nanosec)


def _scan(ranges, range_min=0.1, range_max=8.0):
    return NS(header=NS(stamp=_stamp(), frame_id='laser'), angle_min=-math.pi,
              angle_increment=2 * math.pi / len(ranges), range_min=range_min,
              range_max=range_max, ranges=ranges)


def test_scan_marks_unmeasured_beams_as_null():
    payload = messages.scan_payload(_scan([1.0, float('inf'), float('nan'), 0.01, 9.0, 2.5] * 2))
    assert payload['ranges'] == [1.0, None, None, None, None, 2.5] * 2
    assert payload['stamp'] == pytest.approx(12.5)
    json.loads(messages.encode(payload))


def test_scan_decimation_keeps_uniform_increment():
    msg = _scan([float(i % 7 + 1) for i in range(720)])
    payload = messages.scan_payload(msg, max_points=360)
    assert len(payload['ranges']) == 360
    assert payload['angle_increment'] == pytest.approx(msg.angle_increment * 2)
    assert payload['ranges'][1] == msg.ranges[2]


def test_yaw_from_quaternion():
    half = math.pi / 4
    q = NS(x=0.0, y=0.0, z=math.sin(half), w=math.cos(half))
    assert messages.yaw_from_quaternion(q) == pytest.approx(math.pi / 2)


def test_odom_payload_is_planar():
    msg = NS(header=NS(stamp=_stamp()),
             pose=NS(pose=NS(position=NS(x=1.23456, y=-0.5, z=0.0),
                             orientation=NS(x=0.0, y=0.0, z=0.0, w=1.0))),
             twist=NS(twist=NS(linear=NS(x=0.2), angular=NS(z=-0.1))))
    payload = messages.odom_payload(msg)
    assert (payload['x'], payload['y'], payload['theta']) == (1.2346, -0.5, 0.0)
    assert (payload['v'], payload['w']) == (0.2, -0.1)


def test_drive_payload_and_nan_is_null():
    wheel = NS(velocity_rpm=8, velocity_rpm_raw=9, target_rpm=10, current_amp=0.1234,
               fault_code=0)
    msg = NS(header=NS(stamp=_stamp()), left=wheel, right=wheel,
             linear_velocity=float('nan'), angular_velocity=0.0, emergency_stop=1)
    payload = messages.drive_payload(msg)
    assert payload['left'] == {'rpm': 8, 'rpm_raw': 9, 'target_rpm': 10,
                               'current_amp': 0.123, 'fault_code': 0}
    assert payload['v'] is None and payload['emergency_stop'] is True
    json.loads(messages.encode(payload))


def test_image_kind():
    assert messages.image_kind(b'\xff\xd8\xff\xe0rest') == 'jpeg'
    assert messages.image_kind(b'\x89PNG\r\n\x1a\nrest') == 'png'
    assert messages.image_kind(b'RIFFxxxxWEBP') is None
    assert messages.image_kind(b'') is None


def test_rate_limiter_latest_wins():
    limiter = messages.RateLimiter(10.0)
    assert limiter.ready(0.0)
    assert not limiter.ready(0.05)
    assert limiter.ready(0.11)
    assert all(messages.RateLimiter(0.0).ready(t) for t in (0.0, 0.0, 0.001))


def test_hello_declares_read_only():
    payload = messages.hello_payload({'scan': '/scan', 'camera': None}, 0.1, 0.5)
    assert payload['protocol'] == messages.PROTOCOL_VERSION and payload['read_only'] is True
