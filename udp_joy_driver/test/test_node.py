"""Exercise real loopback UDP, ROS topics, ACK destinations and receive cost."""

import json
import os
import socket
import threading
import time

import pytest

rclpy = pytest.importorskip('rclpy')
from rclpy.context import Context
from rclpy.executors import SingleThreadedExecutor
from rclpy.node import Node
from rclpy.parameter import Parameter
from questix_msgs.msg import ActuationAuthority
from sensor_msgs.msg import Joy

from udp_joy_driver.packet import status_ack
from udp_joy_driver.udp_joy_driver_node import UdpJoyDriver


class MeasuredDriver(UdpJoyDriver):
    """Measure socket receipt (the injected accept clock) to completed publication."""

    def __init__(self, **kwargs):
        self.samples = []
        super().__init__(**kwargs)

    def publish_locked(self, now):
        super().publish_locked(now)
        if threading.current_thread() is getattr(self, 'worker', None):
            self.samples.append((time.monotonic() - self.state.last_packet) * 1000)


@pytest.fixture
def ros(monkeypatch, tmp_path):
    monkeypatch.setenv('ROS_AUTOMATIC_DISCOVERY_RANGE', 'LOCALHOST')
    monkeypatch.setenv('ROS_LOG_DIR', str(tmp_path))
    context = Context()
    rclpy.init(context=context, domain_id=231)
    yield context
    context.try_shutdown()


def parameters(**extra):
    return [Parameter(k, value=v) for k, v in dict(local_address='127.0.0.1',
        peer_address='127.0.0.2', **extra).items()]


@pytest.mark.parametrize('extra', [dict(local_address=''), dict(local_address='0.0.0.0'),
    dict(port=4999), dict(port=5010), dict(arm_button=8), dict(arm_button=14),
    dict(stop_button=-1), dict(message_timeout_sec=0.0)])
def test_startup_rejected(ros, extra):
    p = dict(local_address='127.0.0.1', peer_address='127.0.0.2')
    p.update(extra)
    with pytest.raises((ValueError, TypeError)):
        UdpJoyDriver(context=ros, parameter_overrides=[Parameter(k, value=v) for k, v in p.items()])


def test_socket_topics_and_latency(ros, packet, tmp_path):
    driver = MeasuredDriver(context=ros, parameter_overrides=parameters())
    observer = Node('udp_observer', context=ros)
    joys, votes = [], []
    observer.create_subscription(Joy, '/joy', joys.append, 10)
    observer.create_subscription(ActuationAuthority, '/motion_vote/controller', votes.append, 10)
    executor = SingleThreadedExecutor(context=ros)
    executor.add_node(observer)
    executor.add_node(driver)
    sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sender.bind(('127.0.0.2', 5001))
    sender.settimeout(0.5)
    foreign = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    foreign.bind(('127.0.0.3', 0))
    seq = 0

    def wait_for(predicate, timeout=2.0):
        deadline = time.monotonic() + timeout
        while not predicate() and time.monotonic() < deadline:
            executor.spin_once(timeout_sec=0.005)
        assert predicate()

    def send(**kwargs):
        nonlocal seq
        seq += 1
        p = packet(seq=seq, **kwargs)
        sender.sendto(json.dumps(p).encode(), ('127.0.0.1', 5000))
        wait_for(lambda: driver.state.seq == seq)
        return p

    try:
        wait_for(lambda: joys and votes)
        assert not votes[-1].drive_allowed and not any(joys[-1].axes)
        foreign.sendto(json.dumps(packet()).encode(), ('127.0.0.1', 5000))
        wait_for(lambda: driver.foreign_packets == 1)
        p = send(kind='status')
        data, address = sender.recvfrom(64)
        assert data == status_ack(p) and address == ('127.0.0.1', 5000)
        sender.sendto(json.dumps(p).encode(), ('127.0.0.1', 5000))
        wait_for(lambda: driver.old_packets == 1)
        sender.settimeout(.03)
        with pytest.raises(socket.timeout):
            sender.recvfrom(64)
        sender.settimeout(.5)
        sender.sendto(b'{}', ('127.0.0.1', 5000))
        wait_for(lambda: driver.invalid_packets == 1)
        send(buttons=0x400)  # A held HOME at startup must leave OFF.
        assert driver.state.mode == 'OFF'
        send()  # Observe HOME released before accepting its rising edge.
        send(buttons=0x400)  # HOME
        wait_for(lambda: votes[-1].drive_allowed)
        send(x=32767)  # held stick cannot release neutral latch
        wait_for(lambda: driver.state.needs_neutral)
        send()
        send(x=32767)
        wait_for(lambda: joys[-1].axes[0] == -1)
        wait_for(lambda: not votes[-1].drive_allowed, timeout=1.0)
        assert not any(joys[-1].axes)
        send(x=32767)
        wait_for(lambda: votes[-1].drive_allowed)
        assert driver.state.needs_neutral
        send()
        send(x=32767)
        wait_for(lambda: joys[-1].axes[0] == -1)
        send(buttons=0x20)  # BACK
        wait_for(lambda: not votes[-1].drive_allowed)
        send(buttons=0x400)
        assert driver.state.mode == 'STOPPED'
        # ACK follows source port, independent of the sender's old/new port convention.
        sender.close()
        sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sender.bind(('127.0.0.2', 5000))
        sender.settimeout(0.5)
        p = send(kind='status')
        assert sender.recvfrom(64)[0] == status_ack(p)
        results = {}
        for rate in (0, 100):
            cpu, start = time.process_time(), time.monotonic()
            next_send = start
            end = start + 2.0
            driver.samples.clear()
            while time.monotonic() < end:
                if rate and time.monotonic() >= next_send:
                    send(x=16000)
                    next_send += 1.0 / rate
                executor.spin_once(timeout_sec=0.001)
            elapsed = time.monotonic() - start
            samples = sorted(driver.samples)
            results[str(rate)] = dict(cpu_percent=(time.process_time() - cpu) / elapsed * 100,
                samples=len(samples), median_ms=samples[len(samples) // 2] if samples else None,
                p99_ms=samples[min(len(samples) - 1, int(len(samples) * .99))] if samples else None)
        report = json.dumps(results, indent=2)
        print('\nUDP_BENCHMARK ' + report)
        output = os.environ.get('QUESTIX_UDP_BENCHMARK')
        if output:
            from pathlib import Path
            Path(output).write_text(report + '\n')
        assert results['100']['samples'] >= 190
        assert not driver.failed
    finally:
        sender.close()
        foreign.close()
        executor.shutdown()
        observer.destroy_node()
        driver.destroy_node()


def test_bind_failure_is_fatal(ros):
    occupied = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    occupied.bind(('127.0.0.1', 5000))
    try:
        with pytest.raises(OSError):
            UdpJoyDriver(context=ros, parameter_overrides=parameters())
    finally:
        occupied.close()


def test_packet_rate_warning_rearms_after_low_rate_or_silence(ros, monkeypatch):
    from unittest.mock import Mock
    driver = UdpJoyDriver(context=ros, parameter_overrides=parameters())
    logger = Mock()
    monkeypatch.setattr(driver, 'get_logger', lambda: logger)
    try:
        with driver.lock:
            driver.rate_start = 0.0
            for _ in range(100):
                driver.count_rate(.1)
            assert logger.warning.call_count == 0
            for _ in range(51):
                driver.count_rate(.2)
            assert logger.warning.call_count == 1
            # A continuous overload in the next window is the same episode.
            for _ in range(101):
                driver.count_rate(1.1)
            assert logger.warning.call_count == 1
            # Ten packets in a complete window ends the episode.
            for _ in range(10):
                driver.count_rate(2.1)
            driver.advance_rate_window(3.0)
            for _ in range(101):
                driver.count_rate(3.1)
            assert logger.warning.call_count == 2
            # A full silent window also rearms without requiring a low-rate packet first.
            for _ in range(101):
                driver.count_rate(5.2)
            assert logger.warning.call_count == 3
    finally:
        driver.destroy_node()


def test_receive_failure_stays_neutral_and_repeats_failed_log(ros, packet, monkeypatch):
    from unittest.mock import Mock
    import udp_joy_driver.udp_joy_driver_node as module
    fail = threading.Event()
    original_select = module.select.select

    def select_or_fail(*args):
        if fail.is_set():
            raise OSError('synthetic receiver fault')
        return original_select(*args)

    monkeypatch.setattr(module.select, 'select', select_or_fail)
    driver = UdpJoyDriver(context=ros, parameter_overrides=parameters())
    logger = Mock()
    monkeypatch.setattr(driver, 'get_logger', lambda: logger)
    observer = Node('udp_fault_observer', context=ros)
    joys, votes = [], []
    observer.create_subscription(Joy, '/joy', joys.append, 10)
    observer.create_subscription(ActuationAuthority, '/motion_vote/controller', votes.append, 10)
    executor = SingleThreadedExecutor(context=ros)
    executor.add_node(driver)
    executor.add_node(observer)

    def wait_for(predicate):
        deadline = time.monotonic() + 2
        while not predicate() and time.monotonic() < deadline:
            executor.spin_once(timeout_sec=.005)
        assert predicate()

    try:
        with driver.lock:
            now = time.monotonic()
            for seq, buttons, x in ((0, 0, 0), (1, 0x400, 0), (2, 0, 0), (3, 0, 16000)):
                p = packet(seq=seq, buttons=buttons, x=x)
                driver.state.accept(p, bytes.fromhex(p['raw']), now)
            driver.publish_locked(now)
        wait_for(lambda: votes and votes[-1].drive_allowed and joys and any(joys[-1].axes))
        fail.set()
        wait_for(lambda: driver.failed and votes and not votes[-1].drive_allowed
                 and not votes[-1].launcher_allowed and not any(joys[-1].axes)
                 and not any(joys[-1].buttons))
        driver.worker.join(timeout=1)
        assert not driver.worker.is_alive()
        driver.periodic()
        errors = logger.error.call_count
        driver.periodic()
        assert logger.error.call_count == errors
        # Advance only the fault-log lease, without sleeping or altering ROS clocks.
        driver.last_failed_log = time.monotonic() - 5.01
        driver.periodic()
        assert logger.error.call_count == errors + 1
        assert 'failed' in logger.error.call_args.args[0]
        assert driver.last_diagnostic[1] == 'receiver failed'
        # Repeated periodic callbacks keep the safe topic state after the worker is gone.
        driver.periodic()
        wait_for(lambda: not votes[-1].drive_allowed and not any(joys[-1].axes))
    finally:
        executor.shutdown()
        observer.destroy_node()
        driver.destroy_node()
