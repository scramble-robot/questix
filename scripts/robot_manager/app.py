"""Questix Robot Manager — FastAPI backend for systemd service control."""

import os
import re
import subprocess
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

CONFIG_DIR = Path(os.environ.get("QUESTIX_CONFIG_DIR", "/etc/questix_robot"))
MODE_FILE = CONFIG_DIR / "mode"
ENV_FILE = CONFIG_DIR / "launch.env"
SERVICE_NAME = "questix_robot"

STATIC_DIR = Path(__file__).parent / "static"

MANAGER_PORT = int(os.environ.get("MANAGER_PORT", "8888"))

app = FastAPI(title="Questix Robot Manager")

# ---------------------------------------------------------------------------
# Security middleware
# ---------------------------------------------------------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        f"http://127.0.0.1:{MANAGER_PORT}",
        f"http://localhost:{MANAGER_PORT}",
    ],
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["Content-Type"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Content-Security-Policy"] = "default-src 'self'"
    return response


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

_SAFE_PATH_RE = re.compile(r"^[a-zA-Z0-9_/.~-]+$")
_BOOL_VALUES = {"true", "false"}


class ModeRequest(BaseModel):
    mode: Literal["practice", "competition"]


class LaunchConfig(BaseModel):
    ROBOT_WS: str | None = None
    ROS_DOMAIN_ID: str | None = None
    ENABLE_LIDAR: str | None = None
    ENABLE_SHOT: str | None = None
    ENABLE_DRIVE: str | None = None
    ENABLE_GPIO_REF: str | None = None
    ENABLE_RVIZ: str | None = None

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
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        MODE_FILE.write_text(req.mode + "\n")
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied writing mode file")
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


@app.get("/api/logs")
def get_logs(n: int = 50):
    n = min(max(n, 1), 500)
    try:
        r = subprocess.run(
            ["journalctl", "-u", SERVICE_NAME, "--no-pager", "-n", str(n)],
            capture_output=True, text=True, timeout=10,
        )
        return {"logs": r.stdout}
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to retrieve logs")


# ---------------------------------------------------------------------------
# Static file serving
# ---------------------------------------------------------------------------

@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
