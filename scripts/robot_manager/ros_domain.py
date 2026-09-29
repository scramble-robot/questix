"""The ROS_DOMAIN_ID policy of a QUESTiX robot: which domain IDs a kit may use.

The single Python source for the allowed ranges. Standard library only, so it is imported both by
``scripts/resolve_ros_domain_id.py`` from the source checkout during kitting (before any Robot
Manager is installed) and by the installed Robot Manager (``robot_manager.ros_domain``).

The ranges keep every DDS/RTPS discovery port (7400 + 250 * domain_id [+ 2 for user traffic])
out of the standard Linux ephemeral port range (32768-60999); see
``ansible/playbooks/vars/README.md`` for the derivation. Copies that cannot import this module
repeat the values and are held to them by ``test_ros_domain.py``:
``ansible/playbooks/tasks/validate_ros_domain_id.yaml`` (Jinja), the robot launcher
(``systemd/questix_robot_launcher.sh`` and its Ansible copy), and the ``max`` of the settings
form in ``static/index.html``.
"""

import re

ALLOWED_RANGES = ((0, 101), (215, 232))
# Valid, but the bootstrap value of every image before kitting: kitting asks before keeping it.
LEGACY_DOMAIN_ID = 42
# For messages shown to people.
ALLOWED_TEXT = "0〜101 または 215〜232"

_INT_RE = re.compile(r"-?[0-9]+")


def is_allowed(value: int) -> bool:
    """Tell whether ``value`` lies in one of ALLOWED_RANGES."""
    return any(low <= value <= high for low, high in ALLOWED_RANGES)


def _unquote(raw) -> str:
    """Strip whitespace and one layer of matching quotes, as a shell reading launch.env would."""
    text = "" if raw is None else str(raw).strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        text = text[1:-1].strip()
    return text


def parse(raw) -> "int | None":
    """Return the allowed domain ID written in ``raw`` (a plain integer string), else None.

    Same reading as scripts/resolve_ros_domain_id.py (parse_strict_int): optional quotes, an
    optional minus sign, digits only.
    """
    if raw is None:
        return None
    text = _unquote(raw)
    if not _INT_RE.fullmatch(text):
        return None
    value = int(text)
    return value if is_allowed(value) else None


_EXPORT_RE = re.compile(r"[0-9]{1,3}")


def shell_export(raw) -> str:
    """Return ``export ROS_DOMAIN_ID=<n>; `` for a shell that must join the robot's domain.

    ``raw`` is ROS_DOMAIN_ID from launch.env as the robot service reads it. It is passed on as it
    is, even outside ALLOWED_RANGES (the robot runs in it anyway: the launcher only warns), so the
    lab bridge and the recorder always talk to the robot. Missing or empty means what the robot
    launcher then uses (``${ROS_DOMAIN_ID:-42}``): LEGACY_DOMAIN_ID. Anything else that is not a
    plain number of up to three digits gives "" (the shell keeps its own value) and is never
    pasted into a command.
    """
    text = _unquote(raw)
    if not text:
        text = str(LEGACY_DOMAIN_ID)
    return f"export ROS_DOMAIN_ID={text}; " if _EXPORT_RE.fullmatch(text) else ""
