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


def test_mount_from_transform_is_planar():
    transform = NS(
        translation=NS(x=0.2, y=-0.01, z=0.02),
        rotation=NS(x=0.0, y=0.0, z=math.sin(0.25), w=math.cos(0.25)),
    )
    assert messages.mount_from_transform(transform) == {'x': 0.2, 'y': -0.01, 'yaw': 0.5}


def test_scan_carries_the_mount():
    msg = _scan([1.0, 2.0])
    assert messages.scan_payload(msg)['mount'] is None
    mount = {'x': 0.2, 'y': 0.0, 'yaw': 0.0}
    assert messages.scan_payload(msg, mount=mount)['mount'] == mount


def test_hello_is_not_read_only_when_driving_is_allowed():
    hello = messages.hello_payload({}, 0.1, 0.5, drive_allowed=True)
    assert hello['read_only'] is False


def test_parse_request():
    assert messages.parse_request('{"type":"stop"}') == ('stop', 'any')
    assert messages.parse_request('{"type":"stop","scope":"mine"}') == ('stop', 'mine')
    # A stop with a scope the bridge does not know still stops.
    assert messages.parse_request('{"type":"stop","scope":"everything"}') == ('stop', 'any')
    assert messages.parse_request('{"type":"stop","scope":null}') == ('stop', 'any')
    assert messages.parse_request('{"type":"drive","linear":0.1,"angular":-0.2}') == (
        'drive', 0.1, -0.2)
    # Missing values are passed on as None; the arbiter refuses them.
    assert messages.parse_request('{"type":"drive"}') == ('drive', None, None)
    for ignored in ('not json', '[1]', '{"type":"cmd_vel"}', b'{"type":"stop"}', '"stop"'):
        assert messages.parse_request(ignored) is None


def test_robot_identity_names_the_robot_and_its_domain():
    assert messages.robot_identity('questix-3', {'ROS_DOMAIN_ID': '7'}) == {
        'name': 'questix-3', 'domain': 7}
    identity = messages.robot_identity('', {})
    assert identity['name'] and identity['domain'] is None
    assert messages.robot_identity('a', {'ROS_DOMAIN_ID': ' '})['domain'] is None
    assert messages.robot_identity('a', {'ROS_DOMAIN_ID': 'x'})['domain'] is None


def test_hello_carries_the_robot_identity():
    robot = {'name': 'questix-3', 'domain': 7}
    hello = messages.hello_payload({}, 0.1, 0.5, robot=robot)
    assert hello['robot'] == robot
    default = messages.hello_payload({}, 0.1, 0.5)['robot']
    assert set(default) == {'name', 'domain'} and default['name']
    messages.encode(hello)


def test_state_payload():
    state = messages.state_payload(
        {'allowed': True, 'blockers': []}, {'name': 'r', 'domain': None},
        {'scan': 4.96, 'odom': 20.0}, True, 3, 24)
    assert state == {
        'protocol': messages.PROTOCOL_VERSION, 'read_only': False,
        'robot': {'name': 'r', 'domain': None}, 'clients': 3, 'max_clients': 24,
        'drive_state': {'allowed': True, 'blockers': []},
        'rates': {'scan': 5.0, 'odom': 20.0}, 'records': None,
        'shoot_state': {'allowed': False}, 'emergency_stop': None}
    assert messages.state_payload({}, {}, {}, False, 0, 24)['read_only'] is True
    assert messages.state_payload({}, {}, {}, False, 0, 24, emergency_stop=True)['emergency_stop'] is True
    summary = {'count': 2, 'used_bytes': 10, 'limit_bytes': 100}
    assert messages.state_payload({}, {}, {}, False, 0, 24, records=summary)['records'] == summary


def test_hello_says_what_pages_may_do_with_records():
    assert messages.hello_payload({}, 0.1, 0.5)['records'] == {
        'save': False, 'list': False, 'rosbags': False}
    records = {'save': True, 'list': True, 'rosbags': True}
    assert messages.hello_payload({}, 0.1, 0.5, records=records)['records'] == records


def test_session_and_drive_state_payloads():
    assert messages.session_payload(3) == {'type': 'session', 'id': 3}
    state = messages.drive_state_payload({'allowed': True, 'owner': None})
    assert state == {'type': 'drive_state', 'allowed': True, 'owner': None}


def test_parse_launcher_requests():
    assert messages.parse_request('{"type":"roller","power":0.5}') == ('roller', 0.5)
    assert messages.parse_request('{"type":"roller"}') == ('roller', None)
    assert messages.parse_request('{"type":"roller_stop"}') == ('roller_stop',)
    assert messages.parse_request('{"type":"tilt","deg":30}') == ('tilt', 30)
    assert messages.parse_request('{"type":"fire","confirm":true}') == ('fire', True)
    # Only a JSON true confirms: the pupil's tick, nothing that merely looks like it.
    for text in ('{"type":"fire"}', '{"type":"fire","confirm":1}',
                 '{"type":"fire","confirm":"true"}', '{"type":"fire","confirm":false}'):
        assert messages.parse_request(text) == ('fire', False)


def test_hello_describes_the_launcher():
    assert messages.hello_payload({}, 0.1, 0.5)['shoot'] == {'allowed': False}
    limits = {'max_power': 0.8, 'min_fire_power': 0.2, 'spin_up_sec': 1.0,
              'fire_interval_sec': 2.0, 'tilt_min': 0.0, 'tilt_max': 70.0, 'deadman': 0.5,
              'seconds': 30.0}
    shoot = messages.shoot_hello(True, limits)
    assert shoot == {'allowed': True, 'max_power': 0.8, 'tilt_min': 0.0, 'tilt_max': 70.0,
                     'fire_interval_sec': 2.0, 'min_fire_power': 0.2, 'spin_up_sec': 1.0,
                     'deadman_sec': 0.5, 'max_spin_sec': 30.0}
    assert messages.hello_payload({}, 0.1, 0.5, shoot=shoot)['shoot'] == shoot


def test_launcher_status_is_passed_on_with_a_stamp():
    text = json.dumps({'command': 0.4, 'source': 'lab', 'lab_accepted': True,
                       'lab_locked': False, 'estop': False, 'type': 'spoofed'})
    payload = messages.launcher_status_payload('roller', text, 12.5)
    assert payload == {'type': 'roller', 'stamp': 12.5, 'command': 0.4, 'source': 'lab',
                       'lab_accepted': True, 'lab_locked': False, 'estop': False}
    for broken in ('not json', '[1]', '"x"'):
        with pytest.raises(ValueError):
            messages.launcher_status_payload('shot', broken, 0.0)
    with pytest.raises(ValueError):  # NaN is never emitted to the pages
        messages.encode(messages.launcher_status_payload('shot', '{"tilt_deg": NaN}', 0.0))


def test_shoot_state_and_refusal_payloads():
    assert messages.shoot_state_payload({'allowed': True})['type'] == 'shoot_state'
    refused = messages.shoot_refused_payload(
        'interval', 'fire', {'next_fire_in_sec': 1.2, 'spin_ready_in_sec': 0.0})
    assert refused == {'type': 'shoot_refused', 'reason': 'interval', 'request': 'fire',
                       'next_fire_in_sec': 1.2, 'spin_ready_in_sec': 0.0}
