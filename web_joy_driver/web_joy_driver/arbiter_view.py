"""command_arbiter's drive status as the page shows it (ROS-free, unit-tested).

command_arbiter publishes questix_msgs/ArbiterStatus on ``/command_arbiter/status`` (reliable +
volatile, 5 Hz and at once on a change), one message per mechanism; only lesson launches run it.
The page needs the drive's only: whether QUESTiX LAB has the robot now. Nothing is latched, so a
status older than STATUS_TIMEOUT_SEC means the arbiter is gone (or the launch is not a lesson).
"""

STATUS_TIMEOUT_SEC = 1.5
SOURCES = ("joy", "lab")


def drive_view(msg):
    """Return ``{"active", "reason", "lab_locked"}`` for the drive's status, else None.

    Raises ValueError for a drive status whose source is unknown (it is not shown).
    """
    if str(getattr(msg, "mechanism", "")) != "drive":
        return None  # the launcher's status: not this page's business
    active = str(msg.active_source)
    if active not in SOURCES:
        raise ValueError("unknown source %r" % (active,))
    return {"active": active, "reason": str(msg.switch_reason),
            "lab_locked": bool(msg.lab_locked)}


def fresh(view, received_at, now, timeout_sec=STATUS_TIMEOUT_SEC):
    """Return a copy of ``view`` while it is fresh, None once the arbiter fell silent."""
    if view is None or received_at is None or now - received_at > timeout_sec:
        return None
    return dict(view)
