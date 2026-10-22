"""Read-only robot status for QUESTiX Robot Manager.

One child subscribes to /emergency_stop (reliable, transient_local, keep-last(1)) and
/motion_permission (reliable, volatile, keep-last(1)). The ROS setup, ROBOT_WS and launch.env
ROS_DOMAIN_ID are shared. Each real message can produce a timestamped JSON line, immediately
on change or every 0.5 s otherwise. No timer repeats a cached value without a message.
The parent uses each topic's independent monotonic receive time and expires it after 1.5 s.
Stopping the robot, changing domain/workspace or losing the child clears both snapshots.
It publishes nothing and offers no services. Actuators retain all safety decisions.
"""

import json
import logging
import math
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
_permission: Optional[dict] = None
_permission_received_at = 0.0
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
    if not isinstance(data, dict):
        return None
    received = data.get("received_at")
    if received is not None and (type(received) not in (int, float) or not math.isfinite(received)):
        return None
    if data.get("topic") == "/motion_permission":
        if (received is None or not isinstance(data.get("mode"), str)
                or type(data.get("drive_allowed")) is not bool
                or type(data.get("launcher_allowed")) is not bool):
            return None
        for key in ("drive_blockers", "launcher_blockers"):
            if not isinstance(data.get(key), list) or not all(isinstance(x, str) for x in data[key]):
                return None
        return {key: data[key] for key in ("topic", "received_at", "mode", "drive_allowed",
                                          "launcher_allowed", "drive_blockers",
                                          "launcher_blockers")}
    if type(data.get("active")) is not bool:
        return None
    source, reason = data.get("source", ""), data.get("reason", "")
    if not isinstance(source, str) or not isinstance(reason, str):
        return None
    result = {"active": data["active"], "source": source[:MAX_TEXT], "reason": reason[:MAX_TEXT]}
    if received is not None:
        result["received_at"] = received
    return result


def _read_lines(proc) -> None:
    """Keep the latest report of ``proc`` (a reader thread; ends at the listener's EOF)."""
    global _latest, _received_at, _permission, _permission_received_at
    try:
        for line in proc.stdout:
            report = parse_line(line)
            if report is None:
                continue
            with _lock:
                if proc is _proc:
                    received = report.pop("received_at", _now())
                    # Both processes use this host's monotonic clock. Buffered old lines must
                    # not become fresh just because the parent finally reads stdout.
                    if received > _now():
                        continue
                    if report.pop("topic", None) == "/motion_permission":
                        if received >= _permission_received_at:
                            _permission, _permission_received_at = report, received
                    elif received >= _received_at:
                        _latest, _received_at = report, received
    except (OSError, ValueError):
        pass


def _start_locked(command: list) -> None:
    """Start the listener. Caller holds _lock."""
    global _proc, _command_used, _started_at, _latest, _error, _retry_at
    global _permission, _permission_received_at, _received_at
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
    _permission, _permission_received_at, _received_at = None, 0.0, 0.0
    threading.Thread(target=_read_lines, args=(proc,), name="estop-monitor", daemon=True).start()


def _stop_locked() -> None:
    """Close the listener's stdin (it exits) and wait. Caller holds _lock."""
    global _proc, _latest, _permission
    proc, _proc, _latest = _proc, None, None
    _permission = None
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
    global _proc, _latest, _error, _retry_at, _permission
    if _proc is None or _proc.poll() is None:
        return
    code = _proc.returncode
    _proc, _latest = None, None
    _permission = None
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


def _permission_snapshot_locked(estop: dict) -> dict:
    """Return this topic's own freshness; an E-stop line cannot refresh it."""
    result = {"state": "unknown", "note": estop.get("note"), "mode": None,
              "drive_allowed": None, "launcher_allowed": None, "drive_blockers": [],
              "launcher_blockers": [], "age_sec": None, "stale_after_sec": STALE_SEC}
    if _proc is None:
        return result
    if _permission is None:
        result["note"] = "starting" if _now() - _started_at < STARTUP_SEC else "not_heard"
        return result
    age = _now() - _permission_received_at
    result["age_sec"] = age
    if age < 0 or age > STALE_SEC:
        result["note"] = "silent"
        return result
    return dict(result, **_permission, state="known", note=None)


def observe_all(service: str) -> dict:
    """Take one locked snapshot of the two read-only subscriptions."""
    with _lock:
        estop = _observe_locked(service)
        return {"emergency_stop": estop, "motion_permission": _permission_snapshot_locked(estop)}


def observe(service: str) -> dict:
    """Keep the existing E-stop-only interface for callers."""
    return observe_all(service)["emergency_stop"]


def _observe_locked(service: str) -> dict:
    """Return the E-stop state for ``/api/status``; keeps the listener running while active.

    ``state`` is ``pressed``, ``released`` or ``unknown``; ``note`` says why it is unknown
    (``robot_stopped``, ``starting``, ``not_heard``, ``silent``, ``unavailable`` with ``detail``),
    ``reason`` is operation_manager's text (e.g. ``pin 5 is true, expected false; ``).
    """
    global _error, _retry_at
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
        _stop_locked()
    if _proc is None and _now() >= _retry_at:
        _start_locked(command)
    return _snapshot_locked()


def shutdown() -> None:
    """Stop the listener (the manager is exiting)."""
    with _lock:
        _stop_locked()
