"""Measure only the receiver process, with the synthetic sender in a separate process."""

import json
import os
from pathlib import Path
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time


def worker(directory):
    import rclpy
    from rclpy.parameter import Parameter
    from udp_joy_driver.udp_joy_driver_node import UdpJoyDriver

    class MeasuredDriver(UdpJoyDriver):
        def __init__(self):
            self.samples = []
            self.traces = []
            super().__init__(parameter_overrides=[Parameter('local_address', value='127.0.0.1'),
                Parameter('peer_address', value='127.0.0.2')])

        def publish_locked(self, now):
            super().publish_locked(now)
            if threading.current_thread() is getattr(self, 'worker', None):
                published = time.monotonic()
                self.samples.append((published - self.state.last_packet) * 1000)
                self.traces.append((self.state.seq, published))

    rclpy.init()
    node = MeasuredDriver()
    results = {}
    try:
        for rate in (0, 100):
            node.samples.clear()
            node.traces.clear()
            (directory / 'phase').write_text(str(rate))
            start, cpu = time.monotonic(), time.process_time()
            while time.monotonic() - start < 3:
                rclpy.spin_once(node, timeout_sec=.02)
            elapsed = time.monotonic() - start
            samples = sorted(node.samples)
            results[str(rate)] = dict(cpu_percent=(time.process_time() - cpu) / elapsed * 100,
                samples=len(samples), median_ms=statistics.median(samples) if samples else None,
                p99_ms=samples[int(len(samples) * .99)] if samples else None,
                traces=node.traces[:])
        (directory / 'result.json').write_text(json.dumps(results, indent=2) + '\n')
    finally:
        node.destroy_node()
        rclpy.shutdown()


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--worker':
        worker(Path(sys.argv[2]))
        return
    with tempfile.TemporaryDirectory(prefix='questix-udp-bench-') as name:
        directory = Path(name)
        env = dict(os.environ, ROS_DOMAIN_ID='231', ROS_AUTOMATIC_DISCOVERY_RANGE='LOCALHOST')
        process = subprocess.Popen([sys.executable, __file__, '--worker', name], env=env)
        sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sender.bind(('127.0.0.2', 5001))
        seq = 0
        submitted = {}
        previous_phase = None
        started = time.monotonic()
        next_send = started
        try:
            while process.poll() is None:
                if time.monotonic() - started > 15:
                    raise TimeoutError('benchmark child did not finish')
                phase = (directory / 'phase').read_text() if (directory / 'phase').exists() else ''
                if phase != previous_phase:
                    next_send = time.monotonic()
                    previous_phase = phase
                if phase == '100' and time.monotonic() >= next_send:
                    seq += 1
                    raw = bytearray.fromhex('0014000000000040000000000000000000000000')
                    if seq <= 3:
                        raw[6:8] = b'\x00\x00'
                    if seq == 2:
                        raw[3] |= 4  # Released HOME, HOME, neutral release, then continuous motion.
                    packet = dict(v=3, type='input', seq=seq, ms=seq, connected=True,
                        protocol='xinput', vid='045e', pid='028e', addr=1, ep=1, raw=raw.hex(),
                        reports=seq, dropped=0, user_valid=False, user_age_ms=0xffffffff,
                        user_raw='00' * 32)
                    submitted[seq] = time.monotonic()
                    sender.sendto(json.dumps(packet).encode(), ('127.0.0.1', 5000))
                    next_send += .01
                time.sleep(.0005)
            if process.returncode:
                raise RuntimeError('benchmark child failed')
            measured = json.loads((directory / 'result.json').read_text())
            for values in measured.values():
                delivery = sorted((end - submitted[seq]) * 1000
                                  for seq, end in values.pop('traces') if seq in submitted)
                values['send_to_publish_median_ms'] = statistics.median(delivery) if delivery else None
                values['send_to_publish_p99_ms'] = delivery[int(len(delivery) * .99)] if delivery else None
            result = json.dumps(measured, indent=2) + '\n'
            print(result)
            if os.environ.get('QUESTIX_UDP_BENCHMARK'):
                Path(os.environ['QUESTIX_UDP_BENCHMARK']).write_text(result)
        finally:
            sender.close()
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=3)


if __name__ == '__main__':
    main()
