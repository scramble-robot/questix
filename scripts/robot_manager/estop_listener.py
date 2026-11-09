"""Read-only robot status for QUESTiX Robot Manager.

One child subscribes to /emergency_stop (reliable, transient_local, keep-last(1)) and
/motion_permission (reliable, volatile, keep-last(1)). The ROS setup, ROBOT_WS and launch.env
ROS_DOMAIN_ID are shared. Each real message can produce a timestamped JSON line, immediately
on change or every 0.5 s otherwise. No timer repeats a cached value without a message.
The parent uses each topic's independent monotonic receive time and expires it after 1.5 s.
Stopping the robot, changing domain/workspace or losing the child clears both snapshots.
It publishes nothing and offers no services. Actuators retain all safety decisions.
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
        return json.dumps({"active": state[0], "source": state[1], "reason": state[2],
                           "received_at": now})


class PermissionReporter:
    """Report permission changes immediately and unchanged, received samples every 0.5 s."""

    def __init__(self, period=REPORT_PERIOD_SEC):
        """Keep independent throttling state for this topic only."""
        self.period = period
        self._last = None
        self._last_at = None

    def update(self, msg, now):
        """Return a report only in response to a real subscription callback."""
        state = {"mode": msg.mode, "drive_allowed": msg.drive_allowed,
                 "launcher_allowed": msg.launcher_allowed,
                 "drive_blockers": list(msg.drive_blockers),
                 "launcher_blockers": list(msg.launcher_blockers)}
        if state == self._last and now - self._last_at < self.period:
            return None
        self._last, self._last_at = state, now
        return json.dumps(dict(state, topic="/motion_permission", received_at=now),
                          allow_nan=False)


def stdin_closed(stdin):
    """Return True once the manager closed our stdin (EOF); never blocks."""
    ready, _, _ = select.select([stdin], [], [], 0.0)
    return bool(ready) and stdin.readline() == ""


def main():
    """Report /emergency_stop until stdin closes (see the module docstring)."""
    import signal

    import rclpy
    from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
    from questix_msgs.msg import EmergencyStop, MotionPermission

    rclpy.init(args=[])
    node = rclpy.create_node(f"robot_manager_estop_monitor_{os.getpid()}",
                             enable_rosout=False, start_parameter_services=False)
    reporter = Reporter()
    permission_reporter = PermissionReporter()
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

    def on_permission(msg):
        line = permission_reporter.update(msg, time.monotonic())
        if line is not None:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    permission_qos = QoSProfile(depth=1, history=HistoryPolicy.KEEP_LAST,
                                reliability=ReliabilityPolicy.RELIABLE,
                                durability=DurabilityPolicy.VOLATILE)
    node.create_subscription(MotionPermission, "/motion_permission", on_permission, permission_qos)

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
