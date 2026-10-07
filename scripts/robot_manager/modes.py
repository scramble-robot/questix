"""The robot's three modes, defined once for Robot Manager (stdlib only).

``/etc/questix_robot/mode`` holds one of them; Robot Manager writes it (``/api/mode``) and the
robot launcher (systemd/questix_robot_launcher.sh, which repeats the list; test_launcher_script.py
keeps them identical) reads it:

* ``lesson`` (教材): a class with QUESTiX LAB. The lab bridge may serve and, with the teacher's
  permissions, drive and fire; the drive and the launcher move only while the teacher's permission
  (actuation.py, 操作 tab) is on, controller included.
* ``practice`` (練習): free practice with the controller. No QUESTiX LAB, no teacher permission.
  Also what a missing or unreadable mode file means (the safe default of a fresh kit).
* ``competition`` (本番): the competition safety profile (GPIO5 + GPIO27, AutoReferee); starts at
  power-on. No QUESTiX LAB, no teacher permission.
"""

from pathlib import Path

LESSON = "lesson"
PRACTICE = "practice"
COMPETITION = "competition"
MODES = (LESSON, PRACTICE, COMPETITION)
DEFAULT = PRACTICE

# What the UI and the messages call them: the configuration ("練習用の構成") and the mode.
NAMES = {LESSON: "教材用", PRACTICE: "練習用", COMPETITION: "大会用"}
LABELS = {LESSON: "教材モード", PRACTICE: "練習モード", COMPETITION: "大会モード"}

# Modes the robot launcher starts only on a start request from Robot Manager (never by itself).
STARTED_ON_REQUEST = (LESSON, PRACTICE)


def read(path: Path) -> str:
    """Return the saved mode as written (practice when the file is missing or unreadable)."""
    try:
        return path.read_text().strip()
    except OSError:
        return DEFAULT


def uses_lab(mode: str) -> bool:
    """Whether QUESTiX LAB (the bridge, lab driving and launching) is available in ``mode``."""
    return mode == LESSON


def uses_teacher_permission(mode: str) -> bool:
    """Whether the teacher's permission (操作 tab) gates the robot in ``mode``."""
    return mode == LESSON
