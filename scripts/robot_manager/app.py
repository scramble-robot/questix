"""QUESTiX Robot Manager — FastAPI backend for systemd service control."""

import logging
import os
import re
import socket
import subprocess
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

from robot_manager import control_runtime, controls, lab, logs, recorder, wifi_ap

CONFIG_DIR = Path(os.environ.get("QUESTIX_CONFIG_DIR", "/etc/questix_robot"))
MODE_FILE = CONFIG_DIR / "mode"
ENV_FILE = CONFIG_DIR / "launch.env"
SERVICE_NAME = "questix_robot"
# Practice mode starts the robot only on request: before `systemctl start|restart` in practice
# mode the manager writes this file, and systemd/questix_robot_launcher.sh consumes it (see the
# format there). Without it the launcher skips practice launches (power-on, a crash restart).
START_REQUEST_FILE = CONFIG_DIR / "start-request"
# Written by the launcher right before each launch: what is running (mode, time, boot id).
LAST_LAUNCH_FILE = CONFIG_DIR / "last-launch"
BOOT_ID_FILE = Path("/proc/sys/kernel/random/boot_id")
# After systemctl returns: how long the launcher gets to take the start request, then how long a
# launch must keep running to count as started (a missing package fails within this time).
START_PICKUP_SEC = 4.0
START_SETTLE_SEC = 1.5
STOP_SETTLE_SEC = 3.0
POLL_SEC = 0.25

logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).parent / "static"
LAB_DIR = STATIC_DIR / "lab"

MANAGER_PORT = int(os.environ.get("MANAGER_PORT", "8888"))
# Port of the read-only questix_lab_bridge node (defined once, in lab.py).
LAB_BRIDGE_PORT = lab.LAB_BRIDGE_PORT

_DEFAULT_CSP = "default-src 'self'"
# QUESTiX LAB (/lab) renders lesson figures with inline style attributes, canvas data/blob
# images, listens to the lab bridge WebSocket and reads the records the bridge keeps on the
# robot (GET /api/records*, /api/rosbags* on the bridge's port). Scripts stay limited to
# 'self'; the manager UI itself keeps the strict default policy.
_LAB_CSP = (
    "default-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    f"connect-src 'self' ws://*:{LAB_BRIDGE_PORT} http://*:{LAB_BRIDGE_PORT}"
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Start the lab bridge if lab.env asks for it; a bridge started here must not outlive us.

    The teacher's permissions for driving and launching from the lessons (ALLOW_DRIVE /
    ALLOW_SHOOT in lab.env) are kept as they are across a restart of the manager. A practice start
    request left behind (the manager stopped between writing it and the launcher reading it) is
    removed, so it can never start the robot later.

    A lifespan instead of add_event_handler/on_event: Starlette 1.0 removed the event handlers
    from the application (FastAPI 0.135 no longer offers app.add_event_handler), while lifespan
    works on every FastAPI since 0.93.
    """
    _remove_start_request()
    lab.autostart()
    try:
        yield
    finally:
        lab.shutdown()


app = FastAPI(title="QUESTiX Robot Manager", lifespan=lifespan)

# When a stop of the robot service was last asked for through this manager (any page), so the
# pages can tell a practice launch that ended by itself (not restarted: see START_REQUEST_FILE)
# from one that was stopped.
_stop_requested_at: float | None = None

# ---------------------------------------------------------------------------
# Security middleware
# ---------------------------------------------------------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        f"http://127.0.0.1:{MANAGER_PORT}",
        f"http://localhost:{MANAGER_PORT}",
    ],
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type"],
)

app.include_router(recorder.router)
app.include_router(logs.router)
app.include_router(lab.router)
app.include_router(wifi_ap.router)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    """Apply browser security and cache revalidation headers."""
    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    is_lab = request.url.path == "/lab" or request.url.path.startswith("/lab/")
    response.headers["Content-Security-Policy"] = _LAB_CSP if is_lab else _DEFAULT_CSP
    # Force revalidation so updated static assets (HTML/JS/CSS) are picked up
    # immediately after an edit instead of being served stale from browser cache.
    response.headers["Cache-Control"] = "no-cache"
    return response


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

_SAFE_PATH_RE = re.compile(r"^[a-zA-Z0-9_/.~-]+$")
_BOOL_VALUES = {"true", "false"}


class ModeRequest(BaseModel):
    """Select the mode to use at the next robot start."""

    mode: Literal["practice", "competition"]


_CONTROLLER_TYPES = set(controls.CONTROLLERS)


class LaunchConfig(BaseModel):
    """Validate editable launch environment fields."""

    ROBOT_WS: str | None = None
    ROS_DOMAIN_ID: str | None = None
    ENABLE_LIDAR: str | None = None
    ENABLE_SHOT: str | None = None
    ENABLE_DRIVE: str | None = None
    ENABLE_GPIO_REF: str | None = None
    ENABLE_RVIZ: str | None = None
    CONTROLLER_TYPE: str | None = None

    @field_validator("ROBOT_WS")
    @classmethod
    def validate_robot_ws(cls, v: str | None) -> str | None:
        """Allow only supported workspace path characters."""
        if v is not None and not _SAFE_PATH_RE.match(v):
            raise ValueError("ROBOT_WS contains invalid characters")
        return v

    @field_validator("ROS_DOMAIN_ID")
    @classmethod
    def validate_domain_id(cls, v: str | None) -> str | None:
        """Limit the ROS domain identifier to its supported range."""
        if v is not None:
            if not v.isdigit() or not (0 <= int(v) <= 232):
                raise ValueError("ROS_DOMAIN_ID must be an integer 0-232")
        return v

    @field_validator("ENABLE_LIDAR", "ENABLE_SHOT", "ENABLE_DRIVE", "ENABLE_GPIO_REF", "ENABLE_RVIZ")
    @classmethod
    def validate_bool_flags(cls, v: str | None) -> str | None:
        """Require the boolean strings consumed by the launcher."""
        if v is not None and v not in _BOOL_VALUES:
            raise ValueError("Value must be 'true' or 'false'")
        return v

    @field_validator("CONTROLLER_TYPE")
    @classmethod
    def validate_controller_type(cls, v: str | None) -> str | None:
        """Restrict profiles to supported controller types."""
        if v is not None and v not in _CONTROLLER_TYPES:
            raise ValueError("CONTROLLER_TYPE must be one of: uart, dualshock, web")
        return v


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_mode() -> str:
    try:
        return MODE_FILE.read_text().strip()
    except FileNotFoundError:
        return "practice"


def _read_env() -> dict[str, str]:
    """Parse a shell-style KEY=value env file, skipping comments and blanks."""
    result: dict[str, str] = {}
    try:
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)", line)
            if m:
                result[m.group(1)] = m.group(2)
    except FileNotFoundError:
        pass
    return result


def _write_env(config: dict[str, str]) -> None:
    """Write launch.env preserving a header comment."""
    lines = [
        "# QUESTiX Robot Launch Configuration",
        "# Managed by robot_manager — edit via Web UI or manually",
        "",
    ]
    for key, value in config.items():
        lines.append(f"{key}={value}")
    lines.append("")  # trailing newline
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    ENV_FILE.write_text("\n".join(lines))


def _service_status() -> str:
    """Return systemctl is-active result."""
    try:
        r = subprocess.run(
            ["systemctl", "is-active", SERVICE_NAME],
            capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip()
    except Exception:
        return "unknown"


def _systemctl(action: str) -> None:
    """Run ``systemctl start|stop|restart questix_robot``; raise HTTPException on failure."""
    try:
        r = subprocess.run(
            ["systemctl", "--no-ask-password", action, f"{SERVICE_NAME}.service"],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            raise HTTPException(status_code=500, detail=r.stderr.strip() or r.stdout.strip())
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="systemctl timed out")
    except OSError as exc:
        raise HTTPException(status_code=503, detail="サービス操作を実行できません。"
                            "担当者にサービスのインストール状態を確認してください。") from exc


def _boot_id() -> str:
    try:
        return BOOT_ID_FILE.read_text().strip()
    except OSError:
        return ""


def _read_key_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        for line in path.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep:
                values[key.strip()] = value.strip()
    except OSError:
        pass
    return values


def _write_start_request(mode: str) -> float:
    """Write START_REQUEST_FILE atomically (the launcher never sees half a file); return its time."""
    requested_at = time.time()
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=CONFIG_DIR, prefix=".start-request.")
    try:
        with os.fdopen(fd, "w") as out:
            out.write(f"mode={mode}\nrequested_at={int(requested_at)}\nboot_id={_boot_id()}\n")
        os.chmod(tmp, 0o644)
        os.replace(tmp, START_REQUEST_FILE)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return requested_at


def _remove_start_request() -> None:
    try:
        START_REQUEST_FILE.unlink()
    except FileNotFoundError:
        pass
    except OSError as error:  # the launcher ignores it after START_REQUEST_MAX_AGE_SEC anyway
        logger.warning("cannot remove %s: %s", START_REQUEST_FILE, error)


def _last_launch() -> dict[str, str]:
    """Return what the launcher last started in this boot ({} when nothing or another boot)."""
    values = _read_key_values(LAST_LAUNCH_FILE)
    boot = _boot_id()
    if not values or not boot or values.get("boot_id") != boot:
        return {}
    return values


def _running_mode(service: str) -> str | None:
    """Return the running launch's mode: practice / competition / unknown, or None if stopped."""
    if service not in ("active", "reloading", "deactivating"):
        return None
    mode = _last_launch().get("mode")
    # "unknown": started before this version of the launcher, which did not record it.
    return mode if mode in ("practice", "competition") else "unknown"


def _wait_for(predicate, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while True:
        if predicate():
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(POLL_SEC)


_NAMES = {"practice": "練習用", "competition": "大会用"}


def _start_result(action: str, mode: str, requested_at: float | None) -> dict:
    """Say what a start/restart really did (the toast must never claim a start that did not happen).

    Practice: the launcher must take the request (START_PICKUP_SEC) and the launch must still run
    START_SETTLE_SEC later. Competition: the launch must still run after START_SETTLE_SEC.
    """
    def result(ok: bool, message: str, state: str) -> dict:
        return {"action": action, "result": "ok", "ok": ok, "mode": mode, "state": state,
                "running_mode": _running_mode(state), "message": message}

    if requested_at is not None:
        taken = _wait_for(lambda: not START_REQUEST_FILE.exists(), START_PICKUP_SEC)
        if not taken:
            _remove_start_request()  # must never start the robot later
            state = _service_status()
            return result(False, "起動できませんでした：ロボットの起動スクリプトが練習モードの起動に"
                          "対応していないか、応答がありません。担当者に起動スクリプトの更新"
                          "（scripts/install-robot-manager.sh の再実行）を依頼してください。", state)
    time.sleep(START_SETTLE_SEC)
    state = _service_status()
    launched = _last_launch()
    try:
        launched_after = float(launched.get("started_at", "0")) >= int(requested_at or 0)
    except ValueError:
        launched_after = False
    if state == "active":
        if requested_at is not None and not launched_after:
            return result(False, "起動できませんでした：起動スクリプトが練習用の起動を受け付けませんでした。"
                          "診断ログ（ロボット制御のログ）で理由を確認してください。", state)
        return result(True, f"{_NAMES.get(mode, '')}の構成で起動しました", state)
    if requested_at is not None and not launched_after:
        return result(False, "起動できませんでした：起動スクリプトが練習用の起動を受け付けませんでした。"
                      "診断ログ（ロボット制御のログ）で理由を確認してください。", state)
    if mode == "practice":
        return result(False, "起動できませんでした：練習用の起動がすぐに終了しました（練習モードでは"
                      "自動で起動し直しません）。診断ログ（ロボット制御のログ）を確認してください。", state)
    return result(False, "起動できませんでした：ロボット制御がすぐに終了しました。"
                  "診断ログ（ロボット制御のログ）を確認してください。", state)


def _stop_service() -> dict:
    """Stop the robot service (never raises); used by /api/service/stop and /api/stop-all."""
    global _stop_requested_at
    _stop_requested_at = time.time()
    _remove_start_request()
    try:
        _systemctl("stop")
    except HTTPException as error:
        return {"ok": False, "state": _service_status(), "detail": str(error.detail),
                "message": f"ロボット制御を止められませんでした（{error.detail}）"}
    _wait_for(lambda: _service_status() not in ("active", "deactivating"), STOP_SETTLE_SEC)
    state = _service_status()
    if state in ("active", "deactivating", "activating"):
        return {"ok": False, "state": state, "detail": "",
                "message": "ロボット制御に停止を指示しました。まだ止まりきっていません"}
    return {"ok": True, "state": state, "detail": "", "message": "ロボット制御を止めました"}


def _robot_name() -> str:
    return socket.gethostname()


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------

@app.get("/api/status")
def get_status():
    """Return saved mode, the running mode, launch settings and current service state."""
    service = _service_status()
    return {
        "mode": _read_mode(),
        "service": service,
        # The mode of the running launch (None while stopped): may differ from `mode`, which is
        # the one the next start uses.
        "running_mode": _running_mode(service),
        "launch_config": _read_env(),
        # The host name: also what the lab pages show as the robot's name (questix_lab_bridge's
        # robot_name defaults to it).
        "robot_name": _robot_name(),
        "stop_requested_at": _stop_requested_at,
        "server_time": time.time(),
    }


@app.get("/api/readiness")
def get_readiness():
    """Inspect saved configuration and setup paths without accessing hardware."""
    config = _read_env()
    controller = config.get('CONTROLLER_TYPE')
    profile = {'ok': False, 'message': 'コントローラー設定を担当者に確認してください。'}
    if controller in _CONTROLLER_TYPES:
        try:
            controls.read_profile(CONFIG_DIR, controller, config)
            profile = {'ok': True, 'message': '読み込み・入力値の確認済み'}
        except HTTPException as exc:
            profile = {'ok': False, 'message': str(exc.detail)}
    try:
        control_runtime._ros_paths(config)
        workspace = {'ok': True, 'message': 'ROS・ワークスペースの起動ファイルあり'}
    except HTTPException as exc:
        workspace = {'ok': False, 'message': str(exc.detail)}
    return {'controller': controller, 'profile': profile, 'workspace': workspace}


@app.post("/api/mode")
def set_mode(req: ModeRequest):
    """Save the next startup mode without restarting the robot."""
    previous = _read_mode()
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        MODE_FILE.write_text(req.mode + "\n")
    except PermissionError:
        raise HTTPException(status_code=403, detail=lab.permission_detail(MODE_FILE))
    # QUESTiX LAB streams telemetry to the LAN: off for competitions; back to the teacher's
    # practice choices (not simply on) for practice.
    lab_now = None
    if req.mode == "competition":
        lab.disable_for_competition()
    elif previous == "competition":
        try:
            lab_now = lab.enable_for_practice()
        except HTTPException as error:
            lab_now = {"error": str(error.detail)}
    service = _service_status()
    running = _running_mode(service)
    return {
        "mode": req.mode,
        "previous": previous,
        # What QUESTiX LAB is set to now after going back to practice (None otherwise).
        "lab": lab_now,
        "service": service,
        "running_mode": running,
        # The robot keeps running in its old mode until it is restarted.
        "restart_needed": running is not None and running != req.mode,
    }


@app.post("/api/service/{action}")
def control_service(action: Literal["start", "stop", "restart"]):
    """Run the requested service action and report what really happened.

    In practice mode a start or restart first writes the start request the launcher needs
    (START_REQUEST_FILE); the answer says whether the practice launch is running afterwards
    (``ok``, ``message``), never just that systemctl returned.
    """
    if action == "stop":
        stopped = _stop_service()
        if not stopped["ok"] and stopped["detail"]:
            raise HTTPException(status_code=500, detail=stopped["detail"])
        return {"action": action, "result": "ok", "ok": stopped["ok"], "state": stopped["state"],
                "mode": _read_mode(), "running_mode": None, "message": stopped["message"]}
    mode = _read_mode()
    requested_at = None
    if mode == "practice":
        try:
            requested_at = _write_start_request("practice")
        except PermissionError:
            raise HTTPException(status_code=403, detail=lab.permission_detail(START_REQUEST_FILE))
        except OSError as error:
            raise HTTPException(status_code=500,
                                detail=f"{START_REQUEST_FILE} に書き込めません: {error}")
    try:
        _systemctl(action)
    except HTTPException:
        if requested_at is not None:
            _remove_start_request()
        raise
    return _start_result(action, mode, requested_at)


@app.post("/api/stop-all")
def stop_all():
    """「すべて止める」: stop the robot service and end any lesson run and launcher session.

    One request, no confirmation. The lessons get their stop first (it takes well under a second
    and also covers a robot whose ROS was started by hand), then the robot service is stopped.
    The lab bridge keeps running (no restart, pages stay connected); the teacher's permissions
    for driving and launching from the lessons are not changed.
    """
    lesson = lab.stop_lesson_motion()
    service = _stop_service()
    return {"ok": lesson["ok"] and service["ok"], "lab": lesson,
            "service": {key: service[key] for key in ("ok", "state", "message")}}


@app.get("/api/launch-config")
def get_launch_config():
    """Return the saved launch environment."""
    return _read_env()


@app.put("/api/launch-config")
def set_launch_config(config: LaunchConfig):
    """Persist validated launch fields for the next robot start."""
    current = _read_env()
    update = {k: v for k, v in config.model_dump().items() if v is not None}
    current.update(update)
    try:
        _write_env(current)
    except PermissionError:
        raise HTTPException(status_code=403, detail=lab.permission_detail(ENV_FILE))
    return current


@app.get("/api/control-runtime")
def get_control_runtime():
    """Read running ROS parameters without applying any saved settings."""
    return control_runtime.read_snapshot(_read_env())


@app.get("/api/control-config/{controller}")
def get_control_config(controller: controls.Controller):
    """Return the saved controls for the selected controller profile."""
    return controls.read_profile(CONFIG_DIR, controller, _read_env())


@app.put("/api/control-config/{controller}")
def set_control_config(controller: controls.Controller, config: controls.ControlUpdate):
    """Persist controls for the next robot start without restarting the service."""
    return controls.write_profile(CONFIG_DIR, controller, _read_env(), config)


# ---------------------------------------------------------------------------
# Static file serving
# ---------------------------------------------------------------------------

@app.get("/")
def index():
    """Serve the Robot Manager interface."""
    return FileResponse(STATIC_DIR / "index.html")


# QUESTiX LAB web teaching material (simulator lessons + read-only live robot data).
app.mount("/lab", StaticFiles(directory=str(LAB_DIR), html=True), name="lab")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
