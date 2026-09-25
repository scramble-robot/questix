"""ROS 2 node: publish sensor_msgs/Joy from a browser-based virtual controller.

The node serves ``static/index.html`` over HTTP and accepts joy frames over a
WebSocket (see ``ws_server`` / ``joy_frame``). The latest frame is re-published
at ``publish_rate`` like ``uart_joy_driver``; when frames stop for longer than
``message_timeout_sec`` (Wi-Fi drop, backgrounded browser) a neutral Joy is
published so downstream nodes stop. Emergency-stop state from
``emergency_stop_topic`` is relayed to the page for display only; gating is
still done by ``joy_gate`` and the per-component E-stop subscribers.

Camera view: ``camera_topic`` (``sensor_msgs/CompressedImage``, JPEG or PNG)
is relayed to the page as binary WebSocket messages so the operator sees the
robot's view between the sticks. Frames are throttled to ``camera_max_fps``
and dropped for clients that cannot keep up; nothing is ever queued.
"""

import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import rclpy
from ament_index_python.packages import get_package_share_directory
from rclpy.node import Node
from rclpy.qos import (
    DurabilityPolicy,
    HistoryPolicy,
    QoSProfile,
    ReliabilityPolicy,
    qos_profile_sensor_data,
)
from sensor_msgs.msg import CompressedImage, Joy

from .joy_frame import (
    DEFAULT_NUM_AXES,
    DEFAULT_NUM_BUTTONS,
    HOLD_ACTIVE,
    HOLD_TIMEOUT,
    JoyHold,
    parse_frame,
)
from .ws_server import JoyWebSocketServer

try:
    from questix_msgs.msg import EmergencyStop
except ImportError:  # questix_msgs not built; E-stop display is optional
    EmergencyStop = None  # type: ignore[assignment,misc]

# Camera relay states reported to the page in the status message.
CAMERA_DISABLED = "disabled"  # camera_topic is ""
CAMERA_WAITING = "waiting"  # subscribed, no frame received yet
CAMERA_LIVE = "live"  # frames arriving
CAMERA_STALE = "stale"  # frames stopped for longer than camera_timeout_sec

# Magic bytes of the encodings a browser <img> can show. Anything else is
# logged and skipped instead of being pushed to the page.
_JPEG_SOI = b"\xff\xd8\xff"
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def image_encoding(data: bytes) -> Optional[str]:
    """Return ``"jpeg"``/``"png"`` from the leading bytes of ``data`` or ``None``."""
    if data.startswith(_JPEG_SOI):
        return "jpeg"
    if data.startswith(_PNG_SIGNATURE):
        return "png"
    return None


class WebJoyDriverNode(Node):
    """Bridge WebSocket joy frames to ``sensor_msgs/Joy``."""

    def __init__(self) -> None:
        """Declare parameters, start the WebSocket server and the publish timer."""
        super().__init__("web_joy_driver")

        self.declare_parameter("joy_topic", "/joy")
        self.declare_parameter("host", "0.0.0.0")
        self.declare_parameter("port", 8899)
        self.declare_parameter("auth_token", "")
        self.declare_parameter("publish_rate", 50.0)
        self.declare_parameter("message_timeout_sec", 0.5)
        self.declare_parameter("deadzone", 0.05)
        self.declare_parameter("num_axes", DEFAULT_NUM_AXES)
        self.declare_parameter("num_buttons", DEFAULT_NUM_BUTTONS)
        self.declare_parameter("ping_interval_sec", 1.0)
        self.declare_parameter("ping_timeout_sec", 2.0)
        self.declare_parameter("status_period_sec", 0.2)
        self.declare_parameter("close_timeout_sec", 1.0)
        self.declare_parameter("static_dir", "")
        self.declare_parameter("emergency_stop_topic", "/emergency_stop")
        self.declare_parameter("camera_topic", "/camera/image_raw/compressed")
        self.declare_parameter("camera_max_fps", 15.0)
        self.declare_parameter("camera_timeout_sec", 2.0)

        joy_topic = self.get_parameter("joy_topic").value
        host = self.get_parameter("host").value
        port = int(self.get_parameter("port").value)
        token = self.get_parameter("auth_token").value
        publish_rate = float(self.get_parameter("publish_rate").value)
        timeout_sec = float(self.get_parameter("message_timeout_sec").value)
        self._deadzone = float(self.get_parameter("deadzone").value)
        self._num_axes = int(self.get_parameter("num_axes").value)
        self._num_buttons = int(self.get_parameter("num_buttons").value)
        static_dir = self.get_parameter("static_dir").value
        estop_topic = self.get_parameter("emergency_stop_topic").value
        camera_topic = self.get_parameter("camera_topic").value
        camera_max_fps = float(self.get_parameter("camera_max_fps").value)
        self._camera_timeout = float(self.get_parameter("camera_timeout_sec").value)

        if publish_rate <= 0.0:
            raise ValueError("publish_rate must be > 0")
        if self._num_axes <= 0 or self._num_buttons <= 0:
            raise ValueError("num_axes and num_buttons must be > 0")
        if timeout_sec <= 0.0:
            self.get_logger().warning(
                "message_timeout_sec <= 0: neutral fallback on lost frames is DISABLED")

        self._hold = JoyHold(self._num_axes, self._num_buttons, timeout_sec)
        self._last_state: Optional[str] = None
        self._frame_count = 0
        self._estop_active: Optional[bool] = None
        self._estop_reason = ""
        self._estop_rx_time: Optional[float] = None
        self._camera_enabled = bool(camera_topic)
        self._camera_rx_time: Optional[float] = None
        self._camera_frames = 0
        self._camera_rejected = 0
        self._camera_encoding = ""

        self._publisher = self.create_publisher(Joy, joy_topic, 10)

        if estop_topic and EmergencyStop is not None:
            qos = QoSProfile(
                history=HistoryPolicy.KEEP_LAST,
                depth=1,
                reliability=ReliabilityPolicy.RELIABLE,
                durability=DurabilityPolicy.TRANSIENT_LOCAL,
            )
            self._estop_sub = self.create_subscription(
                EmergencyStop, estop_topic, self._on_emergency_stop, qos)
        elif estop_topic:
            self.get_logger().warning(
                "questix_msgs is unavailable; emergency stop state will not be shown")

        if camera_topic:
            # Best-effort matches both reliable and best-effort image publishers
            # (image_transport / usb_cam / camera_ros); a dropped frame is fine.
            self._camera_sub = self.create_subscription(
                CompressedImage, camera_topic, self._on_camera_image, qos_profile_sensor_data)

        index_html = self._load_index_html(static_dir)
        self._server = JoyWebSocketServer(
            host=host,
            port=port,
            index_html=index_html,
            on_frame=self._on_frame,
            on_release=self._on_release,
            status_provider=self._status,
            token=token,
            ping_interval_sec=float(self.get_parameter("ping_interval_sec").value),
            ping_timeout_sec=float(self.get_parameter("ping_timeout_sec").value),
            status_period_sec=float(self.get_parameter("status_period_sec").value),
            close_timeout_sec=float(self.get_parameter("close_timeout_sec").value),
            camera_max_fps=camera_max_fps,
            logger=_RclpyLoggerAdapter(self.get_logger()),
        )
        self._server.start()

        self._timer = self.create_timer(1.0 / publish_rate, self._publish)
        self.get_logger().info(
            "web_joy_driver listening on http://%s:%d/ (ws %s), publishing %s at %.1f Hz, "
            "timeout %.2fs, token %s"
            % (host, self._server.bound_port, "legacy" if self._server.legacy_api else "asyncio",
               joy_topic, publish_rate, timeout_sec, "set" if token else "NOT set"))
        if camera_topic:
            self.get_logger().info(
                "camera view relays %s (CompressedImage jpeg/png) at <= %.1f fps"
                % (camera_topic, camera_max_fps))
        else:
            self.get_logger().info("camera view disabled (camera_topic is empty)")

    # ------------------------------------------------------------------
    def _load_index_html(self, static_dir: str) -> bytes:
        if static_dir:
            base = Path(static_dir)
        else:
            base = Path(get_package_share_directory("web_joy_driver")) / "static"
        path = base / "index.html"
        try:
            return path.read_bytes()
        except OSError as exc:
            raise RuntimeError(f"cannot read controller page {path}: {exc}") from exc

    # Called from the WebSocket thread ---------------------------------
    def _on_frame(self, payload: Dict[str, Any]) -> None:
        axes, buttons = parse_frame(payload, self._num_axes, self._num_buttons, self._deadzone)
        self._hold.update(axes, buttons, time.monotonic())
        self._frame_count += 1

    def _on_release(self) -> None:
        self._hold.release()

    def _camera_state(self, now: float) -> Tuple[str, Optional[int]]:
        if not self._camera_enabled:
            return CAMERA_DISABLED, None
        if self._camera_rx_time is None:
            return CAMERA_WAITING, None
        age = max(0.0, now - self._camera_rx_time)
        stale = self._camera_timeout > 0.0 and age > self._camera_timeout
        return (CAMERA_STALE if stale else CAMERA_LIVE), int(age * 1000.0)

    def _status(self) -> Dict[str, Any]:
        now = time.monotonic()
        age = self._hold.age_sec(now)
        _axes, _buttons, state = self._hold.snapshot(now)
        camera, camera_age_ms = self._camera_state(now)
        return {
            "camera": camera,
            "camera_age_ms": camera_age_ms,
            "camera_frames": self._camera_frames,
            "hold": state,
            "rx_age_ms": None if age is None else int(age * 1000.0),
            "timeout_ms": int(self._hold.timeout_sec * 1000.0),
            "frames": self._frame_count,
            "estop": self._estop_active,
            "estop_reason": self._estop_reason,
            "estop_age_ms": (None if self._estop_rx_time is None
                             else int((now - self._estop_rx_time) * 1000.0)),
        }

    # Called from the rclpy executor -----------------------------------
    def _on_emergency_stop(self, msg: Any) -> None:
        self._estop_active = bool(msg.active)
        self._estop_reason = str(msg.reason)
        self._estop_rx_time = time.monotonic()

    def _on_camera_image(self, msg: Any) -> None:
        data = bytes(msg.data)
        encoding = image_encoding(data)
        if encoding is None:
            # e.g. a compressedDepth / unsupported codec: log and skip, never push.
            self._camera_rejected += 1
            if self._camera_rejected <= 5 or self._camera_rejected % 100 == 0:
                self.get_logger().warning(
                    "ignored camera frame: unsupported encoding (format=%r, %d bytes), total %d"
                    % (msg.format, len(data), self._camera_rejected))
            return
        if self._camera_frames == 0:
            self.get_logger().info(
                "camera frames arriving: %s, %d bytes (format=%r)"
                % (encoding, len(data), msg.format))
        elif self._camera_encoding and encoding != self._camera_encoding:
            self.get_logger().info(
                "camera encoding changed: %s -> %s" % (self._camera_encoding, encoding))
        self._camera_encoding = encoding
        self._camera_frames += 1
        self._camera_rx_time = time.monotonic()
        self._server.push_camera_frame(data)

    def _publish(self) -> None:
        axes, buttons, state = self._hold.snapshot(time.monotonic())
        if state != self._last_state:
            if state == HOLD_TIMEOUT:
                self.get_logger().warning(
                    "no joy frame for %.2fs; publishing neutral" % self._hold.timeout_sec)
            elif state == HOLD_ACTIVE and self._last_state == HOLD_TIMEOUT:
                self.get_logger().info("joy frames resumed")
            elif state == HOLD_ACTIVE:
                self.get_logger().info("receiving joy frames")
            self._last_state = state
        msg = Joy()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = "web_joy"
        msg.axes = [float(v) for v in axes]
        msg.buttons = [int(v) for v in buttons]
        self._publisher.publish(msg)

    def destroy_node(self) -> bool:
        """Stop the WebSocket server before tearing the node down."""
        self._server.stop()
        return super().destroy_node()


class _RclpyLoggerAdapter:
    """Expose the ``logging``-style methods ``ws_server`` uses on an rclpy logger."""

    def __init__(self, logger: Any) -> None:
        self._logger = logger

    def info(self, fmt: str, *args: Any) -> None:
        self._logger.info(fmt % args if args else fmt)

    def warning(self, fmt: str, *args: Any) -> None:
        self._logger.warning(fmt % args if args else fmt)

    def error(self, fmt: str, *args: Any) -> None:
        self._logger.error(fmt % args if args else fmt)


def main(args: Optional[list] = None) -> None:
    """Run the node until interrupted."""
    rclpy.init(args=args)
    try:
        node = WebJoyDriverNode()
    except (OSError, RuntimeError, ValueError) as exc:
        # e.g. port already in use, unreadable index.html, invalid parameter
        rclpy.logging.get_logger("web_joy_driver").error(f"startup failed: {exc}")
        rclpy.shutdown()
        raise SystemExit(1) from exc
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
