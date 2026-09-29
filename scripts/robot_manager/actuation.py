"""The teacher's runtime actuation authority for a practice robot (操作 tab).

Practice launches of questix_core start drive_component, shot_component and esc_motor_control
with ``require_runtime_actuation_authority:=true``: they move the wheels (``drive``) or the
launcher (``launcher``: roller, tilt, fire) only while a fresh questix_msgs/ActuationAuthority on
``/actuation_authority`` says so. That applies to the controller and to QUESTiX LAB alike, and it
is enforced in those nodes, not here. Competition launches pass false and never depend on this.

This module holds the two switches (``_authority``) and a heartbeat child process
(actuation_heartbeat.py, sourced like the lab bridge: ROS, then ROBOT_WS from launch.env, and
the robot's ROS_DOMAIN_ID) that publishes them at 5 Hz while any is on. The switches are never
settings: they live only in this process, start off at every start of the manager (so after a
reboot too), and go off again on practice / competition mode switches, a start, restart or stop
of the robot service, 「すべて止める」 and the manager's shutdown (``revoke_all``). Switching one
on is refused in competition mode and when the heartbeat cannot be started. When the heartbeat
exits on its own the switches go off (noticed at the next status poll or switch) and nothing
restarts it: the robot has already stopped when its lease ran out, and the teacher switches on
again.

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

from robot_manager import control_runtime, ros_domain

CONFIG_DIR = Path(os.environ.get("QUESTIX_CONFIG_DIR", "/etc/questix_robot"))
LAUNCH_ENV_FILE = CONFIG_DIR / "launch.env"
MODE_FILE = CONFIG_DIR / "mode"
HEARTBEAT_SCRIPT = Path(__file__).with_name("actuation_heartbeat.py")
# The nodes' lease (runtime_authority_timeout_sec) and the heartbeat rate, for the tab.
LEASE_SEC = 1.0
HEARTBEAT_HZ = 5.0
# A heartbeat that exits this fast failed to start (ROS missing, questix_msgs not built).
START_GRACE_SEC = 1.0
STOP_TIMEOUT_SEC = 2.0

KINDS = ("drive", "launcher")
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


def _competition_mode() -> bool:
    try:
        return MODE_FILE.read_text().strip() == "competition"
    except OSError:
        return False


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


def _off_locked(kinds, reason: str) -> list[str]:
    """Switch ``kinds`` off; return the ones that were on. Caller holds _lock."""
    global _last_off_reason
    was_on = [kind for kind in kinds if _authority[kind]]
    for kind in kinds:
        _authority[kind] = False
    if was_on:
        _last_off_reason = reason
    if not any(_authority.values()):
        _stop_heartbeat_locked()
    elif was_on and not _send_locked():
        _authority.update({kind: False for kind in KINDS})
        _stop_heartbeat_locked()
        was_on = list(KINDS)
    return was_on


def _notify(kinds, reason: str) -> None:
    for kind in kinds:
        for listener in list(_revoke_listeners):
            try:
                listener(kind, reason)
            except Exception:  # a listener must never keep a revoke from finishing
                logger.exception("actuation revoke listener failed (%s, %s)", kind, reason)


def _notify_revoked(reaped, others=(), reason: str = "") -> None:
    """Tell the listeners once per kind: ``reaped`` (a dead heartbeat) first, then ``others``.

    Every kind a reap switched off is reported with ``heartbeat_exited``, whatever the caller was
    doing; a kind in ``others`` (the teacher's OFF, a revoke_all) that the reap already reported is
    not reported again, so a listener never repeats its side effects (a bridge restart) for it.
    Called outside _lock.
    """
    reaped = [kind for kind in KINDS if kind in set(reaped)]
    _notify(reaped, "heartbeat_exited")
    _notify([kind for kind in KINDS if kind in set(others) and kind not in reaped], reason)


def _reap_locked() -> list[str]:
    """Notice a heartbeat that exited on its own; switch all off. Caller holds _lock."""
    global _proc, _last_error
    if _proc is None or _proc.poll() is None:
        return []
    code = _proc.returncode
    _proc = None
    _last_error = f"送信プロセスが終了しました（終了コード {code}）。もう一度ONにしてください"
    logger.warning("actuation heartbeat exited on its own (code %s): all switches off", code)
    return _off_locked(KINDS, "heartbeat_exited")


def _status_locked() -> dict:
    return {
        "drive": _authority["drive"],
        "launcher": _authority["launcher"],
        "running": _proc is not None,
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
    _notify_revoked(reaped)
    return allowed


def status() -> dict:
    """Return the switches and the heartbeat state (a heartbeat that died switches all off)."""
    with _lock:
        reaped = _reap_locked()
        result = _status_locked()
    _notify_revoked(reaped)
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
            _off_locked([kind], "teacher")
            result = _status_locked()
        # This kind's lesson permission goes off whether or not the switch was still on.
        _notify_revoked(reaped, [kind], "teacher")
        return result
    if _competition_mode():
        raise HTTPException(status_code=409, detail=f"大会モードでは{_NAMES[kind]}の許可は使いません"
                            "（大会では AutoReferee と非常停止で動きます）")
    reaped: list[str] = []
    try:
        with _lock:
            reaped = _reap_locked()
            return _switch_on_locked(kind)
    finally:
        # Also when switching on failed: what the reap switched off is reported.
        _notify_revoked(reaped)


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
        _authority[kind] = False
        _stop_heartbeat_locked()
        _last_error = "送信プロセスに許可を伝えられませんでした。もう一度ONにしてください"
        raise HTTPException(status_code=503, detail=_last_error)
    _last_error = None
    return _status_locked()


def revoke_all(reason: str) -> dict:
    """Switch both authorities off (mode switch, service start/stop, 「すべて止める」). Never raises."""
    with _lock:
        reaped = _reap_locked()
        revoked = _off_locked(KINDS, reason)
        result = _status_locked()
    # The LAB permissions go off too, whether or not a switch was on (they need one anyway); a
    # kind a dead heartbeat had already switched off is reported once, as heartbeat_exited.
    _notify_revoked(reaped, KINDS, reason)
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
