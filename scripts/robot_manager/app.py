"""Questix Robot Manager — FastAPI backend for systemd service control."""

import os
import re
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

from robot_manager import lab, logs, recorder, wifi_ap

CONFIG_DIR = Path(os.environ.get("QUESTIX_CONFIG_DIR", "/etc/questix_robot"))
MODE_FILE = CONFIG_DIR / "mode"
ENV_FILE = CONFIG_DIR / "launch.env"
SERVICE_NAME = "questix_robot"

STATIC_DIR = Path(__file__).parent / "static"
LAB_DIR = STATIC_DIR / "lab"

MANAGER_PORT = int(os.environ.get("MANAGER_PORT", "8888"))
# Port of the read-only questix_lab_bridge node (defined once, in lab.py).
LAB_BRIDGE_PORT = lab.LAB_BRIDGE_PORT

_DEFAULT_CSP = "default-src 'self'"
# QUESTiX LAB (/lab) renders lesson figures with inline style attributes, canvas data/blob
# images, and listens to the lab bridge WebSocket. Scripts stay limited to 'self'; the
# manager UI itself keeps the strict default policy.
_LAB_CSP = (
    "default-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    f"connect-src 'self' ws://*:{LAB_BRIDGE_PORT}"
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Start the lab bridge if lab.env asks for it; a bridge started here must not outlive us.

    A lifespan instead of add_event_handler/on_event: Starlette 1.0 removed the event handlers
    from the application (FastAPI 0.135 no longer offers app.add_event_handler), while lifespan
    works on every FastAPI since 0.93.
    """
    lab.autostart()
    try:
        yield
    finally:
        lab.shutdown()


app = FastAPI(title="Questix Robot Manager", lifespan=lifespan)

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
    mode: Literal["practice", "competition"]


_CONTROLLER_TYPES = {"uart", "dualshock"}


class LaunchConfig(BaseModel):
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
        if v is not None and not _SAFE_PATH_RE.match(v):
            raise ValueError("ROBOT_WS contains invalid characters")
        return v

    @field_validator("ROS_DOMAIN_ID")
    @classmethod
    def validate_domain_id(cls, v: str | None) -> str | None:
        if v is not None:
            if not v.isdigit() or not (0 <= int(v) <= 232):
                raise ValueError("ROS_DOMAIN_ID must be an integer 0-232")
        return v

    @field_validator("ENABLE_LIDAR", "ENABLE_SHOT", "ENABLE_DRIVE", "ENABLE_GPIO_REF", "ENABLE_RVIZ")
    @classmethod
    def validate_bool_flags(cls, v: str | None) -> str | None:
        if v is not None and v not in _BOOL_VALUES:
            raise ValueError("Value must be 'true' or 'false'")
        return v

    @field_validator("CONTROLLER_TYPE")
    @classmethod
    def validate_controller_type(cls, v: str | None) -> str | None:
        if v is not None and v not in _CONTROLLER_TYPES:
            raise ValueError("CONTROLLER_TYPE must be 'uart' or 'dualshock'")
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
        "# Questix Robot Launch Configuration",
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


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------

@app.get("/api/status")
def get_status():
    return {
        "mode": _read_mode(),
        "service": _service_status(),
        "launch_config": _read_env(),
    }


@app.post("/api/mode")
def set_mode(req: ModeRequest):
    previous = _read_mode()
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        MODE_FILE.write_text(req.mode + "\n")
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied writing mode file")
    # QUESTiX LAB streams telemetry to the LAN: off for competitions, back on for practice.
    if req.mode == "competition":
        lab.disable_for_competition()
    elif previous == "competition":
        lab.enable_for_practice()
    return {"mode": req.mode}


@app.post("/api/service/{action}")
def control_service(action: Literal["start", "stop", "restart"]):
    try:
        r = subprocess.run(
            ["systemctl", "--no-ask-password", action, f"{SERVICE_NAME}.service"],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            raise HTTPException(status_code=500, detail=r.stderr.strip() or r.stdout.strip())
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="systemctl timed out")
    return {"action": action, "result": "ok"}


@app.get("/api/launch-config")
def get_launch_config():
    return _read_env()


@app.put("/api/launch-config")
def set_launch_config(config: LaunchConfig):
    current = _read_env()
    update = {k: v for k, v in config.model_dump().items() if v is not None}
    current.update(update)
    try:
        _write_env(current)
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied writing launch.env")
    return current


# ---------------------------------------------------------------------------
# Static file serving
# ---------------------------------------------------------------------------

@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


# QUESTiX LAB web teaching material (simulator lessons + read-only live robot data).
app.mount("/lab", StaticFiles(directory=str(LAB_DIR), html=True), name="lab")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
