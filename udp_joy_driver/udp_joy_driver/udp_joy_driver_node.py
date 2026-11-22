"""Receive UDP in a select thread; serialize state and ROS publication with one lock."""

import ipaddress
import math
from pathlib import Path
import select
import socket
import threading
import time

from ament_index_python.packages import get_package_share_directory
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
from questix_msgs.msg import ActuationAuthority
from sensor_msgs.msg import Joy
import yaml

from .joy_map import neutral
from .link_state import LinkState
from .packet import parse_packet, status_ack


def validate_parameters(p):
    """Refuse unsafe endpoints, invalid rates and out-of-range button indices."""
    for key in ('local_address', 'peer_address'):
        address = ipaddress.IPv4Address(p[key])
        if address.is_unspecified or address.is_multicast or int(address) == 0xffffffff:
            raise ValueError(key + ' must be a specific unicast IPv4 address')
    if type(p['port']) is not int or not 5000 <= p['port'] <= 5009:
        raise ValueError('port must be 5000..5009')
    for key in ('publish_rate', 'message_timeout_sec', 'input_stale_sec'):
        if type(p[key]) not in (float, int) or not math.isfinite(p[key]) or p[key] <= 0:
            raise ValueError(key + ' must be finite and positive')
    if (type(p['deadzone']) not in (float, int) or not math.isfinite(p['deadzone'])
            or not 0 <= p['deadzone'] <= 0.99):
        raise ValueError('deadzone must be finite and in [0, 0.99]')
    for key in ('arm_button', 'stop_button'):
        if type(p[key]) is not int or not 0 <= p[key] < 14:
            raise ValueError(key + ' must be 0..13')
    if p['arm_button'] == p['stop_button']:
        raise ValueError('arm_button and stop_button must differ')
    if type(p['allow_rearm_after_stop']) is not bool:
        raise ValueError('allow_rearm_after_stop must be boolean')


class UdpJoyDriver(Node):
    """Publish neutral until HOME and fresh neutral input; BACK latches STOPPED."""

    def __init__(self, **kwargs):
        super().__init__('udp_joy_driver', **kwargs)
        own = Path(get_package_share_directory('udp_joy_driver')) / 'config'
        defaults = yaml.safe_load((own / 'udp_joy_driver_params.yaml').read_text())[
            'udp_joy_driver']['ros__parameters']
        profile = Path(get_package_share_directory('questix_control_config')) / 'config'
        defaults.update(yaml.safe_load((profile / 'controls.udp.yaml').read_text())[
            'udp_joy_driver']['ros__parameters'])
        p = {key: self.declare_parameter(key, value).value for key, value in defaults.items()}
        validate_parameters(p)
        self.peer = p['peer_address']
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            self.sock.bind((p['local_address'], p['port']))
            self.sock.setblocking(False)
        except OSError as exc:
            self.sock.close()
            self.get_logger().fatal(f'UDP bind failed: {exc}')
            raise
        self.lock = threading.Lock()
        self.state = LinkState(**{key: p[key] for key in (
            'deadzone', 'message_timeout_sec', 'input_stale_sec', 'arm_button',
            'stop_button', 'allow_rearm_after_stop')})
        qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                         durability=DurabilityPolicy.VOLATILE)
        self.joy_pub = self.create_publisher(Joy, '/joy', qos)
        self.vote_pub = self.create_publisher(ActuationAuthority, '/motion_vote/controller', qos)
        self.last_diagnostic = None
        self.foreign_packets = 0
        self.invalid_packets = 0
        self.old_packets = 0
        self.ack_count = 0
        self.rate_start = time.monotonic()
        self.rate_count = 0
        self.rate_warned = False
        self.failed = False
        self.last_failed_log = None
        self.quit = threading.Event()
        # No receive polling period: select wakes on input (20 ms only bounds shutdown).
        self.worker = threading.Thread(target=self.receive, name='udp-controller', daemon=True)
        self.timer = self.create_timer(1.0 / p['publish_rate'], self.periodic)
        self.get_logger().info('input_stale_sec applies only to HID; ignored for XInput')
        with self.lock:
            self.publish_locked(time.monotonic())
        self.worker.start()

    def publish_locked(self, now):
        if self.failed:
            axes, buttons = neutral()
            allowed = False
            diagnostic = (self.state.mode, 'receiver failed', True)
        else:
            axes, buttons, allowed, diagnostic = self.state.snapshot(now)
        joy = Joy()
        joy.header.stamp = self.get_clock().now().to_msg()
        joy.axes, joy.buttons = axes, buttons
        self.joy_pub.publish(joy)
        vote = ActuationAuthority()
        vote.header = joy.header
        vote.drive_allowed = vote.launcher_allowed = allowed
        vote.source = 'udp_joy_driver'
        self.vote_pub.publish(vote)
        if diagnostic != self.last_diagnostic:
            self.get_logger().info(f'Controller {diagnostic[0]}: '
                                   f'{diagnostic[1] or "link valid"}; '
                                   f'needs neutral={diagnostic[2]}')
            self.last_diagnostic = diagnostic

    def periodic(self):
        with self.lock:
            now = time.monotonic()
            self.advance_rate_window(now)
            self.publish_locked(now)
            if self.failed:
                self.log_failed_locked(now)

    def log_failed_locked(self, now):
        """Keep a latched receive failure visible without flooding the log."""
        if self.last_failed_log is None or now - self.last_failed_log >= 5.0:
            self.get_logger().error(
                'UDP receiver failed=true; input neutral and controller vote off; restart control')
            self.last_failed_log = now

    def advance_rate_window(self, now):
        """Rearm WARN after a healthy window, including a full silent window."""
        elapsed = now - self.rate_start
        if elapsed >= 1.0:
            if elapsed >= 2.0 or self.rate_count <= 100:
                self.rate_warned = False
            self.rate_count = 0
            self.rate_start += int(elapsed)

    def count_rate(self, now):
        self.advance_rate_window(now)
        self.rate_count += 1
        if self.rate_count > 100 and not self.rate_warned:
            self.get_logger().warning('UDP input exceeds 100 packets/s')
            self.rate_warned = True

    def receive(self):
        try:
            while not self.quit.is_set():
                if not select.select([self.sock], [], [], 0.02)[0]:
                    continue
                # Drain every queued datagram in arrival order, not one per wakeup.
                while not self.quit.is_set():
                    try:
                        data, source = self.sock.recvfrom(769)
                    except BlockingIOError:
                        break
                    now = time.monotonic()
                    with self.lock:
                        self.count_rate(now)
                    if source[0] != self.peer:
                        self.foreign_packets += 1
                        continue
                    try:
                        packet, raw = parse_packet(data)
                    except ValueError:
                        self.invalid_packets += 1
                        continue
                    with self.lock:
                        if not self.state.accept(packet, raw, now):
                            self.old_packets += 1
                            continue
                        self.publish_locked(time.monotonic())
                    ack = status_ack(packet)
                    if ack is not None:
                        try:
                            self.sock.sendto(ack, source)
                            self.ack_count += 1
                        except OSError as exc:
                            self.get_logger().warning(f'ACK send failed: {exc}')
        except Exception as exc:
            with self.lock:
                self.failed = True
                self.state.invalidate('receiver failed')
                now = time.monotonic()
                self.publish_locked(now)
                self.get_logger().error(f'UDP receiver failed: {exc}')
                self.log_failed_locked(now)

    def destroy_node(self):
        self.quit.set()
        self.worker.join(timeout=1.0)
        self.sock.close()
        return super().destroy_node()


def main(args=None):
    """Fail startup explicitly on invalid configuration or bind errors."""
    rclpy.init(args=args)
    node = None
    try:
        node = UdpJoyDriver()
        rclpy.spin(node)
    finally:
        if node is not None:
            node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
