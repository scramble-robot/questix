"""Log collection console for robot_manager.

Gathers diagnostic logs (the ``questix_robot`` service journal, the current-boot
system journal, and syslog files) into a single ``.tar.gz`` archive written to a
destination directory chosen via the shared folder picker (typically a USB stick).
This replaces the old live journal viewer: on a headless robot the useful action
is to *retrieve* logs onto removable media, not to tail them in the browser.

The service runs as an unprivileged user, so a source that cannot be read (e.g.
the system journal or syslog need the ``adm`` / ``systemd-journal`` group) is
recorded as a per-source error inside the archive instead of failing the whole
collection.
"""

import os
import re
import shutil
import socket
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

SERVICE_NAME = "questix_robot"

# Absolute path with a conservative character whitelist (matches recorder.py).
_ABS_PATH_RE = re.compile(r"^/[a-zA-Z0-9_/.~ -]*$")

# Selectable log sources. Each maps to a collector that writes files into the
# staging directory and returns a short human-readable note about what happened.
_SOURCES = ("service", "system", "syslog")

# Bounds so a verbose host cannot produce a multi-GB archive (which would be slow
# to build and could fill the destination USB). Journals are line-capped to their
# most recent entries; large syslog files keep only their tail.
_MAX_JOURNAL_LINES = 100000
_MAX_SYSLOG_BYTES = 50 * 1024 * 1024  # per syslog file
# Only the two most recent (uncompressed) syslog files; older *.gz are skipped.
_SYSLOG_FILES = ("syslog", "syslog.1")

router = APIRouter(prefix="/api/logs")


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class CollectRequest(BaseModel):
    """Request to collect logs into an archive under ``dest_dir``."""

    dest_dir: str
    sources: list[str]

    @field_validator("dest_dir")
    @classmethod
    def _validate_dest(cls, v: str) -> str:
        if not _ABS_PATH_RE.match(v):
            raise ValueError("保存先は安全な絶対パスである必要があります")
        return v

    @field_validator("sources")
    @classmethod
    def _validate_sources(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("回収するログを1つ以上選択してください")
        invalid = [s for s in v if s not in _SOURCES]
        if invalid:
            raise ValueError(f"不明なログ種別: {', '.join(invalid)}")
        # De-duplicate while keeping a stable collection order.
        return [s for s in _SOURCES if s in v]


# ---------------------------------------------------------------------------
# Per-source collectors (each writes into `staging` and returns a status note)
# ---------------------------------------------------------------------------

def _fmt_bytes(n: int) -> str:
    units = ["B", "KB", "MB", "GB"]
    v = float(n)
    for u in units:
        if v < 1024 or u == units[-1]:
            return f"{v:.0f} {u}" if u == "B" else f"{v:.1f} {u}"
        v /= 1024
    return f"{n} B"


def _run_journalctl(args: list[str], out_file: Path) -> str:
    """Run journalctl with `args`, streaming stdout to out_file. Return a note.

    stdout is written straight to disk (not buffered in memory) because a busy
    host's journal can be very large; the `-n` line cap keeps the file bounded.
    """
    try:
        with out_file.open("wb") as fh:
            proc = subprocess.run(
                ["journalctl", "--no-pager", "-n", str(_MAX_JOURNAL_LINES), *args],
                stdout=fh, stderr=subprocess.PIPE, timeout=120,
            )
    except FileNotFoundError:
        return "journalctl が見つかりません"
    except subprocess.TimeoutExpired:
        return "journalctl がタイムアウトしました"
    size = out_file.stat().st_size if out_file.exists() else 0
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        return f"journalctl 失敗 (code {proc.returncode}): {err or '権限を確認してください'}"
    return f"OK (最新 {_MAX_JOURNAL_LINES} 行まで, {_fmt_bytes(size)})"


def _collect_service(staging: Path) -> str:
    return _run_journalctl(["-u", SERVICE_NAME], staging / "questix_robot.journal.log")


def _collect_system(staging: Path) -> str:
    # Current boot only, to keep the export bounded by uptime.
    return _run_journalctl(["-b"], staging / "system.journal.log")


def _copy_tail(src: Path, dest: Path, max_bytes: int) -> bool:
    """Copy src to dest, keeping only the last max_bytes if it is larger.

    Returns True if the file was truncated (tail only).
    """
    size = src.stat().st_size
    with src.open("rb") as fsrc, dest.open("wb") as fdst:
        truncated = size > max_bytes
        if truncated:
            fsrc.seek(size - max_bytes)
            fdst.write("# ... (先頭を切り捨て / older entries omitted) ...\n".encode("utf-8"))
        shutil.copyfileobj(fsrc, fdst)
    return truncated


def _collect_syslog(staging: Path) -> str:
    """Copy the two most recent /var/log/syslog files (tail-capped if large)."""
    copied = []
    errors = []
    for name in _SYSLOG_FILES:
        src = Path("/var/log") / name
        if not src.is_file():
            continue
        try:
            truncated = _copy_tail(src, staging / name, _MAX_SYSLOG_BYTES)
            copied.append(f"{name}{' (末尾のみ)' if truncated else ''}")
        except OSError as e:
            errors.append(f"{name}: {e}")
    if not copied:
        if errors:
            return "syslog をコピーできませんでした: " + "; ".join(errors)
        return "syslog ファイルが見つかりません"
    note = f"OK ({', '.join(copied)})"
    if errors:
        note += " / 一部失敗: " + "; ".join(errors)
    return note


_COLLECTORS = {
    "service": _collect_service,
    "system": _collect_system,
    "syslog": _collect_syslog,
}

_SOURCE_LABELS = {
    "service": "questix_robot journal",
    "system": "システム全体 journal (現在のブート)",
    "syslog": "syslog",
}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/sources")
def list_sources():
    """Return the selectable log sources with their display labels."""
    return {"sources": [{"id": s, "label": _SOURCE_LABELS[s]} for s in _SOURCES]}


@router.post("/collect")
def collect_logs(req: CollectRequest):
    """Collect the requested log sources into a .tar.gz under dest_dir."""
    try:
        dest = Path(req.dest_dir).resolve()
    except OSError:
        raise HTTPException(status_code=400, detail="保存先パスが不正です")
    if not dest.is_dir():
        raise HTTPException(status_code=404, detail="保存先フォルダが見つかりません")
    if not os.access(dest, os.W_OK):
        raise HTTPException(status_code=403, detail="保存先フォルダに書き込む権限がありません")

    hostname = re.sub(r"[^a-zA-Z0-9_-]", "_", socket.gethostname()) or "robot"
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"questix_logs_{hostname}_{stamp}.tar.gz"
    final_path = dest / filename
    part_path = dest / (filename + ".part")

    notes: dict[str, str] = {}
    with tempfile.TemporaryDirectory(prefix="questix_logs_") as tmp:
        staging = Path(tmp) / f"questix_logs_{hostname}_{stamp}"
        staging.mkdir()

        for source in req.sources:
            try:
                notes[source] = _COLLECTORS[source](staging)
            except Exception as e:  # noqa: BLE001 — never let one source abort the rest
                notes[source] = f"エラー: {e}"

        # A manifest so whoever opens the archive can see what succeeded.
        manifest = [
            "QUESTiX log collection",
            f"host: {socket.gethostname()}",
            f"collected: {datetime.now().isoformat(timespec='seconds')}",
            "",
        ]
        for source in req.sources:
            manifest.append(f"[{_SOURCE_LABELS[source]}] {notes[source]}")
        (staging / "MANIFEST.txt").write_text("\n".join(manifest) + "\n")

        try:
            # Build under the staging root, then atomically rename into place so a
            # failure never leaves a truncated archive on the (possibly USB) dest.
            tmp_archive = Path(tmp) / filename
            _make_targz(tmp_archive, staging)
            shutil.move(str(tmp_archive), str(part_path))
            os.replace(part_path, final_path)
        except OSError as e:
            part_path.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"アーカイブの作成に失敗しました: {e}")

    try:
        size = final_path.stat().st_size
    except OSError:
        size = 0

    return {
        "filename": filename,
        "path": str(final_path),
        "size_bytes": size,
        "notes": [
            {"source": s, "label": _SOURCE_LABELS[s], "note": notes[s]}
            for s in req.sources
        ],
    }


def _make_targz(archive_path: Path, source_dir: Path) -> None:
    """Create archive_path as a gzip tar of source_dir (kept as top-level folder)."""
    import tarfile

    with tarfile.open(archive_path, "w:gz") as tar:
        tar.add(source_dir, arcname=source_dir.name)
