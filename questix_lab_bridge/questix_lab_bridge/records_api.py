"""HTTP GET endpoints and the ``record_save`` frame for records kept on the robot.

ROS-free; ws_server.py calls :meth:`RecordsApi.http` and :meth:`RecordsApi.save` on a worker
thread (never on its asyncio loop), because reading, writing and converting can take seconds.

* ``GET /api/records`` - ``{records: [entry...] newest first, quota: {used_bytes,
  limit_bytes}, save}`` (records.RecordStore.listing).
* ``GET /api/records/<id>`` - that recording (JSON, as an attachment ``<id>.json``).
* ``GET /api/rosbags`` - ``{bags: [{name, startedAt, seconds, bytes, topics, usable, reason}],
  dir}`` (rosbags.list_bags).
* ``GET /api/rosbags/<name>/recording[?start=<s>&seconds=<s>]`` - a window of that bag as a
  recording (at most ``rosbag_max_seconds``), cached in the store as ``rosbag-cache``.

Every answer carries ``Access-Control-Allow-Origin: *`` (the pages may come from Robot
Manager's ``/lab/`` on another port) and ``Cache-Control: no-store``; errors are
``{"error": <Japanese>}``. Nothing here changes the robot: the only write is a record file.
"""

import gzip
import json
import math
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit

from . import records, rosbags

RECORDS_PATH = '/api/records'
ROSBAGS_PATH = '/api/rosbags'
_GZIP_ABOVE = 2048  # bytes; smaller bodies are sent as they are
_GZIP_LEVEL = 5


def _json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'),
                      allow_nan=False).encode('utf-8')


def _accepts_gzip(request_headers):
    if request_headers is None:
        return False
    return 'gzip' in (request_headers.get('Accept-Encoding') or '').lower()


def respond(status, body, request_headers=None, extra=()):
    """``(status, headers, body)`` of a JSON answer, gzip-compressed when the client allows."""
    headers = [
        ('Content-Type', 'application/json; charset=utf-8'),
        ('X-Content-Type-Options', 'nosniff'),
        ('Cache-Control', 'no-store'),
        ('Access-Control-Allow-Origin', '*'),
        ('Access-Control-Expose-Headers', 'Content-Disposition'),
        ('Vary', 'Accept-Encoding'),
        *extra,
    ]
    if len(body) > _GZIP_ABOVE and _accepts_gzip(request_headers):
        body = gzip.compress(body, _GZIP_LEVEL)
        headers.append(('Content-Encoding', 'gzip'))
    return status, headers, body


def error(status, text, request_headers=None):
    return respond(status, _json_bytes({'error': text}), request_headers)


def _number(query, key, default):
    values = query.get(key)
    if not values:
        return default
    try:
        value = float(values[0])
    except ValueError:
        return None
    return value if math.isfinite(value) and value >= 0 else None


def _seconds_text(value):
    return ('%.3f' % value).rstrip('0').rstrip('.')


class RecordsApi:
    """Answers for the record endpoints of one bridge.

    ``convert(bag_dir, start, seconds, deadline)`` turns a bag window into a recording (the
    node binds rosbags.convert to its topics, geometry and rates); ``clock`` is monotonic.
    """

    def __init__(self, store, rosbag_dir, convert, rosbag_max_seconds=300.0,
                 convert_timeout_sec=60.0, topics=None, logger=None, clock=time.monotonic,
                 rosbags_available=None):
        self.store = store
        self.rosbag_dir = rosbag_dir or None
        self._convert = convert
        self.rosbag_max_seconds = float(rosbag_max_seconds)
        self.convert_timeout_sec = float(convert_timeout_sec)
        self._topics = dict(topics or {})
        self._logger = logger
        self._clock = clock
        self._rosbags_available = (rosbags.available() if rosbags_available is None
                                   else rosbags_available)
        self._converting = threading.Lock()

    @staticmethod
    def handles(target):
        path = urlsplit(target).path
        return any(path == prefix or path.startswith(prefix + '/')
                   for prefix in (RECORDS_PATH, ROSBAGS_PATH))

    def hello(self):
        """Return ``hello.records``: what pages may do with records on this robot."""
        return {'save': self.store.can_save(), 'list': True,
                'rosbags': bool(self.rosbag_dir and self._rosbags_available)}

    def summary(self):
        """Return ``records`` of GET /api/state: count, size and quota for robot_manager."""
        return dict(self.store.summary(), rosbag_dir=self.rosbag_dir)

    # --- HTTP

    def http(self, target, request_headers=None):
        """Answer one GET under /api/records or /api/rosbags."""
        parts = urlsplit(target)
        path = parts.path
        try:
            if path in (RECORDS_PATH, RECORDS_PATH + '/'):
                return respond(200, _json_bytes(self.store.listing()), request_headers)
            if path.startswith(RECORDS_PATH + '/'):
                return self._record(unquote(path[len(RECORDS_PATH) + 1:]), request_headers)
            if path in (ROSBAGS_PATH, ROSBAGS_PATH + '/'):
                return respond(200, _json_bytes(rosbags.list_bags(self.rosbag_dir, self._topics)),
                               request_headers)
            rest = path[len(ROSBAGS_PATH) + 1:].split('/')
            if len(rest) == 2 and rest[1] == 'recording':
                return self._bag_recording(unquote(rest[0]), parse_qs(parts.query),
                                           request_headers)
            return error(404, 'そのようなページはありません。', request_headers)
        except Exception as failure:  # noqa: B902 - answered, the server stays up
            self._log('error', '%s failed: %r' % (path, failure))
            return error(500, 'ロボットで記録を扱えませんでした: %s' % failure, request_headers)

    def _record(self, record_id, request_headers):
        body = self.store.read_bytes(record_id)
        if body is None:
            return error(404, '記録が見つかりません（消されたか、別のロボットの記録です）。',
                         request_headers)
        disposition = ('Content-Disposition', 'attachment; filename="%s.json"' % record_id)
        return respond(200, body, request_headers, extra=(disposition,))

    def _bag_recording(self, name, query, request_headers):
        if not self.rosbag_dir:
            return error(404, 'このロボットには録画の保存先が設定されていません。', request_headers)
        bag_dir = rosbags.bag_path(self.rosbag_dir, name)
        if bag_dir is None:
            return error(404, '録画が見つかりません。', request_headers)
        start = _number(query, 'start', 0.0)
        seconds = _number(query, 'seconds', self.rosbag_max_seconds)
        if start is None or seconds is None or seconds <= 0:
            return error(400, 'start と seconds は 0 以上の秒数で指定してください。',
                         request_headers)
        seconds = min(seconds, self.rosbag_max_seconds)
        cache_id = 'rosbag-%s-%s-%s' % (name, _seconds_text(start), _seconds_text(seconds))
        if not records.ID_PATTERN.match(cache_id):
            cache_id = None  # a very long bag name: converted every time, not cached
        cached = self._cached(cache_id, bag_dir) if cache_id else None
        if cached is not None:
            return respond(200, cached, request_headers)
        if not self._converting.acquire(blocking=False):
            return error(503, '別の録画を変換しています。少し待ってからもう一度開いてください。',
                         request_headers)
        try:
            started = self._clock()
            recording = self._convert(bag_dir, start, seconds,
                                      started + self.convert_timeout_sec)
        except rosbags.BagError as failure:
            return error(failure.status, failure.text, request_headers)
        finally:
            self._converting.release()
        self._log('info', 'converted rosbag %s (%s s from %s s) in %.1f s' % (
            name, _seconds_text(seconds), _seconds_text(start), self._clock() - started))
        if cache_id and self.store.enabled:
            try:
                self.store.save(recording, records.SOURCE_ROSBAG_CACHE, record_id=cache_id)
            except records.RecordError as failure:
                self._log('warning', 'rosbag conversion not cached: %s' % failure)
        return respond(200, _json_bytes(recording), request_headers)

    def _cached(self, cache_id, bag_dir):
        path = self.store.path_of(cache_id)
        if path is None:
            return None
        try:
            if path.stat().st_mtime < (bag_dir / 'metadata.yaml').stat().st_mtime:
                return None  # the bag was rewritten since
        except OSError:
            return None
        return self.store.read_bytes(cache_id)

    # --- WebSocket

    def save(self, text):
        """Answer a browser frame: a ``record_saved`` / ``record_error`` payload, or None.

        None means the frame is not a ``record_save`` (the node handles it, or ignores it).
        """
        try:
            recording = records.parse_save_request(text)
            if recording is None:
                return None
            record_id = self.store.save(recording, records.SOURCE_LAB)
        except records.RecordError as failure:
            return {'type': 'record_error', 'message': str(failure)}
        self._log('info', 'saved record %s' % record_id)
        return {'type': 'record_saved', 'id': record_id}

    def _log(self, level, text):
        if self._logger is not None:
            getattr(self._logger, level)(text)
