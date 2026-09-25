"""Robot Manager's rosbags for QUESTiX LAB: list them, and convert a window into a recording.

Robot Manager records with ``ros2 bag record -s mcap`` into one directory per bag
(``rosbag_dir``; its OUTPUT_DIR). Listing reads only each bag's ``metadata.yaml``. Conversion
reads the bag with rosbag2_py and builds the same payloads the bridge sends live
(messages.py), so a lesson opens the result like any other recording. rosbag2_py, rclpy and
rosidl_runtime_py are imported only when converting: listing and the tests work without ROS.
"""

import importlib
import importlib.util
import os
from pathlib import Path
import re
import time

from . import messages
from .records import iso_time, make_recording, MAX_RECORDING_MESSAGES, ROSBAG_LABEL

BAG_NAME = re.compile(r'^[A-Za-z0-9._-]{1,200}$')
# The type each stream is converted from; a topic of another type is left out.
STREAM_TYPES = {
    'scan': 'sensor_msgs/msg/LaserScan',
    'odom': 'nav_msgs/msg/Odometry',
    'drive': 'questix_msgs/msg/DriveStatus',
    'twist': 'geometry_msgs/msg/Twist',
}
USABLE_STREAMS = ('drive', 'odom', 'scan')  # a bag with none of these has nothing to show
TF_STATIC_TOPIC = '/tf_static'
_BAG_FILES = ('.mcap', '.db3')
_DEADLINE_CHECK_EVERY = 200  # messages between two looks at the clock
_RATE_HEADROOM = 1.1

NOT_USABLE_TEXT = 'この録画には走行（/drive_status）・オドメトリ（/odom）・LiDAR（/scan）が入っていません。'
UNFINISHED_TEXT = '録画中か、正しく終わっていない録画です（metadata.yaml がありません）。'
BROKEN_METADATA_TEXT = '録画の情報（metadata.yaml）を読み取れません。'


class BagError(Exception):
    """A bag cannot be listed or converted; ``status`` is the HTTP status, the text Japanese."""

    def __init__(self, status, text):
        super().__init__(text)
        self.status = status
        self.text = text


def available():
    """Whether rosbag2_py can be imported here (the bridge runs with ROS sourced)."""
    try:
        return importlib.util.find_spec('rosbag2_py') is not None
    except (ImportError, ValueError):
        return False


def _bag_files(bag_dir):
    try:
        return [item for item in os.scandir(bag_dir)
                if item.is_file() and item.name.endswith(_BAG_FILES)]
    except OSError:
        return []


def _dir_bytes(bag_dir):
    total = 0
    try:
        for item in os.scandir(bag_dir):
            if item.is_file():
                total += item.stat().st_size
    except OSError:
        pass
    return total


def read_metadata(bag_dir):
    """Return ``{start_ns, duration_ns, storage, topics: {name: (type, count)}}`` or raise.

    Raises FileNotFoundError without metadata.yaml, ValueError when it cannot be read.
    """
    import yaml  # python3-yaml; imported here so a missing module only affects rosbags

    text = (Path(bag_dir) / 'metadata.yaml').read_text(encoding='utf-8')
    try:
        info = yaml.safe_load(text)['rosbag2_bagfile_information']
        topics = {}
        for item in info.get('topics_with_message_count') or []:
            meta = item['topic_metadata']
            topics[meta['name']] = (meta['type'], int(item.get('message_count', 0)))
        return {
            'start_ns': int(info['starting_time']['nanoseconds_since_epoch']),
            'duration_ns': int(info['duration']['nanoseconds']),
            'storage': str(info.get('storage_identifier') or ''),
            'topics': topics,
        }
    except (yaml.YAMLError, KeyError, TypeError, ValueError) as error:
        raise ValueError('bad metadata.yaml: %r' % (error,))


def stream_topics(metadata, topics):
    """``{stream: topic}`` of the bridge's topics that the bag has with the expected type."""
    found = {}
    for stream, topic in topics.items():
        entry = metadata['topics'].get(topic) if topic else None
        if stream in STREAM_TYPES and entry and entry[0] == STREAM_TYPES[stream] and entry[1]:
            found[stream] = topic
    return found


def bag_entry(bag_dir, topics):
    """Return the listing entry of one bag directory, or None when it holds no bag."""
    bag_dir = Path(bag_dir)
    has_metadata = (bag_dir / 'metadata.yaml').is_file()
    if not has_metadata and not _bag_files(bag_dir):
        return None
    entry = {'name': bag_dir.name, 'startedAt': None, 'seconds': 0.0,
             'bytes': _dir_bytes(bag_dir), 'topics': [], 'usable': False, 'reason': None}
    try:
        metadata = read_metadata(bag_dir)
    except FileNotFoundError:
        entry['reason'] = UNFINISHED_TEXT
    except (OSError, ValueError, ImportError):
        entry['reason'] = BROKEN_METADATA_TEXT
    else:
        entry['startedAt'] = iso_time(metadata['start_ns'] * 1e-9)
        entry['seconds'] = round(metadata['duration_ns'] * 1e-9, 3)
        entry['topics'] = sorted(metadata['topics'])
        usable = any(stream in stream_topics(metadata, topics) for stream in USABLE_STREAMS)
        entry['usable'] = usable
        entry['reason'] = None if usable else NOT_USABLE_TEXT
    if entry['startedAt'] is None:
        try:
            entry['startedAt'] = iso_time(bag_dir.stat().st_mtime)
        except OSError:
            entry['startedAt'] = iso_time(0)
    return entry


def list_bags(directory, topics):
    """Body of GET /api/rosbags: every bag in ``directory``, newest first.

    A missing or unreadable directory is an empty list, not an error.
    """
    bags = []
    if directory:
        try:
            children = [item for item in os.scandir(directory)
                        if item.is_dir() and BAG_NAME.match(item.name)]
        except OSError:
            children = []
        for child in children:
            entry = bag_entry(child.path, topics)
            if entry is not None:
                bags.append(entry)
    bags.sort(key=lambda bag: (bag['startedAt'], bag['name']), reverse=True)
    return {'bags': bags, 'dir': str(directory) if directory else None}


def bag_path(directory, name):
    """Return the directory of bag ``name`` in ``directory``, or None (bad name, no bag)."""
    if not (directory and isinstance(name, str) and BAG_NAME.match(name)) or name in ('.', '..'):
        return None
    path = Path(directory) / name
    return path if path.is_dir() else None


def _mounts(reader, rosbag2_py, deserialize, tf_type, base_frame):
    """``{child frame: mount}`` of the static transforms from ``base_frame`` in the bag."""
    mounts = {base_frame: {'x': 0.0, 'y': 0.0, 'yaw': 0.0}}
    reader.set_filter(rosbag2_py.StorageFilter(topics=[TF_STATIC_TOPIC]))
    while reader.has_next():
        _, data, _ = reader.read_next()
        for transform in deserialize(data, tf_type).transforms:
            if transform.header.frame_id.lstrip('/') == base_frame:
                mounts[transform.child_frame_id.lstrip('/')] = messages.mount_from_transform(
                    transform.transform)
    reader.reset_filter()
    return mounts


def convert(bag_dir, topics, config, start=0.0, seconds=300.0, max_hz=None, max_points=360,
            base_frame='base_link', deadline=None, clock=time.monotonic):
    """Convert ``seconds`` of the bag from ``start`` [s after its start] into a recording.

    ``topics`` maps stream -> topic (the bridge's parameters), ``config`` is the wheel
    geometry, ``max_hz`` the bridge's forwarding rates per stream (on the bag's receive time),
    ``deadline`` a ``clock()`` value after which the conversion gives up (BagError 504).
    Raises BagError with a Japanese text for the page.
    """
    bag_dir = Path(bag_dir)
    try:
        metadata = read_metadata(bag_dir)
    except FileNotFoundError:
        raise BagError(409, UNFINISHED_TEXT)
    except (OSError, ValueError):
        raise BagError(500, BROKEN_METADATA_TEXT)
    found = stream_topics(metadata, topics)
    if not any(stream in found for stream in USABLE_STREAMS):
        raise BagError(422, NOT_USABLE_TEXT)
    if start * 1e9 > metadata['duration_ns']:
        raise BagError(400, 'start が録画の長さ（%.1f 秒）を超えています。'
                       % (metadata['duration_ns'] * 1e-9))
    try:
        rosbag2_py = importlib.import_module('rosbag2_py')
        from rclpy.serialization import deserialize_message
        from rosidl_runtime_py.utilities import get_message
    except ImportError:
        raise BagError(503, 'このロボットでは録画を変換できません（rosbag2_py がありません）。')

    begin_ns = metadata['start_ns'] + int(start * 1e9)
    end_ns = begin_ns + int(seconds * 1e9)
    # The bridge's forwarding rates, on the bag's receive time (as live, on the node's clock),
    # with 10 % headroom: a 20 Hz topic under a 20 Hz limit must not lose every other message
    # to a timestamp a microsecond early.
    limiters = {stream: messages.RateLimiter((max_hz or {}).get(stream, 0.0) * _RATE_HEADROOM)
                for stream in found}
    by_topic = {topic: stream for stream, topic in found.items()}
    streams = {stream: [] for stream in found}
    count = 0
    reader = rosbag2_py.SequentialReader()
    try:
        reader.open(rosbag2_py.StorageOptions(uri=str(bag_dir), storage_id=metadata['storage']),
                    rosbag2_py.ConverterOptions('', ''))
        types = {topic.name: topic.type for topic in reader.get_all_topics_and_types()}
        message_types = {topic: get_message(types[topic]) for topic in by_topic}
        mounts = {}
        if types.get(TF_STATIC_TOPIC) == 'tf2_msgs/msg/TFMessage':
            mounts = _mounts(reader, rosbag2_py, deserialize_message,
                             get_message('tf2_msgs/msg/TFMessage'), base_frame)
        reader.set_filter(rosbag2_py.StorageFilter(topics=sorted(by_topic)))
        reader.seek(begin_ns)
        read = 0
        while reader.has_next():
            read += 1
            if deadline is not None and read % _DEADLINE_CHECK_EVERY == 0 and clock() > deadline:
                raise BagError(504, '録画の変換に時間がかかりすぎました。短い区間を指定してください。')
            topic, data, received_ns = reader.read_next()
            if received_ns > end_ns:
                break
            stream = by_topic.get(topic)
            if stream is None or received_ns < begin_ns:
                continue
            if not limiters[stream].ready(received_ns * 1e-9):
                continue
            msg = deserialize_message(data, message_types[topic])
            try:
                payload = _payload(stream, msg, received_ns, max_points, mounts)
            except (AttributeError, TypeError, ValueError):
                continue  # a message this build cannot convert (as the live bridge skips it)
            streams[stream].append(payload)
            count += 1
            if count >= MAX_RECORDING_MESSAGES:
                break
    except BagError:
        raise
    except Exception as error:  # noqa: B902 - rosbag2 raises RuntimeError and friends
        raise BagError(500, '録画を読み取れませんでした（壊れているか、録画中です）: %s' % error)
    finally:
        del reader  # closes the bag
    recording = make_recording(
        source='rosbag', name=bag_dir.name, recorded_at=iso_time(begin_ns * 1e-9),
        config=config, topics=found, streams=streams, conditions={'label': ROSBAG_LABEL})
    recording['lesson'] = None
    return recording


def _payload(stream, msg, received_ns, max_points, mounts):
    if stream == 'scan':
        return messages.scan_payload(msg, max_points, mounts.get(msg.header.frame_id.lstrip('/')))
    if stream == 'odom':
        return messages.odom_payload(msg)
    if stream == 'drive':
        return messages.drive_payload(msg)
    # Twist has no header: its stamp is when it was received, as live (the bag's receive time).
    return messages.twist_payload(msg, received_ns * 1e-9)
