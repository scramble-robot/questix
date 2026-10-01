"""The packaged parameter file keeps a bridge started by hand from moving the robot."""

from pathlib import Path
import re

CONFIG = Path(__file__).resolve().parents[1] / 'config' / 'lab_bridge.yaml'


def packaged(name):
    """Return the raw value of ``name`` in lab_bridge.yaml (read as text: no YAML dependency)."""
    values = re.findall(r'^\s+%s:\s*(\S+)' % re.escape(name), CONFIG.read_text(), re.M)
    assert len(values) == 1, '%s must be set exactly once in %s' % (name, CONFIG)
    return values[0]


def test_driving_and_launching_are_off_unless_passed_explicitly():
    # robot_manager always passes both (-p allow_drive:=... -p allow_shoot:=...); these
    # defaults only decide for `ros2 run` / `ros2 launch` by hand.
    assert packaged('allow_drive') == 'false'
    assert packaged('allow_shoot') == 'false'
