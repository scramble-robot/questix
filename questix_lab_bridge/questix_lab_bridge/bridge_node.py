"""ROS 2 node that mirrors robot telemetry to QUESTiX LAB pages over a WebSocket.

Without ``allow_drive`` observation only: the node creates subscriptions and nothing else,
and the WebSocket ignores everything a browser sends. With it, the node also publishes the
drive topic (``/target_twist/lab``, twist_arbiter's lab input) for pages that run a driving
experiment, under the rules of drive.DriveArbiter: nothing else may publish that topic, a node
must listen, the emergency stop must be released, one page at a time, speed limits, and a
dead-man timeout. twist_arbiter's status ends a run the controller takes over.

With ``allow_shoot`` it also publishes the launcher's lab inputs (``/roller/lab``,
``/shot/lab/tilt``, ``/shot/lab/fire``) for the pages' launcher experiments, under the rules of
shoot.ShootArbiter: the launcher nodes must listen and accept lab input, nothing else may publish
those topics, E-stop released, the controller not in use, one page at a time, a roller dead-man,
a power limit and the fire rules. ``/roller/status`` and ``/shot/status`` are mirrored to every
page either way (streams ``roller`` and ``shot``). Nothing else is ever published.

Records kept on the robot (records.py, records_api.py, rosbags.py) need no ROS interface of
their own: pages save and list them over the same port, the node records controller driving
from the payloads it already builds, and rosbags are read from files.
"""
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import json
import signal
import threading
import time

from geometry_msgs.msg import Twist
from nav_msgs.msg import Odometry
from questix_msgs.msg import DriveStatus, EmergencyStop
import rclpy
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, qos_profile_sensor_data, ReliabilityPolicy
from rclpy.signals import SignalHandlerOptions
from rclpy.time import Time
from sensor_msgs.msg import CompressedImage, LaserScan
from std_msgs.msg import Empty, Float32, String
from tf2_ros import Buffer, TransformException, TransformListener

from . import messages, records, rosbags
from .drive import DriveArbiter
from .records_api import RecordsApi
from .shoot import ShootArbiter
from .static_site import find_lab_dir
from .ws_server import LabWebSocketServer

_STATUS_PERIOD_SEC = 1.0
# How often the ROS graph is checked for other publishers / the drive node.
_GRAPH_PERIOD_SEC = 0.5
# drive_state is repeated this often even without a change, so a page notices a dead bridge.
_DRIVE_STATE_PERIOD_SEC = 1.0
# questix_msgs/README.md: /emergency_stop is reliable + transient_local, keep-last 1.
# How long a run may wait for twist_arbiter to hand it the robot before the controller is
# considered to hold it (a stick not at rest when the run started).
_ARBITER_GRACE_SEC = 0.5
# Browser requests handled by the ShootArbiter (messages.parse_request).
_SHOOT_REQUESTS = ('roller', 'roller_stop', 'tilt', 'fire')
# Least time between two tilt commands (shot_component refuses closer than 50 ms).
_TILT_GAP_SEC = 0.06
_ESTOP_QOS = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                        durability=DurabilityPolicy.TRANSIENT_LOCAL)


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
        wheel_radius = self.declare_parameter('wheel_radius', 0.1).value
        wheel_separation = self.declare_parameter('wheel_separation', 0.5).value

        # Driving from the pages (off unless allow_drive; see drive.py for every rule).
        allow_drive = bool(self.declare_parameter('allow_drive', False).value)
        # twist_arbiter's lab input: the controller keeps its own, and the arbiter decides.
        self._drive_topic = self.declare_parameter('drive_topic', '/target_twist/lab').value
        arbiter_topic = self.declare_parameter(
            'arbiter_status_topic', '/twist_arbiter/status').value
        self._arbiter_status = None
        estop_topic = self.declare_parameter('emergency_stop_topic', '/emergency_stop').value
        drive_rate = self.declare_parameter('drive_rate_hz', 20.0).value
        self._drive_lock = threading.Lock()
        self._drive = DriveArbiter(
            allowed=allow_drive and bool(self._drive_topic),
            max_linear=self.declare_parameter('drive_max_linear', 0.3).value,
            max_angular=self.declare_parameter('drive_max_angular', 1.0).value,
            deadman_sec=self.declare_parameter('drive_deadman_sec', 0.5).value,
            max_run_sec=self.declare_parameter('drive_max_run_sec', 30.0).value)
        self._drive_sent_version = -1
        self._drive_sent_at = 0.0
        # The launcher from the pages (off unless allow_shoot; see shoot.py for every rule).
        allow_shoot = bool(self.declare_parameter('allow_shoot', False).value)
        self._shoot_topics = {
            'roller': self.declare_parameter('roller_lab_topic', '/roller/lab').value,
            'tilt': self.declare_parameter('tilt_lab_topic', '/shot/lab/tilt').value,
            'fire': self.declare_parameter('fire_lab_topic', '/shot/lab/fire').value,
        }
        shoot_rate = self.declare_parameter('shoot_rate_hz', 20.0).value
        self._shoot = ShootArbiter(
            allowed=(allow_shoot and all(self._shoot_topics.values())
                     and bool(topics['roller']) and bool(topics['shot'])),
            max_power=self.declare_parameter('shoot_max_power', 0.8).value,
            tilt_min=self.declare_parameter('shoot_tilt_min', 0.0).value,
            tilt_max=self.declare_parameter('shoot_tilt_max', 120.0).value,
            fire_interval_sec=self.declare_parameter('shoot_fire_interval_sec', 2.0).value,
            deadman_sec=self.declare_parameter('shoot_deadman_sec', 0.5).value,
            max_spin_sec=self.declare_parameter('shoot_max_spin_sec', 30.0).value)
        self._shoot_sent_version = -1
        self._shoot_sent_at = 0.0
        # shot_component refuses tilts closer than 50 ms apart: faster requests are coalesced
        # (latest wins) and sent at most every _TILT_GAP_SEC.
        self._tilt_pending = None
        self._tilt_sent_at = -1.0e9
        self._closing = False  # destroy_node() has begun
        # Either source reports an emergency stop: operation_manager's topic, or drive_component
        # itself in /drive_status (robots started without the GPIO safety path).
        self._estop = {'topic': False, 'drive': False}

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
        self._record_limiters = {}
        if auto_record and self._store.enabled:
            self._record_writer = ThreadPoolExecutor(1, thread_name_prefix='lab_records')
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
            streams, wheel_radius, wheel_separation, self._drive.allowed, self._robot,
            self._records.hello(),
            messages.shoot_hello(self._shoot.allowed, self._shoot.limits())))
        self._server = LabWebSocketServer(
            host, port, hello, max_clients, self.get_logger(), site_dir,
            greeting=self._greeting, on_message=self._on_browser, on_disconnect=self._on_leave,
            state_provider=self._state, records=self._records)

        self._drive_publisher = None
        if (self._drive.allowed or self._shoot.allowed) and estop_topic:
            self._estop_subscription = self.create_subscription(
                EmergencyStop, estop_topic, self._on_estop, _ESTOP_QOS)
        self._shoot_publishers = {}
        if self._shoot.allowed:
            self._shoot_publishers = {
                'roller': self.create_publisher(Float32, self._shoot_topics['roller'], 1),
                'tilt': self.create_publisher(Float32, self._shoot_topics['tilt'], 1),
                'fire': self.create_publisher(Empty, self._shoot_topics['fire'], 1),
            }
            self._shoot_timer = self.create_timer(1.0 / max(1.0, shoot_rate), self._on_shoot_tick)
        if self._drive.allowed:
            self._drive_publisher = self.create_publisher(Twist, self._drive_topic, 1)
            if arbiter_topic:
                self._arbiter_subscription = self.create_subscription(
                    String, arbiter_topic, self._on_arbiter, _ESTOP_QOS)
            self._drive_timer = self.create_timer(1.0 / max(1.0, drive_rate), self._on_drive_tick)
        if self._drive.allowed or self._shoot.allowed:
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
        may = ([self._drive_topic] if self._drive.allowed else []) + (
            list(self._shoot_topics.values()) if self._shoot.allowed else [])
        self.get_logger().info(
            'QUESTiX LAB bridge (%s) on ws://%s:%d, streams: %s'
            % ('may publish %s' % ', '.join(may) if may else 'read-only',
               host, self._server.port, ', '.join(sorted(self._counts)) or 'none'))
        if allow_shoot and not self._shoot.allowed:
            self.get_logger().warning(
                'allow_shoot is set, but a launcher topic parameter is empty: launcher off')
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
        """Save a finished auto record on the writer thread (the ROS thread keeps going)."""
        self._record_writer.submit(self._save_auto_record, recording)

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
        if ((self._drive.allowed or self._shoot.allowed)
                and self._estop['drive'] != bool(msg.emergency_stop)):
            self._set_estop('drive', bool(msg.emergency_stop))
        self._relay('drive', lambda: messages.drive_payload(msg))

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
            return [messages.encode(messages.session_payload(client_id)), self._drive_state_text(),
                    self._shoot_state_text(time.monotonic())]

    def _on_browser(self, client_id, text):
        request = messages.parse_request(text)
        if request is None or self._closing:
            return
        if request[0] in _SHOOT_REQUESTS:
            if self._shoot.allowed:
                self._on_shoot_request(client_id, request)
            return
        if not self._drive.allowed:
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
        summary = dict(self._records.summary(), auto_record=self._recorder is not None)
        return messages.state_payload(drive_state, self._robot, self._rates,
                                      self._drive.allowed, clients, max_clients, summary,
                                      shoot_state)

    def _on_leave(self, client_id):
        with self._drive_lock:
            if self._drive.owner == client_id:
                self._drive.disconnect(client_id, time.monotonic())
                self._publish_twist(0.0, 0.0)
                self.get_logger().warning('page %d disconnected while driving: stopped' % client_id)
                self._send_drive_state(time.monotonic())
            if self._shoot.disconnect(client_id, time.monotonic()):
                self._publish_roller(0.0)
                self.get_logger().warning(
                    'page %d disconnected while using the launcher: roller stopped' % client_id)
                self._send_shoot_state(time.monotonic())

    def _on_arbiter(self, msg):
        try:
            status = json.loads(msg.data)
        except ValueError:
            return
        with self._drive_lock:
            self._arbiter_status = status if isinstance(status, dict) else None

    def _controller_has_robot(self, now):
        """Tell whether twist_arbiter has given the robot to the controller during our run.

        The arbiter switches to the lab on our first command; a run it has not switched to
        within _ARBITER_GRACE_SEC (the stick was held) or has switched away from (the stick
        moved) is over. Without an arbiter status (no arbiter running) nothing is decided here.
        """
        status = self._arbiter_status
        if status is None or not self._drive.active:
            return False
        if status.get('reason') == 'controller' and status.get('lab_locked'):
            return True
        return (status.get('active') != 'lab'
                and self._drive.run_seconds(now) > _ARBITER_GRACE_SEC)

    def _on_drive_tick(self):
        now = time.monotonic()
        with self._drive_lock:
            if self._controller_has_robot(now):
                self._drive.controller_took_over(now)
            was_active = self._drive.active
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
        if self._drive.allowed:
            publishers = others(self.get_publishers_info_by_topic(self._drive_topic))
            subscribers = others(self.get_subscriptions_info_by_topic(self._drive_topic))
            with self._drive_lock:
                was_active = self._drive.active
                self._drive.set_graph(publishers, subscribers, time.monotonic())
                if was_active and not self._drive.active:
                    self._publish_twist(0.0, 0.0)
                    self.get_logger().warning('drive stopped: another node publishes %s (%s)' % (
                        self._drive_topic, ', '.join(publishers)))
        if self._shoot.allowed:
            publishers = []
            for topic in self._shoot_topics.values():
                publishers += others(self.get_publishers_info_by_topic(topic))
            roller = others(self.get_subscriptions_info_by_topic(self._shoot_topics['roller']))
            fire = others(self.get_subscriptions_info_by_topic(self._shoot_topics['fire']))
            now = time.monotonic()
            with self._drive_lock:
                was_active = self._shoot.active
                self._shoot.set_graph(publishers, roller, fire, now)
                self._after_shoot_change(was_active, now)

    def _on_estop(self, msg):
        self._set_estop('topic', bool(msg.active))

    def _set_estop(self, source, active):
        now = time.monotonic()
        with self._drive_lock:
            self._estop[source] = active
            was_active = self._drive.active
            self._drive.set_emergency_stop(any(self._estop.values()), now)
            if was_active and not self._drive.active:
                self._publish_twist(0.0, 0.0)
            was_active = self._shoot.active
            self._shoot.set_emergency_stop(any(self._estop.values()), now)
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
    # Same threading as driving: every access to the ShootArbiter holds _drive_lock, and a
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
                    self._publish_roller(0.0)
                    self.get_logger().info('roller stopped by page %d' % client_id)
            elif kind == 'roller':
                before = self._shoot.power
                refused = self._shoot.roller(client_id, request[1], now)
                if refused is None and self._shoot.power != before:
                    self._publish_roller(self._shoot.power)  # at once, not at the next tick
            elif kind == 'tilt':
                refused, deg = self._shoot.tilt_to(client_id, request[1], now)
                if deg is not None:
                    self._send_tilt(deg, now)
            else:
                refused = self._shoot.fire(client_id, request[1], now)
                if refused is None:
                    self._shoot_publish('fire', Empty())
                    self.get_logger().info('page %d fires one disc (roller %.2f, tilt %s)' % (
                        client_id, self._shoot.power, self._shoot.tilt))
            if was_owner == client_id and not self._shoot.active and kind != 'roller_stop':
                self._publish_roller(0.0)  # e.g. a non-finite value ended the session
            if self._shoot.owner == client_id and was_owner is None:
                self.get_logger().info('page %d operates the launcher' % client_id)
            if refused is not None:
                # Only the asking page hears why, at once.
                self._server.publish_to(client_id, 'shoot_refused', messages.encode(
                    messages.shoot_refused_payload(refused, kind, self._shoot.state(now))))
            self._send_shoot_state(now)

    def _on_roller_status(self, msg):
        self._on_launcher_status('roller', msg, ShootArbiter.set_roller_status)

    def _on_shot_status(self, msg):
        self._on_launcher_status('shot', msg, ShootArbiter.set_shot_status)

    def _on_launcher_status(self, name, msg, feed):
        stamp = self._now()
        if self._shoot.allowed:
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
            power = self._shoot.tick(now)
            self._after_shoot_change(was_active, now)
            if power is not None:
                self._publish_roller(power)
            if self._tilt_pending is not None and now - self._tilt_sent_at >= _TILT_GAP_SEC:
                deg, self._tilt_pending = self._tilt_pending, None
                if not self._shoot.blockers():  # a blocker since: the request is void
                    self._send_tilt(deg, now)

    def _send_tilt(self, deg, now):
        """Publish a tilt now, or keep it for the next tick if the last one was too recent."""
        if now - self._tilt_sent_at < _TILT_GAP_SEC:
            self._tilt_pending = deg
            return
        self._tilt_pending = None
        self._tilt_sent_at = now
        self._shoot_publish('tilt', Float32(data=float(deg)))

    def _after_shoot_change(self, was_active, now):
        """Stop the roller at once if the session just ended; tell the pages. Holds the lock."""
        if was_active and not self._shoot.active:
            self._publish_roller(0.0)
            self.get_logger().warning(
                'launcher session ended: %s' % self._shoot.last_stop['reason'])
        self._send_shoot_state(now)

    def _shoot_publish(self, name, msg):
        publisher = self._shoot_publishers.get(name)
        if publisher is not None:
            publisher.publish(msg)

    def _publish_roller(self, power):
        self._shoot_publish('roller', Float32(data=float(power)))

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
                self._publish_roller(0.0)
                stopped = True
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
