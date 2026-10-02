import json

import pytest

from questix_lab_bridge import records
from questix_lab_bridge.records import AutoRecorder, RecordError, RecordStore

CONFIG = {'wheel_radius': 0.1, 'wheel_separation': 0.5}
MIB = 1024 * 1024


def _recording(**info):
    streams = info.pop('streams', {
        'drive': [{'type': 'drive', 'stamp': 2.0, 'v': 0.2, 'w': 0.0},
                  {'type': 'drive', 'stamp': 1.0, 'v': 0.0, 'w': 0.0}],
        'twist': [{'type': 'twist', 'stamp': 1.5, 'linear': 0.2, 'angular': 0.0}],
    })
    return records.make_recording(
        source='live', name='run', recorded_at='2026-09-25T01:51:02.000Z', config=CONFIG,
        topics={'drive': '/drive_status'}, streams=streams, **info)


class Clock:
    def __init__(self, now=1_790_000_000.0):
        self.now = now

    def __call__(self):
        return self.now


@pytest.fixture
def store(tmp_path):
    return RecordStore(tmp_path / 'records', 10 * MIB, 0, clock=Clock(),
                       disk_free=lambda path: 100 * MIB)


# --- format ------------------------------------------------------------------------------------

def test_make_recording_matches_recording_core():
    recording = _recording(lesson='control-speed', conditions={'speed': 0.2, 'label': ''},
                           robot={'name': 'questix-03', 'domain': 3}, group=' 3班 ',
                           outcome={'reason': 'done', 'label': '予定どおり'})
    assert recording['format'] == 'questix-lab-recording' and recording['version'] == 1
    assert [m['stamp'] for m in recording['streams']['drive']] == [1.0, 2.0]
    assert set(recording['streams']) == {'drive', 'twist'}
    assert recording['conditions'] == {'speed': 0.2, 'label': '0.20 m/s'}
    assert recording['group'] == '3班'
    assert recording['robot'] == {'name': 'questix-03', 'domain': 3}
    assert recording['outcome'] == {'reason': 'done', 'label': '予定どおり'}
    # Empty run fields are left out, as runInfo does.
    bare = _recording(lesson='', group=None)
    assert 'lesson' not in bare and 'group' not in bare and 'conditions' not in bare
    assert records.clean_conditions({'kp': 2.0, 'kd': 0.6}) == {
        'kp': 2.0, 'kd': 0.6, 'label': 'P 2・D 0.6'}
    assert records.clean_conditions('0.2 m/s') == {'label': '0.2 m/s'}


def test_iso_time_is_javascript_style():
    assert records.iso_time(0.5) == '1970-01-01T00:00:00.500Z'
    assert records.parse_iso('1970-01-01T00:00:01.500Z') == 1.5
    assert records.parse_iso('not a date') is None


@pytest.mark.parametrize('change, text', [
    ({'format': 'other'}, 'questix-lab-recording'),
    ({'version': 2}, '別の版'),
    ({'config': {'wheel_radius': 0.1}}, '車輪'),
    ({'config': {'wheel_radius': -1, 'wheel_separation': 0.5}}, '車輪'),
    ({'streams': {'drive': 'x'}}, 'drive'),
])
def test_check_recording_refuses_what_the_lab_cannot_open(change, text):
    with pytest.raises(RecordError, match=text):
        records.check_recording({**_recording(), **change})
    records.check_recording(_recording())


def test_parse_save_request():
    assert records.parse_save_request('{"type":"drive","linear":0}') is None
    assert records.parse_save_request('not json') is None
    recording = _recording()
    text = json.dumps({'type': 'record_save', 'recording': recording})
    assert records.parse_save_request(text) == recording
    with pytest.raises(RecordError):
        records.parse_save_request('{"type":"record_save","recording":{"format":"x"}}')
    with pytest.raises(RecordError):
        records.parse_save_request('{"type":"record_save", broken')
    with pytest.raises(RecordError):  # NaN is not JSON; the lab could not read it back
        records.parse_save_request(text.replace('0.2', 'NaN', 1))
    with pytest.raises(RecordError, match='大きすぎ'):
        records.parse_save_request('{"type":"record_save","pad":"%s"}'
                                   % ('x' * (records.MAX_SAVE_BYTES + 5000)))


# --- store -------------------------------------------------------------------------------------

def test_save_list_and_read(store):
    record_id = store.save(_recording(lesson='control-speed', group='3班',
                                      robot={'name': 'questix-03', 'domain': 3},
                                      conditions={'speed': 0.2}), records.SOURCE_LAB)
    assert records.ID_PATTERN.match(record_id)
    assert '-lab-control-speed-3-questix-03' in record_id
    listing = store.listing()
    assert listing['save'] is True
    assert listing['quota']['limit_bytes'] == 10 * MIB
    assert listing['quota']['used_bytes'] > 0
    [entry] = listing['records']
    assert entry == {
        'id': record_id, 'source': 'lab', 'lesson': 'control-speed', 'label': '0.20 m/s',
        'group': '3班', 'robot': {'name': 'questix-03', 'domain': 3},
        'recordedAt': '2026-09-25T01:51:02.000Z', 'seconds': 1.0, 'outcome': None,
        'bytes': entry['bytes']}
    body = store.read_bytes(record_id)
    assert len(body) == entry['bytes']
    assert json.loads(body)['conditions']['label'] == '0.20 m/s'
    # A second save in the same second gets its own id.
    assert store.save(_recording(lesson='control-speed', group='3班',
                                 robot={'name': 'questix-03', 'domain': 3}),
                      records.SOURCE_LAB) == record_id + '-2'
    # Same recordedAt: the later id first; without conditions the label says so.
    assert [e['label'] for e in store.entries()] == ['設定：不明', '0.20 m/s']
    summary = store.summary()
    assert summary['count'] == 2 and summary['save'] is True
    assert summary['dir'] == str(store.directory)


@pytest.mark.parametrize('bad', ['../x', '.meta', 'a/b', '', '..', 'x' * 200, None, '.hidden'])
def test_ids_are_validated(store, bad):
    store.save(_recording(), records.SOURCE_LAB)
    assert store.path_of(bad) is None and store.read_bytes(bad) is None


def test_listing_is_newest_first_and_survives_a_lost_index(store):
    first = store.save({**_recording(), 'recordedAt': '2026-09-25T01:00:00.000Z'},
                       records.SOURCE_LAB)
    second = store.save({**_recording(), 'recordedAt': '2026-09-25T02:00:00.000Z'},
                        records.SOURCE_AUTO)
    assert [e['id'] for e in store.entries()] == [second, first]
    # A file copied in by hand (no index) is listed too, as a lab record.
    (store.directory / 'copied.json').write_text(json.dumps(_recording()))
    (store.directory / 'broken.json').write_text('{')
    (store.directory / records._META_DIR / (first + '.json')).unlink()
    ids = {e['id']: e['source'] for e in store.entries()}
    assert ids == {first: 'lab', second: 'auto', 'copied': 'lab'}


def _quota_for(count, tmp_path):
    """A quota that holds ``count`` records like _recording(), and not one more."""
    probe = RecordStore(tmp_path / 'probe', 100 * MIB, 0, clock=Clock(),
                        disk_free=lambda path: 100 * MIB)
    probe.save(_recording(), records.SOURCE_LAB)
    return count * probe.used_bytes() + records._META_RESERVE


def test_a_full_store_refuses_lab_saves_and_never_deletes_lab_records(tmp_path):
    store = RecordStore(tmp_path / 'r', _quota_for(2, tmp_path), 0, clock=Clock(),
                        disk_free=lambda path: 100 * MIB)
    store.save(_recording(), records.SOURCE_LAB)
    store.save(_recording(), records.SOURCE_LAB)
    assert store.can_save() is False
    with pytest.raises(RecordError, match='いっぱい'):
        store.save(_recording(), records.SOURCE_LAB)
    with pytest.raises(RecordError, match='いっぱい'):  # auto may not delete lab records
        store.save(_recording(), records.SOURCE_AUTO)
    assert len(store.entries()) == 2


def test_auto_records_make_room_by_deleting_their_own_oldest(tmp_path):
    clock = Clock()
    store = RecordStore(tmp_path / 'r', _quota_for(3, tmp_path), 0, clock=clock,
                        disk_free=lambda path: 100 * MIB)
    lab = store.save(_recording(), records.SOURCE_LAB)
    autos = []
    for hour in range(4):
        clock.now += 60
        autos.append(store.save({**_recording(), 'recordedAt': '2026-09-25T0%d:00:00.000Z'
                                 % hour}, records.SOURCE_AUTO))
    ids = {e['id'] for e in store.entries()}
    assert ids == {lab, autos[2], autos[3]}
    # A lab save now finds no room, and nothing was deleted for it.
    with pytest.raises(RecordError):
        store.save(_recording(), records.SOURCE_LAB)
    assert {e['id'] for e in store.entries()} == ids


def test_caches_go_first_and_may_only_delete_caches(tmp_path):
    store = RecordStore(tmp_path / 'r', _quota_for(2, tmp_path), 0, clock=Clock(),
                        disk_free=lambda path: 100 * MIB)
    auto = store.save(_recording(), records.SOURCE_AUTO)
    store.save(_recording(), records.SOURCE_ROSBAG_CACHE, record_id='rosbag-a-0-300')
    store.save(_recording(), records.SOURCE_ROSBAG_CACHE, record_id='rosbag-b-0-300')
    assert {e['id'] for e in store.entries()} == {auto, 'rosbag-b-0-300'}
    store.save(_recording(), records.SOURCE_AUTO)
    assert auto in {e['id'] for e in store.entries()}
    assert 'rosbag-b-0-300' not in {e['id'] for e in store.entries()}
    with pytest.raises(RecordError):
        store.save(_recording(), records.SOURCE_ROSBAG_CACHE, record_id='rosbag-c-0-300')


def test_the_disk_reserve_counts_like_the_quota(tmp_path):
    free = {'bytes': 100 * MIB}
    store = RecordStore(tmp_path, 100 * MIB, 50 * MIB, clock=Clock(),
                        disk_free=lambda path: free['bytes'])
    store.save(_recording(), records.SOURCE_LAB)
    free['bytes'] = 50 * MIB + 100
    assert store.can_save() is False
    with pytest.raises(RecordError, match='いっぱい'):
        store.save(_recording(), records.SOURCE_LAB)


def test_too_big_and_disabled(tmp_path):
    store = RecordStore(tmp_path, 100 * MIB, 0, disk_free=lambda path: 1000 * MIB)
    huge = _recording(streams={'drive': [{'stamp': float(i), 'pad': 'x' * 100}
                                         for i in range(90000)]})
    with pytest.raises(RecordError, match='大きすぎ'):
        store.save(huge, records.SOURCE_LAB)
    disabled = RecordStore('', 100 * MIB, 0)
    assert not disabled.enabled and disabled.can_save() is False
    assert disabled.listing()['records'] == [] and disabled.summary()['count'] == 0
    with pytest.raises(RecordError):
        disabled.save(_recording(), records.SOURCE_LAB)


# --- auto recording ----------------------------------------------------------------------------

class Feeder:
    """Feed a steady robot: twist/drive at 20 Hz; ``speed(t)`` is the commanded speed."""

    def __init__(self, recorder):
        self.recorder = recorder
        self.t = 0.0

    def run(self, seconds, speed=0.0, measured=None, lab=False, command=True):
        measured = speed if measured is None else measured
        for _ in range(round(seconds * 20)):
            self.t = round(self.t + 0.05, 6)
            if command:
                self.recorder.feed('twist', {'type': 'twist', 'stamp': self.t, 'linear': speed,
                                             'angular': 0.0}, self.t, lab_active=lab)
            self.recorder.feed('drive', {'type': 'drive', 'stamp': self.t, 'v': measured,
                                         'w': 0.0}, self.t, lab_active=lab)
            if round(self.t * 20) % 20 == 0:
                self.recorder.tick(self.t, lab_active=lab)


@pytest.fixture
def auto():
    saved = []
    recorder = AutoRecorder(saved.append, CONFIG, {'drive': '/drive_status',
                                                   'twist': '/target_twist', 'camera': '/c'},
                            robot={'name': 'questix-03', 'domain': 3},
                            wall_clock=lambda: 1_790_000_100.0)
    return Feeder(recorder), saved


def test_a_controller_drive_is_recorded_with_pre_roll_until_still(auto):
    feeder, saved = auto
    feeder.run(5.0)
    feeder.run(4.0, speed=0.2)
    assert saved == []
    feeder.run(2.9)
    assert saved == []  # still for less than 3 s
    feeder.run(0.2)
    [recording] = saved
    records.check_recording(recording)
    assert recording['lesson'] == 'free-drive'
    assert recording['conditions'] == {'label': 'コントローラーで走行'}
    assert recording['outcome']['reason'] == 'done'
    assert recording['robot'] == {'name': 'questix-03', 'domain': 3}
    assert recording['topics'] == {'drive': '/drive_status', 'twist': '/target_twist'}
    stamps = [m['stamp'] for m in recording['streams']['drive']]
    # One second of pre-roll before the first command, then the drive, then 3 s still.
    assert stamps[0] == pytest.approx(4.0, abs=0.06)
    assert stamps[-1] == pytest.approx(12.0, abs=0.06)
    feeder.run(10.0)
    assert len(saved) == 1


def test_short_bumps_are_not_recorded(auto):
    feeder, saved = auto
    feeder.run(2.0)
    feeder.run(0.8, speed=0.2)
    feeder.run(5.0)
    assert saved == []


def test_long_drives_are_split(auto):
    feeder, saved = auto
    feeder.run(400.0, speed=0.1)
    assert len(saved) == 2
    first = saved[0]['streams']['drive']
    assert first[-1]['stamp'] - first[0]['stamp'] == pytest.approx(180.0, abs=0.1)
    feeder.run(4.0)
    assert len(saved) == 3
    assert saved[1]['streams']['drive'][0]['stamp'] > first[-1]['stamp']


def test_motion_without_a_command_is_labelled_unknown(auto):
    feeder, saved = auto
    feeder.run(3.0, measured=0.2, command=False)
    feeder.run(4.0)
    [recording] = saved
    assert recording['conditions']['label'] == '走行（指令元不明）'


def test_nothing_is_recorded_during_a_lab_run(auto):
    feeder, saved = auto
    feeder.run(1.0)
    feeder.run(5.0, speed=0.2, lab=True)
    feeder.run(0.3, measured=0.1, lab=False)  # the robot slows down after the run
    feeder.run(5.0)
    assert saved == []


def test_a_drive_in_progress_ends_when_a_lab_run_starts(auto):
    feeder, saved = auto
    feeder.run(3.0, speed=0.2)
    feeder.run(3.0, speed=0.2, lab=True)
    [recording] = saved
    assert recording['streams']['drive'][-1]['stamp'] <= 3.0


def test_the_controller_taking_over_after_a_lab_run_is_recorded(auto):
    feeder, saved = auto
    feeder.run(3.0, speed=0.2, lab=True)
    feeder.run(0.2, speed=0.0, measured=0.2)  # the run ended, the robot still rolls
    feeder.run(4.0, speed=0.3)  # the controller drives on at once
    feeder.run(4.0)
    [recording] = saved
    assert recording['conditions']['label'] == 'コントローラーで走行'


def test_flush_keeps_a_drive_in_progress(auto):
    feeder, saved = auto
    feeder.run(2.0, speed=0.2)
    feeder.recorder.flush(feeder.t)
    assert len(saved) == 1
