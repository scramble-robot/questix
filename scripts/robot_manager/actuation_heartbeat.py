"""Publish the teacher's permissions for a lesson robot (QUESTiX).

Started by robot_manager/actuation.py under ``bash`` after sourcing ROS and the robot workspace
(the domain from launch.env), never by hand. It publishes two questix_msgs/ActuationAuthority
messages at HEARTBEAT_HZ, both with reliable + volatile + keep-last(1) QoS (never
transient_local: nothing is latched), using the latest state read from stdin, one JSON line
``{"drive": bool, "launcher": bool, "lab_drive": bool, "lab_launcher": bool}`` per change:

* ``/actuation_authority``: the teacher's switches (``drive``, ``launcher``), the lesson mode's
  vote for the motion permission (operation_manager's MotionPermissionManager);
* ``/lab_permission``: QUESTiX LAB's lesson permissions (``lab_drive``, ``lab_launcher``), read by
  command_arbiter and the lab bridge. A lesson permission is published on only while the switch of
  the same kind is on.

Anything but a JSON ``true`` is off. Both are leases: their readers treat them as off a short time
after the last message (1.0 s), judged by their own monotonic clock. So when this process stops
for any reason (stdin EOF because the manager closed it or died, a crash, SIGKILL) the robot
stops within the lease. On EOF (and SIGTERM / SIGINT) it first publishes an explicit all-off a
few times, then exits.

``run`` is the ROS-free loop (tested in test_actuation.py); ``main`` wires it to rclpy.
"""

import json
import os
import select
import sys
import time

TOPIC = "/actuation_authority"
LAB_TOPIC = "/lab_permission"
HEARTBEAT_HZ = 5.0
# Explicit all-off messages sent before exiting (one per period).
FINAL_OFF_COUNT = 3
SOURCE = "robot_manager"
ALL_OFF = (False, False, False, False)


def parse_state(line):
    """Return ``(drive, launcher, lab_drive, lab_launcher)`` from one stdin line.

    Anything unexpected is all off, and a lesson permission is off while its switch is.
    """
    try:
        data = json.loads(line)
    except (TypeError, ValueError):
        return ALL_OFF
    if not isinstance(data, dict):
        return ALL_OFF
    drive = data.get("drive") is True
    launcher = data.get("launcher") is True
    return (drive, launcher, drive and data.get("lab_drive") is True,
            launcher and data.get("lab_launcher") is True)


def run(stdin, publish, now=time.monotonic, wait=None, parent_alive=None):
    """Publish the latest state every period until stdin closes; then publish all off.

    ``stdin`` is a text stream (one JSON line per change), ``publish(drive, launcher, lab_drive,
    lab_launcher)`` sends one message on each topic, ``wait(timeout)`` returns True when a line can be read without blocking (default:
    select on stdin), ``parent_alive()`` returns False once the manager is gone. Returns the
    number of messages published.
    """
    period = 1.0 / HEARTBEAT_HZ
    if wait is None:
        def wait(timeout):
            ready, _, _ = select.select([stdin], [], [], max(0.0, timeout))
            return bool(ready)
    if parent_alive is None:
        parent = os.getppid()

        def parent_alive():
            return os.getppid() == parent
    state = ALL_OFF
    sent = 0
    next_at = now()
    while True:
        remaining = next_at - now()
        if remaining <= 0.0:
            if not parent_alive():
                break
            publish(*state)
            sent += 1
            next_at += period
            if next_at < now():  # a stalled process never sends a burst to catch up
                next_at = now() + period
            continue
        if wait(remaining):
            line = stdin.readline()
            if not line:
                break  # EOF: the manager closed our stdin (all off) or went away
            state = parse_state(line)
            publish(*state)  # a change goes out at once, OFF above all
            sent += 1
            next_at = now() + period
    for _ in range(FINAL_OFF_COUNT):
        publish(*ALL_OFF)
        sent += 1
        time.sleep(period / 2.0)
    return sent


def main():
    """Publish on /actuation_authority and /lab_permission until stdin closes (module docstring)."""
    import signal

    import rclpy
    from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
    from questix_msgs.msg import ActuationAuthority

    rclpy.init()
    node = rclpy.create_node("robot_manager_actuation_authority")
    qos = QoSProfile(depth=1, history=HistoryPolicy.KEEP_LAST,
                     reliability=ReliabilityPolicy.RELIABLE,
                     durability=DurabilityPolicy.VOLATILE)
    publisher = node.create_publisher(ActuationAuthority, TOPIC, qos)
    lab_publisher = node.create_publisher(ActuationAuthority, LAB_TOPIC, qos)

    def message(stamp, drive, launcher):
        msg = ActuationAuthority()
        msg.header.stamp = stamp
        msg.drive_allowed = bool(drive)
        msg.launcher_allowed = bool(launcher)
        msg.source = SOURCE
        return msg

    def publish(drive, launcher, lab_drive, lab_launcher):
        stamp = node.get_clock().now().to_msg()
        publisher.publish(message(stamp, drive, launcher))
        lab_publisher.publish(message(stamp, lab_drive, lab_launcher))

    def closing(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, closing)
    try:
        run(sys.stdin, publish)
    except KeyboardInterrupt:
        for _ in range(FINAL_OFF_COUNT):
            publish(*ALL_OFF)
            time.sleep(0.5 / HEARTBEAT_HZ)
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()
