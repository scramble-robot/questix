"""Wi-Fi access point (QUESTiX Local): the 教材 tab's QR codes and the 管理設定 network card.

``scripts/wifi-ap.sh`` (Ansible role ``wifi_access_point``) keeps the access point settings in
``$QUESTIX_CONFIG_DIR/wifi_ap.env``, readable by the robot's login user, which runs this manager.
``GET /api/wifi-ap`` only reads them (and NetworkManager's state) to show "join this Wi-Fi" and
"open the teaching pages" QR codes and the network card; it changes nothing. It listens on
127.0.0.1 only, so the password stays on the robot. The answer also carries the browser
controller's address on the access point and the controller type saved for the next start, so
the printable card can add a controller QR code when it is Web.

The network card changes the access point without a terminal: start, stop, SSID, password, band,
channel and address. This manager never touches the network itself and never runs anything as
root. It validates the request (unknown keys and values refused, the password never echoed),
writes it to ``network_request.json`` in the settings directory and starts
``questix_network_admin.service`` (``systemctl --no-ask-password start``; polkit lets the robot
user start only that unit), which runs the root-owned helper ``network_admin.py`` installed in
``/opt/questix_robot``. The helper validates everything again, applies it like the role and
writes ``network_status.json`` without secrets. One change runs at a time (409 otherwise);
``GET /api/wifi-ap/job`` reports it. After a successful start in practice mode, QUESTiX LAB is
started through lab.py when its automatic start (AUTOSTART) is on; never in competition mode.

Binding to 127.0.0.1 and the loopback-only CORS policy do not stop a web page opened in the
robot's own browser from sending a "simple" cross-site POST (a form, text/plain): the browser
sends it without asking and only hides the answer. Every request that changes the network
therefore has to pass ``_browser_mutation_guard``: ``Content-Type: application/json`` (which a
cross-site page can only send after a CORS preflight the manager refuses), a JSON object body
(``{}`` for start / stop / new password), an ``Origin``, when the browser sends one, equal to
this manager's own loopback origin, and no ``Sec-Fetch-Site`` other than same-origin / none.
The Host header itself is limited to 127.0.0.1 / localhost for the whole app (app.py,
TrustedHostMiddleware), which also keeps DNS-rebinding pages from reading GET /api/wifi-ap.
Scripts that call these endpoints send the JSON header like the page does.
"""

import getpass
import json
import logging
import os
import shlex
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Literal, Optional, Union

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, ValidationError

from robot_manager import lab, network_admin

logger = logging.getLogger(__name__)

CONFIG_DIR = Path(os.environ.get("QUESTIX_CONFIG_DIR", "/etc/questix_robot"))
WIFI_AP_ENV_FILE = CONFIG_DIR / "wifi_ap.env"
# Port of the browser controller (web_joy_driver, used when CONTROLLER_TYPE=web in launch.env).
WEB_JOY_PORT = int(os.environ.get("WEB_JOY_PORT", "8899"))
# NetworkManager profile written by the wifi_access_point role.
CONNECTION_NAME = network_admin.CONNECTION_NAME
# The root helper and its unit (questix_network_admin.service runs HELPER_PATH).
HELPER_PATH = Path("/opt/questix_robot/questix_network_admin.py")
ADMIN_UNIT = "questix_network_admin.service"
REQUEST_FILE = CONFIG_DIR / network_admin.REQUEST_NAME
STATUS_FILE = CONFIG_DIR / network_admin.STATUS_NAME
# The unit's TimeoutStartSec is 120 s; systemctl start waits for the oneshot to finish.
JOB_TIMEOUT_SEC = 150
SYS_NET = Path("/sys/class/net")

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


def _tool(argv: list[str]) -> str:
    """Stdout of a read-only tool (argument list, no shell), '' when it cannot run."""
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=3, check=False,
                              shell=False).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def _active() -> bool:
    return CONNECTION_NAME in _tool(["nmcli", "-t", "-f", "NAME", "connection", "show",
                                     "--active"]).splitlines()


def _clients(interface: str) -> Optional[int]:
    """Devices joined to the access point now, None when it cannot be read."""
    if not network_admin.INTERFACE_RE.fullmatch(interface):
        return None
    output = _tool(["iw", "dev", interface, "station", "dump"])
    if not output and not (SYS_NET / interface).is_dir():
        return None
    return sum(1 for line in output.splitlines() if line.startswith("Station "))


def _upstream(interface: str) -> dict:
    """Return what NetworkManager's shared mode can forward learners' traffic to (read only).

    ``default_route``: this robot has a default route through another interface (a wired LAN
    with a router, usually the school network). ``wired``: a wired interface has a link.
    """
    default_route = False
    for line in _tool(["ip", "-4", "-o", "route", "show", "default"]).splitlines():
        words = line.split()
        dev = words[words.index("dev") + 1] if "dev" in words[:-1] else ""
        if dev and dev != interface:
            default_route = True
    wired = False
    try:
        names = sorted(path.name for path in SYS_NET.iterdir())
    except OSError:
        names = []
    for name in names:
        if name == interface or not name.startswith(("eth", "en")):
            continue
        try:
            if (SYS_NET / name / "carrier").read_text().strip() == "1":
                wired = True
        except OSError:
            pass
    summary = "default_route" if default_route else "wired" if wired else "none"
    return {"summary": summary, "wired": wired, "default_route": default_route}


def _admin_available() -> bool:
    """Return whether the root helper is installed (kit setup or update-robot-manager.sh)."""
    return HELPER_PATH.is_file()


@router.get("")
def get_access_point():
    """Return the access point settings for the QR codes and the network card (read only)."""
    settings = _read_settings()
    if settings is None:
        return {"configured": False, "admin_available": _admin_available(), "job": _job_view()}
    address = settings.get("address", "").split("/")[0]
    interface = settings.get("interface") or network_admin.DEFAULT_INTERFACE
    active = _active()
    return {
        "configured": True,
        "active": active,
        "state": settings.get("state", ""),
        "ssid": settings.get("ssid", ""),
        "password": settings.get("password", ""),
        "band": settings.get("band", ""),
        "channel": settings.get("channel", ""),
        "country": settings.get("country", ""),
        "address": address,
        "prefix": settings.get("address", "").partition("/")[2],
        "clients": _clients(interface) if active else None,
        "upstream": _upstream(interface),
        "ssh": f"ssh {getpass.getuser()}@{address}" if address else "",
        "lab_url": f"http://{address}:{lab.LAB_BRIDGE_PORT}/" if address else "",
        "controller_url": f"http://{address}:{WEB_JOY_PORT}/" if address else "",
        "controller_type": lab._read_env_file(lab.LAUNCH_ENV_FILE).get("CONTROLLER_TYPE", ""),
        "admin_available": _admin_available(),
        "job": _job_view(),
    }


# ---------------------------------------------------------------------------
# Changes through the root helper
# ---------------------------------------------------------------------------

# Results found here and not by the helper (it writes the others to network_status.json).
MESSAGES = {
    **network_admin.MESSAGES,
    "not_installed": "この機体には、画面から切り替えるための部品がまだありません"
                     "（sudo scripts/update-robot-manager.sh を実行してください）。",
    "not_permitted": "この機体では、画面から切り替える許可がまだ設定されていません"
                     "（sudo scripts/update-robot-manager.sh を実行してください）。",
    "helper_failed": "切り替えに失敗しました（journalctl -u questix_network_admin で理由を確認できます）。",
    "timeout": "切り替えが時間内に終わりませんでした。状態を確認してください。",
    "request_failed": "切り替えの要求を書き込めませんでした。",
}
LAB_MESSAGES = {
    "started": "教材の配信を開始しました。",
    "running": "教材の配信は動作中です。",
    "competition": "大会モードのため、教材は配信しません。",
    "autostart_off": "教材の自動開始がオフのため、配信は開始していません（教材タブから開始できます）。",
    "failed": "教材の配信を開始できませんでした（教材タブで確認してください）。",
}

_job_lock = threading.Lock()
_job: dict = {"state": "idle"}


def _job_view() -> dict:
    with _job_lock:
        return dict(_job)


class AccessPointConfig(BaseModel):
    """Settings the network card may change; every field is optional (unset = keep)."""

    model_config = ConfigDict(extra="forbid", strict=True)

    ssid: Optional[str] = None
    password: Optional[str] = None
    band: Optional[Literal["bg", "a"]] = None
    channel: Optional[Union[Literal["auto"], int]] = None
    address: Optional[str] = None


LOOPBACK_HOSTS = ("127.0.0.1", "localhost")


def _host_name(host: str) -> str:
    return host.rsplit(":", 1)[0].lower() if host.count(":") == 1 else host.lower()


def _browser_mutation_guard(request: Request) -> None:
    """Refuse a network change that a cross-site page could have sent (see the module doc)."""
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type != "application/json":
        raise HTTPException(status_code=415,
                            detail="Content-Type: application/json の要求だけを受け付けます")
    host = request.headers.get("host", "")
    if _host_name(host) not in LOOPBACK_HOSTS:
        raise HTTPException(status_code=403, detail="このロボットの画面からの要求ではありません")
    origin = request.headers.get("origin")
    if origin is not None and origin.lower() != f"http://{host}".lower():
        raise HTTPException(status_code=403, detail="このロボットの画面からの要求ではありません")
    fetch_site = request.headers.get("sec-fetch-site")
    if fetch_site is not None and fetch_site not in ("same-origin", "none"):
        raise HTTPException(status_code=403, detail="このロボットの画面からの要求ではありません")


async def _json_body(request: Request):
    """Return the guarded request's JSON body ({} when empty); 422 without echoing it."""
    _browser_mutation_guard(request)
    raw = await request.body()
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=422, detail="JSON で送ってください")


async def _empty_body(request: Request) -> None:
    body = await _json_body(request)
    if body != {}:
        raise HTTPException(status_code=422, detail="この操作に本文は要りません（{} を送ってください）")


def _refuse(field: str, message: str):
    # Never the submitted value: it may be the password.
    raise HTTPException(status_code=422, detail=f"{field}: {message}")


def _validated_settings(body) -> dict:
    """Return the requested changes, checked like the helper, or a 422 echoing no value."""
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="JSON オブジェクトで送ってください")
    unknown = sorted(set(body) - set(network_admin.SETTING_KEYS))
    if unknown:
        raise HTTPException(status_code=422, detail=f"変更できない項目です: {', '.join(unknown)[:200]}")
    try:
        config = AccessPointConfig(**body)
    except ValidationError as error:
        fields = sorted({str(item["loc"][0]) for item in error.errors() if item.get("loc")})
        raise HTTPException(status_code=422, detail=f"値の形式が正しくありません: {', '.join(fields)}")
    settings = config.model_dump(exclude_none=True)
    if not settings:
        raise HTTPException(status_code=422, detail="変更する項目がありません")
    if "ssid" in settings and not network_admin.valid_ssid(settings["ssid"]):
        _refuse("ssid", "2〜32 文字の英数字・空白・_ . - で入力してください（先頭と末尾に空白は使えません）")
    if "password" in settings and not network_admin.valid_password(settings["password"]):
        _refuse("password", "8〜63 文字の半角英数字・記号で入力してください（空白と \\ は使えません）")
    if "channel" in settings and settings["channel"] != "auto":
        band = settings.get("band") or (_read_settings() or {}).get("band") or "bg"
        if not network_admin.valid_channel(settings["channel"], band):
            channels = "・".join(str(c) for c in network_admin.CHANNELS[band])
            _refuse("channel", f"この周波数帯で選べるのは {channels} または自動です")
    if "address" in settings and settings["address"] != "auto" \
            and network_admin.parse_address(settings["address"]) is None:
        _refuse("address", "10.42.0.1/24 のようなプライベートアドレスで入力してください（/16〜/30）")
    return settings


def _write_request(request: dict) -> None:
    """Hand the request to the helper: a new 0600 file renamed into place (no link followed)."""
    dir_fd = os.open(CONFIG_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        network_admin.write_atomic(dir_fd, REQUEST_FILE.name, json.dumps(request), 0o600)
    finally:
        os.close(dir_fd)


def _remove_request() -> None:
    try:
        REQUEST_FILE.unlink()
    except FileNotFoundError:
        pass
    except OSError as error:
        logger.warning("network request not removed: %s", error.strerror)


def _read_status(request_id: str) -> Optional[dict]:
    try:
        status = json.loads(STATUS_FILE.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(status, dict) or status.get("id") != request_id:
        return None
    return status


def _systemctl_start() -> subprocess.CompletedProcess:
    """Start the helper's unit and wait for it (the only unit polkit allows for this)."""
    return subprocess.run(
        ["systemctl", "--no-ask-password", "start", ADMIN_UNIT],
        capture_output=True, text=True, timeout=JOB_TIMEOUT_SEC, check=False, shell=False,
    )


def _start_lab() -> str:
    """Start QUESTiX LAB after a successful start: practice mode with AUTOSTART on only."""
    if lab._competition_mode():
        return "competition"
    if lab._read_config().get("AUTOSTART") != "true":
        return "autostart_off"
    try:
        lab.start_bridge()
    except HTTPException as error:
        if error.status_code == 409 and "配信中" in str(error.detail):
            return "running"
        logger.warning("QUESTiX LAB after QUESTiX Local start: %s", error.detail)
        return "failed"
    return "started"


def _finish(request_id: str, **fields) -> None:
    global _job
    with _job_lock:
        if _job.get("id") == request_id:
            _job = {**_job, **fields, "finished_at": time.time()}


def _run_job(request_id: str, action: str) -> None:
    try:
        try:
            result = _systemctl_start()
        except (OSError, subprocess.TimeoutExpired):
            result = None
        status = _read_status(request_id)
        if status is not None and status.get("state") in ("succeeded", "failed"):
            state, code = status["state"], status.get("code", "")
        elif result is None:
            state, code = "failed", "timeout"
        elif result.returncode != 0:
            stderr = result.stderr.lower()
            state = "failed"
            if "not found" in stderr or "not loaded" in stderr:
                code = "not_installed"
            elif "authentication" in stderr or "access denied" in stderr or "authoriz" in stderr:
                code = "not_permitted"
            else:
                code = "helper_failed"
            logger.warning("%s: exit %s: %s", ADMIN_UNIT, result.returncode, result.stderr.strip()[:300])
        else:
            state, code = "failed", "helper_failed"
        code = code if code in MESSAGES else "helper_failed"
        fields = {"state": state, "code": code, "message": MESSAGES[code]}
        if state == "succeeded" and action == "start":
            lab_result = _start_lab()
            fields.update(lab=lab_result, lab_message=LAB_MESSAGES[lab_result])
        _finish(request_id, **fields)
    except Exception:  # never leave the job "running" forever
        logger.exception("QUESTiX Local job failed")
        _finish(request_id, state="failed", code="helper_failed", message=MESSAGES["helper_failed"])
    finally:
        _remove_request()  # the helper removes it; not when it never ran (it may hold the password)


def _submit(action: str, settings: Optional[dict] = None) -> JSONResponse:
    """Start one change through the helper; 409 while another one runs."""
    global _job
    request_id = uuid.uuid4().hex
    request = {"version": 1, "id": request_id, "action": action, "settings": settings or {}}
    # Same checks as the helper, so a request it would refuse is refused here already.
    try:
        network_admin.validate_request(request)
    except network_admin.AdminError as error:
        raise HTTPException(status_code=422, detail=MESSAGES.get(error.code, "要求が正しくありません"))
    with _job_lock:
        if _job.get("state") == "running":
            raise HTTPException(status_code=409, detail="切り替え中です。終わるまでお待ちください。")
        if not _admin_available():
            raise HTTPException(status_code=503, detail=MESSAGES["not_installed"])
        if action in ("stop", "regenerate_password") and _read_settings() is None:
            raise HTTPException(status_code=409, detail=MESSAGES["not_configured"])
        try:
            _write_request(request)
        except OSError as error:
            logger.warning("network request not written: %s", error.strerror)
            raise HTTPException(status_code=500, detail=MESSAGES["request_failed"])
        _job = {"id": request_id, "action": action, "state": "running", "code": "",
                "message": "切り替え中…", "started_at": time.time()}
        job = dict(_job)
    threading.Thread(target=_run_job, args=(request_id, action), name="questix-local",
                     daemon=True).start()
    return JSONResponse(status_code=202, content=job)


@router.put("/config")
async def put_config(request: Request):
    """Save SSID / password / band / channel / address (applied at once while the AP is on)."""
    return _submit("configure", _validated_settings(await _json_body(request)))


@router.post("/start")
async def start_access_point(request: Request):
    """Start QUESTiX Local (creates the settings on the first start, like wifi-ap.sh up)."""
    await _empty_body(request)
    return _submit("start")


@router.post("/stop")
async def stop_access_point(request: Request):
    """Stop QUESTiX Local; NetworkManager's saved Wi-Fi client profiles take over."""
    await _empty_body(request)
    return _submit("stop")


@router.post("/regenerate-password")
async def regenerate_password(request: Request):
    """Generate a new password (applied at once while the access point is on)."""
    await _empty_body(request)
    return _submit("regenerate_password")


@router.get("/job")
def get_job():
    """Return the last change requested from this manager (idle when none since start)."""
    return _job_view()
