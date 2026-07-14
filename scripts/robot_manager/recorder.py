"""rosbag recording console for robot_manager.

Records ROS 2 bags in MCAP format (so the separate ``rosbag_manager`` catalog can
ingest them) and guards against filling the disk. Recording state is kept in
module-level globals guarded by a lock; uvicorn runs a single worker so this is
sufficient. Bags are named ``<vehicle>_<timestamp>`` so the recording machine is
identifiable from the bag (directory) name alone, which ``rosbag_manager`` uses as
the display name.
"""

import os
import re
import shutil
import signal
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

CONFIG_DIR = Path(os.environ.get("QUESTIX_CONFIG_DIR", "/etc/questix_robot"))
LAUNCH_ENV_FILE = CONFIG_DIR / "launch.env"
ROSBAG_ENV_FILE = CONFIG_DIR / "rosbag.env"

# ros2 bag record needs SIGINT to finalize metadata.yaml + the MCAP summary.
STOP_TIMEOUT_SEC = 20
WATCH_INTERVAL_SEC = 5

_DEFAULT_CONFIG = {
    "VEHICLE_NAME": "robot",
    "OUTPUT_DIR": "/var/lib/questix/rosbags",
    "EXCLUDE_TOPICS": "",
    "MIN_FREE_GB": "5",
    "MAX_SPLIT_MB": "0",
    "MAX_DURATION_SEC": "0",
}

# ---------------------------------------------------------------------------
# Input validation (all values below are interpolated into a `bash -lc` string,
# so every field is strictly whitelisted before use).
# ---------------------------------------------------------------------------

_VEHICLE_RE = re.compile(r"^[a-zA-Z0-9_-]+$")
_ABS_PATH_RE = re.compile(r"^/[a-zA-Z0-9_/.~-]*$")
_TOPIC_RE = re.compile(r"^[A-Za-z0-9_/.*+()\[\]|-]+$")
_FOLDER_NAME_RE = re.compile(r"^[a-zA-Z0-9_.-]+$")

router = APIRouter(prefix="/api/rosbag")

# ---------------------------------------------------------------------------
# Recording state (guarded by _lock)
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_proc: Optional[subprocess.Popen] = None
_bag_name: Optional[str] = None
_bag_path: Optional[Path] = None
_started_at: Optional[float] = None
_last_stop_reason: Optional[str] = None


# ---------------------------------------------------------------------------
# Config helpers (mirrors app.py's _read_env / _write_env KEY=value pattern)
# ---------------------------------------------------------------------------

def _read_env_file(path: Path) -> dict[str, str]:
    """Parse a shell-style KEY=value file, skipping comments and blanks."""
    result: dict[str, str] = {}
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)", line)
            if m:
                result[m.group(1)] = m.group(2)
    except FileNotFoundError:
        pass
    return result


def _read_config() -> dict[str, str]:
    """Return recorder config: defaults overlaid with rosbag.env."""
    config = dict(_DEFAULT_CONFIG)
    config.update(_read_env_file(ROSBAG_ENV_FILE))
    return config


def _write_config(config: dict[str, str]) -> None:
    """Write rosbag.env preserving a header comment."""
    lines = [
        "# Questix rosbag recorder configuration",
        "# Managed by robot_manager — edit via Web UI or manually",
        "",
    ]
    for key in _DEFAULT_CONFIG:
        if key in config:
            lines.append(f"{key}={config[key]}")
    lines.append("")
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    ROSBAG_ENV_FILE.write_text("\n".join(lines))


def _robot_ws() -> str:
    """Read ROBOT_WS from launch.env, falling back to a sensible default."""
    return _read_env_file(LAUNCH_ENV_FILE).get("ROBOT_WS", "/home/ubuntu/robot_ws")


# ---------------------------------------------------------------------------
# Disk / filesystem helpers
# ---------------------------------------------------------------------------

def _existing_ancestor(path: Path) -> Path:
    """Return the nearest existing ancestor of path (for disk_usage)."""
    p = path
    while not p.exists() and p != p.parent:
        p = p.parent
    return p


def _disk_usage(output_dir: Path) -> tuple[int, int]:
    """Return (free_bytes, total_bytes) of output_dir's filesystem."""
    try:
        usage = shutil.disk_usage(_existing_ancestor(output_dir))
        return usage.free, usage.total
    except OSError:
        return 0, 0


def _tree_size(path: Path) -> int:
    """Sum the sizes of all files under path (non-recursive symlink follow)."""
    total = 0
    try:
        for root, _dirs, files in os.walk(path):
            for name in files:
                try:
                    total += os.path.getsize(os.path.join(root, name))
                except OSError:
                    pass
    except OSError:
        pass
    return total


def _min_free_bytes(config: dict[str, str]) -> int:
    try:
        return max(0, int(config["MIN_FREE_GB"])) * 1024 ** 3
    except (ValueError, KeyError):
        return 0


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class RecorderConfig(BaseModel):
    """Recorder settings persisted to rosbag.env. All fields optional (PATCH-like)."""

    VEHICLE_NAME: str | None = None
    OUTPUT_DIR: str | None = None
    EXCLUDE_TOPICS: str | None = None
    MIN_FREE_GB: str | None = None
    MAX_SPLIT_MB: str | None = None
    MAX_DURATION_SEC: str | None = None

    @field_validator("VEHICLE_NAME")
    @classmethod
    def _validate_vehicle(cls, v: str | None) -> str | None:
        if v is not None and not _VEHICLE_RE.match(v):
            raise ValueError("VEHICLE_NAME may only contain letters, digits, '_' and '-'")
        return v

    @field_validator("OUTPUT_DIR")
    @classmethod
    def _validate_output_dir(cls, v: str | None) -> str | None:
        if v is not None and not _ABS_PATH_RE.match(v):
            raise ValueError("OUTPUT_DIR must be an absolute path with safe characters")
        return v

    @field_validator("EXCLUDE_TOPICS")
    @classmethod
    def _validate_excludes(cls, v: str | None) -> str | None:
        if v is None:
            return v
        for token in _split_excludes(v):
            if not _TOPIC_RE.match(token):
                raise ValueError(f"Invalid exclude topic pattern: {token}")
        return v

    @field_validator("MIN_FREE_GB", "MAX_SPLIT_MB", "MAX_DURATION_SEC")
    @classmethod
    def _validate_nonneg_int(cls, v: str | None) -> str | None:
        if v is not None and (not v.isdigit()):
            raise ValueError("Value must be a non-negative integer")
        return v


class BagRef(BaseModel):
    """Reference to a bag by its directory name inside OUTPUT_DIR."""

    bag_name: str


class MkdirRequest(BaseModel):
    """Create a new sub-folder `name` under the directory `path`."""

    path: str
    name: str

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not _FOLDER_NAME_RE.match(v):
            raise ValueError("フォルダ名に使えない文字が含まれています")
        return v


# ---------------------------------------------------------------------------
# Command construction
# ---------------------------------------------------------------------------

def _split_excludes(raw: str) -> list[str]:
    """Split an EXCLUDE_TOPICS string on commas/whitespace into tokens."""
    return [t for t in re.split(r"[\s,]+", raw.strip()) if t]


def _build_record_command(config: dict[str, str], bag_path: Path) -> str:
    """Build the `bash -lc` script that sources ROS and runs `ros2 bag record`."""
    robot_ws = _robot_ws()
    if not _ABS_PATH_RE.match(robot_ws):
        raise HTTPException(status_code=400, detail="ROBOT_WS in launch.env is invalid")

    args = ["ros2", "bag", "record", "-a", "-s", "mcap", "-o", f'"{bag_path}"']

    excludes = _split_excludes(config.get("EXCLUDE_TOPICS", ""))
    for token in excludes:
        if not _TOPIC_RE.match(token):
            raise HTTPException(status_code=400, detail=f"Invalid exclude pattern: {token}")
    if excludes:
        # rosbag2 --exclude takes a single regex; join topics as an alternation.
        args += ["-x", f'"({"|".join(excludes)})"']

    try:
        max_split_mb = int(config.get("MAX_SPLIT_MB", "0"))
        max_duration = int(config.get("MAX_DURATION_SEC", "0"))
    except ValueError:
        raise HTTPException(status_code=400, detail="MAX_SPLIT_MB / MAX_DURATION_SEC must be integers")
    if max_split_mb > 0:
        args += ["--max-bag-size", str(max_split_mb * 1000 * 1000)]
    if max_duration > 0:
        args += ["--max-bag-duration", str(max_duration)]

    record_cmd = " ".join(args)
    return (
        "source /opt/ros/jazzy/setup.bash && "
        f'source "{robot_ws}/install/setup.bash" 2>/dev/null; '
        f"exec {record_cmd}"
    )


# ---------------------------------------------------------------------------
# Start / stop core
# ---------------------------------------------------------------------------

def _stop_locked(reason: str) -> None:
    """Send SIGINT to the recording process group and wait. Caller must hold _lock."""
    global _proc, _bag_name, _bag_path, _started_at, _last_stop_reason
    proc = _proc
    if proc is None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGINT)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=STOP_TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        # Escalate only as a last resort; the bag may be left unfinalized.
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            proc.wait(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
    _proc = None
    _bag_name = None
    _bag_path = None
    _started_at = None
    _last_stop_reason = reason


def _watch_disk(output_dir: Path, min_free: int) -> None:
    """Background watcher: auto-stop recording if free space drops below min_free."""
    while True:
        time.sleep(WATCH_INTERVAL_SEC)
        with _lock:
            if _proc is None or _proc.poll() is not None:
                # Recording ended (manually or the process died); nothing to watch.
                return
            free, _total = _disk_usage(output_dir)
            if min_free > 0 and free < min_free:
                _stop_locked("auto_stopped_low_disk")
                return


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

def _status_payload() -> dict:
    config = _read_config()
    output_dir = Path(config["OUTPUT_DIR"])
    free, total = _disk_usage(output_dir)
    recording = _proc is not None and _proc.poll() is None
    size = _tree_size(_bag_path) if (recording and _bag_path) else 0
    elapsed = int(time.time() - _started_at) if (recording and _started_at) else 0
    return {
        "recording": recording,
        "bag_name": _bag_name if recording else None,
        "started_at": _started_at if recording else None,
        "elapsed_sec": elapsed,
        "size_bytes": size,
        "disk_free_bytes": free,
        "disk_total_bytes": total,
        "min_free_bytes": _min_free_bytes(config),
        "last_stop_reason": _last_stop_reason,
    }


@router.get("/status")
def get_status():
    """Return current recording state and disk usage."""
    with _lock:
        # Reap a process that exited on its own (e.g. --max-bag-duration).
        global _proc
        if _proc is not None and _proc.poll() is not None:
            _stop_locked(_last_stop_reason or "process_exited")
        return _status_payload()


@router.post("/start")
def start_recording():
    """Start a new MCAP recording of all topics."""
    global _proc, _bag_name, _bag_path, _started_at, _last_stop_reason
    with _lock:
        if _proc is not None and _proc.poll() is None:
            raise HTTPException(status_code=409, detail="録画中です")

        config = _read_config()
        vehicle = config["VEHICLE_NAME"]
        if not _VEHICLE_RE.match(vehicle):
            raise HTTPException(status_code=400, detail="VEHICLE_NAME が不正です")
        output_dir = Path(config["OUTPUT_DIR"])
        if not _ABS_PATH_RE.match(str(output_dir)):
            raise HTTPException(status_code=400, detail="OUTPUT_DIR が不正です")

        min_free = _min_free_bytes(config)
        free, _total = _disk_usage(output_dir)
        if min_free > 0 and free < min_free:
            raise HTTPException(
                status_code=507,
                detail=f"空き容量不足: {free // 1024**3}GB < {min_free // 1024**3}GB",
            )

        try:
            output_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"出力フォルダを作成できません: {e}")

        bag_name = f"{vehicle}_{datetime.now():%Y%m%d_%H%M%S}"
        bag_path = output_dir / bag_name
        script = _build_record_command(config, bag_path)

        try:
            proc = subprocess.Popen(
                ["bash", "-lc", script],
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"録画を開始できません: {e}")

        _proc = proc
        _bag_name = bag_name
        _bag_path = bag_path
        _started_at = time.time()
        _last_stop_reason = None

        # Fast-fail: if the process dies immediately, ROS/the mcap plugin is
        # likely missing. Surface that as an error instead of a phantom recording.
        time.sleep(0.6)
        if proc.poll() is not None:
            _proc = None
            _bag_name = None
            _bag_path = None
            _started_at = None
            _last_stop_reason = "start_failed"
            raise HTTPException(
                status_code=500,
                detail="録画を開始できませんでした (ROS環境 / rosbag2 mcapプラグインを確認してください)",
            )

        watcher = threading.Thread(
            target=_watch_disk, args=(output_dir, min_free), daemon=True
        )
        watcher.start()
        return {"recording": True, "bag_name": bag_name}


@router.post("/stop")
def stop_recording():
    """Stop the current recording (SIGINT so the bag is finalized)."""
    with _lock:
        if _proc is None or _proc.poll() is not None:
            raise HTTPException(status_code=409, detail="録画していません")
        name = _bag_name
        _stop_locked("stopped")
        return {"recording": False, "bag_name": name}


@router.get("/config")
def get_config():
    """Return the recorder configuration."""
    return _read_config()


@router.put("/config")
def set_config(config: RecorderConfig):
    """Update recorder configuration (rosbag.env)."""
    current = _read_config()
    update = {k: v for k, v in config.model_dump().items() if v is not None}
    current.update(update)
    try:
        _write_config(current)
    except PermissionError:
        raise HTTPException(status_code=403, detail="rosbag.env への書き込み権限がありません")
    return current


@router.get("/list")
def list_bags():
    """List recorded bags in OUTPUT_DIR with size / mtime / mcap presence."""
    config = _read_config()
    output_dir = Path(config["OUTPUT_DIR"])
    bags = []
    total_used = 0
    if output_dir.is_dir():
        for entry in sorted(output_dir.iterdir(), key=lambda p: p.name):
            if entry.name.startswith(".") or not entry.is_dir():
                continue
            has_mcap = any(f.suffix.lower() == ".mcap" for f in entry.glob("*.mcap"))
            recording = _bag_name == entry.name and _proc is not None and _proc.poll() is None
            # Only actual bags are listed; OUTPUT_DIR may contain unrelated
            # folders (e.g. when it points at a home directory). The bag being
            # recorded is always shown, even before its first .mcap appears.
            if not has_mcap and not recording:
                continue
            size = _tree_size(entry)
            total_used += size
            try:
                mtime = entry.stat().st_mtime
            except OSError:
                mtime = 0
            bags.append({
                "name": entry.name,
                "path": str(entry),
                "size_bytes": size,
                "mtime": mtime,
                "has_mcap": has_mcap,
                "recording": recording,
            })
    bags.sort(key=lambda b: b["mtime"], reverse=True)
    return {"output_dir": str(output_dir), "total_used_bytes": total_used, "bags": bags}


@router.delete("/bag")
def delete_bag(ref: BagRef):
    """Delete a bag directory inside OUTPUT_DIR (name-validated, in-dir only)."""
    name = ref.bag_name
    if not name or "/" in name or name.startswith(".") or name in ("", ".", ".."):
        raise HTTPException(status_code=400, detail="バッグ名が不正です")
    config = _read_config()
    output_dir = Path(config["OUTPUT_DIR"]).resolve()
    target = (output_dir / name).resolve()
    if target.parent != output_dir or not target.is_dir():
        raise HTTPException(status_code=404, detail="バッグが見つかりません")
    with _lock:
        if _bag_name == name and _proc is not None and _proc.poll() is None:
            raise HTTPException(status_code=409, detail="録画中のバッグは削除できません")
    try:
        shutil.rmtree(target)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"削除に失敗しました: {e}")
    return {"deleted": name}


# ---------------------------------------------------------------------------
# Server-side directory browser (for choosing OUTPUT_DIR from the web UI)
# ---------------------------------------------------------------------------

def _browse_start_path() -> Path:
    """Return the default starting directory for the folder browser."""
    output_dir = Path(_read_config()["OUTPUT_DIR"])
    if output_dir.is_dir():
        return output_dir
    ancestor = _existing_ancestor(output_dir)
    if ancestor.is_dir():
        return ancestor
    return Path(os.path.expanduser("~"))


@router.get("/locations")
def get_locations():
    """Return shortcut locations (home / default / current / USB mounts) for the picker."""
    locations = []
    seen: set[str] = set()

    def add(label: str, path: Path, kind: str) -> None:
        p = str(path)
        if p not in seen and path.is_dir():
            seen.add(p)
            locations.append({"label": label, "path": p, "kind": kind})

    add("ホーム", Path.home(), "home")
    add("既定", Path(_DEFAULT_CONFIG["OUTPUT_DIR"]), "default")
    add("現在の設定", Path(_read_config()["OUTPUT_DIR"]), "current")

    # Removable media: real mount points under the usual automount roots.
    candidates: list[Path] = []
    for pattern in ("/media/*/*", "/media/*", "/run/media/*/*", "/mnt/*"):
        candidates.extend(Path("/").glob(pattern.lstrip("/")))
    for p in sorted(candidates):
        try:
            if p.is_dir() and os.path.ismount(p):
                add(f"USB: {p.name}", p, "usb")
        except OSError:
            continue

    return {"locations": locations}


@router.get("/browse")
def browse(path: str = ""):
    """List sub-directories of `path` so the UI can navigate the server filesystem."""
    p = _browse_start_path() if not path else Path(path)
    try:
        p = p.resolve()
    except OSError:
        raise HTTPException(status_code=400, detail="パスが不正です")
    if not p.is_dir():
        raise HTTPException(status_code=404, detail="ディレクトリが見つかりません")

    dirs = []
    try:
        for entry in sorted(p.iterdir(), key=lambda e: e.name.lower()):
            if entry.name.startswith("."):
                continue
            try:
                if entry.is_dir():
                    dirs.append({"name": entry.name, "path": str(entry)})
            except OSError:
                continue  # permission denied on a specific entry
    except PermissionError:
        raise HTTPException(status_code=403, detail="このフォルダを開く権限がありません")

    free, total = _disk_usage(p)
    return {
        "path": str(p),
        "parent": str(p.parent) if p != p.parent else None,
        "dirs": dirs,
        "writable": os.access(p, os.W_OK),
        "disk_free_bytes": free,
        "disk_total_bytes": total,
    }


@router.post("/mkdir")
def make_dir(req: MkdirRequest):
    """Create a new sub-folder and return the browse listing of its parent."""
    try:
        parent = Path(req.path).resolve()
    except OSError:
        raise HTTPException(status_code=400, detail="パスが不正です")
    if not parent.is_dir():
        raise HTTPException(status_code=404, detail="親ディレクトリが見つかりません")
    target = (parent / req.name).resolve()
    if target.parent != parent:
        raise HTTPException(status_code=400, detail="フォルダ名が不正です")
    try:
        target.mkdir(exist_ok=False)
    except FileExistsError:
        raise HTTPException(status_code=409, detail="同名のフォルダが既に存在します")
    except PermissionError:
        raise HTTPException(status_code=403, detail="作成する権限がありません")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"作成に失敗しました: {e}")
    return browse(str(parent))
