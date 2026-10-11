"""Report /emergency_stop to Robot Manager (QUESTiX), read-only.

Started by robot_manager/estop_monitor.py under ``bash`` after sourcing ROS and the robot workspace
(the domain from launch.env), never by hand. It subscribes to questix_msgs/EmergencyStop on
``/emergency_stop`` with the publisher's QoS (reliable + transient_local + keep-last(1), see
questix_msgs/msg/EmergencyStop.msg) and writes one JSON line ``{"active": bool, "source": str,
"reason": str}`` to stdout when the state changes, and again at least every REPORT_PERIOD_SEC
while messages keep arriving, so the manager can tell a silent topic from a quiet one. It publishes
nothing and offers no services. It exits when stdin closes (the manager stops it) or the manager
is gone.

``Reporter`` and ``stdin_closed`` are ROS-free (tested in test_estop_monitor.py); ``main`` wires
them to rclpy.
"""

import json
import os
import select
import sys
import time

TOPIC = "/emergency_stop"
# operation_manager publishes every 100 ms; the manager calls the topic silent after
# estop_monitor.STALE_SEC without a line.
REPORT_PERIOD_SEC = 0.5
# Long reasons are cut: they are only shown to people.
MAX_TEXT = 200


class Reporter:
    """Decide which messages become a stdout line (a change, or one per period)."""

    def __init__(self, period=REPORT_PERIOD_SEC):
        """Report every change and otherwise at most one line per ``period`` seconds."""
        self.period = period
        self._last = None
        self._last_at = None

    def update(self, active, source, reason, now):
        """Return the JSON line to write for one message, or None to stay quiet."""
        state = (bool(active), str(source)[:MAX_TEXT], str(reason)[:MAX_TEXT])
        if state == self._last and now - self._last_at < self.period:
            return None
        self._last = state
        self._last_at = now
        return json.dumps({"active": state[0], "source": state[1], "reason": state[2]})


def stdin_closed(stdin):
    """Return True once the manager closed our stdin (EOF); never blocks."""
    ready, _, _ = select.select([stdin], [], [], 0.0)
    return bool(ready) and stdin.readline() == ""


def main():
    """Report /emergency_stop until stdin closes (see the module docstring)."""
    import signal

    import rclpy
    from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
    from questix_msgs.msg import EmergencyStop

    rclpy.init(args=[])
    node = rclpy.create_node(f"robot_manager_estop_monitor_{os.getpid()}",
                             enable_rosout=False, start_parameter_services=False)
    reporter = Reporter()
    parent = os.getppid()

    def on_message(msg):
        line = reporter.update(msg.active, msg.source, msg.reason, time.monotonic())
        if line is not None:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    qos = QoSProfile(depth=1, history=HistoryPolicy.KEEP_LAST,
                     reliability=ReliabilityPolicy.RELIABLE,
                     durability=DurabilityPolicy.TRANSIENT_LOCAL)
    node.create_subscription(EmergencyStop, TOPIC, on_message, qos)

    def closing(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, closing)
    try:
        while rclpy.ok() and os.getppid() == parent and not stdin_closed(sys.stdin):
            rclpy.spin_once(node, timeout_sec=0.2)
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()
