"""ROS 2 node that mirrors robot telemetry to QUESTiX LAB pages over a WebSocket.

By default observation only: the node creates subscriptions and nothing else, and the
WebSocket ignores everything a browser sends. With ``allow_drive`` it also publishes the
drive topic (``/target_twist``) for pages that run a driving experiment, under the rules
of drive.DriveArbiter: nothing else may publish that topic, a drive node must listen, the
emergency stop must be released, one page at a time, speed limits, and a dead-man timeout.
"""
import threading
import time

from geometry_msgs.msg import Twist
from nav_msgs.msg import Odometry
from questix_msgs.msg import DriveStatus, EmergencyStop
import rclpy
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, qos_profile_sensor_data, ReliabilityPolicy
from rclpy.time import Time
from sensor_msgs.msg import CompressedImage, LaserScan
from tf2_ros import Buffer, TransformException, TransformListener

from . import messages
from .drive import DriveArbiter
from .static_site import find_lab_dir
from .ws_server import LabWebSocketServer

_STATUS_PERIOD_SEC = 1.0
# How often the ROS graph is checked for other publishers / the drive node.
_GRAPH_PERIOD_SEC = 0.5
# drive_state is repeated this often even without a change, so a page notices a dead bridge.
_DRIVE_STATE_PERIOD_SEC = 1.0
# questix_msgs/README.md: /emergency_stop is reliable + transient_local, keep-last 1.
_ESTOP_QOS = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                        durability=DurabilityPolicy.TRANSIENT_LOCAL)


class LabBridgeNode(Node):

    def __init__(self):
        super().__init__('questix_lab_bridge')
        host = self.declare_parameter('host', '0.0.0.0').value
        port = self.declare_parameter('port', 8897).value
        max_clients = self.declare_parameter('max_clients', 8).value
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
        }
        max_hz = {
            'scan': self.declare_parameter('scan_max_hz', 5.0).value,
            'odom': self.declare_parameter('odom_max_hz', 20.0).value,
            'drive': self.declare_parameter('drive_max_hz', 20.0).value,
            'twist': self.declare_parameter('twist_max_hz', 20.0).value,
            'camera': self.declare_parameter('camera_max_fps', 10.0).value,
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
        self._drive_topic = self.declare_parameter('drive_topic', '/target_twist').value
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
        # Either source reports an emergency stop: operation_manager's topic, or drive_component
        # itself in /drive_status (robots started without the GPIO safety path).
        self._estop = {'topic': False, 'drive': False}

        self._limiters = {name: messages.RateLimiter(hz) for name, hz in max_hz.items()}
        self._counts = {name: 0 for name, topic in topics.items() if topic}
        self._warned_camera_format = False

        streams = {name: (topic or None) for name, topic in topics.items()}
        hello = messages.encode(messages.hello_payload(
            streams, wheel_radius, wheel_separation, self._drive.allowed))
        self._server = LabWebSocketServer(
            host, port, hello, max_clients, self.get_logger(), site_dir,
            greeting=self._greeting, on_message=self._on_browser, on_disconnect=self._on_leave)

        self._drive_publisher = None
        if self._drive.allowed:
            self._drive_publisher = self.create_publisher(Twist, self._drive_topic, 1)
            if estop_topic:
                self._estop_subscription = self.create_subscription(
                    EmergencyStop, estop_topic, self._on_estop, _ESTOP_QOS)
            self._graph_timer = self.create_timer(_GRAPH_PERIOD_SEC, self._check_graph)
            self._drive_timer = self.create_timer(1.0 / max(1.0, drive_rate), self._on_drive_tick)
            self._check_graph()
        self._server.start()

        handlers = {
            'scan': (LaserScan, self._on_scan),
            'odom': (Odometry, self._on_odom),
            'drive': (DriveStatus, self._on_drive),
            'twist': (Twist, self._on_twist),
            'camera': (CompressedImage, self._on_camera),
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
        self.get_logger().info(
            'QUESTiX LAB bridge (%s) on ws://%s:%d, streams: %s'
            % ('may drive %s' % self._drive_topic if self._drive.allowed else 'read-only',
               host, self._server.port, ', '.join(sorted(self._counts)) or 'none'))
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
        self._counts[name] += 1
        if not (self._server.client_count and self._limiters[name].ready(self._now())):
            return
        try:
            payload = build()
        except (AttributeError, TypeError, ValueError) as error:
            # e.g. a questix_msgs build that predates a field: skip the message, keep the
            # other streams alive, and say why instead of taking the node down.
            self.get_logger().error(
                'cannot convert a %s message, skipping it: %r' % (name, error),
                throttle_duration_sec=10.0)
            return
        self._server.publish(name, payload)

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
        self._relay('scan', lambda: messages.encode(messages.scan_payload(
            msg, self._scan_max_points, self._mount(msg.header.frame_id))))

    def _on_odom(self, msg):
        self._relay('odom', lambda: messages.encode(messages.odom_payload(msg)))

    def _on_drive(self, msg):
        if self._drive.allowed and self._estop['drive'] != bool(msg.emergency_stop):
            self._set_estop('drive', bool(msg.emergency_stop))
        self._relay('drive', lambda: messages.encode(messages.drive_payload(msg)))

    def _on_twist(self, msg):
        self._relay('twist', lambda: messages.encode(messages.twist_payload(msg, self._now())))

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
            return [messages.encode(messages.session_payload(client_id)), self._drive_state_text()]

    def _on_browser(self, client_id, text):
        request = messages.parse_request(text)
        if request is None or not self._drive.allowed:
            return
        now = time.monotonic()
        with self._drive_lock:
            if request[0] == 'stop':
                if self._drive.stop(client_id, now):
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

    def _on_leave(self, client_id):
        with self._drive_lock:
            if self._drive.owner == client_id:
                self._drive.disconnect(client_id, time.monotonic())
                self._publish_twist(0.0, 0.0)
                self.get_logger().warning('page %d disconnected while driving: stopped' % client_id)
                self._send_drive_state(time.monotonic())

    def _on_drive_tick(self):
        now = time.monotonic()
        with self._drive_lock:
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
        publishers = others(self.get_publishers_info_by_topic(self._drive_topic))
        subscribers = others(self.get_subscriptions_info_by_topic(self._drive_topic))
        with self._drive_lock:
            was_active = self._drive.active
            self._drive.set_graph(publishers, subscribers, time.monotonic())
            if was_active and not self._drive.active:
                self._publish_twist(0.0, 0.0)
                self.get_logger().warning('drive stopped: another node publishes %s (%s)' % (
                    self._drive_topic, ', '.join(publishers)))

    def _on_estop(self, msg):
        self._set_estop('topic', bool(msg.active))

    def _set_estop(self, source, active):
        with self._drive_lock:
            self._estop[source] = active
            was_active = self._drive.active
            self._drive.set_emergency_stop(any(self._estop.values()), time.monotonic())
            if was_active and not self._drive.active:
                self._publish_twist(0.0, 0.0)

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

    def _on_status(self):
        rates = {name: count / _STATUS_PERIOD_SEC for name, count in self._counts.items()}
        for name in self._counts:
            self._counts[name] = 0
        self._server.publish('status', messages.encode(messages.status_payload(rates)))

    def destroy_node(self):
        with self._drive_lock:
            if self._drive.stop(None, time.monotonic()):
                self._publish_twist(0.0, 0.0)
        self._server.stop()
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = LabBridgeNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
