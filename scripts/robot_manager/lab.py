"""QUESTiX LAB console: run the lab bridge from robot_manager.

robot_manager itself only listens on 127.0.0.1 (its API controls the robot service without
authentication), so learners' devices cannot open ``/lab/`` here. The ``questix_lab_bridge``
node can: it serves the same teaching pages on the LAN and mirrors robot telemetry to them.
This module starts and stops that node so nobody has to type ``ros2 launch``.

The bridge is observation only unless ``ALLOW_DRIVE`` is on (``/api/lab/drive``): then pages
may run low-speed driving experiments, under the bridge's own checks
(questix_lab_bridge/questix_lab_bridge/drive.py). It is off by default, turned off by
competition mode, and turned off again whenever robot_manager starts: permission to drive never
carries over a restart.

The status reports what the running bridge itself says (``GET /api/state`` on its port), so the
tab shows whether pages can really drive now, also for a bridge started by hand. The output of
a bridge started here goes to ``LOG_FILE``; its last lines are shown when it stopped or failed.
"""

import getpass
import http.client
import json
import logging
import os
import pwd
import re
import signal
import socket
import subprocess
import threading
import time
import urllib.request
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

CONFIG_DIR = Path(os.environ.get("QUESTIX_CONFIG_DIR", "/etc/questix_robot"))
LAUNCH_ENV_FILE = CONFIG_DIR / "launch.env"
LAB_ENV_FILE = CONFIG_DIR / "lab.env"
# Written by app.py (/api/mode) and read by the robot launcher; "competition" or "practice".
MODE_FILE = CONFIG_DIR / "mode"
COMPETITION_MODE = "competition"
LAB_DIR = Path(__file__).parent / "static" / "lab"

# Keep in sync with `port` in questix_lab_bridge/config/lab_bridge.yaml, LAB_BRIDGE_PORT in
# app.py (CSP) and DEFAULT_PORT in static/lab/js/live/robot-link.js.
LAB_BRIDGE_PORT = int(os.environ.get("LAB_BRIDGE_PORT", "8897"))
# The bridge's JSON snapshot (questix_lab_bridge/README.md, "GET /api/state").
BRIDGE_STATE_URL = f"http://127.0.0.1:{LAB_BRIDGE_PORT}/api/state"
# The status is polled every few seconds; a bridge that does not answer this fast counts as down.
BRIDGE_STATE_TIMEOUT_SEC = 0.5

STOP_TIMEOUT_SEC = 5
START_GRACE_SEC = 1.5

# stdout/stderr of the bridge started here; truncated on every start.
LOG_FILE = Path.home() / ".cache" / "questix" / "lab-bridge.log"
LOG_TAIL_LINES = 15
# last_stop_reason values after which the log tells what went wrong.
_FAILURE_REASONS = ("exited", "start_failed", "autostart_failed")

_DEFAULT_CONFIG = {
    # sensor_msgs/CompressedImage topic; empty = no camera stream (no camera driver ships
    # with the repository).
    "CAMERA_TOPIC": "",
    # "true": start the bridge whenever robot_manager starts (i.e. at boot), so a class can open
    # the pages without anyone pressing 配信開始 first. On by default for classes; switching to
    # competition mode turns it off (disable_for_competition), and it never starts in that mode.
    "AUTOSTART": "true",
    # "true": the bridge may publish /target_twist for the lessons' driving experiments. Off by
    # default; a person at the robot turns it on for a class (/api/lab/drive). Competition mode
    # and every start of robot_manager (reset_drive_at_startup) turn it off again. Changed only
    # through set_drive, never by the settings form.
    "ALLOW_DRIVE": "false",
}
_ABS_PATH_RE = re.compile(r"^/[a-zA-Z0-9_/.~-]*$")
_TOPIC_RE = re.compile(r"^/[A-Za-z0-9_/]*$")
_DOMAIN_RE = re.compile(r"^\d{1,3}$")

router = APIRouter(prefix="/api/lab")
logger = logging.getLogger(__name__)

# Bridge process state (guarded by _lock)
_lock = threading.Lock()
_proc: Optional[subprocess.Popen] = None
_started_at: Optional[float] = None
_last_stop_reason: Optional[str] = None
# Whether the running bridge was started with allow_drive (lab.env may have changed since).
_started_allow_drive = False
# Driving had to be switched off but lab.env could not be written: it counts as "false" anyway
# until a write succeeds, so a permission problem never leaves driving allowed.
_drive_forced_off = False
# Why the last such write failed (shown in the tab until a write succeeds).
_config_error: Optional[str] = None


class DriveRequest(BaseModel):
    allow: bool


class LabConfig(BaseModel):
    CAMERA_TOPIC: str = ""
    AUTOSTART: bool = True

    @field_validator("CAMERA_TOPIC")
    @classmethod
    def validate_camera_topic(cls, v: str) -> str:
        v = v.strip()
        if v and not _TOPIC_RE.match(v):
            raise ValueError("カメラのトピックは / で始まるROSのトピック名にしてください")
        return v


def _owner(path: Path) -> str:
    try:
        uid = path.stat().st_uid
    except OSError:
        return "?"
    try:
        return pwd.getpwuid(uid).pw_name
    except KeyError:
        return str(uid)


def permission_detail(path: Path) -> str:
    """Explain a PermissionError on a settings file: who we run as, who owns it, and the fix.

    Typical cause: the robot's login user is not the one the installer set the directory up
    for (e.g. ``scramble`` instead of ``ubuntu``), so every save in the manager fails.
    """
    user = getpass.getuser()
    directory = path.parent
    owners = f"{directory} の所有者は {_owner(directory)}"
    targets = [str(directory)]
    if path.exists():
        owners += f"、{path.name} の所有者は {_owner(path)}"
        targets.append(str(path))
    return (
        f"{path} に書き込めません。Robot Manager はユーザー {user} で動いていますが、"
        f"{owners} です。ロボットの端末で次を実行してください: "
        f"sudo chown {user}:{user} {' '.join(targets)}"
    )


def _read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip('"')
    except FileNotFoundError:
        pass
    return values


def _read_config() -> dict[str, str]:
    config = dict(_DEFAULT_CONFIG)
    config.update({k: v for k, v in _read_env_file(LAB_ENV_FILE).items() if k in config})
    if _drive_forced_off:
        config["ALLOW_DRIVE"] = "false"
    return config


def _write_config(values: dict[str, str]) -> None:
    global _drive_forced_off, _config_error
    lines = [f'{key}="{value}"' for key, value in values.items()]
    try:
        LAB_ENV_FILE.write_text("\n".join(lines) + "\n")
    except PermissionError:
        raise HTTPException(status_code=403, detail=permission_detail(LAB_ENV_FILE))
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"{LAB_ENV_FILE} に書き込めません: {e}")
    _drive_forced_off = False
    _config_error = None


def _force_drive_off(config: dict[str, str], why: str) -> dict[str, str]:
    """Write ``config`` with ALLOW_DRIVE=false; if that fails, log it and keep driving off anyway.

    For the places where switching driving off must not fail: robot_manager's start,
    competition mode and 走行を禁止する. Returns the config with ALLOW_DRIVE=false.
    """
    global _drive_forced_off, _config_error
    config = {**config, "ALLOW_DRIVE": "false"}
    try:
        _write_config(config)
    except HTTPException as error:
        _drive_forced_off = True
        _config_error = error.detail
        logger.error("QUESTiX LAB (%s): %s — driving stays off until lab.env can be written",
                     why, error.detail)
    return config


def _competition_mode() -> bool:
    try:
        return MODE_FILE.read_text().strip() == COMPETITION_MODE
    except OSError:
        return False


def _build_command(config: dict[str, str]) -> str:
    """Build the `bash -lc` script that sources ROS and runs the bridge node."""
    launch_env = _read_env_file(LAUNCH_ENV_FILE)
    robot_ws = launch_env.get("ROBOT_WS", "/home/ubuntu/robot_ws")
    if not _ABS_PATH_RE.match(robot_ws):
        raise HTTPException(
            status_code=400,
            detail=f"{LAUNCH_ENV_FILE} の ROBOT_WS が不正です（/ で始まるパスにしてください）",
        )
    camera_topic = config.get("CAMERA_TOPIC", "")
    if camera_topic and not _TOPIC_RE.match(camera_topic):
        raise HTTPException(status_code=400, detail="CAMERA_TOPIC が不正です")

    # The robot runs in the domain from launch.env; the bridge must listen in the same one.
    domain = launch_env.get("ROS_DOMAIN_ID", "")
    export_domain = f"export ROS_DOMAIN_ID={domain}; " if _DOMAIN_RE.match(domain) else ""

    args = [
        "ros2", "run", "questix_lab_bridge", "lab_bridge_node", "--ros-args",
        "--params-file",
        '"$(ros2 pkg prefix --share questix_lab_bridge)/config/lab_bridge.yaml"',
        "-p", f"port:={LAB_BRIDGE_PORT}",
        # Serve exactly the pages this manager serves at /lab/.
        "-p", f'lab_dir:="{LAB_DIR}"',
    ]
    if camera_topic:  # an empty value would be an rcl parse error, and empty is the default
        args += ["-p", f"camera_topic:={camera_topic}"]
    if config.get("ALLOW_DRIVE") == "true":
        args += ["-p", "allow_drive:=true"]
    return (
        "source /opt/ros/jazzy/setup.bash && "
        f'source "{robot_ws}/install/setup.bash" 2>/dev/null; '
        f"{export_domain}exec {' '.join(args)}"
    )


# Container and VM bridges have addresses too, but no learner device can reach them.
_VIRTUAL_INTERFACE_RE = re.compile(r"^(lo|docker|br-|veth|virbr|tailscale|tun|zt)")


def _lan_addresses() -> list[str]:
    """Return the IPv4 addresses learners can reach this host on (best effort)."""
    addresses: list[str] = []
    try:
        output = subprocess.run(
            ["ip", "-4", "-o", "addr", "show", "scope", "global"],
            capture_output=True, text=True, timeout=2, check=False,
        ).stdout
        for line in output.splitlines():
            fields = line.split()  # "2: wlan0    inet 192.168.1.11/24 brd ..."
            if len(fields) >= 4 and not _VIRTUAL_INTERFACE_RE.match(fields[1]):
                addresses.append(fields[3].split("/")[0])
    except (OSError, subprocess.TimeoutExpired):
        pass
    if not addresses:
        try:
            # connect() on a UDP socket only selects a route; nothing is transmitted.
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                probe.connect(("192.0.2.1", 9))
                addresses = [probe.getsockname()[0]]
        except OSError:
            pass
    return [a for a in addresses if not a.startswith("127.")]


def _port_in_use() -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.3)
        return probe.connect_ex(("127.0.0.1", LAB_BRIDGE_PORT)) == 0


# A proxy from the environment must never see a request for 127.0.0.1.
_local_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _bridge_state() -> Optional[dict]:
    """Return the bridge's own ``GET /api/state``, or None if nothing sensible answers."""
    try:
        with _local_opener.open(BRIDGE_STATE_URL, timeout=BRIDGE_STATE_TIMEOUT_SEC) as reply:
            state = json.loads(reply.read(1 << 16))
    except (OSError, ValueError, http.client.HTTPException):
        # Not running, an older bridge without /api/state (404), or not a bridge at all.
        return None
    return state if isinstance(state, dict) else None


def _open_log():
    """Open LOG_FILE for a new bridge (truncated), or return None if that is impossible."""
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        return LOG_FILE.open("wb")
    except OSError as error:
        logger.warning("QUESTiX LAB bridge output is discarded: cannot write %s: %s",
                       LOG_FILE, error)
        return None


def _log_tail() -> Optional[str]:
    """Return the last LOG_TAIL_LINES lines of LOG_FILE, or None when there is none."""
    try:
        with LOG_FILE.open("rb") as log:
            log.seek(0, os.SEEK_END)
            log.seek(max(0, log.tell() - 16384))
            text = log.read().decode("utf-8", errors="replace")
    except OSError:
        return None
    lines = text.splitlines()[-LOG_TAIL_LINES:]
    return "\n".join(lines) if lines else None


def _stop_locked(reason: str) -> None:
    """Interrupt the bridge's process group and wait. Caller must hold _lock."""
    global _proc, _started_at, _last_stop_reason
    proc = _proc
    if proc is None:
        return
    for sig, timeout in ((signal.SIGINT, STOP_TIMEOUT_SEC), (signal.SIGTERM, 3), (signal.SIGKILL, 3)):
        try:
            os.killpg(os.getpgid(proc.pid), sig)
            proc.wait(timeout=timeout)
            break
        except ProcessLookupError:
            break
        except subprocess.TimeoutExpired:
            continue
    _proc = None
    _started_at = None
    _last_stop_reason = reason


def _status_payload() -> dict:
    global _proc, _started_at, _last_stop_reason
    managed = _proc is not None and _proc.poll() is None
    if _proc is not None and not managed:
        # The node exited on its own (crash, port taken, ROS missing).
        _proc = None
        _started_at = None
        _last_stop_reason = "exited"
    # A bridge started by hand (ros2 launch) is reported, but not ours to stop.
    external = not managed and _port_in_use()
    config = _read_config()
    failed = _last_stop_reason in _FAILURE_REASONS
    return {
        "running": managed,
        "external": external,
        "port": LAB_BRIDGE_PORT,
        "urls": [f"http://{a}:{LAB_BRIDGE_PORT}/" for a in _lan_addresses()],
        "elapsed_sec": int(time.time() - _started_at) if managed and _started_at else 0,
        "last_stop_reason": _last_stop_reason,
        "config": config,
        # What lab.env asks for, and what the bridge started here was started with (null: none,
        # or not ours). The truth for driving is bridge.read_only.
        "drive_allowed": config.get("ALLOW_DRIVE") == "true",
        "drive_running": _started_allow_drive if managed else None,
        # The running bridge's own GET /api/state (ours or started by hand); null when none
        # answers.
        "bridge": _bridge_state() if managed or external else None,
        # A failed write of lab.env that did not fail the request (see _force_drive_off).
        "config_error": _config_error,
        # The end of the last bridge's output, while none of ours runs or after a failure.
        "log_tail": _log_tail() if not managed or failed else None,
        "log_file": str(LOG_FILE),
    }


@router.get("/status")
def get_status():
    with _lock:
        return _status_payload()


@router.post("/start")
def start_bridge():
    """Start the bridge (teaching pages + telemetry on the LAN; driving only if allowed)."""
    global _proc, _started_at, _last_stop_reason, _started_allow_drive
    with _lock:
        if _proc is not None and _proc.poll() is None:
            raise HTTPException(status_code=409, detail="教材の配信は既に動いています")
        if _port_in_use():
            raise HTTPException(
                status_code=409,
                detail=f"ポート {LAB_BRIDGE_PORT} は使用中です (手動で起動したブリッジを止めてください)",
            )
        if not (LAB_DIR / "index.html").is_file():
            raise HTTPException(status_code=500, detail="教材のファイルが見つかりません")
        config = _read_config()
        if _competition_mode() and config.get("ALLOW_DRIVE") == "true":
            # lab.env may have been edited by hand; a competition robot never takes lab commands.
            config = _force_drive_off(config, "competition mode")
        script = _build_command(config)
        log = _open_log()
        try:
            proc = subprocess.Popen(
                ["bash", "-lc", script],
                start_new_session=True,
                stdout=log if log is not None else subprocess.DEVNULL,
                stderr=subprocess.STDOUT if log is not None else subprocess.DEVNULL,
            )
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"教材の配信を開始できません: {e}")
        finally:
            if log is not None:
                log.close()  # the child keeps its own descriptor

        # Fast-fail: a missing ROS environment or package makes the process exit at once.
        deadline = time.time() + START_GRACE_SEC
        while time.time() < deadline and proc.poll() is None and not _port_in_use():
            time.sleep(0.1)
        if proc.poll() is not None:
            _last_stop_reason = "start_failed"
            raise HTTPException(
                status_code=500,
                detail=(
                    "教材の配信を開始できませんでした (ROS環境 / questix_lab_bridge のビルドを確認してください)。"
                    f"「ブリッジのログ」または {LOG_FILE} に理由が出ています"
                ),
            )
        _proc = proc
        _started_at = time.time()
        _last_stop_reason = None
        _started_allow_drive = config.get("ALLOW_DRIVE") == "true"
        return _status_payload()


@router.post("/stop")
def stop_bridge():
    with _lock:
        if _proc is None or _proc.poll() is not None:
            raise HTTPException(status_code=409, detail="教材の配信は動いていません")
        _stop_locked("stopped")
        return _status_payload()


@router.put("/config")
def set_config(config: LabConfig):
    """Persist bridge settings; they take effect the next time the bridge starts."""
    values = {
        key: (str(value).lower() if isinstance(value, bool) else value)
        for key, value in config.model_dump().items()
    }
    _write_config({**_read_config(), **values})  # keeps ALLOW_DRIVE as it is
    return values


@router.post("/drive")
def set_drive(request: DriveRequest):
    """Allow or forbid the lessons' driving experiments, and restart our bridge to apply it.

    A bridge this manager runs is restarted at once, so the switch never says one thing while
    the bridge does another (every connected page drops for a few seconds and reconnects). A
    bridge started by hand keeps its own parameters: the status reports drive_running = null
    for it, and its bridge.read_only tells what it does.

    Forbidding always works: if lab.env cannot be written, driving stays off in this manager
    (config_error says why) and the bridge is still restarted without allow_drive.
    """
    if request.allow and _competition_mode():
        raise HTTPException(status_code=409, detail="大会モードでは教材から走行させられません")
    config = _read_config()
    if request.allow:
        _write_config({**config, "ALLOW_DRIVE": "true"})
    else:
        _force_drive_off(config, "走行を禁止する")
    with _lock:
        running = _proc is not None and _proc.poll() is None
        if running:
            _stop_locked("drive_setting")
    if running:
        start_bridge()
    with _lock:
        return _status_payload()


def disable_for_competition() -> None:
    """Keep the bridge off once the robot is switched to competition mode (app.py /api/mode).

    Competition runs must not stream telemetry to the LAN: a bridge this manager started is
    stopped first (whatever happens to lab.env), then automatic start is turned off in lab.env
    (the checkbox shows it). Switching back to practice mode turns both on again
    (enable_for_practice). Driving from the lessons (ALLOW_DRIVE) is turned off too, and is not
    turned back on by practice mode. A failed write of lab.env is logged, not raised: the mode
    switch itself has already happened, and autostart never runs in competition mode anyway.
    """
    with _lock:
        if _proc is not None and _proc.poll() is None:
            _stop_locked("competition_mode")
    config = _read_config()
    if config.get("AUTOSTART") != "false" or config.get("ALLOW_DRIVE") != "false":
        # Driving from the lessons stays off after returning to practice: someone at the robot
        # turns it on again deliberately.
        _force_drive_off({**config, "AUTOSTART": "false"}, "competition mode")


def enable_for_practice() -> None:
    """Undo disable_for_competition when the robot goes from competition back to practice mode.

    Automatic start is turned on again and the bridge is started now, in the background like at
    boot, so the class can open the pages right away. A bridge that already runs (started here or
    by hand) is left alone.
    """
    config = _read_config()
    if config.get("AUTOSTART") != "true":
        _write_config({**config, "AUTOSTART": "true"})
    with _lock:
        running = (_proc is not None and _proc.poll() is None) or _port_in_use()
    if not running:
        threading.Thread(target=_autostart, name="lab-practice-start", daemon=True).start()


def _autostart() -> None:
    global _last_stop_reason
    try:
        start_bridge()
        logger.info("QUESTiX LAB bridge started automatically (AUTOSTART=true in lab.env)")
    except HTTPException as error:
        # e.g. ROS not built yet, or someone already runs a bridge by hand: say so in the UI.
        with _lock:
            _last_stop_reason = "autostart_failed"
        logger.warning("QUESTiX LAB bridge autostart failed: %s", error.detail)


def reset_drive_at_startup() -> None:
    """Forbid driving from the lessons again whenever robot_manager starts.

    Permission to drive is given by a person at the robot for one class. A reboot, a crash or an
    update of the manager must not bring a robot back up that pages can drive.
    """
    if _read_config().get("ALLOW_DRIVE") == "true":
        logger.warning("QUESTiX LAB: driving from the lessons was still allowed in lab.env; "
                       "forbidden again at robot_manager start (ALLOW_DRIVE=false)")
        _force_drive_off(_read_config(), "robot_manager start")


def autostart() -> None:
    """Start-up of the lab console: forbid driving, then start the bridge if lab.env asks for it.

    Driving is reset synchronously (reset_drive_at_startup), before any bridge can start. The
    bridge itself is started in a thread: starting waits up to START_GRACE_SEC for the node,
    which must not delay the manager's own start-up.
    """
    reset_drive_at_startup()
    if _read_config().get("AUTOSTART") != "true":
        return
    if _competition_mode():
        # lab.env may still say true when the mode file was changed by hand.
        logger.info("QUESTiX LAB bridge not started automatically: competition mode")
        return
    threading.Thread(target=_autostart, name="lab-autostart", daemon=True).start()


def shutdown() -> None:
    """Stop a bridge this manager started; called when robot_manager exits."""
    with _lock:
        _stop_locked("manager_shutdown")
