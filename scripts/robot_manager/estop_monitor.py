"""The robot's E-stop state for the header and the 操作 tab, in every mode (read-only).

Practice and competition robots have no QUESTiX LAB bridge (lab.py serves lesson mode only) and
Robot Manager has no GPIO switch any more (issue #168), so without this the pages could only say
「不明」 there, even when a pressed or unwired GPIO5 is why nothing moves. While the robot service is
active, a listener child (estop_listener.py, sourced like the actuation heartbeat: ROS, then
ROBOT_WS from launch.env, and the robot's ROS_DOMAIN_ID) reports ``/emergency_stop``; ``observe``
starts it, follows a changed domain or workspace, and stops it when the service is not active.

This is a display only. It publishes nothing, and drive_component, shot_component,
esc_motor_control and the lab bridge keep judging ``/emergency_stop`` themselves: nothing here
ever lets anything move. A listener that cannot start or exits is retried after RETRY_SEC; until
then, and while nothing was heard, the state is ``unknown`` (never ``released``).
"""

import json
import logging
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from robot_manager import control_runtime, ros_domain

CONFIG_DIR = Path(os.environ.get("QUESTIX_CONFIG_DIR", "/etc/questix_robot"))
LAUNCH_ENV_FILE = CONFIG_DIR / "launch.env"
LISTENER_SCRIPT = Path(__file__).with_name("estop_listener.py")
# The listener writes a line at least every 0.5 s while /emergency_stop arrives (every 100 ms from
# operation_manager); the nodes stop after emergency_stop_timeout_sec (1.0 s) of silence.
STALE_SEC = 1.5
# Sourcing ROS and discovery: before this, nothing heard yet is "starting", not "not_heard".
STARTUP_SEC = 5.0
RETRY_SEC = 10.0
STOP_TIMEOUT_SEC = 2.0
MAX_TEXT = 200

logger = logging.getLogger(__name__)

# Guarded by _lock.
_lock = threading.Lock()
_proc: Optional[subprocess.Popen] = None
_command_used: Optional[list] = None
_started_at = 0.0
_latest: Optional[dict] = None
_received_at = 0.0
_error: Optional[str] = None
_retry_at = 0.0
_now = time.monotonic


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


def _command(config: dict[str, str]) -> list[str]:
    """Build the listener command; raises HTTPException when ROS or the workspace is missing."""
    ros_setup, workspace_setup = control_runtime._ros_paths(config)
    export_domain = ros_domain.shell_export(config.get("ROS_DOMAIN_ID"))
    # Paths are positional arguments, never shell source code. Setup output is suppressed so
    # stdout carries only the listener's JSON lines.
    return [
        "/bin/bash", "--noprofile", "--norc", "-c",
        f'set -e; source "$1" >/dev/null; source "$2" >/dev/null; {export_domain}'
        'exec /usr/bin/python3 "$3"',
        "questix-estop-monitor", str(ros_setup), str(workspace_setup), str(LISTENER_SCRIPT),
    ]


def parse_line(line: str) -> Optional[dict]:
    """Return one listener report, or None for anything that is not one."""
    try:
        data = json.loads(line)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict) or type(data.get("active")) is not bool:
        return None
    source, reason = data.get("source", ""), data.get("reason", "")
    if not isinstance(source, str) or not isinstance(reason, str):
        return None
    return {"active": data["active"], "source": source[:MAX_TEXT], "reason": reason[:MAX_TEXT]}


def _read_lines(proc) -> None:
    """Keep the latest report of ``proc`` (a reader thread; ends at the listener's EOF)."""
    global _latest, _received_at
    try:
        for line in proc.stdout:
            report = parse_line(line)
            if report is None:
                continue
            with _lock:
                if proc is _proc:
                    _latest = report
                    _received_at = _now()
    except (OSError, ValueError):
        pass


def _start_locked(command: list) -> None:
    """Start the listener. Caller holds _lock."""
    global _proc, _command_used, _started_at, _latest, _error, _retry_at
    environment = os.environ.copy()
    environment.pop("ROS_DOMAIN_ID", None)  # the command exports the robot's domain
    try:
        proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True, env=environment,
                                start_new_session=True)
    except OSError as error:
        _error = f"非常停止の確認用プロセスを起動できません: {error}"
        _retry_at = _now() + RETRY_SEC
        return
    _proc, _command_used, _started_at, _latest, _error = proc, command, _now(), None, None
    threading.Thread(target=_read_lines, args=(proc,), name="estop-monitor", daemon=True).start()


def _stop_locked() -> None:
    """Close the listener's stdin (it exits) and wait. Caller holds _lock."""
    global _proc, _latest
    proc, _proc, _latest = _proc, None, None
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
            logger.error("E-stop listener (pid %s) did not exit", proc.pid)


def _reap_locked() -> None:
    """Notice a listener that exited on its own. Caller holds _lock."""
    global _proc, _latest, _error, _retry_at
    if _proc is None or _proc.poll() is None:
        return
    code = _proc.returncode
    _proc, _latest = None, None
    _error = (f"非常停止の確認用プロセスが終了しました（終了コード {code}）。"
              "ROS 環境と questix_msgs のビルドを確認してください")
    _retry_at = _now() + RETRY_SEC
    logger.warning("E-stop listener exited (code %s); retrying in %.0f s", code, RETRY_SEC)


def _report(state: str, note: Optional[str] = None, **extra) -> dict:
    result = {"state": state, "note": note, "reason": None, "source": None, "age_sec": None,
              "detail": None}
    result.update(extra)
    return result


def _snapshot_locked() -> dict:
    now = _now()
    if _proc is None:
        return _report("unknown", "unavailable", detail=_error)
    if _latest is None:
        return _report("unknown", "starting" if now - _started_at < STARTUP_SEC else "not_heard")
    age = round(now - _received_at, 1)
    if now - _received_at > STALE_SEC:
        return _report("unknown", "silent", age_sec=age)
    return _report("pressed" if _latest["active"] else "released", reason=_latest["reason"],
                   source=_latest["source"], age_sec=age)


def observe(service: str) -> dict:
    """Return the E-stop state for ``/api/status``; keeps the listener running while active.

    ``state`` is ``pressed``, ``released`` or ``unknown``; ``note`` says why it is unknown
    (``robot_stopped``, ``starting``, ``not_heard``, ``silent``, ``unavailable`` with ``detail``),
    ``reason`` is operation_manager's text (e.g. ``pin 5 is true, expected false; ``).
    """
    global _error, _retry_at
    with _lock:
        if service != "active":
            _stop_locked()
            _error, _retry_at = None, 0.0
            return _report("unknown", "robot_stopped")
        _reap_locked()
        try:
            command = _command(_read_env_file(LAUNCH_ENV_FILE))
        except HTTPException as error:
            _stop_locked()
            _error = str(error.detail)
            return _snapshot_locked()
        if _proc is not None and command != _command_used:
            _stop_locked()  # the domain or the workspace changed: listen where the robot runs now
        if _proc is None and _now() >= _retry_at:
            _start_locked(command)
        return _snapshot_locked()


def shutdown() -> None:
    """Stop the listener (the manager is exiting)."""
    with _lock:
        _stop_locked()
