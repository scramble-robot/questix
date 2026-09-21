"""ROS 2 node that mirrors robot telemetry to QUESTiX LAB pages over a WebSocket.

Observation only: the node creates subscriptions and no publishers, services, or
actions, and the WebSocket ignores everything a browser sends.
"""
from geometry_msgs.msg import Twist
from nav_msgs.msg import Odometry
from questix_msgs.msg import DriveStatus
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import CompressedImage, LaserScan

from . import messages
from .static_site import find_lab_dir
from .ws_server import LabWebSocketServer

_STATUS_PERIOD_SEC = 1.0


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
        # Geometry is only reported to the page (it must match drive_component's values).
        wheel_radius = self.declare_parameter('wheel_radius', 0.1).value
        wheel_separation = self.declare_parameter('wheel_separation', 0.5).value

        self._limiters = {name: messages.RateLimiter(hz) for name, hz in max_hz.items()}
        self._counts = {name: 0 for name, topic in topics.items() if topic}
        self._warned_camera_format = False

        streams = {name: (topic or None) for name, topic in topics.items()}
        hello = messages.encode(messages.hello_payload(streams, wheel_radius, wheel_separation))
        self._server = LabWebSocketServer(
            host, port, hello, max_clients, self.get_logger(), site_dir)
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
            'QUESTiX LAB bridge (read-only) on ws://%s:%d, streams: %s'
            % (host, self._server.port, ', '.join(sorted(self._counts)) or 'none'))
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

    def _on_scan(self, msg):
        self._relay('scan', lambda: messages.encode(
            messages.scan_payload(msg, self._scan_max_points)))

    def _on_odom(self, msg):
        self._relay('odom', lambda: messages.encode(messages.odom_payload(msg)))

    def _on_drive(self, msg):
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

    def _on_status(self):
        rates = {name: count / _STATUS_PERIOD_SEC for name, count in self._counts.items()}
        for name in self._counts:
            self._counts[name] = 0
        self._server.publish('status', messages.encode(messages.status_payload(rates)))

    def destroy_node(self):
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
