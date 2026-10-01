import gzip
import json

import pytest

from questix_lab_bridge import records, rosbags
from questix_lab_bridge.records import RecordStore
from questix_lab_bridge.records_api import RecordsApi

CONFIG = {'wheel_radius': 0.1, 'wheel_separation': 0.5}
TOPICS = {'scan': '/scan', 'odom': '/odom', 'drive': '/drive_status', 'twist': '/target_twist',
          'camera': ''}
MIB = 1024 * 1024

METADATA = """rosbag2_bagfile_information:
  version: 9
  storage_identifier: mcap
  duration:
    nanoseconds: 4000000000
  starting_time:
    nanoseconds_since_epoch: %d
  message_count: 3
  topics_with_message_count:
%s
  relative_file_paths:
    - bag_0.mcap
"""
TOPIC = """    - topic_metadata:
        name: %s
        type: %s
        serialization_format: cdr
      message_count: %d"""


def _bag(directory, name, topics, start_ns=1_758_000_000 * 10**9):
    path = directory / name
    path.mkdir(parents=True)
    listing = '\n'.join(TOPIC % topic for topic in topics)
    (path / 'metadata.yaml').write_text(METADATA % (start_ns, listing))
    (path / 'bag_0.mcap').write_bytes(b'x' * 100)
    return path


def _recording(**info):
    return records.make_recording(
        source='live', name='run', recorded_at='2026-09-25T01:51:02.000Z', config=CONFIG,
        streams={'drive': [{'type': 'drive', 'stamp': 1.0, 'v': 0.2, 'w': 0.0}]}, **info)


class FakeConvert:
    def __init__(self, result=None, error=None):
        self.calls = []
        self.result = result
        self.error = error

    def __call__(self, bag_dir, start, seconds, deadline):
        self.calls.append((bag_dir.name, start, seconds))
        if self.error:
            raise self.error
        recording = _recording(conditions={'label': records.ROSBAG_LABEL})
        recording['source'] = 'rosbag'
        return recording


@pytest.fixture
def setup(tmp_path):
    store = RecordStore(tmp_path / 'records', 100 * MIB, 0, disk_free=lambda path: 1000 * MIB)
    convert = FakeConvert()
    api = RecordsApi(store, str(tmp_path / 'bags'), convert, rosbag_max_seconds=300,
                     topics=TOPICS, rosbags_available=True)
    return api, store, convert, tmp_path


def _json(answer):
    status, headers, body = answer
    headers = dict(headers)
    assert headers['Access-Control-Allow-Origin'] == '*'
    assert headers['Cache-Control'] == 'no-store'
    if headers.get('Content-Encoding') == 'gzip':
        body = gzip.decompress(body)
    return status, headers, json.loads(body)


def test_handles_only_its_paths():
    assert RecordsApi.handles('/api/records') and RecordsApi.handles('/api/records/x?y=1')
    assert RecordsApi.handles('/api/rosbags/a/recording?start=1')
    assert not RecordsApi.handles('/api/recordsx') and not RecordsApi.handles('/api/state')
    assert not RecordsApi.handles('/index.html')


def test_hello_and_summary(setup):
    api, store, _, tmp_path = setup
    store.prepare()
    assert api.hello() == {'save': True, 'list': True, 'rosbags': True}
    summary = api.summary()
    assert summary['count'] == 0 and summary['limit_bytes'] == 100 * MIB
    assert summary['rosbag_dir'] == str(tmp_path / 'bags')
    no_bags = RecordsApi(store, '', None, rosbags_available=True)
    assert no_bags.hello()['rosbags'] is False


def test_save_then_list_and_download(setup):
    api, store, _, _ = setup
    assert api.save('{"type":"stop"}') is None
    reply = api.save(json.dumps({'type': 'record_save', 'recording': _recording(
        lesson='control-speed', group='3班')}))
    assert reply['type'] == 'record_saved'
    status, _, listing = _json(api.http('/api/records'))
    assert status == 200 and listing['save'] is True
    assert [entry['id'] for entry in listing['records']] == [reply['id']]
    assert listing['quota']['used_bytes'] > 0
    status, headers, recording = _json(api.http('/api/records/' + reply['id']))
    assert status == 200 and recording['group'] == '3班'
    assert headers['Content-Disposition'] == 'attachment; filename="%s.json"' % reply['id']
    for missing in ('nope', '..%2Fx', '%2e%2e'):
        status, _, body = _json(api.http('/api/records/' + missing))
        assert status == 404 and body['error']
    assert _json(api.http('/api/records/a/b'))[0] == 404


def test_save_errors_are_japanese(setup):
    api, _, _, _ = setup
    reply = api.save('{"type":"record_save","recording":{"format":"questix-lab-recording",'
                     '"version":7}}')
    assert reply['type'] == 'record_error' and '版' in reply['message']


def test_large_bodies_are_gzipped_when_accepted(setup):
    api, store, _, _ = setup
    big = _recording()
    big['streams']['drive'] = [{'type': 'drive', 'stamp': float(i), 'v': 0.1} for i in range(500)]
    record_id = store.save(big, records.SOURCE_LAB)
    status, headers, body = api.http('/api/records/' + record_id, {'Accept-Encoding': 'gzip'})
    assert dict(headers)['Content-Encoding'] == 'gzip'
    assert json.loads(gzip.decompress(body))['streams']['drive'][499]['stamp'] == 499.0
    status, headers, body = api.http('/api/records/' + record_id)
    assert 'Content-Encoding' not in dict(headers) and json.loads(body)


def test_rosbag_listing(setup):
    api, _, _, tmp_path = setup
    status, _, body = _json(api.http('/api/rosbags'))
    assert status == 200 and body == {'bags': [], 'dir': str(tmp_path / 'bags')}
    _bag(tmp_path / 'bags', 'robot_20250916_1', [
        ('/drive_status', 'questix_msgs/msg/DriveStatus', 80),
        ('/scan', 'sensor_msgs/msg/LaserScan', 20)])
    _bag(tmp_path / 'bags', 'robot_20250916_2', [('/rosout', 'rcl_interfaces/msg/Log', 3)],
         start_ns=1_758_000_100 * 10**9)
    _bag(tmp_path / 'bags', 'wrong_type', [('/odom', 'std_msgs/msg/String', 3)],
         start_ns=1_757_000_000 * 10**9)
    recording_now = tmp_path / 'bags' / 'robot_now'
    recording_now.mkdir()
    (recording_now / 'robot_now_0.mcap').write_bytes(b'x')
    (tmp_path / 'bags' / 'not_a_bag').mkdir()
    (tmp_path / 'bags' / 'file.txt').write_text('x')
    status, _, body = _json(api.http('/api/rosbags'))
    bags = {bag['name']: bag for bag in body['bags']}
    assert set(bags) == {'robot_20250916_1', 'robot_20250916_2', 'wrong_type', 'robot_now'}
    first = bags['robot_20250916_1']
    assert first == {'name': 'robot_20250916_1', 'startedAt': '2025-09-16T05:20:00.000Z',
                     'seconds': 4.0, 'bytes': first['bytes'],
                     'topics': ['/drive_status', '/scan'], 'usable': True, 'reason': None}
    assert first['bytes'] > 100
    assert bags['robot_20250916_2']['usable'] is False and bags['robot_20250916_2']['reason']
    assert bags['wrong_type']['usable'] is False
    assert bags['robot_now']['usable'] is False and 'metadata.yaml' in bags['robot_now']['reason']
    # Newest first; a bag still being recorded counts from its directory's time (now).
    assert [bag['name'] for bag in body['bags']] == [
        'robot_now', 'robot_20250916_2', 'robot_20250916_1', 'wrong_type']


def test_missing_rosbag_dir_is_an_empty_list(tmp_path):
    api = RecordsApi(RecordStore('', 1, 0), str(tmp_path / 'none'), None, topics=TOPICS,
                     rosbags_available=True)
    assert _json(api.http('/api/rosbags'))[2] == {'bags': [], 'dir': str(tmp_path / 'none')}
    assert rosbags.list_bags('', TOPICS) == {'bags': [], 'dir': None}


def test_bag_recording_converts_caps_and_caches(setup):
    api, store, convert, tmp_path = setup
    _bag(tmp_path / 'bags', 'robot_1', [('/odom', 'nav_msgs/msg/Odometry', 3)])
    status, _, recording = _json(api.http('/api/rosbags/robot_1/recording?start=2&seconds=900'))
    assert status == 200 and recording['source'] == 'rosbag'
    assert convert.calls == [('robot_1', 2.0, 300.0)]
    # The second request is served from the cache, which the listing shows as such.
    assert _json(api.http('/api/rosbags/robot_1/recording?start=2&seconds=300'))[0] == 200
    assert len(convert.calls) == 1
    [entry] = store.entries()
    assert entry['id'] == 'rosbag-robot_1-2-300' and entry['source'] == 'rosbag-cache'
    assert entry['label'] == 'Robot Managerの録画'
    # Defaults: from the start, rosbag_max_seconds long.
    api.http('/api/rosbags/robot_1/recording')
    assert convert.calls[-1] == ('robot_1', 0.0, 300.0)


@pytest.mark.parametrize('target, status', [
    ('/api/rosbags/nope/recording', 404),
    ('/api/rosbags/..%2F..%2Fetc/recording', 404),
    ('/api/rosbags/robot_1/recording?start=-1', 400),
    ('/api/rosbags/robot_1/recording?seconds=0', 400),
    ('/api/rosbags/robot_1/recording?start=nan', 400),
    ('/api/rosbags/robot_1/other', 404),
])
def test_bad_bag_requests(setup, target, status):
    api, _, _, tmp_path = setup
    _bag(tmp_path / 'bags', 'robot_1', [('/odom', 'nav_msgs/msg/Odometry', 3)])
    answer_status, _, body = _json(api.http(target))
    assert answer_status == status and body['error']


def test_conversion_errors_and_one_at_a_time(setup):
    api, _, convert, tmp_path = setup
    _bag(tmp_path / 'bags', 'robot_1', [('/odom', 'nav_msgs/msg/Odometry', 3)])
    convert.error = rosbags.BagError(504, '時間がかかりすぎました')
    status, _, body = _json(api.http('/api/rosbags/robot_1/recording'))
    assert status == 504 and body == {'error': '時間がかかりすぎました'}
    api._converting.acquire()
    try:
        assert _json(api.http('/api/rosbags/robot_1/recording?start=1'))[0] == 503
    finally:
        api._converting.release()


def test_unexpected_failures_answer_500(setup):
    api, _, convert, tmp_path = setup
    _bag(tmp_path / 'bags', 'robot_1', [('/odom', 'nav_msgs/msg/Odometry', 3)])
    convert.error = RuntimeError('boom')
    status, _, body = _json(api.http('/api/rosbags/robot_1/recording'))
    assert status == 500 and 'boom' in body['error']
