"""Wi-Fi access point settings for the 教材 tab's QR codes (read only).

``scripts/wifi-ap.sh`` (Ansible role ``wifi_access_point``) keeps the access point settings in
``$QUESTIX_CONFIG_DIR/wifi_ap.env``, readable by the robot's login user, which runs this manager.
The manager only reads them to show "join this Wi-Fi" and "open the teaching pages" QR codes; it
never changes the network. It listens on 127.0.0.1 only, so the password stays on the robot.
The answer also carries the browser controller's address on the access point and the controller
type saved for the next start, so the printable card can add a controller QR code when it is Web.
"""

import os
import shlex
import subprocess
from pathlib import Path

from fastapi import APIRouter

from robot_manager import lab

CONFIG_DIR = Path(os.environ.get("QUESTIX_CONFIG_DIR", "/etc/questix_robot"))
WIFI_AP_ENV_FILE = CONFIG_DIR / "wifi_ap.env"
# Port of the browser controller (web_joy_driver, used when CONTROLLER_TYPE=web in launch.env).
WEB_JOY_PORT = int(os.environ.get("WEB_JOY_PORT", "8899"))
# NetworkManager profile written by the wifi_access_point role.
CONNECTION_NAME = "questix-ap"

router = APIRouter(prefix="/api/wifi-ap")


def _read_settings() -> dict[str, str] | None:
    """Return the WIFI_AP_* values without the prefix, or None when there is no access point."""
    try:
        text = WIFI_AP_ENV_FILE.read_text()
    except (FileNotFoundError, PermissionError):
        return None
    values: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("WIFI_AP_") and "=" in line:
            key, _, value = line.partition("=")
            # The role writes shell-quoted values (Ansible `quote`): a password may contain ' or ".
            try:
                words = shlex.split(value)
            except ValueError:
                continue
            values[key.removeprefix("WIFI_AP_").lower()] = words[0] if words else ""
    return values


def _active() -> bool:
    try:
        output = subprocess.run(
            ["nmcli", "-t", "-f", "NAME", "connection", "show", "--active"],
            capture_output=True, text=True, timeout=3, check=False,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return False
    return CONNECTION_NAME in output.splitlines()


@router.get("")
def get_access_point():
    """Return the access point settings for the QR codes, or configured: false."""
    settings = _read_settings()
    if settings is None:
        return {"configured": False}
    address = settings.get("address", "").split("/")[0]
    return {
        "configured": True,
        "active": _active(),
        "ssid": settings.get("ssid", ""),
        "password": settings.get("password", ""),
        "band": settings.get("band", ""),
        "channel": settings.get("channel", ""),
        "address": address,
        "lab_url": f"http://{address}:{lab.LAB_BRIDGE_PORT}/" if address else "",
        "controller_url": f"http://{address}:{WEB_JOY_PORT}/" if address else "",
        "controller_type": lab._read_env_file(lab.LAUNCH_ENV_FILE).get("CONTROLLER_TYPE", ""),
    }
