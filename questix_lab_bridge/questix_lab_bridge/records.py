"""Records kept on the robot: QUESTiX LAB recordings any device connected to it can list and open.

ROS-free and clock-injected, so every rule is unit-tested (test/test_records.py).

* :func:`make_recording` writes the ``questix-lab-recording`` format of
  ``scripts/robot_manager/static/lab/js/live/recording-core.js`` (``makeRecording``); keep the
  two in step (``RECORDING_VERSION`` there).
* :class:`RecordStore` keeps them as files in one directory (``records_dir``): pages save their
  runs over the WebSocket (``record_save``, source ``lab``), the bridge records controller
  driving by itself (source ``auto``, :class:`AutoRecorder`), and rosbags converted for the lab
  are cached (source ``rosbag-cache``). Ids are made here, never taken from a page.
  Storage is bounded by a quota and by the free space left on the disk: when full, auto records
  and caches make room by deleting their own oldest; lab records are never deleted
  automatically, a lab save is refused instead (the teacher tidies up).
* :class:`AutoRecorder` watches the payloads the bridge sends to the pages and records a drive
  nobody recorded from a page: from 1 s before the robot starts moving until it has stood
  still for 3 s, split every 180 s, not while a lab driving run is active.
"""

from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import shutil
import threading
import time

RECORDING_FORMAT = 'questix-lab-recording'
RECORDING_VERSION = 1  # RECORDING_VERSION in static/lab/js/live/recording-core.js
RECORDING_STREAMS = ('drive', 'twist', 'scan', 'odom')
MAX_RECORDING_MESSAGES = 200000  # MAX_RECORDING_MESSAGES in recording-core.js
# Largest recording a page may save (the WebSocket frame limit is a little above it).
MAX_SAVE_BYTES = 8 * 1024 * 1024

SOURCE_LAB = 'lab'
SOURCE_AUTO = 'auto'
SOURCE_ROSBAG_CACHE = 'rosbag-cache'
SOURCES = (SOURCE_LAB, SOURCE_AUTO, SOURCE_ROSBAG_CACHE)

UNKNOWN_CONDITIONS = '設定：不明'  # UNKNOWN_CONDITIONS in recording-core.js
AUTO_LESSON = 'free-drive'
AUTO_LABEL_CONTROLLER = 'コントローラーで走行'
AUTO_LABEL_UNKNOWN = '走行（指令元不明）'
ROSBAG_LABEL = 'Robot Managerの録画'

FULL_TEXT = 'ロボットの保存領域がいっぱいです。先生に古い記録の整理を頼んでください。'
TOO_BIG_TEXT = '記録が大きすぎて保存できません（8 MBまで）。短く区切って記録してください。'
NO_STORE_TEXT = 'このロボットには記録を保存できません（保存先が設定されていないか、書き込めません）。'
WRITE_FAILED_TEXT = 'ロボットに記録を書き込めませんでした。先生に知らせてください。'

ID_PATTERN = re.compile(r'^[A-Za-z0-9._-]{1,160}$')
_ID_PART = re.compile(r'[^A-Za-z0-9._-]+')
_META_DIR = '.meta'
_SUFFIX = '.json'
_META_RESERVE = 2048  # bytes kept free for a record's index file

_MAX_TEXT = 60
_MAX_GROUP = 30


class RecordError(Exception):
    """A record could not be saved or read; the message is Japanese, shown to the learner."""


# --- the recording format (recording-core.js) -----------------------------------------------

def clean_text(value, limit=_MAX_TEXT):
    return value.strip()[:limit] if isinstance(value, str) else ''


def _finite_number(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value))


def _conditions_text(values):
    if _finite_number(values.get('speed')):
        return '%.2f m/s' % values['speed']
    gains = [(name, values.get(key)) for name, key in (('P', 'kp'), ('I', 'ki'), ('D', 'kd'))]
    return '・'.join('%s %s' % (name, _js_number(value))
                    for name, value in gains if _finite_number(value))


def _js_number(value):
    """Format a number as JavaScript's String(n) would for the usual cases (2.0 -> '2')."""
    return str(int(value)) if float(value).is_integer() else repr(float(value))


def clean_conditions(value):
    """Clean conditions as recording-core.js does: numbers, short texts and a label, or None."""
    if isinstance(value, str):
        return {'label': clean_text(value)} if clean_text(value) else None
    if not isinstance(value, dict):
        return None
    kept = {}
    for key, item in value.items():
        if key == 'label':
            continue
        if _finite_number(item):
            kept[key] = item
        elif isinstance(item, bool):
            kept[key] = item
        elif isinstance(item, str):
            kept[key] = clean_text(item)
    label = clean_text(value.get('label')) or _conditions_text(kept)
    if not label and not kept:
        return None
    return {**kept, 'label': label}


def clean_robot(value):
    if not isinstance(value, dict):
        return None
    name = clean_text(value.get('name'))
    domain = value.get('domain')
    domain = domain if isinstance(domain, int) and not isinstance(domain, bool) else None
    return {'name': name, 'domain': domain} if name or domain is not None else None


def clean_outcome(value):
    reason = clean_text(value.get('reason'), 40) if isinstance(value, dict) else ''
    return {'reason': reason, 'label': clean_text(value.get('label'))} if reason else None


def run_info(lesson=None, conditions=None, robot=None, group=None, outcome=None):
    """Return the optional run fields of a recording, cleaned; empty ones left out (runInfo)."""
    info = {
        'lesson': clean_text(lesson),
        'conditions': clean_conditions(conditions),
        'robot': clean_robot(robot),
        'group': clean_text(group, _MAX_GROUP),
        'outcome': clean_outcome(outcome),
    }
    return {key: value for key, value in info.items() if value}


def _sorted_by_stamp(messages):
    kept = [m for m in messages if isinstance(m, dict) and _finite_number(m.get('stamp'))]
    return sorted(kept, key=lambda message: message['stamp'])


def make_recording(source, name, recorded_at, config, streams, topics=None, **info):
    """Return a recording as makeRecording builds it; streams not given are left out."""
    kept = {stream: _sorted_by_stamp(streams[stream])
            for stream in RECORDING_STREAMS if isinstance(streams.get(stream), list)}
    return {
        'format': RECORDING_FORMAT,
        'version': RECORDING_VERSION,
        'source': source,
        'name': name,
        'recordedAt': recorded_at,
        'config': {'wheel_radius': config['wheel_radius'],
                   'wheel_separation': config['wheel_separation']},
        'topics': dict(topics or {}),
        'streams': kept,
        **run_info(**info),
    }


def iso_time(epoch_seconds):
    """ISO 8601 in UTC with milliseconds, as JavaScript's Date.toISOString writes it."""
    moment = datetime.fromtimestamp(epoch_seconds, timezone.utc)
    return moment.strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (moment.microsecond // 1000)


def parse_iso(text):
    """Epoch seconds of an ISO 8601 text, or None."""
    if not isinstance(text, str) or not text:
        return None
    try:
        moment = datetime.fromisoformat(text.replace('Z', '+00:00'))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.astimezone()
    return moment.timestamp()


def check_recording(recording):
    """Raise RecordError unless ``recording`` is a questix-lab-recording the lab can open."""
    if not isinstance(recording, dict) or recording.get('format') != RECORDING_FORMAT:
        raise RecordError('QUESTiX LABの実機記録（questix-lab-recording）ではありません。')
    if recording.get('version') != RECORDING_VERSION:
        raise RecordError('この記録は、別の版の教材で作られています。教材を読み込み直してください。')
    config = recording.get('config')
    if not (isinstance(config, dict) and _finite_number(config.get('wheel_radius'))
            and _finite_number(config.get('wheel_separation'))
            and config['wheel_radius'] > 0 and config['wheel_separation'] > 0):
        raise RecordError('記録に車輪の寸法（wheel_radius・wheel_separation）がありません。')
    streams = recording.get('streams')
    if streams is not None and not isinstance(streams, dict):
        raise RecordError('記録の streams が正しくありません。')
    count = 0
    for stream in RECORDING_STREAMS:
        items = (streams or {}).get(stream)
        if items is None:
            continue
        if not isinstance(items, list):
            raise RecordError('記録の %s が一覧になっていません。' % stream)
        count += len(items)
    if count > MAX_RECORDING_MESSAGES:
        raise RecordError('記録が長すぎます。45分以内に区切って保存してください。')


def recording_seconds(recording):
    """Span of the stamps over every stream [s] (recordingSummary().seconds)."""
    stamps = []
    for items in (recording.get('streams') or {}).values():
        values = [m.get('stamp') for m in items if isinstance(m, dict)] if isinstance(
            items, list) else []
        values = [v for v in values if _finite_number(v)]
        if values:
            stamps += [min(values), max(values)]
    return round(max(stamps) - min(stamps), 3) if stamps else 0.0


def _fallback_label(source):
    return {SOURCE_AUTO: AUTO_LABEL_CONTROLLER,
            SOURCE_ROSBAG_CACHE: ROSBAG_LABEL}.get(source, UNKNOWN_CONDITIONS)


def entry_of(record_id, recording, source, size, saved_at):
    """Return the listing entry (GET /api/records) of a recording file."""
    info = run_info(**{key: recording.get(key) for key in (
        'lesson', 'conditions', 'robot', 'group', 'outcome')})
    recorded = parse_iso(recording.get('recordedAt'))
    return {
        'id': record_id,
        'source': source,
        'lesson': info.get('lesson') or None,
        'label': (info.get('conditions') or {}).get('label') or _fallback_label(source),
        'group': info.get('group') or None,
        'robot': info.get('robot'),
        'recordedAt': iso_time(recorded if recorded is not None else saved_at),
        'seconds': recording_seconds(recording),
        'outcome': info.get('outcome'),
        'bytes': size,
    }


def _id_part(text, limit):
    return _ID_PART.sub('-', str(text or '')).strip('-._')[:limit]


def make_id(source, when, lesson=None, group=None, robot=None):
    """``20260925-105102-lab-control-speed-3-questix-03``: local time, source, what it was.

    Only ``[A-Za-z0-9._-]`` survive (a group typed in Japanese keeps its digits, if any); the
    store appends ``-2``, ``-3``… when two records would share an id.
    """
    stamp = datetime.fromtimestamp(when).strftime('%Y%m%d-%H%M%S')
    parts = [stamp, source, _id_part(lesson, 32), _id_part(group, 16), _id_part(robot, 24)]
    return '-'.join(part for part in parts if part)


# --- the store --------------------------------------------------------------------------------

class RecordStore:
    """Recording files in one directory, with a quota and a free-space reserve.

    ``<dir>/<id>.json`` is the recording; ``<dir>/.meta/<id>.json`` its listing entry (so a
    listing never parses the recordings themselves). Thread-safe: the WebSocket thread, the
    auto recorder's writer and rosbag conversions all use it.
    """

    def __init__(self, directory, quota_bytes, min_free_bytes, clock=time.time, logger=None,
                 disk_free=None):
        self.directory = Path(directory).expanduser() if directory else None
        self.quota_bytes = int(quota_bytes)
        self.min_free_bytes = int(min_free_bytes)
        self._clock = clock
        self._logger = logger
        self._disk_free = disk_free or _disk_free
        self._lock = threading.RLock()
        self._entries = {}  # file name -> (mtime_ns, size, entry) of files read without an index

    @property
    def enabled(self):
        return self.directory is not None

    def prepare(self):
        """Create the directory (with this user's permissions); return whether it is writable."""
        if not self.enabled:
            return False
        try:
            (self.directory / _META_DIR).mkdir(parents=True, exist_ok=True)
        except OSError as error:
            self._warn('cannot create %s: %s' % (self.directory, error))
            return False
        return os.access(self.directory, os.W_OK)

    # -- reading

    def _record_files(self):
        if not self.enabled:
            return []
        try:
            return [item for item in os.scandir(self.directory)
                    if item.is_file() and item.name.endswith(_SUFFIX)
                    and not item.name.startswith('.')
                    and ID_PATTERN.match(item.name[:-len(_SUFFIX)])]
        except OSError:
            return []

    def _meta_path(self, record_id):
        return self.directory / _META_DIR / (record_id + _SUFFIX)

    def _entry(self, item):
        record_id = item.name[:-len(_SUFFIX)]
        stat = item.stat()
        try:
            entry = json.loads(self._meta_path(record_id).read_text(encoding='utf-8'))
            if isinstance(entry, dict) and entry.get('id') == record_id:
                return dict(entry, bytes=stat.st_size)
        except (OSError, ValueError):
            pass
        # A file copied in by hand (or an index lost): read it once, keep the entry in memory.
        cached = self._entries.get(item.name)
        if cached and cached[:2] == (stat.st_mtime_ns, stat.st_size):
            return cached[2]
        try:
            recording = json.loads(Path(item.path).read_text(encoding='utf-8'))
            check_recording(recording)
        except (OSError, ValueError, RecordError):
            return None
        entry = entry_of(record_id, recording, SOURCE_LAB, stat.st_size, stat.st_mtime)
        self._entries[item.name] = (stat.st_mtime_ns, stat.st_size, entry)
        return entry

    def entries(self):
        """Every record's listing entry, newest first."""
        with self._lock:
            entries = [entry for entry in map(self._entry, self._record_files()) if entry]
        return sorted(entries, key=lambda entry: (entry['recordedAt'], entry['id']), reverse=True)

    def used_bytes(self):
        total = 0
        for item in self._record_files():
            try:
                total += item.stat().st_size
                total += self._meta_path(item.name[:-len(_SUFFIX)]).stat().st_size
            except OSError:
                pass
        return total

    def can_save(self):
        """Whether a page's save could succeed now (the directory is writable, not full)."""
        if not self.enabled:
            return False
        if not os.access(self.directory, os.W_OK):
            return False
        return self._room(self.used_bytes()) > _META_RESERVE

    def summary(self):
        """Count and size for GET /api/state (robot_manager's 教材 tab)."""
        files = self._record_files()
        return {
            'dir': str(self.directory) if self.enabled else None,
            'count': len(files),
            'used_bytes': self.used_bytes(),
            'limit_bytes': self.quota_bytes,
            'save': self.can_save(),
        }

    def listing(self):
        """Body of GET /api/records."""
        entries = self.entries()
        return {
            'records': entries,
            'quota': {'used_bytes': self.used_bytes(), 'limit_bytes': self.quota_bytes},
            'save': self.can_save(),
        }

    def path_of(self, record_id):
        """Return the file of a record id, or None for an invalid or unknown id."""
        if not (self.enabled and isinstance(record_id, str) and ID_PATTERN.match(record_id)):
            return None
        if record_id.startswith('.'):
            return None
        path = self.directory / (record_id + _SUFFIX)
        return path if path.is_file() else None

    def read_bytes(self, record_id):
        path = self.path_of(record_id)
        if path is None:
            return None
        try:
            return path.read_bytes()
        except OSError:
            return None

    # -- writing

    def _room(self, used):
        free = self._disk_free(self.directory) - self.min_free_bytes
        return min(self.quota_bytes - used, free)

    def save(self, recording, source, record_id=None):
        """Write ``recording``; return its id. Raises RecordError (Japanese) when it cannot.

        ``source`` ``lab`` is refused when full; ``auto`` deletes the oldest caches and auto
        records to make room; ``rosbag-cache`` deletes only the oldest caches. ``record_id``
        (caches only) replaces a record of that id.
        """
        if source not in SOURCES:
            raise ValueError('unknown source %r' % (source,))
        if not self.prepare():
            raise RecordError(NO_STORE_TEXT)
        check_recording(recording)
        body = json.dumps(recording, ensure_ascii=False, separators=(',', ':'),
                          allow_nan=False).encode('utf-8')
        if len(body) > MAX_SAVE_BYTES:
            raise RecordError(TOO_BIG_TEXT)
        now = self._clock()
        with self._lock:
            if record_id is None:
                record_id = self._new_id(source, now, recording)
            elif not ID_PATTERN.match(record_id):
                raise ValueError('invalid record id %r' % (record_id,))
            self._make_room(len(body) + _META_RESERVE, source, keep=record_id)
            entry = entry_of(record_id, recording, source, len(body), now)
            try:
                _write_atomic(self.directory / (record_id + _SUFFIX), body)
                _write_atomic(self._meta_path(record_id), json.dumps(
                    entry, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
            except OSError as error:
                self._warn('cannot write record %s: %s' % (record_id, error))
                raise RecordError(WRITE_FAILED_TEXT)
        return record_id

    def _new_id(self, source, now, recording):
        robot = recording.get('robot') if isinstance(recording.get('robot'), dict) else {}
        # The time the run was recorded (as listed), else now.
        when = parse_iso(recording.get('recordedAt'))
        base = make_id(source, now if when is None else when, recording.get('lesson'),
                       recording.get('group'), robot.get('name'))
        record_id, number = base, 1
        while (self.directory / (record_id + _SUFFIX)).exists():
            number += 1
            record_id = '%s-%d' % (base, number)
        return record_id

    def _make_room(self, needed, source, keep):
        if self._room(self.used_bytes()) >= needed:
            return
        prunable = {SOURCE_AUTO: (SOURCE_ROSBAG_CACHE, SOURCE_AUTO),
                    SOURCE_ROSBAG_CACHE: (SOURCE_ROSBAG_CACHE,)}.get(source, ())
        candidates = [entry for entry in self.entries()
                      if entry['source'] in prunable and entry['id'] != keep]
        # Caches go first, then the oldest auto records.
        candidates.sort(key=lambda entry: (entry['source'] != SOURCE_ROSBAG_CACHE,
                                           entry['recordedAt']))
        for entry in candidates:
            self.delete(entry['id'])
            self._info('deleted %s record %s to make room' % (entry['source'], entry['id']))
            if self._room(self.used_bytes()) >= needed:
                return
        raise RecordError(FULL_TEXT)

    def delete(self, record_id):
        with self._lock:
            path = self.path_of(record_id)
            if path is None:
                return False
            for target in (path, self._meta_path(record_id)):
                try:
                    target.unlink()
                except FileNotFoundError:
                    pass
            self._entries.pop(path.name, None)
            return True

    def _warn(self, text):
        if self._logger is not None:
            self._logger.warning(text)

    def _info(self, text):
        if self._logger is not None:
            self._logger.info(text)


def _disk_free(directory):
    try:
        return shutil.disk_usage(directory).free
    except OSError:
        return 0


def _write_atomic(path, body):
    temporary = path.with_name('.tmp-%d-%s' % (os.getpid(), path.name))
    try:
        temporary.write_bytes(body)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def parse_save_request(text):
    """Return the recording of a ``{"type": "record_save", "recording": {...}}`` frame.

    None when the frame is something else (not ours to answer). Raises RecordError for a
    record_save that cannot be read or is too big.
    """
    if not isinstance(text, str):
        return None
    if len(text.encode('utf-8')) > MAX_SAVE_BYTES + 4096:
        raise RecordError(TOO_BIG_TEXT)
    try:
        message = json.loads(text, parse_constant=_reject_constant)
    except ValueError:
        if '"record_save"' in text:
            raise RecordError('記録を読み取れませんでした。もう一度保存してください。')
        return None
    if not isinstance(message, dict) or message.get('type') != 'record_save':
        return None
    recording = message.get('recording')
    check_recording(recording)
    return recording


def _reject_constant(name):
    raise ValueError('%s is not JSON' % name)


# --- recording controller driving without a lab page ------------------------------------------

# A command or a measured speed above these counts as moving.
MOVING_LINEAR = 0.02  # m/s
MOVING_ANGULAR = 0.1  # rad/s
# A stream's gap longer than this does not count as motion time.
_MAX_MOTION_STEP = 0.25


def _moving(payload, linear_key, angular_key):
    linear = payload.get(linear_key)
    angular = payload.get(angular_key)
    return ((_finite_number(linear) and abs(linear) > MOVING_LINEAR)
            or (_finite_number(angular) and abs(angular) > MOVING_ANGULAR))


def payload_moving(stream, payload):
    """Whether one bridge payload says the robot moves (twist: is asked to move)."""
    if stream == 'twist':
        return _moving(payload, 'linear', 'angular')
    if stream in ('drive', 'odom'):
        return _moving(payload, 'v', 'w')
    return False


class AutoRecorder:
    """Record controller driving from the payloads the bridge sends to the pages.

    Feed it every scan/odom/drive/twist payload with ``feed(stream, payload, now, lab_active)``
    (``now``: a monotonic clock [s]) and call ``tick(now, lab_active)`` about once a second.
    Finished recordings go to ``sink(recording)`` on the caller's thread (the bridge writes
    them on a worker thread).

    * Idle, the last ``pre_roll`` seconds are kept. When a command or a measured speed says
      the robot moves, a segment starts with them.
    * A segment ends ``still_sec`` after the last motion, or is split at ``split_sec`` (the
      next one starts at once). A segment with less than ``min_motion_sec`` of motion is
      dropped (a bump, a twitch of the stick).
    * While a lab driving run is active nothing is recorded: the page records its own run.
      A segment in progress ends when one starts. After it, recording resumes once the robot
      has stood still for ``pre_roll`` seconds, or at the first command that asks the robot to
      move ``lab_grace`` seconds after the run (the controller took over).
    """

    def __init__(self, sink, config, topics, robot=None, wall_clock=time.time, pre_roll=1.0,
                 still_sec=3.0, split_sec=180.0, min_motion_sec=1.0, lab_grace=0.5):
        self._sink = sink
        self._config = dict(config)
        self._topics = {k: v for k, v in topics.items() if k in RECORDING_STREAMS and v}
        self._robot = robot
        self._wall_clock = wall_clock
        self.pre_roll = pre_roll
        self.still_sec = still_sec
        self.split_sec = split_sec
        self.min_motion_sec = min_motion_sec
        self.lab_grace = lab_grace
        self._buffer = []  # (now, stream, payload)
        self.recording = False
        self._blocked = False
        self._lab_ended_at = None
        self._start = 0.0
        self._last_motion = None
        self._motion_seconds = 0.0
        self._commanded = False

    def feed(self, stream, payload, now, lab_active=False):
        if stream not in RECORDING_STREAMS:
            return
        self._lab(now, lab_active)
        if lab_active:
            return
        moving = payload_moving(stream, payload)
        if self._blocked:
            if moving and stream == 'twist' and now - self._lab_ended_at >= self.lab_grace:
                self._blocked = False  # the controller drives now
            elif moving:
                self._last_motion = now
            elif now - self._last_motion >= self.pre_roll:
                self._blocked = False
                self._last_motion = None
            if self._blocked:
                return
        self._buffer.append((now, stream, payload))
        if moving:
            if self.recording and self._last_motion is not None:
                self._motion_seconds += min(now - self._last_motion, _MAX_MOTION_STEP)
            self._last_motion = now
            if stream == 'twist':
                self._commanded = True
            if not self.recording:
                self._begin(now)
        self._check(now)

    def tick(self, now, lab_active=False):
        self._lab(now, lab_active)
        self._check(now)

    def flush(self, now):
        """End a segment in progress (the bridge shuts down); it is kept if long enough."""
        if self.recording:
            self._finish(now, 'done')

    def _lab(self, now, lab_active):
        if lab_active:
            if self.recording:
                self._finish(now, 'lab')
            self._buffer = []
            self._blocked = True
            self._lab_ended_at = None
        elif self._blocked and self._lab_ended_at is None:
            # The robot counts as moving until it has been seen still for pre_roll.
            self._lab_ended_at = now
            self._last_motion = now

    def _begin(self, now):
        self.recording = True
        self._start = self._buffer[0][0] if self._buffer else now
        self._motion_seconds = 0.0
        self._commanded = any(stream == 'twist' and payload_moving(stream, payload)
                              for _, stream, payload in self._buffer)

    def _check(self, now):
        if self.recording:
            if now - self._last_motion >= self.still_sec:
                self._finish(now, 'done')
                self._last_motion = None
            elif now - self._start >= self.split_sec:
                self._finish(now, 'split')
                self.recording = True
                self._start = now
                self._motion_seconds = 0.0
                self._commanded = False
        elif not self._blocked:
            self._buffer = [item for item in self._buffer if now - item[0] <= self.pre_roll]

    def _finish(self, now, why):
        buffer, self._buffer = self._buffer, []
        self.recording = False
        if self._motion_seconds < self.min_motion_sec or not buffer:
            return
        streams = {}
        for _, stream, payload in buffer:
            streams.setdefault(stream, []).append(payload)
        started = self._wall_clock() - (now - buffer[0][0])
        label = AUTO_LABEL_CONTROLLER if self._commanded else AUTO_LABEL_UNKNOWN
        outcome_label = {'split': '3分ごとに区切った',
                         'lab': '教材の走行が始まった'}.get(why, 'ロボットが止まった')
        recording = make_recording(
            source='live', name='%s %s' % (label, datetime.fromtimestamp(started).strftime(
                '%H:%M:%S')),
            recorded_at=iso_time(started), config=self._config, topics=self._topics,
            streams=streams, lesson=AUTO_LESSON, conditions={'label': label}, robot=self._robot,
            outcome={'reason': 'done', 'label': outcome_label})
        self._sink(recording)
