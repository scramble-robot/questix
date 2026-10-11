"""The packaged parameter file holds no switch that lets a bridge move the robot by itself.

Whether QUESTiX LAB may drive or use the launcher is the teacher's lesson permission
(``/lab_permission``, from Robot Manager), judged by command_arbiter and the launcher nodes, plus
the robot's ``/motion_permission``; a bridge started by hand has no parameter that grants it.
"""

from pathlib import Path
import re

CONFIG = Path(__file__).resolve().parents[1] / 'config' / 'lab_bridge.yaml'


def values(name):
    """Return the raw values of ``name`` in lab_bridge.yaml (read as text: no YAML dependency)."""
    return [value.strip('"') for value in re.findall(
        r'^\s+%s:\s*(\S+)' % re.escape(name), CONFIG.read_text(), re.M)]


def packaged(name):
    found = values(name)
    assert len(found) == 1, '%s must be set exactly once in %s' % (name, CONFIG)
    return found[0]


def test_no_parameter_grants_driving_or_the_launcher():
    for name in ('allow_drive', 'allow_shoot', 'drive_max_linear', 'drive_max_angular'):
        assert values(name) == [], '%s was replaced by /lab_permission and the arbiter' % name


def test_the_permissions_come_from_their_topics():
    assert packaged('lab_permission_topic') == '/lab_permission'
    assert packaged('motion_permission_topic') == '/motion_permission'
    assert packaged('arbiter_status_topic') == '/command_arbiter/status'
    assert packaged('emergency_stop_topic') == '/emergency_stop'
