"""QUESTiX LAB console: run the read-only lab bridge from robot_manager.

robot_manager itself only listens on 127.0.0.1 (its API controls the robot service without
authentication), so learners' devices cannot open ``/lab/`` here. The ``questix_lab_bridge``
node can: it serves the same teaching pages on the LAN and mirrors robot telemetry to them,
observation only. This module starts and stops that node so nobody has to type ``ros2 launch``.
"""

import os
import re
import signal
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

CONFIG_DIR = Path(os.environ.get("QUESTIX_CONFIG_DIR", "/etc/questix_robot"))
LAUNCH_ENV_FILE = CONFIG_DIR / "launch.env"
LAB_ENV_FILE = CONFIG_DIR / "lab.env"
LAB_DIR = Path(__file__).parent / "static" / "lab"

# Keep in sync with `port` in questix_lab_bridge/config/lab_bridge.yaml, LAB_BRIDGE_PORT in
# app.py (CSP) and DEFAULT_PORT in static/lab/js/live/robot-link.js.
LAB_BRIDGE_PORT = int(os.environ.get("LAB_BRIDGE_PORT", "8897"))

STOP_TIMEOUT_SEC = 5
START_GRACE_SEC = 1.5

_DEFAULT_CONFIG = {
    # sensor_msgs/CompressedImage topic; empty = no camera stream (no camera driver ships
    # with the repository).
    "CAMERA_TOPIC": "",
}
_ABS_PATH_RE = re.compile(r"^/[a-zA-Z0-9_/.~-]*$")
_TOPIC_RE = re.compile(r"^/[A-Za-z0-9_/]*$")
_DOMAIN_RE = re.compile(r"^\d{1,3}$")

router = APIRouter(prefix="/api/lab")

# Bridge process state (guarded by _lock)
_lock = threading.Lock()
_proc: Optional[subprocess.Popen] = None
_started_at: Optional[float] = None
_last_stop_reason: Optional[str] = None


class LabConfig(BaseModel):
    CAMERA_TOPIC: str = ""

    @field_validator("CAMERA_TOPIC")
    @classmethod
    def validate_camera_topic(cls, v: str) -> str:
        v = v.strip()
        if v and not _TOPIC_RE.match(v):
            raise ValueError("CAMERA_TOPIC must be an absolute ROS topic name")
        return v


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
    return config


def _build_command(config: dict[str, str]) -> str:
    """Build the `bash -lc` script that sources ROS and runs the bridge node."""
    launch_env = _read_env_file(LAUNCH_ENV_FILE)
    robot_ws = launch_env.get("ROBOT_WS", "/home/ubuntu/robot_ws")
    if not _ABS_PATH_RE.match(robot_ws):
        raise HTTPException(status_code=400, detail="ROBOT_WS in launch.env is invalid")
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
    return {
        "running": managed,
        "external": external,
        "port": LAB_BRIDGE_PORT,
        "urls": [f"http://{a}:{LAB_BRIDGE_PORT}/" for a in _lan_addresses()],
        "elapsed_sec": int(time.time() - _started_at) if managed and _started_at else 0,
        "last_stop_reason": _last_stop_reason,
        "config": _read_config(),
    }


@router.get("/status")
def get_status():
    with _lock:
        return _status_payload()


@router.post("/start")
def start_bridge():
    """Start the read-only bridge (teaching pages + telemetry on the LAN)."""
    global _proc, _started_at, _last_stop_reason
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
        script = _build_command(_read_config())
        try:
            proc = subprocess.Popen(
                ["bash", "-lc", script],
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"教材の配信を開始できません: {e}")

        # Fast-fail: a missing ROS environment or package makes the process exit at once.
        deadline = time.time() + START_GRACE_SEC
        while time.time() < deadline and proc.poll() is None and not _port_in_use():
            time.sleep(0.1)
        if proc.poll() is not None:
            _last_stop_reason = "start_failed"
            raise HTTPException(
                status_code=500,
                detail="教材の配信を開始できませんでした (ROS環境 / questix_lab_bridge のビルドを確認してください)",
            )
        _proc = proc
        _started_at = time.time()
        _last_stop_reason = None
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
    values = config.model_dump()
    lines = [f'{key}="{value}"' for key, value in values.items()]
    try:
        LAB_ENV_FILE.write_text("\n".join(lines) + "\n")
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied writing lab.env")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"lab.env を書き込めません: {e}")
    return values


def shutdown() -> None:
    """Stop a bridge this manager started; called when robot_manager exits."""
    with _lock:
        _stop_locked("manager_shutdown")
