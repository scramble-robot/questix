"""The teacher's permission for a lesson robot (操作 tab; modes.LESSON, 教材モード).

The permission is not an emergency stop. It is used in lesson mode only
(``modes.uses_teacher_permission``): the robot launcher then starts questix_core with
``require_teacher_permission:=true``,
so drive_component, shot_component and esc_motor_control move the wheels (``drive``) or the
launcher (``launcher``: roller, tilt, fire) only while a fresh questix_msgs/ActuationAuthority on
``/actuation_authority`` says so, for the controller and QUESTiX LAB alike, enforced in those
nodes, not here. It is also the precondition for QUESTiX LAB's lesson permissions (lab.py).
Practice mode (the controller alone) and competition mode never use it.

This module holds the two switches (``_authority``) and a heartbeat child process
(actuation_heartbeat.py, sourced like the lab bridge: ROS, then ROBOT_WS from launch.env, and
the robot's ROS_DOMAIN_ID) that publishes them at 5 Hz while any is on. The switches are never
settings: they live only in this process, start off at every start of the manager (so after a
reboot too), and go off again on every mode switch, a start, restart or stop of the robot service,
「すべて止める」 and the manager's shutdown (``revoke_all``). Switching one on is refused outside
lesson mode and when the heartbeat cannot be started. When the heartbeat
exits on its own the switches go off (noticed at the next status poll or switch) and nothing
restarts it: the lesson permissions go off with them (and an opted-in robot has already stopped
when its lease ran out), and the teacher switches on again. Likewise, when the heartbeat cannot
be told the switches (a failed write), both switches go off and it is stopped
(``heartbeat_write_failed``): no switch stays on without a heartbeat.

Turning a switch off (by the teacher or by ``revoke_all``) also turns off the matching QUESTiX
LAB permission (lab.py: driving experiments / launcher experiments) through the listeners
registered with ``add_revoke_listener``; turning one on never turns a LAB permission on, and
lab.py refuses a LAB permission while its switch here is off (``is_allowed``).
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
# The nodes' lease (teacher_permission_timeout_sec) and the heartbeat rate, for the tab.
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

# Guarded by _lock.
_lock = threading.Lock()
_authority = {kind: False for kind in KINDS}
_proc: Optional[subprocess.Popen] = None
_last_off_reason: Optional[str] = None
_last_error: Optional[str] = None
# Called as listener(kind, reason) after a switch went off (outside _lock).
_revoke_listeners: list[Callable[[str, str], None]] = []


class _HeartbeatWriteFailed(HTTPException):
    """The heartbeat could not be told the switches; every switch is already off."""

    def __init__(self, detail: str) -> None:
        super().__init__(status_code=503, detail=detail)


class AuthorityRequest(BaseModel):
    """Switch one runtime authority on or off."""

    allow: bool


def add_revoke_listener(listener: Callable[[str, str], None]) -> None:
    """Call ``listener(kind, reason)`` whenever a switch goes off (lab.py registers one)."""
    if listener not in _revoke_listeners:
        _revoke_listeners.append(listener)


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


def _send_locked() -> bool:
    """Tell the heartbeat the current switches; return False if it is gone. Caller holds _lock."""
    if _proc is None or _proc.stdin is None:
        return False
    try:
        _proc.stdin.write(json.dumps(_authority) + "\n")
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


def _write_failed_locked() -> list[str]:
    """Switch all off and stop the heartbeat that could not be told. Caller holds _lock.

    No switch may stay on without a heartbeat: the nodes stop when their lease runs out anyway,
    but the tab and the lesson permissions must not keep showing it on. Returns the kinds that
    were still on.
    """
    global _last_off_reason, _last_error
    was_on = [kind for kind in KINDS if _authority[kind]]
    _authority.update({kind: False for kind in KINDS})
    _stop_heartbeat_locked()
    _last_off_reason = WRITE_FAILED
    _last_error = "送信プロセスに許可を伝えられませんでした。もう一度ONにしてください"
    logger.warning("actuation heartbeat could not be told the switches: all switches off")
    return was_on


def _off_locked(kinds, reason: str) -> tuple[list[str], list[str]]:
    """Switch ``kinds`` off. Caller holds _lock.

    Returns the ``kinds`` that were on, and the other kinds a failed write to the heartbeat
    switched off with them (reported as heartbeat_write_failed, not as ``reason``).
    """
    global _last_off_reason
    was_on = [kind for kind in kinds if _authority[kind]]
    for kind in kinds:
        _authority[kind] = False
    if was_on:
        _last_off_reason = reason
    if not any(_authority.values()):
        _stop_heartbeat_locked()
    elif was_on and not _send_locked():
        return was_on, _write_failed_locked()
    return was_on, []


def _notify(kinds, reason: str) -> None:
    for kind in kinds:
        for listener in list(_revoke_listeners):
            try:
                listener(kind, reason)
            except Exception:  # a listener must never keep a revoke from finishing
                logger.exception("actuation revoke listener failed (%s, %s)", kind, reason)


def _notify_revoked(*groups) -> None:
    """Tell the listeners once per kind; ``groups`` are ``(kinds, reason)`` pairs, first wins.

    Callers pass what a reap switched off (heartbeat_exited) first, then what a failed write
    switched off (heartbeat_write_failed), then what they were asked to switch off (the teacher's
    OFF, a revoke_all). A kind already reported is not reported again, so a listener never repeats
    its side effects (a bridge restart) for it. Called outside _lock.
    """
    told: set[str] = set()
    for kinds, reason in groups:
        batch = [kind for kind in KINDS if kind in set(kinds) and kind not in told]
        told.update(batch)
        _notify(batch, reason)


def _reap_locked() -> list[str]:
    """Notice a heartbeat that exited on its own; switch all off. Caller holds _lock."""
    global _proc, _last_error
    if _proc is None or _proc.poll() is None:
        return []
    code = _proc.returncode
    _proc = None
    _last_error = f"送信プロセスが終了しました（終了コード {code}）。もう一度ONにしてください"
    logger.warning("actuation heartbeat exited on its own (code %s): all switches off", code)
    return _off_locked(KINDS, HEARTBEAT_EXITED)[0]


def _status_locked() -> dict:
    return {
        "drive": _authority["drive"],
        "launcher": _authority["launcher"],
        "running": _proc is not None,
        # The saved mode, and whether the switches can be used in it (lesson mode only).
        "mode": _mode(),
        "available": modes.uses_teacher_permission(_mode()),
        "competition": _competition_mode(),
        "last_off_reason": _last_off_reason,
        "error": _last_error,
        "lease_sec": LEASE_SEC,
        "heartbeat_hz": HEARTBEAT_HZ,
        # Only this process holds the switches: they are off after every restart and reboot.
        "transient": True,
    }


def peek(kind: str) -> bool:
    """Return the switch for ``kind`` without noticing a dead heartbeat (safe under lab's lock)."""
    with _lock:
        return _authority.get(kind, False)


def is_allowed(kind: str) -> bool:
    """Return whether the teacher's switch for ``kind`` ("drive" / "launcher") is on now."""
    with _lock:
        reaped = _reap_locked()
        allowed = _authority.get(kind, False)
    _notify_revoked((reaped, HEARTBEAT_EXITED))
    return allowed


def status() -> dict:
    """Return the switches and the heartbeat state (a heartbeat that died switches all off)."""
    with _lock:
        reaped = _reap_locked()
        result = _status_locked()
    _notify_revoked((reaped, HEARTBEAT_EXITED))
    return result


def set_authority(kind: str, allow: bool) -> dict:
    """Switch one authority on or off; raises HTTPException when it cannot be switched on."""
    if kind not in KINDS:
        raise HTTPException(status_code=404, detail="unknown authority")
    if not allow:
        with _lock:
            # A heartbeat that died before this OFF switched both kinds off: the other kind's
            # lesson permission must go off too (reported as heartbeat_exited), not only this one.
            reaped = _reap_locked()
            # Telling the heartbeat that the other kind stays on can fail: then it is off too.
            _, failed = _off_locked([kind], "teacher")
            result = _status_locked()
        # This kind's lesson permission goes off whether or not the switch was still on.
        _notify_revoked((reaped, HEARTBEAT_EXITED), (failed, WRITE_FAILED), ([kind], "teacher"))
        return result
    mode = _mode()
    if not modes.uses_teacher_permission(mode):
        raise HTTPException(status_code=409, detail=(
            f"{modes.LABELS.get(mode, '今のモード')}では{_NAMES[kind]}の許可は使いません"
            "（先生の許可は教材モードだけで使います）"))
    reaped: list[str] = []
    failed: tuple[str, ...] = ()
    try:
        with _lock:
            reaped = _reap_locked()
            return _switch_on_locked(kind)
    except _HeartbeatWriteFailed:
        # Both switches went off (the other one may have been on): both lesson permissions too.
        failed = KINDS
        raise
    finally:
        # Also when switching on failed: what the reap switched off is reported.
        _notify_revoked((reaped, HEARTBEAT_EXITED), (failed, WRITE_FAILED))


def _switch_on_locked(kind: str) -> dict:
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
    return _status_locked()


def revoke_all(reason: str) -> dict:
    """Switch both authorities off (mode switch, service start/stop, 「すべて止める」). Never raises."""
    with _lock:
        reaped = _reap_locked()
        revoked, _ = _off_locked(KINDS, reason)  # all off: nothing is written to the heartbeat
        result = _status_locked()
    # The LAB permissions go off too, whether or not a switch was on (they need one anyway); a
    # kind a dead heartbeat had already switched off is reported once, as heartbeat_exited.
    _notify_revoked((reaped, HEARTBEAT_EXITED), (KINDS, reason))
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
    """Allow or forbid moving the wheels (controller and QUESTiX LAB) in this session."""
    return set_authority("drive", request.allow)


@router.post("/launcher")
def set_launcher(request: AuthorityRequest):
    """Allow or forbid the roller, tilt and fire (controller and QUESTiX LAB) in this session."""
    return set_authority("launcher", request.allow)
