"""QUESTiX LAB console: run the lab bridge from robot_manager.

robot_manager itself only listens on 127.0.0.1 (its API controls the robot service without
authentication), so learners' devices cannot open ``/lab/`` here. The ``questix_lab_bridge``
node can: it serves the same teaching pages on the LAN and mirrors robot telemetry to them.
This module starts and stops that node so nobody has to type ``ros2 launch``.

With ``ALLOW_DRIVE`` on (the default in practice mode) pages may run low-speed driving
experiments, each confirmed by the learner's safety tick on the page and bounded by the bridge's
own checks (questix_lab_bridge/questix_lab_bridge/drive.py); twist_arbiter lets the controller
take over at any time. ``/api/lab/drive`` is the teacher's off switch. Competition mode turns
driving off (and does not stream at all); going back to practice mode restores what the teacher had
chosen before competition mode (``PRACTICE_*`` in lab.env), so an explicit forbid survives the
round trip.

``ALLOW_SHOOT`` works the same way for the disc launcher (roller, tilt, firing one disc; the
bridge's questix_lab_bridge/questix_lab_bridge/shoot.py): on by default in practice mode, each
firing session confirmed by the learner's safety tick, the controller taking over at any time,
``/api/lab/shoot`` the teacher's off switch, off in competition mode and restored with practice
mode like driving. Both permissions are always
passed to the bridge explicitly (``-p allow_drive:=…`` / ``-p allow_shoot:=…``), so the defaults
in its lab_bridge.yaml never decide.

The status reports what the running bridge itself says (``GET /api/state`` on its port), so the
tab shows whether pages can really drive now, also for a bridge started by hand, and how many
records the bridge keeps on the robot (its ``records``: count, size, quota, folder).

``stop_lesson_motion`` (Robot Manager's 「すべて止める」) ends whatever a page runs right now: it
opens a WebSocket to the bridge like a page and sends ``{"type": "stop"}`` and
``{"type": "roller_stop"}``, which any page may send; the bridge keeps running and no page
disconnects.

The bridge keeps the pages' records in ``records_dir`` (its own default in
questix_lab_bridge/config/lab_bridge.yaml unless ``RECORDS_DIR`` is set in lab.env) and lists
and converts the rosbags this manager records: it is given the recorder's ``OUTPUT_DIR``. The output of
a bridge started here goes to ``LOG_FILE``; its last lines are shown when it stopped or failed.
"""

import base64
import getpass
import hashlib
import http.client
import json
import logging
import os
import pwd
import re
import signal
import socket
import struct
import subprocess
import threading
import time
import urllib.request
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

from robot_manager import recorder

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
    # "true": the bridge may publish twist_arbiter's lab input for the lessons' driving
    # experiments; each run is confirmed by the learner on the page, and moving the controller's
    # stick takes over. On by default in practice mode; the teacher can switch it off
    # (/api/lab/drive), competition mode switches it off and practice mode on again. Changed
    # only through set_drive and the mode switches, never by the settings form.
    "ALLOW_DRIVE": "true",
    # "true": the bridge may publish the launcher's lab inputs (/roller/lab, /shot/lab/tilt,
    # /shot/lab/fire) for the lessons' launcher experiments; the learner confirms each firing
    # session on the page, and the controller's launcher buttons take over. Same policy as
    # ALLOW_DRIVE: on by default in practice mode, the teacher can switch it off
    # (/api/lab/shoot), competition mode switches it off and practice mode on again; changed only
    # through set_shoot and the mode switches.
    "ALLOW_SHOOT": "true",
    # Folder where the bridge keeps QUESTiX LAB records (pages' saves, controller driving, rosbag
    # conversions). Empty = the bridge's own default (records_dir in
    # questix_lab_bridge/config/lab_bridge.yaml, ~/.local/share/questix/lab-records of the user
    # running it). Set by hand in lab.env; an absolute path.
    "RECORDS_DIR": "",
}
# What the teacher had chosen in practice mode, saved by disable_for_competition and restored (then
# cleared) by enable_for_practice. Kept in lab.env next to the live values, never in _read_config.
_PRACTICE_KEYS = {
    "AUTOSTART": "PRACTICE_AUTOSTART",
    "ALLOW_DRIVE": "PRACTICE_ALLOW_DRIVE",
    "ALLOW_SHOOT": "PRACTICE_ALLOW_SHOOT",
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
# Permissions the lessons get from lab.env; each is passed to the bridge as its parameter.
_PERMISSIONS = {"ALLOW_DRIVE": "allow_drive", "ALLOW_SHOOT": "allow_shoot"}
# Whether the running bridge was started with allow_drive / allow_shoot (lab.env may have changed
# since).
_started_allow_drive = False
_started_allow_shoot = False
# Permissions that had to be switched off but lab.env could not be written: they count as
# "false" anyway until a write succeeds, so a permission problem never leaves them allowed.
_forced_off: set[str] = set()
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
    # A competition robot never takes lab commands, whatever lab.env says (it may have been edited
    # by hand, or never written: driving and the launcher are on by default).
    competition = _competition_mode()
    for key in _PERMISSIONS:
        if competition or key in _forced_off:
            config[key] = "false"
    return config


def _read_practice_snapshot() -> dict[str, str]:
    """Return the saved practice-mode values (AUTOSTART, ALLOW_*) or {} when none is saved."""
    raw = _read_env_file(LAB_ENV_FILE)
    return {key: raw[saved] for key, saved in _PRACTICE_KEYS.items()
            if raw.get(saved) in ("true", "false")}


def _write_config(values: dict[str, str], practice: Optional[dict[str, str]] = None) -> None:
    """Write lab.env: ``values`` plus the practice snapshot (None keeps it, {} clears it)."""
    global _config_error
    if practice is None:
        practice = _read_practice_snapshot()
    lines = [f'{key}="{value}"' for key, value in values.items()]
    lines += [f'{_PRACTICE_KEYS[key]}="{value}"' for key, value in practice.items()]
    try:
        LAB_ENV_FILE.write_text("\n".join(lines) + "\n")
    except PermissionError:
        raise HTTPException(status_code=403, detail=permission_detail(LAB_ENV_FILE))
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"{LAB_ENV_FILE} に書き込めません: {e}")
    # What was written came from _read_config, so it already says "false" for every forced key.
    _forced_off.clear()
    _config_error = None


def _force_off(config: dict[str, str], keys, why: str,
               practice: Optional[dict[str, str]] = None) -> dict[str, str]:
    """Write ``config`` with ``keys`` (ALLOW_*) false; if that fails, log it and keep them off.

    For the places where switching a permission off must not fail: competition mode, 走行を禁止する
    and 発射を禁止する. Returns the config with those keys false.
    """
    global _config_error
    config = {**config, **{key: "false" for key in keys}}
    try:
        _write_config(config, practice)
    except HTTPException as error:
        _forced_off.update(keys)
        _config_error = error.detail
        logger.error("QUESTiX LAB (%s): %s — %s stays off until lab.env can be written",
                     why, error.detail, ", ".join(keys))
    return config


def _competition_mode() -> bool:
    try:
        return MODE_FILE.read_text().strip() == COMPETITION_MODE
    except OSError:
        return False


def _rosbag_dir() -> Optional[str]:
    """Return the recorder's OUTPUT_DIR (rosbag.env), for the bridge to list; None if unusable."""
    try:
        output_dir = recorder._read_config().get("OUTPUT_DIR", "")
    except OSError as error:
        logger.warning("QUESTiX LAB: rosbag.env unreadable, the bridge uses its default: %s", error)
        return None
    return output_dir if _ABS_PATH_RE.match(output_dir) else None


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
    # Always explicit: lab_bridge.yaml has its own defaults (allow_drive: true for a bridge started
    # by hand), and a switched-off permission must never fall back to them.
    for key, parameter in _PERMISSIONS.items():
        args += ["-p", f"{parameter}:={'true' if config.get(key) == 'true' else 'false'}"]
    records_dir = config.get("RECORDS_DIR", "")
    if records_dir:
        if not _ABS_PATH_RE.match(records_dir):
            raise HTTPException(
                status_code=400,
                detail=f"{LAB_ENV_FILE} の RECORDS_DIR が不正です（/ で始まるパスにしてください）",
            )
        args += ["-p", f'records_dir:="{records_dir}"']
    rosbag_dir = _rosbag_dir()
    if rosbag_dir:
        # The bags this manager records (録画 tab), listed and converted for the lessons.
        args += ["-p", f'rosbag_dir:="{rosbag_dir}"']
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


# --- 「すべて止める」: end the pages' driving run and launcher session ---------------------------
# The bridge accepts {"type": "stop"} and {"type": "roller_stop"} from any page
# (questix_lab_bridge/README.md, "Protocol"); the manager sends them over a WebSocket of its own
# like a page would. A minimal RFC 6455 client, so the manager needs no websockets package (it
# stays out of requirements.txt, which keeps ROS 2's apt python3-websockets untouched).
STOP_TIMEOUT_SEC_WS = 1.5
# How long to wait for /api/state to report both sessions ended.
STOP_CONFIRM_SEC = 1.5
_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _ws_frame(opcode: int, payload: bytes) -> bytes:
    """One final client frame (clients must mask); lengths in network byte order."""
    head = bytes([0x80 | opcode])
    length = len(payload)
    if length < 126:
        head += bytes([0x80 | length])
    elif length < 1 << 16:
        head += bytes([0x80 | 126]) + struct.pack("!H", length)
    else:
        head += bytes([0x80 | 127]) + struct.pack("!Q", length)
    mask = os.urandom(4)
    return head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))


def _ws_send_texts(port: int, texts: list[str], timeout: float = STOP_TIMEOUT_SEC_WS) -> None:
    """Open a WebSocket to 127.0.0.1:port, send ``texts`` as text frames, then close cleanly.

    Raises OSError (also for a refused upgrade, e.g. the bridge's client limit). The server's
    frames (hello, states) are not needed and are read only to wait for its close.
    """
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as conn:
        conn.settimeout(timeout)
        conn.sendall((
            "GET / HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "User-Agent: questix-robot-manager\r\n\r\n").encode("ascii"))
        reply = b""
        while b"\r\n\r\n" not in reply:
            chunk = conn.recv(4096)
            if not chunk:
                raise OSError("the bridge closed the connection during the upgrade")
            reply += chunk
            if len(reply) > 65536:
                raise OSError("the bridge sent an unexpected answer")
        head = reply.split(b"\r\n\r\n", 1)[0].decode("latin-1")
        status = head.split("\r\n", 1)[0]
        if " 101 " not in status + " ":
            raise OSError(f"the bridge refused the WebSocket: {status}")
        accept = base64.b64encode(
            hashlib.sha1((key + _WS_GUID).encode("ascii")).digest()).decode("ascii")
        if accept.lower() not in head.lower():
            raise OSError("the bridge answered with a wrong Sec-WebSocket-Accept")
        for text in texts:
            conn.sendall(_ws_frame(0x1, text.encode("utf-8")))
        conn.sendall(_ws_frame(0x8, struct.pack("!H", 1000)))
        # The bridge handles the frames in order before our close; wait for its side to close.
        deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < deadline and conn.recv(65536):
                pass
        except OSError:
            pass  # a timeout here only means the close handshake was slow; the frames went out


def stop_lesson_motion() -> dict:
    """End the pages' driving run and launcher session now (Robot Manager's 「すべて止める」).

    Never raises. The bridge (ours or one started by hand) keeps running and the pages stay
    connected: a pupil can start again, which the manager's stop of the robot service prevents
    physically. Returns ``{"ok", "message", "bridge": bool, "drive_active", "shoot_active"}``
    (the two actives as /api/state reports them after the stop; None when unknown).
    """
    if not _port_in_use():
        return {"ok": True, "bridge": False, "drive_active": None, "shoot_active": None,
                "message": "教材の配信は止まっています（教材からは何も動いていません）"}
    before = _bridge_state() or {}
    was_active = bool((before.get("drive_state") or {}).get("active")
                      or (before.get("shoot_state") or {}).get("active"))
    try:
        _ws_send_texts(LAB_BRIDGE_PORT, ['{"type":"stop"}', '{"type":"roller_stop"}'])
    except OSError as error:
        logger.warning("QUESTiX LAB: could not send stop to the bridge: %s", error)
        return {"ok": False, "bridge": True, "drive_active": None, "shoot_active": None,
                "message": f"教材のブリッジに停止を送れませんでした（{error}）"}
    deadline = time.monotonic() + STOP_CONFIRM_SEC
    while True:
        state = _bridge_state()
        drive = (state or {}).get("drive_state") or {}
        shoot = (state or {}).get("shoot_state") or {}
        drive_active = drive.get("active") if state else None
        shoot_active = shoot.get("active") if state else None
        if state and not drive_active and not shoot_active:
            break
        if time.monotonic() >= deadline:
            break
        time.sleep(0.1)
    if state is None:
        return {"ok": True, "bridge": True, "drive_active": None, "shoot_active": None,
                "message": "教材の走行・発射に停止を送りました（結果はブリッジから確認できません）"}
    if drive_active or shoot_active:
        return {"ok": False, "bridge": True, "drive_active": bool(drive_active),
                "shoot_active": bool(shoot_active),
                "message": "教材に停止を送りましたが、まだ動作中と報告されています"}
    return {"ok": True, "bridge": True, "drive_active": False, "shoot_active": False,
            "message": ("教材の走行・発射を止めました" if was_active
                        else "教材では何も動いていませんでした（念のため停止を送りました）")}


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
        # Competition mode: no streaming, no lab driving or launching (the tab disables them).
        "competition": _competition_mode(),
        "urls": [f"http://{a}:{LAB_BRIDGE_PORT}/" for a in _lan_addresses()],
        "elapsed_sec": int(time.time() - _started_at) if managed and _started_at else 0,
        "last_stop_reason": _last_stop_reason,
        "config": config,
        # What lab.env asks for, and what the bridge started here was started with (null: none,
        # or not ours). The truth for driving is bridge.read_only.
        "drive_allowed": config.get("ALLOW_DRIVE") == "true",
        "drive_running": _started_allow_drive if managed else None,
        # The same for the launcher; the truth is bridge.shoot_state.allowed.
        "shoot_allowed": config.get("ALLOW_SHOOT") == "true",
        "shoot_running": _started_allow_shoot if managed else None,
        # The running bridge's own GET /api/state (ours or started by hand); null when none
        # answers.
        "bridge": _bridge_state() if managed or external else None,
        # A failed write of lab.env that did not fail the request (see _force_off).
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
    global _proc, _started_at, _last_stop_reason, _started_allow_drive, _started_allow_shoot
    with _lock:
        if _proc is not None and _proc.poll() is None:
            raise HTTPException(status_code=409, detail="教材はすでに配信中です")
        if _port_in_use():
            raise HTTPException(
                status_code=409,
                detail=f"ポート {LAB_BRIDGE_PORT} は使用中です（手動で起動したブリッジを止めてください）",
            )
        if _competition_mode():
            # Competition runs must not stream telemetry to the LAN (disable_for_competition).
            raise HTTPException(
                status_code=409,
                detail="大会モードでは教材を配信しません（練習モードに切り替えると配信できます）",
            )
        if not (LAB_DIR / "index.html").is_file():
            raise HTTPException(status_code=500, detail="教材のファイルが見つかりません")
        config = _read_config()
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
                    "教材の配信を開始できませんでした（ROS 環境と questix_lab_bridge のビルドを確認してください）。"
                    f"「ブリッジのログ」または {LOG_FILE} に理由が出ています"
                ),
            )
        _proc = proc
        _started_at = time.time()
        _last_stop_reason = None
        _started_allow_drive = config.get("ALLOW_DRIVE") == "true"
        _started_allow_shoot = config.get("ALLOW_SHOOT") == "true"
        return _status_payload()


@router.post("/stop")
def stop_bridge():
    with _lock:
        if _proc is None or _proc.poll() is not None:
            raise HTTPException(status_code=409, detail="教材は配信していません")
        _stop_locked("stopped")
        return _status_payload()


@router.put("/config")
def set_config(config: LabConfig):
    """Persist bridge settings; they take effect the next time the bridge starts."""
    values = {
        key: (str(value).lower() if isinstance(value, bool) else value)
        for key, value in config.model_dump().items()
    }
    _write_config({**_read_config(), **values})  # keeps ALLOW_DRIVE / ALLOW_SHOOT as they are
    return values


@router.post("/drive")
def set_drive(request: DriveRequest):
    """Allow or forbid the lessons' driving experiments, and restart our bridge to apply it.

    A bridge this manager runs is restarted at once, so the switch never says one thing while
    the bridge does another (every connected page drops for a few seconds and reconnects). A
    bridge started by hand keeps its own parameters: the status reports drive_running = null
    for it, and its bridge.read_only tells what it does.

    Forbidding always works: if lab.env cannot be written, driving stays off in this manager
    (config_error says why) and the bridge is still restarted with allow_drive:=false.
    """
    return _set_permission("ALLOW_DRIVE", request.allow,
                           "大会モードでは教材から走らせられません", "走行を禁止する",
                           "drive_setting")


@router.post("/shoot")
def set_shoot(request: DriveRequest):
    """Allow or forbid the lessons' launcher experiments (roller, tilt, fire), like set_drive.

    Our bridge is restarted at once, so the switch never says one thing while the bridge does
    another; forbidding always works, even when lab.env cannot be written.
    """
    return _set_permission("ALLOW_SHOOT", request.allow,
                           "大会モードでは教材から発射させられません", "発射を禁止する",
                           "shoot_setting")


def _set_permission(key: str, allow: bool, competition_detail: str, why: str,
                    stop_reason: str) -> dict:
    """Write one ALLOW_* switch and restart a bridge of ours so it applies (set_drive/set_shoot)."""
    if allow and _competition_mode():
        raise HTTPException(status_code=409, detail=competition_detail)
    config = _read_config()
    if allow:
        _write_config({**config, key: "true"})
    else:
        _force_off(config, (key,), why)
    with _lock:
        running = _proc is not None and _proc.poll() is None
        if running:
            _stop_locked(stop_reason)
    if running and not _competition_mode():  # a competition robot does not stream at all
        start_bridge()
    with _lock:
        return _status_payload()


def disable_for_competition() -> None:
    """Keep the bridge off once the robot is switched to competition mode (app.py /api/mode).

    Competition runs must not stream telemetry to the LAN: a bridge this manager started is
    stopped first (whatever happens to lab.env), then automatic start, driving and the launcher
    from the lessons (AUTOSTART, ALLOW_DRIVE, ALLOW_SHOOT) are turned off in lab.env. What the
    teacher had chosen for practice is saved first (PRACTICE_* in lab.env, only if nothing is
    saved yet, so competition -> competition keeps the practice values), and enable_for_practice
    restores exactly that. A failed write of lab.env is logged, not raised: the mode switch itself
    has already happened, and autostart never runs in competition mode anyway.
    """
    with _lock:
        if _proc is not None and _proc.poll() is None:
            _stop_locked("competition_mode")
    snapshot = None
    if not _read_practice_snapshot():
        raw = _read_env_file(LAB_ENV_FILE)
        snapshot = {}
        for key in _PRACTICE_KEYS:
            value = raw.get(key, _DEFAULT_CONFIG[key])
            # A forbid that could not be written still counts as a forbid.
            snapshot[key] = "false" if key in _forced_off or value != "true" else "true"
    config = _read_config()
    if snapshot is not None or config.get("AUTOSTART") != "false" or any(
            _read_env_file(LAB_ENV_FILE).get(key) != "false" for key in _PERMISSIONS):
        _force_off({**config, "AUTOSTART": "false"}, tuple(_PERMISSIONS), "competition mode",
                   practice=snapshot)


def enable_for_practice() -> dict:
    """Undo disable_for_competition when the robot goes from competition back to practice mode.

    Automatic start and the two permissions get the values the teacher had before competition
    mode (all on when nothing was saved, e.g. the mode file was changed by hand), and the saved
    values are cleared. When automatic start is on, the bridge is started now, in the background
    like at boot, so the class can open the pages right away; a bridge that already runs (started
    here or by hand) is left alone. Returns what is on now, for the manager's message:
    ``{"restored": bool, "autostart": bool, "drive": bool, "shoot": bool}``.
    """
    snapshot = _read_practice_snapshot()
    config = _read_config()
    wanted = {key: snapshot.get(key, "true") for key in _PRACTICE_KEYS}
    if any(config.get(key) != value for key, value in wanted.items()) or snapshot:
        _write_config({**config, **wanted}, practice={})
    if wanted["AUTOSTART"] == "true":
        with _lock:
            running = (_proc is not None and _proc.poll() is None) or _port_in_use()
        if not running:
            threading.Thread(target=_autostart, name="lab-practice-start", daemon=True).start()
    return {
        "restored": bool(snapshot),
        "autostart": wanted["AUTOSTART"] == "true",
        "drive": wanted["ALLOW_DRIVE"] == "true",
        "shoot": wanted["ALLOW_SHOOT"] == "true",
    }


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


def autostart() -> None:
    """Start the bridge when robot_manager starts, if lab.env asks for it (AUTOSTART=true).

    Runs in a thread: starting waits up to START_GRACE_SEC for the node, which must not delay
    the manager's own start-up.
    """
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
