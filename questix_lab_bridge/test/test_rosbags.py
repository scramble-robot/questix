"""Convert a real rosbag2 (MCAP) bag; skipped without ROS 2 (rosbag2_py, questix_msgs)."""

import math

import pytest

rosbag2_py = pytest.importorskip('rosbag2_py')
pytest.importorskip('questix_msgs.msg')

from builtin_interfaces.msg import Time  # noqa: E402
from geometry_msgs.msg import TransformStamped, Twist  # noqa: E402
from nav_msgs.msg import Odometry  # noqa: E402
from questix_msgs.msg import DriveStatus  # noqa: E402
from rclpy.serialization import serialize_message  # noqa: E402
from sensor_msgs.msg import LaserScan  # noqa: E402
from tf2_msgs.msg import TFMessage  # noqa: E402

from questix_lab_bridge import records, rosbags  # noqa: E402

START_NS = 1_758_000_000 * 10**9
TOPICS = {'scan': '/scan', 'odom': '/odom', 'drive': '/drive_status', 'twist': '/target_twist',
          'camera': ''}
CONFIG = {'wheel_radius': 0.1, 'wheel_separation': 0.5}
MAX_HZ = {'scan': 5.0, 'odom': 20.0, 'drive': 20.0, 'twist': 20.0}


def _stamp(seconds):
    ns = START_NS + round(seconds * 1e9)
    return Time(sec=ns // 10**9, nanosec=ns % 10**9)


def _messages(t):
    speed = 0.2 if 1.0 <= t < 3.0 else 0.0
    drive = DriveStatus()
    drive.header.stamp = _stamp(t)
    drive.linear_velocity = speed
    odom = Odometry()
    odom.header.stamp = _stamp(t)
    odom.pose.pose.position.x = speed * t
    odom.pose.pose.orientation.w = 1.0
    odom.twist.twist.linear.x = speed
    twist = Twist()
    twist.linear.x = speed
    yield '/drive_status', drive
    yield '/odom', odom
    yield '/target_twist', twist
    if round(t * 100) % 10 == 0:  # 10 Hz, above the bridge's 5 Hz
        scan = LaserScan()
        scan.header.stamp = _stamp(t)
        scan.header.frame_id = 'laser_frame'
        scan.angle_min = -math.pi
        scan.angle_increment = 2 * math.pi / 400
        scan.range_min = 0.05
        scan.range_max = 12.0
        scan.ranges = [1.5] * 400
        yield '/scan', scan


@pytest.fixture(scope='module')
def bag(tmp_path_factory):
    path = tmp_path_factory.mktemp('bags') / 'robot_20250916_052000'
    writer = rosbag2_py.SequentialWriter()
    writer.open(rosbag2_py.StorageOptions(uri=str(path), storage_id='mcap'),
                rosbag2_py.ConverterOptions('cdr', 'cdr'))
    for index, (name, kind) in enumerate([
            ('/drive_status', 'questix_msgs/msg/DriveStatus'),
            ('/odom', 'nav_msgs/msg/Odometry'),
            ('/target_twist', 'geometry_msgs/msg/Twist'),
            ('/scan', 'sensor_msgs/msg/LaserScan'),
            ('/tf_static', 'tf2_msgs/msg/TFMessage')]):
        writer.create_topic(rosbag2_py.TopicMetadata(
            id=index, name=name, type=kind, serialization_format='cdr'))
    mount = TransformStamped()
    mount.header.frame_id = 'base_link'
    mount.child_frame_id = 'laser_frame'
    mount.transform.translation.x = 0.2
    mount.transform.rotation.w = 1.0
    writer.write('/tf_static', serialize_message(TFMessage(transforms=[mount])), START_NS)
    for step in range(81):  # 4 s at 20 Hz
        t = step * 0.05
        for topic, msg in _messages(t):
            writer.write(topic, serialize_message(msg), START_NS + round(t * 1e9))
    del writer
    return path


def test_listing_reads_the_metadata(bag):
    [entry] = rosbags.list_bags(bag.parent, TOPICS)['bags']
    assert entry['name'] == bag.name and entry['usable'] is True
    assert entry['seconds'] == pytest.approx(4.0)
    assert entry['startedAt'] == records.iso_time(START_NS * 1e-9)
    assert set(entry['topics']) == {'/drive_status', '/odom', '/target_twist', '/scan',
                                    '/tf_static'}


def test_a_window_becomes_a_recording_of_bridge_payloads(bag):
    recording = rosbags.convert(bag, TOPICS, CONFIG, start=0.5, seconds=2.0, max_hz=MAX_HZ,
                                max_points=360)
    records.check_recording(recording)
    assert recording['source'] == 'rosbag' and recording['lesson'] is None
    assert recording['conditions'] == {'label': 'Robot Managerの録画'}
    assert recording['name'] == bag.name
    assert recording['recordedAt'] == records.iso_time(START_NS * 1e-9 + 0.5)
    assert recording['topics'] == {'scan': '/scan', 'odom': '/odom', 'drive': '/drive_status',
                                   'twist': '/target_twist'}
    streams = recording['streams']
    first = START_NS * 1e-9 + 0.5
    for name in ('drive', 'odom', 'twist', 'scan'):
        stamps = [message['stamp'] for message in streams[name]]
        assert stamps[0] >= first - 1e-6 and stamps[-1] <= first + 2.0 + 1e-6, name
    assert len(streams['drive']) == 41 and streams['drive'][0]['type'] == 'drive'
    assert max(message['v'] for message in streams['odom']) == pytest.approx(0.2)
    assert {message['linear'] for message in streams['twist']} == {0.0, 0.2}
    # 10 Hz in the bag, 5 Hz as the bridge forwards it; decimated to 200 beams, with the mount.
    assert len(streams['scan']) == 11
    scan = streams['scan'][0]
    assert len(scan['ranges']) == 200 and scan['mount'] == {'x': 0.2, 'y': 0.0, 'yaw': 0.0}


def test_windows_and_errors(bag, tmp_path):
    with pytest.raises(rosbags.BagError) as error:
        rosbags.convert(bag, TOPICS, CONFIG, start=10.0)
    assert error.value.status == 400
    with pytest.raises(rosbags.BagError) as error:
        rosbags.convert(bag, TOPICS, CONFIG, deadline=0.0, clock=lambda: 1.0)
    assert error.value.status == 504
    with pytest.raises(rosbags.BagError) as error:
        rosbags.convert(bag, {'drive': '/elsewhere'}, CONFIG)
    assert error.value.status == 422
    with pytest.raises(rosbags.BagError) as error:
        rosbags.convert(tmp_path, TOPICS, CONFIG)
    assert error.value.status == 409
