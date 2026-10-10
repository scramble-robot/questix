"""One-shot read of /emergency_stop and /motion_permission; imported only inside the ROS environment.

Prints one JSON object on stdout: ``{"emergency_stop": {...} | null, "motion_permission": {...} |
null}``. It subscribes, waits until both have been heard or the deadline passes, and exits; it
publishes nothing. /emergency_stop is latched (transient_local) and /motion_permission comes at
20 Hz, so a running robot answers well within the deadline once discovery is done.
"""

import json
import os
import time

DEADLINE_SEC = 3.0


def estop_dict(msg):
    """Return the fields of a questix_msgs/EmergencyStop the manager shows."""
    return {"active": bool(msg.active), "source": str(msg.source), "reason": str(msg.reason)}


def permission_dict(msg):
    """Return the fields of a questix_msgs/MotionPermission the manager shows."""
    return {
        "mode": str(msg.mode),
        "drive_allowed": bool(msg.drive_allowed),
        "launcher_allowed": bool(msg.launcher_allowed),
        "drive_blockers": [str(item) for item in msg.drive_blockers],
        "launcher_blockers": [str(item) for item in msg.launcher_blockers],
    }


def collect(spin_once, node, state, deadline_sec=DEADLINE_SEC, now=time.monotonic):
    """Spin until both entries of ``state`` are filled or the deadline passes."""
    deadline = now() + deadline_sec
    while now() < deadline and None in state.values():
        spin_once(node, timeout_sec=min(0.05, max(0.0, deadline - now())))
    return state


def main():
    """Read both topics once and print them as JSON, then release the ROS node."""
    import rclpy
    from questix_msgs.msg import EmergencyStop, MotionPermission
    from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy

    rclpy.init(args=[])
    node = None
    try:
        node = rclpy.create_node(f'questix_manager_motion_{os.getpid()}',
                                 enable_rosout=False, start_parameter_services=False)
        state = {"emergency_stop": None, "motion_permission": None}

        def on_estop(msg):
            state["emergency_stop"] = estop_dict(msg)

        def on_permission(msg):
            state["motion_permission"] = permission_dict(msg)

        node.create_subscription(
            EmergencyStop, "/emergency_stop", on_estop,
            QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                       durability=DurabilityPolicy.TRANSIENT_LOCAL))
        node.create_subscription(
            MotionPermission, "/motion_permission", on_permission,
            QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                       durability=DurabilityPolicy.VOLATILE))
        collect(rclpy.spin_once, node, state)
        print(json.dumps(state, allow_nan=False))
    finally:
        if node is not None:
            node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
