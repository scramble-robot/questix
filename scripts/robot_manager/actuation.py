"""The teacher's permission for a lesson robot (操作 tab; modes.LESSON, 教材モード).

The permission is not an emergency stop: it is the lesson mode's vote for the motion permission
(L2). While a switch is on, a heartbeat publishes questix_msgs/ActuationAuthority on
``/actuation_authority``; operation_manager's MotionPermissionManager needs that vote in lesson
mode only (operation_manager.permission.yaml) and folds it into ``/motion_permission``, which
drive_component (``drive``: the wheels) and shot_component / esc_motor_control (``launcher``:
roller, tilt, fire) obey, for the controller and QUESTiX LAB alike. Nothing here or in the
actuators decides that: the robot's running mode does (questix_core ``robot_mode``). Practice mode
(the controller alone) and competition mode (the referee's vote) never use it. It is also the
precondition for QUESTiX LAB's lesson permissions (lab.py).

The switches can be used only while the robot runs a lesson launch and lesson is also the saved
mode (``switches_available``): the running mode decides what the robot does, and a saved mode
that differs is what the next start will run. The running mode comes from app.py
(``set_running_mode_source``: the robot service and the launcher's last-launch record).

This module holds the two switches (``_authority``), QUESTiX LAB's two lesson permissions
(``_lab``: 教材からの走行 / 教材からの発射, switched by lab.py with ``set_lab``) and a heartbeat
child process (actuation_heartbeat.py, sourced like the lab bridge: ROS, then ROBOT_WS from
launch.env, and the robot's ROS_DOMAIN_ID) that publishes them at 5 Hz while any switch is on: the
switches on ``/actuation_authority``, the lesson permissions on ``/lab_permission`` (command_arbiter
and the lab bridge read it; design/safety_permission_input_refactor.md, 4.6). None of them is a
setting: they live only in this process, start off at every start of the manager (so after a
reboot too), and go off again on every mode switch, a start, restart or stop of the robot service,
「すべて止める」 and the manager's shutdown (``revoke_all``). Switching one on is refused unless the
robot runs a lesson launch, and when the heartbeat cannot be started. When the heartbeat exits on
its own everything goes off (noticed at the next status poll or switch) and nothing restarts it
(the robot has already stopped when the leases ran out), and the teacher switches on again.
Likewise, when the heartbeat cannot be told (a failed write), everything goes off and it is
stopped (``heartbeat_write_failed``): nothing stays on without a heartbeat.

A lesson permission needs the switch of the same kind: it cannot be switched on while that switch
is off, and it goes off with it, in the same step (so ``/lab_permission`` never says yes while the
teacher's switch says no); switching a switch on never switches a lesson permission on.
"""

import json
import logging
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from robot_manager import control_runtime, modes, ros_domain

CONFIG_DIR = Path(os.environ.get("QUESTIX_CONFIG_DIR", "/etc/questix_robot"))
LAUNCH_ENV_FILE = CONFIG_DIR / "launch.env"
MODE_FILE = CONFIG_DIR / "mode"
HEARTBEAT_SCRIPT = Path(__file__).with_name("actuation_heartbeat.py")
# The vote's lease (MotionPermissionManager's lease_sec) and the heartbeat rate, for the tab.
LEASE_SEC = 1.0
HEARTBEAT_HZ = 5.0
# A heartbeat that exits this fast failed to start (ROS missing, questix_msgs not built).
START_GRACE_SEC = 1.0
STOP_TIMEOUT_SEC = 2.0

KINDS = ("drive", "launcher")
# Why a switch went off without the teacher asking (also in last_off_reason).
HEARTBEAT_EXITED = "heartbeat_exited"
WRITE_FAILED = "heartbeat_write_failed"
_NAMES = {"drive": "ロボットの走行制御", "launcher": "発射機構の操作"}

router = APIRouter(prefix="/api/actuation")
logger = logging.getLogger(__name__)

# Guarded by _lock. lab.py calls in while holding its own lock, never the other way round.
_lock = threading.Lock()
_authority = {kind: False for kind in KINDS}
# QUESTiX LAB's lesson permission per kind (on /lab_permission); never on while _authority is off.
_lab = {kind: False for kind in KINDS}
_proc: Optional[subprocess.Popen] = None
_last_off_reason: Optional[str] = None
_last_error: Optional[str] = None
# The mode of the running launch (modes.MODES or "unknown"), None while the robot is stopped.
# app.py installs the real source; until then nothing runs as far as this module knows.
_running_mode_source: Callable[[], Optional[str]] = lambda: None


class _HeartbeatWriteFailed(HTTPException):
    """The heartbeat could not be told the switches; every switch is already off."""

    def __init__(self, detail: str) -> None:
        super().__init__(status_code=503, detail=detail)


class AuthorityRequest(BaseModel):
    """Switch one runtime authority on or off."""

    allow: bool


def set_running_mode_source(source: Callable[[], Optional[str]]) -> None:
    """Tell this module how to find the running launch's mode (app.py does at import)."""
    global _running_mode_source
    _running_mode_source = source


def running_mode() -> Optional[str]:
    """Return the running launch's mode (modes.MODES or "unknown"), or None when stopped."""
    try:
        return _running_mode_source()
    except Exception:  # an unreadable state never makes the switches usable
        logger.exception("cannot tell the running mode")
        return "unknown"


_LOOK_UP = object()  # switches_available: ask for the running mode (None means "stopped")


def switches_available(running=_LOOK_UP) -> bool:
    """Tell whether the teacher's switches can be used now.

    They can while the robot runs a lesson launch and lesson is also the saved mode (design
    section 6.5). ``running``: a mode already looked up (None: stopped); by default it is looked
    up now.
    """
    if running is _LOOK_UP:
        running = running_mode()
    return modes.uses_teacher_permission(_mode()) and modes.uses_teacher_permission(running or "")


def _read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        for line in path.read_text().splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and key and not key.startswith("#"):
                values[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return values


def _mode() -> str:
    return modes.read(MODE_FILE)


def _competition_mode() -> bool:
    return _mode() == modes.COMPETITION


def _command(config: dict[str, str]) -> list[str]:
    """Build the heartbeat command; raises HTTPException when ROS or the workspace is missing."""
    ros_setup, workspace_setup = control_runtime._ros_paths(config)
    export_domain = ros_domain.shell_export(config.get("ROS_DOMAIN_ID"))
    # Paths are positional arguments, never shell source code.
    return [
        "/bin/bash", "--noprofile", "--norc", "-c",
        f'set -e; source "$1" >/dev/null; source "$2" >/dev/null; {export_domain}'
        'exec /usr/bin/python3 "$3"',
        "questix-actuation-authority", str(ros_setup), str(workspace_setup), str(HEARTBEAT_SCRIPT),
    ]


def _heartbeat_state_locked() -> dict:
    """Return the line the heartbeat publishes (actuation_heartbeat.parse_state). Holds _lock."""
    state = dict(_authority)
    state.update({f"lab_{kind}": _lab[kind] and _authority[kind] for kind in KINDS})
    return state


def _send_locked() -> bool:
    """Tell the heartbeat the current state; return False if it is gone. Caller holds _lock."""
    if _proc is None or _proc.stdin is None:
        return False
    try:
        _proc.stdin.write(json.dumps(_heartbeat_state_locked()) + "\n")
        _proc.stdin.flush()
    except (OSError, ValueError):
        return False
    return True


def _stop_heartbeat_locked() -> None:
    """Close the heartbeat's stdin (it publishes all off and exits) and wait. Caller holds _lock."""
    global _proc
    proc = _proc
    _proc = None
    if proc is None:
        return
    try:
        if proc.stdin is not None:
            proc.stdin.close()
    except OSError:
        pass
    try:
        proc.wait(timeout=STOP_TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=STOP_TIMEOUT_SEC)
        except subprocess.TimeoutExpired:
            logger.error("actuation heartbeat (pid %s) did not exit", proc.pid)


def _write_failed_locked() -> None:
    """Switch everything off and stop the heartbeat that could not be told. Caller holds _lock.

    Nothing may stay on without a heartbeat: the nodes stop when their lease runs out anyway, but
    the tabs must not keep showing it on.
    """
    global _last_off_reason, _last_error
    _authority.update({kind: False for kind in KINDS})
    _lab.update({kind: False for kind in KINDS})
    _stop_heartbeat_locked()
    _last_off_reason = WRITE_FAILED
    _last_error = "送信プロセスに許可を伝えられませんでした。もう一度ONにしてください"
    logger.warning("actuation heartbeat could not be told the switches: everything off")


def _off_locked(kinds, reason: str) -> list[str]:
    """Switch ``kinds`` and their lesson permissions off; return the kinds that were on.

    Caller holds _lock. A failed write to the heartbeat switches everything off
    (heartbeat_write_failed).
    """
    global _last_off_reason
    was_on = [kind for kind in kinds if _authority[kind]]
    lab_was_on = any(_lab[kind] for kind in kinds)
    for kind in kinds:
        _authority[kind] = False
        _lab[kind] = False
    if was_on:
        _last_off_reason = reason
    if not any(_authority.values()):
        _stop_heartbeat_locked()
    elif (was_on or lab_was_on) and not _send_locked():
        _write_failed_locked()
    return was_on


def _reap_locked() -> list[str]:
    """Notice a heartbeat that exited on its own; switch all off. Caller holds _lock."""
    global _proc, _last_error
    if _proc is None or _proc.poll() is None:
        return []
    code = _proc.returncode
    _proc = None
    _last_error = f"送信プロセスが終了しました（終了コード {code}）。もう一度ONにしてください"
    logger.warning("actuation heartbeat exited on its own (code %s): all switches off", code)
    return _off_locked(KINDS, HEARTBEAT_EXITED)


def _status_locked(running: Optional[str], known: bool = True) -> dict:
    """Return the status; ``known=False``: the running mode was not looked up (both None)."""
    return {
        "drive": _authority["drive"],
        "launcher": _authority["launcher"],
        # QUESTiX LAB's lesson permissions (教材 tab), published on /lab_permission.
        "lab_drive": _lab["drive"],
        "lab_launcher": _lab["launcher"],
        "running": _proc is not None,
        # The saved mode, the running launch's mode (None while stopped), and whether the switches
        # can be used (both lesson: switches_available).
        "mode": _mode(),
        "running_mode": running if known else None,
        "available": switches_available(running) if known else None,
        "competition": _competition_mode(),
        "last_off_reason": _last_off_reason,
        "error": _last_error,
        "lease_sec": LEASE_SEC,
        "heartbeat_hz": HEARTBEAT_HZ,
        # Only this process holds the switches: they are off after every restart and reboot.
        "transient": True,
    }


def is_allowed(kind: str) -> bool:
    """Return whether the teacher's switch for ``kind`` ("drive" / "launcher") is on now."""
    with _lock:
        _reap_locked()
        return _authority.get(kind, False)


def lab_permissions() -> dict[str, bool]:
    """Return QUESTiX LAB's lesson permissions now (a heartbeat that died switched them off)."""
    with _lock:
        _reap_locked()
        return dict(_lab)


def set_lab(kind: str, allow: bool) -> dict[str, bool]:
    """Switch QUESTiX LAB's lesson permission for ``kind`` (lab.py's 教材 switches).

    Switching on needs the teacher's switch of the same kind (409) and a heartbeat that can be
    told (503: then everything is off, as after any failed write). Switching off never raises.
    Returns the lesson permissions now. lab.py calls it while holding its own lock.
    """
    if kind not in KINDS:
        raise HTTPException(status_code=404, detail="unknown permission")
    with _lock:
        _reap_locked()
        if allow and not _authority[kind]:
            raise HTTPException(status_code=409, detail=(
                f"先に「操作」タブで「{_NAMES[kind]}」をONにしてください"))
        if _lab[kind] != bool(allow):
            _lab[kind] = bool(allow)
            if not _send_locked():
                _write_failed_locked()
                if allow:
                    raise _HeartbeatWriteFailed(_last_error)
        return dict(_lab)


def revoke_lab() -> bool:
    """Switch both lesson permissions off; return whether one was on. Never raises.

    lab.py: 配信停止, 「すべて止める」, leaving lesson mode, a bridge that exited on its own.
    """
    with _lock:
        was_on = any(_lab.values())
        _lab.update({kind: False for kind in KINDS})
        if was_on and not _send_locked():
            _write_failed_locked()
        return was_on


def status(with_running_mode: bool = True) -> dict:
    """Return the switches and the heartbeat state (a heartbeat that died switches all off).

    ``with_running_mode=False`` does not ask for the running launch (systemd); ``running_mode``
    and ``available`` are then None (the evidence snapshot of recorder.py only needs the switches).
    """
    running = running_mode() if with_running_mode else None  # outside _lock: may ask systemd
    with _lock:
        _reap_locked()
        return _status_locked(running, known=with_running_mode)


def set_authority(kind: str, allow: bool) -> dict:
    """Switch one authority on or off; raises HTTPException when it cannot be switched on."""
    if kind not in KINDS:
        raise HTTPException(status_code=404, detail="unknown authority")
    running = running_mode()  # outside _lock: it may ask systemd
    if not allow:
        with _lock:
            _reap_locked()
            # Telling the heartbeat that the other kind stays on can fail: then it is off too.
            _off_locked([kind], "teacher")
            return _status_locked(running)
    mode = _mode()
    if not modes.uses_teacher_permission(mode):
        raise HTTPException(status_code=409, detail=(
            f"{modes.LABELS.get(mode, '今のモード')}では{_NAMES[kind]}の許可は使いません"
            "（先生の許可は教材モードだけで使います）"))
    if not modes.uses_teacher_permission(running or ""):
        now = ("ロボット制御が止まっています" if running is None
               else f"いまは{modes.NAMES.get(running, '別')}の構成で動いています")
        raise HTTPException(status_code=409, detail=(
            f"{now}。{_NAMES[kind]}の許可は、教材モードで起動（再起動）してから使えます"))
    with _lock:
        _reap_locked()
        return _switch_on_locked(kind, running)


def _switch_on_locked(kind: str, running: Optional[str]) -> dict:
    """Start the heartbeat if needed and switch ``kind`` on. Caller holds _lock; may raise."""
    global _proc, _last_error
    if _proc is None:
        config = _read_env_file(LAUNCH_ENV_FILE)
        try:
            command = _command(config)
        except HTTPException as error:
            _last_error = str(error.detail)
            raise
        environment = os.environ.copy()
        environment.pop("ROS_DOMAIN_ID", None)  # the command exports the robot's domain
        try:
            proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, text=True, env=environment,
                                    start_new_session=True)
        except OSError as error:
            _last_error = f"送信プロセスを起動できません: {error}"
            raise HTTPException(status_code=503, detail=_last_error) from error
        deadline = time.monotonic() + START_GRACE_SEC
        while time.monotonic() < deadline and proc.poll() is None:
            time.sleep(0.05)
        if proc.poll() is not None:
            _last_error = ("送信プロセスがすぐに終了しました（ROS 環境と questix_msgs の"
                           "ビルドを確認してください）")
            raise HTTPException(status_code=503, detail=_last_error)
        _proc = proc
    _authority[kind] = True
    if not _send_locked():
        # Not only this kind: a heartbeat that cannot be told leaves no switch on.
        _write_failed_locked()
        raise _HeartbeatWriteFailed(_last_error)
    _last_error = None
    return _status_locked(running)


def revoke_all(reason: str) -> dict:
    """Switch both authorities off (mode switch, service start/stop, 「すべて止める」). Never raises."""
    running = running_mode()
    with _lock:
        reaped = _reap_locked()
        # All off, the lesson permissions with them: nothing is written to the heartbeat.
        revoked = _off_locked(KINDS, reason)
        result = _status_locked(running)
    result["revoked"] = sorted(set(revoked) | set(reaped), key=KINDS.index)
    return result


def shutdown() -> None:
    """Switch everything off and end the heartbeat (the manager is exiting)."""
    revoke_all("manager_shutdown")


@router.get("/status")
def get_status():
    """Return the teacher's runtime authority switches."""
    return status()


@router.post("/drive")
def set_drive(request: AuthorityRequest):
    """Vote for or against moving the wheels (controller and QUESTiX LAB) in this session."""
    return set_authority("drive", request.allow)


@router.post("/launcher")
def set_launcher(request: AuthorityRequest):
    """Vote for or against the roller, tilt and fire (controller and QUESTiX LAB) in this session."""
    return set_authority("launcher", request.allow)
