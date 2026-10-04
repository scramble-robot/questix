"""The robot's raw GPIO safety inputs, as Robot Manager shows them (操作 tab), read-only.

Two separate rows, never merged into one "E-stop" word:

- ``button``: the physical emergency-stop button (GPIO5, gpio_reader's ``/gpio_5``). Read in
  every mode unless a practice launch runs without the GPIO safety path (``ENABLE_GPIO_REF=false``
  in launch.env). The button also cuts motor power in hardware (RLY1); this is only its report.
- ``defeat``: the AutoReferee defeat signal (GPIO27 ``AR_in``, ``/gpio_27``), read by competition
  launches only. ``true`` (not defeated) also means AutoReferee not connected or not powered:
  the hardware cannot tell them apart (operation_manager's ``pin_27_signal_limit``).

What the robot decides from them (operation_manager's ``/emergency_stop``) is not shown here.

The values come from a child process (safety_inputs_monitor.py, sourced like the actuation
heartbeat: ROS, then ROBOT_WS from launch.env, and the robot's ROS_DOMAIN_ID) that only
subscribes. It runs while the robot service runs and someone asks (``status``), is restarted when
launch.env's workspace or domain changes, and ends with the service or the manager.
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

MONITOR_SCRIPT = Path(__file__).with_name("safety_inputs_monitor.py")
# A GPIO value older than this is not shown as the current state. Equal to operation_manager's
# timeout_seconds (operation_manager/config/*.yaml), past which the robot stops on it too.
STALE_SEC = 1.0
# The monitor reports every 0.25 s; a report older than this means it is stuck or gone.
MONITOR_STALE_SEC = 2.0
# How long a monitor that exited waits before it is started again.
RETRY_SEC = 5.0
STOP_TIMEOUT_SEC = 2.0
RUNNING_SERVICE_STATES = ("active", "reloading", "deactivating")

logger = logging.getLogger(__name__)

# Guarded by _lock.
_lock = threading.Lock()
_proc: Optional[subprocess.Popen] = None
_command_key: Optional[tuple] = None
_latest: Optional[dict] = None
_latest_at: Optional[float] = None
_started_at: Optional[float] = None
_retry_at = 0.0
_last_error: Optional[str] = None


def _command(config: dict[str, str]) -> list[str]:
    """Build the monitor command; raises HTTPException when ROS or the workspace is missing."""
    ros_setup, workspace_setup = control_runtime._ros_paths(config)
    export_domain = ros_domain.shell_export(config.get("ROS_DOMAIN_ID"))
    # Paths are positional arguments, never shell source code.
    return [
        "/bin/bash", "--noprofile", "--norc", "-c",
        f'set -e; source "$1" >/dev/null; source "$2" >/dev/null; {export_domain}'
        'exec /usr/bin/python3 "$3"',
        "questix-safety-inputs", str(ros_setup), str(workspace_setup), str(MONITOR_SCRIPT),
    ]


def parse_report(line: str) -> Optional[dict]:
    """Return ``{5: pin, 27: pin}`` from one monitor line, or None when it is malformed."""
    try:
        pins = json.loads(line)["pins"]
        result = {}
        for pin in (5, 27):
            item = pins[str(pin)]
            received = item["received"] is True
            value = item["value"]
            age = item["age_sec"]
            publishers = item["publishers"]
            if received and (type(value) is not bool or type(age) not in (int, float)
                             or not 0 <= age < float("inf")):
                return None
            if type(publishers) is not int or publishers < 0:
                return None
            result[pin] = {"received": received, "value": value if received else None,
                           "age_sec": float(age) if received else None, "publishers": publishers}
        return result
    except (KeyError, TypeError, ValueError):
        return None


def _read_lines(proc: subprocess.Popen) -> None:
    """Keep the latest report of ``proc`` (runs in its own thread until the pipe closes)."""
    global _latest, _latest_at
    for line in proc.stdout:
        report = parse_report(line)
        if report is None:
            continue
        with _lock:
            if _proc is proc:
                _latest, _latest_at = report, time.monotonic()


def _stop_locked() -> None:
    """Close the monitor's stdin (it exits) and wait. Caller holds _lock."""
    global _proc, _command_key, _latest, _latest_at, _started_at
    proc = _proc
    _proc, _command_key, _latest, _latest_at, _started_at = None, None, None, None, None
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
            logger.error("safety inputs monitor (pid %s) did not exit", proc.pid)


def _ensure_running_locked(config: dict[str, str], now: float) -> None:
    """Start (or restart for another workspace / domain) the monitor. Caller holds _lock."""
    global _proc, _command_key, _started_at, _retry_at, _last_error
    try:
        command = _command(config)
    except HTTPException as error:
        _stop_locked()
        _last_error = str(error.detail)
        return
    key = tuple(command)
    if _proc is not None and _proc.poll() is None and key == _command_key:
        return
    if _proc is not None and _proc.poll() is not None:
        _last_error = f"読み取りプロセスが終了しました（終了コード {_proc.returncode}）"
        logger.warning("safety inputs monitor exited (code %s)", _proc.returncode)
    _stop_locked()
    if now < _retry_at:
        return
    _retry_at = now + RETRY_SEC
    environment = os.environ.copy()
    environment.pop("ROS_DOMAIN_ID", None)  # the command exports the robot's domain
    try:
        proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True, env=environment,
                                start_new_session=True)
    except OSError as error:
        _last_error = f"読み取りプロセスを起動できません: {error}"
        return
    _proc, _command_key, _started_at = proc, key, now
    threading.Thread(target=_read_lines, args=(proc,), daemon=True,
                     name="safety-inputs-monitor").start()


def _pin_row(pin: Optional[dict]) -> dict:
    """Split one pin into fresh value / stale / never heard."""
    if pin is None:
        return {"state": "no_signal", "value": None, "age_sec": None, "publishers": 0}
    if pin["received"] and pin["age_sec"] <= STALE_SEC:
        state = "fresh"
    elif pin["received"]:
        state = "stale"
    else:
        state = "no_signal"
    return {"state": state, "value": pin["value"], "age_sec": pin["age_sec"],
            "publishers": pin["publishers"]}


def interpret(service: str, running_mode: Optional[str], config: dict[str, str],
              report: Optional[dict], report_age: Optional[float],
              monitor: str) -> dict:
    """Return the two rows from what the monitor last saw (pure: tested without ROS).

    ``monitor`` is ``"running"``, ``"starting"`` or ``"unavailable"``. Each row's ``state``:

    - button: ``released`` / ``pressed`` / ``stale`` / ``no_signal`` / ``not_read`` (a practice
      launch without the GPIO safety path) / ``robot_stopped`` / ``unknown`` (no monitor).
    - defeat: ``not_defeated`` / ``defeated`` / ``stale`` / ``no_signal`` / ``not_used`` (not a
      competition launch) / ``robot_stopped`` / ``unknown``.
    """
    if service not in RUNNING_SERVICE_STATES:
        return {"button": {"state": "robot_stopped"}, "defeat": {"state": "robot_stopped"}}
    fresh = report is not None and report_age is not None and report_age <= MONITOR_STALE_SEC
    if not fresh:
        return {"button": {"state": "unknown", "monitor": monitor},
                "defeat": {"state": "unknown", "monitor": monitor}}
    button = _pin_row(report.get(5))
    if button["state"] == "fresh":
        button["state"] = "pressed" if button["value"] else "released"
    elif (button["state"] == "no_signal" and button["publishers"] == 0
          and running_mode == "practice" and config.get("ENABLE_GPIO_REF") == "false"):
        button["state"] = "not_read"
    defeat = _pin_row(report.get(27))
    if defeat["state"] == "fresh":
        defeat["state"] = "not_defeated" if defeat["value"] else "defeated"
    elif running_mode != "competition" and defeat["state"] == "no_signal" \
            and defeat["publishers"] == 0:
        defeat["state"] = "not_used"
    return {"button": button, "defeat": defeat}


def status(service: str, running_mode: Optional[str], config: dict[str, str]) -> dict:
    """Return both rows; starts the monitor while the robot runs, stops it otherwise."""
    global _last_error
    now = time.monotonic()
    with _lock:
        if service not in RUNNING_SERVICE_STATES:
            _stop_locked()
            _last_error = None
            report, report_age, monitor = None, None, "stopped"
        else:
            _ensure_running_locked(config, now)
            report = _latest
            report_age = None if _latest_at is None else now - _latest_at
            if _proc is None:
                monitor = "unavailable"
            elif _latest_at is None:
                monitor = "starting"
            else:
                monitor = "running"
        error = _last_error if monitor == "unavailable" else None
    result = interpret(service, running_mode, config, report, report_age, monitor)
    result["stale_after_sec"] = STALE_SEC
    result["error"] = error
    return result


def shutdown() -> None:
    """End the monitor (the manager is exiting)."""
    with _lock:
        _stop_locked()
