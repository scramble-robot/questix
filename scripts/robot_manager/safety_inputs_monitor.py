"""Watch the raw GPIO safety inputs for Robot Manager (QUESTiX), read-only.

Started by robot_manager/safety_inputs.py under ``bash`` after sourcing ROS and the robot
workspace (the domain from launch.env), never by hand. It subscribes to gpio_reader's raw
std_msgs/Bool topics, publishes nothing and changes no parameter:

- ``/gpio_5``: the physical emergency-stop button (``true`` = pressed, ``false`` = released).
- ``/gpio_27``: AutoReferee ``AR_in``, the defeat signal used by competition launches
  (``false`` = defeated, ``true`` = not defeated, or AutoReferee not connected / not powered).

Every REPORT_PERIOD_SEC it writes one JSON line to stdout:
``{"pins": {"5": {"received": bool, "value": bool|null, "age_sec": float|null,
"publishers": int}, "27": {...}}}``. ``age_sec`` is measured on this process's monotonic clock
from the last message. It exits when stdin closes (the manager closed it or went away).

``PinWatch`` and ``run`` are ROS-free (tested in test_safety_inputs.py); ``main`` wires them to
rclpy.
"""

import json
import os
import select
import sys
import time

PINS = (5, 27)
REPORT_PERIOD_SEC = 0.25


def topic(pin):
    """Return gpio_reader's topic for ``pin`` (gpio_reader_component.cpp: ``gpio_<N>``)."""
    return f"/gpio_{pin}"


class PinWatch:
    """The last value of one raw GPIO topic and when it arrived (monotonic seconds)."""

    def __init__(self):
        """Start with nothing received."""
        self.value = None
        self.received_at = None

    def receive(self, value, now):
        """Record one message; anything but a bool is ignored."""
        if isinstance(value, bool):
            self.value = value
            self.received_at = now

    def report(self, now, publishers):
        """Return this pin's part of a report line."""
        if self.received_at is None:
            return {"received": False, "value": None, "age_sec": None,
                    "publishers": int(publishers)}
        return {"received": True, "value": self.value,
                "age_sec": round(max(0.0, now - self.received_at), 3),
                "publishers": int(publishers)}


def report_line(watches, now, publishers):
    """Return one JSON report line for ``watches`` ({pin: PinWatch})."""
    return json.dumps({"pins": {str(pin): watch.report(now, publishers(pin))
                                for pin, watch in watches.items()}}) + "\n"


def run(stdin, stdout, watches, spin, publishers, now=time.monotonic, stdin_closed=None,
        parent_alive=None):
    """Spin and report every REPORT_PERIOD_SEC until stdin closes or the manager is gone.

    ``spin(timeout)`` delivers pending messages to ``watches``, ``publishers(pin)`` counts the
    publishers of that pin's topic, ``stdin_closed()`` returns True once stdin reached EOF.
    Returns the number of lines written.
    """
    if stdin_closed is None:
        def stdin_closed():
            ready, _, _ = select.select([stdin], [], [], 0.0)
            return bool(ready) and not stdin.readline()
    if parent_alive is None:
        parent = os.getppid()

        def parent_alive():
            return os.getppid() == parent
    written = 0
    next_at = now()
    while parent_alive() and not stdin_closed():
        remaining = next_at - now()
        if remaining > 0.0:
            spin(remaining)
            continue
        try:
            stdout.write(report_line(watches, now(), publishers))
            stdout.flush()
        except (OSError, ValueError):
            break  # the manager stopped reading
        written += 1
        next_at += REPORT_PERIOD_SEC
        if next_at < now():  # a stalled process never writes a burst to catch up
            next_at = now() + REPORT_PERIOD_SEC
    return written


def main():
    """Report /gpio_5 and /gpio_27 until stdin closes (see the module docstring)."""
    import signal

    import rclpy
    from std_msgs.msg import Bool

    rclpy.init()
    node = rclpy.create_node("robot_manager_safety_inputs")
    watches = {pin: PinWatch() for pin in PINS}

    def subscribe(pin):
        def callback(msg):
            watches[pin].receive(bool(msg.data), time.monotonic())
        # gpio_reader publishes with the default QoS (reliable, volatile, depth 10).
        return node.create_subscription(Bool, topic(pin), callback, 10)

    subscriptions = [subscribe(pin) for pin in PINS]  # noqa: F841 (kept alive)

    def closing(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, closing)
    try:
        run(sys.stdin, sys.stdout, watches,
            lambda timeout: rclpy.spin_once(node, timeout_sec=timeout),
            lambda pin: node.count_publishers(topic(pin)))
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()
