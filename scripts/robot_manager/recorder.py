"""rosbag recording console for robot_manager.

Records ROS 2 bags in MCAP format (so the separate ``rosbag_manager`` catalog can
ingest them) and guards against filling the disk. Recording state is kept in
module-level globals guarded by a lock; uvicorn runs a single worker so this is
sufficient. Bags are named ``<vehicle>_<timestamp>`` so the recording machine is
identifiable from the bag (directory) name alone, which ``rosbag_manager`` uses as
the display name.

Two recording flavours share that single process, lock and state:

* **generic** — ``POST /start``: unchanged behaviour, no metadata, no sidecars.
* **classroom trial** — ``POST /start-trial``: the same recorder plus the
  evidence described in :mod:`robot_manager.trial` (metadata, exact source
  identity, effective parameters before/after, topic list, bag integrity).

The classroom path adds *evidence*, never a second recording authority and never
any control authority: it publishes nothing, sets no parameter and touches no
device.
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

from robot_manager import trial

CONFIG_DIR = Path(os.environ.get("QUESTIX_CONFIG_DIR", "/etc/questix_robot"))
LAUNCH_ENV_FILE = CONFIG_DIR / "launch.env"
ROSBAG_ENV_FILE = CONFIG_DIR / "rosbag.env"

# ros2 bag record needs SIGINT to finalize metadata.yaml + the MCAP summary.
STOP_TIMEOUT_SEC = 20
WATCH_INTERVAL_SEC = 5
# Bounded wait for the classroom evidence thread when the service shuts down.
SHUTDOWN_FINALIZE_TIMEOUT_SEC = 90

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
# "clean" or "finalize_timeout": whether SIGINT alone finalized the last bag.
_last_finalize_reason: Optional[str] = None
# "generic" or "classroom" while recording; kept for the status payload.
_mode: Optional[str] = None
# Evidence context of the running classroom trial (None for generic recordings).
_trial: Optional[dict] = None
# Summary of the most recent classroom trial (evidence status, warnings, ...).
_last_trial: Optional[dict] = None
# Set while a start is being prepared (preflight/evidence run outside the lock),
# so two concurrent starts cannot both reach `Popen`.
_starting: bool = False
# The background thread collecting after-run evidence, joined on shutdown.
_finalize_thread: Optional[threading.Thread] = None


# ---------------------------------------------------------------------------
# Config helpers (mirrors app.py's _read_env / _write_env KEY=value pattern)
# ---------------------------------------------------------------------------

def _read_env_file(path: Path) -> dict[str, str]:
    """Parse a shell-style KEY=value file, skipping comments and blanks."""
    result: dict[str, str] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)", line)
            if m:
                result[m.group(1)] = m.group(2)
    except FileNotFoundError:
        pass
    except UnicodeError as exc:
        raise OSError(f"failed to decode environment file {path}: {exc}") from exc
    except OSError as exc:
        raise OSError(f"failed to read environment file {path}: {exc}") from exc
    return result


def _read_config() -> dict[str, str]:
    """Return recorder config: defaults overlaid with rosbag.env."""
    config = dict(_DEFAULT_CONFIG)
    config.update(_read_env_file(ROSBAG_ENV_FILE))
    return config


def _read_config_for_api() -> dict[str, str]:
    """Read recorder config, mapping filesystem failures to a safe API error."""
    try:
        return _read_config()
    except OSError as exc:
        raise HTTPException(status_code=500, detail="録画設定を読み込めません") from exc


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


class TrialStartRequest(BaseModel):
    """Optional classroom metadata for a trial recording.

    There is deliberately no field for a student name, student number, e-mail
    address or school: unknown keys are rejected (``extra="forbid"``) so such a
    value cannot even reach the validation layer.
    """

    model_config = {"extra": "forbid"}

    trial_id: str | None = None
    team_id: str | None = None
    robot_id: str | None = None
    condition_label: str | None = None
    floor: str | None = None
    payload_kg: float | str | None = None
    battery_voltage: float | str | None = None
    memo: str | None = None


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


def _build_record_command(
    config: dict[str, str], bag_path: Path, prelude: str | None = None
) -> str:
    """Build the `bash -lc` script that sources ROS and runs `ros2 bag record`.

    ``prelude`` overrides the lenient default sourcing with the strict classroom
    prelude (see :func:`robot_manager.trial.build_prelude`), which fails with a
    distinct exit code instead of recording in the wrong ROS environment.
    """
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
    if prelude is not None:
        return f"{prelude}exec {record_cmd}"
    return (
        "source /opt/ros/jazzy/setup.bash && "
        f'source "{robot_ws}/install/setup.bash" 2>/dev/null; '
        f"exec {record_cmd}"
    )


def _record_args_summary(config: dict[str, str]) -> dict:
    """Describe the recorder configuration that is being applied, for evidence."""
    return {
        "storage": "mcap",
        "all_topics": True,
        "exclude_topics": _split_excludes(config.get("EXCLUDE_TOPICS", "")),
        "vehicle_name": config.get("VEHICLE_NAME", ""),
        "output_dir": config.get("OUTPUT_DIR", ""),
        "min_free_gb": config.get("MIN_FREE_GB", ""),
        "max_split_mb": config.get("MAX_SPLIT_MB", ""),
        "max_duration_sec": config.get("MAX_DURATION_SEC", ""),
    }


# ---------------------------------------------------------------------------
# Start / stop core
# ---------------------------------------------------------------------------

def _stop_locked(reason: str) -> None:
    """Send SIGINT to the recording process group and wait. Caller must hold _lock.

    A classroom trial additionally hands its evidence context to a background
    finalize thread: the after-run parameter dumps and ``ros2 bag info`` must not
    block the HTTP request, and they need the recorder process to be gone first.
    """
    global _proc, _bag_name, _bag_path, _started_at, _last_stop_reason
    global _last_finalize_reason, _mode, _trial, _last_trial
    proc = _proc
    if proc is None:
        return
    # SIGINT alone means rosbag2 wrote metadata.yaml and the MCAP summary; an
    # escalation does not, so it is never reported as a clean finalize.
    finalize = "clean"
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGINT)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=STOP_TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        # Escalate only as a last resort; the bag may be left unfinalized.
        finalize = "finalize_timeout"
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            proc.wait(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass

    ctx = _trial
    elapsed = time.time() - _started_at if _started_at else 0.0
    returncode = proc.poll()

    _proc = None
    _bag_name = None
    _bag_path = None
    _started_at = None
    _mode = None
    _trial = None
    _last_stop_reason = reason
    _last_finalize_reason = finalize

    if ctx is None:
        return

    log = ctx.get("log")
    if log is not None:
        try:
            log.close()
        except OSError:
            pass
    _last_trial = _trial_summary(ctx, reason, finalize, {"status": "pending", "warnings": []},
                                 finalizing=True)
    global _finalize_thread
    _finalize_thread = threading.Thread(
        target=_finalize_trial,
        args=(ctx, reason, finalize, elapsed, returncode),
        daemon=True,
    )
    _finalize_thread.start()


def _trial_summary(ctx: dict, reason: str, finalize: str, integrity: dict,
                   finalizing: bool = False) -> dict:
    """Build the compact trial view returned by the status API / shown in the UI."""
    meta = ctx.get("metadata", {})
    warnings = list(ctx.get("warnings", [])) + list(integrity.get("warnings", []))
    return {
        "trial_id": meta.get("trial_id"),
        "team_id": meta.get("team_id"),
        "condition_label": meta.get("condition_label"),
        "bag_name": ctx.get("bag_name"),
        "stop_reason": reason,
        "finalize": finalize,
        "integrity_status": integrity.get("status"),
        "evidence_dir": str(ctx.get("evidence_dir") or ctx.get("staging")),
        "warnings": warnings,
        "finalizing": finalizing,
    }


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
# Classroom trial evidence (passive: every ROS call below is a read)
# ---------------------------------------------------------------------------

def _dump_params(runtime, node: str, dest: Path, filename: str) -> tuple[str | None, str | None]:
    """Dump a node's effective parameters into dest/filename.

    Returns ``(dump_text, warning)``. A failed snapshot is a warning, never a
    hard failure: evidence quality must not decide whether the robot keeps
    running or whether a bag is kept.
    """
    code, out, err = trial.run_ros(runtime, ["ros2", "param", "dump", node])
    if code != 0 or not out.strip():
        detail = (err or "").strip().splitlines()
        return None, f"{node} のparameter取得に失敗しました: {detail[-1] if detail else f'code {code}'}"
    try:
        trial.atomic_write_text(dest / filename, out)
    except OSError as exc:
        return out, f"{filename} を書き出せませんでした: {exc}"
    return out, None


def _trial_document(ctx: dict, status: str, result: dict | None = None) -> str:
    """Render questix_trial.yaml for a trial in the given lifecycle state."""
    runtime = ctx["runtime"]
    meta = ctx["metadata"]
    pre = ctx["preflight"]
    doc = {
        "schema_version": trial.SCHEMA_VERSION,
        "mode": "classroom",
        "status": status,
        "privacy": "氏名・学籍番号・メール等の個人情報は保存しません",
        "trial": {k: meta.get(k) for k in trial.METADATA_FIELDS if meta.get(k) is not None},
        "timing": {
            "started_at": ctx["started_iso"],
            "ended_at": (result or {}).get("ended_at"),
            "elapsed_sec": (result or {}).get("elapsed_sec"),
        },
        "recording": dict(ctx["record_config"], bag_name=ctx["bag_name"],
                          bag_dir=str(ctx["bag_path"])),
        "runtime": {
            "hostname": ctx["hostname"],
            "robot_ws": runtime.robot_ws,
            "ros_domain_id": runtime.ros_domain_id or "unset",
            "ros_domain_id_source": runtime.domain_source,
            "discovery": trial.discovery_settings(runtime.env),
        },
        "source": ctx["source"],
        "preflight": {
            "required_present": pre["required_present"],
            "missing_required": pre["missing_required"],
            "optional_present": pre["optional_present"],
            "optional_missing": pre["optional_missing"],
            "node_count": len(pre["nodes"]),
            "topic_count": len(pre["topics"]),
        },
        "result": result or {},
        "evidence": {
            "staging_dir": str(ctx["staging"]),
            "files": sorted((result or {}).get("files", ctx.get("files", []))),
            "staging_kept": (result or {}).get("staging_kept", True),
        },
        "warnings": list(ctx.get("warnings", [])) + list((result or {}).get("warnings", [])),
    }
    return trial.to_yaml(doc)


def _write_trial_document(ctx: dict, dest: Path, status: str, result: dict | None = None) -> None:
    """Write questix_trial.yaml into dest, ignoring filesystem failures."""
    try:
        trial.atomic_write_text(dest / trial.TRIAL_FILE, _trial_document(ctx, status, result))
    except OSError:
        pass


def _finalize_trial(ctx: dict, reason: str, finalize: str, elapsed: float,
                    returncode: int | None) -> None:
    """Collect after-run evidence and move the sidecars into the bag directory.

    Runs in a background thread after the recorder process is gone, so a slow
    ROS query cannot block the HTTP request that stopped the recording.
    """
    global _last_trial
    runtime = ctx["runtime"]
    staging: Path = ctx["staging"]
    bag_dir: Path = ctx["bag_path"]
    warnings: list = []

    after: dict[str, str | None] = {}
    snapshots = [("drive", trial.DRIVE_NODE, trial.DRIVE_PARAMS_AFTER)]
    if ctx["preflight"]["joy_node_present"]:
        snapshots.append(("joy", trial.JOY_NODE, trial.JOY_PARAMS_AFTER))
    for key, node, filename in snapshots:
        text, warning = _dump_params(runtime, node, staging, filename)
        after[key] = text
        if warning:
            warnings.append(warning)

    diff_sections: list[str] = []
    for key, label in (("drive", trial.DRIVE_NODE), ("joy", trial.JOY_NODE)):
        before = ctx["params_before"].get(key)
        if before is None or after.get(key) is None:
            continue
        diff = trial.unified_diff_text(before, after[key], f"{label} before", f"{label} after")
        diff_sections.append(diff if diff else f"# {label}: no parameter change\n")
    if diff_sections:
        try:
            trial.atomic_write_text(staging / trial.PARAM_DIFF_FILE, "".join(diff_sections))
        except OSError as exc:
            warnings.append(f"parameter_diff.txt を書き出せませんでした: {exc}")

    if bag_dir.is_dir():
        code, out, err = trial.run_ros(
            runtime, ["ros2", "bag", "info", str(bag_dir)], trial.BAG_INFO_TIMEOUT_SEC
        )
        info_text = out if code == 0 else f"{out}\n# stderr\n{err}"
        try:
            trial.atomic_write_text(staging / trial.BAG_INFO_FILE, info_text)
        except OSError as exc:
            warnings.append(f"bag_info.txt を書き出せませんでした: {exc}")
        integrity = trial.evaluate_integrity(
            code == 0, trial.parse_bag_info_topics(out), finalize == "clean"
        )
    else:
        warnings.append("バッグディレクトリが作成されませんでした")
        integrity = {"status": "failed", "topic_counts": {},
                     "warnings": ["バッグが作成されていません"]}

    moved = trial.move_sidecars(staging, bag_dir)
    evidence_dir = bag_dir if bag_dir.is_dir() else staging
    if moved["skipped"]:
        warnings.append("退避できなかったevidence: " + ", ".join(moved["skipped"]))
    if moved["staging_kept"] and evidence_dir != staging:
        warnings.append(f"一時evidenceを {staging} に残しました")

    result = {
        "ended_at": datetime.now().isoformat(timespec="seconds"),
        "elapsed_sec": int(elapsed),
        "stop_reason": reason,
        "finalize": finalize,
        "return_code": returncode,
        "integrity": integrity,
        "files": sorted({*ctx.get("files", []), *moved["moved"], trial.TRIAL_FILE}),
        "staging_kept": moved["staging_kept"],
        "warnings": warnings,
    }
    ctx["evidence_dir"] = evidence_dir
    _write_trial_document(ctx, evidence_dir, "finalized", result)

    summary = _trial_summary(ctx, reason, finalize, integrity)
    summary["warnings"] = list(ctx.get("warnings", [])) + warnings + integrity.get("warnings", [])
    with _lock:
        _last_trial = summary


def _reserve_start() -> None:
    """Claim the single recording slot, or raise 409. Caller must hold _lock."""
    global _starting
    if _starting or (_proc is not None and _proc.poll() is None):
        raise HTTPException(status_code=409, detail="録画中です")
    _starting = True


def _release_start() -> None:
    """Release the start reservation."""
    global _starting
    with _lock:
        _starting = False


def _prepare_output(config: dict[str, str]) -> tuple[str, Path]:
    """Validate vehicle/output settings, enforce the disk guard, ensure the folder."""
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
    return vehicle, output_dir


def _classroom_preflight(runtime) -> dict:
    """Query the ROS graph read-only and require the drive command/feedback path."""
    code, out, err = trial.run_ros(runtime, ["ros2", "topic", "list"])
    if code != 0:
        detail = (err or "").strip().splitlines()
        raise HTTPException(
            status_code=503,
            detail="ROS環境を解決できません (setup.bash / ROS_DOMAIN_ID を確認してください): "
                   + (detail[-1] if detail else f"code {code}"),
        )
    topics = trial.parse_name_list(out)

    code, out_nodes, err = trial.run_ros(runtime, ["ros2", "node", "list"])
    if code != 0:
        detail = (err or "").strip().splitlines()
        raise HTTPException(
            status_code=503,
            detail="ノード一覧を取得できません: " + (detail[-1] if detail else f"code {code}"),
        )
    preflight = trial.classify_preflight(trial.parse_name_list(out_nodes), topics)
    if preflight["missing_required"]:
        # No recorder process is started: an unusable trial is refused up front.
        raise HTTPException(
            status_code=409,
            detail="必須のノード/トピックがありません: " + ", ".join(preflight["missing_required"]),
        )
    return preflight


def _start_trial(raw: dict) -> dict:
    """Start a classroom trial recording, writing evidence before the recorder runs."""
    global _proc, _bag_name, _bag_path, _started_at, _last_stop_reason
    global _last_finalize_reason, _mode, _trial

    try:
        metadata = trial.validate_metadata(raw)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    metadata["trial_id"] = metadata.get("trial_id") or trial.new_trial_id()

    with _lock:
        _reserve_start()
    try:
        config = _read_config_for_api()
        vehicle, output_dir = _prepare_output(config)

        try:
            launch_env = _read_env_file(LAUNCH_ENV_FILE)
        except OSError as exc:
            raise HTTPException(status_code=500, detail="launch.env を読み込めません") from exc
        try:
            runtime = trial.resolve_runtime_env(launch_env)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        preflight = _classroom_preflight(runtime)

        staging = trial.staging_dir(output_dir, metadata["trial_id"])
        try:
            staging.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"evidence置き場を作成できません: {e}")

        warnings = list(runtime.warnings)
        files: list[str] = []
        source = trial.git_source_identity(Path(__file__).resolve().parent)
        if source["commit"] == "unknown":
            warnings.append("git情報を取得できませんでした (commit unknown)")

        try:
            trial.atomic_write_text(
                staging / trial.TOPIC_LIST_FILE,
                "\n".join(preflight["topics"]) + "\n" if preflight["topics"] else "",
            )
            trial.atomic_write_text(
                staging / trial.SOURCE_FILE,
                trial.source_identity_text(source, {
                    "hostname": trial.hostname(),
                    "started_at": datetime.now().isoformat(timespec="seconds"),
                    "robot_ws": runtime.robot_ws,
                    "ros_domain_id": runtime.ros_domain_id or "unset",
                    "ros_domain_id_source": runtime.domain_source,
                    **trial.discovery_settings(runtime.env),
                }),
            )
            files += [trial.TOPIC_LIST_FILE, trial.SOURCE_FILE]
        except OSError as e:
            warnings.append(f"evidenceを書き出せませんでした: {e}")

        params_before: dict[str, str | None] = {}
        snapshots = [("drive", trial.DRIVE_NODE, trial.DRIVE_PARAMS_BEFORE)]
        if preflight["joy_node_present"]:
            snapshots.append(("joy", trial.JOY_NODE, trial.JOY_PARAMS_BEFORE))
        for key, node, filename in snapshots:
            text, warning = _dump_params(runtime, node, staging, filename)
            params_before[key] = text
            if warning:
                warnings.append(warning)
            else:
                files.append(filename)

        try:
            bag_name = trial.unique_bag_name(
                output_dir, f"{vehicle}_{datetime.now():%Y%m%d_%H%M%S}", metadata["trial_id"]
            )
        except OSError as e:
            raise HTTPException(status_code=500, detail=str(e))
        bag_path = output_dir / bag_name

        try:
            script = _build_record_command(config, bag_path, prelude=runtime.prelude)
        except OSError as exc:
            raise HTTPException(status_code=500, detail="録画設定を読み込めません") from exc

        ctx = {
            "metadata": metadata,
            "bag_name": bag_name,
            "bag_path": bag_path,
            "staging": staging,
            "runtime": runtime,
            "preflight": preflight,
            "source": source,
            "hostname": trial.hostname(),
            "record_config": _record_args_summary(config),
            "params_before": params_before,
            "started_iso": datetime.now().isoformat(timespec="seconds"),
            "warnings": warnings,
            "files": files + [trial.RECORDER_LOG_FILE],
            "log": None,
        }

        # Unlike the generic recorder (stdout/stderr -> /dev/null), a classroom
        # trial keeps the recorder output so a start failure, a rosbag2 warning
        # or an abnormal exit can be read afterwards from the bag itself.
        try:
            log = open(staging / trial.RECORDER_LOG_FILE, "ab", buffering=0)
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"recorder.log を作成できません: {e}")
        ctx["log"] = log

        try:
            proc = subprocess.Popen(
                ["bash", "-lc", script],
                start_new_session=True,
                env=runtime.env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        except OSError as e:
            log.close()
            _write_trial_document(ctx, staging, "start_failed",
                                  {"stop_reason": "start_failed", "warnings": [str(e)]})
            raise HTTPException(status_code=500, detail=f"録画を開始できません: {e}")

        # Fast-fail: if the process dies immediately, ROS/the mcap plugin is
        # likely missing. Surface that as an error instead of a phantom recording.
        time.sleep(0.6)
        if proc.poll() is not None:
            log.close()
            tail = _recorder_log_tail(staging / trial.RECORDER_LOG_FILE)
            result = {
                "stop_reason": "start_failed",
                "return_code": proc.returncode,
                "warnings": [f"recorder が即終了しました (code {proc.returncode})"],
                "staging_kept": True,
            }
            # The staging directory is intentionally kept: partial evidence of a
            # failed start is the evidence of that failure.
            _write_trial_document(ctx, staging, "start_failed", result)
            with _lock:
                _last_stop_reason = "start_failed"
                _last_finalize_reason = None
            raise HTTPException(
                status_code=500,
                detail="録画を開始できませんでした "
                       "(ROS環境 / rosbag2 mcapプラグインを確認してください)"
                       + (f": {tail}" if tail else ""),
            )

        _write_trial_document(ctx, staging, "recording")

        with _lock:
            _proc = proc
            _bag_name = bag_name
            _bag_path = bag_path
            _started_at = time.time()
            _last_stop_reason = None
            _last_finalize_reason = None
            _mode = "classroom"
            _trial = ctx

        threading.Thread(
            target=_watch_disk, args=(output_dir, _min_free_bytes(config)), daemon=True
        ).start()
        return {
            "recording": True,
            "mode": "classroom",
            "bag_name": bag_name,
            "trial_id": metadata["trial_id"],
            "evidence_dir": str(staging),
            "preflight": {
                "required_present": preflight["required_present"],
                "optional_present": preflight["optional_present"],
                "optional_missing": preflight["optional_missing"],
            },
            "warnings": warnings,
        }
    finally:
        _release_start()


def _recorder_log_tail(path: Path, limit: int = 300) -> str:
    """Return the last characters of recorder.log for an API error message."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return ""
    return text[-limit:].replace("\n", " / ")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

def _status_payload() -> dict:
    config = _read_config_for_api()
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
        "last_finalize_reason": _last_finalize_reason,
        "mode": _mode if recording else None,
        "starting": _starting,
        "trial": _active_trial_view() if recording else None,
        "last_trial": _last_trial,
    }


def _active_trial_view() -> Optional[dict]:
    """Return the running trial's metadata for the status payload."""
    if _trial is None:
        return None
    meta = _trial["metadata"]
    return {
        "trial_id": meta.get("trial_id"),
        "team_id": meta.get("team_id"),
        "condition_label": meta.get("condition_label"),
        "evidence_dir": str(_trial["staging"]),
        "warnings": list(_trial.get("warnings", [])),
    }


@router.get("/status")
def get_status():
    """Return current recording state and disk usage."""
    with _lock:
        # Reap a process that exited on its own (e.g. --max-bag-duration).
        global _proc
        if _proc is not None and _proc.poll() is not None:
            # Reaping must not depend on the config being readable, so a bad
            # rosbag.env degrades the reason instead of skipping the reap.
            try:
                max_duration = int(_read_config().get("MAX_DURATION_SEC", "0"))
            except (OSError, ValueError):
                max_duration = 0
            elapsed = time.time() - _started_at if _started_at else 0.0
            _stop_locked(
                _last_stop_reason
                or trial.classify_exit_reason(_proc.poll(), max_duration, elapsed)
            )
        return _status_payload()


@router.post("/start")
def start_recording():
    """Start a new MCAP recording of all topics (generic, no trial metadata)."""
    global _proc, _bag_name, _bag_path, _started_at, _last_stop_reason
    global _last_finalize_reason, _mode, _trial
    with _lock:
        _reserve_start()
    try:
        config = _read_config_for_api()
        vehicle, output_dir = _prepare_output(config)
        min_free = _min_free_bytes(config)

        try:
            bag_name = trial.unique_bag_name(
                output_dir, f"{vehicle}_{datetime.now():%Y%m%d_%H%M%S}"
            )
        except OSError as e:
            raise HTTPException(status_code=500, detail=str(e))
        bag_path = output_dir / bag_name
        try:
            script = _build_record_command(config, bag_path)
        except OSError as exc:
            raise HTTPException(status_code=500, detail="録画設定を読み込めません") from exc

        try:
            proc = subprocess.Popen(
                ["bash", "-lc", script],
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"録画を開始できません: {e}")

        # Fast-fail: if the process dies immediately, ROS/the mcap plugin is
        # likely missing. Surface that as an error instead of a phantom recording.
        time.sleep(0.6)
        if proc.poll() is not None:
            with _lock:
                _last_stop_reason = "start_failed"
                _last_finalize_reason = None
            raise HTTPException(
                status_code=500,
                detail="録画を開始できませんでした (ROS環境 / rosbag2 mcapプラグインを確認してください)",
            )

        with _lock:
            _proc = proc
            _bag_name = bag_name
            _bag_path = bag_path
            _started_at = time.time()
            _last_stop_reason = None
            _last_finalize_reason = None
            _mode = "generic"
            _trial = None

        watcher = threading.Thread(
            target=_watch_disk, args=(output_dir, min_free), daemon=True
        )
        watcher.start()
        return {"recording": True, "mode": "generic", "bag_name": bag_name}
    finally:
        _release_start()


@router.post("/start-trial")
def start_trial_recording(req: TrialStartRequest):
    """Start a classroom trial recording (same recorder, plus evidence sidecars)."""
    raw = {k: v for k, v in req.model_dump().items() if v is not None}
    return _start_trial(raw)


@router.post("/stop")
def stop_recording():
    """Stop the current recording (SIGINT so the bag is finalized)."""
    with _lock:
        if _proc is None or _proc.poll() is not None:
            raise HTTPException(status_code=409, detail="録画していません")
        name = _bag_name
        _stop_locked("user_stopped")
        return {"recording": False, "bag_name": name}


def shutdown_recording() -> None:
    """Stop any running recording when the web service shuts down.

    Without this the recorder process would be orphaned or killed without a
    SIGINT, leaving an unfinalized bag behind. A classroom trial's evidence is
    collected in a background thread, so the shutdown waits for it rather than
    letting the interpreter exit mid-write.
    """
    with _lock:
        if _proc is not None and _proc.poll() is None:
            _stop_locked("shutdown")
        pending = _finalize_thread
    if pending is not None and pending.is_alive():
        pending.join(timeout=SHUTDOWN_FINALIZE_TIMEOUT_SEC)


@router.get("/config")
def get_config():
    """Return the recorder configuration."""
    return _read_config_for_api()


@router.put("/config")
def set_config(config: RecorderConfig):
    """Update recorder configuration (rosbag.env)."""
    current = _read_config_for_api()
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
    config = _read_config_for_api()
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
    config = _read_config_for_api()
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
    output_dir = Path(_read_config_for_api()["OUTPUT_DIR"])
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
    add("現在の設定", Path(_read_config_for_api()["OUTPUT_DIR"]), "current")

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
