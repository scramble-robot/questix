"""ROS 2 node that mirrors robot telemetry to QUESTiX LAB pages over a WebSocket.

It also holds the pages' sessions with the robot (design/safety_permission_input_refactor.md,
4.5). Driving: it publishes the drive topic (``/target_twist/lab``, command_arbiter's lab input)
for the page that runs a driving experiment, under drive.DriveSession: one page at a time, a
dead-man timeout and a run time limit. What reaches the drive is decided further down and only
shown here: command_arbiter's DriveArbiter (the teacher's lesson permission, QUESTiX LAB's speed
caps, the controller always wins; its status ``/command_arbiter/status`` ends a run it refused)
and drive_component (``/emergency_stop``, ``/motion_permission``).

The launcher: it publishes a questix_msgs/LauncherCommand (``/launcher_command/lab``,
command_arbiter's lab input) for the page that runs a launcher experiment, under
shoot.ShootSession: one page at a time, a roller dead-man, a session time limit, the pupil's
confirmation and the shot rules checked first. What reaches the launcher is decided further down
and only shown here: command_arbiter's LauncherArbiter (the teacher's lesson permission, QUESTiX
LAB's caps and shot preconditions, the controller always wins) and the launcher nodes
(``/emergency_stop``, ``/motion_permission``). ``/roller/status`` and ``/shot/status`` are mirrored
to every page either way (streams ``roller`` and ``shot``). Nothing else is ever published.

Records kept on the robot (records.py, records_api.py, rosbags.py) need no ROS interface of
their own: pages save and list them over the same port, the node records controller driving
from the payloads it already builds, and rosbags are read from files.
"""
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import json
import math
import signal
import threading
import time

from geometry_msgs.msg import Twist
from nav_msgs.msg import Odometry
from questix_msgs.msg import ArbiterStatus, DriveStatus, EmergencyStop, LauncherCommand
from questix_msgs.msg import MotionPermission
import rclpy
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, qos_profile_sensor_data, ReliabilityPolicy
from rclpy.signals import SignalHandlerOptions
from rclpy.time import Time
from sensor_msgs.msg import CompressedImage, LaserScan
from std_msgs.msg import String
from tf2_ros import Buffer, TransformException, TransformListener

from . import messages, records, rosbags
from .drive import arbiter_status, DriveSession
from .records_api import RecordsApi
from .shoot import ShootSession, TiltCoalescer
from .static_site import find_lab_dir
from .ws_server import LabWebSocketServer

_STATUS_PERIOD_SEC = 1.0
# How often the ROS graph is checked for other publishers / the drive node.
_GRAPH_PERIOD_SEC = 0.5
# drive_state is repeated this often even without a change, so a page notices a dead bridge.
_DRIVE_STATE_PERIOD_SEC = 1.0
# questix_msgs/README.md: /emergency_stop is reliable + transient_local, keep-last 1.
# command_arbiter's status comes at 5 Hz: one older than this means the arbiter is gone.
_ARBITER_STATUS_TIMEOUT_SEC = 1.5
# /motion_permission comes at 20 Hz; its lease (the actuators use 0.5 s). Here it only decides what
# the pages are told and ends a session.
_MOTION_PERMISSION_LEASE_SEC = 0.5
_PERMISSION_QOS = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                             durability=DurabilityPolicy.VOLATILE)
_STATUS_QOS = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE,
                         durability=DurabilityPolicy.VOLATILE)
# Browser requests handled by the ShootSession (messages.parse_request).
_SHOOT_REQUESTS = ('roller', 'roller_stop', 'tilt', 'fire')
# Least time between two tilt targets (shot_component's tilt rate limit is 50 ms).
_TILT_GAP_SEC = 0.06
_ESTOP_QOS = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                        durability=DurabilityPolicy.TRANSIENT_LOCAL)
# questix_msgs/msg/LauncherCommand.msg: reliable + volatile + keep-last(1).
_COMMAND_QOS = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                          durability=DurabilityPolicy.VOLATILE)
# Finished controller-driving records admitted to the writer thread at once (the one being written
# included). More are dropped with a warning: the ROS callbacks never wait for the disk, and at
# most this many recordings are held in memory for writing.
_AUTO_RECORD_BACKLOG = 2
# A new page gets the last /emergency_stop only if it arrived this recently (the pages count an
# E-stop older than 1 s as stale).
_ESTOP_GREETING_MAX_AGE_SEC = 1.0


class LabBridgeNode(Node):

    def __init__(self):
        super().__init__('questix_lab_bridge')
        host = self.declare_parameter('host', '0.0.0.0').value
        port = self.declare_parameter('port', 8897).value
        max_clients = self.declare_parameter('max_clients', 24).value
        # Shown to pages and teachers so they can tell robots apart; empty = the host name.
        self._robot = messages.robot_identity(self.declare_parameter('robot_name', '').value)
        # Directory of the QUESTiX LAB site served over HTTP on the same port; empty = locate
        # it automatically (source tree, $ROBOT_WS, /opt/questix_robot).
        site_dir = find_lab_dir(self.declare_parameter('lab_dir', '').value)
        # An empty topic name disables that stream.
        topics = {
            'scan': self.declare_parameter('scan_topic', '/scan').value,
            'odom': self.declare_parameter('odom_topic', '/odom').value,
            'drive': self.declare_parameter('drive_status_topic', '/drive_status').value,
            'twist': self.declare_parameter('target_twist_topic', '/target_twist').value,
            'camera': self.declare_parameter('camera_topic', '').value,
            # The launcher nodes' status (std_msgs/String JSON, Contract A), for every page.
            'roller': self.declare_parameter('roller_status_topic', '/roller/status').value,
            'shot': self.declare_parameter('shot_status_topic', '/shot/status').value,
        }
        max_hz = {
            'scan': self.declare_parameter('scan_max_hz', 5.0).value,
            'odom': self.declare_parameter('odom_max_hz', 20.0).value,
            'drive': self.declare_parameter('drive_max_hz', 20.0).value,
            'twist': self.declare_parameter('twist_max_hz', 20.0).value,
            'camera': self.declare_parameter('camera_max_fps', 10.0).value,
            # 5 Hz and on change at the source: every status is passed on (0 = no limit), so a
            # short "shooting" is not lost.
            'roller': 0.0,
            'shot': 0.0,
        }
        self._scan_max_points = self.declare_parameter('scan_max_points', 360).value
        # Frame the LiDAR mount is reported in (the robot's own frame, as in the static TF
        # published by launcher/launch/lidar_driver.launch.xml).
        self._base_frame = self.declare_parameter('base_frame', 'base_link').value
        self._tf_buffer = Buffer()
        self._tf_listener = TransformListener(self._tf_buffer, self)
        self._mounts = {}  # scan frame -> mount; static on this robot, so looked up once
        # Geometry is only reported to the page (it must match drive_component's values).
        wheel_radius = self.declare_parameter('wheel_radius', 0.05).value
        wheel_separation = self.declare_parameter('wheel_separation', 0.5).value

        # Driving from the pages (see drive.py for every rule): command_arbiter's lab input. The
        # arbiter decides what reaches the drive; its status tells the pages why.
        self._drive_topic = self.declare_parameter('drive_topic', '/target_twist/lab').value
        arbiter_topic = self.declare_parameter(
            'arbiter_status_topic', '/command_arbiter/status').value
        motion_topic = self.declare_parameter(
            'motion_permission_topic', '/motion_permission').value
        # Receive times (monotonic) of the latest drive status of the arbiter and of the motion
        # permission, and its values. The teacher's lesson permission is the arbiter's report.
        self._arbiter_at = -math.inf
        self._motion = {'drive': False, 'launcher': False}
        self._motion_at = -math.inf
        estop_topic = self.declare_parameter('emergency_stop_topic', '/emergency_stop').value
        # /emergency_stop is also a stream of its own (``estop``): the authoritative E-stop for
        # the pages and the recordings. Its own subscription (below) feeds it.
        topics['estop'] = estop_topic
        # 10 Hz and on change at the source (operation_manager): every message is passed on.
        max_hz['estop'] = 0.0
        # The last /emergency_stop (encoded) and when it arrived (monotonic), for pages that
        # connect later; only passed on while it is fresh, so a new page never sees an old state.
        self._latest_estop = None
        self._latest_estop_at = -math.inf
        drive_rate = self.declare_parameter('drive_rate_hz', 20.0).value
        self._drive_lock = threading.Lock()
        self._drive = DriveSession(
            deadman_sec=self.declare_parameter('drive_deadman_sec', 0.5).value,
            max_run_sec=self.declare_parameter('drive_max_run_sec', 30.0).value)
        self._drive_sent_version = -1
        self._drive_sent_at = 0.0
        # The launcher from the pages (see shoot.py for every rule): command_arbiter's lab input.
        # The arbiter decides what reaches the launcher; its status tells the pages why.
        self._launcher_topic = self.declare_parameter(
            'launcher_command_topic', '/launcher_command/lab').value
        shoot_rate = self.declare_parameter('shoot_rate_hz', 20.0).value
        self._shoot_enabled = (bool(self._launcher_topic) and bool(arbiter_topic)
                               and bool(topics['roller']) and bool(topics['shot']))
        self._shoot = ShootSession(
            deadman_sec=self.declare_parameter('shoot_deadman_sec', 0.5).value,
            max_spin_sec=self.declare_parameter('shoot_max_spin_sec', 30.0).value)
        self._shoot_sent_version = -1
        self._shoot_sent_at = 0.0
        # Tilt targets faster than shot_component's rate limit (50 ms) are coalesced (latest
        # wins) and sent at most every _TILT_GAP_SEC, only while the session that asked for them
        # still runs (shoot.TiltCoalescer).
        self._tilt = TiltCoalescer(_TILT_GAP_SEC)
        self._closing = False  # destroy_node() has begun
        # Either source reports an emergency stop: operation_manager's topic, or drive_component
        # itself in /drive_status (robots started without the GPIO safety path).
        self._estop = {'topic': False, 'drive': False}
        # The state is known only once /emergency_stop itself has been observed. /drive_status
        # (and the launcher statuses) may add a pressed E-stop, but their "released" is derived
        # and never counts: until then driving and the launcher stay refused (estop_unknown).
        self._estop_known = False

        # Records kept on the robot: pages' saves, controller driving recorded here, and
        # Robot Manager's rosbags converted for the lessons.
        mib = 1024 * 1024
        self._store = records.RecordStore(
            self.declare_parameter('records_dir', '~/.local/share/questix/lab-records').value,
            self.declare_parameter('records_quota_mb', 500).value * mib,
            self.declare_parameter('records_min_free_mb', 200).value * mib,
            logger=self.get_logger())
        auto_record = bool(self.declare_parameter('auto_record', True).value)
        if self._store.enabled and not self._store.prepare():
            self.get_logger().warning('cannot write records to %s: pages cannot save there'
                                      % self._store.directory)
        config = {'wheel_radius': wheel_radius, 'wheel_separation': wheel_separation}
        convert = partial(
            self._convert_bag, topics=topics, config=config, max_hz=max_hz,
            max_points=self._scan_max_points, base_frame=self._base_frame)
        self._records = RecordsApi(
            self._store, self.declare_parameter('rosbag_dir', '/var/lib/questix/rosbags').value,
            convert, self.declare_parameter('rosbag_max_seconds', 300.0).value,
            self.declare_parameter('rosbag_convert_timeout_sec', 60.0).value,
            topics=topics, logger=self.get_logger())
        self._recorder = None
        self._record_writer = None
        self._record_admission = None
        self._record_limiters = {}
        if auto_record and self._store.enabled:
            self._record_writer = ThreadPoolExecutor(1, thread_name_prefix='lab_records')
            self._record_admission = records.BoundedWriter(
                self._record_writer, _AUTO_RECORD_BACKLOG)
            self._recorder = records.AutoRecorder(
                self._write_auto_record, config, topics, robot=self._robot)
            self._record_limiters = {name: messages.RateLimiter(max_hz[name])
                                     for name in records.RECORDING_STREAMS}

        self._limiters = {name: messages.RateLimiter(hz) for name, hz in max_hz.items()}
        self._counts = {name: 0 for name, topic in topics.items() if topic}
        self._rates = {}  # last status report; replaced whole, read by /api/state
        self._warned_camera_format = False

        streams = {name: (topic or None) for name, topic in topics.items()}
        hello = messages.encode(messages.hello_payload(
            streams, wheel_radius, wheel_separation, bool(self._drive_topic), self._robot,
            self._records.hello(),
            messages.shoot_hello(self._shoot_enabled, self._shoot.limits())))
        self._server = LabWebSocketServer(
            host, port, hello, max_clients, self.get_logger(), site_dir,
            greeting=self._greeting, on_message=self._on_browser, on_disconnect=self._on_leave,
            state_provider=self._state, records=self._records)

        self._drive_publisher = None
        # Observed even when pages may not move the robot: /api/state tells the teacher whether the
        # E-stop is pressed (robot_manager's status strip) whatever the permissions are.
        if estop_topic:
            self._estop_subscription = self.create_subscription(
                EmergencyStop, estop_topic, self._on_estop, _ESTOP_QOS)
        # Shown to the pages (and a lost permission ends a session); enforced further down.
        if motion_topic:
            self._motion_subscription = self.create_subscription(
                MotionPermission, motion_topic, self._on_motion_permission, _PERMISSION_QOS)
        self._launcher_publisher = None
        if self._shoot_enabled:
            self._launcher_publisher = self.create_publisher(
                LauncherCommand, self._launcher_topic, _COMMAND_QOS)
            self._shoot_timer = self.create_timer(1.0 / max(1.0, shoot_rate), self._on_shoot_tick)
        if (self._drive_topic or self._shoot_enabled) and arbiter_topic:
            self._arbiter_subscription = self.create_subscription(
                ArbiterStatus, arbiter_topic, self._on_arbiter, _STATUS_QOS)
        if self._drive_topic:
            self._drive_publisher = self.create_publisher(Twist, self._drive_topic, 1)
            self._drive_timer = self.create_timer(1.0 / max(1.0, drive_rate), self._on_drive_tick)
        if self._drive_topic or self._shoot_enabled:
            self._graph_timer = self.create_timer(_GRAPH_PERIOD_SEC, self._check_graph)
            self._check_graph()
        self._server.start()

        handlers = {
            'scan': (LaserScan, self._on_scan),
            'odom': (Odometry, self._on_odom),
            'drive': (DriveStatus, self._on_drive),
            'twist': (Twist, self._on_twist),
            'camera': (CompressedImage, self._on_camera),
            'roller': (String, self._on_roller_status),
            'shot': (String, self._on_shot_status),
        }
        self._lab_subscriptions = []
        for name, (msg_type, callback) in handlers.items():
            if not topics[name]:
                continue
            # Sensor streams are best-effort; the rest use the default reliable profile.
            qos = qos_profile_sensor_data if name in ('scan', 'camera') else 10
            self._lab_subscriptions.append(
                self.create_subscription(msg_type, topics[name], callback, qos))
        self._status_timer = self.create_timer(_STATUS_PERIOD_SEC, self._on_status)
        may = ([self._drive_topic] if self._drive_topic else []) + (
            [self._launcher_topic] if self._shoot_enabled else [])
        self.get_logger().info(
            'QUESTiX LAB bridge (%s) on ws://%s:%d, streams: %s'
            % ('may publish %s' % ', '.join(may) if may else 'read-only',
               host, self._server.port, ', '.join(sorted(self._counts)) or 'none'))
        if not self._shoot_enabled:
            self.get_logger().info('a launcher or arbiter topic parameter is empty: no launcher '
                                   'experiments')
        self.get_logger().info('records: %s (%s), rosbags: %s' % (
            self._store.directory or 'not kept',
            'controller driving recorded' if self._recorder else 'no auto recording',
            self._records.rosbag_dir or 'none'))
        if site_dir is None:
            self.get_logger().warning(
                'QUESTiX LAB site not found; set the lab_dir parameter to serve it from this port')
        else:
            self.get_logger().info(
                'teaching material: open http://<this host>:%d/ in a browser (serving %s)'
                % (self._server.port, site_dir))

    def _now(self):
        return self.get_clock().now().nanoseconds * 1e-9

    def _relay(self, name, build):
        """Hand a message to the pages and to the auto recorder, each at its own rate.

        ``build`` returns the payload: a dict (JSON streams) or bytes (camera frames).
        """
        self._counts[name] += 1
        now = self._now()
        send = self._server.client_count and self._limiters[name].ready(now)
        keep = name in self._record_limiters and self._record_limiters[name].ready(now)
        if not (send or keep):
            return
        try:
            payload = build()
            text = messages.encode(payload) if send and isinstance(payload, dict) else payload
        except (AttributeError, TypeError, ValueError) as error:
            # e.g. a questix_msgs build that predates a field: skip the message, keep the
            # other streams alive, and say why instead of taking the node down.
            self.get_logger().error(
                'cannot convert a %s message, skipping it: %r' % (name, error),
                throttle_duration_sec=10.0)
            return
        if send:
            self._server.publish(name, text)
        if keep:
            # The recorder only reads the payload; a lab run in progress records itself.
            self._recorder.feed(name, payload, time.monotonic(), lab_active=self._drive.active)

    def _write_auto_record(self, recording):
        """Save a finished auto record on the writer thread (the ROS thread keeps going).

        At most _AUTO_RECORD_BACKLOG are admitted at once (being written or waiting): a slow disk
        then costs the newest controller drives, never unbounded memory or a waiting callback.
        """
        if self._record_admission.submit(self._save_auto_record, recording):
            return True
        self.get_logger().warning(
            'controller drive not recorded: %d records are still being written'
            % _AUTO_RECORD_BACKLOG, throttle_duration_sec=10.0)
        return False

    def _save_auto_record(self, recording):
        try:
            record_id = self._store.save(recording, records.SOURCE_AUTO)
        except records.RecordError as error:
            self.get_logger().warning('controller drive not recorded: %s' % error)
            return
        except Exception as error:  # noqa: B902 - on the writer thread nobody else would see it
            self.get_logger().error('controller drive not recorded: %r' % (error,))
            return
        self.get_logger().info('recorded controller driving: %s' % record_id)

    def _convert_bag(self, bag_dir, start, seconds, deadline, **options):
        """Convert a bag window for RecordsApi (on a worker thread, never the ROS executor)."""
        return rosbags.convert(bag_dir, start=start, seconds=seconds, deadline=deadline,
                               **options)

    def _mount(self, frame):
        """Pose of ``frame`` in the base frame, or None while TF does not know it yet."""
        if frame in self._mounts:
            return self._mounts[frame]
        try:
            stamped = self._tf_buffer.lookup_transform(self._base_frame, frame, Time())
        except TransformException as error:
            self.get_logger().warning(
                'no TF from %s to %s yet, the lab will assume its default LiDAR mount: %s'
                % (self._base_frame, frame, error), throttle_duration_sec=30.0)
            return None
        self._mounts[frame] = messages.mount_from_transform(stamped.transform)
        self.get_logger().info('LiDAR mount %s in %s: %s'
                               % (frame, self._base_frame, self._mounts[frame]))
        return self._mounts[frame]

    def _on_scan(self, msg):
        self._relay('scan', lambda: messages.scan_payload(
            msg, self._scan_max_points, self._mount(msg.header.frame_id)))

    def _on_odom(self, msg):
        self._relay('odom', lambda: messages.odom_payload(msg))

    def _on_drive(self, msg):
        # Derived: may add a pressed E-stop, never makes the state known.
        if self._estop['drive'] != bool(msg.emergency_stop):
            self._set_estop('drive', bool(msg.emergency_stop))
        stamp = self._now()
        self._relay('drive', lambda: messages.drive_payload(msg, stamp))

    def _on_twist(self, msg):
        self._relay('twist', lambda: messages.twist_payload(msg, self._now()))

    def _on_camera(self, msg):
        if messages.image_kind(msg.data) is None:
            # Unknown encodings are skipped, not guessed: the browser could not decode them.
            if not self._warned_camera_format:
                self._warned_camera_format = True
                self.get_logger().warning(
                    'camera frames are not JPEG/PNG (format="%s"); skipping them' % msg.format)
            return
        self._relay('camera', lambda: bytes(msg.data))

    # --- driving from the pages ------------------------------------------------------------
    # Browser callbacks run on the WebSocket thread and ROS callbacks on the executor, so every
    # access to the arbiter holds _drive_lock. A stop is published at once, not at the next tick.

    def _drive_state_text(self):
        return messages.encode(messages.drive_state_payload(self._drive.state()))

    def _greeting(self, client_id):
        with self._drive_lock:
            greeting = [messages.encode(messages.session_payload(client_id)),
                        self._drive_state_text(), self._shoot_state_text(time.monotonic())]
        # The last /emergency_stop, so a page that connects later knows it at once (it is
        # re-sent by operation_manager anyway; the page judges its age by bridge_stamp).
        if (self._latest_estop is not None
                and time.monotonic() - self._latest_estop_at <= _ESTOP_GREETING_MAX_AGE_SEC):
            greeting.append(self._latest_estop)
        return greeting

    def _on_browser(self, client_id, text):
        request = messages.parse_request(text)
        if request is None or self._closing:
            return
        if request[0] in _SHOOT_REQUESTS:
            if self._shoot_enabled:
                self._on_shoot_request(client_id, request)  # refused while not permitted
            return
        if not self._drive_topic:
            return
        now = time.monotonic()
        with self._drive_lock:
            if request[0] == 'stop':
                if self._drive.stop(client_id, now, only_own=request[1] == 'mine'):
                    self._publish_twist(0.0, 0.0)
                    self.get_logger().info('drive stopped by page %d' % client_id)
            else:
                was_owner = self._drive.owner
                refused = self._drive.request(client_id, request[1], request[2], now)
                if refused is not None and was_owner == client_id:
                    self._publish_twist(0.0, 0.0)
                if refused is not None:
                    # Only the asking page hears why, at once (the others see no change).
                    state = dict(self._drive.state(), refused=refused)
                    self._server.publish_to(client_id, 'drive_state', messages.encode(
                        messages.drive_state_payload(state)))
                if self._drive.owner == client_id and was_owner is None:
                    self.get_logger().info('page %d drives %s' % (client_id, self._drive_topic))
            self._send_drive_state(now)

    def _state(self, clients, max_clients):
        """Snapshot for GET /api/state; runs on the WebSocket thread."""
        with self._drive_lock:
            drive_state = self._drive.state()
            shoot_state = self._shoot.state(time.monotonic())
            # None until /emergency_stop itself has been observed (see _estop_known).
            estop = any(self._estop.values()) if self._estop_known else None
        summary = dict(self._records.summary(), auto_record=self._recorder is not None)
        return messages.state_payload(drive_state, self._robot, self._rates,
                                      self._drive.allowed, clients, max_clients, summary,
                                      shoot_state, emergency_stop=estop)

    def _on_leave(self, client_id):
        with self._drive_lock:
            if self._drive.owner == client_id:
                self._drive.disconnect(client_id, time.monotonic())
                self._publish_twist(0.0, 0.0)
                self.get_logger().warning('page %d disconnected while driving: stopped' % client_id)
                self._send_drive_state(time.monotonic())
            if self._shoot.disconnect(client_id, time.monotonic()):
                self._drop_pending_tilt()
                self._publish_launcher_stop()
                self.get_logger().warning(
                    'page %d disconnected while using the launcher: roller stopped' % client_id)
                self._send_shoot_state(time.monotonic())

    def _on_arbiter(self, msg):
        status = arbiter_status(msg)
        now = time.monotonic()
        with self._drive_lock:
            if msg.mechanism == 'drive' and self._drive_topic:
                self._arbiter_at = now
                was_active = self._drive.active
                self._drive.set_arbiter(status, now)
                self._after_drive_change(was_active, now)
            elif msg.mechanism == 'launcher' and self._shoot_enabled:
                was_active = self._shoot.active
                self._shoot.set_arbiter(status, now)
                self._after_shoot_change(was_active, now)

    def _on_motion_permission(self, msg):
        with self._drive_lock:
            self._motion = {'drive': bool(msg.drive_allowed), 'launcher': bool(msg.launcher_allowed)}
            self._motion_at = time.monotonic()

    def _motion_allows(self, kind, now):
        """Whether a fresh /motion_permission allows ``kind`` ("drive" / "launcher")."""
        return self._motion[kind] and now - self._motion_at <= _MOTION_PERMISSION_LEASE_SEC

    def _after_drive_change(self, was_active, now):
        """Stop at once if the run just ended; tell the pages. Holds the lock."""
        if was_active and not self._drive.active:
            self._publish_twist(0.0, 0.0)
            self.get_logger().warning('drive run ended: %s' % self._drive.last_stop['reason'])
        self._send_drive_state(now)

    def _on_drive_tick(self):
        now = time.monotonic()
        with self._drive_lock:
            was_active = self._drive.active
            if now - self._arbiter_at > _ARBITER_STATUS_TIMEOUT_SEC:
                self._drive.set_arbiter(None, now)  # the arbiter is gone (or never ran)
            self._drive.set_motion_permission(self._motion_allows('drive', now), now)
            command = self._drive.tick(now)
            if was_active and not self._drive.active:
                self.get_logger().warning(
                    'drive run ended: %s' % self._drive.last_stop['reason'])
            if command is not None:
                self._publish_twist(*command)
            self._send_drive_state(now)

    def _check_graph(self):
        me = (self.get_name(), self.get_namespace())

        def others(infos):
            return [info.node_namespace.rstrip('/') + '/' + info.node_name for info in infos
                    if (info.node_name, info.node_namespace) != me]
        if self._drive_topic:
            publishers = others(self.get_publishers_info_by_topic(self._drive_topic))
            subscribers = others(self.get_subscriptions_info_by_topic(self._drive_topic))
            with self._drive_lock:
                was_active = self._drive.active
                self._drive.set_graph(publishers, subscribers, time.monotonic())
                if was_active and not self._drive.active:
                    self._publish_twist(0.0, 0.0)
                    self.get_logger().warning('drive stopped: another node publishes %s (%s)' % (
                        self._drive_topic, ', '.join(publishers)))
        if self._shoot_enabled:
            publishers = others(self.get_publishers_info_by_topic(self._launcher_topic))
            arbiter = others(self.get_subscriptions_info_by_topic(self._launcher_topic))
            now = time.monotonic()
            with self._drive_lock:
                was_active = self._shoot.active
                self._shoot.set_graph(publishers, arbiter, now)
                self._after_shoot_change(was_active, now)

    def _on_estop(self, msg):
        self._set_estop('topic', bool(msg.active))
        payload = messages.estop_payload(msg, self._now())
        self._latest_estop = messages.encode(payload)
        self._latest_estop_at = time.monotonic()
        self._relay('estop', lambda: payload)

    def _set_estop(self, source, active):
        """Record one E-stop report; only source 'topic' (/emergency_stop) makes the state known."""
        now = time.monotonic()
        with self._drive_lock:
            self._estop[source] = active
            pressed = any(self._estop.values())
            was_active = self._drive.active
            # Pressed first, then known: a session never runs between the two.
            self._drive.set_emergency_stop(pressed, now)
            if source == 'topic':
                self._estop_known = True
                self._drive.set_estop_known(True, now)
            if was_active and not self._drive.active:
                self._publish_twist(0.0, 0.0)
            was_active = self._shoot.active
            self._shoot.set_emergency_stop(pressed, now)
            if source == 'topic':
                self._shoot.set_estop_known(True, now)
            self._after_shoot_change(was_active, now)

    def _publish_twist(self, linear, angular):
        if self._drive_publisher is None:
            return
        msg = Twist()
        msg.linear.x = float(linear)
        msg.angular.z = float(angular)
        self._drive_publisher.publish(msg)

    def _send_drive_state(self, now):
        """Broadcast drive_state on a change, and at least every _DRIVE_STATE_PERIOD_SEC."""
        if (self._drive.version == self._drive_sent_version
                and now - self._drive_sent_at < _DRIVE_STATE_PERIOD_SEC):
            return
        self._drive_sent_version = self._drive.version
        self._drive_sent_at = now
        self._server.publish('drive_state', self._drive_state_text())

    # --- the launcher from the pages --------------------------------------------------------
    # Same threading as driving: every access to the ShootSession holds _drive_lock, and a
    # session that ends publishes roller 0 at once, not at the next tick.

    def _shoot_state_text(self, now):
        return messages.encode(messages.shoot_state_payload(self._shoot.state(now)))

    def _on_shoot_request(self, client_id, request):
        now = time.monotonic()
        kind = request[0]
        refused = None
        with self._drive_lock:
            was_owner = self._shoot.owner
            if kind == 'roller_stop':
                if self._shoot.stop(client_id, now):
                    self._publish_launcher_stop()
                    self.get_logger().info('roller stopped by page %d' % client_id)
            elif kind == 'roller':
                before = self._shoot.power
                refused = self._shoot.roller(client_id, request[1], now)
                if refused is None and self._shoot.power != before:
                    self._publish_launcher(self._shoot.command())  # at once, not at the tick
            elif kind == 'tilt':
                refused, deg = self._shoot.tilt_to(client_id, request[1], now)
                if deg is not None:
                    self._send_tilt(deg, now)
            else:
                refused = self._shoot.fire(client_id, request[1], now)
                if refused is None:
                    self._publish_launcher(self._shoot.command())
                    self.get_logger().info('page %d asks for one disc (roller %.2f, tilt %s)' % (
                        client_id, self._shoot.power, self._shoot.tilt))
            if was_owner == client_id and not self._shoot.active and kind != 'roller_stop':
                self._publish_launcher_stop()  # e.g. a non-finite value ended the session
            if not self._shoot.active:
                self._drop_pending_tilt()  # roller_stop, or a request that ended the session
            if self._shoot.owner == client_id and was_owner is None:
                self.get_logger().info('page %d operates the launcher' % client_id)
            if refused is not None:
                # Only the asking page hears why, at once.
                self._server.publish_to(client_id, 'shoot_refused', messages.encode(
                    messages.shoot_refused_payload(refused, kind, self._shoot.state(now))))
            self._send_shoot_state(now)

    def _on_roller_status(self, msg):
        self._on_launcher_status('roller', msg, ShootSession.set_roller_status)

    def _on_shot_status(self, msg):
        self._on_launcher_status('shot', msg, ShootSession.set_shot_status)

    def _on_launcher_status(self, name, msg, feed):
        stamp = self._now()
        if self._shoot_enabled:
            try:
                status = json.loads(msg.data)
            except ValueError:
                status = None  # ignored: the status then goes stale (no_launcher)
            now = time.monotonic()
            with self._drive_lock:
                was_active = self._shoot.active
                feed(self._shoot, status, now)
                self._after_shoot_change(was_active, now)
        self._relay(name, lambda: messages.launcher_status_payload(name, msg.data, stamp))

    def _on_shoot_tick(self):
        now = time.monotonic()
        with self._drive_lock:
            was_active = self._shoot.active
            # Shown to the pages; the launcher nodes enforce the motion permission themselves.
            self._shoot.set_motion_permission(self._motion_allows('launcher', now), now)
            command = self._shoot.tick(now, _ARBITER_STATUS_TIMEOUT_SEC)
            self._after_shoot_change(was_active, now)
            # A kept tilt only for the session that asked, still running and unblocked.
            deg = self._tilt.due(self._shoot.session_token(), bool(self._shoot.blockers()), now)
            if deg is not None:
                self._shoot.set_tilt(deg)
                command = self._shoot.command()
            if command is not None:
                self._publish_launcher(command)

    def _send_tilt(self, deg, now):
        """Send a tilt target now, or keep it (with its session) for a tick if the last was too recent."""
        deg = self._tilt.request(deg, self._shoot.session_token(), now)
        if deg is not None:
            self._shoot.set_tilt(deg)
            self._publish_launcher(self._shoot.command())

    def _drop_pending_tilt(self):
        """Forget a coalesced tilt: its session ended (every session-ending path calls this)."""
        self._tilt.drop()

    def _after_shoot_change(self, was_active, now):
        """Stop the roller at once if the session just ended; tell the pages. Holds the lock."""
        if was_active and not self._shoot.active:
            self._drop_pending_tilt()
            self._publish_launcher_stop()
            self.get_logger().warning(
                'launcher session ended: %s' % self._shoot.last_stop['reason'])
        self._send_shoot_state(now)

    def _publish_launcher(self, command):
        """Publish ``(power, tilt or None, fire_seq)`` as a LauncherCommand from the lab."""
        if self._launcher_publisher is None:
            return
        power, tilt, fire_seq = command
        msg = LauncherCommand()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.roller_power = float(power)
        msg.tilt_deg = float(tilt) if tilt is not None else math.nan
        msg.tilt_steps = 0  # QUESTiX LAB asks for a tilt target, never steps
        msg.fire_seq = int(fire_seq) & 0xFFFFFFFF
        msg.source = 'lab'
        self._launcher_publisher.publish(msg)

    def _publish_launcher_stop(self):
        """Roller 0, no tilt target, no new shot: the lab's stop."""
        self._publish_launcher((0.0, None, self._shoot.fire_seq))

    def _send_shoot_state(self, now):
        """Broadcast shoot_state on a change, and at least every _DRIVE_STATE_PERIOD_SEC."""
        if (self._shoot.version == self._shoot_sent_version
                and now - self._shoot_sent_at < _DRIVE_STATE_PERIOD_SEC):
            return
        self._shoot_sent_version = self._shoot.version
        self._shoot_sent_at = now
        self._server.publish('shoot_state', self._shoot_state_text(now))

    def _on_status(self):
        rates = {name: count / _STATUS_PERIOD_SEC for name, count in self._counts.items()}
        for name in self._counts:
            self._counts[name] = 0
        self._rates = rates
        self._server.publish('status', messages.encode(messages.status_payload(rates)))
        if self._recorder is not None:
            self._recorder.tick(time.monotonic(), lab_active=self._drive.active)

    def _stop_all(self):
        """End any driving run and launcher session and publish their stop; return if any."""
        with self._drive_lock:
            stopped = self._drive.stop(None, time.monotonic())
            if stopped:
                self._publish_twist(0.0, 0.0)
            if self._shoot.stop(None, time.monotonic()):
                self._publish_launcher_stop()
                stopped = True
            self._drop_pending_tilt()
        return stopped

    def destroy_node(self):
        # Stop at once, then again once the pages are closed (closing waits for them, and a
        # request may have started a new run in between).
        self._closing = True  # pages' requests are ignored from now on
        stopped = self._stop_all()
        self._server.stop()
        if self._stop_all() or stopped:
            time.sleep(0.1)  # let the stop leave before the process exits
        if self._recorder is not None:
            self._recorder.flush(time.monotonic())
            self._record_writer.shutdown(wait=True)
        super().destroy_node()


def _interrupt(_signum, _frame):
    raise KeyboardInterrupt


def main(args=None):
    # rclpy's own SIGINT/SIGTERM handler shuts the context down before destroy_node() runs, so
    # the final stop (drive 0, roller 0) could not be published any more. Without it, Ctrl+C and
    # robot_manager's SIGINT and SIGTERM end spin() with KeyboardInterrupt while the context is
    # still valid; the 20 Hz timers bring spin() back to Python quickly. Installed explicitly: a
    # shell starting the node in the background leaves SIGINT ignored.
    rclpy.init(args=args, signal_handler_options=SignalHandlerOptions.NO)
    signal.signal(signal.SIGINT, _interrupt)
    signal.signal(signal.SIGTERM, _interrupt)
    node = LabBridgeNode()
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
